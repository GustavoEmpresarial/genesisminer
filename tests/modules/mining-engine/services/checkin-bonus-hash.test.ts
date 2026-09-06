import { describe, expect, it } from 'vitest';
import {
  aggregateHashByCoinWithCheckinBonus,
  effectiveHashWithCheckinBonus,
  sumNonNftRoomRigHashHps,
  type CheckinHashEntry
} from '../../../../server/modules/mining-engine/services/checkin-bonus-hash.js';
import { ASIC_ROOM_ID } from '../../../../server/modules/mining-engine/services/room-kind.js';

const NFT_ROOM = new Set(['room_nft']);

describe('sumNonNftRoomRigHashHps', () => {
  it('exclui entradas da sala NFT e de moedas exclusivas NFT', () => {
    const entries: CheckinHashEntry[] = [
      { coinId: 'btc', roomId: 'sala_1', baseHps: 10 },
      { coinId: 'usdt', roomId: 'sala_1', baseHps: 5 },
      { coinId: 'coin_admin', roomId: 'room_nft', baseHps: 20 }
    ];
    expect(sumNonNftRoomRigHashHps(entries, NFT_ROOM)).toBe(10);
  });

  it('exclui entradas da Sala ASICs (bónus não entra na sala)', () => {
    const asicBaseHps = 50;
    const standardBaseHps = 10;
    const entries: CheckinHashEntry[] = [
      { coinId: 'btc', roomId: 'sala_1', baseHps: standardBaseHps },
      { coinId: 'usdc_interno', roomId: ASIC_ROOM_ID, baseHps: asicBaseHps }
    ];
    expect(sumNonNftRoomRigHashHps(entries, NFT_ROOM)).toBe(standardBaseHps);
  });
});

describe('effectiveHashWithCheckinBonus', () => {
  it('sem bónus ou sem total: devolve o base', () => {
    expect(effectiveHashWithCheckinBonus(10, 'btc', 'sala_1', 0, 0, NFT_ROOM)).toBe(10);
  });

  it('rig na sala NFT não recebe bónus', () => {
    expect(effectiveHashWithCheckinBonus(10, 'coin_admin', 'room_nft', 5, 10, NFT_ROOM)).toBe(10);
  });

  it('rig na Sala ASICs não recebe bónus (devolve só o base)', () => {
    const asicBaseHps = 50;
    const bonusHps = 10;
    const totalEligibleHps = 10;
    expect(effectiveHashWithCheckinBonus(asicBaseHps, 'usdc_interno', ASIC_ROOM_ID, bonusHps, totalEligibleHps, NFT_ROOM)).toBe(asicBaseHps);
  });

  it('moeda exclusiva NFT não recebe bónus mesmo fora da sala', () => {
    expect(effectiveHashWithCheckinBonus(10, 'usdt', 'sala_1', 5, 10, NFT_ROOM)).toBe(10);
  });

  it('distribui o bónus proporcionalmente ao peso da rig no total', () => {
    // base=10, total=20 → metade do bónus
    expect(effectiveHashWithCheckinBonus(10, 'btc', 'sala_1', 4, 20, NFT_ROOM)).toBe(12);
  });

  it('base inválido devolve 0', () => {
    expect(effectiveHashWithCheckinBonus(NaN, 'btc', 'sala_1', 5, 10, NFT_ROOM)).toBe(0);
  });
});

describe('aggregateHashByCoinWithCheckinBonus', () => {
  it('agrega por moeda aplicando o bónus só nas rigs elegíveis', () => {
    const entries: CheckinHashEntry[] = [
      { coinId: 'btc', roomId: 'sala_1', baseHps: 10 },
      { coinId: 'btc', roomId: 'sala_1', baseHps: 10 },
      { coinId: 'coin_admin', roomId: 'room_nft', baseHps: 5 }
    ];
    const out = aggregateHashByCoinWithCheckinBonus(entries, 4, NFT_ROOM);
    expect(out.btc).toBe(24); // 20 base + 4 de bónus (100% do total elegível)
    expect(out.coin_admin).toBe(5); // sem bónus (sala NFT)
  });
});
