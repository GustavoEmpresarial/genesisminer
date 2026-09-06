/**
 * Public mining ranking UI — merged into catalogs as `ranking`.
 */
import type { MessageTree } from '../../types';

export const rankingEn: MessageTree = {
  loading: 'Loading ranking…',
  errorPrefix: 'Error: {{message}}',
  titleGlobal: 'Global Miner Leaderboard',
  titleCoin: 'Ranking {{name}} ({{symbol}})',
  sortedBy: 'Sorted by mining power',
  sortedByGlobalHint:
    ' — global excludes H/s from ASICs in the NFT Room; use the coin filter for USDT, DAI, GEMT, etc.',
  totalListed: 'Total listed',
  filterGlobal: 'Global (Overall)',
  powerGlobal: 'Accumulated global power',
  powerTotalCoin: 'Total power ({{symbol}})',
  avgPerPlayer: 'Average per player',
  activeMining: 'Active mining',
  players: 'Players',
  anyCoin: 'In any coin',
  inCoin: 'In {{name}}',
  averagesByCoin: 'Averages per coin',
  colRank: '#',
  colUser: 'User',
  colPowerTotal: 'Total power (H/s)',
  colPowerMining: 'Mining power (H/s)',
  colShare: '% of total',
  empty: 'No active miners found.'
};

export const rankingPt: MessageTree = {
  loading: 'Carregando ranking…',
  errorPrefix: 'Erro: {{message}}',
  titleGlobal: 'Ranking Global de Mineradores',
  titleCoin: 'Ranking {{name}} ({{symbol}})',
  sortedBy: 'Organizado por Poder de Mineração',
  sortedByGlobalHint:
    ' — global exclui H/s das ASICs na Sala NFT; use o filtro por moeda para USDT, DAI, GEMT, etc.',
  totalListed: 'Total Listados',
  filterGlobal: 'Global (Geral)',
  powerGlobal: 'Poder Global Acumulado',
  powerTotalCoin: 'Poder Total ({{symbol}})',
  avgPerPlayer: 'Média por Jogador',
  activeMining: 'Mineração Ativa',
  players: 'Jogadores',
  anyCoin: 'Em qualquer moeda',
  inCoin: 'Em {{name}}',
  averagesByCoin: 'Médias por Moeda',
  colRank: '#',
  colUser: 'Usuário',
  colPowerTotal: 'Poder Total (H/s)',
  colPowerMining: 'Poder de Mineração (H/s)',
  colShare: '% do Total',
  empty: 'Nenhum minerador ativo encontrado.'
};

export const rankingEs: MessageTree = {
  loading: 'Cargando ranking…',
  errorPrefix: 'Error: {{message}}',
  titleGlobal: 'Clasificación global de mineros',
  titleCoin: 'Ranking {{name}} ({{symbol}})',
  sortedBy: 'Ordenado por poder de minería',
  sortedByGlobalHint:
    ' — lo global excluye H/s de ASICs en la Sala NFT; usa el filtro por moneda para USDT, DAI, GEMT, etc.',
  totalListed: 'Total listados',
  filterGlobal: 'Global (General)',
  powerGlobal: 'Poder global acumulado',
  powerTotalCoin: 'Poder total ({{symbol}})',
  avgPerPlayer: 'Media por jugador',
  activeMining: 'Minería activa',
  players: 'Jugadores',
  anyCoin: 'En cualquier moneda',
  inCoin: 'En {{name}}',
  averagesByCoin: 'Medias por moneda',
  colRank: '#',
  colUser: 'Usuario',
  colPowerTotal: 'Poder total (H/s)',
  colPowerMining: 'Poder de minería (H/s)',
  colShare: '% del total',
  empty: 'No se encontraron mineros activos.'
};
