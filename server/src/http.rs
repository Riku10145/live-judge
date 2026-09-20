use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

use crate::criteria::{self, CriterionView, MapError};
use crate::demo;
use crate::gateway::{self, GatewayClient, GatewayError};

const MAX_TEXT_CHARS: usize = 4000;

#[derive(Clone)]
pub enum Source {
    Demo,
    Live(GatewayClient),
}

#[derive(Clone)]
struct AppState {
    source: Source,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Serialize)]
struct JudgeResponse {
    source: &'static str,
    criteria: Vec<CriterionView>,
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn empty_text() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "empty_text",
            "text is missing or empty",
        )
    }

    fn text_too_long() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "text_too_long",
            "text exceeds 4000 characters",
        )
    }

    fn invalid_json() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            "body must be JSON with a string text field",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({
            "error": {
                "code": self.code,
                "message": self.message,
            }
        });
        (self.status, Json(body)).into_response()
    }
}

impl From<GatewayError> for ApiError {
    fn from(err: GatewayError) -> Self {
        match err {
            GatewayError::Unreachable => Self::new(
                StatusCode::BAD_GATEWAY,
                "gateway_unreachable",
                err.to_string(),
            ),
            GatewayError::Http(message) => {
                Self::new(StatusCode::BAD_GATEWAY, "gateway_error", message)
            }
            GatewayError::InvalidResponse(message) => {
                Self::new(StatusCode::BAD_GATEWAY, "invalid_gateway_response", message)
            }
        }
    }
}

impl From<MapError> for ApiError {
    fn from(err: MapError) -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "invalid_gateway_response",
            err.to_string(),
        )
    }
}

pub fn router(source: Source, static_dir: Option<PathBuf>) -> Router {
    let state = AppState { source };
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/criteria", get(criteria_handler))
        .route("/api/judge", post(judge_handler))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    match static_dir {
        Some(dir) => app.fallback_service(ServeDir::new(dir)),
        None => app,
    }
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn criteria_handler() -> Json<criteria::CriteriaResponse> {
    Json(criteria::metadata())
}

async fn judge_handler(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<JudgeResponse>, ApiError> {
    let text = parse_text(&body)?;
    let (label, answers) = match &state.source {
        Source::Demo => {
            let value = demo::evaluate_response(&text);
            ("demo", gateway::answers_from_value(&value)?)
        }
        Source::Live(client) => ("live", client.evaluate(&text).await?),
    };
    Ok(Json(JudgeResponse {
        source: label,
        criteria: criteria::map_answers(&answers)?,
    }))
}

fn parse_text(body: &[u8]) -> Result<String, ApiError> {
    let mut value: Value = serde_json::from_slice(body).map_err(|_| ApiError::invalid_json())?;
    let object = value.as_object_mut().ok_or_else(ApiError::invalid_json)?;
    let text = match object.remove("text") {
        None => return Err(ApiError::empty_text()),
        Some(Value::String(text)) => text,
        Some(_) => return Err(ApiError::invalid_json()),
    };
    if text.trim().is_empty() {
        return Err(ApiError::empty_text());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(ApiError::text_too_long());
    }
    Ok(text)
}
