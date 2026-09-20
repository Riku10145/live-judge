use std::collections::BTreeMap;

use crate::criteria::{Prompt, CRITERIA};
use crate::verdict::{self, Answer, Verdict};

/// FNV-1a, used instead of `DefaultHasher` because that hasher is not stable
/// across Rust releases and demo verdicts must survive a restart.
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn unit(hash: u64, salt: u64) -> f64 {
    ((hash.wrapping_mul(salt ^ 0x9e3779b97f4a7c15)) % 10_001) as f64 / 10_000.0
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn nudge(value: f64, delta: f64) -> f64 {
    clamp01(value + delta)
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub fn judge(text: &str) -> BTreeMap<String, Verdict> {
    let hash = fnv1a(text);
    let mut verdicts = BTreeMap::new();
    for criterion in CRITERIA {
        let answer = demo_answer(criterion.id, &criterion.prompt, text, hash);
        let verdict = verdict::to_verdict(criterion, &answer, None)
            .expect("demo answers are built to match the registry");
        verdicts.insert(criterion.id.to_string(), verdict);
    }
    verdicts
}

fn demo_answer(id: &str, prompt: &Prompt, text: &str, hash: u64) -> Answer {
    match prompt {
        Prompt::Boolean { .. } => {
            let mut probability = unit(hash, salt(id, 1));
            if contains_any(text, &["最高", "嬉しい", "楽しい", "好き", "良い", "いい"])
            {
                probability = nudge(probability, 0.35);
            }
            if contains_any(text, &["最悪", "つらい", "しんどい", "嫌い", "ダメ"]) {
                probability = nudge(probability, -0.35);
            }
            Answer::Boolean {
                probability: round2(probability),
            }
        }
        Prompt::Score { levels, .. } => {
            let n = levels.len();
            let mut weights: Vec<f64> = (0..n)
                .map(|index| 0.08 + unit(hash, salt(id, index as u64 + 2)))
                .collect();
            if bang_count(text) > 0 || contains_any(text, &["w", "W", "草"]) {
                if let Some(last) = weights.last_mut() {
                    *last += 1.4;
                }
            }
            let total: f64 = weights.iter().sum();
            let mut score = 0.0;
            let mut probabilities = BTreeMap::new();
            for (index, weight) in weights.iter().enumerate() {
                let p = round2(weight / total);
                score += index as f64 * p;
                probabilities.insert(index.to_string(), p);
            }
            Answer::Score {
                score: round2(score),
                probabilities: Some(probabilities),
            }
        }
        Prompt::Choice { options, .. } => {
            let mut weights: Vec<(&str, f64)> = options
                .iter()
                .enumerate()
                .map(|(index, option)| (option.key, 0.12 + unit(hash, salt(id, index as u64 + 11))))
                .collect();
            if contains_any(text, &["w", "W", "草", "ネタ"]) {
                bump(&mut weights, "neta", 1.1);
            }
            if bang_count(text) > 1 || contains_any(text, &["本気", "本当"]) {
                bump(&mut weights, "honki", 0.8);
            }
            let total: f64 = weights.iter().map(|(_, w)| *w).sum();
            let mut distribution = BTreeMap::new();
            let mut choice = weights[0].0.to_string();
            let mut best = -1.0;
            for (key, weight) in &weights {
                let p = round2(weight / total);
                distribution.insert((*key).to_string(), p);
                if p > best {
                    best = p;
                    choice = (*key).to_string();
                }
            }
            Answer::Choice {
                choice,
                probabilities: Some(distribution),
            }
        }
    }
}

fn salt(id: &str, n: u64) -> u64 {
    fnv1a(id).wrapping_add(n.wrapping_mul(0x100000001b3))
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn bang_count(text: &str) -> usize {
    text.chars().filter(|ch| *ch == '!' || *ch == '！').count()
}

fn bump(weights: &mut [(&str, f64)], key: &str, delta: f64) {
    if let Some((_, weight)) = weights.iter_mut().find(|(k, _)| *k == key) {
        *weight += delta;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::criteria;

    #[test]
    fn identical_text_produces_identical_verdicts() {
        let a = judge("このセット、本当に最高だった！");
        let b = judge("このセット、本当に最高だった！");
        assert_eq!(a, b);
        assert_eq!(a.len(), criteria::CRITERIA.len());
    }

    #[test]
    fn different_text_produces_different_verdicts() {
        let a = judge("このセット、本当に最高だった！");
        let b = judge("正直これはしんどい");
        assert_ne!(a, b);
    }

    #[test]
    fn every_demo_verdict_matches_its_criterion() {
        let verdicts = judge("テスト");
        for criterion in criteria::CRITERIA {
            let verdict = &verdicts[criterion.id];
            match (&criterion.prompt, verdict) {
                (Prompt::Boolean { .. }, Verdict::Boolean { .. })
                | (Prompt::Score { .. }, Verdict::Score { .. })
                | (Prompt::Choice { .. }, Verdict::Choice { .. }) => {}
                _ => panic!("{} produced a mismatched verdict", criterion.id),
            }
        }
    }
}
