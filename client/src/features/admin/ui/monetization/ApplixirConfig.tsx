// @ts-nocheck — template legado 1:1.

import React from 'react';
import { Globe, ShieldCheck, Info } from 'lucide-react';
import { MonetizationSettings } from '../../lib/adminTypes';

interface Props {
    settings: MonetizationSettings;
    setSettings: (s: MonetizationSettings) => void;
}

export const ApplixirConfig: React.FC<Props> = ({ settings, setSettings }) => {
    return (
        <div className="space-y-6 animate-in fade-in zoom-in-95 duration-300">
            <div className="flex items-center justify-between">
                <h4 className="text-slate-300 font-bold text-xs uppercase tracking-widest flex items-center gap-2">
                    <Globe size={14} className="text-green-500" /> Parâmetros Applixir
                </h4>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500 font-bold uppercase">{settings.applixirEnabled ? 'Ativo' : 'Desativado'}</span>
                    <button
                        onClick={() => setSettings({ ...settings, applixirEnabled: !settings.applixirEnabled })}
                        className={`w-10 h-5 rounded-full p-1 transition-colors ${settings.applixirEnabled ? 'bg-green-600' : 'bg-slate-700'}`}
                    >
                        <div className={`w-3 h-3 bg-white rounded-full transition-transform ${settings.applixirEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Site ID</label>
                        <input
                            type="text"
                            value={settings.applixirSiteId}
                            onChange={e => setSettings({ ...settings, applixirSiteId: e.target.value })}
                            placeholder="Ex: 1234"
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white text-sm focus:border-green-600 outline-none transition-all"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Zone ID</label>
                        <input
                            type="text"
                            value={settings.applixirZoneId}
                            onChange={e => setSettings({ ...settings, applixirZoneId: e.target.value })}
                            placeholder="Ex: 5678"
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white text-sm focus:border-green-600 outline-none transition-all"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Account ID</label>
                        <input
                            type="text"
                            value={settings.applixirAccountId}
                            onChange={e => setSettings({ ...settings, applixirAccountId: e.target.value })}
                            placeholder="Ex: 8993"
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white text-sm focus:border-green-600 outline-none transition-all"
                        />
                    </div>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Callback Secret (S2S)</label>
                        <input
                            type="password"
                            value={settings.applixirCallbackSecret}
                            onChange={e => setSettings({ ...settings, applixirCallbackSecret: e.target.value })}
                            placeholder="Chave ou token"
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-yellow-500 text-sm focus:border-yellow-600 outline-none transition-all font-mono"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] text-slate-500 font-bold uppercase block mb-1">Template de Mensagem</label>
                        <input
                            type="text"
                            value={settings.applixirRewardMessage}
                            onChange={e => setSettings({ ...settings, applixirRewardMessage: e.target.value })}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-white text-sm focus:border-green-600 outline-none transition-all"
                        />
                    </div>
                </div>
            </div>

            <div className="bg-slate-900/50 border border-slate-700/50 p-4 rounded-xl flex items-start gap-4">
                <ShieldCheck className="text-green-500 mt-1" size={20} />
                <div>
                    <h5 className="text-xs font-bold text-white uppercase tracking-tight">Status da Integração</h5>
                    <p className="text-[10px] text-slate-400 mt-1">O SDK da Applixir está pronto para processar anúncios {settings.applixirEnabled ? 'ativos' : 'assim que for habilitado'}.</p>
                </div>
            </div>
        </div>
    );
};
