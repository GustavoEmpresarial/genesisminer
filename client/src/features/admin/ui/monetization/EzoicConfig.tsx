// @ts-nocheck — template legado 1:1.

import React from 'react';
import { Monitor, Zap, Info, ShieldCheck } from 'lucide-react';
import { MonetizationSettings } from '../../lib/adminTypes';

interface Props {
    settings: MonetizationSettings;
    setSettings: (s: MonetizationSettings) => void;
}

export const EzoicConfig: React.FC<Props> = ({ settings, setSettings }) => {
    return (
        <div className="space-y-6 animate-in fade-in zoom-in-95 duration-300">
            <div className="flex items-center justify-between">
                <h4 className="text-slate-300 font-bold text-xs uppercase tracking-widest flex items-center gap-2">
                    <Monitor size={14} className="text-amber-500" /> Parâmetros Ezoic
                </h4>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500 font-bold uppercase">{settings.ezoicEnabled ? 'Ativo' : 'Desativado'}</span>
                    <button
                        onClick={() => setSettings({ ...settings, ezoicEnabled: !settings.ezoicEnabled })}
                        className={`w-10 h-5 rounded-full p-1 transition-colors ${settings.ezoicEnabled ? 'bg-amber-600' : 'bg-slate-700'}`}
                    >
                        <div className={`w-3 h-3 bg-white rounded-full transition-transform ${settings.ezoicEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Publisher ID</label>
                        <input
                            type="text"
                            value={settings.ezoicPublisherId}
                            onChange={e => setSettings({ ...settings, ezoicPublisherId: e.target.value })}
                            placeholder="Ex: 123456"
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white text-sm focus:border-amber-600 outline-none transition-all"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">App ID / Developer Key</label>
                        <input
                            type="text"
                            value={settings.ezoicAppId}
                            onChange={e => setSettings({ ...settings, ezoicAppId: e.target.value })}
                            placeholder="Ex: abc-123-def"
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white text-sm focus:border-amber-600 outline-none transition-all"
                        />
                    </div>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Placeholder ID (Rewarded)</label>
                        <input
                            type="text"
                            value={settings.ezoicPlaceholderId}
                            onChange={e => setSettings({ ...settings, ezoicPlaceholderId: e.target.value })}
                            placeholder="Ex: 987654"
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white text-sm focus:border-amber-600 outline-none transition-all"
                        />
                    </div>
                </div>
            </div>

            <div className="flex items-start gap-4 p-4 bg-amber-900/10 border border-amber-900/30 rounded-xl">
                <Info className="text-amber-500 mt-1" size={20} />
                <div>
                    <h3 className="text-amber-500 font-bold uppercase tracking-widest text-xs">Integração Ezoic</h3>
                    <p className="text-slate-400 text-[10px] mt-1">
                        Os anúncios recompensados da Ezoic funcionam através do SDK de vídeo. Certifique-se de que o domínio está aprovado no painel da Ezoic.
                    </p>
                </div>
            </div>

            <div className="bg-slate-900/50 border border-slate-700/50 p-4 rounded-xl flex items-start gap-4">
                <ShieldCheck className="text-amber-500 mt-1" size={20} />
                <div>
                    <h5 className="text-xs font-bold text-white uppercase tracking-tight">Status da Integração</h5>
                    <p className="text-[10px] text-slate-400 mt-1">O SDK da Ezoic está {settings.ezoicEnabled ? 'pronto para uso' : 'desativado'}.</p>
                </div>
            </div>
        </div>
    );
};
