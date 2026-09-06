/**
 * Broadcast de eventos do mercado P2P — no-op no processo Express.
 *
 * Socket.IO + market emits vivem em genesis-api (Rust). Admin black-market
 * routes ainda tipam `emitMarketWs` via deps; até migrarem, este stub é seguro.
 */
export function emitMarketWs(_payload: Record<string, unknown>): void {
  /* genesis-api owns Socket.IO */
}
