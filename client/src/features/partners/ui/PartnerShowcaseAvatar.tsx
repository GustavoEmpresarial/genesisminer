import { useState } from 'react';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';

type PartnerShowcaseAvatarProps = {
  name: string;
  imageUrl: string;
  compact?: boolean;
};

export function PartnerShowcaseAvatar({ name, imageUrl, compact }: PartnerShowcaseAvatarProps) {
  const [broken, setBroken] = useState(false);
  const letter = String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
  const src = normalizePublicAssetUrl(imageUrl) || '';
  const showImg = Boolean(src) && !broken;
  const box = compact ? 'h-10 w-10 text-sm' : 'h-14 w-14 text-lg';
  return (
    <span
      className={`relative flex ${box} shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-600 bg-gradient-to-br from-slate-700 to-slate-900 font-black text-amber-400`}
    >
      {showImg ? (
        <img
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        letter
      )}
    </span>
  );
}
