//! Calculator "Analisar com IA" — `POST /v1/calculator/ai-analyze`.
//!
//! Rebuilds the same server snapshot as `/v1/calculator/snapshot`, renders a
//! compact briefing, and asks the Anthropic Messages API for concrete tuning
//! advice. Returns `{ ok, analysisMarkdown, model, scope }`.
//!
//! No API key configured → `AI_NOT_CONFIGURED` (503). Upstream failure → 502.

use std::time::Duration;

use deadpool_postgres::Pool;
use genesis_core::calculator::types::{PlayerCalculatorCoinComparison, PlayerCalculatorSnapshot};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::warn;

use crate::calculator::run_calculator_snapshot;
use crate::config::WorkerConfig;

pub const CALCULATOR_AI_ANALYZE_PATH: &str = "/v1/calculator/ai-analyze";

const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const AI_MAX_TOKENS: u32 = 1400;
const AI_TIMEOUT_SECS: u64 = 55;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatorAiAnalyzeRequest {
    pub user_id: i64,
    #[serde(default)]
    pub scope: Option<String>,
}

/// Error payload — mirrors the client contract (`error` + optional `detail` + `code`).
#[derive(Debug)]
pub struct AiAnalyzeError {
    pub http_status: u16,
    pub code: &'static str,
    pub error: String,
    pub detail: Option<String>,
}

impl AiAnalyzeError {
    pub fn to_body(&self) -> Value {
        let mut body = json!({ "ok": false, "error": self.error, "code": self.code });
        if let Some(detail) = &self.detail {
            body["detail"] = json!(detail);
        }
        body
    }

    fn upstream(detail: impl Into<String>) -> Self {
        Self {
            http_status: 502,
            code: "AI_UPSTREAM",
            error: "A análise IA falhou. Tenta novamente.".to_string(),
            detail: Some(detail.into()),
        }
    }
}

pub async fn run_calculator_ai_analyze(
    pool: &Pool,
    http: &reqwest::Client,
    cfg: &WorkerConfig,
    user_id: i64,
    scope_raw: Option<&str>,
) -> Result<Value, AiAnalyzeError> {
    let snapshot = run_calculator_snapshot(pool, user_id, scope_raw)
        .await
        .map_err(|e| AiAnalyzeError {
            http_status: e.http_status,
            code: e.code,
            error: e.message.clone(),
            detail: None,
        })?
        .snapshot;

    let Some(api_key) = cfg.anthropic_api_key.as_deref() else {
        return Err(AiAnalyzeError {
            http_status: 503,
            code: "AI_NOT_CONFIGURED",
            error: "A análise IA não está configurada neste servidor.".to_string(),
            detail: None,
        });
    };

    let briefing = render_briefing(&snapshot);
    let model = cfg.calculator_ai_model.clone();

    let request_body = json!({
        "model": model,
        "max_tokens": AI_MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": [{
            "role": "user",
            "content": format!(
                "Analisa a configuração de mineração deste jogador e dá recomendações \
                 concretas e acionáveis para aumentar o rendimento em USD. Responde em \
                 português de Portugal, em Markdown.\n\n{briefing}"
            ),
        }],
    });

    let resp = http
        .post(ANTHROPIC_MESSAGES_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .timeout(Duration::from_secs(AI_TIMEOUT_SECS))
        .json(&request_body)
        .send()
        .await
        .map_err(|e| {
            warn!(err = %e, "calculator ai-analyze: request failed");
            AiAnalyzeError::upstream(format!("request: {e}"))
        })?;

    let status = resp.status();
    let payload: Value = resp.json().await.map_err(|e| {
        warn!(err = %e, "calculator ai-analyze: non-JSON upstream response");
        AiAnalyzeError::upstream(format!("decode: {e}"))
    })?;

    if !status.is_success() {
        let msg = payload
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("upstream error")
            .to_string();
        warn!(status = status.as_u16(), msg = %msg, "calculator ai-analyze: upstream error");
        return Err(AiAnalyzeError::upstream(format!("{}: {msg}", status.as_u16())));
    }

    let text = extract_text(&payload);
    if text.trim().is_empty() {
        return Err(AiAnalyzeError::upstream("empty completion"));
    }

    Ok(json!({
        "ok": true,
        "analysisMarkdown": text,
        "model": payload.get("model").and_then(Value::as_str).unwrap_or(&model),
        "scope": snapshot.scope,
    }))
}

/// Concatenate every `text` content block of an Anthropic Messages response.
fn extract_text(payload: &Value) -> String {
    payload
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

const SYSTEM_PROMPT: &str = "És um analista do jogo de mineração Genesis Miner. \
Recebes um resumo numérico já calculado pelo servidor (potência efetiva, ganhos \
diários e projeção a 30 dias por moeda). Não inventes números nem mecânicas. \
Explica de forma directa: (1) qual a moeda mais rentável agora e porquê, \
(2) se o jogador devia trocar a moeda que está a minerar, (3) 2 a 4 acções \
concretas para melhorar o rendimento. Sê conciso — no máximo ~250 palavras.";

fn render_briefing(s: &PlayerCalculatorSnapshot) -> String {
    let mut out = String::new();
    out.push_str(&format!("Âmbito: {}\n", s.scope));
    out.push_str(&format!(
        "Potência geral efetiva: {:.2} H/s\n\n",
        s.general_power_hps
    ));

    out.push_str("Comparação de moedas (todas as moedas disponíveis):\n");
    let mut comps: Vec<&PlayerCalculatorCoinComparison> = s.coin_comparisons.iter().collect();
    comps.sort_by(|a, b| {
        b.projection30_usd
            .partial_cmp(&a.projection30_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for c in comps {
        out.push_str(&format!(
            "- {} ({}): preço ${:.6} | {}minerando agora | ${:.4}/dia | 30d ${:.2}\n",
            c.name,
            c.symbol,
            c.price_usd,
            if c.is_actively_mining { "" } else { "NÃO " },
            c.daily_usd,
            c.projection30_usd,
        ));
    }

    out.push_str("\nMoedas com potência atribuída pelo jogador:\n");
    let mut any = false;
    for coin in &s.coins {
        if coin.user_power_hps <= 0.0 {
            continue;
        }
        any = true;
        out.push_str(&format!(
            "- {} ({}): {:.2} H/s | ${:.4}/dia | 30d ${:.2}{}{}\n",
            coin.name,
            coin.symbol,
            coin.user_power_hps,
            coin.daily_usd,
            coin.projection30_usd,
            if coin.nft_room_only { " | só sala NFT" } else { "" },
            if coin.independent_pool {
                " | pool independente"
            } else {
                ""
            },
        ));
    }
    if !any {
        out.push_str("- (nenhuma — o jogador não tem racks ligados a minerar)\n");
    }

    out
}
