use std::{path::PathBuf, sync::Arc};

use anyhow::{Result, bail};
use reqwest::{Client, Proxy, Url};
use serde::Deserialize;
use serde::Serialize;
use tokio::sync::RwLock;

use crate::{QuarkBackend, QuarkOpenClient, config};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct QuarkOpenConfig {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) app_id: String,
    pub(crate) sign_key: String,
    pub(crate) refresh_url: String,
    #[serde(default)]
    pub(crate) root_fid: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GithubReleasesConfig {
    pub(crate) repo: String,
    pub(crate) token: Option<String>,
    pub(crate) proxy: Option<String>,
    pub(crate) show_source_code: bool,
    pub(crate) asset_allow: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(crate) struct S3Config {
    pub(crate) endpoint: String,
    pub(crate) bucket: String,
    pub(crate) region: String,
    pub(crate) access_key: String,
    pub(crate) secret_key: String,
    pub(crate) session_token: Option<String>,
    pub(crate) path_style: bool,
    pub(crate) proxy: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum ResolvedMount {
    QuarkOpen {
        remote_key: String,
        config: QuarkOpenConfig,
        mount_path: String,
    },
    SystemConfig {
        virtual_path: String,
    },
    UrlTree {
        url: String,
        proxy: Option<String>,
        size: Option<u64>,
    },
    GithubReleases {
        rest: String,
        config: GithubReleasesConfig,
    },
    S3 {
        remote_key: String,
        config: S3Config,
    },
}

pub(crate) fn quark_open_client(
    config: QuarkOpenConfig,
    mount_path: &str,
    db_path: PathBuf,
    service_config: Arc<RwLock<config::ServiceConfig>>,
) -> Result<QuarkOpenClient> {
    if config.refresh_token.trim().is_empty() {
        bail!("quark_open mount {mount_path} needs options.refresh_token");
    }
    let http = Client::builder()
        .user_agent("atree/quark-open")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()?;
    Ok(QuarkOpenClient {
        http,
        config: std::sync::Arc::new(tokio::sync::Mutex::new(config)),
        db_path,
        service_config,
        mount_path: mount_path.to_string(),
    })
}

pub(crate) fn github_client(config: &GithubReleasesConfig) -> Result<Client> {
    let mut builder = Client::builder()
        .user_agent("atree/github-releases")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(120));
    if let Some(proxy_url) = config.proxy.as_deref() {
        builder = builder.proxy(Proxy::all(proxy_url)?);
    } else {
        builder = builder.no_proxy();
    }
    Ok(builder.build()?)
}

#[cfg(test)]
pub(crate) fn resolve_remote_key(
    config: &config::ServiceConfig,
    virtual_path: &str,
) -> Option<String> {
    match resolve_mount(config, virtual_path)? {
        ResolvedMount::QuarkOpen { remote_key, .. } => Some(remote_key),
        _ => None,
    }
}

pub(crate) fn resolve_mount(
    config: &config::ServiceConfig,
    virtual_path: &str,
) -> Option<ResolvedMount> {
    let path = normalize_virtual_path(virtual_path);
    let mount = config
        .mounts
        .iter()
        .rev()
        .find(|mount| mount_matches_for_type(mount, &path))?;
    match mount.mount_type.as_str() {
        "quark_open" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            Some(ResolvedMount::QuarkOpen {
                remote_key: join_remote_path(config::mount_root_path(mount), rest),
                config: quark_open_config_from_mount(mount)?,
                mount_path: mount.mount_path.clone(),
            })
        }
        "system_config" => Some(ResolvedMount::SystemConfig {
            virtual_path: path.to_string(),
        }),
        "url_tree" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            Some(ResolvedMount::UrlTree {
                url: join_url_path(config::mount_root_path(mount), rest)?,
                proxy: mount_option_string(&mount.options, "proxy"),
                size: mount_option_u64(&mount.options, "size"),
            })
        }
        "github_releases" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            Some(ResolvedMount::GithubReleases {
                rest: rest.to_string(),
                config: github_releases_config_from_mount(mount)?,
            })
        }
        "s3" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            Some(ResolvedMount::S3 {
                remote_key: join_remote_path(config::mount_root_path(mount), rest),
                config: s3_config_from_mount(mount)?,
            })
        }
        _ => None,
    }
}

pub(crate) fn resolve_github_release_mounts(
    config: &config::ServiceConfig,
    virtual_path: &str,
) -> Vec<(String, GithubReleasesConfig)> {
    let path = normalize_virtual_path(virtual_path);
    let matches = config
        .mounts
        .iter()
        .filter(|mount| {
            mount.mount_type == "github_releases" && mount_matches(&mount.mount_path, &path)
        })
        .collect::<Vec<_>>();
    let Some(best_len) = matches
        .iter()
        .map(|mount| normalize_virtual_path(&mount.mount_path).len())
        .max()
    else {
        return Vec::new();
    };
    matches
        .into_iter()
        .filter(|mount| normalize_virtual_path(&mount.mount_path).len() == best_len)
        .filter_map(|mount| {
            Some((
                strip_mount_path(&mount.mount_path, &path).to_string(),
                github_releases_config_from_mount(mount)?,
            ))
        })
        .collect()
}

pub(crate) fn backend_from_mount(
    db_path: PathBuf,
    service_config: Arc<RwLock<config::ServiceConfig>>,
    mount: ResolvedMount,
) -> Option<(String, QuarkBackend)> {
    match mount {
        ResolvedMount::QuarkOpen {
            remote_key,
            config,
            mount_path,
        } => Some((
            remote_key,
            QuarkBackend::Open(
                quark_open_client(config, &mount_path, db_path, service_config).ok()?,
            ),
        )),
        _ => None,
    }
}

