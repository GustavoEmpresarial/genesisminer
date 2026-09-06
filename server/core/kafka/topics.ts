/** Tópicos canónicos — ver deploy/kafka/topics.md. */
export const KAFKA_TOPIC_MINING_PROGRESS = 'genesis.mining.progress';
export const KAFKA_TOPIC_ECONOMY_LEDGER = 'genesis.economy.ledger';
export const KAFKA_TOPIC_RANKING_SNAPSHOT = 'genesis.ranking.snapshot';
export const KAFKA_TOPIC_PARTNER_GAMES_SESSION = 'genesis.partner_games.session';
export const KAFKA_TOPIC_MARKET_EVENTS = 'genesis.market.events';
export const KAFKA_TOPIC_LUCKY_BOX_OPEN = 'genesis.lucky_box.open';

export const KAFKA_HEADER_INVALIDATE_TOPICS = [
  KAFKA_TOPIC_MINING_PROGRESS,
  KAFKA_TOPIC_ECONOMY_LEDGER
] as const;
