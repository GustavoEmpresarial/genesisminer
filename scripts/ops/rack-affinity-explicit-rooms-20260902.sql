-- Chassis rackRoomAffinity explícita (salas).
-- 'standard' passa a significar SÓ sala normal; combinados via asic+standard etc.
-- Idempotente. NÃO aplicar automaticamente na VM.
--
-- 1) army / promo (+ merges) → só Sala ASICs
-- 2) rack_armario_1 (+ merges) → só Sala NFT
-- 3) restantes infrastructure null/''/'standard' → asic+standard (paridade antiga)

UPDATE upgrades
SET rack_room_affinity = 'asic'
WHERE type = 'infrastructure'
  AND (
    id IN ('rack_army', 'rack_promo')
    OR id LIKE 'merge_rack_army_%'
    OR id LIKE 'merge_rack_promo_%'
    OR id LIKE 'merge_%_rack_army_%'
    OR id LIKE 'merge_%_rack_promo_%'
  );

UPDATE upgrades
SET rack_room_affinity = 'nft'
WHERE type = 'infrastructure'
  AND (
    id = 'rack_armario_1'
    OR id LIKE 'merge_rack_armario_1_%'
    OR id LIKE 'merge_%_rack_armario_1_%'
  );

UPDATE upgrades
SET rack_room_affinity = 'asic+standard'
WHERE type = 'infrastructure'
  AND (
    rack_room_affinity IS NULL
    OR btrim(rack_room_affinity) = ''
    OR rack_room_affinity = 'standard'
  );
