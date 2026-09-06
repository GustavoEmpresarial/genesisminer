import { useMemo, useState, type FormEvent } from 'react';
import { Headphones, ImagePlus, Loader2, Mail, Search, Send, X } from 'lucide-react';
import {
  createPublicSupportTicket,
  getPublicSupportTicket,
  listPublicSupportTicketsByEmail,
  type PublicSupportTicketDetail,
  type PublicSupportTicketSummary
} from '../../../shared/api/public-support';
import {
  SUPPORT_ATTACHMENT_MAX_COUNT,
  SUPPORT_CONTACT_EMAIL_MAX,
  SUPPORT_CONTACT_NAME_MAX,
  SUPPORT_TICKET_MESSAGE_MAX,
  SUPPORT_TICKET_SUBJECT_MAX
} from '../../../shared/constants/formLimits';

type Tab = 'new' | 'lookup';

type PublicSupportPageProps = {
  onBackHome: () => void;
  onGoLogin: () => void;
};

export function PublicSupportPage({ onBackHome, onGoLogin }: PublicSupportPageProps) {
  const [tab, setTab] = useState<Tab>('new');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [lookupEmail, setLookupEmail] = useState('');
  const [tickets, setTickets] = useState<PublicSupportTicketSummary[]>([]);
  const [detail, setDetail] = useState<PublicSupportTicketDetail | null>(null);

  const fileLabel = useMemo(() => {
    if (files.length === 0) return 'Anexar imagens (opcional)';
    return `${files.length} ficheiro(s)`;
  }, [files.length]);

  const onPickFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files, ...Array.from(list)].slice(0, SUPPORT_ATTACHMENT_MAX_COUNT);
    setFiles(next);
  };

  const submitNew = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      const res = await createPublicSupportTicket({ name, email, subject, message, files });
      if (!res.ok) {
        setError(res.error || 'Falha ao enviar.');
        return;
      }
      setSuccess(`Ticket criado: ${res.id}`);
      setSubject('');
      setMessage('');
      setFiles([]);
      setLookupEmail(email.trim());
      setTab('lookup');
      const listed = await listPublicSupportTicketsByEmail(email);
      if (listed.ok && listed.tickets) setTickets(listed.tickets);
    } finally {
      setBusy(false);
    }
  };

  const submitLookup = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setDetail(null);
    setBusy(true);
    try {
      const res = await listPublicSupportTicketsByEmail(lookupEmail);
      if (!res.ok) {
        setError(res.error || 'Falha na pesquisa.');
        setTickets([]);
        return;
      }
      setTickets(res.tickets || []);
    } finally {
      setBusy(false);
    }
  };

  const openTicket = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await getPublicSupportTicket(id, lookupEmail || email);
      if (!res.ok || !res.ticket) {
        setError(res.error || 'Ticket não encontrado.');
        return;
      }
      setDetail(res.ticket);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-3 py-6 sm:px-4 sm:py-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBackHome}
          className="text-sm font-semibold text-slate-600 hover:text-amber-600 dark:text-slate-300"
        >
          ← Voltar
        </button>
        <button
          type="button"
          onClick={onGoLogin}
          className="text-sm font-semibold text-amber-700 hover:underline dark:text-amber-400"
        >
          Já tenho conta — Login
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-200 bg-gradient-to-r from-amber-500/10 to-orange-500/5 px-4 py-5 sm:px-6 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/20 text-amber-700 dark:text-amber-300">
              <Headphones size={22} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white sm:text-2xl">Suporte</h1>
              <p className="text-sm text-slate-500">Sem login — abre um ticket ou consulta pelo teu email.</p>
            </div>
          </div>
        </div>

        <div className="flex gap-1 border-b border-slate-200 p-2 dark:border-slate-800">
          <button
            type="button"
            onClick={() => setTab('new')}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-bold ${
              tab === 'new' ? 'bg-amber-500 text-stone-950' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            Novo ticket
          </button>
          <button
            type="button"
            onClick={() => setTab('lookup')}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-bold ${
              tab === 'lookup'
                ? 'bg-amber-500 text-stone-950'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            Meus tickets
          </button>
        </div>

        <div className="p-4 sm:p-6">
          {error ? (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          ) : null}
          {success ? (
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300">
              {success}
            </div>
          ) : null}

          {tab === 'new' ? (
            <form onSubmit={submitNew} className="space-y-3">
              <label className="block text-xs font-bold uppercase text-slate-500">
                Nome
                <input
                  required
                  maxLength={SUPPORT_CONTACT_NAME_MAX}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>
              <label className="block text-xs font-bold uppercase text-slate-500">
                Email
                <input
                  required
                  type="email"
                  maxLength={SUPPORT_CONTACT_EMAIL_MAX}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>
              <label className="block text-xs font-bold uppercase text-slate-500">
                Assunto
                <input
                  required
                  maxLength={SUPPORT_TICKET_SUBJECT_MAX}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>
              <label className="block text-xs font-bold uppercase text-slate-500">
                Mensagem
                <textarea
                  required
                  maxLength={SUPPORT_TICKET_MESSAGE_MAX}
                  rows={5}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>
              <div>
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 dark:border-slate-600 dark:text-slate-300">
                  <ImagePlus size={16} />
                  {fileLabel}
                  <input
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    className="hidden"
                    onChange={(e) => onPickFiles(e.target.files)}
                  />
                </label>
                {files.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {files.map((f, i) => (
                      <li
                        key={`${f.name}-${i}`}
                        className="flex items-center justify-between gap-2 text-xs text-slate-500"
                      >
                        <span className="truncate">{f.name}</span>
                        <button
                          type="button"
                          onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                          className="text-red-500"
                          aria-label="Remover ficheiro"
                        >
                          <X size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <button
                type="submit"
                disabled={busy}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-amber-600 px-4 py-3 text-sm font-bold text-stone-950 disabled:opacity-50 sm:w-auto"
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                Enviar ticket
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              <form onSubmit={submitLookup} className="flex flex-col gap-2 sm:flex-row">
                <label className="relative min-w-0 flex-1">
                  <Mail size={14} className="absolute left-3 top-3 text-slate-400" />
                  <input
                    required
                    type="email"
                    maxLength={SUPPORT_CONTACT_EMAIL_MAX}
                    value={lookupEmail}
                    onChange={(e) => setLookupEmail(e.target.value)}
                    placeholder="Email usado no ticket"
                    className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white dark:bg-amber-600 dark:text-stone-950"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                  Buscar
                </button>
              </form>

              {detail ? (
                <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                  <button type="button" className="text-xs font-bold text-amber-700" onClick={() => setDetail(null)}>
                    ← Lista
                  </button>
                  <h2 className="font-bold text-slate-900 dark:text-white">{detail.subject}</h2>
                  <p className="text-xs text-slate-500">
                    {detail.status} · respostas admin: {detail.admin_reply_count}
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">{detail.message}</p>
                  {Array.isArray(detail.attachments) && detail.attachments.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {(detail.attachments as Array<{ url?: string; originalName?: string }>).map((a, i) =>
                        a?.url ? (
                          <a
                            key={`${a.url}-${i}`}
                            href={a.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block"
                          >
                            <img
                              src={a.url}
                              alt={a.originalName || 'anexo'}
                              className="max-h-28 rounded-lg border border-slate-200 object-cover dark:border-slate-700"
                            />
                          </a>
                        ) : null
                      )}
                    </div>
                  ) : null}
                  <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
                    <p className="text-xs font-bold uppercase text-slate-500">Respostas do suporte</p>
                    {detail.replies.length === 0 ? (
                      <p className="text-sm text-slate-500">Ainda sem resposta da equipa.</p>
                    ) : (
                      detail.replies.map((r) => (
                        <div key={r.id} className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-950">
                          <div className="mb-1 text-[10px] font-bold text-amber-700 dark:text-amber-400">
                            {r.admin_username}
                          </div>
                          <p className="whitespace-pre-wrap text-slate-700 dark:text-slate-200">{r.message}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <ul className="space-y-2">
                  {tickets.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => void openTicket(t.id)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-3 text-left hover:border-amber-400 dark:border-slate-700"
                      >
                        <div className="font-semibold text-slate-900 dark:text-white">{t.subject}</div>
                        <div className="text-[11px] text-slate-500">
                          {t.status} · {t.admin_reply_count} resposta(s)
                        </div>
                      </button>
                    </li>
                  ))}
                  {tickets.length === 0 ? (
                    <p className="text-center text-sm text-slate-500">Nenhum ticket para este email.</p>
                  ) : null}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
