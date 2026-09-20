use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::confidence::concentration;

pub struct Criterion {
    pub id: &'static str,
    pub label: &'static str,
    pub question: Question,
}

pub enum Question {
    Boolean {
        instructions: &'static str,
        true_meaning: &'static str,
        false_meaning: &'static str,
    },
    Score {
        instructions: &'static str,
        levels: &'static [&'static str],
    },
    Choice {
        instructions: &'static str,
        options: &'static [ChoiceOption],
    },
}

pub struct ChoiceOption {
    pub id: &'static str,
    pub label: &'static str,
    pub meaning: &'static str,
}

pub static CRITERIA: &[Criterion] = &[
    Criterion {
        id: "positivity",
        label: "前向きさ",
        question: Question::Boolean {
            instructions: "この文章は前向き・建設的か。",
            true_meaning: "前向き・建設的",
            false_meaning: "後ろ向き・否定的",
        },
    },
    Criterion {
        id: "intensity",
        label: "強度",
        question: Question::Score {
            instructions: "この文章の強度。",
            levels: &["穏やか", "はっきり", "強い", "激しい"],
        },
    },
    Criterion {
        id: "stance",
        label: "ネタ本気",
        question: Question::Choice {
            instructions: "この文章はネタか本気か。",
            options: &[
                ChoiceOption {
                    id: "joke",
                    label: "ネタ",
                    meaning: "ネタ・冗談",
                },
                ChoiceOption {
                    id: "serious",
                    label: "本気",
                    meaning: "本気・真剣",
                },
            ],
        },
    },
];

#[derive(Serialize)]
pub struct CriteriaResponse {
    pub criteria: Vec<CriterionMeta>,
}

#[derive(Serialize)]
#[serde(tag = "kind")]
pub enum CriterionMeta {
    #[serde(rename = "boolean")]
    Boolean {
        id: &'static str,
        label: &'static str,
    },
    #[serde(rename = "score")]
    Score {
        id: &'static str,
        label: &'static str,
        levels: &'static [&'static str],
    },
    #[serde(rename = "choice")]
    Choice {
        id: &'static str,
        label: &'static str,
        options: Vec<ChoiceMeta>,
    },
}

#[derive(Serialize)]
pub struct ChoiceMeta {
    pub id: &'static str,
    pub label: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub enum CriterionView {
    #[serde(rename = "boolean")]
    Boolean {
        id: &'static str,
        label: &'static str,
        probability: f64,
        confidence: f64,
    },
    #[serde(rename = "score")]
    Score {
        id: &'static str,
        label: &'static str,
        score: f64,
        levels: &'static [&'static str],
        probabilities: Vec<f64>,
        confidence: f64,
    },
    #[serde(rename = "choice")]
    Choice {
        id: &'static str,
        label: &'static str,
        choice: &'static str,
        options: Vec<ChoiceOptionView>,
        confidence: f64,
    },
}

#[derive(Debug, Serialize)]
pub struct ChoiceOptionView {
    pub id: &'static str,
    pub label: &'static str,
    pub probability: f64,
}

