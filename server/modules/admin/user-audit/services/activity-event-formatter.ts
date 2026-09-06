/**
 * Formata eventos de auditoria (Mongo / `action_logs`) para texto legível no
 * admin: cada `action` gravado pelo backend (session snapshot, delta de
 * stock, login, compra, evento de rig, trade P2P, ticket de suporte...) tem
 * um `meta` em formato livre; este módulo é a única fonte de verdade que
 * traduz `(action, meta)` num título/resumo/severidade/categoria em pt-PT
 * prontos pra UI — sem isso, o admin veria só JSON cru.
 *
 * Consumidores: `controllers/user-audit.controller.ts` (feed de atividade e
 * snapshots de sessão) e `services/account-trace.ts` (timeline do rastreio de
 * conta), ambos deste módulo.
 *
 * Migrado de legacy/backend/lib/activityEventFormatter.ts (verbatim, sem dependências externas).
 */
export type ActivityDisplayCategory =
  | 'auth'
  | 'inventory'
  | 'rigs'
  | 'economy'
  | 'boxes'
  | 'session'
  | 'p2p'
  | 'other';

export type ActivityDisplaySeverity = 'info' | 'success' | 'warning' | 'danger';

export type ActivityEventDisplay = {
  category: ActivityDisplayCategory;
  severity: ActivityDisplaySeverity;
  title: string;
  summary: string;
  lines?: string[];
  technicalMeta?: Record<string, unknown> | null;
};

const SUMMARY_KEY_PREVIEW_MAX_LEN = 80;
const SUMMARY_KEY_PREVIEW_COUNT = 4;
const RACK_ID_SHORT_LEN = 8;
const LISTING_ID_SHORT_LEN = 8;
const TX_HASH_SHORT_LEN = 14;
const COIN_ID_SHORT_LEN = 12;
const TICKET_ID_SHORT_LEN = 8;
const QTY_DECIMALS = 4;
const FINGERPRINT_PREVIEW_LEN = 12;

function metaObj(meta: unknown): Record<string, unknown> {
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return {};
  return meta as Record<string, unknown>;
}

