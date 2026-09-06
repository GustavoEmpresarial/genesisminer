//! Tolerância numérica oficial do motor (Plano 5) — espelho de `mining-economic-epsilon.ts`.

pub const MINING_AMOUNT_ABS_EPSILON: f64 = 1e-9;
pub const MINING_AMOUNT_REL_EPSILON: f64 = 1e-12;

pub fn amounts_almost_equal(a: f64, b: f64) -> bool {
    if !a.is_finite() || !b.is_finite() {
        return false;
    }
    let diff = (a - b).abs();
    let scale = a.abs().max(b.abs()).max(1.0);
    diff <= MINING_AMOUNT_ABS_EPSILON.max(MINING_AMOUNT_REL_EPSILON * scale)
}

pub fn assert_amounts_almost_equal(a: f64, b: f64, context: &str) -> Result<(), String> {
    if amounts_almost_equal(a, b) {
        return Ok(());
    }
    let diff = (a - b).abs();
    Err(format!(
        "[MiningEpsilon] {context}: a={a} b={b} |Δ|={diff} (abs={MINING_AMOUNT_ABS_EPSILON} rel={MINING_AMOUNT_REL_EPSILON})"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_within_abs() {
        assert!(amounts_almost_equal(1.0, 1.0 + 1e-10));
        assert!(!amounts_almost_equal(1.0, 1.0 + 1e-6));
    }
}
