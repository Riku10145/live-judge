use std::collections::BTreeMap;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::config::Config;
use crate::criteria::{self, Criterion, Prompt, CRITERIA};
use crate::verdict::{self, Answer, Verdict};

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("the evaluation request timed out")]
    Timeout,
    #[error("the gateway rejected the API key")]
    Auth,
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Malformed(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Debug)]
pub struct Evaluation {
    pub model: String,
    pub usage: Option<Usage>,
    pub verdicts: BTreeMap<String, Verdict>,
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    evaluate_url: String,
    api_key: String,
    model: String,
}

impl Client {
    pub fn new(config: &Config) -> Result<Self, GatewayError> {
        let api_key = config
            .api_key
            .clone()
            .ok_or_else(|| GatewayError::Unavailable("AI_GATEWAY_API_KEY is unset".into()))?;
        let http = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .map_err(|err| GatewayError::Unavailable(err.to_string()))?;
        Ok(Self {
            http,
            evaluate_url: format!("{}/v1/evaluate", config.gateway_base_url),
            api_key,
            model: config.model.clone(),
        })
    }

    pub async fn evaluate(&self, text: &str) -> Result<Evaluation, GatewayError> {
        let body = json!({
            "model": self.model,
            "state": text,
            "questions": questions_from_registry(),
        });

        let response = self
            .http
            .post(&self.evaluate_url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(map_transport)?;

        let status = response.status();
        let bytes = response.bytes().await.map_err(map_transport)?;

        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(GatewayError::Auth);
        }
        if !status.is_success() {
            return Err(GatewayError::Unavailable(format!(
                "gateway returned {status}"
            )));
        }

        parse_evaluation(&bytes, &self.model)
    }
}

fn map_transport(err: reqwest::Error) -> GatewayError {
    if err.is_timeout() {
        GatewayError::Timeout
    } else {
        GatewayError::Unavailable(err.without_url().to_string())
    }
}

fn questions_from_registry() -> Map<String, Value> {
    let mut questions = Map::new();
    for criterion in CRITERIA {
        questions.insert(criterion.id.to_string(), question_body(criterion));
    }
    questions
}

fn question_body(criterion: &Criterion) -> Value {
    match &criterion.prompt {
        Prompt::Boolean {
            instructions,
            true_criteria,
            false_criteria,
            ..
        } => json!({
            "type": "boolean",
            "instructions": instructions,
            "criteria": { "true": true_criteria, "false": false_criteria },
        }),
        Prompt::Score {
            instructions,
            levels,
        } => json!({
            "type": "score",
            "instructions": instructions,
            "criteria": levels.iter().map(|level| level.criteria).collect::<Vec<_>>(),
        }),
        Prompt::Choice {
            instructions,
            options,
        } => {
            let mut criteria = Map::new();
            for option in *options {
                criteria.insert(
                    option.key.to_string(),
                    Value::String(option.criteria.to_string()),
                );
            }
            json!({
                "type": "choice",
                "instructions": instructions,
                "criteria": criteria,
            })
        }
    }
}

