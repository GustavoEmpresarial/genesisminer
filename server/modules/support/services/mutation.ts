/**
 * Support submit + player reply — validation stays Node; SQL TX lives in
 * `genesis-mining-worker` (`POST /v1/support/submit|reply`). Fail-closed:
 * no Prisma INSERT fallback when the worker is unset or unreachable.
 */
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import { parseIdempotencyKey } from '../../../shared/validation/idempotency-key.js';
import {
  callMiningWorkerSupportReply,
  callMiningWorkerSupportSubmit,
  type MiningWorkerSupportSubmitResult,
  type MiningWorkerSupportReplyResult
} from '../../mining-engine/services/mining-worker-client.js';
import { getTicketForPlayerAction } from './ticket-model.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const SUBJECT_MAX_LENGTH = 180;
const SUBJECT_MIN_LENGTH = 3;
const MESSAGE_MAX_LENGTH = 8000;
const MESSAGE_MIN_LENGTH_SUBMIT = 10;
const MESSAGE_MIN_LENGTH_REPLY = 3;
const TICKET_ID_MAX_LENGTH = 80;
/** Node `LOCK_TIMEOUT_MS` — kept as the named source copied into the worker. */
export const LOCK_TIMEOUT_MS = 45_000;

export class SupportMutationError extends HttpControlledError {
  readonly code?: string;
  constructor(message: string, statusCode = HTTP_BAD_REQUEST, code?: string) {
    super(statusCode, code ? { error: message, code } : { error: message });
    this.name = 'SupportMutationError';
    this.code = code;
  }
}

export type SupportAttachmentItem = { url: string; originalName: string; mime: string };

function trimSubject(raw: unknown): string {
  return (raw != null ? String(raw) : '').trim().slice(0, SUBJECT_MAX_LENGTH);
}

function trimMessage(raw: unknown): string {
  return (raw != null ? String(raw) : '').trim().slice(0, MESSAGE_MAX_LENGTH);
}

function trimTicketId(raw: unknown): string {
  return (raw != null ? String(raw) : '').trim().slice(0, TICKET_ID_MAX_LENGTH);
}

function throwSupportWorkerFailure(out: MiningWorkerSupportSubmitResult | MiningWorkerSupportReplyResult): never {
  if (out.ok) {
    throw new SupportMutationError('mining worker support empty result', HTTP_INTERNAL_SERVER_ERROR, 'INTERNAL');
  }
  if (out.code === 'VALIDATION') {
    throw new SupportMutationError(out.error, HTTP_BAD_REQUEST, 'VALIDATION');
  }
  if (out.code === 'NOT_FOUND') {
    throw new SupportMutationError(out.error, HTTP_NOT_FOUND, 'NOT_FOUND');
  }
  if (out.code === 'ARCHIVED') {
    throw new SupportMutationError(out.error, HTTP_FORBIDDEN, 'ARCHIVED');
  }
  throw new SupportMutationError(out.error, HTTP_INTERNAL_SERVER_ERROR, out.code);
}

export async function runSupportSubmitTicketMutation(params: {
  userId: number;
  subjectRaw: unknown;
  messageRaw: unknown;
  attachments: SupportAttachmentItem[];
  idempotencyKeyRaw?: unknown;
}): Promise<{ id: string; idempotentReplay?: boolean }> {
  const subject = trimSubject(params.subjectRaw);
  const message = trimMessage(params.messageRaw);
  if (subject.length < SUBJECT_MIN_LENGTH) {
    throw new SupportMutationError('Assunto demasiado curto (mín. 3 characters).', HTTP_BAD_REQUEST, 'VALIDATION');
  }
  if (message.length < MESSAGE_MIN_LENGTH_SUBMIT) {
    throw new SupportMutationError('Mensagem demasiado curta (mín. 10 characters).', HTTP_BAD_REQUEST, 'VALIDATION');
  }

  const idem = parseIdempotencyKey(params.idempotencyKeyRaw);
  const out = await callMiningWorkerSupportSubmit({
    userId: params.userId,
    subject,
    message,
    attachments: params.attachments,
    ...(idem ? { idempotencyKey: idem } : {})
  });
  if (!out.ok) throwSupportWorkerFailure(out);
  return { id: out.id, ...(out.idempotentReplay ? { idempotentReplay: true } : {}) };
}

export async function runSupportPlayerReplyMutation(params: {
  userId: number;
  ticketIdRaw: unknown;
  messageRaw: unknown;
  attachments: SupportAttachmentItem[];
  idempotencyKeyRaw?: unknown;
}): Promise<{ replyId: string; idempotentReplay?: boolean }> {
  const ticketId = trimTicketId(params.ticketIdRaw);
  if (!ticketId) {
    throw new SupportMutationError('Invalid request.', HTTP_BAD_REQUEST, 'VALIDATION');
  }
  const message = trimMessage(params.messageRaw);
  const hasFiles = params.attachments.length > 0;
  if (message.length < MESSAGE_MIN_LENGTH_REPLY && !hasFiles) {
    throw new SupportMutationError('Escreve uma mensagem (mín. 3 caracteres) ou anexa ficheiros.', HTTP_BAD_REQUEST, 'VALIDATION');
  }
  const t = await getTicketForPlayerAction(ticketId);
  if (!t || Number(t.user_id) !== params.userId) {
    throw new SupportMutationError('Order not found.', HTTP_NOT_FOUND, 'NOT_FOUND');
  }
  const idem = parseIdempotencyKey(params.idempotencyKeyRaw);
  if (String(t.status) !== 'open' && !idem) {
    throw new SupportMutationError('Este pedido está arquivado. Só podes ver a conversa. Abre um novo pedido para falar connosco de novo.', HTTP_FORBIDDEN, 'ARCHIVED');
  }

  const out = await callMiningWorkerSupportReply({
    userId: params.userId,
    ticketId,
    message,
    attachments: params.attachments,
    ...(idem ? { idempotencyKey: idem } : {})
  });
  if (!out.ok) throwSupportWorkerFailure(out);
  return { replyId: out.replyId, ...(out.idempotentReplay ? { idempotentReplay: true } : {}) };
}
