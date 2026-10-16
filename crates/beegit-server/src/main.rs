//! `beegit-server` binary: load the config, connect CockroachDB and S3, serve (SPEC 3.1, 6.1;
//! P23).
//!
//! Usage: `beegit-server [--config] <beegit-server.toml>` (default `/etc/beegit/beegit-server.toml`,
//! or `$BEEGIT_SERVER_CONFIG`). Startup fails on an invalid config, an invalid or missing policy
//! file, unreadable signing keys or TLS material, or unreachable backends (SPEC 6, 6.2).

use anyhow::Context as _;
use beegit_config::{ProcessEnv, load_server};
use beegit_core::{FaultRegistry, SystemClock};
use beegit_server::{ServerApp, ServerDeps};
use std::path::PathBuf;
use std::sync::Arc;

const DEFAULT_CONFIG: &str = "/etc/beegit/beegit-server.toml";

fn config_path() -> anyhow::Result<PathBuf> {
    let mut args = std::env::args().skip(1);
    match (args.next(), args.next()) {
        (None, _) => Ok(std::env::var_os("BEEGIT_SERVER_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG))),
        (Some(flag), Some(p)) if flag == "--config" || flag == "-c" => Ok(PathBuf::from(p)),
        (Some(flag), None) if flag == "--help" || flag == "-h" => {
            anyhow::bail!("usage: beegit-server [--config] <beegit-server.toml>")
        }
        (Some(p), None) if !p.starts_with('-') => Ok(PathBuf::from(p)),
        _ => anyhow::bail!("usage: beegit-server [--config] <beegit-server.toml>"),
    }
}

fn main() -> anyhow::Result<()> {
    let path = config_path()?;
    let config =
        load_server(&path, &ProcessEnv).with_context(|| format!("loading {}", path.display()))?;
    let format = if config.observability.log_format == "text" {
        beegit_obs::LogFormat::Text
    } else {
        beegit_obs::LogFormat::Json
    };
    let _logs = beegit_obs::init_logging(format);
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("starting the tokio runtime")?
        .block_on(run(config))
}

async fn run(config: beegit_config::ServerConfig) -> anyhow::Result<()> {
    let policy = beegit_policy::PolicyHandle::load(&config.policy.path)
        .with_context(|| format!("loading policy {}", config.policy.path.display()))?;
    let keyring = beegit_auth::Keyring::from_files(&config.auth.signing_keys)
        .context("loading signing keys")?;
    let (cert, key) = beegit_server_tls(&config)?;

    let meta = beegit_store_crdb::CrdbMetaStore::connect(beegit_store_crdb::CrdbConfig {
        url: config.metadata.url.clone(),
        max_connections: config.metadata.max_connections,
        repo_name: config.server.repo.clone(),
        tls: None,
    })
    .await
    .context("connecting to the metadata store")?;
    meta.migrate()
        .await
        .context("migrating the metadata store")?;
    let blobs = beegit_store_s3::S3BlobStore::new(beegit_store_s3::S3Config {
        endpoint: config.objects.endpoint.clone(),
        bucket: config.objects.bucket.clone(),
        region: config.objects.region.clone(),
        access_key: None,
        secret_key: None,
        allow_http: config.objects.endpoint.starts_with("http://"),
        path_style: config.objects.path_style,
        key_prefix: String::new(),
    })
    .context("configuring the object store")?;
    let storage = beegit_store::Storage::new(Arc::new(meta), Arc::new(blobs), FaultRegistry::new());

    let listen = config.server.listen;
    let app = ServerApp::build(ServerDeps {
        storage,
        github: beegit_auth::GitHubClient::new(&config.auth.github_api_url),
        config,
        policy,
        keyring,
        clock: Arc::new(SystemClock),
        metrics: beegit_obs::Metrics::new(),
        registry: None,
    })
    .await
    .context("building the server")?;
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .with_context(|| format!("binding {listen}"))?;
    let handle = app
        .serve(listener, Some((cert, key)))
        .await
        .context("serving")?;
    tracing::info!(addr = %handle.addr, admin = ?handle.admin_addr, "beegit-server started");
    shutdown_signal().await;
    tracing::info!("shutting down");
    handle.shutdown().await;
    Ok(())
}

fn beegit_server_tls(config: &beegit_config::ServerConfig) -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    let read = |p: &std::path::Path| {
        std::fs::read(p).with_context(|| format!("reading TLS file {}", p.display()))
    };
    Ok((
        read(&config.server.tls_cert)?,
        read(&config.server.tls_key)?,
    ))
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
