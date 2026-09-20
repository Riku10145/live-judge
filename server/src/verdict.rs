use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::criteria::{Criterion, Prompt};

/// One jev answer, already parsed out of the gateway response. Demo mode
/// produces the same type so both paths converge on [`to_verdict`].
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Answer {
    Boolean {
        probability: f64,
    },
    Score {
        score: f64,
        #[serde(default)]
        probabilities: Option<BTreeMap<String, f64>>,
    },
    Choice {
        choice: String,
        #[serde(default)]
        probabilities: Option<BTreeMap<String, f64>>,
    },
}

impl Answer {
    pub fn kind(&self) -> &'static str {
        match self {
            Answer::Boolean { .. } => "boolean",
            Answer::Score { .. } => "score",
            Answer::Choice { .. } => "choice",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Verdict {
    Boolean {
        probability: f64,
        certainty: f64,
    },
    Score {
        score: f64,
        distribution: Option<Vec<f64>>,
        certainty: f64,
    },
    Choice {
        choice: String,
        distribution: Option<BTreeMap<String, f64>>,
        certainty: f64,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct AnswerMismatch {
    pub criterion: String,
    pub expected: &'static str,
    pub found: &'static str,
}

/// Concentration of a probability distribution, 0 for uniform and 1 for all
/// mass on one outcome. Measured as the normalized Euclidean distance from
/// uniform, which at two outcomes reduces exactly to `|2p - 1|`. That is why
/// booleans need no separate rule.
pub fn concentration(weights: &[f64]) -> f64 {
    let n = weights.len();
    if n <= 1 {
        return 1.0;
    }

    let cleaned: Vec<f64> = weights
        .iter()
        .map(|w| if w.is_finite() && *w > 0.0 { *w } else { 0.0 })
        .collect();
    let total: f64 = cleaned.iter().sum();
    if total <= 0.0 {
        return 0.0;
    }

    // jev rounds to two decimals, so a distribution can sum to 0.99. Normalizing
    // here keeps the math exact. The distribution reported on the wire stays as
    // the provider sent it, because the provider docs forbid renormalizing it.
    let mean = 1.0 / n as f64;
    let spread: f64 = cleaned.iter().map(|w| (w / total - mean).powi(2)).sum();
    (spread / (1.0 - mean)).sqrt().clamp(0.0, 1.0)
}

pub fn boolean_certainty(probability: f64) -> f64 {
    let p = if probability.is_finite() {
        probability.clamp(0.0, 1.0)
    } else {
        0.5
    };
    concentration(&[p, 1.0 - p])
}

/// Converts one answer into the verdict the board renders. `provider_confidence`
/// is the gateway's own concentration statistic, which jev reports for score and
/// choice but never for boolean.
pub fn to_verdict(
    criterion: &Criterion,
    answer: &Answer,
    provider_confidence: Option<f64>,
) -> Result<Verdict, AnswerMismatch> {
    let mismatch = |found: &'static str| AnswerMismatch {
        criterion: criterion.id.to_string(),
        expected: match &criterion.prompt {
            Prompt::Boolean { .. } => "boolean",
            Prompt::Score { .. } => "score",
            Prompt::Choice { .. } => "choice",
        },
        found,
    };

    match (&criterion.prompt, answer) {
        (Prompt::Boolean { .. }, Answer::Boolean { probability }) => {
            let probability = probability.clamp(0.0, 1.0);
            Ok(Verdict::Boolean {
                probability,
                certainty: round2(boolean_certainty(probability)),
            })
        }

        (
            Prompt::Score { levels, .. },
            Answer::Score {
                score,
                probabilities,
            },
        ) => {
            let distribution = probabilities
                .as_ref()
                .map(|p| dense_by_index(p, levels.len()));
            let certainty = derive_certainty(provider_confidence, distribution.as_deref());
            Ok(Verdict::Score {
                score: score.clamp(0.0, (levels.len().max(1) - 1) as f64),
                distribution,
                certainty,
            })
        }

        (
            Prompt::Choice { options, .. },
            Answer::Choice {
                choice,
                probabilities,
            },
        ) => {
            let distribution = probabilities.as_ref().map(|p| {
                options
                    .iter()
                    .map(|opt| (opt.key.to_string(), p.get(opt.key).copied().unwrap_or(0.0)))
                    .collect::<BTreeMap<String, f64>>()
            });
            let weights: Option<Vec<f64>> =
                distribution.as_ref().map(|d| d.values().copied().collect());
            let certainty = derive_certainty(provider_confidence, weights.as_deref());
            Ok(Verdict::Choice {
                choice: choice.clone(),
                distribution,
                certainty,
            })
        }

        (_, other) => Err(mismatch(other.kind())),
    }
}

fn derive_certainty(provider_confidence: Option<f64>, distribution: Option<&[f64]>) -> f64 {
    let certainty = match provider_confidence {
        Some(confidence) if confidence.is_finite() => confidence.clamp(0.0, 1.0),
        _ => distribution.map_or(0.0, concentration),
    };
    round2(certainty)
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// jev keys a score distribution by stringified level index. Missing indices
/// carry no mass.
fn dense_by_index(probabilities: &BTreeMap<String, f64>, levels: usize) -> Vec<f64> {
    (0..levels)
        .map(|index| {
            probabilities
                .get(&index.to_string())
                .copied()
                .unwrap_or(0.0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::criteria;

    fn approx(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn uniform_distributions_have_no_concentration() {
        approx(concentration(&[0.5, 0.5]), 0.0);
        approx(concentration(&[0.25, 0.25, 0.25, 0.25]), 0.0);
    }

    #[test]
    fn a_single_outcome_holding_all_mass_is_fully_concentrated() {
        approx(concentration(&[1.0, 0.0]), 1.0);
        approx(concentration(&[0.0, 0.0, 1.0, 0.0]), 1.0);
    }

    #[test]
    fn boolean_certainty_is_the_distance_from_a_coin_flip() {
        approx(boolean_certainty(0.5), 0.0);
        approx(boolean_certainty(0.98), 0.96);
        approx(boolean_certainty(0.0), 1.0);
        approx(boolean_certainty(1.0), 1.0);
    }

    #[test]
    fn two_decimal_rounding_matches_its_normalized_twin() {
        let rounded = [0.0, 0.02, 0.1, 0.87];
        assert!((rounded.iter().sum::<f64>() - 0.99).abs() < 1e-9);
        let normalized: Vec<f64> = rounded.iter().map(|w| w / 0.99).collect();
        approx(concentration(&rounded), concentration(&normalized));
    }

    #[test]
    fn degenerate_inputs_do_not_produce_nan() {
        approx(concentration(&[]), 1.0);
        approx(concentration(&[1.0]), 1.0);
        approx(concentration(&[0.0, 0.0, 0.0]), 0.0);
        approx(concentration(&[f64::NAN, 1.0]), 1.0);
        approx(concentration(&[-1.0, 1.0]), 1.0);
    }

    #[test]
    fn a_score_answer_becomes_a_dense_level_indexed_distribution() {
        let criterion = criteria::find("intensity").unwrap();
        let answer = Answer::Score {
            score: 2.86,
            probabilities: Some(BTreeMap::from([
                ("0".to_string(), 0.0),
                ("1".to_string(), 0.02),
                ("2".to_string(), 0.1),
                ("3".to_string(), 0.88),
            ])),
        };
        let verdict = to_verdict(criterion, &answer, Some(0.91)).unwrap();
        match verdict {
            Verdict::Score {
                score,
                distribution,
                certainty,
            } => {
                approx(score, 2.86);
                assert_eq!(distribution, Some(vec![0.0, 0.02, 0.1, 0.88]));
                approx(certainty, 0.91);
            }
            other => panic!("expected a score verdict, got {other:?}"),
        }
    }

    #[test]
    fn provider_confidence_wins_over_the_distribution() {
        let criterion = criteria::find("register").unwrap();
        let answer = Answer::Choice {
            choice: "honki".to_string(),
            probabilities: Some(BTreeMap::from([
                ("neta".to_string(), 0.12),
                ("honki".to_string(), 0.88),
            ])),
        };

        let with_provider = to_verdict(criterion, &answer, Some(0.47)).unwrap();
        let derived = to_verdict(criterion, &answer, None).unwrap();

        let certainty_of = |v: &Verdict| match v {
            Verdict::Choice { certainty, .. } => *certainty,
            other => panic!("expected a choice verdict, got {other:?}"),
        };

        approx(certainty_of(&with_provider), 0.47);
        approx(certainty_of(&derived), 0.76);
    }

    #[test]
    fn a_missing_distribution_still_yields_a_certainty() {
        let criterion = criteria::find("intensity").unwrap();
        let answer = Answer::Score {
            score: 1.0,
            probabilities: None,
        };
        match to_verdict(criterion, &answer, None).unwrap() {
            Verdict::Score {
                distribution,
                certainty,
                ..
            } => {
                assert_eq!(distribution, None);
                approx(certainty, 0.0);
            }
            other => panic!("expected a score verdict, got {other:?}"),
        }
    }

    #[test]
    fn an_answer_of_the_wrong_type_is_rejected() {
        let criterion = criteria::find("positivity").unwrap();
        let answer = Answer::Score {
            score: 1.0,
            probabilities: None,
        };
        assert_eq!(
            to_verdict(criterion, &answer, None),
            Err(AnswerMismatch {
                criterion: "positivity".to_string(),
                expected: "boolean",
                found: "score",
            })
        );
    }

    #[test]
    fn a_choice_answer_keeps_only_options_the_registry_declared() {
        let criterion = criteria::find("register").unwrap();
        let answer = Answer::Choice {
            choice: "honki".to_string(),
            probabilities: Some(BTreeMap::from([
                ("honki".to_string(), 0.9),
                ("unknown".to_string(), 0.1),
            ])),
        };
        match to_verdict(criterion, &answer, None).unwrap() {
            Verdict::Choice { distribution, .. } => {
                let distribution = distribution.unwrap();
                assert_eq!(distribution.get("neta"), Some(&0.0));
                assert_eq!(distribution.get("honki"), Some(&0.9));
                assert_eq!(distribution.get("unknown"), None);
            }
            other => panic!("expected a choice verdict, got {other:?}"),
        }
    }

    #[test]
    fn the_wire_shape_matches_the_contract() {
        let verdict = Verdict::Boolean {
            probability: 0.93,
            certainty: 0.86,
        };
        let json = serde_json::to_value(&verdict).unwrap();
        assert_eq!(json["type"], "boolean");
        assert_eq!(json["probability"], 0.93);
        assert_eq!(json["certainty"], 0.86);
    }
}
