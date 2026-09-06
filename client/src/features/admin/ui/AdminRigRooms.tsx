// @ts-nocheck — template legado 1:1.
import React, { useEffect, useState } from 'react';
import { getRigRooms as apiGetRigRooms, setRigRooms as apiSetRigRooms, recallAllPlayersItems, recallScan, getSeasonPasses } from '../../../shared/api/admin-legacy';
import { RefreshCw, Package, Calendar } from 'lucide-react';
import { RigRoom, SeasonPass } from '../lib/adminTypes';

/**
 * Gerenciador de salas de mining (`rig_rooms`).
 * Sala ≠ plano: não há gate por access_levels aqui — ownership/season pass only.
 */
export const AdminRigRooms: React.FC = () => {
  const [rigRooms, setRigRooms] = useState<RigRoom[]>([]);
  const [seasonPasses, setSeasonPasses] = useState<SeasonPass[]>([]);
  const [savingRoomId, setSavingRoomId] = useState<string | null>(null);
  const [roomStatuses, setRoomStatuses] = useState<Record<string, 'ok' | 'error' | null>>({});
  const [recalling, setRecalling] = useState(false);

  const withInitialFallback = (rooms: RigRoom[]) => {
    let next = rooms.slice();
    const hasInitial = next.some((r) => r.id === 'room_initial');
    if (!hasInitial) {
      next = [
        {
          id: 'room_initial',
          name: 'Sala de Mineração Inicial',
          initialCapacity: 5,
          maxCapacity: 10,
          baseSlotPrice: 50,
          slotPriceIncreasePercent: 20,
          allowedLevels: [],
          allowedSeasonPassIds: [],
          isActive: true,
          sortOrder: -999
        },
        ...next
      ];
    }
    // Never persist plan→room gates from this UI.
    return next.map((r) => ({ ...r, allowedLevels: [] }));
  };

  useEffect(() => {
    (async () => {
      const [rooms, passes] = await Promise.all([apiGetRigRooms(), getSeasonPasses()]);
      setSeasonPasses(passes);
      setRigRooms(withInitialFallback(rooms));
    })();
  }, []);

  const handleAddRoom = () => {
    const newRoom: RigRoom = {
      id: `room_${Date.now()}`,
      name: 'Nova Sala',
      initialCapacity: 1,
      maxCapacity: 10,
      baseSlotPrice: 10,
      slotPriceIncreasePercent: 20,
      allowedLevels: [],
      allowedSeasonPassIds: [],
      isActive: true,
      sortOrder: rigRooms.length
    };
    setRigRooms((prev) => [...prev, newRoom]);
  };

  const handleRemoveRoom = (id: string) => {
    setRigRooms((prev) => prev.filter((r) => r.id !== id));
  };

  const handleUpdateRoom = (id: string, patch: Partial<RigRoom>) => {
    setRigRooms((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch, allowedLevels: [] } : r)));
  };

  const toggleRoomSeason = (roomId: string, passId: string) => {
    setRigRooms((prev) =>
      prev.map((r) => {
        if (r.id !== roomId) return r;
        const set = new Set(r.allowedSeasonPassIds || []);
        if (set.has(passId)) set.delete(passId);
        else set.add(passId);
        return { ...r, allowedSeasonPassIds: Array.from(set), allowedLevels: [] };
      })
    );
  };

  const handleSaveRoom = async (roomId: string) => {
    if (savingRoomId) return;
    setSavingRoomId(roomId);
    const payload = withInitialFallback(rigRooms);
    const resp = await apiSetRigRooms(payload);
    const status: 'ok' | 'error' = resp?.ok ? 'ok' : 'error';
    if (resp?.ok) {
      const fresh = await apiGetRigRooms();
      setRigRooms(withInitialFallback(fresh));
    }
    setRoomStatuses((prev) => ({ ...prev, [roomId]: status }));
    setSavingRoomId(null);
    setTimeout(() => setRoomStatuses((prev) => ({ ...prev, [roomId]: null })), 3000);
  };

  const handleRecallAll = async () => {
    console.log('[Recall UI] Iniciando fluxo interativo de recolhimento...');
    setRecalling(true);

    try {
      let summaryRes = await recallScan();
      while (true) {
        if (!summaryRes.ok) {
          alert('Erro ao fazer levantamento: ' + summaryRes.error);
          setRecalling(false);
          return;
        }

        const list = summaryRes.summary || [];
        if (list.length === 0) {
          alert('Nenhum item instalado encontrado para recolher.');
          setRecalling(false);
          return;
        }

        let msg = `ETAPA 1: Levantamento de Itens\n`;
        msg += `(Total de ${summaryRes.totalUsersChecked || '?'} jogadores verificados no banco)\n\n`;
        msg += 'Jogadores com itens instalados:\n';
        list.forEach((u: any) => {
          msg += `- ${u.username}: ${u.totalItems} itens (${u.racksCount} rigs)\n`;
        });
        msg += `\nTotal de Jogadores com itens: ${list.length}\n`;
        msg += '\nO que deseja fazer?\n[OK] Continuar para mover\n[CANCELAR] Parar\n(Clique em Repetir se quiser atualizar a lista)';

        if (window.confirm(msg)) {
          break;
        } else {
          if (window.confirm('Deseja repetir o levantamento para atualizar os dados?')) {
            summaryRes = await recallScan();
            continue;
          }
          setRecalling(false);
          return;
        }
      }

      alert('Iniciando movimentação para o estoque... Aguarde.');
      const res = await recallAllPlayersItems();

      if (!res.ok) {
        alert('Erro na execução: ' + (res.error || 'Falha desconhecida'));
        setRecalling(false);
        return;
      }

      const report = res.report as any;
      let reportMsg = `ETAPA 2: Movimentação Concluída\n\n`;
      reportMsg += `- Itens Movidos: ${report?.totalItemsMoved}\n`;
      reportMsg += `- Rigs Processadas: ${report?.racksProcessed}\n`;
      reportMsg += `- Status Final: ${report?.finalStatus === 'success' ? 'SUCESSO TOTAL' : 'PENDENTE'}\n\n`;
      reportMsg +=
        'Deseja encerrar a ação? (Se clicar em Cancelar, o sistema fará uma nova verificação para garantir que tudo foi movido)';

      if (window.confirm(reportMsg)) {
        alert('Ação finalizada com sucesso.');
      } else {
        alert('Reiniciando verificação...');
        setRecalling(false);
        void handleRecallAll();
        return;
      }
    } catch (err) {
      console.error('[Recall UI] Erro no fluxo:', err);
      alert('Erro ao conectar com o servidor.');
    } finally {
      setRecalling(false);
    }
  };

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-white font-bold">Gerenciador de Sala de Rigs</h3>
          <p className="text-xs text-slate-400 mt-1">
            Configure slots iniciais, slots totais, preço base de expansão e progressão de custo.
          </p>
          <p className="text-[10px] text-emerald-400/90 mt-1">
            {rigRooms.length} salas — acesso <strong>não</strong> usa plano Tester/VIP/etc. (só season pass opcional).
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleRecallAll}
            disabled={recalling || !!savingRoomId}
            className={`text-white text-xs px-3 py-1 rounded flex items-center gap-1 shadow-lg transition-transform active:scale-95 ${
              recalling ? 'bg-orange-400 animate-pulse' : 'bg-orange-600 hover:bg-orange-500 shadow-orange-900/40'
            }`}
          >
            {recalling ? <RefreshCw size={14} className="animate-spin" /> : <Package size={14} />}
            {recalling ? 'Processando...' : 'Mover Tudo p/ Estoque (Global)'}
          </button>
          <button
            type="button"
            onClick={handleAddRoom}
            className="bg-green-600 hover:bg-green-500 text-white text-xs px-3 py-1 rounded shadow-lg shadow-green-900/40 transition-transform active:scale-95"
            disabled={!!savingRoomId}
          >
            + Adicionar Sala
          </button>
        </div>
      </div>
      <div className="space-y-3">
        {rigRooms.map((room) => (
          <div key={room.id} className="p-3 rounded border border-slate-700 bg-slate-900 shadow-xl">
            <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4">
              <div className="md:col-span-2">
                <label className="text-[10px] uppercase font-bold text-slate-500 block mb-1">Nome da Sala</label>
                <input
                  value={room.name}
                  onChange={(e) => handleUpdateRoom(room.id, { name: e.target.value })}
                  className="w-full bg-slate-800 text-white text-sm p-2 rounded border border-slate-700 focus:border-amber-500 outline-none transition-colors"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-500 block mb-1">Slots Iniciais</label>
                <input
                  type="number"
                  value={room.initialCapacity}
                  onChange={(e) => handleUpdateRoom(room.id, { initialCapacity: Number(e.target.value || 0) })}
                  className="w-full bg-slate-800 text-white text-sm p-2 rounded border border-slate-700 focus:border-amber-500 outline-none transition-colors"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-500 block mb-1">Máximo Slots</label>
                <input
                  type="number"
                  value={room.maxCapacity}
                  onChange={(e) => handleUpdateRoom(room.id, { maxCapacity: Number(e.target.value || 0) })}
                  className="w-full bg-slate-800 text-white text-sm p-2 rounded border border-slate-700 focus:border-amber-500 outline-none transition-colors"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-500 block mb-1">Preço 1º Slot (USDC)</label>
                <input
                  type="number"
                  step="0.01"
                  value={room.baseSlotPrice}
                  onChange={(e) => handleUpdateRoom(room.id, { baseSlotPrice: Number(e.target.value || 0) })}
                  className="w-full bg-slate-800 text-white text-sm p-2 rounded border border-slate-700 focus:border-amber-500 outline-none transition-colors"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-500 block mb-1">Aumento por Slot (%)</label>
                <input
                  type="number"
                  step="0.1"
                  value={room.slotPriceIncreasePercent}
                  onChange={(e) =>
                    handleUpdateRoom(room.id, { slotPriceIncreasePercent: Number(e.target.value || 0) })
                  }
                  className="w-full bg-slate-800 text-white text-sm p-2 rounded border border-slate-700 focus:border-amber-500 outline-none transition-colors"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4">
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-500 block mb-1">Ordem</label>
                <input
                  type="number"
                  value={room.sortOrder}
                  onChange={(e) => handleUpdateRoom(room.id, { sortOrder: Number(e.target.value || 0) })}
                  className="w-full bg-slate-800 text-white text-sm p-2 rounded border border-slate-700 focus:border-amber-500 outline-none transition-colors"
                />
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-xs text-slate-300 font-bold cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={room.isActive}
                    onChange={(e) => handleUpdateRoom(room.id, { isActive: e.target.checked })}
                    className="rounded bg-slate-700 border-slate-600 text-green-500"
                  />
                  <span className="group-hover:text-green-400 transition-colors">SALA ATIVA</span>
                </label>
              </div>
            </div>

            <div className="mb-4">
              <div className="text-[10px] uppercase font-bold text-slate-500 mb-2 flex items-center gap-1">
                <Calendar size={12} /> Temporadas Exclusivas (Season Pass)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-slate-800/40 p-3 rounded border border-slate-700/50">
                {seasonPasses.map((pass) => (
                  <label
                    key={pass.id}
                    className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer hover:text-white transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={(room.allowedSeasonPassIds || []).includes(pass.id)}
                      onChange={() => toggleRoomSeason(room.id, pass.id)}
                      className="rounded bg-slate-700 border-slate-600 text-orange-500"
                    />
                    <span className="truncate" title={pass.name}>
                      {pass.name}
                    </span>
                  </label>
                ))}
                {seasonPasses.length === 0 && (
                  <span className="text-[10px] text-slate-600 italic">Nenhuma temporada configurada</span>
                )}
              </div>
            </div>

            <div className="flex justify-end items-center gap-3 pt-3 border-t border-slate-800">
              {roomStatuses[room.id] === 'ok' && (
                <span className="text-[10px] font-bold text-green-500 animate-pulse">✓ SALVO COM SUCESSO</span>
              )}
              {roomStatuses[room.id] === 'error' && (
                <span className="text-[10px] font-bold text-red-500">✗ ERRO AO SALVAR</span>
              )}
              <button
                type="button"
                onClick={() => handleSaveRoom(room.id)}
                className={`text-white text-xs font-bold px-4 py-2 rounded-lg shadow-lg transition-all active:scale-95 ${
                  savingRoomId === room.id
                    ? 'bg-amber-400 cursor-not-allowed'
                    : 'bg-amber-600 hover:bg-amber-500 shadow-amber-900/20'
                }`}
                disabled={savingRoomId !== null}
              >
                {savingRoomId === room.id ? 'PROCESSANDO...' : 'SALVAR ALTERAÇÕES'}
              </button>
              <button
                type="button"
                onClick={() => handleRemoveRoom(room.id)}
                className="bg-red-900/20 hover:bg-red-600 text-red-500 hover:text-white text-xs font-bold px-4 py-2 rounded-lg border border-red-900/50 transition-all active:scale-95"
              >
                REMOVER
              </button>
            </div>
          </div>
        ))}
        {rigRooms.length === 0 && (
          <div className="text-center py-12 bg-slate-900/50 rounded-xl border border-dashed border-slate-700 text-slate-500 italic">
            Nenhuma sala configurada no sistema.
          </div>
        )}
      </div>
    </div>
  );
};
