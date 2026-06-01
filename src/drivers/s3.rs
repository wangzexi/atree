//! S3 mount driver.
//!
//! This is the generic object-storage backend. It expects explicit credentials
//! in config and defaults to path-style addressing for self-hosted or S3-like
//! endpoints.

use serde::Deserialize;

use crate::config;
use crate::drivers::options;

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

pub(crate) fn from_mount(mount: &config::MountConfig) -> Option<S3Config> {
    Some(S3Config {
        endpoint: options::string(&mount.options, "endpoint")?,
        bucket: options::string(&mount.options, "bucket")?,
        region: options::string(&mount.options, "region")
            .unwrap_or_else(|| "us-east-1".to_string()),
        access_key: options::string(&mount.options, "access_key")
            .or_else(|| options::string(&mount.options, "access_key_id"))?,
        secret_key: options::string(&mount.options, "secret_key")
            .or_else(|| options::string(&mount.options, "secret_access_key"))?,
        session_token: options::string(&mount.options, "session_token"),
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
        proxy: options::string(&mount.options, "proxy"),
    })
}
