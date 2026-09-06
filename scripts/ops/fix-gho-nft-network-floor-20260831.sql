-- GHO_nft: piso admin absurdo (1e6) vs ~180 H/s vivo. Alinha piso ao poder equipado.
-- 2026-08-31

UPDATE mining_coins
SET network_hashrate = GREATEST(
  1,
  CEIL((
    SELECT COALESCE(SUM(u.base_production), 0)
    FROM rack_slots rs
    JOIN placed_racks pr ON pr.id = rs.rack_id
    JOIN upgrades u ON u.id = rs.machine_item_id
    WHERE u.nft_mining_coin_id = mining_coins.id
  )::numeric)
)
WHERE id = '6529d347-d3dd-4dc8-b15f-3a4d318a301f'
RETURNING id, symbol, network_hashrate;
