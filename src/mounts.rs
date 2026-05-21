use std::fs;
use std::path::{Path as FsPath, PathBuf};

use anyhow::{Result, bail};
use reqwest::{Client, Proxy, Url};
use serde::Deserialize;
use serde_yaml::Value as YamlValue;

use crate::{config, QuarkBackend, QuarkClient, QuarkOpenClient};

#[derive(Debug, Clone)]
pub(crate) struct QuarkOpenConfig {
    pub(crate) oauth_file: Option<PathBuf>,
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) app_id: String,
    pub(crate) sign_key: String,
    pub(crate) refresh_url: String,
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

#[derive(Debug, Clone)]
pub(crate) enum ResolvedMount {
    Quark {
        remote_key: String,
        cookie: String,
        root_fid: String,
    },
    QuarkOpen {
        remote_key: String,
        config: QuarkOpenConfig,
    },
    SystemConfig,
    UrlTree {
        url: String,
        proxy: Option<String>,
    },
    GithubReleases {
        rest: String,
        config: GithubReleasesConfig,
    },
}

pub(crate) fn quark_client(cookie: String, root_fid: String) -> Result<QuarkClient> {
    if cookie.trim().is_empty() {
        bail!("quark_cookie mount needs options.cookie in config.yaml");
    }
    QuarkClient::new(cookie, root_fid)
}

pub(crate) fn quark_open_client(config: QuarkOpenConfig) -> Result<QuarkOpenClient> {
    if config.refresh_token.trim().is_empty() {
        bail!("quark_open mount needs options.refresh_token or options.oauth_file");
    }
    let http = Client::builder()
        .user_agent("atree/quark-open")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()?;
    Ok(QuarkOpenClient {
        http,
        config: std::sync::Arc::new(tokio::sync::Mutex::new(config)),
    })
}

pub(crate) fn github_client(config: &GithubReleasesConfig) -> Result<Client> {
    let mut builder = Client::builder()
        .user_agent("atree/github-releases")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(120));
    if let Some(proxy_url) = config.proxy.as_deref() {
        builder = builder.proxy(Proxy::all(proxy_url)?);
    }
    Ok(builder.build()?)
}

pub(crate) fn resolve_remote_key(config: &config::ServiceConfig, virtual_path: &str) -> Option<String> {
    match resolve_mount(config, virtual_path)? {
        ResolvedMount::Quark { remote_key, .. } => Some(remote_key),
        _ => None,
    }
}

pub(crate) fn resolve_mount(config: &config::ServiceConfig, virtual_path: &str) -> Option<ResolvedMount> {
    resolve_mount_inner(config, virtual_path, true)
}

pub(crate) fn resolve_explicit_mount(config: &config::ServiceConfig, virtual_path: &str) -> Option<ResolvedMount> {
    resolve_mount_inner(config, virtual_path, false)
}

fn resolve_mount_inner(
    config: &config::ServiceConfig,
    virtual_path: &str,
    include_root_mount: bool,
) -> Option<ResolvedMount> {
    let path = normalize_virtual_path(virtual_path);
    let mount = config
        .mounts
        .iter()
        .rev()
        .find(|mount| {
            mount.enabled
                && (include_root_mount || normalize_virtual_path(&mount.mount_path) != "/")
                && mount_matches_for_type(mount, &path)
        })?;
    match mount.mount_type.as_str() {
        "quark_cookie" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            Some(ResolvedMount::Quark {
                remote_key: join_remote_path(&mount.root_path, rest),
                cookie: mount_option_string(&mount.options, "cookie").unwrap_or_default(),
                root_fid: mount_option_string(&mount.options, "root_fid")
                    .unwrap_or_else(|| "0".to_string()),
            })
        }
        "quark_open" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            Some(ResolvedMount::QuarkOpen {
                remote_key: join_remote_path(&mount.root_path, rest),
                config: quark_open_config_from_options(&mount.options)?,
            })
        }
        "system_config" => Some(ResolvedMount::SystemConfig),
        "url_tree" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            Some(ResolvedMount::UrlTree {
                url: join_url_path(&mount.root_path, rest)?,
                proxy: mount
                    .options
                    .get("proxy")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.trim().is_empty())
                    .map(ToString::to_string),
            })
        }
        "github_releases" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            Some(ResolvedMount::GithubReleases {
                rest: rest.to_string(),
                config: github_releases_config_from_mount(mount)?,
            })
        }
        _ => None,
    }
}

