/**
 * Renders ticket attachment thumbnails / video links (safe href only).
 */
import { ExternalLink } from 'lucide-react';
import type { SupportTicketAttachment } from '../../../shared/api/support';
import { safeSupportAttachmentHref } from '../../../shared/utils/supportAttachmentUrls';

function isVideoAtt(a: { mime?: string; url?: string }): boolean {
  const m = (a.mime || '').toLowerCase();
  if (m.startsWith('video/')) return true;
  const u = (a.url || '').toLowerCase();
  return /\.(mp4|webm|mov)(\?|$)/.test(u);
}

type SupportAttachmentLinksProps = {
  items: SupportTicketAttachment[];
  unavailableLabel: string;
  videoFallback: string;
};

export function SupportAttachmentLinks({
  items,
  unavailableLabel,
  videoFallback
}: SupportAttachmentLinksProps) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((a, i) => {
        const href = safeSupportAttachmentHref(a.url);
        if (!href) {
          return (
            <span
              key={i}
              className="max-w-full truncate rounded border border-slate-800 px-2 py-1 text-[10px] text-slate-500"
              title={unavailableLabel}
            >
              {unavailableLabel}
            </span>
          );
        }
        return isVideoAtt({ ...a, url: href }) ? (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1 truncate text-[11px] text-sky-400 hover:text-sky-300"
          >
            <ExternalLink size={11} className="shrink-0" />
            <span className="truncate">{a.originalName || videoFallback}</span>
          </a>
        ) : (
          <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="block max-w-full shrink-0">
            <img
              src={href}
              alt=""
              className="h-auto max-h-28 w-auto max-w-full rounded border border-slate-700 object-cover"
            />
          </a>
        );
      })}
    </div>
  );
}
