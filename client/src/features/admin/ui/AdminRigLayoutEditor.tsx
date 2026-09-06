// @ts-nocheck — template legado 1:1.
import React, { useState, useRef, useEffect } from 'react';
import { Upgrade, RigLayout, SlotLayout } from '../lib/adminTypes';
import { normalizePublicAssetUrl } from '../../servers/utils/publicUrl';

const IMG_UPLOAD_FOLDERS = [
    { id: '', label: 'uploads (dinâmico)' },
    { id: 'miner', label: 'miner' },
    { id: 'moedas', label: 'moedas' },
    { id: 'carregadores', label: 'carregadores' },
    { id: 'baterias', label: 'baterias' },
    { id: 'favicon', label: 'favicon' }
] as const;
import { Move, Plus, Trash2, Cpu, Battery, Plug, Zap, Save, AlertCircle, Power, Cog, Coins, Activity, BarChart3, Terminal } from 'lucide-react';
import { apiFetch } from '../../../shared/api/http';

interface AdminRigLayoutEditorProps {
    gameUpgrades: Upgrade[];
    onUpdateGameUpgrades?: (upgrades: Upgrade[]) => void;
}

export const AdminRigLayoutEditor: React.FC<AdminRigLayoutEditorProps> = ({ gameUpgrades, onUpdateGameUpgrades }) => {
    const [selectedRackId, setSelectedRackId] = useState<string>('');
    const [layout, setLayout] = useState<RigLayout>({ slots: [] });
    const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
    const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
    const [resizingIdx, setResizingIdx] = useState<number | null>(null);
    const [isResizingCanvas, setIsResizingCanvas] = useState<boolean>(false);
    const [tempImage, setTempImage] = useState<string | null>(null);
    const [imageUploadFolder, setImageUploadFolder] = useState<string>('miner');
    const canvasRef = useRef<HTMLDivElement>(null);

    const racks = gameUpgrades.filter(u => u.type === 'infrastructure');
    const selectedRack = racks.find(r => r.id === selectedRackId);

    // Skin: re-sincroniza quando o catálogo (gameUpgrades) ganha `image` depois do primeiro render.
    useEffect(() => {
        if (!selectedRack) return;
        const url = normalizePublicAssetUrl(selectedRack.image);
        setTempImage(url ?? null);
    }, [selectedRackId, selectedRack?.image]);

    // Layout: só quando troca a rig selecionada (evita apagar edição ao atualizar só a imagem).
    useEffect(() => {
        if (!selectedRack) return;
        if (selectedRack.layout) {
            setLayout({
                ...selectedRack.layout,
                canvasWidth: selectedRack.layout.canvasWidth || 500,
                canvasHeight: selectedRack.layout.canvasHeight || 800
            });
        } else {
            const newSlots: SlotLayout[] = [];
            const cols = 3;
            for (let i = 0; i < (selectedRack.slotsCapacity || 0); i++) {
                const row = Math.floor(i / cols);
                const col = i % cols;
                newSlots.push({
                    id: `slot_${i}`,
                    type: 'machine',
                    x: 10 + col * 25,
                    y: 10 + row * 25,
                    w: 20,
                    h: 20
                });
            }
            newSlots.push({ id: 'wiring', type: 'wiring', x: 85, y: 10, w: 10, h: 20 });
            newSlots.push({ id: 'battery', type: 'battery', x: 85, y: 35, w: 10, h: 20 });
            for (let i = 0; i < (selectedRack.aiSlotsCapacity || 0); i++) {
                newSlots.push({ id: `ai_${i}`, type: 'multiplier', x: 85, y: 60 + i * 15, w: 10, h: 10 });
            }
            setLayout({ slots: newSlots });
        }
    }, [selectedRackId, gameUpgrades.length]);

    const handleMouseDown = (idx: number, e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        setDraggingIdx(idx);
        setSelectedIdx(idx);
    };

    const handleResizeStart = (idx: number, e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        setResizingIdx(idx);
    };

    const handleCanvasResizeStart = (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        setIsResizingCanvas(true);
    };

    /**
     * Upload via `multipart/form-data` em `/api/admin/upload-image` (sem
     * inflar via base64). Lê as dimensões do ficheiro localmente para ajustar
     * `canvasWidth`/`canvasHeight` antes de enviar.
     */
    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const input = e.target;
        const file = input.files?.[0];
        if (!file) return;
        const okMime = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
        if (!okMime.includes(file.type)) {
            alert('Formato de imagem inválido. Usa PNG, JPG, WEBP ou GIF.');
            input.value = '';
            return;
        }
        const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
            const objUrl = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => { resolve({ w: img.width, h: img.height }); URL.revokeObjectURL(objUrl); };
            img.onerror = () => { resolve(null); URL.revokeObjectURL(objUrl); };
            img.src = objUrl;
        });
        const fd = new FormData();
        fd.append('image', file, file.name);
        if (imageUploadFolder) fd.append('assetFolder', imageUploadFolder);
        try {
            const res = await apiFetch('/api/admin/upload-image', {
                method: 'POST',
                credentials: 'include',
                body: fd
            });
            let payload: { ok?: boolean; path?: string; url?: string; error?: string } | null = null;
            try { payload = await res.json(); } catch { /* sem JSON */ }
            const url = payload?.path || payload?.url;
            if (res.ok && payload?.ok && url) {
                setTempImage(url);
                if (dims) {
                    setLayout(prev => ({ ...prev, canvasWidth: dims.w, canvasHeight: dims.h }));
                }
            } else {
                alert(payload?.error || `Falha ao enviar imagem (HTTP ${res.status}).`);
            }
        } catch {
            alert('Falha de rede ao enviar imagem. Verifica a ligação e tenta novamente.');
        } finally {
            input.value = '';
        }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();

        if (draggingIdx !== null) {
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;

            const newSlots = [...layout.slots];
            newSlots[draggingIdx] = {
                ...newSlots[draggingIdx],
                x: Math.max(0, Math.min(100 - newSlots[draggingIdx].w, x - newSlots[draggingIdx].w / 2)),
                y: Math.max(0, Math.min(100 - newSlots[draggingIdx].h, y - newSlots[draggingIdx].h / 2))
            };
            setLayout({ ...layout, slots: newSlots });
        } else if (resizingIdx !== null) {
            const slot = layout.slots[resizingIdx];
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;

            const newSlots = [...layout.slots];
            newSlots[resizingIdx] = {
                ...newSlots[resizingIdx],
                w: Math.max(2, x - slot.x),
                h: Math.max(2, y - slot.y)
            };
            setLayout({ ...layout, slots: newSlots });
        } else if (isResizingCanvas) {
            const parent = canvasRef.current.parentElement;
            if (!parent) return;
            const parentRect = parent.getBoundingClientRect();

            // For canvas resizing, we work with the ratio and raw pixels
            const newW = e.clientX - rect.left;
            const newH = e.clientY - rect.top;

            if (newW > 50 && newH > 50) {
                setLayout({
                    ...layout,
                    canvasWidth: Math.round(newW),
                    canvasHeight: Math.round(newH)
                });
            }
        }
    };

    const handleMouseUp = () => {
        setDraggingIdx(null);
        setResizingIdx(null);
        setIsResizingCanvas(false);
    };

    const updateSlotSize = (idx: number, w: number, h: number) => {
        const newSlots = [...layout.slots];
        newSlots[idx] = { ...newSlots[idx], w, h };
        setLayout({ ...layout, slots: newSlots });
    }

    const updateCanvasSize = (w: number, h: number) => {
        setLayout({ ...layout, canvasWidth: w, canvasHeight: h });
    }

    const handleSave = () => {
        if (!onUpdateGameUpgrades || !selectedRackId) return;
        const updated = gameUpgrades.map(u => u.id === selectedRackId ? { ...u, layout, image: tempImage || u.image } : u);
        onUpdateGameUpgrades(updated);
        alert('Layout e Imagem salvos com sucesso!');
    };

    const addNewSlot = (type: SlotLayout['type']) => {
        let id: string = type;

        if (type === 'machine') {
            id = `slot_${(layout.slots as any[]).filter(s => s.type === 'machine').length}`;
        } else if (type === 'multiplier') {
            id = `ai_${(layout.slots as any[]).filter(s => s.type === 'multiplier').length}`;
        } else if (type === 'battery') {
            id = `battery_${(layout.slots as any[]).filter(s => s.type === 'battery').length}`;
        } else if (type === 'battery_bar') {
            id = `battery_bar_${(layout.slots as any[]).filter(s => s.type === 'battery_bar').length}`;
        }

        let w = 20;
        let h = 20;

        if (type === 'stat_monitor') {
            w = (150 / (layout.canvasWidth || 500)) * 100;
            h = (55 / (layout.canvasHeight || 800)) * 100;
        }

        const newSlot: SlotLayout = { id, type, x: 40, y: 40, w, h };
        setLayout({ ...layout, slots: [...layout.slots, newSlot] });
    };

    const removeSlot = (idx: number) => {
        setLayout({ ...layout, slots: layout.slots.filter((_, i) => i !== idx) });
        setSelectedIdx(null);
    };

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
            <div className="flex justify-between items-center bg-slate-800 p-4 rounded-xl border border-slate-700">
                <div className="flex items-center gap-4">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2"><Move size={24} className="text-amber-500" /> Editor de Layout Visual</h2>
                    <select
                        value={selectedRackId}
                        onChange={(e) => setSelectedRackId(e.target.value)}
                        className="bg-slate-900 border border-slate-600 text-white px-3 py-2 rounded-lg text-sm"
                    >
                        <option value="">Selecione uma Rig...</option>
                        {racks.map(r => <option key={r.id} value={r.id}>{r.name} ({r.id})</option>)}
                    </select>
                </div>
                {selectedRackId && (
                    <div className="flex items-center gap-6">
                        <div className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-700">
                            <span className="text-[10px] text-slate-500 font-bold uppercase transition-all">
                                {selectedIdx !== null ? `Ajuste Slot (PX)` : `Dimensões Skin (PX)`}
                            </span>
                            <input
                                type="number"
                                className={`w-16 bg-black text-xs px-2 py-1 rounded border transition-colors ${selectedIdx !== null ? 'border-amber-500 text-amber-400' : 'border-slate-600 text-white'}`}
                                value={selectedIdx !== null && layout.slots[selectedIdx]
                                    ? Math.round((layout.slots[selectedIdx].w / 100) * (layout.canvasWidth || 500))
                                    : (layout.canvasWidth || 0)}
                                onChange={e => {
                                    const val = parseInt(e.target.value) || 0;
                                    if (selectedIdx !== null && layout.slots[selectedIdx]) {
                                        updateSlotSize(selectedIdx, (val / (layout.canvasWidth || 500)) * 100, layout.slots[selectedIdx].h);
                                    } else {
                                        updateCanvasSize(val, layout.canvasHeight || 0);
                                    }
                                }}
                                placeholder="W"
                            />
                            <span className="text-slate-600">x</span>
                            <input
                                type="number"
                                className={`w-16 bg-black text-xs px-2 py-1 rounded border transition-colors ${selectedIdx !== null ? 'border-amber-500 text-amber-400' : 'border-slate-600 text-white'}`}
                                value={selectedIdx !== null && layout.slots[selectedIdx]
                                    ? Math.round((layout.slots[selectedIdx].h / 100) * (layout.canvasHeight || 800))
                                    : (layout.canvasHeight || 0)}
                                onChange={e => {
                                    const val = parseInt(e.target.value) || 0;
                                    if (selectedIdx !== null && layout.slots[selectedIdx]) {
                                        updateSlotSize(selectedIdx, layout.slots[selectedIdx].w, (val / (layout.canvasHeight || 800)) * 100);
                                    } else {
                                        updateCanvasSize(layout.canvasWidth || 0, val);
                                    }
                                }}
                                placeholder="H"
                            />
                            {selectedIdx !== null && (
                                <button
                                    onClick={() => setSelectedIdx(null)}
                                    className="ml-2 text-[10px] text-slate-500 hover:text-white underline uppercase tracking-tighter"
                                >
                                    Focar Skin
                                </button>
                            )}
                        </div>
                        <button onClick={handleSave} className="bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2 transition-all">
                            <Save size={18} /> SALVAR LAYOUT
                        </button>
                    </div>
                )}
            </div>

            {selectedRackId ? (
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                    {/* CONTROLS */}
                    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-4 shadow-xl">
                        <h3 className="font-bold text-slate-400 text-xs uppercase tracking-wider">Ferramentas</h3>
                        <div className="grid grid-cols-1 gap-2">
                            <button onClick={() => addNewSlot('machine')} className="w-full bg-slate-900 hover:bg-slate-700 p-3 rounded-lg border border-slate-700 text-left flex items-center gap-3 transition-colors">
                                <Cpu size={18} className="text-amber-500" /> <span className="text-sm">Adicionar Slot GPU</span>
                            </button>
                            <button onClick={() => addNewSlot('multiplier')} className="w-full bg-slate-900 hover:bg-slate-700 p-3 rounded-lg border border-slate-700 text-left flex items-center gap-3 transition-colors">
                                <Zap size={18} className="text-yellow-500" /> <span className="text-sm">Adicionar Slot IA</span>
                            </button>
                            <button onClick={() => addNewSlot('battery')} className="w-full bg-slate-900 hover:bg-slate-700 p-3 rounded-lg border border-slate-700 text-left flex items-center gap-3 transition-colors">
                                <Battery size={18} className="text-green-500" /> <span className="text-sm">Slot Bateria</span>
                            </button>
                            <button onClick={() => addNewSlot('wiring')} className="w-full bg-slate-900 hover:bg-slate-700 p-3 rounded-lg border border-slate-700 text-left flex items-center gap-3 transition-colors">
                                <Plug size={18} className="text-amber-500" /> <span className="text-sm">Slot Circuito</span>
                            </button>
                        </div>

                        <div className="pt-4 border-t border-slate-700 space-y-2">
                            <h3 className="font-bold text-slate-400 text-xs uppercase tracking-wider">Controles UI</h3>
                            <div className="grid grid-cols-1 gap-2">
                                <button onClick={() => addNewSlot('power')} className="w-full bg-slate-900 hover:bg-slate-700 p-3 rounded-lg border border-slate-700 text-left flex items-center gap-3 transition-colors">
                                    <Power size={18} className="text-green-500" /> <span className="text-sm">Botão Ligar/Desl</span>
                                </button>
                                <button onClick={() => addNewSlot('config')} className="w-full bg-slate-900 hover:bg-slate-700 p-3 rounded-lg border border-slate-700 text-left flex items-center gap-3 transition-colors">
                                    <Cog size={18} className="text-slate-400" /> <span className="text-sm">Botão Config</span>
                                </button>
                                <button onClick={() => addNewSlot('coin_selector')} className="w-full bg-slate-900 hover:bg-slate-700 p-3 rounded-lg border border-slate-700 text-left flex items-center gap-3 transition-colors">
                                    <Coins size={18} className="text-amber-500" /> <span className="text-sm">Seletor de Moeda</span>
                                </button>
                            </div>
                        </div>

                        <div className="pt-4 border-t border-slate-700 space-y-2">
                            <h3 className="font-bold text-slate-400 text-xs uppercase tracking-wider">Widgets de Informação</h3>
                            <div className="grid grid-cols-1 gap-2">
                                <button onClick={() => addNewSlot('battery_bar')} className="w-full bg-slate-900 hover:bg-slate-700 p-3 rounded-lg border border-slate-700 text-left flex items-center gap-3 transition-colors">
                                    <BarChart3 size={18} className="text-emerald-400" /> <span className="text-sm">Barra de Bateria</span>
                                </button>
                                <button onClick={() => addNewSlot('production_display')} className="w-full bg-slate-900 hover:bg-slate-700 p-3 rounded-lg border border-slate-700 text-left flex items-center gap-3 transition-colors">
                                    <Activity size={18} className="text-amber-400" /> <span className="text-sm">Display de Produção</span>
                                </button>
                                <button onClick={() => addNewSlot('stat_monitor')} className="w-full bg-slate-900 hover:bg-slate-700 p-3 rounded-lg border border-slate-700 text-left flex items-center gap-3 transition-colors">
                                    <Terminal size={18} className="text-slate-400" /> <span className="text-sm">Monitor de Status (CMD)</span>
                                </button>
                            </div>
                        </div>

                        <div className="pt-4 border-t border-slate-700 space-y-2">
                            <h3 className="font-bold text-slate-400 text-xs uppercase tracking-wider">Skin da Rig</h3>
                            <div className="flex flex-col gap-2">
                                <select
                                    value={imageUploadFolder}
                                    onChange={(e) => setImageUploadFolder(e.target.value)}
                                    className="text-xs bg-slate-900 border border-slate-600 rounded px-2 py-1 text-white"
                                    title="Pasta em /img/… (só admin)"
                                >
                                    {IMG_UPLOAD_FOLDERS.map((o) => (
                                        <option key={o.id || 'uploads'} value={o.id}>{o.label}</option>
                                    ))}
                                </select>
                                <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    id="skin-upload"
                                    onChange={handleImageUpload}
                                />
                                <label
                                    htmlFor="skin-upload"
                                    className="w-full bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 border border-amber-500/30 p-2 rounded text-center text-xs font-bold cursor-pointer transition-all"
                                >
                                    ALTERAR IMAGEM SKIN
                                </label>
                                {tempImage && (
                                    <button
                                        onClick={() => setTempImage(null)}
                                        className="text-[10px] text-red-500 hover:underline text-center"
                                    >
                                        Remover Imagem
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="pt-4 border-t border-slate-700">
                            <h3 className="font-bold text-slate-400 text-xs uppercase tracking-wider mb-2">Slots Criados ({layout.slots.length})</h3>
                            <div className="space-y-2 max-h-[30vh] overflow-y-auto custom-scrollbar pr-1">
                                {layout.slots.map((s, i) => (
                                    <div
                                        key={i}
                                        onClick={() => setSelectedIdx(i)}
                                        className={`bg-slate-900 p-2 rounded border flex justify-between items-center group cursor-pointer transition-all
                                            ${selectedIdx === i ? 'border-amber-500 bg-amber-500/5' : 'border-slate-700'}
                                        `}
                                    >
                                        <div className="flex flex-col">
                                            <span className="text-[10px] font-bold text-white">{s.id}</span>
                                            <span className="text-[8px] text-slate-500 lowercase">{s.type}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="flex flex-col gap-1">
                                                <div className="flex items-center gap-2">
                                                    <div className="flex items-center gap-1">
                                                        <span className="text-[8px] text-slate-500">W:</span>
                                                        <input
                                                            type="number"
                                                            className="w-10 bg-black text-[9px] border border-slate-700 rounded px-1"
                                                            value={Math.round(s.w)}
                                                            onChange={e => updateSlotSize(i, parseInt(e.target.value), s.h)}
                                                        />
                                                        <span className="text-[8px] text-slate-500">%</span>
                                                    </div>
                                                    {layout.canvasWidth && (
                                                        <div className="flex items-center gap-1 border-l border-slate-700 pl-1">
                                                            <input
                                                                type="number"
                                                                className="w-10 bg-slate-800 text-[9px] border border-slate-700 rounded px-1 text-amber-400"
                                                                value={Math.round((s.w / 100) * layout.canvasWidth)}
                                                                onChange={e => updateSlotSize(i, (parseInt(e.target.value) / layout.canvasWidth!) * 100, s.h)}
                                                            />
                                                            <span className="text-[8px] text-slate-500">px</span>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <div className="flex items-center gap-1">
                                                        <span className="text-[8px] text-slate-500">H:</span>
                                                        <input
                                                            type="number"
                                                            className="w-10 bg-black text-[9px] border border-slate-700 rounded px-1"
                                                            value={Math.round(s.h)}
                                                            onChange={e => updateSlotSize(i, s.w, parseInt(e.target.value))}
                                                        />
                                                        <span className="text-[8px] text-slate-500">%</span>
                                                    </div>
                                                    {layout.canvasHeight && (
                                                        <div className="flex items-center gap-1 border-l border-slate-700 pl-1">
                                                            <input
                                                                type="number"
                                                                className="w-10 bg-slate-800 text-[9px] border border-slate-700 rounded px-1 text-amber-400"
                                                                value={Math.round((s.h / 100) * layout.canvasHeight)}
                                                                onChange={e => updateSlotSize(i, s.w, (parseInt(e.target.value) / layout.canvasHeight!) * 100)}
                                                            />
                                                            <span className="text-[8px] text-slate-500">px</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <button onClick={() => removeSlot(i)} className="text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 size={12} /></button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* CANVAS */}
                    <div className="lg:col-span-3 space-y-4">
                        <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden relative flex items-center justify-center p-8 bg-[radial-gradient(circle_at_center,_#1e293b_0%,_#020617_100%)]" style={{ height: '70vh' }}>
                            <div
                                ref={canvasRef}
                                onClick={(e) => {
                                    if (e.target === canvasRef.current) {
                                        setSelectedIdx(null);
                                    }
                                }}
                                className={`bg-slate-950 rounded-lg shadow-2xl border-2 relative transition-all ${isResizingCanvas ? 'border-amber-500 ring-4 ring-amber-500/20' : 'border-slate-700/50 hover:border-slate-500'}`}
                                style={{
                                    backgroundImage: tempImage ? `url(${JSON.stringify(tempImage)})` : 'none',
                                    backgroundSize: '100% 100%',
                                    backgroundRepeat: 'no-repeat',
                                    width: layout.canvasWidth ? `${layout.canvasWidth}px` : '100%',
                                    height: layout.canvasHeight ? `${layout.canvasHeight}px` : '100%',
                                    maxHeight: '100%',
                                    maxWidth: '100%',
                                    flexShrink: 0
                                }}
                                onMouseMove={handleMouseMove}
                                onMouseUp={handleMouseUp}
                                onMouseLeave={handleMouseUp}
                            >
                                {/* Canvas Resize Handle */}
                                <div
                                    onMouseDown={handleCanvasResizeStart}
                                    className="absolute bottom-0 right-0 w-4 h-4 bg-amber-600 rounded-tl cursor-nwse-resize z-50 flex items-center justify-center hover:bg-amber-500 transition-colors"
                                >
                                    <div className="w-1.5 h-1.5 border-r border-b border-white opacity-60"></div>
                                </div>

                                {/* Grid Helper */}
                                <div className="absolute inset-0 pointer-events-none opacity-20" style={{
                                    backgroundImage: `linear-gradient(to right, #334155 1px, transparent 1px), linear-gradient(to bottom, #334155 1px, transparent 1px)`,
                                    backgroundSize: '10% 10%'
                                }}></div>

                                {layout.slots.map((s, i) => (
                                    <div
                                        key={i}
                                        onMouseDown={(e) => handleMouseDown(i, e)}
                                        onClick={(e) => e.stopPropagation()}
                                        className={`
                                            absolute cursor-move flex flex-col items-center justify-center transition-shadow border
                                            ${draggingIdx === i || resizingIdx === i || selectedIdx === i ? 'ring-2 ring-white z-50 shadow-2xl scale-105 border-white' : 'border-white/20 z-10 hover:border-white/50'}
                                            ${s.type === 'machine' ? 'bg-amber-600/20' :
                                                s.type === 'multiplier' ? 'bg-yellow-600/20' :
                                                    s.type === 'battery' ? 'bg-green-600/20' :
                                                        s.type === 'battery_bar' ? 'bg-emerald-600/20' :
                                                            s.type === 'stat_monitor' ? 'bg-slate-800/60' :
                                                                s.type === 'production_display' ? 'bg-amber-600/20' : 'bg-amber-600/20'}
                                        `}
                                        style={{
                                            left: `${s.x}%`,
                                            top: `${s.y}%`,
                                            width: `${s.w}%`,
                                            height: `${s.h}%`,
                                        }}
                                    >
                                        {/* Slot Resize Handle */}
                                        <div
                                            onMouseDown={(e) => handleResizeStart(i, e)}
                                            className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-white/30 hover:bg-white/80 cursor-nwse-resize z-[60]"
                                        ></div>

                                        <div className="bg-black/40 backdrop-blur-sm p-0.5 rounded flex items-center gap-1 border border-white/10 pointer-events-none select-none">
                                            {s.type === 'machine' && <Cpu size={8} className="text-amber-400" />}
                                            {s.type === 'multiplier' && <Zap size={8} className="text-yellow-400" />}
                                            {s.type === 'battery' && <Battery size={8} className="text-green-400" />}
                                            {s.type === 'wiring' && <Plug size={8} className="text-amber-400" />}
                                            {s.type === 'power' && <Power size={8} className="text-green-500" />}
                                            {s.type === 'config' && <Cog size={8} className="text-slate-400" />}
                                            {s.type === 'coin_selector' && <Coins size={8} className="text-amber-500" />}
                                            {s.type === 'battery_bar' && <BarChart3 size={8} className="text-emerald-400" />}
                                            {s.type === 'production_display' && <Activity size={8} className="text-amber-400" />}
                                            {s.type === 'stat_monitor' && <Terminal size={8} className="text-slate-400" />}
                                            <span className="text-[7px] text-white font-mono">{s.id}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Info Overlay */}
                            <div className="absolute bottom-6 left-6 right-6 flex justify-between items-center pointer-events-none">
                                <span className="bg-black/60 backdrop-blur px-3 py-1 rounded-full text-[10px] text-slate-400 border border-slate-700">Arraste os slots para posicionar sobre a arte.</span>
                                <div className="flex gap-4">
                                    <div className="flex items-center gap-2 bg-black/60 backdrop-blur px-3 py-1 rounded-full text-[10px] text-slate-400 border border-slate-700">
                                        <span className="w-2 h-2 rounded bg-amber-600"></span> GPU
                                    </div>
                                    <div className="flex items-center gap-2 bg-black/60 backdrop-blur px-3 py-1 rounded-full text-[10px] text-slate-400 border border-slate-700">
                                        <span className="w-2 h-2 rounded bg-yellow-600"></span> IA
                                    </div>
                                </div>
                            </div>
                        </div>

                        {!tempImage && (
                            <div className="bg-amber-900/20 border border-amber-900/50 p-4 rounded-xl flex items-center gap-3 text-amber-500">
                                <AlertCircle size={20} />
                                <span className="text-xs">Esta Rig não possui uma imagem de skin. Suba uma imagem acima para ver o fundo real.</span>
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <div className="h-[60vh] bg-slate-800 border border-slate-700 rounded-xl flex flex-col items-center justify-center text-slate-500 gap-4">
                    <Move size={48} className="opacity-20 text-amber-500" />
                    <p className="text-sm">Selecione uma Rig no menu acima para começar a editar o layout.</p>
                </div>
            )}
        </div>
    );
};