pub(crate) fn backend_from_mount(mount: ResolvedMount) -> Option<(String, QuarkBackend)> {
    match mount {
        ResolvedMount::Quark {
            remote_key,
            cookie,
            root_fid,
        } => Some((remote_key, QuarkBackend::Cookie(quark_client(cookie, root_fid).ok()?))),
        ResolvedMount::QuarkOpen {
            remote_key,
            config,
        } => Some((remote_key, QuarkBackend::Open(quark_open_client(config).ok()?))),
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
            value
                .as_bool()
                .or_else(|| value.as_str().map(|value| matches!(value, "true" | "yes" | "1")))
        })
        .unwrap_or(false)
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
        let root = mount.root_path.trim().trim_matches('/');
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

fn quark_open_config_from_options(options: &serde_json::Value) -> Option<QuarkOpenConfig> {
    let oauth_file = mount_option_string(options, "oauth_file").map(PathBuf::from);
    let oauth = oauth_file.as_deref().and_then(read_quark_open_oauth_file);
    Some(QuarkOpenConfig {
        oauth_file,
        access_token: mount_option_string(options, "access_token")
            .or_else(|| {
                oauth
                    .as_ref()
                    .and_then(|value| yaml_string(value, &["tokens", "access_token"]))
            })
            .unwrap_or_default(),
        refresh_token: mount_option_string(options, "refresh_token").or_else(|| {
            oauth
                .as_ref()
                .and_then(|value| yaml_string(value, &["tokens", "refresh_token"]))
        })?,
        app_id: mount_option_string(options, "app_id")
            .or_else(|| {
                oauth
                    .as_ref()
                    .and_then(|value| yaml_string(value, &["app_id"]))
            })
            .or_else(|| {
                oauth
                    .as_ref()
                    .and_then(|value| yaml_string(value, &["application", "client_id"]))
            })
            .unwrap_or_default(),
        sign_key: mount_option_string(options, "sign_key")
            .or_else(|| {
                oauth
                    .as_ref()
                    .and_then(|value| yaml_string(value, &["sign_key"]))
            })
            .or_else(|| {
                oauth
                    .as_ref()
                    .and_then(|value| yaml_string(value, &["application", "sign_key"]))
            })
            .unwrap_or_default(),
        refresh_url: mount_option_string(options, "refresh_url")
            .or_else(|| {
                oauth
                    .as_ref()
                    .and_then(|value| yaml_string(value, &["source", "refresh_url"]))
            })
            .unwrap_or_else(|| "https://api.oplist.org/quarkyun/renewapi".to_string()),
        root_fid: mount_option_string(options, "root_fid").unwrap_or_else(|| "0".to_string()),
    })
}

pub(crate) fn is_fnnas_quark_refresh_url(refresh_url: &str) -> bool {
    let Ok(url) = Url::parse(refresh_url) else {
        return false;
    };
    matches!(url.host_str(), Some("oauth.fnnas.com")) && url.path() == "/api/v1/oauth/refreshToken"
}

pub(crate) fn read_quark_open_oauth_file(path: &FsPath) -> Option<YamlValue> {
    let bytes = fs::read(path).ok()?;
    serde_yaml::from_slice(&bytes).ok()
}

pub(crate) fn persist_quark_open_config(config: &QuarkOpenConfig) -> Result<()> {
    let Some(path) = &config.oauth_file else {
        return Ok(());
    };
    let mut value =
        read_quark_open_oauth_file(path).unwrap_or(YamlValue::Mapping(Default::default()));
    set_yaml_string(
        &mut value,
        &["tokens", "access_token"],
        &config.access_token,
    );
    set_yaml_string(
        &mut value,
        &["tokens", "refresh_token"],
        &config.refresh_token,
    );
    if !config.app_id.is_empty() {
        set_yaml_string(&mut value, &["application", "client_id"], &config.app_id);
        set_yaml_string(&mut value, &["app_id"], &config.app_id);
    }
    if !config.sign_key.is_empty() {
        set_yaml_string(&mut value, &["application", "sign_key"], &config.sign_key);
        set_yaml_string(&mut value, &["sign_key"], &config.sign_key);
    }
    fs::write(path, serde_yaml::to_string(&value)?)?;
    Ok(())
}

fn yaml_string(value: &YamlValue, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(YamlValue::String((*key).to_string()))?;
    }
    current.as_str().map(ToString::to_string)
}

fn set_yaml_string(value: &mut YamlValue, path: &[&str], new_value: &str) {
    if path.is_empty() {
        *value = YamlValue::String(new_value.to_string());
        return;
    }
    if !value.is_mapping() {
        *value = YamlValue::Mapping(Default::default());
    }
    let mapping = value
        .as_mapping_mut()
        .expect("mapping was just initialized");
    let key = YamlValue::String(path[0].to_string());
    let entry = mapping
        .entry(key)
        .or_insert_with(|| YamlValue::Mapping(Default::default()));
    set_yaml_string(entry, &path[1..], new_value);
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
