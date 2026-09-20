mod config;
mod criteria;
mod demo;
mod jev;
mod routes;
mod verdict;

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use config::Config;
use routes::AppState;

#[tokio::main]
async fn main() {
    let _ = dotenvy::from_filename(".env");
    let _ = dotenvy::from_filename("../.env");

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "live_judge_server=info,tower_http=warn".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env();
    if config.is_demo() {
        tracing::info!("mode=demo (AI_GATEWAY_API_KEY is unset)");
    } else {
        tracing::info!(gateway = %config.gateway_base_url, "mode=live");
    }

    let client = if config.is_demo() {
        None
    } else {
        match jev::Client::new(&config) {
            Ok(client) => Some(client),
            Err(err) => {
                tracing::error!("failed to build the gateway client: {err}");
                None
            }
        }
    };

    let mut app = Router::new()
        .route("/api/criteria", get(routes::criteria))
        .route("/api/judge", post(routes::judge))
        .with_state(Arc::new(AppState { client }))
        .layer(TraceLayer::new_for_http());

    if config.web_dist_exists() {
        tracing::info!(path = %config.web_dist.display(), "serving the frontend");
        let index = config.web_dist.join("index.html");
        let files = ServeDir::new(&config.web_dist).fallback(ServeFile::new(index));
        app = app.fallback_service(files);
    } else {
        tracing::info!("WEB_DIST is missing; serving the API only");
    }

    let listener = tokio::net::TcpListener::bind(config.addr)
        .await
        .unwrap_or_else(|err| panic!("failed to bind {}: {err}", config.addr));
    tracing::info!(addr = %config.addr, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await
        .expect("server exited");
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
