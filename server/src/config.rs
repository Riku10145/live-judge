use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    pub addr: SocketAddr,
    pub api_key: Option<String>,
    pub model: String,
    pub gateway_base_url: String,
    pub web_dist: PathBuf,
    pub timeout: Duration,
}

impl Config {
    pub fn from_env() -> Self {
        let api_key = env::var("AI_GATEWAY_API_KEY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let addr = env::var("LIVE_JUDGE_ADDR")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 8787)));

        let timeout_ms = env::var("JEV_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(15_000);

        Self {
            addr,
            api_key,
            model: env::var("JEV_MODEL").unwrap_or_else(|_| "typesafe-ai/jev".to_string()),
            gateway_base_url: env::var("AI_GATEWAY_BASE_URL")
                .unwrap_or_else(|_| "https://ai-gateway.vercel.sh".to_string())
                .trim_end_matches('/')
                .to_string(),
            web_dist: resolve_web_dist(env::var("WEB_DIST").ok()),
            timeout: Duration::from_millis(timeout_ms),
        }
    }

    pub fn is_demo(&self) -> bool {
        self.api_key.is_none()
    }

    pub fn web_dist_exists(&self) -> bool {
        self.web_dist.is_dir()
    }
}

fn crate_web_dist() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/dist")
}

fn resolve_web_dist(raw: Option<String>) -> PathBuf {
    let preferred = raw
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(crate_web_dist);
    if preferred.is_dir() {
        return preferred;
    }
    let from_crate = crate_web_dist();
    if from_crate.is_dir() {
        return from_crate;
    }
    preferred
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_named_path_falls_back_to_the_crate_relative_build() {
        let resolved = resolve_web_dist(Some("web/dist".into()));
        if PathBuf::from("web/dist").is_dir() {
            assert_eq!(resolved, PathBuf::from("web/dist"));
        } else {
            assert_eq!(resolved, crate_web_dist());
        }
    }

    #[test]
    fn an_existing_named_path_wins() {
        let dir = std::env::temp_dir().join(format!("live-judge-web-dist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let resolved = resolve_web_dist(Some(dir.to_string_lossy().into_owned()));
        assert_eq!(resolved, dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blank_env_is_treated_as_unset() {
        let resolved = resolve_web_dist(Some("   ".into()));
        assert_eq!(resolved, resolve_web_dist(None));
    }
}
