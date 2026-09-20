use serde_json::{json, Map, Value};

use crate::criteria::{Question, CRITERIA};

pub fn evaluate_response(text: &str) -> Value {
    let mut hash = djb2(text);
    let mut answers = Map::new();
    for criterion in CRITERIA {
        hash = step(hash, 1);
        answers.insert(
            criterion.id.to_string(),
            fake_answer(hash, &criterion.question),
        );
    }
    json!({
        "model": "typesafe-ai/jev",
        "answers": answers,
    })
}

fn fake_answer(hash: u64, question: &Question) -> Value {
    match question {
        Question::Boolean { .. } => json!({
            "type": "boolean",
            "probability": unit01(hash),
        }),
        Question::Score { levels, .. } => {
            let probabilities = dist(hash, levels.len());
            let score: f64 = probabilities
                .iter()
                .enumerate()
                .map(|(index, probability)| index as f64 * probability)
                .sum();
            json!({
                "type": "score",
                "score": score,
                "probabilities": keyed_numeric(&probabilities),
            })
        }
        Question::Choice { options, .. } => {
            let probabilities = dist(hash, options.len());
            let mut best_index = 0;
            let mut best = f64::NEG_INFINITY;
            for (index, probability) in probabilities.iter().enumerate() {
                if *probability > best {
                    best = *probability;
                    best_index = index;
                }
            }
            let mut keyed = Map::new();
            for (option, probability) in options.iter().zip(probabilities.iter()) {
                keyed.insert(option.id.to_string(), json!(probability));
            }
            json!({
                "type": "choice",
                "choice": options[best_index].id,
                "probabilities": keyed,
            })
        }
    }
}

fn keyed_numeric(probabilities: &[f64]) -> Map<String, Value> {
    let mut keyed = Map::new();
    for (index, probability) in probabilities.iter().enumerate() {
        keyed.insert(index.to_string(), json!(probability));
    }
    keyed
}

fn djb2(text: &str) -> u64 {
    let mut hash: u64 = 5381;
    for byte in text.as_bytes() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_add(hash)
            .wrapping_add(u64::from(*byte));
    }
    hash
}

fn step(hash: u64, salt: u64) -> u64 {
    hash.wrapping_shl(5).wrapping_add(hash).wrapping_add(salt)
}

fn unit01(hash: u64) -> f64 {
    (hash % 10_001) as f64 / 10_000.0
}

fn dist(mut hash: u64, n: usize) -> Vec<f64> {
    let mut weights = Vec::with_capacity(n);
    for index in 0..n {
        hash = step(hash, index as u64 + 1);
        weights.push((hash % 1000) as f64 + 1.0);
    }
    let sum: f64 = weights.iter().sum();
    weights.into_iter().map(|weight| weight / sum).collect()
}
