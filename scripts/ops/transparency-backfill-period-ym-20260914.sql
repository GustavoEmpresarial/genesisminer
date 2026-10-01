-- Backfill de `period_ym` nos lançamentos de transparência sem mês.
--
-- PROPOSTA PARA REVISÃO — não corras isto sem ler. Cada UPDATE está comentado com o
-- porquê, e há lançamentos onde "Geral / permanente" é provavelmente a escolha certa.
--
-- Contexto: com `period_scope = 'all_time'` (o default) isto não muda nada no índice.
-- Só passa a importar quando ligares o âmbito 'season' ou 'current_month' no painel de
-- admin, porque aí `count_undated` decide se os lançamentos sem mês continuam a contar.
--
-- Estado em 2026-09-14: 12 lançamentos sem mês válido.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Antes: o que vai ser tocado
-- ---------------------------------------------------------------------------
SELECT id, category, COALESCE(amount_usdc, 0)::numeric(12, 2) AS amt,
       to_char(to_timestamp(created_at / 1000) AT TIME ZONE 'UTC', 'YYYY-MM') AS criado_em,
       left(title, 50) AS titulo
  FROM transparency_entries
 WHERE period_ym IS NULL OR period_ym !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 ORDER BY created_at;

-- ---------------------------------------------------------------------------
-- 2. DEIXAR COMO "GERAL" (sem período) — recomendado
-- ---------------------------------------------------------------------------
-- Custos fixos mensais recorrentes. O corpo do próprio lançamento diz "custo mensal":
--   4  SERVIDOR                              $200
--   6  IA de codificação                     $200
--   7  Sites e serviços operacionais         $100
--   8  CONTRIBUIÇÃO AOS DEVS                 $900
--  16  DESENVOLVIMENTO MASTER LEGEND LEAGUE $1200
-- Se estes são despesas que se repetem todos os meses, "Geral" + `count_undated = true`
-- é a modelação correta: contam em qualquer janela. Não fazer nada.
--
-- Publicações informativas com amount 0 (não mexem na matemática de todo):
--   5  Pools DEFI Genesis DAO (link)
--  14  GRÁFICO DO TOKEN GEMT (link)
--  15  IMPORTANTE (comunicado)
--  17  Incidente de piso de rede (post-mortem)
-- Não fazer nada.

-- ---------------------------------------------------------------------------
-- 3. CANDIDATOS A DATAR — descomenta só os que quiseres
-- ---------------------------------------------------------------------------
-- Investimentos: ficam FORA do cálculo em qualquer caso (categoria `investment`),
-- por isso datá-los é só arrumação do portal público.
-- UPDATE transparency_entries SET period_ym = '2026-05', updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
--  WHERE id = 9;   -- Lastro de segurança em Bitcoin/Sol/BNB  $9.500
-- UPDATE transparency_entries SET period_ym = '2026-05', updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
--  WHERE id = 11;  -- OPERAÇÕES EM SHORT INVERSE              $1.000

-- Entrada de pool pontual de maio. Esta CONTA para o sub-score do portal, por isso
-- datá-la tira-a das temporadas seguintes:
-- UPDATE transparency_entries SET period_ym = '2026-05', updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
--  WHERE id = 12;  -- POOL DA MINERAÇÃO TOKEN GEMT            $500

-- ---------------------------------------------------------------------------
-- 4. Depois: confirmar
-- ---------------------------------------------------------------------------
SELECT COALESCE(period_ym, '(geral)') AS periodo, category, count(*),
       sum(COALESCE(amount_usdc, 0))::numeric(12, 2) AS total
  FROM transparency_entries
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- Revê o output acima. Depois:  COMMIT;   (ou ROLLBACK; se algo não bater certo)
ROLLBACK;