#[derive(Debug, thiserror::Error)]
pub enum MapError {
    #[error("missing answer for {0}")]
    Missing(&'static str),
    #[error("invalid answer for {0}")]
    Invalid(&'static str),
}

pub fn metadata() -> CriteriaResponse {
    CriteriaResponse {
        criteria: CRITERIA.iter().map(Criterion::meta).collect(),
    }
}

pub fn build_questions() -> Value {
    let mut questions = Map::new();
    for criterion in CRITERIA {
        questions.insert(criterion.id.to_string(), criterion.gateway_question());
    }
    Value::Object(questions)
}

pub fn map_answers(answers: &Map<String, Value>) -> Result<Vec<CriterionView>, MapError> {
    CRITERIA
        .iter()
        .map(|criterion| criterion.view_from(answers))
        .collect()
}

impl Criterion {
    fn meta(&self) -> CriterionMeta {
        match self.question {
            Question::Boolean { .. } => CriterionMeta::Boolean {
                id: self.id,
                label: self.label,
            },
            Question::Score { levels, .. } => CriterionMeta::Score {
                id: self.id,
                label: self.label,
                levels,
            },
            Question::Choice { options, .. } => CriterionMeta::Choice {
                id: self.id,
                label: self.label,
                options: options
                    .iter()
                    .map(|option| ChoiceMeta {
                        id: option.id,
                        label: option.label,
                    })
                    .collect(),
            },
        }
    }

    fn gateway_question(&self) -> Value {
        match self.question {
            Question::Boolean {
                instructions,
                true_meaning,
                false_meaning,
            } => json!({
                "type": "boolean",
                "instructions": instructions,
                "criteria": {
                    "true": true_meaning,
                    "false": false_meaning,
                }
            }),
            Question::Score {
                instructions,
                levels,
            } => json!({
                "type": "score",
                "instructions": instructions,
                "criteria": levels,
            }),
            Question::Choice {
                instructions,
                options,
            } => {
                let mut criteria = Map::new();
                for option in options {
                    criteria.insert(option.id.to_string(), json!(option.meaning));
                }
                json!({
                    "type": "choice",
                    "instructions": instructions,
                    "criteria": criteria,
                })
            }
        }
    }

    fn view_from(&self, answers: &Map<String, Value>) -> Result<CriterionView, MapError> {
        let raw = answers.get(self.id).ok_or(MapError::Missing(self.id))?;
        match self.question {
            Question::Boolean { .. } => {
                let probability = parse_boolean(raw).ok_or(MapError::Invalid(self.id))?;
                Ok(CriterionView::Boolean {
                    id: self.id,
                    label: self.label,
                    probability,
                    confidence: concentration(&[probability, 1.0 - probability]),
                })
            }
            Question::Score { levels, .. } => {
                let (score, probabilities) =
                    parse_score(raw, levels.len()).ok_or(MapError::Invalid(self.id))?;
                let confidence = concentration(&probabilities);
                Ok(CriterionView::Score {
                    id: self.id,
                    label: self.label,
                    score,
                    levels,
                    probabilities,
                    confidence,
                })
            }
            Question::Choice { options, .. } => {
                let (choice, probabilities) =
                    parse_choice(raw, options).ok_or(MapError::Invalid(self.id))?;
                let confidence = concentration(&probabilities);
                let views = options
                    .iter()
                    .zip(probabilities.iter())
                    .map(|(option, probability)| ChoiceOptionView {
                        id: option.id,
                        label: option.label,
                        probability: *probability,
                    })
                    .collect();
                Ok(CriterionView::Choice {
                    id: self.id,
                    label: self.label,
                    choice,
                    options: views,
                    confidence,
                })
            }
        }
    }
}

fn type_is(value: &Value, expected: &str) -> bool {
    value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|ty| ty == expected)
}

fn finite_unit(value: Option<&Value>) -> Option<f64> {
    let number = value.and_then(Value::as_f64)?;
    if number.is_finite() && (0.0..=1.0).contains(&number) {
        Some(number)
    } else {
        None
    }
}

fn parse_boolean(value: &Value) -> Option<f64> {
    if !type_is(value, "boolean") {
        return None;
    }
    finite_unit(value.get("probability"))
}

fn parse_score(value: &Value, n: usize) -> Option<(f64, Vec<f64>)> {
    if !type_is(value, "score") {
        return None;
    }
    let score = value.get("score").and_then(Value::as_f64)?;
    if !score.is_finite() || !(0.0..=(n as f64 - 1.0)).contains(&score) {
        return None;
    }
    let probs_obj = value.get("probabilities")?.as_object()?;
    let mut probabilities = Vec::with_capacity(n);
    for index in 0..n {
        probabilities.push(finite_unit(probs_obj.get(&index.to_string()))?);
    }
    Some((score, probabilities))
}

fn parse_choice(value: &Value, options: &[ChoiceOption]) -> Option<(&'static str, Vec<f64>)> {
    if !type_is(value, "choice") {
        return None;
    }
    let chosen = value.get("choice")?.as_str()?;
    let choice = options.iter().find(|option| option.id == chosen)?.id;
    let probs_obj = value.get("probabilities")?.as_object()?;
    let mut probabilities = Vec::with_capacity(options.len());
    for option in options {
        probabilities.push(finite_unit(probs_obj.get(option.id))?);
    }
    Some((choice, probabilities))
}

#[cfg(test)]
mod tests {
    use super::{map_answers, CriterionView};
    use serde_json::{Map, Value};

    fn assert_close(got: f64, expected: f64) {
        assert!((got - expected).abs() < 1e-9, "{got} != {expected}");
    }

    #[test]
    fn maps_fixture_gateway_answers() {
        let json = r#"{
            "positivity": {"type":"boolean","probability":0.82},
            "intensity": {
                "type":"score",
                "score":1.4,
                "probabilities":{"0":0.1,"1":0.5,"2":0.3,"3":0.1}
            },
            "stance": {
                "type":"choice",
                "choice":"joke",
                "probabilities":{"joke":0.7,"serious":0.3}
            }
        }"#;
        let answers: Map<String, Value> = serde_json::from_str(json).unwrap();
        let views = map_answers(&answers).unwrap();
        assert_eq!(views.len(), 3);

        match &views[0] {
            CriterionView::Boolean {
                id,
                label,
                probability,
                confidence,
            } => {
                assert_eq!(*id, "positivity");
                assert_eq!(*label, "前向きさ");
                assert_close(*probability, 0.82);
                assert_close(*confidence, 0.64);
            }
            other => panic!("expected boolean, got {other:?}"),
        }

        match &views[1] {
            CriterionView::Score {
                id,
                label,
                score,
                levels,
                probabilities,
                ..
            } => {
                assert_eq!(*id, "intensity");
                assert_eq!(*label, "強度");
                assert_close(*score, 1.4);
                assert_eq!(*levels, ["穏やか", "はっきり", "強い", "激しい"]);
                assert_eq!(probabilities.len(), 4);
                assert_close(probabilities[0], 0.1);
                assert_close(probabilities[1], 0.5);
                assert_close(probabilities[2], 0.3);
                assert_close(probabilities[3], 0.1);
            }
            other => panic!("expected score, got {other:?}"),
        }

        match &views[2] {
            CriterionView::Choice {
                id,
                label,
                choice,
                options,
                ..
            } => {
                assert_eq!(*id, "stance");
                assert_eq!(*label, "ネタ本気");
                assert_eq!(*choice, "joke");
                assert_eq!(options.len(), 2);
                assert_eq!(options[0].id, "joke");
                assert_eq!(options[0].label, "ネタ");
                assert_close(options[0].probability, 0.7);
                assert_eq!(options[1].id, "serious");
                assert_eq!(options[1].label, "本気");
                assert_close(options[1].probability, 0.3);
            }
            other => panic!("expected choice, got {other:?}"),
        }
    }
}
