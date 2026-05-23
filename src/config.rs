use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use reqwest::Url;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{chrono_millis, mounts::normalize_virtual_path};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ServiceConfig {
    #[serde(default = "default_bucket")]
    pub(crate) s3_bucket: String,
    #[serde(default = "default_mounts")]
    pub(crate) mounts: Vec<MountConfig>,
    #[serde(default)]
    pub(crate) auth: AuthConfig,
    #[serde(default)]
    pub(crate) cache: CacheConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MountConfig {
    pub(crate) mount_path: String,
    #[serde(rename = "type")]
    pub(crate) mount_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) root_path: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub(crate) options: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AuthConfig {
    #[serde(default)]
    pub(crate) keys: Vec<KeyConfig>,
    #[serde(default)]
    pub(crate) rules: Vec<AuthRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct KeyConfig {
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) key_hash: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) key_hint: String,
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
    #[serde(default, skip_serializing)]
    pub(crate) plain_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AuthRule {
    pub(crate) principal: String,
    pub(crate) actions: Vec<String>,
    pub(crate) resources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CacheConfig {
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
    #[serde(default = "default_cache_ttl_seconds")]
    pub(crate) ttl_seconds: u64,
    #[serde(default = "default_cache_max_bytes")]
    pub(crate) max_bytes: u64,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            s3_bucket: default_bucket(),
            mounts: default_mounts(),
            auth: AuthConfig::default(),
            cache: CacheConfig::default(),
        }
    }
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            ttl_seconds: default_cache_ttl_seconds(),
            max_bytes: default_cache_max_bytes(),
        }
    }
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            keys: Vec::new(),
            rules: Vec::new(),
        }
    }
}

pub(crate) fn default_mounts() -> Vec<MountConfig> {
    vec![MountConfig {
        mount_path: "/api/config.yaml".to_string(),
        mount_type: "system_config".to_string(),
        root_path: None,
        options: Value::Null,
    }]
}

fn default_true() -> bool {
    true
}

fn default_cache_max_bytes() -> u64 {
    50 * 1024 * 1024 * 1024
}

fn default_cache_ttl_seconds() -> u64 {
    600
}

fn default_bucket() -> String {
    "atree".to_string()
}

pub(crate) fn config_db_path() -> Result<PathBuf> {
    if let Ok(path) = env::var("ATREE_DB") {
        return Ok(PathBuf::from(path));
    }
    let home = env::var("HOME").context("HOME is required when ATREE_DB is not set")?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("atree")
        .join("atree.sqlite"))
}

pub(crate) fn mount_root_path(mount: &MountConfig) -> &str {
    mount.root_path.as_deref().unwrap_or("")
}

pub(crate) fn load_or_init_config(
    db_path: &Path,
    bootstrap_config_path: Option<&Path>,
) -> Result<ServiceConfig> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(db_path)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;
    let existing: Option<String> = conn
        .query_row("SELECT json FROM config WHERE id = 1", [], |row| row.get(0))
        .ok();
    if let Some(raw) = existing {
        let config = normalize_config(serde_json::from_str(&raw)?)?;
        save_config_to_db(db_path, &config)?;
        return Ok(config);
    }
    let config = if let Some(path) = bootstrap_config_path {
        let bytes = std::fs::read(path)
            .with_context(|| format!("failed to read bootstrap config: {}", path.display()))?;
        normalize_config(parse_config_yaml(&bytes)?)?
    } else {
        ServiceConfig::default()
    };
    save_config_to_db(db_path, &config)?;
    Ok(config)
}

pub(crate) fn save_config_to_db(db_path: &Path, config: &ServiceConfig) -> Result<()> {
    let conn = Connection::open(db_path)?;
    let raw = serde_json::to_string_pretty(config)?;
    conn.execute(
        "INSERT INTO config (id, json, updated_at) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        params![raw, chrono_millis()],
    )?;
    Ok(())
}

pub(crate) fn normalize_config(mut config: ServiceConfig) -> Result<ServiceConfig> {
    for mount in &mut config.mounts {
        if mount.mount_type == "system_config" {
            mount.root_path = None;
        }
    }
    for key in &mut config.auth.keys {
        if let Some(plain) = key.plain_key.take() {
            if plain.len() < 8 {
                bail!("plain_key for '{}' must be at least 8 characters", key.name);
            }
            key.key_hash = hash_key(&plain);
            key.key_hint = key_hint(&plain);
        }
    }
    validate_config(&config)?;
    Ok(config)
}

pub(crate) fn parse_config_yaml(bytes: &[u8]) -> Result<ServiceConfig> {
    Ok(serde_yaml::from_slice(bytes)?)
}

pub(crate) fn commented_yaml(
    config: &ServiceConfig,
    public_base_url: &str,
    config_path: &str,
) -> Result<String> {
    let yaml = serde_yaml::to_string(config)?;
    Ok(format!(
        "{}{}",
        config_yaml_comments(public_base_url, config_path),
        yaml
    ))
}

