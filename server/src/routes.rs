use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::criteria::CRITERIA;
use crate::demo;
use crate::jev::{Client, Evaluation, GatewayError, Usage};
use crate::verdict::Verdict;

pub struct AppState {
    pub client: Option<Client>,
}

#[derive(Deserialize)]
pub struct JudgeRequest {
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgeResponse {
    source: &'static str,
    model: String,
    elapsed_ms: u128,
    usage: Option<Usage>,
    verdicts: BTreeMap<String, Verdict>,
}

#[derive(Serialize)]
struct CriteriaResponse {
    criteria: &'static [crate::criteria::Criterion],
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    kind: &'static str,
    message: String,
}

pub async fn criteria() -> impl IntoResponse {
    Json(CriteriaResponse { criteria: CRITERIA })
}

pub async fn judge(State(state): State<Arc<AppState>>, Json(body): Json<JudgeRequest>) -> Response {
    let started = Instant::now();
    let text = body.text.trim();
    if text.is_empty() {
        return error(StatusCode::BAD_REQUEST, "empty_text", "text is empty");
    }
    if text.chars().count() > 2000 {
        return error(
            StatusCode::BAD_REQUEST,
            "text_too_long",
            "text exceeds 2000 characters",
        );
    }

    let result = if let Some(client) = &state.client {
        match client.evaluate(text).await {
            Ok(evaluation) => Ok(live_response(evaluation, started)),
            Err(err) => Err(err),
        }
    } else {
        let verdicts = demo::judge(text);
        Ok(JudgeResponse {
            source: "demo",
            model: "demo".to_string(),
            elapsed_ms: elapsed_ms(started),
            usage: None,
            verdicts,
        })
    };

    match result {
        Ok(payload) => Json(payload).into_response(),
        Err(err) => map_gateway_error(err),
    }
}

fn live_response(evaluation: Evaluation, started: Instant) -> JudgeResponse {
    JudgeResponse {
        source: "live",
        model: evaluation.model,
        elapsed_ms: elapsed_ms(started),
        usage: evaluation.usage,
        verdicts: evaluation.verdicts,
    }
}

fn map_gateway_error(err: GatewayError) -> Response {
    match err {
        GatewayError::Timeout => error(StatusCode::GATEWAY_TIMEOUT, "timeout", err.to_string()),
        GatewayError::Auth => error(StatusCode::BAD_GATEWAY, "gateway_auth", err.to_string()),
        GatewayError::Unavailable(message) => {
            error(StatusCode::BAD_GATEWAY, "gateway_unavailable", message)
        }
        GatewayError::Malformed(message) => {
            error(StatusCode::BAD_GATEWAY, "gateway_malformed", message)
        }
    }
}

fn error(status: StatusCode, kind: &'static str, message: impl Into<String>) -> Response {
    (
        status,
        Json(ErrorBody {
            error: ErrorDetail {
                kind,
                message: message.into(),
            },
        }),
    )
        .into_response()
}

fn elapsed_ms(started: Instant) -> u128 {
    started.elapsed().as_millis().max(1)
}
