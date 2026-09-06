/**
 * Showcase card hero — video thumb + optional vitrine photo (legacy layout).
 */
import { useState } from 'react';
import { Play } from 'lucide-react';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';

type PartnerSplitHeroProps = {
  youtubeUrl: string;
  videoThumb: string;
  vitrineUrl: string;
};

export function PartnerSplitHero({ youtubeUrl, videoThumb, vitrineUrl }: PartnerSplitHeroProps) {
  const [vitrineOk, setVitrineOk] = useState(true);
  const resolvedVitrine = normalizePublicAssetUrl(vitrineUrl) || '';
  const hasVitrine = Boolean(resolvedVitrine.trim()) && vitrineOk;
  const splitPlayLeft = 'left-[55%]';

  return (
    <a
      href={youtubeUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block aspect-video shrink-0 overflow-hidden bg-slate-950"
    >
      <div className="absolute inset-0 flex">
        <div className={`relative min-h-0 overflow-hidden ${hasVitrine ? 'min-w-0 flex-[11]' : 'flex-1'}`}>
          <img
            src={videoThumb}
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-95 transition-transform duration-300 group-hover:scale-[1.02] group-hover:opacity-100"
          />
        </div>
        {hasVitrine ? (
          <div className="relative flex min-w-0 flex-[9] items-center justify-center border-l border-slate-700/80 bg-gradient-to-br from-slate-900 via-slate-950 to-slate-950 px-3 py-3 sm:px-4 sm:py-4">
            <div className="relative grid h-[min(76%,11.5rem)] w-[min(80%,10.5rem)] place-items-center overflow-hidden rounded-2xl border border-white/20 bg-slate-900/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_40px_rgba(0,0,0,0.55)] ring-1 ring-black/40 sm:h-[min(78%,13rem)] sm:w-[min(80%,11.5rem)]">
              <img
                src={resolvedVitrine}
                alt=""
                className="max-h-[90%] max-w-[90%] rounded-lg object-contain"
                onError={() => setVitrineOk(false)}
              />
            </div>
          </div>
        ) : null}
      </div>
      <div className="pointer-events-none absolute inset-0 bg-black/28 transition-colors group-hover:bg-black/20" />
      <div
        className={`pointer-events-none absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 ${
          hasVitrine ? splitPlayLeft : 'left-1/2'
        }`}
      >
        <div className="scale-95 rounded-full bg-red-600 p-3 text-white shadow-lg shadow-red-900/60 ring-[5px] ring-slate-950/90 transition-transform group-hover:scale-100">
          <Play size={24} className="translate-x-0.5 fill-white" />
        </div>
      </div>
    </a>
  );
}
