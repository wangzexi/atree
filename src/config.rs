use std::{collections::HashSet, env, path::PathBuf};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::chrono_millis;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ServiceConfig {
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
    pub(crate) root_path: String,
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub(crate) options: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    #[serde(default = "default_cache_max_bytes")]
    pub(crate) max_bytes: u64,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
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
            max_bytes: default_cache_max_bytes(),
        }
    }
}

pub(crate) fn default_mounts() -> Vec<MountConfig> {
    vec![MountConfig {
        mount_path: "/".to_string(),
        mount_type: "quark_cookie".to_string(),
        root_path: "/".to_string(),
        enabled: true,
        options: Value::Null,
    }]
}

fn default_true() -> bool {
    true
}

fn default_cache_max_bytes() -> u64 {
    50 * 1024 * 1024 * 1024
}

pub(crate) fn config_db_path() -> Result<PathBuf> {
    if let Ok(path) = env::var("QUARK_S3_DB") {
        return Ok(PathBuf::from(path));
    }
    let home = env::var("HOME").context("HOME is required when QUARK_S3_DB is not set")?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("quark-s3-demo")
        .join("quark-s3-demo.sqlite"))
}

pub(crate) fn load_or_init_config(db_path: &PathBuf) -> Result<ServiceConfig> {
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
        let config: ServiceConfig = serde_json::from_str(&raw)?;
        validate_config(&config)?;
        return Ok(config);
    }
    let config = ServiceConfig::default();
    save_config_to_db(db_path, &config)?;
    Ok(config)
}

pub(crate) fn save_config_to_db(db_path: &PathBuf, config: &ServiceConfig) -> Result<()> {
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

pub(crate) fn commented_yaml(config: &ServiceConfig) -> Result<String> {
    let yaml = serde_yaml::to_string(config)?;
    Ok(format!("{}{}", CONFIG_YAML_COMMENTS, yaml))
}

const CONFIG_YAML_COMMENTS: &str = r#"# quark-s3-demo config
# This YAML is meant for humans and AI agents. Comments are ignored on PUT.
#
# mounts: ordered mount table. Later mounts have higher priority.
# mounts[].mount_path: service path, must start with /. Example: /public
# mounts[].type: currently only quark_cookie is supported.
# mounts[].root_path: human-readable Quark path to expose at mount_path.
# mounts[].enabled: false disables the mount without deleting it.
# mounts[].options: reserved driver-specific object; use {} or null when unused.
#
# auth.keys: named service keys. Do not store plaintext keys here.
# auth.keys[].plain_key: allowed only in PUT; the service stores key_hash/key_hint and never returns plain_key.
# auth.keys[].key_hash: sha256:<hex> hash generated from plain_key.
# auth.keys[].key_hint: short non-secret hint for humans.
# auth.rules: default-deny allow-list.
# auth.rules[].principal: anonymous or key:<name>.
# auth.rules[].actions: ListBucket, HeadObject, GetObject, PutObject, DeleteObject, or *.
# auth.rules[].resources: service paths such as /public/* or /*.
#
# cache.enabled: reserved for read-through cache work.
# cache.max_bytes: max local cache size in bytes; it is not Quark capacity.

"#;

pub(crate) fn validate_config(config: &ServiceConfig) -> Result<()> {
    if config.mounts.is_empty() {
        bail!("config.mounts must contain at least one mount");
    }
    let mut mount_paths = HashSet::new();
    for mount in &config.mounts {
        validate_abs_path(&mount.mount_path, "mount_path")?;
        validate_abs_path(&mount.root_path, "root_path")?;
        if mount.mount_type != "quark_cookie" {
            bail!("unsupported mount type '{}'", mount.mount_type);
        }
        if !mount_paths.insert(mount.mount_path.clone()) {
            bail!("duplicate mount_path '{}'", mount.mount_path);
        }
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
        if rule.principal != "anonymous" && !rule.principal.starts_with("key:") {
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

fn validate_abs_path(path: &str, field: &str) -> Result<()> {
    if !path.starts_with('/') {
        bail!("{field} must start with /");
    }
    if path.split('/').any(|p| p == "..") {
        bail!("{field} cannot contain ..");
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
