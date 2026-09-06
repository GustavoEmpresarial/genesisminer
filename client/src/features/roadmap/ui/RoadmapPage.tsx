import React, { useCallback, useEffect, useState } from 'react';
import {
  Calendar,
  CheckCircle2,
  CircleDashed,
  FlaskConical,
  Loader2,
  Map,
  Sparkles,
  XCircle
} from 'lucide-react';
import { getRoadmapSteps, type RoadmapStepPayload } from '../../../shared/api/roadmap';
import { useT } from '../../../shared/i18n';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';
import { RemoteBannerImage } from '../../mini-blog/ui/RemoteBannerImage';

const STATUS_META: Record<string, { color: string; icon: React.ReactNode }> = {
  planned: {
    color: 'border-slate-400 bg-slate-500/10 text-slate-300',
    icon: <CircleDashed size={16} />
  },
  in_dev: {
    color: 'border-blue-500 bg-blue-500/10 text-blue-300',
    icon: <Loader2 size={16} className="animate-spin" />
  },
  testing: {
    color: 'border-purple-500 bg-purple-500/10 text-purple-300',
    icon: <FlaskConical size={16} />
  },
  done: {
    color: 'border-green-500 bg-green-500/10 text-green-300',
    icon: <CheckCircle2 size={16} />
  },
  cancelled: {
    color: 'border-red-500 bg-red-500/10 text-red-400',
    icon: <XCircle size={16} />
  }
};

export const RoadmapPage: React.FC = () => {
  const t = useT();
  const [steps, setSteps] = useState<RoadmapStepPayload[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { steps: rows } = await getRoadmapSteps();
    setSteps(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <div className="mb-10 text-center">
        <h1 className="text-3xl font-bold text-slate-900 dark:text-white flex items-center justify-center gap-3">
          <Map className="text-amber-500" /> {t('roadmap.title')}
        </h1>
        <p className="text-slate-500 dark:text-slate-400 mt-2">{t('roadmap.subtitle')}</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-amber-500">
          <Loader2 className="animate-spin" size={32} />
        </div>
      ) : steps.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center text-slate-500">
          {t('roadmap.empty')}
        </div>
      ) : (
        <ol className="relative border-l-2 border-orange-500/30 ml-4 space-y-8">
          {steps.map((step, idx) => {
            const meta = STATUS_META[step.status] || STATUS_META.planned;
            const statusKey = STATUS_META[step.status] ? step.status : 'planned';
            const img = step.imageUrl ? normalizePublicAssetUrl(step.imageUrl) || step.imageUrl : null;
            return (
              <li key={step.id} className="relative pl-8">
                <span
                  className={`absolute -left-[11px] top-1 flex h-5 w-5 items-center justify-center rounded-full border-2 bg-slate-950 ${meta.color.split(' ')[0]}`}
                  aria-hidden
                >
                  <span className="h-2 w-2 rounded-full bg-current opacity-80" />
                </span>

                <article
                  className={`rounded-xl border p-4 sm:p-5 transition-shadow ${
                    step.isHighlight
                      ? 'border-amber-500/50 bg-gradient-to-br from-amber-950/40 to-slate-900/60 shadow-lg shadow-amber-500/10'
                      : 'border-slate-700/80 bg-slate-900/40'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {step.isHighlight && <Sparkles size={16} className="text-amber-400 shrink-0" />}
                      <h2 className="text-lg font-bold text-white">{step.title}</h2>
                    </div>
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${meta.color}`}>
                      {meta.icon}
                      {t(`roadmap.status.${statusKey}`)}
                    </span>
                  </div>

                  {step.plannedDate ? (
                    <p className="text-[11px] text-slate-400 flex items-center gap-1 mb-2">
                      <Calendar size={12} />
                      {t('roadmap.forecast', { date: step.plannedDate })}
                    </p>
                  ) : null}

                  {img ? (
                    <div className="mb-3 overflow-hidden rounded-lg border border-slate-700">
                      <RemoteBannerImage
                        src={img}
                        alt={step.title}
                        className="w-full max-h-48 object-cover"
                        failureHint={t('roadmap.imageFallback')}
                      />
                    </div>
                  ) : null}

                  <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">{step.description}</p>

                  <p className="text-[10px] text-slate-600 mt-3">
                    {t('roadmap.stepOf', { current: idx + 1, total: steps.length })}
                  </p>
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};
