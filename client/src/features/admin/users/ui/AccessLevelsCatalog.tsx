// @ts-nocheck
import React from 'react';
import { PlusCircle } from 'lucide-react';
import type { AccessLevel } from '../../lib/adminTypes';
import { filterMembershipAccessLevels } from '../../lib/membershipAccessLevels';

export type AccessLevelsCatalogProps = {
  accessLevels: AccessLevel[];
  editLevelMode: boolean;
  levelForm: any;
  setLevelForm: (v: any) => void;
  setEditLevelMode: (v: boolean) => void;
  handleNewLevel: () => void;
  handleEditLevel: (level: AccessLevel) => void;
  handleSaveLevel: () => void;
  handleDeleteLevel: () => void;
};

/** Planos / níveis de acesso (`access_levels`) — membership only.
 * Não confundir com salas de mining (`rig_rooms`).
 */
export function AccessLevelsCatalog({
  accessLevels: accessLevelsProp,
  editLevelMode,
  levelForm,
  setLevelForm,
  setEditLevelMode,
  handleNewLevel,
  handleEditLevel,
  handleSaveLevel,
  handleDeleteLevel
}: AccessLevelsCatalogProps) {
  const accessLevels = filterMembershipAccessLevels(accessLevelsProp);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 h-[70vh] flex flex-col">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className="font-bold text-white">Planos / níveis configurados</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">
              Membership unlocks — não são salas de mining.
            </p>
          </div>
          <button
            type="button"
            onClick={handleNewLevel}
            className="bg-green-600 text-white text-xs px-2 py-1 rounded flex items-center gap-1"
          >
            <PlusCircle size={12} /> NOVO
          </button>
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2">
          {accessLevels.map((level) => (
            <div
              key={level.id}
              onClick={() => handleEditLevel(level)}
              className={`p-3 rounded border cursor-pointer hover:border-amber-500 ${
                level.isDefault
                  ? 'bg-amber-900/20 border-amber-500/50'
                  : 'bg-slate-900 border-slate-700'
              }`}
            >
              <div className="flex justify-between items-start">
                <div className="font-bold text-white flex items-center gap-2">
                  {level.name}
                  {level.isDefault && (
                    <span className="text-[9px] bg-amber-600 px-1 rounded text-white">PADRÃO</span>
                  )}
                  {!level.isActive && (
                    <span className="text-[9px] bg-red-600 px-1 rounded text-white">INATIVO</span>
                  )}
                </div>
                <div className="text-xs text-green-400 font-mono">
                  {level.priceUsdc && level.priceUsdc > 0 ? `$${level.priceUsdc} USDC` : 'GRÁTIS'}
                </div>
              </div>
              <div className="text-xs text-slate-400 mt-1">{level.description}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 h-[70vh] overflow-y-auto">
        {editLevelMode ? (
          <div className="space-y-4">
            <h3 className="font-bold text-white border-b border-slate-700 pb-2 mb-4">
              {levelForm.id ? `Editando: ${levelForm.name}` : 'Novo plano / nível'}
            </h3>
            <div>
              <label className="text-xs font-bold text-slate-500 block mb-1">ID (Slug)</label>
              <input
                type="text"
                value={levelForm.id}
                onChange={(e) => setLevelForm({ ...levelForm, id: e.target.value })}
                className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500 block mb-1">Nome de Exibição</label>
              <input
                type="text"
                value={levelForm.name}
                onChange={(e) => setLevelForm({ ...levelForm, name: e.target.value })}
                className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500 block mb-1">Descrição</label>
              <input
                type="text"
                value={levelForm.description}
                onChange={(e) => setLevelForm({ ...levelForm, description: e.target.value })}
                className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-4 bg-slate-900 p-3 rounded">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={levelForm.isActive}
                  onChange={(e) => setLevelForm({ ...levelForm, isActive: e.target.checked })}
                />
                <span className="text-sm text-slate-300">Ativo</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={levelForm.isDefault}
                  onChange={(e) => setLevelForm({ ...levelForm, isDefault: e.target.checked })}
                />
                <span className="text-sm text-slate-300">Padrão</span>
              </label>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500 block mb-1">Preço (USDC)</label>
              <input
                type="number"
                value={levelForm.priceUsdc}
                onChange={(e) => setLevelForm({ ...levelForm, priceUsdc: parseFloat(e.target.value) })}
                className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500 block mb-1">
                Mensagem de Bloqueio (Opcional)
              </label>
              <input
                type="text"
                value={levelForm.inactiveMessage}
                onChange={(e) => setLevelForm({ ...levelForm, inactiveMessage: e.target.value })}
                placeholder="Mensagem mostrada se inativo..."
                className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm"
              />
            </div>
            <div className="flex gap-4 pt-4">
              <button
                type="button"
                onClick={() => setEditLevelMode(false)}
                className="bg-slate-700 text-white px-4 py-2 rounded font-bold text-sm"
              >
                CANCELAR
              </button>
              <button
                type="button"
                onClick={handleSaveLevel}
                className="bg-amber-600 text-white px-4 py-2 rounded font-bold text-sm flex-1"
              >
                SALVAR
              </button>
              {levelForm.id && (
                <button
                  type="button"
                  onClick={handleDeleteLevel}
                  className="bg-red-600 text-white px-4 py-2 rounded font-bold text-sm"
                >
                  EXCLUIR
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-slate-500">
            Selecione um plano / nível para editar.
          </div>
        )}
      </div>
    </div>
  );
}
