import { describe, expect, it } from 'vitest';
import {
  isAsicMachineUpgradeRow,
  isNftAutoRoomId,
  isNftMiningRoomId,
  isNftRoomCatalogMachineRow,
  isNftRoomExclusiveMiningCoinRef,
  isNftRoomExclusiveMiningCoinSymbol,
  listSlotMiningCredits,
  NFT_AUTO_ALLOWED_CHASSIS_ID,
  NFT_AUTO_ROOM_ID,
  nftMiningCoinIdFromUpgrade,
  normalizeMiningCoinSymbolKey,
  rackMultiplierFactor,
  rackPowerIsOn,
  resolveMiningCoinUsdRate,
  type UpgradeMiningRow
} from '../../../../server/modules/mining-engine/services/nft-room-mining.js';
import { ASIC_ROOM_ID } from '../../../../server/modules/mining-engine/services/room-kind.js';

describe('normalizeMiningCoinSymbolKey / isNftRoomExclusiveMiningCoinSymbol', () => {
  it('normaliza pra uppercase trimado', () => {
    expect(normalizeMiningCoinSymbolKey(' usdt ')).toBe('USDT');
  });

  it('reconhece símbolos exclusivos NFT e o prefixo NFT_', () => {
    expect(isNftRoomExclusiveMiningCoinSymbol('usdt')).toBe(true);
    expect(isNftRoomExclusiveMiningCoinSymbol('NFT_DAI')).toBe(true);
    expect(isNftRoomExclusiveMiningCoinSymbol('btc')).toBe(false);
    expect(isNftRoomExclusiveMiningCoinSymbol('')).toBe(false);
  });
});

describe('isNftRoomExclusiveMiningCoinRef', () => {
  it('flag nft_room_only=1 no objeto força exclusivo', () => {
    expect(isNftRoomExclusiveMiningCoinRef({ nft_room_only: 1 })).toBe(true);
  });

  it('string reconhece por prefixo/sufixo de chave conhecida', () => {
    expect(isNftRoomExclusiveMiningCoinRef('usdt')).toBe(true);
    expect(isNftRoomExclusiveMiningCoinRef('mining_usdt')).toBe(true);
    expect(isNftRoomExclusiveMiningCoinRef('usdt_v2')).toBe(true);
    expect(isNftRoomExclusiveMiningCoinRef('bitcoin')).toBe(false);
  });

  it('null/undefined não é exclusivo', () => {
    expect(isNftRoomExclusiveMiningCoinRef(null)).toBe(false);
    expect(isNftRoomExclusiveMiningCoinRef(undefined)).toBe(false);
  });
});

describe('isNftAutoRoomId / isNftMiningRoomId', () => {
  it('reconhece o id fixo da Sala NFT', () => {
    expect(isNftAutoRoomId(NFT_AUTO_ROOM_ID)).toBe(true);
    expect(isNftAutoRoomId('outra_sala')).toBe(false);
  });

  it('isNftMiningRoomId usa o Set fornecido', () => {
    const ids = new Set(['room_x']);
    expect(isNftMiningRoomId('room_x', ids)).toBe(true);
    expect(isNftMiningRoomId('room_y', ids)).toBe(false);
  });
});

describe('resolveMiningCoinUsdRate', () => {
  it('usa usdc_rate quando > 0', () => {
    expect(resolveMiningCoinUsdRate({ usdc_rate: 2.5 })).toBe(2.5);
  });

  it('cai pra price_usd quando usdc_rate ausente', () => {
    expect(resolveMiningCoinUsdRate({ price_usd: 1.2 })).toBe(1.2);
  });

  it('stable NFT-exclusiva sem taxa cai em fallback $1', () => {
    expect(resolveMiningCoinUsdRate({ id: 'usdt', symbol: 'USDT' })).toBe(1);
  });

  it('cbBTC sem taxa (não-stable) fica em 0', () => {
    expect(resolveMiningCoinUsdRate({ id: 'cbbtc', symbol: 'CBBTC' })).toBe(0);
  });

  it('moeda comum sem taxa fica em 0', () => {
    expect(resolveMiningCoinUsdRate({ id: 'btc', symbol: 'BTC' })).toBe(0);
  });
});

describe('isAsicMachineUpgradeRow / isNftRoomCatalogMachineRow / nftMiningCoinIdFromUpgrade', () => {
  it('máquina tipo machine com id asic_ é ASIC', () => {
    expect(isAsicMachineUpgradeRow({ type: 'machine', id: 'asic_x1' })).toBe(true);
    expect(isAsicMachineUpgradeRow({ type: 'machine', id: 'gpu_x1', category: 'asic-line' })).toBe(true);
    expect(isAsicMachineUpgradeRow({ type: 'machine', id: 'gpu_x1', category: 'gpu' })).toBe(false);
    expect(isAsicMachineUpgradeRow(null)).toBe(false);
  });

  it('máquina com nft_mining_coin_id configurado entra no catálogo NFT mesmo sem ser ASIC', () => {
    const up: UpgradeMiningRow = { type: 'machine', id: 'x', nft_mining_coin_id: 'coin_a' };
    expect(isNftRoomCatalogMachineRow(up)).toBe(true);
    expect(nftMiningCoinIdFromUpgrade(up)).toBe('coin_a');
  });

  it('máquinas excluídas nunca entram no catálogo NFT', () => {
    expect(isNftRoomCatalogMachineRow({ type: 'machine', id: 'iceberg_v1', nft_mining_coin_id: 'coin_a' })).toBe(false);
  });

  it('nftMiningCoinIdFromUpgrade devolve null quando ausente', () => {
    expect(nftMiningCoinIdFromUpgrade({ type: 'machine' })).toBeNull();
    expect(nftMiningCoinIdFromUpgrade(null)).toBeNull();
  });
});

