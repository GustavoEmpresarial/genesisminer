import React from 'react';
import { ArrowLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type LegalSection = {
  id: string;
  title: string;
  body: string[];
};

type LegalPageLayoutProps = {
  title: string;
  intro: string;
  updatedAt: string;
  accentClass: string;
  accentHoverClass: string;
  iconClass: string;
  icon: LucideIcon;
  sections: LegalSection[];
};

export const LegalPageLayout: React.FC<LegalPageLayoutProps> = ({
  title,
  intro,
  updatedAt,
  accentClass,
  accentHoverClass,
  iconClass,
  icon: Icon,
  sections
}) => {
  return (
    <div className="max-w-5xl mx-auto px-6 py-12 text-slate-700 dark:text-slate-300 animate-in slide-in-from-bottom-4 duration-500">
      <div className="mb-6">
        <a
          href="/"
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:border-amber-500/50 hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
        >
          <ArrowLeft size={16} />
          Voltar para o início
        </a>
      </div>

      <div className="mb-10 text-center">
        <h1 className="text-4xl font-bold text-slate-900 dark:text-white mb-4 flex items-center justify-center gap-3">
          <Icon className={iconClass} /> {title}
        </h1>
        <p className="text-slate-500 dark:text-slate-400 text-lg">{intro}</p>
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-500">Última atualização: {updatedAt}</p>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 md:p-8 shadow-sm mb-8">
        <p className="text-sm md:text-base leading-7">
          Esta página resume as regras e diretrizes públicas atualmente aplicáveis ao Genesis Miner para este tema específico.
        </p>
      </div>

      <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 md:p-8 mb-10">
        <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-4">Nesta página</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`} className={`${accentClass} ${accentHoverClass} transition-colors`}>
              {section.title}
            </a>
          ))}
        </div>
      </div>

      <div className="space-y-8">
        {sections.map((section) => (
          <section
            key={section.id}
            id={section.id}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 md:p-8 shadow-sm"
          >
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-4">{section.title}</h2>
            <div className="space-y-4">
              {section.body.map((paragraph, idx) => (
                <p key={idx} className="text-sm md:text-base leading-7 text-slate-600 dark:text-slate-300">
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};