#[derive(Deserialize)]
struct RawEvaluation {
    model: Option<String>,
    answers: BTreeMap<String, Answer>,
    usage: Option<RawUsage>,
    #[serde(default, rename = "providerMetadata", alias = "provider_metadata")]
    provider_metadata: Option<RawProviderMetadata>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawUsage {
    #[serde(default, alias = "input_tokens")]
    input_tokens: Option<u32>,
    #[serde(default, alias = "output_tokens")]
    output_tokens: Option<u32>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawProviderMetadata {
    #[serde(default)]
    typesafe: Option<RawTypesafe>,
}

#[derive(Deserialize, Default)]
struct RawTypesafe {
    #[serde(default)]
    confidence: BTreeMap<String, f64>,
}

pub fn parse_evaluation(bytes: &[u8], fallback_model: &str) -> Result<Evaluation, GatewayError> {
    let raw: RawEvaluation = serde_json::from_slice(bytes).map_err(|err| {
        GatewayError::Malformed(format!(
            "gateway response was not a valid evaluation: {err}"
        ))
    })?;

    let confidence = raw
        .provider_metadata
        .and_then(|meta| meta.typesafe)
        .map(|typesafe| typesafe.confidence)
        .unwrap_or_default();

    let mut verdicts = BTreeMap::new();
    for (id, answer) in &raw.answers {
        let Some(criterion) = criteria::find(id) else {
            continue;
        };
        let provider_confidence = confidence.get(id).copied();
        let verdict =
            verdict::to_verdict(criterion, answer, provider_confidence).map_err(|mismatch| {
                GatewayError::Malformed(format!(
                    "{}: expected {}, got {}",
                    mismatch.criterion, mismatch.expected, mismatch.found
                ))
            })?;
        verdicts.insert(id.clone(), verdict);
    }

    Ok(Evaluation {
        model: raw.model.unwrap_or_else(|| fallback_model.to_string()),
        usage: raw.usage.and_then(|usage| {
            Some(Usage {
                input_tokens: usage.input_tokens?,
                output_tokens: usage.output_tokens.unwrap_or(0),
            })
        }),
        verdicts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GATEWAY_JSON: &str = r#"{
        "model": "typesafe-ai/jev",
        "answers": {
            "positivity": { "type": "boolean", "probability": 0.98 },
            "intensity":  { "type": "score", "score": 2.86,
                            "probabilities": { "0": 0, "1": 0.02, "2": 0.1, "3": 0.88 } },
            "register":   { "type": "choice", "choice": "honki",
                            "probabilities": { "neta": 0.12, "honki": 0.88 } }
        },
        "usage": { "inputTokens": 275, "outputTokens": 20 },
        "providerMetadata": {
            "gateway": { "cost": "0.00001155", "generationId": "gen_..." },
            "typesafe": { "confidence": { "intensity": 0.91, "register": 0.47 } }
        }
    }"#;

    fn approx(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn a_full_gateway_response_becomes_three_typed_verdicts() {
        let evaluation = parse_evaluation(GATEWAY_JSON.as_bytes(), "fallback").unwrap();
        assert_eq!(evaluation.model, "typesafe-ai/jev");
        assert_eq!(evaluation.usage.as_ref().unwrap().input_tokens, 275);

        match &evaluation.verdicts["positivity"] {
            Verdict::Boolean { probability, .. } => approx(*probability, 0.98),
            other => panic!("expected boolean, got {other:?}"),
        }

        match &evaluation.verdicts["intensity"] {
            Verdict::Score {
                score,
                distribution,
                certainty,
            } => {
                approx(*score, 2.86);
                assert_eq!(distribution.as_deref(), Some(&[0.0, 0.02, 0.1, 0.88][..]));
                approx(*certainty, 0.91);
            }
            other => panic!("expected score, got {other:?}"),
        }

        match &evaluation.verdicts["register"] {
            Verdict::Choice {
                choice, certainty, ..
            } => {
                assert_eq!(choice, "honki");
                approx(*certainty, 0.47);
            }
            other => panic!("expected choice, got {other:?}"),
        }
    }

    #[test]
    fn a_type_mismatch_is_malformed() {
        let json = r#"{
            "answers": { "positivity": { "type": "score", "score": 1.0 } }
        }"#;
        match parse_evaluation(json.as_bytes(), "fallback") {
            Err(GatewayError::Malformed(message)) => {
                assert!(message.contains("positivity"), "{message}");
                assert!(message.contains("boolean"), "{message}");
            }
            other => panic!("expected malformed, got {other:?}"),
        }
    }

    #[test]
    fn unknown_criterion_ids_are_ignored() {
        let json = r#"{
            "answers": {
                "positivity": { "type": "boolean", "probability": 0.2 },
                "mystery": { "type": "boolean", "probability": 0.9 }
            }
        }"#;
        let evaluation = parse_evaluation(json.as_bytes(), "fallback").unwrap();
        assert!(evaluation.verdicts.contains_key("positivity"));
        assert!(!evaluation.verdicts.contains_key("mystery"));
        assert!(!evaluation.verdicts.contains_key("intensity"));
    }

    #[test]
    fn questions_cover_the_whole_registry() {
        let questions = questions_from_registry();
        assert_eq!(questions.len(), CRITERIA.len());
        assert_eq!(questions["positivity"]["type"], "boolean");
        assert_eq!(questions["intensity"]["type"], "score");
        assert_eq!(questions["register"]["type"], "choice");
        assert!(questions["positivity"]["criteria"]["true"].is_string());
        assert!(questions["intensity"]["criteria"].as_array().unwrap().len() == 4);
        assert!(questions["register"]["criteria"]["neta"].is_string());
    }
}
