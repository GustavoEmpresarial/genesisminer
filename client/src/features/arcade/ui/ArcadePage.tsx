/**
 * Arcade Hub placeholder — matches legacy stub until games ship.
 * DECISIONS #101.
 */
import { Gamepad2 } from 'lucide-react';
import { useT } from '../../../shared/i18n';

export function ArcadePage() {
  const t = useT();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-slate-500">
      <Gamepad2 size={48} className="animate-bounce" />
      <h2 className="bg-gradient-to-r from-amber-500 to-orange-500 bg-clip-text text-2xl font-bold uppercase tracking-widest text-transparent">
        {t('arcade.title')}
      </h2>
      <p className="max-w-md text-center text-sm">{t('arcade.subtitle')}</p>
    </div>
  );
}