fn mount_option_string(options: &serde_json::Value, key: &str) -> Option<String> {
    options
        .get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
}

fn mount_option_bool(options: &serde_json::Value, key: &str) -> bool {
    options
        .get(key)
        .and_then(|value| {
            value.as_bool().or_else(|| {
                value
                    .as_str()
                    .map(|value| matches!(value, "true" | "yes" | "1"))
            })
        })
        .unwrap_or(false)
}

pub(crate) fn mount_option_u64(options: &serde_json::Value, key: &str) -> Option<u64> {
    options
        .get(key)
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
}

fn mount_option_string_list(options: &serde_json::Value, key: &str) -> Vec<String> {
    match options.get(key) {
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .filter_map(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(ToString::to_string)
            .collect(),
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => value
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn github_releases_config_from_mount(mount: &config::MountConfig) -> Option<GithubReleasesConfig> {
    let repo = mount_option_string(&mount.options, "repo").or_else(|| {
        let root = config::mount_root_path(mount).trim().trim_matches('/');
        (!root.is_empty()).then(|| root.to_string())
    })?;

    Some(GithubReleasesConfig {
        repo,
        token: mount_option_string(&mount.options, "token"),
        proxy: mount_option_string(&mount.options, "proxy"),
        show_source_code: mount_option_bool(&mount.options, "show_source_code"),
        asset_allow: mount_option_string_list(&mount.options, "asset_allow"),
    })
}

fn s3_config_from_mount(mount: &config::MountConfig) -> Option<S3Config> {
    Some(S3Config {
        endpoint: mount_option_string(&mount.options, "endpoint")?,
        bucket: mount_option_string(&mount.options, "bucket")?,
        region: mount_option_string(&mount.options, "region")
            .unwrap_or_else(|| "us-east-1".to_string()),
        access_key: mount_option_string(&mount.options, "access_key")
            .or_else(|| mount_option_string(&mount.options, "access_key_id"))?,
        secret_key: mount_option_string(&mount.options, "secret_key")
            .or_else(|| mount_option_string(&mount.options, "secret_access_key"))?,
        session_token: mount_option_string(&mount.options, "session_token"),
        path_style: mount
            .options
            .get("path_style")
            .or_else(|| mount.options.get("force_path_style"))
            .and_then(|value| {
                value.as_bool().or_else(|| {
                    value
                        .as_str()
                        .map(|value| matches!(value, "true" | "yes" | "1"))
                })
            })
            .unwrap_or(true),
        proxy: mount_option_string(&mount.options, "proxy"),
    })
}

fn quark_open_config_from_mount(mount: &config::MountConfig) -> Option<QuarkOpenConfig> {
    Some(QuarkOpenConfig {
        access_token: mount_option_string(&mount.options, "access_token").unwrap_or_default(),
        refresh_token: mount_option_string(&mount.options, "refresh_token")?,
        app_id: mount_option_string(&mount.options, "app_id").unwrap_or_default(),
        sign_key: mount_option_string(&mount.options, "sign_key").unwrap_or_default(),
        refresh_url: mount_option_string(&mount.options, "refresh_url")
            .unwrap_or_else(|| "https://api.oplist.org/quarkyun/renewapi".to_string()),
        root_fid: mount_option_string(&mount.options, "root_fid")
            .unwrap_or_else(|| "0".to_string()),
    })
}

pub(crate) fn is_fnnas_quark_refresh_url(refresh_url: &str) -> bool {
    let Ok(url) = Url::parse(refresh_url) else {
        return false;
    };
    matches!(url.host_str(), Some("oauth.fnnas.com")) && url.path() == "/api/v1/oauth/refreshToken"
}

fn mount_matches_for_type(mount: &config::MountConfig, path: &str) -> bool {
    if mount.mount_type == "system_config" {
        return normalize_virtual_path(&mount.mount_path) == path;
    }
    mount_matches(&mount.mount_path, path)
}

fn mount_matches(mount_path: &str, path: &str) -> bool {
    let mount_path = normalize_virtual_path(mount_path);
    if mount_path == "/" {
        return true;
    }
    path == mount_path || path.starts_with(&format!("{mount_path}/"))
}

fn strip_mount_path<'a>(mount_path: &str, path: &'a str) -> &'a str {
    let mount_path = normalize_virtual_path(mount_path);
    if mount_path == "/" {
        return path.trim_start_matches('/');
    }
    path.strip_prefix(&mount_path)
        .unwrap_or("")
        .trim_start_matches('/')
}

fn join_remote_path(root_path: &str, rest: &str) -> String {
    let root = root_path.trim_matches('/');
    let rest = rest.trim_matches('/');
    match (root.is_empty(), rest.is_empty()) {
        (true, true) => String::new(),
        (true, false) => rest.to_string(),
        (false, true) => root.to_string(),
        (false, false) => format!("{root}/{rest}"),
    }
}

fn join_url_path(root_url: &str, rest: &str) -> Option<String> {
    let mut url = Url::parse(root_url).ok()?;
    if !rest.trim_matches('/').is_empty() {
        let mut path = url.path().trim_end_matches('/').to_string();
        for segment in rest.trim_matches('/').split('/') {
            path.push('/');
            path.push_str(segment);
        }
        url.set_path(&path);
    }
    Some(url.to_string())
}

pub(crate) fn normalize_virtual_path(path: &str) -> String {
    let path = format!("/{}", path.trim_matches('/'));
    if path == "/" {
        path
    } else {
        path.trim_end_matches('/').to_string()
    }
}
