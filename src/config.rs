use std::{
    collections::{HashMap, HashSet},
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ServiceConfig {
    #[serde(default = "default_bucket")]
    pub(crate) bucket: String,
    #[serde(default = "default_mounts")]
    pub(crate) mounts: Vec<MountConfig>,
    #[serde(default)]
    pub(crate) users: Vec<KeyConfig>,
    #[serde(default)]
    pub(crate) rules: Vec<AuthRule>,
    #[serde(default)]
    pub(crate) cache: CacheConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct MountConfig {
    #[serde(rename = "type")]
    pub(crate) mount_type: String,
    pub(crate) path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) root_path: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub(crate) options: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct KeyConfig {
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) key_hash: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) key_hint: String,
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
    #[serde(default, skip_serializing)]
    pub(crate) key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct AuthRule {
    pub(crate) user: String,
    pub(crate) paths: Vec<String>,
    pub(crate) actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
            bucket: default_bucket(),
            mounts: default_mounts(),
            users: Vec::new(),
            rules: Vec::new(),
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

pub(crate) fn default_mounts() -> Vec<MountConfig> {
    vec![MountConfig {
        path: "/api/config.yaml".to_string(),
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
    "abucket".to_string()
}

pub(crate) fn config_db_path() -> Result<PathBuf> {
    if let Ok(path) = env::var("ABUCKET_DB").or_else(|_| env::var("ATREE_DB")) {
        return Ok(PathBuf::from(path));
    }
    let home = env::var("HOME").context("HOME is required when neither ABUCKET_DB nor ATREE_DB is set")?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("abucket")
        .join("abucket.sqlite"))
}

pub(crate) fn mount_root_path(mount: &MountConfig) -> &str {
    mount.root_path.as_deref().unwrap_or("")
}

pub(crate) fn load_or_init_config(db_path: &Path) -> Result<ServiceConfig> {
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
    let config = normalize_config(ServiceConfig::default())?;
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
    if config.bucket == "atree" {
        config.bucket = "abucket".to_string();
    }

    for mount in &mut config.mounts {
        if mount.mount_type == "system_config" {
            mount.root_path = None;
        }
    }
    for user in &mut config.users {
        if let Some(plain) = user.key.take() {
            if plain.len() < 8 {
                bail!("key for user '{}' must be at least 8 characters", user.name);
            }
            user.key_hash = hash_key(&plain);
            user.key_hint = key_hint(&plain);
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
        r#"# abucket config
# This is the live service config. Comments are ignored on PUT.
# If ABUCKET_ROOT_KEY is set, that key is treated as user `root`.
#
# bucket: path-style S3 bucket name used by clients. Default: abucket.
# mounts: ordered mount table. Later mounts have higher priority.
# mounts[].path: service path, must start with /. Example: /quark or /pub
# mounts[].type: quark_open, system_config, url_tree, github_releases, or s3.
# mounts[].root_path: only for mounts backed by a remote tree.
#   Mount field details are documented where they are parsed: src/mounts/*.rs.
#   system_config does not use root_path; path is the config file path.
# Disable a mount by commenting it out of this YAML.
# mounts[].options:
#   Mount-specific fields live here. Read src/mounts/*.rs for exact meaning.
#   hide_from_parent: optional boolean. Hides this mount only from its parent directory listing.
#     Direct requests to path still resolve normally and still use rules.
#     This is discoverability control, not a security boundary.
#   use {{}} or null when unused.
# system_config note:
#   path is one mounted file path, not a directory. Example: {config_path}
#   if you move this path, rules must target the new path; the old path will 404.
#
# users: named users. Do not store plaintext keys here.
# users[].key: allowed only in PUT; the service stores key_hash/key_hint and never returns key.
# users[].key_hash: sha256:<hex> hash generated from key.
# users[].key_hint: short non-secret hint for humans.
# rules: default-deny allow-list.
# rules[].user: anonymous, root, or a name from users.
# rules[].paths: service paths such as /public, /public/*, or /*.
# rules[].actions: ListBucket, HeadObject, GetObject, PutObject, DeleteObject, or *.
#   /public/* matches descendants at any depth, but not /public itself.
# rules only grant access; writable paths still need a writable mount.
# requests that match no rule are denied unless the caller is `root`.
#
# cache.enabled: enable local tree cache for ListBucket responses and object GET/HEAD reads.
#   GitHub release mounts also cache mount metadata behind the same TTL.
# cache.ttl_seconds: cached freshness window. Default: 600.
# cache.max_bytes: max local cache size in bytes; it is not backend capacity.
#
# `abucket` is an S3-style file API with one mounted system config file.
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
    validate_bucket(&config.bucket)?;
    if config.mounts.is_empty() {
        bail!("config.mounts must contain at least one mount");
    }
    if config.cache.ttl_seconds == 0 {
        bail!("cache.ttl_seconds must be greater than 0");
    }
    let mut paths = HashMap::new();
    let mut has_system_config = false;
    for mount in &config.mounts {
        validate_abs_path(&mount.path, "path")?;
        if !matches!(
            mount.mount_type.as_str(),
            "quark_open" | "system_config" | "url_tree" | "github_releases" | "s3"
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
                    "access_token",
                    "refresh_token",
                    "app_id",
                    "sign_key",
                    "refresh_url",
                    "root_fid",
                ] {
                    if let Some(value) = mount.options.get(key)
                        && !value.is_string()
                    {
                        bail!("options.{key} must be a string");
                    }
                }
                if mount
                    .options
                    .get("refresh_token")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .is_none()
                {
                    bail!("quark_open mounts need options.refresh_token");
                }
                if let Some(refresh_url) = mount.options.get("refresh_url").and_then(Value::as_str)
                {
                    validate_http_url(refresh_url, "options.refresh_url")?;
                }
                if let Some(value) = mount.options.get("hide_from_parent")
                    && !value.is_boolean()
                    && !value.is_string()
                {
                    bail!("options.hide_from_parent must be a boolean");
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
                if normalize_virtual_path(&mount.path) == "/" {
                    bail!("system_config path must be a file path, not /");
                }
            }
            "s3" => {
                if let Some(root_path) = mount.root_path.as_deref() {
                    validate_abs_path(root_path, "root_path")?;
                }
                for key in [
                    "endpoint",
                    "bucket",
                    "region",
                    "access_key",
                    "secret_key",
                    "session_token",
                    "proxy",
                ] {
                    if let Some(value) = mount.options.get(key)
                        && !value.is_string()
                    {
                        bail!("options.{key} must be a string");
                    }
                }
                for key in ["endpoint", "bucket"] {
                    if mount
                        .options
                        .get(key)
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .is_none()
                    {
                        bail!("s3 mounts need options.{key}");
                    }
                }
                if mount
                    .options
                    .get("access_key")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .is_none()
                {
                    bail!("s3 mounts need options.access_key");
                }
                if mount
                    .options
                    .get("secret_key")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .is_none()
                {
                    bail!("s3 mounts need options.secret_key");
                }
                if let Some(endpoint) = mount.options.get("endpoint").and_then(Value::as_str) {
                    validate_http_url(endpoint, "options.endpoint")?;
                }
                if let Some(proxy) = mount.options.get("proxy").and_then(Value::as_str) {
                    validate_http_url(proxy, "options.proxy")?;
                }
                for key in ["hide_from_parent"] {
                    if let Some(value) = mount.options.get(key)
                        && !value.is_boolean()
                        && !value.is_string()
                    {
                        bail!("options.{key} must be a boolean");
                    }
                }
            }
            _ => unreachable!(),
        }
        if mount.mount_type == "system_config" {
            has_system_config = true;
        }
        if let Some(existing_type) = paths.insert(mount.path.clone(), mount.mount_type.clone())
            && (existing_type != "github_releases" || mount.mount_type != "github_releases")
        {
            bail!("duplicate path '{}'", mount.path);
        }
    }
    if !has_system_config {
        bail!("config.mounts must contain at least one system_config mount");
    }

    let mut names = HashSet::new();
    for key in &config.users {
        if key.name.trim().is_empty() {
            bail!("user name cannot be empty");
        }
        if !names.insert(key.name.clone()) {
            bail!("duplicate user '{}'", key.name);
        }
        if matches!(key.name.as_str(), "anonymous" | "root") {
            bail!("user '{}' uses a reserved name", key.name);
        }
        if key.enabled && !key.key_hash.starts_with("sha256:") {
            bail!("user '{}' needs key_hash or key", key.name);
        }
    }

    for rule in &config.rules {
        if rule.user != "anonymous" && rule.user != "root" && !names.contains(&rule.user) {
            bail!("rule references missing user '{}'", rule.user);
        }
        if rule.actions.is_empty() || rule.paths.is_empty() {
            bail!("rules need non-empty actions and paths");
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
        for path in &rule.paths {
            if path != "*" && !path.starts_with('/') {
                bail!("path '{}' must start with / or be *", path);
            }
        }
    }
    Ok(())
}

fn validate_bucket(bucket: &str) -> Result<()> {
    if bucket.trim().is_empty() {
        bail!("bucket cannot be empty");
    }
    if bucket.contains('/') {
        bail!("bucket cannot contain /");
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