describe('rackMultiplierFactor', () => {
  it('soma multiplicadores dos slots + infraestrutura da própria rack', () => {
    const map = new Map<string, UpgradeMiningRow>([
      ['mult_a', { multiplier: 0.5 }],
      ['mult_b', { multiplier: 0.25 }],
      ['rack_x', { type: 'infrastructure', multiplier: 1 }]
    ]);
    expect(rackMultiplierFactor(['mult_a', 'mult_b'], map, 'rack_x')).toBeCloseTo(2.75);
  });

  it('sem slots nem rack: fator neutro 1', () => {
    expect(rackMultiplierFactor([], new Map())).toBe(1);
  });
});

describe('rackPowerIsOn', () => {
  it('Sala NFT liga sem selected_coin', () => {
    expect(rackPowerIsOn(true, true, false)).toBe(true);
  });

  it('Sala ASICs liga sem selected_coin', () => {
    expect(rackPowerIsOn(true, true, false)).toBe(true);
  });

  it('sala standard exige selected_coin para ligar', () => {
    expect(rackPowerIsOn(true, false, false)).toBe(false);
    expect(rackPowerIsOn(true, false, true)).toBe(true);
  });

  it('wantOff permanece desligado', () => {
    expect(rackPowerIsOn(false, true, false)).toBe(false);
    expect(rackPowerIsOn(false, true, true)).toBe(false);
    expect(rackPowerIsOn(false, false, true)).toBe(false);
  });
});

describe('listSlotMiningCredits', () => {
  const upgrades = new Map<string, UpgradeMiningRow>([
    ['gpu_1', { type: 'machine', base_production: 10 }],
    ['asic_1', { type: 'machine', id: 'asic_1', base_production: 20, nft_mining_coin_id: 'coin_admin' }],
    ['nft_1', { type: 'machine', id: 'nft_1', base_production: 20, nft_mining_coin_id: 'coin_admin' }]
  ]);

  it('sala normal: soma base_production dos slots na moeda selecionada da rig', () => {
    const credits = listSlotMiningCredits('sala_1', ['gpu_1'], [], upgrades, 'btc');
    expect(credits).toEqual([{ coinId: 'btc', effectiveBaseProd: 10, countsTowardGeneralPower: true }]);
  });

  it('sala normal sem moeda selecionada: nada creditado', () => {
    expect(listSlotMiningCredits('sala_1', ['gpu_1'], [], upgrades, '')).toEqual([]);
  });

  it('sala normal com moeda exclusiva NFT selecionada: nada creditado', () => {
    expect(listSlotMiningCredits('sala_1', ['gpu_1'], [], upgrades, 'usdt')).toEqual([]);
  });

  it('sala NFT: cada slot colecionável credita na moeda do upgrade (nft_mining_coin_id)', () => {
    const nftRoomIds = new Set([NFT_AUTO_ROOM_ID]);
    const credits = listSlotMiningCredits(NFT_AUTO_ROOM_ID, ['nft_1'], [], upgrades, '', nftRoomIds);
    expect(credits).toEqual([{ coinId: 'coin_admin', effectiveBaseProd: 20, countsTowardGeneralPower: false }]);
  });

  it('sala NFT: ASIC real não credita (mineração de ASIC é na Sala ASICs)', () => {
    const nftRoomIds = new Set([NFT_AUTO_ROOM_ID]);
    expect(listSlotMiningCredits(NFT_AUTO_ROOM_ID, ['asic_1'], [], upgrades, '', nftRoomIds)).toEqual([]);
  });

  it('rack Dólar NFT fora da Sala NFT/ASICs não minera nada', () => {
    const credits = listSlotMiningCredits('sala_1', ['gpu_1'], [], upgrades, 'btc', new Set(), NFT_AUTO_ALLOWED_CHASSIS_ID);
    expect(credits).toEqual([]);
  });

  it('rack Dólar NFT na Sala ASICs minera (par da regra de montagem)', () => {
    const credits = listSlotMiningCredits(
      ASIC_ROOM_ID,
      ['gpu_1'],
      [],
      upgrades,
      'btc',
      new Set(),
      NFT_AUTO_ALLOWED_CHASSIS_ID,
      new Set([ASIC_ROOM_ID])
    );
    expect(credits).toEqual([{ coinId: 'btc', effectiveBaseProd: 10, countsTowardGeneralPower: false }]);
  });
});