function str(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtUsdc(v: unknown): string {
  const n = num(v);
  if (n == null) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function fmtQty(v: unknown): string {
  const n = num(v);
  if (n == null) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(QTY_DECIMALS);
}

function defaultDisplay(action: string, meta: Record<string, unknown>): ActivityEventDisplay {
  const keys = Object.keys(meta);
  const summary =
    keys.length === 0
      ? `Evento técnico: ${action}`
      : keys
          .slice(0, SUMMARY_KEY_PREVIEW_COUNT)
          .map((k) => `${k}=${JSON.stringify(meta[k])?.slice(0, SUMMARY_KEY_PREVIEW_MAX_LEN)}`)
          .join(' · ');
  return {
    category: 'other',
    severity: 'info',
    title: action.replace(/_/g, ' '),
    summary,
    technicalMeta: meta
  };
}

function formatSessionSnapshot(meta: Record<string, unknown>): ActivityEventDisplay {
  const economy = metaObj(meta.economy);
  const inventory = metaObj(meta.inventory);
  const rigs = metaObj(meta.rigs);
  const boxes = metaObj(meta.boxes);
  const batteries = metaObj(meta.batteries);
  const usdc = fmtUsdc(economy.usdc);
  const stockLines = num(inventory.distinctItems) ?? 0;
  const stockQty = num(inventory.totalQty) ?? 0;
  const rackCount = num(rigs.count) ?? 0;
  const boxesTotal = num(boxes.totalQty) ?? 0;
  const batCount = num(batteries.count) ?? 0;
  const fp = str(meta.fingerprint).slice(0, FINGERPRINT_PREVIEW_LEN);
  return {
    category: 'session',
    severity: 'success',
    title: 'Estado da conta ao entrar',
    summary: `${usdc} USDC · ${stockLines} tipos de item (${stockQty} un.) · ${rackCount} rig(s) · ${boxesTotal} caixa(s) fechada(s) · ${batCount} bateria(s) no armazém`,
    lines: fp ? [`Assinatura de estado: ${fp}…`] : undefined,
    technicalMeta: meta
  };
}

function stockDeltaContextLines(meta: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const source = str(meta.source);
  if (source) {
    lines.push(source === 'save-game' ? 'Origem: save-game (cliente enviou inventário)' : `Origem: ${source}`);
  }
  const after = num(meta.after ?? meta.quantity_after);
  if (after === 0) {
    lines.push('Quantidade zerada no stock — confirmar se foi para rig/sala, venda ou P2P; se não, item órfão ou bug de sync.');
  }
  if (meta.unknownCatalog === true || str(meta.dispositionHint) === 'unknown_catalog') {
    lines.push('ID fora do catálogo (possível item legado/órfão).');
  }
  return lines;
}

function formatStockDelta(meta: Record<string, unknown>, opts?: { lossAlert?: boolean }): ActivityEventDisplay {
  const itemId = str(meta.itemId || meta.catalogItemId);
  const name = str(meta.itemName) || itemId;
  const before = num(meta.before ?? meta.quantity_before);
  const after = num(meta.after ?? meta.quantity_after);
  const delta = num(meta.delta) ?? (before != null && after != null ? after - before : null);
  const isLoss = delta != null && delta < 0;
  const lossAlert = opts?.lossAlert === true;
  const contextLines = stockDeltaContextLines(meta);
  return {
    category: 'inventory',
    severity: lossAlert ? 'danger' : isLoss ? 'warning' : delta != null && delta > 0 ? 'success' : 'info',
    title: lossAlert
      ? 'Alerta: item sumiu do inventário'
      : isLoss
        ? 'Inventário: perda de item'
        : delta != null && delta > 0
          ? 'Inventário: ganho de item'
          : 'Inventário alterado',
    summary: `${name}: ${fmtQty(before)} → ${fmtQty(after)}${delta != null ? ` (Δ ${delta > 0 ? '+' : ''}${delta})` : ''}`,
    lines: contextLines.length > 0 ? contextLines : undefined,
    technicalMeta: meta
  };
}

function formatHardwareBuy(meta: Record<string, unknown>): ActivityEventDisplay {
  const linesRaw = Array.isArray(meta.lines) ? meta.lines : [];
  const itemLines = linesRaw
    .map((ln) => {
      if (ln == null || typeof ln !== 'object') return '';
      const o = ln as Record<string, unknown>;
      const qty = num(o.qty) ?? 1;
      const name = str(o.name) || str(o.id);
      return name ? `${qty}× ${name}` : '';
    })
    .filter(Boolean);
  const source = str(meta.source);
  const sourceLabel = source === 'shop_checkout' ? 'Loja (checkout)' : source === 'upgrades_buy' ? 'Compra directa' : source;
  return {
    category: 'economy',
    severity: 'success',
    title: 'Comprou hardware',
    summary: `Pagou ${fmtUsdc(meta.totalUsdc ?? meta.totalPaid)} USDC · saldo ${fmtUsdc(meta.newUsdc)} USDC`,
    lines: [itemLines.length > 0 ? `Itens: ${itemLines.join(', ')}` : '', sourceLabel ? `Canal: ${sourceLabel}` : ''].filter(Boolean),
    technicalMeta: meta
  };
}

function formatShopCheckoutOk(meta: Record<string, unknown>): ActivityEventDisplay {
  const cached = meta.cached === true;
  return {
    category: 'economy',
    severity: 'success',
    title: 'Checkout concluído',
    summary: `Pago ${fmtUsdc(meta.totalPaid)} USDC · saldo ${fmtUsdc(meta.newUsdc)} USDC${cached ? ' (pedido repetido — cache)' : ''}`,
    technicalMeta: meta
  };
}

function formatShopCheckoutAttempt(meta: Record<string, unknown>): ActivityEventDisplay {
  const n = num(meta.lineCount);
  return {
    category: 'economy',
    severity: 'info',
    title: 'Tentativa de checkout',
    summary: n != null ? `${n} linha(s) no carrinho` : 'Iniciou checkout na loja',
    technicalMeta: meta
  };
}

function formatShopCheckoutDenied(meta: Record<string, unknown>): ActivityEventDisplay {
  return {
    category: 'economy',
    severity: 'warning',
    title: 'Checkout recusado',
    summary: str(meta.error) || str(meta.code) || 'Compra não concluída',
    lines: [str(meta.code) ? `Código: ${meta.code}` : ''].filter(Boolean),
    technicalMeta: meta
  };
}

function formatShopCartEvent(action: string, meta: Record<string, unknown>): ActivityEventDisplay {
  return {
    category: 'economy',
    severity: 'info',
    title: 'Carrinho alterado',
    summary: action.replace(/^shop_cart_/, '').replace(/_/g, ' ') || 'Alteração no carrinho',
    lines: [meta.productId ? `Produto: ${str(meta.productId)}` : '', meta.qty != null ? `Quantidade: ${fmtQty(meta.qty)}` : ''].filter(Boolean),
    technicalMeta: meta
  };
}

function formatOrphanRiskDetected(meta: Record<string, unknown>): ActivityEventDisplay {
  const count = num(meta.count) ?? 0;
  const kind = str(meta.kind) || 'desconhecido';
  return {
    category: 'inventory',
    severity: 'danger',
    title: 'Risco de item órfão',
    summary:
      kind === 'rack_battery_uuid' ? `${count} bateria(s) na rig sem registo válido no armazém` : `${count} referência(s) órfã(s) detectada(s)`,
    lines: [meta.autoRecover === false ? 'Recuperação automática desactivada — verificar rigs e stored_batteries.' : ''].filter(Boolean),
    technicalMeta: meta
  };
}

const RACK_FIELD_PT: Record<string, string> = {
  chassis: 'chassi',
  wiring: 'cablagem',
  battery: 'bateria',
  power: 'energia (ligar/desligar)',
  coin: 'moeda de mineração',
  room: 'sala',
  slot: 'posição na sala',
  miners: 'GPUs / ASICs',
  multipliers: 'multiplicadores'
};

const AUX_KIND_PT: Record<string, string> = {
  battery: 'bateria',
  wiring: 'cablagem',
  multiplier: 'multiplicador'
};

function rackContextLine(meta: Record<string, unknown>): string | undefined {
  const room = str(meta.room || meta.roomId);
  const parts: string[] = [];
  if (room) parts.push(`sala ${room}`);
  if (parts.length > 0) return parts.join(' · ');
  const rackId = str(meta.rackId);
  if (rackId) return `Ref. interna da rig: ${rackId.slice(0, RACK_ID_SHORT_LEN)}…`;
  return undefined;
}

function formatRackMinerEquipEvent(meta: Record<string, unknown>): ActivityEventDisplay {
  const name = str(meta.itemName) || str(meta.itemId) || 'item';
  const slot = num(meta.slotIndex);
  const rackShort = str(meta.rackId).slice(0, RACK_ID_SHORT_LEN);
  return {
    category: 'inventory',
    severity: 'info',
    title: 'Equipou na rig',
    summary: `${name} → rig ${rackShort}${rackShort ? '…' : ''} slot ${slot ?? '?'}`,
    lines: [meta.stockBefore != null && meta.stockAfter != null ? `Stock: ${fmtQty(meta.stockBefore)} → ${fmtQty(meta.stockAfter)}` : ''].filter(
      Boolean
    ),
    technicalMeta: meta
  };
}

function formatRackMinerUnequipEvent(meta: Record<string, unknown>): ActivityEventDisplay {
  const name = str(meta.itemName) || str(meta.itemId) || 'item';
  const slot = num(meta.slotIndex);
  const rackShort = str(meta.rackId).slice(0, RACK_ID_SHORT_LEN);
  return {
    category: 'inventory',
    severity: 'info',
    title: 'Desequipou da rig',
    summary: `${name} ← rig ${rackShort}${rackShort ? '…' : ''} slot ${slot ?? '?'}`,
    lines: [meta.stockBefore != null && meta.stockAfter != null ? `Stock: ${fmtQty(meta.stockBefore)} → ${fmtQty(meta.stockAfter)}` : ''].filter(
      Boolean
    ),
    technicalMeta: meta
  };
}

const P2P_TITLE_PT: Record<string, string> = {
  p2p_listing_create: 'Anúncio P2P criado',
  p2p_listing_open: 'Anúncio P2P activo',
  p2p_listing_cancel: 'Anúncio P2P cancelado',
  p2p_listing_reserve: 'Reserva P2P',
  p2p_reserve_cancel: 'Reserva P2P cancelada',
  p2p_listing_buy: 'Compra P2P',
  p2p_listing_sold: 'Venda P2P concluída',
  p2p_trade_sell: 'Venda no mercado P2P',
  p2p_trade_buy: 'Compra no mercado P2P',
  p2p_proceeds_claim: 'Levantamento P2P (vendedor)',
  p2p_custody_claim: 'Item retirado do cofre P2P',
  p2p_custody_claim_all: 'Itens retirados do cofre P2P'
};

function formatP2pAction(action: string, meta: Record<string, unknown>): ActivityEventDisplay {
  const itemName = str(meta.itemName) || str(meta.itemId);
  const qty = num(meta.qty) ?? num(meta.buyQty) ?? num(meta.purchasedQty);
  const price = num(meta.price) ?? num(meta.unitPrice);
  const total = num(meta.totalUsdc) ?? num(meta.buyerPaidUsdc);
  const counterparty =
    meta.sellerId != null
      ? `#${meta.sellerId}`
      : meta.buyerId != null
        ? `#${meta.buyerId}`
        : meta.counterpartyUserId != null
          ? `#${meta.counterpartyUserId}`
          : '';
  const title = P2P_TITLE_PT[action] || 'Mercado P2P';
  let summary = action.replace(/^p2p_/, '').replace(/_/g, ' ');
  if (action === 'p2p_listing_create' && itemName) {
    summary = `Listou ${qty ?? 1}× ${itemName}${price != null ? ` · ${fmtUsdc(price)} USDC/un.` : ''}`;
  } else if (action === 'p2p_listing_buy' && itemName) {
    summary = `Comprou ${qty ?? 1}× ${itemName}${total != null ? ` · ${fmtUsdc(total)} USDC` : ''}`;
  } else if ((action === 'p2p_trade_buy' || action === 'p2p_trade_sell') && itemName) {
    const verb = action === 'p2p_trade_sell' ? 'Vendeu' : 'Comprou';
    summary = `${verb} ${qty ?? 1}× ${itemName}${total != null ? ` · ${fmtUsdc(total)} USDC` : ''}`;
  } else if (action === 'p2p_listing_sold' && itemName) {
    summary = `Vendeu ${qty ?? 1}× ${itemName}${total != null ? ` · ${fmtUsdc(total)} USDC` : ''}`;
  } else if (action === 'p2p_listing_open' && itemName) {
    summary = `Anúncio activo: ${qty ?? 1}× ${itemName}${price != null ? ` · ${fmtUsdc(price)} USDC/un.` : ''}`;
  } else if (action === 'p2p_listing_cancel' && itemName) {
    summary = `Cancelou anúncio de ${itemName}`;
  } else if (action === 'p2p_proceeds_claim') {
    summary = `Levantou ${fmtUsdc(meta.claimedUsdc)} USDC`;
  } else if (action === 'p2p_custody_claim_all') {
    summary = `Retirou ${num(meta.claimed) ?? 0} item(ns) do cofre`;
  }
  const lines = [
    itemName ? `Item: ${itemName}` : '',
    counterparty ? `Contraparte: ${counterparty}` : '',
    str(meta.listingId) ? `Anúncio: ${str(meta.listingId).slice(0, LISTING_ID_SHORT_LEN)}…` : ''
  ].filter(Boolean);
  return {
    category: 'p2p',
    severity: action === 'p2p_listing_buy' || action === 'p2p_trade_buy' || action === 'p2p_trade_sell' ? 'success' : 'info',
    title,
    summary,
    lines: lines.length > 0 ? lines : undefined,
    technicalMeta: meta
  };
}

function humanizeRackChanged(meta: Record<string, unknown>): string[] {
  const raw = Array.isArray(meta.changed) ? (meta.changed as string[]) : str(meta.changed) ? [str(meta.changed)] : [];
  return raw.map((f) => RACK_FIELD_PT[f] || f.replace(/_/g, ' '));
}

function formatRackAuxIntent(meta: Record<string, unknown>): ActivityEventDisplay {
  const scope = str(meta.scope);
  const ok = meta.ok !== false;
  const ctx = rackContextLine(meta);
  const lines: string[] = [];
  if (ctx) lines.push(ctx);

  if (scope === 'srv_place_rack') {
    return {
      category: 'rigs',
      severity: ok ? 'success' : 'warning',
      title: 'Rig colocada na sala',
      summary: ok ? 'Colocou uma rig no datacenter' : 'Tentativa de colocar rig falhou',
      lines: lines.length ? lines : undefined,
      technicalMeta: meta
    };
  }
  if (/^srv_remove_rack:/.test(scope)) {
    return {
      category: 'rigs',
      severity: ok ? 'warning' : 'danger',
      title: 'Rig removida da sala',
      summary: ok ? 'Retirou a rig e devolveu equipamento ao stock' : 'Falha ao remover rig',
      lines: lines.length ? lines : undefined,
      technicalMeta: meta
    };
  }
  const minerEquip = /^rack_miner_equip:[^:]+:(\d+)$/.exec(scope);
  if (minerEquip) {
    const slot = str(meta.slotIndex) || minerEquip[1];
    const name = str(meta.itemName) || str(meta.itemId);
    return {
      category: 'inventory',
      severity: ok ? 'success' : 'warning',
      title: 'Equipou na rig',
      summary: ok ? (name ? `${name} → slot ${slot}` : `Equipou miner no slot ${slot}`) : `Falha ao equipar no slot ${slot}`,
      lines: [...(lines.length ? lines : []), meta.stockBefore != null && meta.stockAfter != null ? `Stock: ${fmtQty(meta.stockBefore)} → ${fmtQty(meta.stockAfter)}` : ''].filter(
        Boolean
      ),
      technicalMeta: meta
    };
  }
  const minerUnequip = /^rack_miner_unequip:[^:]+:(\d+)$/.exec(scope);
  if (minerUnequip) {
    const slot = str(meta.slotIndex) || minerUnequip[1];
    const name = str(meta.itemName) || str(meta.itemId);
    return {
      category: 'inventory',
      severity: ok ? 'info' : 'warning',
      title: 'Desequipou da rig',
      summary: ok ? (name ? `${name} ← slot ${slot} (devolveu ao stock)` : `Removeu miner do slot ${slot}`) : `Falha ao remover do slot ${slot}`,
      lines: [...(lines.length ? lines : []), meta.stockBefore != null && meta.stockAfter != null ? `Stock: ${fmtQty(meta.stockBefore)} → ${fmtQty(meta.stockAfter)}` : ''].filter(
        Boolean
      ),
      technicalMeta: meta
    };
  }
  const auxEquip = /^rack_aux_equip:[^:]+:(\w+)$/.exec(scope);
  if (auxEquip) {
    const kind = AUX_KIND_PT[auxEquip[1]] || auxEquip[1];
    return {
      category: 'rigs',
      severity: ok ? 'success' : 'warning',
      title: `Montou ${kind}`,
      summary: ok ? `Equipou ${kind} na rig` : `Falha ao equipar ${kind}`,
      lines: lines.length ? lines : undefined,
      technicalMeta: meta
    };
  }
  const auxUnequip = /^rack_aux_unequip:[^:]+:(\w+)$/.exec(scope);
  if (auxUnequip) {
    const kind = AUX_KIND_PT[auxUnequip[1]] || auxUnequip[1];
    return {
      category: 'rigs',
      severity: ok ? 'info' : 'warning',
      title: `Desmontou ${kind}`,
      summary: ok ? `Removeu ${kind} da rig` : `Falha ao remover ${kind}`,
      lines: lines.length ? lines : undefined,
      technicalMeta: meta
    };
  }
  return {
    category: 'rigs',
    severity: 'info',
    title: 'Alteração na rig',
    summary: scope ? `Operação na sala de servidores (${scope.split(':')[0].replace(/_/g, ' ')})` : 'Ação na sala de servidores',
    lines: lines.length ? lines : undefined,
    technicalMeta: meta
  };
}

function formatRackEvent(action: string, meta: Record<string, unknown>): ActivityEventDisplay {
  const room = str(meta.room || meta.roomId);
  if (action === 'rack_aux_intent') {
    return formatRackAuxIntent(meta);
  }
  if (action === 'rack_dismantle') {
    const parts = metaObj(meta.parts);
    const miners = Array.isArray(parts.miners) ? parts.miners.length : 0;
    return {
      category: 'rigs',
      severity: 'warning',
      title: 'Rig desmontada',
      summary: `${str(meta.chassisName) || 'Rig'} desmontada${room ? ` · sala ${room}` : ''}`,
      lines: [parts.chassis ? `Chassis: ${str(meta.chassisName) || parts.chassis}` : '', miners > 0 ? `${miners} miner(s) removido(s)` : ''].filter(
        Boolean
      ),
      technicalMeta: meta
    };
  }
  if (action === 'rack_place') {
    return {
      category: 'rigs',
      severity: 'success',
      title: 'Rig colocada',
      summary: `${str(meta.itemName) || str(meta.itemId) || 'Rig'} colocada${room ? ` · sala ${room}` : ''}`,
      technicalMeta: meta
    };
  }
  if (action === 'mining_rack_update') {
    const parts = humanizeRackChanged(meta);
    const ctx = rackContextLine(meta);
    const rackShort = str(meta.rackId).slice(0, RACK_ID_SHORT_LEN);
    return {
      category: 'rigs',
      severity: 'info',
      title: 'Rig atualizada',
      summary: parts.length > 0 ? `Alterou: ${parts.join(', ')}` : 'Guardou configuração da rig',
      lines: [rackShort ? `Rig: ${rackShort}…` : '', ctx || ''].filter(Boolean),
      technicalMeta: meta
    };
  }
  if (action === 'room_coin_bulk') {
    const roomId = str(meta.roomId);
    const coinId = str(meta.coinId);
    const roomLabel = roomId === 'room_initial' ? 'Sala inicial' : /1775484506874/.test(roomId) ? 'Sala NFT / Streamer' : roomId || 'sala';
    return {
      category: 'rigs',
      severity: 'info',
      title: 'Moeda da sala alterada',
      summary: `Mineração definida na ${roomLabel}`,
      lines: coinId ? [`Moeda: ${coinId.slice(0, COIN_ID_SHORT_LEN)}…`] : undefined,
      technicalMeta: meta
    };
  }
  return defaultDisplay(action, meta);
}

/**
 * Traduz um evento cru de log `(action, meta)` para exibição no admin:
 * categoria, severidade, título e resumo em pt-PT, mais linhas de detalhe
 * opcionais (`lines`) e o `meta` original preservado em `technicalMeta` para
 * quem quiser inspecionar o JSON bruto.
 *
 * Faz dispatch por `action` (comparação exacta ou regex de prefixo, ex.
 * `/^p2p_/`, `/^rack_/`) para um formatter especializado; `action`s não
 * reconhecidas caem em `defaultDisplay`, que monta um resumo genérico a
 * partir das primeiras chaves de `meta` — nunca lança nem esconde o evento.
 *
 * @param action - Nome do evento gravado (ex. `'stock_delta'`, `'p2p_listing_buy'`).
 * @param meta - Payload livre do evento; qualquer valor que não seja um
 *   objeto plano (array, `null`, primitivo) é tratado como `{}`.
 * @returns Estrutura de exibição pronta para o painel; nunca lança.
 */
export function formatActivityEvent(action: string, meta: unknown): ActivityEventDisplay {
  const a = String(action || '').trim();
  const m = metaObj(meta);

  if (a === 'session_state_snapshot' || a === 'session_resync') {
    return formatSessionSnapshot(m);
  }

  if (a === 'orphan_risk_detected') {
    return formatOrphanRiskDetected(m);
  }

  if (a === 'stock_delta' || a === 'stock_save_delta' || a === 'inventory_loss_alert') {
    if (a === 'inventory_loss_alert') {
      return formatStockDelta(m, { lossAlert: true });
    }
    return formatStockDelta(m);
  }

  if (/^login_success$/i.test(a)) {
    return { category: 'auth', severity: 'success', title: 'Login com sucesso', summary: m.ip ? `IP ${m.ip}` : 'Sessão iniciada', technicalMeta: m };
  }
  if (/^login_failed$/i.test(a)) {
    return {
      category: 'auth',
      severity: 'warning',
      title: 'Tentativa de login falhada',
      summary: m.ip ? `IP ${m.ip}` : 'Credenciais incorrectas',
      technicalMeta: m
    };
  }
  if (/^login_blocked/i.test(a)) {
    return {
      category: 'auth',
      severity: 'danger',
      title: 'Login bloqueado',
      summary: m.retryAfterSeconds ? `Conta bloqueada temporariamente (${m.retryAfterSeconds}s)` : 'Conta bloqueada',
      technicalMeta: m
    };
  }
  if (/^signup_complete$/i.test(a)) {
    return { category: 'auth', severity: 'success', title: 'Registo concluído', summary: 'Conta criada com sucesso', technicalMeta: m };
  }
  if (/^wallet_link$/i.test(a)) {
    return { category: 'auth', severity: 'info', title: 'Carteira ligada', summary: 'Sessão Web3 / Polygon associada', technicalMeta: m };
  }

  if (/^deposit_credit$/i.test(a)) {
    return {
      category: 'economy',
      severity: 'success',
      title: 'Depósito creditado',
      summary: `${fmtUsdc(m.amountUsdc ?? m.amount)} USDC${m.txHash ? ` · tx ${str(m.txHash).slice(0, TX_HASH_SHORT_LEN)}…` : ''}`,
      technicalMeta: m
    };
  }
  if (/^exchange_sell$/i.test(a)) {
    return {
      category: 'economy',
      severity: 'info',
      title: 'Venda na exchange',
      summary: `${str(m.coinId)} · ${fmtUsdc(m.usdcReceived ?? m.amountUsdc)} USDC`,
      technicalMeta: m
    };
  }

  if (/^loot_box_open$/i.test(a)) {
    return {
      category: 'boxes',
      severity: 'success',
      title: 'Caixa aberta',
      summary: `${str(m.boxName) || str(m.boxId)}${m.wonItemId ? ` → ${str(m.wonItemName) || m.wonItemId}` : ''}`,
      technicalMeta: m
    };
  }
  if (/^loot_box_buy$/i.test(a)) {
    return {
      category: 'boxes',
      severity: 'info',
      title: 'Caixa comprada',
      summary: `${str(m.boxId)} × ${fmtQty(m.qty ?? 1)} · ${fmtUsdc(m.price)} USDC`,
      technicalMeta: m
    };
  }

  if (a === 'rack_miner_equip') {
    return formatRackMinerEquipEvent(m);
  }
  if (a === 'rack_miner_unequip') {
    return formatRackMinerUnequipEvent(m);
  }

  if (/^rack_/.test(a) || /^mining_rack/.test(a) || /^room_battery/.test(a) || /^room_coin_bulk/.test(a)) {
    if (/^room_battery/.test(a)) {
      return {
        category: 'rigs',
        severity: 'info',
        title: 'Baterias na sala',
        summary: a.replace(/_/g, ' '),
        lines: m.roomId ? [`Sala: ${m.roomId}`] : undefined,
        technicalMeta: m
      };
    }
    return formatRackEvent(a, m);
  }

  if (/^p2p_/.test(a)) {
    return formatP2pAction(a, m);
  }

  if (/^client_/.test(a)) {
    return { category: 'other', severity: 'info', title: 'Acção no cliente', summary: a.replace(/^client_/, '').replace(/_/g, ' '), technicalMeta: m };
  }

  if (a === 'hardware_buy') {
    return formatHardwareBuy(m);
  }
  if (a === 'shop_checkout_ok') {
    return formatShopCheckoutOk(m);
  }
  if (a === 'shop_checkout_attempt') {
    return formatShopCheckoutAttempt(m);
  }
  if (a === 'shop_checkout_denied') {
    return formatShopCheckoutDenied(m);
  }
  if (/^shop_cart_/.test(a)) {
    return formatShopCartEvent(a, m);
  }
  if (/^shop_/.test(a)) {
    return { category: 'economy', severity: 'info', title: 'Loja', summary: a.replace(/_/g, ' '), technicalMeta: m };
  }

  if (/^promo_redeem/.test(a) || /^roleta_/.test(a) || /^wheel_/.test(a)) {
    return { category: 'boxes', severity: 'success', title: 'Recompensa / jogo', summary: a.replace(/_/g, ' '), technicalMeta: m };
  }

  if (a === 'support_ticket_player_reply') {
    return { category: 'other', severity: 'info', title: 'Jogador respondeu no suporte', summary: str(m.ticketId) ? `Ticket ${m.ticketId}` : 'Nova mensagem do jogador', technicalMeta: m };
  }
  if (a === 'support_ticket_admin_reply') {
    return { category: 'other', severity: 'info', title: 'Admin respondeu no suporte', summary: str(m.ticketId) ? `Ticket ${m.ticketId}` : 'Resposta da equipa', technicalMeta: m };
  }
  if (a === 'admin_ranking_exclusion') {
    const excluded = !!m.excluded;
    const adminId = m.adminUserId != null ? String(m.adminUserId) : '';
    return {
      category: 'other',
      severity: 'warning',
      title: excluded ? 'Excluído do ranking' : 'Reincluído no ranking',
      summary: excluded ? 'Admin removeu o jogador do ranking público' : 'Admin devolveu o jogador ao ranking público',
      lines: adminId ? [`Admin #${adminId}`] : undefined,
      technicalMeta: m
    };
  }
  if (a === 'support_attachment_download') {
    const file = str(m.file);
    const ticketId = str(m.ticketId);
    return {
      category: 'other',
      severity: 'info',
      title: 'Anexo de suporte transferido',
      summary: file ? `Download: ${file}` : 'Transferência de anexo do ticket',
      lines: ticketId ? [`Ticket ${ticketId.slice(0, TICKET_ID_SHORT_LEN)}…`] : undefined,
      technicalMeta: m
    };
  }

  if (/^support_ticket/.test(a)) {
    return { category: 'other', severity: 'info', title: 'Suporte', summary: str(m.ticketId) ? `Ticket ${m.ticketId}` : a.replace(/_/g, ' '), technicalMeta: m };
  }

  return defaultDisplay(a, m);
}

/**
 * Aplica um filtro de UI (chip do painel de atividade, ex. "losses", "p2p",
 * "inventory_moves") a um evento já formatado. Cada `filterId` é uma
 * combinação fixa de `category`/`severity`/regex sobre `action` — não é
 * configurável por dado externo, então não há validação de `filterId`
 * desconhecido: qualquer id não reconhecido cai no `return true` final
 * (comportamento de "sem filtro", igual a `'all'`).
 *
 * @param display - Resultado de `formatActivityEvent` para o evento.
 * @param action - `action` bruta do evento (usada pelos filtros que olham regex/prefixo).
 * @param filterId - Id do filtro escolhido na UI.
 * @returns `true` se o evento deve aparecer com esse filtro ativo.
 */
export function matchesActivityFilter(display: ActivityEventDisplay, action: string, filterId: string): boolean {
  if (filterId === 'all') return true;
  if (filterId === 'losses') {
    return display.category === 'inventory' && (display.severity === 'warning' || display.severity === 'danger');
  }
  if (filterId === 'session') return display.category === 'session';
  if (filterId === 'inventory') return display.category === 'inventory';
  if (filterId === 'inventory_moves') {
    return (
      display.category === 'inventory' ||
      /^rack_miner_(equip|unequip)$/.test(action) ||
      /^(stock_delta|inventory_loss_alert)$/.test(action) ||
      /^p2p_listing_(create|cancel|buy)$/.test(action)
    );
  }
  if (filterId === 'p2p') return display.category === 'p2p';
  if (filterId === 'auth') return display.category === 'auth';
  if (filterId === 'deposit') return /deposit/i.test(action);
  if (filterId === 'boxes') return display.category === 'boxes';
  if (filterId === 'rigs') return display.category === 'rigs';
  if (filterId === 'login') return display.category === 'auth';
  return true;
}
