/**
 * Chat TTL cron (texto + áudio em disco).
 *
 * **No-op:** o loop vive em `genesis-mining-worker` (`run_chat_ttl_loop`,
 * Redis lock `genesis:lock:job:chat-ttl`, intervalo `MS_PER_MINUTE`, SQL +
 * unlink sob `IMG_UPLOADS_DIR`/`CHAT_AUDIO_DIR` + publish `chat:ttl_purge`
 * em `genesis:ws:emit`).
 *
 * Mantido como export de bootstrap para não partir `startBackgroundSchedulers`.
 */
import { log } from '../../../core/ops/logger.js';

export type ChatTtlCronDeps = {
  uploadsDir: string;
};

export function startChatTtlCron(_deps: ChatTtlCronDeps): () => void {
  log.info('chat ttl cron not scheduled', {
    module: 'chat_ttl',
    event: 'disabled',
    reason: 'Rust mining-worker owns chat TTL purge (SQL + disk + ws emit)'
  });
  return () => undefined;
}
