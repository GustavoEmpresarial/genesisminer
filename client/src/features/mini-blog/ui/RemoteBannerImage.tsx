import { useCallback, useEffect, useMemo, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';

type RemoteBannerImageProps = {
  src: string;
  alt: string;
  className?: string;
  failureHint?: string;
  compact?: boolean;
};

export function RemoteBannerImage({
  src,
  alt,
  className = 'w-full h-full object-cover',
  failureHint = 'Image unavailable',
  compact = false
}: RemoteBannerImageProps) {
  const [broken, setBroken] = useState(false);
  const resolvedSrc = useMemo(() => normalizePublicAssetUrl(src) ?? src.trim(), [src]);

  useEffect(() => {
    setBroken(false);
  }, [src]);

  const onError = useCallback(() => {
    setBroken(true);
  }, []);

  if (!resolvedSrc || broken) {
    return (
      <div
        className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-0.5 overflow-hidden bg-slate-950 p-0.5 text-amber-500/90"
        role="img"
        aria-label={alt ? `${alt} — ${failureHint}` : failureHint}
      >
        <ImageOff
          className={compact ? 'h-2.5 w-2.5 shrink-0 opacity-70' : 'h-3.5 w-3.5 shrink-0 opacity-70'}
          aria-hidden
        />
        <span
          className={`text-center font-bold uppercase leading-tight line-clamp-3 ${
            compact ? 'px-0.5 text-[6px]' : 'px-0.5 text-[7px] sm:text-[8px]'
          }`}
        >
          {failureHint}
        </span>
      </div>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={onError}
    />
  );
}
