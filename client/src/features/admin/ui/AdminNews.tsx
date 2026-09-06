// @ts-nocheck — template legado 1:1.
import React, { useEffect, useState } from 'react';
import { SystemNews, AccessLevel } from '../lib/adminTypes';
import { PlusCircle, Newspaper, Edit, Trash2, ToggleLeft, ToggleRight, DollarSign, CheckCircle2, XCircle, Layout, Image as ImageIcon } from 'lucide-react';
import { RemoteBannerImage } from '../../mini-blog/ui/RemoteBannerImage';
import { addOrUpdateNews, deleteNews, getNewsFee, setNewsFee, getPendingPlayerNews, approvePlayerNews, rejectPlayerNews, getNewsExpireDays, setNewsExpireDays, uploadAdImage } from '../../../shared/api/admin-legacy';

interface AdminNewsProps {
    newsList: SystemNews[];
    setNewsList: (news: SystemNews[]) => void;
    accessLevels?: AccessLevel[];
    onUpdateAccessLevels?: (levels: AccessLevel[]) => void;
}

export const AdminNews: React.FC<AdminNewsProps> = ({ newsList, setNewsList, accessLevels = [], onUpdateAccessLevels }) => {
    const [newNewsText, setNewNewsText] = useState('');
    const [newNewsLink, setNewNewsLink] = useState('');
    const [newNewsDuration, setNewNewsDuration] = useState<number>(60);
    const [adType, setAdType] = useState<'horizontal' | 'vertical'>('horizontal');
    const [imageUrl, setImageUrl] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [newsFee, setNewsFeeState] = useState<number>(0);
    const [pendingSubs, setPendingSubs] = useState<Array<{ id: string; userId: number; username: string; email: string; text: string; link?: string; status: string; createdAt: number }>>([]);
    const [expireDays, setExpireDays] = useState<number>(0);

    useEffect(() => {
        (async () => {
            const fee = await getNewsFee();
            setNewsFeeState(fee);
            const pending = await getPendingPlayerNews();
            setPendingSubs(pending);
            const ed = await getNewsExpireDays();
            setExpireDays(ed);
        })();
    }, []);

    const handleAddOrUpdateNews = () => {
        if (!newNewsText && !imageUrl) return;
        let updated: SystemNews[];

        const itemData = {
            text: newNewsText,
            link: newNewsLink || undefined,
            duration: newNewsDuration,
            adType: adType,
            imageUrl: imageUrl || undefined
        };

        if (editingId) {
            updated = newsList.map(item =>
                item.id === editingId ? { ...item, ...itemData } : item
            );
            setEditingId(null);
        } else {
            const newItem: SystemNews = {
                id: crypto.randomUUID(),
                text: newNewsText,
                link: newNewsLink || undefined,
                duration: newNewsDuration,
                active: true,
                createdAt: Date.now(),
                adType: adType,
                imageUrl: imageUrl || undefined
            };
            updated = [newItem, ...newsList];
        }

        setNewsList(updated);
        const itemToSave = editingId ? updated.find(n => n.id === editingId)! : updated[0];

        addOrUpdateNews({
            id: itemToSave.id,
            text: itemToSave.text,
            link: itemToSave.link,
            duration: itemToSave.duration,
            authorName: editingId ? undefined : 'Admin',
            adType: itemToSave.adType,
            imageUrl: itemToSave.imageUrl
        });

        setNewNewsText(''); setNewNewsLink(''); setNewNewsDuration(60); setImageUrl(''); setAdType('horizontal');
    };

    const startEditingNews = (item: SystemNews) => {
        setNewNewsText(item.text);
        setNewNewsLink(item.link || '');
        setNewNewsDuration(item.duration || 60);
        setAdType(item.adType || 'horizontal');
        setImageUrl(item.imageUrl || '');
        setEditingId(item.id);
    };

    const toggleLevelNewsPosting = (levelId: string, enabled: boolean) => {
        if (!onUpdateAccessLevels) return;
        const updated = accessLevels.map(l => l.id === levelId ? { ...l, newsPostingEnabled: enabled } : l);
        onUpdateAccessLevels(updated);
    };

    const saveNewsFee = async () => {
        await setNewsFee(newsFee);
        alert('Taxa de publicação atualizada.');
    };

    const approveSubmission = async (id: string) => {
        const res = await approvePlayerNews(id);
        if (res?.ok) {
            setPendingSubs(p => p.filter(x => x.id !== id));
            alert('Notícia aprovada e publicada.');
        }
    };

    const rejectSubmission = async (id: string) => {
        const res = await rejectPlayerNews(id);
        if (res?.ok) {
            setPendingSubs(p => p.filter(x => x.id !== id));
            alert('Notícia rejeitada.');
        }
    };

    const handleDeleteNews = (id: string) => {
        const updated = newsList.filter(n => n.id !== id);
        setNewsList(updated);
        deleteNews(id);
        if (editingId === id) {
            setNewNewsText(''); setNewNewsLink(''); setNewNewsDuration(60); setImageUrl(''); setEditingId(null);
        }
    };

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-in fade-in slide-in-from-right-4">
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
                <h3 className="text-white font-bold mb-4 flex items-center gap-2">
                    <PlusCircle size={20} className="text-green-500" /> {editingId ? 'Editar Anúncio' : 'Novo Anúncio'}
                </h3>
                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs uppercase font-bold text-slate-500 mb-1 block">Tipo de Anúncio</label>
                            <select
                                value={adType}
                                onChange={e => setAdType(e.target.value as any)}
                                className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm"
                            >
                                <option value="horizontal">Horizontal (Topo - 320x50)</option>
                                <option value="vertical">Vertical (Lateral - 160x600)</option>
                            </select>
                        </div>
                        <div>
                            <label className="text-xs uppercase font-bold text-slate-500 mb-1 block">Duração (Segundos)</label>
                            <input type="number" value={newNewsDuration} onChange={e => setNewNewsDuration(parseInt(e.target.value))} className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm" />
                        </div>
                    </div>

                    <div>
                        <label className="text-xs uppercase font-bold text-slate-500 mb-1 block">Texto do Anúncio / Alt</label>
                        <input type="text" value={newNewsText} onChange={e => setNewNewsText(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm" placeholder="Ex: Promoção de Hardware!" />
                    </div>

                    <div>
                        <label className="text-xs uppercase font-bold text-slate-500 mb-1 block">URL da Imagem (PNG, JPG, GIF)</label>
                        <div className="flex gap-2">
                            <div className="flex-1 relative">
                                <ImageIcon size={18} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                                <input type="text" value={imageUrl} onChange={e => setImageUrl(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded p-2 pl-9 text-white text-sm" placeholder="https://exemplo.com/banner.gif" />
                            </div>
                            <label className="bg-slate-700 hover:bg-slate-600 text-white px-3 py-2 rounded cursor-pointer transition-colors flex items-center justify-center shrink-0">
                                <PlusCircle size={16} />
                                <input
                                    type="file"
                                    className="hidden"
                                    accept="image/*"
                                    onChange={async (e) => {
                                        const file = e.target.files?.[0];
                                        if (file) {
                                            const res = await uploadAdImage(file);
                                            if (res.ok && res.imageUrl) {
                                                setImageUrl(res.imageUrl);
                                            } else {
                                                alert('Erro no upload: ' + (res.error || 'Erro desconhecido'));
                                            }
                                        }
                                    }}
                                />
                            </label>
                        </div>
                    </div>

                    <div>
                        <label className="text-xs uppercase font-bold text-slate-500 mb-1 block">Link de Destino</label>
                        <input type="text" value={newNewsLink} onChange={e => setNewNewsLink(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm" placeholder="https://..." />
                    </div>

                    {/* Preview Area */}
                    {(imageUrl || newNewsText) && (
                        <div className="mt-4 p-4 bg-slate-900/50 rounded-lg border border-slate-700">
                            <label className="text-[10px] uppercase font-bold text-slate-500 mb-2 block tracking-widest text-center">Pré-visualização</label>
                            <div className="flex justify-center">
                                <div className={`overflow-hidden rounded border border-slate-700 bg-slate-950 flex items-center justify-center ${adType === 'horizontal' ? 'w-[160px] h-[25px]' : 'w-[40px] h-[150px]'}`}>
                                    {imageUrl ? (
                                        <RemoteBannerImage
                                            src={imageUrl}
                                            alt={newNewsText || 'Pré-visualização'}
                                            className="w-full h-full object-cover"
                                            failureHint="URL falhou (404/502/522)"
                                        />
                                    ) : (
                                        <span className="text-[8px] text-slate-600 text-center px-1 leading-none">{newNewsText}</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    <button onClick={handleAddOrUpdateNews} disabled={!newNewsText && !imageUrl} className="bg-green-600 hover:bg-green-500 text-white px-4 py-3 rounded-lg font-bold text-sm w-full transition-all shadow-lg shadow-green-900/20 active:scale-95 uppercase tracking-wider">
                        {editingId ? 'ATUALIZAR ANÚNCIO' : 'PUBLICAR ANÚNCIO'}
                    </button>
                    {editingId && <button onClick={() => { setEditingId(null); setNewNewsText(''); setImageUrl(''); }} className="w-full text-xs text-slate-500 hover:text-white uppercase font-bold">Cancelar Edição</button>}
                </div>
            </div>

            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
                <h3 className="text-white font-bold mb-4 flex items-center gap-2">
                    <Newspaper size={20} className="text-amber-500" /> Anúncios Ativos
                </h3>
                <div className="space-y-2 h-[400px] overflow-y-auto custom-scrollbar pr-2">
                    {newsList.map(item => (
                        <div key={item.id} className="bg-slate-900 p-3 rounded-lg border border-slate-700 flex justify-between items-center group hover:border-amber-500/50 transition-colors">
                            <div className="flex items-center gap-3 overflow-hidden">
                                <div className={`shrink-0 rounded border border-slate-800 bg-slate-950 overflow-hidden flex items-center justify-center ${item.adType === 'vertical' ? 'w-8 h-12' : 'w-12 h-6'}`}>
                                    {item.imageUrl ? (
                                        <RemoteBannerImage
                                            src={item.imageUrl}
                                            alt={item.text || 'Anúncio'}
                                            className="w-full h-full object-cover"
                                            failureHint="Falhou"
                                            compact
                                        />
                                    ) : (
                                        <Layout size={12} className="text-slate-700" />
                                    )}
                                </div>
                                <div className="min-w-0">
                                    <div className="text-sm text-white font-bold truncate">{item.text || 'Sem texto'}</div>
                                    <div className="flex items-center gap-2 text-[10px] text-slate-500 uppercase font-bold">
                                        <span className={item.adType === 'vertical' ? 'text-orange-400' : 'text-amber-400'}>{item.adType === 'vertical' ? 'Vertical' : 'Horizontal'}</span>
                                        <span>•</span>
                                        <span>{item.duration}s</span>
                                    </div>
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <button onClick={() => startEditingNews(item)} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors" title="Editar"><Edit size={16} /></button>
                                <button onClick={() => handleDeleteNews(item.id)} className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-900/20 rounded transition-colors" title="Excluir"><Trash2 size={16} /></button>
                            </div>
                        </div>
                    ))}
                    {newsList.length === 0 && <div className="text-center py-10 text-slate-600 italic">Nenhum anúncio publicado.</div>}
                </div>
            </div>

            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
                <h3 className="text-white font-bold mb-4 flex items-center gap-2">
                    <Newspaper size={20} className="text-yellow-500" /> Configurações de Publicação (Jogadores)
                </h3>
                <div className="space-y-4">
                    <div className="flex items-end gap-2">
                        <div className="flex-1">
                            <label className="text-xs uppercase font-bold text-slate-500 mb-1 block">Taxa por publicação (USDC)</label>
                            <div className="relative">
                                <DollarSign size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input type="number" value={newsFee} onChange={e => setNewsFeeState(parseFloat(e.target.value || '0'))} className="w-full bg-slate-900 border border-slate-700 rounded p-2 pl-8 text-white text-sm" />
                            </div>
                        </div>
                        <button onClick={saveNewsFee} className="bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded font-bold text-xs h-[38px] transition-colors">SALVAR</button>
                    </div>

                    <div>
                        <label className="text-xs uppercase font-bold text-slate-500 mb-1 block">Tempo de expiração (dias)</label>
                        <div className="flex items-center gap-2">
                            <input type="number" min={0} value={expireDays} onChange={e => setExpireDays(parseInt(e.target.value || '0'))} className="flex-1 bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm" />
                            <button onClick={async () => { await setNewsExpireDays(expireDays); alert('Expiração atualizada.'); }} className="bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded font-bold text-xs h-[38px] transition-colors">SALVAR</button>
                        </div>
                    </div>

                    <div>
                        <label className="text-xs uppercase font-bold text-slate-500 mb-2 block">Níveis autorizados a postar</label>
                        <div className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar pr-2">
                            {accessLevels.map(l => (
                                <div key={l.id} className="flex items-center justify-between bg-slate-900 p-2 px-3 rounded border border-slate-700">
                                    <div className="text-sm text-white font-bold">{l.name}</div>
                                    <button onClick={() => toggleLevelNewsPosting(l.id, !(l.newsPostingEnabled))} className="transition-transform active:scale-90">
                                        {l.newsPostingEnabled ? <ToggleRight size={24} className="text-green-500" /> : <ToggleLeft size={24} className="text-slate-500" />}
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
                <h3 className="text-white font-bold mb-4 flex items-center gap-2">
                    <Newspaper size={20} className="text-orange-500" /> Submissões Pendentes
                </h3>
                <div className="space-y-2 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
                    {pendingSubs.map(item => (
                        <div key={item.id} className="bg-slate-900 p-4 rounded-lg border border-slate-700 flex flex-col gap-3">
                            <div>
                                <div className="text-sm text-white font-bold italic">"{item.text}"</div>
                                {item.link && <div className="text-xs text-amber-400 flex items-center gap-1 mt-1"><Layout size={10} /> {item.link}</div>}
                            </div>
                            <div className="flex items-center justify-between mt-1 pt-3 border-t border-slate-800">
                                <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                                    {item.username} <span className="opacity-50">•</span> {item.email}
                                </div>
                                <div className="flex gap-2">
                                    <button onClick={() => approveSubmission(item.id)} className="bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 rounded text-[10px] font-bold flex items-center gap-1 transition-colors"><CheckCircle2 size={12} /> APROVAR</button>
                                    <button onClick={() => rejectSubmission(item.id)} className="bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded text-[10px] font-bold flex items-center gap-1 transition-colors"><XCircle size={12} /> REJEITAR</button>
                                </div>
                            </div>
                        </div>
                    ))}
                    {pendingSubs.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-20 text-slate-600 opacity-50">
                            <CheckCircle2 size={48} className="mb-2" />
                            <p className="text-xs font-bold uppercase">Tudo limpo! Nenhuma submissão pendente.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
