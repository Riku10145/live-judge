mod confidence;
mod criteria;
mod demo;
mod gateway;
mod http;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use http::Source;

struct Config {
    addr: SocketAddr,
    static_dir: Option<PathBuf>,
    source: Source,
}

impl Config {
    fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let port = match std::env::var("PORT") {
            Ok(value) if !value.is_empty() => value.parse::<u16>()?,
            _ => 8080,
        };
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port);

        let force_demo = std::env::var("LIVE_JUDGE_DEMO")
            .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        let api_key = std::env::var("AI_GATEWAY_API_KEY")
            .ok()
            .filter(|value| !value.is_empty());

        let source = if force_demo {
            Source::Demo
        } else if let Some(api_key) = api_key {
            let base_url = std::env::var("AI_GATEWAY_URL")
                .ok()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "https://ai-gateway.vercel.sh".to_string());
            let base_url = base_url.trim_end_matches('/').to_string();
            Source::Live(gateway::GatewayClient::new(base_url, api_key)?)
        } else {
            Source::Demo
        };

        let static_dir = std::env::var("STATIC_DIR")
            .ok()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_dir());

        Ok(Self {
            addr,
            static_dir,
            source,
        })
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(err) => {
            tracing::error!("config: {err}");
            std::process::exit(1);
        }
    };

    let app = http::router(config.source, config.static_dir);
    let listener = match tokio::net::TcpListener::bind(config.addr).await {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("bind {}: {err}", config.addr);
            std::process::exit(1);
        }
    };
    tracing::info!("listening on {}", config.addr);

    if let Err(err) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        tracing::error!("server: {err}");
        std::process::exit(1);
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
