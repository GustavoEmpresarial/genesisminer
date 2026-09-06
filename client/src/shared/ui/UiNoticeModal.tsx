import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export type NoticeVariant = 'info' | 'success' | 'error';

export type UiNotice = {
    variant: NoticeVariant;
    message: string;
    title?: string;
};

type Props = {
    notice: UiNotice | null;
    onClose: () => void;
    /** Classes Tailwind para o stacking (ex. `z-[140]` acima de outros modais na App). */
    overlayZClassName?: string;
};

export const UiNoticeModal: React.FC<Props> = ({ notice, onClose, overlayZClassName = 'z-[100]' }) => {
    if (!notice) return null;
    const { variant, message, title } = notice;
    const Icon = variant === 'error' ? AlertTriangle : variant === 'success' ? CheckCircle2 : Info;
    const iconWrap =
        variant === 'error'
            ? 'bg-red-500/20 text-red-400'
            : variant === 'success'
              ? 'bg-emerald-500/20 text-emerald-400'
              : 'bg-amber-500/20 text-amber-400';

    return (
        <div
            className={`fixed inset-0 ${overlayZClassName} flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200`}
            role="dialog"
            aria-modal="true"
            aria-label={title || 'Mensagem'}
            onClick={onClose}
        >
            <div
                className="relative w-full max-w-md rounded-2xl border border-slate-600/80 bg-slate-900 p-5 shadow-2xl dark:bg-slate-950"
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    type="button"
                    onClick={onClose}
                    className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
                    aria-label="Fechar"
                >
                    <X size={18} />
                </button>
                <div className={`mb-3 inline-flex rounded-full p-2 ${iconWrap}`}>
                    <Icon size={22} aria-hidden />
                </div>
                {title ? <h3 className="mb-2 pr-8 text-sm font-bold uppercase tracking-wide text-white">{title}</h3> : null}
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{message}</p>
                <button
                    type="button"
                    onClick={onClose}
                    className="mt-6 w-full rounded-xl bg-orange-600 py-2.5 text-xs font-black uppercase tracking-widest text-white transition hover:bg-orange-500"
                >
                    OK
                </button>
            </div>
        </div>
    );
};
