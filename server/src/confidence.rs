pub fn concentration(probs: &[f64]) -> f64 {
    let n = probs.len();
    if n == 0 {
        return 0.0;
    }
    if n == 1 {
        return 1.0;
    }
    let n_f = n as f64;
    let uniform = 1.0 / n_f;
    let sum_sq: f64 = probs.iter().map(|q| (q - uniform).powi(2)).sum();
    let denom = 1.0 - uniform;
    (sum_sq / denom).sqrt().clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::concentration;

    fn assert_close(got: f64, expected: f64) {
        assert!(
            (got - expected).abs() < 1e-9,
            "concentration={got} expected={expected}"
        );
    }

    #[test]
    fn certain_two_outcome() {
        assert_close(concentration(&[1.0, 0.0]), 1.0);
    }

    #[test]
    fn uniform_two_outcome() {
        assert_close(concentration(&[0.5, 0.5]), 0.0);
    }

    #[test]
    fn boolean_matches_abs_form() {
        assert_close(concentration(&[0.8, 0.2]), 0.6);
    }
}
