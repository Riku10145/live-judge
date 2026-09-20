use std::time::Duration;

use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::criteria;

#[derive(Clone)]
pub struct GatewayClient {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
}

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("evaluation gateway is unreachable")]
    Unreachable,
    #[error("{0}")]
    Http(String),
    #[error("{0}")]
    InvalidResponse(String),
}

#[derive(Deserialize)]
struct EvaluateBody {
    answers: Map<String, Value>,
}

#[derive(Deserialize)]
struct GatewayErrorEnvelope {
    error: GatewayErrorFields,
}

#[derive(Deserialize)]
struct GatewayErrorFields {
    message: String,
}

impl GatewayClient {
    pub fn new(base_url: String, api_key: String) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(5))
            .build()?;
        Ok(Self {
            client,
            base_url,
            api_key,
        })
    }

    pub async fn evaluate(&self, text: &str) -> Result<Map<String, Value>, GatewayError> {
        let url = format!("{}/v1/evaluate", self.base_url);
        let response = self
            .client
            .post(url)
            .bearer_auth(&self.api_key)
            .json(&json!({
                "model": "typesafe-ai/jev",
                "state": text,
                "questions": criteria::build_questions(),
            }))
            .send()
            .await
            .map_err(|_| GatewayError::Unreachable)?;

        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| GatewayError::Unreachable)?;

        if !status.is_success() {
            return Err(GatewayError::Http(http_error_message(status, &bytes)));
        }

        parse_answers(&bytes)
    }
}

pub fn parse_answers(bytes: &[u8]) -> Result<Map<String, Value>, GatewayError> {
    let body: EvaluateBody = serde_json::from_slice(bytes).map_err(|_| {
        GatewayError::InvalidResponse("evaluation response is not JSON with answers".into())
    })?;
    Ok(body.answers)
}

pub fn answers_from_value(value: &Value) -> Result<Map<String, Value>, GatewayError> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        GatewayError::InvalidResponse("failed to serialize evaluate payload".into())
    })?;
    parse_answers(&bytes)
}

fn http_error_message(status: StatusCode, bytes: &[u8]) -> String {
    if let Ok(envelope) = serde_json::from_slice::<GatewayErrorEnvelope>(bytes) {
        envelope.error.message
    } else {
        format!("evaluation gateway HTTP {status}")
    }
}
