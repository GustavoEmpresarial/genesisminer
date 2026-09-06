// @ts-nocheck — template legado 1:1.
import React, { useState, useEffect } from 'react';
import { getExchangeSettings, setExchangeSettings } from '../../../shared/api/admin-legacy';
import { Save, RefreshCcw, DollarSign, Percent } from 'lucide-react';

type AdminExchangeProps = { readOnly?: boolean };

export const AdminExchange: React.FC<AdminExchangeProps> = ({ readOnly = false }) => {
    const [minAmount, setMinAmount] = useState<string>('');
    const [feePercent, setFeePercent] = useState<string>('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        setLoading(true);
        const s = await getExchangeSettings();
        setMinAmount(String(s.minExchangeAmount));
        setFeePercent(String(s.exchangeFeePercent));
        setLoading(false);
    };

    const handleSave = async () => {
        if (readOnly) return;
        const min = parseFloat(minAmount.toString().replace(',', '.'));
        const fee = parseFloat(feePercent.toString().replace(',', '.'));

        if (isNaN(min) || min < 0) {
            alert("Valor mínimo inválido.");
            return;
        }
        if (isNaN(fee) || fee < 0 || fee > 100) {
            alert("Taxa inválida. Deve ser entre 0 e 100.");
            return;
        }

        setLoading(true);
        const res = await setExchangeSettings({ minExchangeAmount: min, exchangeFeePercent: fee });
        setLoading(false);

        if (res.ok) {
            alert("Configurações salvas com sucesso!");
        } else {
            alert(res.error || "Erro ao salvar configurações.");
        }
    };

    return (
        <div className="bg-slate-900 border border-slate-700/50 rounded-lg p-6 max-w-2xl mx-auto shadow-xl">
            <div className="flex items-center gap-3 mb-6 border-b border-slate-700 pb-4">
                <div className="p-2 bg-yellow-500/20 rounded-lg text-yellow-500">
                    <RefreshCcw size={24} />
                </div>
                <div>
                    <h2 className="text-xl font-bold text-slate-100">Configurações de Exchange</h2>
                    <p className="text-sm text-slate-400">Configure as taxas e limites para conversão de Cripto em USDC.</p>
                </div>
            </div>

            <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700">
                        <label className="block text-sm font-bold text-slate-400 mb-2 flex items-center gap-2">
                            <DollarSign size={14} /> Valor Mínimo para Troca (USDC)
                        </label>
                        <div className="relative">
                            <input
                                type="number"
                                step="0.1"
                                min="0"
                                readOnly={readOnly}
                                value={minAmount}
                                onChange={(e) => setMinAmount(e.target.value)}
                                className={`w-full bg-slate-900 border border-slate-600 rounded p-2 text-white font-mono focus:border-yellow-500 outline-none ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
                            />
                        </div>
                        <p className="text-xs text-slate-500 mt-2">Valor mínimo bruto em USDC que o jogador deve atingir para converter.</p>
                    </div>

                    <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700">
                        <label className="block text-sm font-bold text-slate-400 mb-2 flex items-center gap-2">
                            <Percent size={14} /> Taxa de Conversão (%)
                        </label>
                        <div className="relative">
                            <input
                                type="number"
                                step="0.1"
                                min="0"
                                max="100"
                                readOnly={readOnly}
                                value={feePercent}
                                onChange={(e) => setFeePercent(e.target.value)}
                                className={`w-full bg-slate-900 border border-slate-600 rounded p-2 text-white font-mono focus:border-yellow-500 outline-none ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
                            />
                        </div>
                        <p className="text-xs text-slate-500 mt-2">Porcentagem retida pelo sistema em cada transação.</p>
                    </div>
                </div>

                {!readOnly && (
                    <div className="flex justify-end pt-4 border-t border-slate-700">
                        <button
                            onClick={handleSave}
                            disabled={loading}
                            className="flex items-center gap-2 bg-yellow-600 hover:bg-yellow-500 text-white px-6 py-2 rounded font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? <RefreshCcw size={18} className="animate-spin" /> : <Save size={18} />}
                            SALVAR ALTERAÇÕES
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
