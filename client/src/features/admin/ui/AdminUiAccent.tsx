// @ts-nocheck — template legado 1:1.
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Palette, Save } from 'lucide-react';
import { getAdminUiAccent, putAdminUiAccent } from '../../../shared/api/admin-legacy';
import {
  DEFAULT_UI_ACCENT_HEX,
  UI_ACCENT_LABELS,
  UI_ACCENT_PRESETS,
  UI_ACCENT_SWATCH,
  applyUiAccent,
  normalizeUiAccentHex
} from '../lib/uiAccent';

export const AdminUiAccent: React.FC = () => {
  const [accent, setAccent] = useState<string>(DEFAULT_UI_ACCENT_HEX);
  const [hexText, setHexText] = useState<string>(DEFAULT_UI_ACCENT_HEX);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  const preview = useCallback((raw: string) => {
    const hex = normalizeUiAccentHex(raw);
    setAccent(hex);
    setHexText(hex);
    applyUiAccent(hex);
    setSaveStatus('idle');
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getAdminUiAccent();
      if (cancelled) return;
      if (res.ok && res.accent) {
        const hex = normalizeUiAccentHex(res.accent);
        setAccent(hex);
        setHexText(hex);
        applyUiAccent(hex);
      } else if (!res.ok) {
        setError(res.error || 'Falha ao carregar.');
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onPickerChange = (value: string) => {
    preview(value);
  };

  const onHexTextChange = (value: string) => {
    setHexText(value);
    const trimmed = value.trim();
    if (/^#?[0-9a-fA-F]{3}$/.test(trimmed) || /^#?[0-9a-fA-F]{6}$/.test(trimmed)) {
      preview(trimmed);
    } else {
      setSaveStatus('idle');
    }
  };

  const onHexBlur = () => {
    preview(hexText);
  };

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const toSave = normalizeUiAccentHex(accent);
      const res = await putAdminUiAccent(toSave);
      if (!res.ok) {
        setError(res.error || 'Falha ao guardar.');
        return;
      }
      const saved = normalizeUiAccentHex(res.accent || toSave);
      setAccent(saved);
      setHexText(saved);
      applyUiAccent(saved);
      setSaveStatus('saved');
      window.setTimeout(() => setSaveStatus('idle'), 2500);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 relative space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h3 className="text-white font-bold flex items-center gap-2">
            <Palette size={18} className="text-amber-400" />
            Cor do tema
          </h3>
          <p className="text-xs text-slate-400 mt-1 max-w-xl">
            Escolhe qualquer cor de destaque para o site. A alteração aplica-se a todos os jogadores após
            guardar (sem redeploy).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!loaded || busy}
          className="px-4 py-2 rounded-lg font-bold text-xs flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-stone-950 disabled:opacity-50 shrink-0"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {busy ? 'A guardar…' : 'Salvar'}
          {saveStatus === 'saved' && <CheckCircle2 size={14} className="text-emerald-700" />}
        </button>
      </div>

      {!loaded ? (
        <div className="text-sm text-slate-400 flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> A carregar…
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center rounded-xl border border-slate-600 bg-slate-900/60 p-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <span
                className="relative h-14 w-14 shrink-0 rounded-full border border-white/20 shadow-inner overflow-hidden"
                style={{ backgroundColor: accent }}
              >
                <input
                  type="color"
                  value={accent}
                  onChange={(e) => onPickerChange(e.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label="Escolher cor"
                />
              </span>
              <span className="text-sm text-slate-300">
                Clique no círculo para abrir o seletor
              </span>
            </label>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <label className="text-[11px] uppercase tracking-wide text-slate-500 shrink-0" htmlFor="ui-accent-hex">
                Hex
              </label>
              <input
                id="ui-accent-hex"
                type="text"
                value={hexText}
                onChange={(e) => onHexTextChange(e.target.value)}
                onBlur={onHexBlur}
                spellCheck={false}
                className="w-full max-w-[10rem] rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-mono text-sm text-white focus:border-amber-400 focus:outline-none"
                placeholder="#f59e0b"
              />
            </div>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Atalhos</p>
            <div className="flex flex-wrap gap-2">
              {UI_ACCENT_PRESETS.map((id) => {
                const hex = UI_ACCENT_SWATCH[id];
                const selected = accent === hex;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => preview(hex)}
                    className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition ${
                      selected
                        ? 'border-amber-400 bg-amber-500/15 ring-1 ring-amber-400/40'
                        : 'border-slate-600 bg-slate-900/60 hover:border-slate-500'
                    }`}
                  >
                    <span
                      className="h-5 w-5 shrink-0 rounded-full border border-white/20"
                      style={{ backgroundColor: hex }}
                      aria-hidden
                    />
                    <span className="text-xs font-bold text-white">{UI_ACCENT_LABELS[id]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
      {saveStatus === 'saved' && !error && (
        <p className="text-sm text-emerald-400">Cor guardada. Visível para todos os jogadores.</p>
      )}
    </div>
  );
};