fn config_yaml_comments(public_base_url: &str, config_path: &str) -> String {
    format!(
        r#"# atree config
# This is the live service config. Comments are ignored on PUT.
# If ATREE_ROOT_KEY is set, that key is treated as principal `root`.
#
# s3_bucket: path-style S3 bucket name used by clients. Default: atree.
# mounts: ordered mount table. Later mounts have higher priority.
# mounts[].mount_path: service path, must start with /. Example: /quark or /pub
# mounts[].type: quark_open, system_config, url_tree, or github_releases.
# mounts[].root_path: only for mounts backed by a remote tree.
#   quark_open: human-readable Quark path to expose at mount_path.
#   url_tree: upstream http(s) URL prefix. Read-only.
#   github_releases: GitHub repo in owner/repo form. Read-only.
#   system_config does not use root_path; mount_path is the config file path.
# Disable a mount by commenting it out of this YAML.
# mounts[].options:
#   quark_open.oauth_file: path to private OAuth YAML, such as quark-open-oauth.yaml.
#   quark_open.access_token/refresh_token/app_id/sign_key/refresh_url can also be set directly.
#   url_tree.proxy: optional outbound proxy URL, such as http://127.0.0.1:1080.
#   github_releases.repo: owner/repo. If omitted, root_path can be owner/repo.
#   github_releases.proxy: optional outbound proxy URL for API and downloads.
#   github_releases.token: optional GitHub token for higher rate limits or private repos.
#   github_releases.asset_allow: optional list of asset names or * globs.
#   github_releases.show_source_code: optional boolean. Exposes GitHub's source zip/tarball links.
#   use {{}} or null when unused.
# system_config note:
#   mount_path is one mounted file path, not a directory. Example: {config_path}
#   if you move this path, auth.rules must target the new path; the old path will 404.
#
# auth.keys: named service keys. Do not store plaintext keys here.
# auth.keys[].plain_key: allowed only in PUT; the service stores key_hash/key_hint and never returns plain_key.
# auth.keys[].key_hash: sha256:<hex> hash generated from plain_key.
# auth.keys[].key_hint: short non-secret hint for humans.
# auth.rules: default-deny allow-list.
# auth.rules[].principal: anonymous, root, or key:<name>.
# auth.rules[].actions: ListBucket, HeadObject, GetObject, PutObject, DeleteObject, or *.
# auth.rules[].resources: service paths such as /public, /public/*, or /*.
#   /public/* matches descendants at any depth, but not /public itself.
# requests that match no rule are denied unless the caller is `root`.
#
# cache.enabled: enable local tree cache for ListBucket responses and object GET/HEAD reads.
#   GitHub release mounts also cache driver metadata behind the same TTL.
# cache.ttl_seconds: cached freshness window. Default: 600.
# cache.max_bytes: max local cache size in bytes; it is not backend capacity.
#
# `atree` is an S3-style file API with one mounted system config file.
#
# Examples:
#   curl -H 'Authorization: Bearer <root-key>' '{public_base_url}{config_path}'
#   curl -X PUT -H 'Authorization: Bearer <root-key>' --data @config.yaml '{public_base_url}{config_path}'
#   curl -I -H 'Authorization: Bearer <key>' '{public_base_url}/public/example.txt'
#   curl -H 'Authorization: Bearer <key>' '{public_base_url}/?list-type=2&delimiter=/&prefix=public/'
#   curl -X PUT -H 'Authorization: Bearer <key>' -T ./example.txt '{public_base_url}/public/example.txt'
#   curl -H 'Accept: text/html' '{public_base_url}/public/'
#   curl -H 'Accept: application/xml' '{public_base_url}/public/'

"#
    )
}

