// @ts-nocheck — template legado 1:1.
import React, { useState, useEffect } from 'react';
import { Database as DbIcon, Download, RotateCcw, Trash2, Plus, AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '../../../shared/api/http';

interface BackupFile {
    filename: string;
    size: number;
    createdAt: number;
}

export const AdminBackup: React.FC = () => {
    const [backups, setBackups] = useState<BackupFile[]>([]);
    const [loading, setLoading] = useState(false);
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [backupName, setBackupName] = useState('');
    const [message, setMessage] = useState<{ text: string, type: 'success' | 'error' } | null>(null);
    const [showConfirmRestore, setShowConfirmRestore] = useState<string | null>(null);

    const loadBackups = async () => {
        setLoading(true);
        try {
            const resp = await apiFetch('/api/admin/backups');
            if (resp.ok) {
                const data = await resp.json();
                setBackups(Array.isArray(data) ? data : []);
            } else {
                setBackups([]);
            }
        } catch (e) {
            console.error('Erro ao carregar backups:', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadBackups();
    }, []);

    const handleCreateBackup = async () => {
        if (actionLoading) return;
        setActionLoading('create');
        setMessage(null);
        try {
            const resp = await apiFetch('/api/admin/backup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: backupName || 'manual_backup' })
            });
            if (resp.ok) {
                try {
                    const j = await resp.json();
                    const fn = typeof j.filename === 'string' ? j.filename : '';
                    if (fn && !fn.toLowerCase().endsWith('.sql')) {
                        setMessage({
                            text: `Resposta inesperada: «${fn}». O backup manual deve ser .sql (pg_dump). Reinicie o servidor com a versão atual do código ou instale pg_dump no PATH.`,
                            type: 'error'
                        });
                        loadBackups();
                        return;
                    }
                    const mib = typeof j.bytes === 'number' ? (j.bytes / (1024 * 1024)).toFixed(2) : null;
                    const extra = mib != null ? ` ${mib} MiB.` : '';
                    const namePart = fn ? ` Ficheiro: ${fn}.` : '';
                    setMessage({
                        text: `Backup SQL completo (schema + dados + constraints) criado no servidor.${namePart}${extra}`,
                        type: 'success'
                    });
                } catch {
                    setMessage({ text: 'Backup criado. Atualize a lista ao lado e confirme que o ficheiro termina em .sql.', type: 'success' });
                }
                setBackupName('');
                loadBackups();
            } else {
                let errText = 'Falha ao criar backup.';
                try {
                    const j = await resp.json();
                    if (j.error) errText = j.error;
                } catch {
                    /* ignore */
                }
                setMessage({ text: errText, type: 'error' });
            }
        } catch (e) {
            setMessage({ text: 'Erro de conexão.', type: 'error' });
        } finally {
            setActionLoading(null);
        }
    };

    const handleDeleteBackup = async (filename: string) => {
        if (actionLoading) return;
        setActionLoading(`delete-${filename}`);
        try {
            const resp = await apiFetch(`/api/admin/backups/${filename}`, { method: 'DELETE' });
            if (resp.ok) {
                loadBackups();
            }
        } catch (e) {
            console.error('Erro ao deletar:', e);
        } finally {
            setActionLoading(null);
        }
    };

    const handleRestore = async (filename: string) => {
        if (actionLoading) return;
        setActionLoading(`restore-${filename}`);
        setMessage(null);
        try {
            const resp = await apiFetch('/api/admin/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename })
            });
            if (resp.ok) {
                let msg = 'Operação de restauração concluída.';
                try {
                    const j = await resp.json();
                    if (j.message) msg = j.message;
                } catch {
                    /* ignore */
                }
                setMessage({ text: msg, type: 'success' });
                setShowConfirmRestore(null);
            } else {
                const err = await resp.json();
                setMessage({ text: `Falha na restauração: ${err.error || 'Erro desconhecido'}`, type: 'error' });
            }
        } catch (e) {
            setMessage({ text: 'Erro crítico na restauração.', type: 'error' });
        } finally {
            setActionLoading(null);
        }
    };

    const handleDownload = (filename: string) => {
        window.open(`/api/admin/backups/download/${filename}`, '_blank');
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (actionLoading) return;
        setActionLoading('upload');
        setMessage(null);

        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const base64 = (reader.result as string).split(',')[1];
                const resp = await apiFetch('/api/admin/backups/upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: file.name, content: base64 })
                });

                if (resp.ok) {
                    setMessage({ text: 'Backup enviado com sucesso!', type: 'success' });
                    loadBackups();
                } else {
                    const err = await resp.json();
                    setMessage({ text: `Falha no envio: ${err.error || 'Erro desconhecido'}`, type: 'error' });
                }
            } catch (e) {
                setMessage({ text: 'Erro ao processar arquivo.', type: 'error' });
            } finally {
                setActionLoading(null);
                e.target.value = '';
            }
        };
        reader.readAsDataURL(file);
    };

    const formatSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const sortedBackups = [...backups].sort((a, b) => b.createdAt - a.createdAt);

    return (
        <div className="space-y-6 min-w-0 max-w-full">
            <div className="flex flex-col gap-4 border-b border-slate-700 pb-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-bold text-white flex flex-wrap items-center gap-2 sm:text-2xl">
                        <DbIcon className="text-red-500 shrink-0" /> Gerenciador de Backups
                    </h2>
                    <p className="text-slate-400 text-sm leading-relaxed break-words">
                        O botão abaixo gera sempre <strong className="text-slate-200">.sql</strong> com <code className="text-slate-300">pg_dump</code> (schema, dados, constraints). Ficheiros <code className="text-slate-300">.json</code> na lista são só legado — não voltam a ser criados pelo painel atual.
                        Dump automático: <code className="text-slate-300">auto_pgdump_*.sql</code> (worker em segundo plano).
                    </p>
                    <p className="mt-2 text-xs text-slate-500 break-words">
                        Se aparecer erro com <code className="text-slate-400">ENOENT</code>: o processo Node não encontrou <code className="text-slate-400">pg_dump</code>. No deploy com Docker do repositório atual, faça <strong className="text-slate-300">rebuild da imagem</strong> do serviço <code className="text-slate-400">app</code> (o Dockerfile já inclui <code className="text-slate-400">postgresql-client</code>).
                    </p>
                </div>
                <div className="flex shrink-0 lg:justify-end">
                    <label className={`cursor-pointer bg-slate-700 hover:bg-slate-600 text-white px-3 py-2 sm:px-4 rounded font-bold text-xs sm:text-sm transition-all inline-flex items-center gap-2 max-w-full ${actionLoading === 'upload' ? 'opacity-50 pointer-events-none' : ''}`}>
                        {actionLoading === 'upload' ? <Loader2 size={18} className="animate-spin shrink-0" /> : <Download size={18} className="rotate-180 shrink-0" />}
                        <span className="min-w-0 text-left leading-snug">Subir backup (.sql / .dump / .json / .db …)</span>
                        <input type="file" onChange={handleUpload} className="hidden" accept=".db,.sqlite,.back,.json,.sql,.dump,.gz" />
                    </label>
                </div>
            </div>

            {message && (
                <div className={`p-4 rounded border flex flex-col gap-2 ${message.type === 'success' ? 'bg-green-900/20 border-green-900 text-green-400' : 'bg-red-900/20 border-red-900 text-red-400'}`}>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
                        <div className="flex shrink-0 gap-3 sm:contents">
                            {message.type === 'success' ? <CheckCircle2 size={20} className="shrink-0 mt-0.5" /> : <AlertTriangle size={20} className="shrink-0 mt-0.5" />}
                            <span className="text-sm font-bold break-words min-w-0 flex-1">{message.text}</span>
                        </div>
                        <button type="button" onClick={() => setMessage(null)} className="self-end text-xs opacity-70 hover:opacity-100 sm:ml-auto sm:self-start shrink-0">Fechar</button>
                    </div>
                    {message.type === 'error' && message.text.includes('ENOENT') && (
                        <div className="rounded border border-red-800/60 bg-slate-950/40 p-3 text-xs font-normal text-red-200/90 leading-relaxed">
                            <p className="font-bold text-red-300 mb-2">O que fazer no servidor</p>
                            <ol className="list-decimal pl-4 space-y-2">
                                <li>
                                    <strong>Docker Compose</strong> (este repo): na pasta do projeto, executar{' '}
                                    <code className="rounded bg-slate-900 px-1 py-0.5 text-[11px] text-amber-200/90">docker compose build --no-cache app &amp;&amp; docker compose up -d app</code>
                                    {' '}para reconstruir a imagem com <code className="text-slate-300">postgresql-client</code>.
                                </li>
                                <li>
                                    <strong>VM sem Docker</strong>: instalar o cliente PostgreSQL (ex.: Debian/Ubuntu:{' '}
                                    <code className="rounded bg-slate-900 px-1 py-0.5 text-[11px] text-amber-200/90">sudo apt install postgresql-client</code>
                                    ), depois confirmar <code className="text-slate-300">which pg_dump</code>.
                                </li>
                                <li>
                                    <strong>Binário noutro caminho</strong>: no <code className="text-slate-300">.env</code> do backend,{' '}
                                    <code className="rounded bg-slate-900 px-1 py-0.5 text-[11px] text-amber-200/90">PG_DUMP_PATH=/caminho/absoluto/pg_dump</code>
                                    {' '}(ver <code className="text-slate-300">.env.example</code> na raiz).
                                </li>
                            </ol>
                        </div>
                    )}
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="md:col-span-1 space-y-6">
                    <div className="bg-slate-800/50 p-6 rounded-xl border border-slate-700 space-y-4">
                        <h3 className="text-lg font-bold text-white flex items-center gap-2">
                            <Plus className="text-green-500" size={18} /> Backup manual (SQL)
                        </h3>
                        <p className="text-[11px] text-slate-500 leading-relaxed">
                            Gera agora um ficheiro <span className="text-slate-400 font-mono">.sql</span> completo (pg_dump) no servidor. Na tabela ao lado, use o botão de download para gravar esse SQL no seu computador.
                        </p>
                        <div>
                            <label className="block text-xs uppercase text-slate-500 mb-1 font-bold">Identificador (Opcional)</label>
                            <input
                                type="text"
                                value={backupName}
                                onChange={e => setBackupName(e.target.value)}
                                placeholder="ex: antes_da_update"
                                className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:border-red-500 outline-none"
                            />
                        </div>
                        <button
                            onClick={handleCreateBackup}
                            disabled={!!actionLoading}
                            className="w-full bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-bold py-2 rounded transition-all flex items-center justify-center gap-2 shadow-lg shadow-red-600/20"
                        >
                            {actionLoading === 'create' ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
                            Gerar SQL no servidor
                        </button>
                    </div>

                    <div className="bg-amber-900/10 p-6 rounded-xl border border-amber-900/30 space-y-3">
                        <h3 className="text-amber-500 font-bold flex items-center gap-2">
                            <AlertTriangle size={18} /> Aviso de Restauração
                        </h3>
                        <p className="text-xs text-amber-500/80 leading-relaxed space-y-2">
                            <span className="block">
                                Ficheiros <strong className="text-amber-400">.sql</strong> (pg_dump plain) e dumps binários <strong className="text-amber-400">.dump</strong> são aplicados com <code className="text-amber-300/90">psql</code> / <code className="text-amber-300/90">pg_restore</code> sobre a base atual — pode apagar e recriar objetos conforme o conteúdo do dump.
                            </span>
                            <span className="block">
                                Backups antigos em <strong className="text-amber-400">JSON</strong> continuam a usar <strong className="text-amber-400">merge</strong> (inserção por tabela, sem reescrever o schema).
                            </span>
                        </p>
                    </div>
                </div>

                <div className="md:col-span-2">
                    <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden">
                        <div className="p-4 border-b border-slate-700 flex items-center justify-between bg-slate-900/50">
                            <h3 className="font-bold text-white">Backups no servidor</h3>
                            <button onClick={loadBackups} className="text-xs text-slate-400 hover:text-white flex items-center gap-1">
                                {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Atualizar
                            </button>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead className="text-xs uppercase text-slate-500 bg-slate-900/30 font-bold">
                                    <tr>
                                        <th className="px-6 py-3">Arquivo</th>
                                        <th className="px-6 py-3">Tamanho</th>
                                        <th className="px-6 py-3 text-right">Ações (baixar .sql)</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-700/50">
                                    {sortedBackups.length === 0 ? (
                                        <tr>
                                            <td colSpan={3} className="px-6 py-12 text-center text-slate-500 italic">
                                                Nenhum backup encontrado no diretório.
                                            </td>
                                        </tr>
                                    ) : (
                                        sortedBackups.map(b => (
                                            <tr key={b.filename} className="hover:bg-slate-700/30 transition-colors group">
                                                <td className="px-6 py-4">
                                                    <div className="flex flex-col">
                                                        <span className="text-white font-medium truncate max-w-xs" title={b.filename}>{b.filename}</span>
                                                        <span className="text-[10px] text-slate-500 flex flex-wrap items-center gap-1">
                                                            {new Date(b.createdAt).toLocaleString()}
                                                            {b.filename.toLowerCase().endsWith('.sql') && (
                                                                <span className="font-bold uppercase text-emerald-600/90 dark:text-emerald-400/90">SQL</span>
                                                            )}
                                                            {b.filename.toLowerCase().endsWith('.json') && (
                                                                <span className="font-bold uppercase text-amber-600/90 dark:text-amber-400/90" title="Export antigo; use Gerar SQL para dump completo">
                                                                    JSON legado
                                                                </span>
                                                            )}
                                                            {b.filename.startsWith('auto_pgdump_') && (
                                                                <span className="text-cyan-600/90 dark:text-cyan-400/90 font-bold uppercase">automático</span>
                                                            )}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 text-slate-400">{formatSize(b.size)}</td>
                                                <td className="px-6 py-4 text-right">
                                                    <div className="flex items-center justify-end gap-2">
                                                        {showConfirmRestore === b.filename ? (
                                                            <div className="flex items-center gap-1 bg-amber-900/30 p-1 rounded border border-amber-900/50">
                                                                <span className="text-[10px] text-amber-500 px-2 font-bold uppercase">Confirmar?</span>
                                                                <button
                                                                    onClick={() => handleRestore(b.filename)}
                                                                    className="bg-amber-600 hover:bg-amber-500 text-white text-[10px] px-2 py-1 rounded font-bold"
                                                                >
                                                                    Sim
                                                                </button>
                                                                <button
                                                                    onClick={() => setShowConfirmRestore(null)}
                                                                    className="text-slate-400 hover:text-white text-[10px] px-2 py-1"
                                                                >
                                                                    Não
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <>
                                                                <button
                                                                    onClick={() => handleDownload(b.filename)}
                                                                    disabled={!!actionLoading}
                                                                    className="p-2 text-slate-400 hover:text-amber-500 transition-colors"
                                                                    title={b.filename.toLowerCase().endsWith('.sql') ? 'Baixar ficheiro SQL para o PC' : 'Baixar ficheiro para o PC'}
                                                                >
                                                                    <Download size={18} />
                                                                </button>
                                                                <button
                                                                    onClick={() => setShowConfirmRestore(b.filename)}
                                                                    disabled={!!actionLoading}
                                                                    className="p-2 text-slate-400 hover:text-amber-500 transition-colors"
                                                                    title="Restaurar este backup"
                                                                >
                                                                    <RotateCcw size={18} />
                                                                </button>
                                                                <button
                                                                    onClick={() => handleDeleteBackup(b.filename)}
                                                                    disabled={!!actionLoading}
                                                                    className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                                                                    title="Deletar arquivo"
                                                                >
                                                                    <Trash2 size={18} />
                                                                </button>
                                                            </>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>

        </div>
    );
};