pub(crate) fn validate_config(config: &ServiceConfig) -> Result<()> {
    validate_bucket(&config.s3_bucket)?;
    if config.mounts.is_empty() {
        bail!("config.mounts must contain at least one mount");
    }
    if config.cache.ttl_seconds == 0 {
        bail!("cache.ttl_seconds must be greater than 0");
    }
    let mut mount_paths = HashSet::new();
    let mut has_system_config = false;
    for mount in &config.mounts {
        validate_abs_path(&mount.mount_path, "mount_path")?;
        if !matches!(
            mount.mount_type.as_str(),
            "quark_open" | "system_config" | "url_tree" | "github_releases"
        ) {
            bail!("unsupported mount type '{}'", mount.mount_type);
        }
        match mount.mount_type.as_str() {
            "quark_open" => {
                let Some(root_path) = mount.root_path.as_deref() else {
                    bail!("{} mounts need root_path", mount.mount_type);
                };
                validate_abs_path(root_path, "root_path")?;
                for key in [
                    "oauth_file",
                    "access_token",
                    "refresh_token",
                    "app_id",
                    "sign_key",
                    "refresh_url",
                ] {
                    if let Some(value) = mount.options.get(key)
                        && !value.is_string()
                    {
                        bail!("options.{key} must be a string");
                    }
                }
            }
            "url_tree" => {
                let Some(root_path) = mount.root_path.as_deref() else {
                    bail!("url_tree mounts need root_path");
                };
                validate_http_url(root_path, "root_path")?;
                if let Some(proxy) = mount.options.get("proxy").and_then(|value| value.as_str()) {
                    validate_http_url(proxy, "options.proxy")?;
                }
            }
            "github_releases" => {
                if mount
                    .root_path
                    .as_deref()
                    .unwrap_or_default()
                    .trim()
                    .is_empty()
                    && mount
                        .options
                        .get("repo")
                        .and_then(|value| value.as_str())
                        .is_none()
                {
                    bail!("github_releases needs root_path or options.repo in owner/repo form");
                }
                for key in ["repo", "token", "proxy"] {
                    if let Some(value) = mount.options.get(key)
                        && !value.is_string()
                    {
                        bail!("options.{key} must be a string");
                    }
                }
                if let Some(proxy) = mount.options.get("proxy").and_then(|value| value.as_str()) {
                    validate_http_url(proxy, "options.proxy")?;
                }
                if let Some(value) = mount.options.get("show_source_code")
                    && !value.is_boolean()
                    && !value.is_string()
                {
                    bail!("options.show_source_code must be a boolean");
                }
                if let Some(value) = mount.options.get("asset_allow") {
                    match value {
                        Value::Array(values) => {
                            if !values.iter().all(Value::is_string) {
                                bail!("options.asset_allow entries must be strings");
                            }
                        }
                        Value::String(_) => {}
                        _ => bail!("options.asset_allow must be a list of strings"),
                    }
                }
            }
            "system_config" => {
                if mount.root_path.is_some() {
                    bail!("system_config mounts do not use root_path");
                }
                if normalize_virtual_path(&mount.mount_path) == "/" {
                    bail!("system_config mount_path must be a file path, not /");
                }
            }
            _ => unreachable!(),
        }
        if mount.mount_type == "system_config" {
            has_system_config = true;
        }
        if !mount_paths.insert(mount.mount_path.clone()) {
            bail!("duplicate mount_path '{}'", mount.mount_path);
        }
    }
    if !has_system_config {
        bail!("config.mounts must contain at least one system_config mount");
    }

    let mut names = HashSet::new();
    for key in &config.auth.keys {
        if key.name.trim().is_empty() {
            bail!("auth key name cannot be empty");
        }
        if !names.insert(key.name.clone()) {
            bail!("duplicate auth key '{}'", key.name);
        }
        if key.enabled && !key.key_hash.starts_with("sha256:") {
            bail!("auth key '{}' needs key_hash or plain_key", key.name);
        }
    }

    for rule in &config.auth.rules {
        if rule.principal != "anonymous"
            && rule.principal != "root"
            && !rule.principal.starts_with("key:")
        {
            bail!("invalid principal '{}'", rule.principal);
        }
        if let Some(name) = rule.principal.strip_prefix("key:")
            && !names.contains(name)
        {
            bail!("rule references missing key '{}'", name);
        }
        if rule.actions.is_empty() || rule.resources.is_empty() {
            bail!("auth rules need non-empty actions and resources");
        }
        for action in &rule.actions {
            if action != "*"
                && !matches!(
                    action.as_str(),
                    "ListBucket" | "HeadObject" | "GetObject" | "PutObject" | "DeleteObject"
                )
            {
                bail!("unsupported action '{}'", action);
            }
        }
        for resource in &rule.resources {
            if resource != "*" && !resource.starts_with('/') {
                bail!("resource '{}' must start with / or be *", resource);
            }
        }
    }
    Ok(())
}

fn validate_bucket(bucket: &str) -> Result<()> {
    if bucket.trim().is_empty() {
        bail!("s3_bucket cannot be empty");
    }
    if bucket.contains('/') {
        bail!("s3_bucket cannot contain /");
    }
    Ok(())
}

fn validate_abs_path(path: &str, field: &str) -> Result<()> {
    if !path.starts_with('/') {
        bail!("{field} must start with /");
    }
    if path.split('/').any(|p| p == "..") {
        bail!("{field} cannot contain ..");
    }
    Ok(())
}

fn validate_http_url(url: &str, field: &str) -> Result<()> {
    let parsed = Url::parse(url).with_context(|| format!("{field} must be a valid URL"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        bail!("{field} must use http or https");
    }
    Ok(())
}

pub(crate) fn hash_key(key: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(key.as_bytes())))
}

fn key_hint(key: &str) -> String {
    let prefix = key.chars().take(4).collect::<String>();
    let suffix = key
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{prefix}...{suffix}")
}
