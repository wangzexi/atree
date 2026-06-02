//! S3 mount driver.
//!
//! This is the generic object-storage backend. It expects explicit credentials
//! in config and uses path-style addressing for self-hosted or S3-like endpoints.
//!
//! Mount config:
//! - `path`: atree directory exposed to users, such as `/public`.
//! - `root_path`: optional object key prefix inside the remote bucket. Omit it
//!   to use the bucket root.
//! - `options.endpoint`: required S3-compatible endpoint base URL.
//! - `options.bucket`: required remote bucket name.
//! - `options.region`: optional signing region; defaults to `us-east-1`.
//! - `options.access_key`: required access key.
//! - `options.secret_key`: required secret key.
//! - `options.session_token`: optional temporary credential token.
//! - `options.proxy`: optional outbound proxy.

use serde::Deserialize;

use crate::config;
use crate::drivers::options;

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(crate) struct S3Config {
    /// S3-compatible endpoint base URL.
    pub(crate) endpoint: String,
    /// Remote bucket name.
    pub(crate) bucket: String,
    /// AWS SigV4 signing region.
    pub(crate) region: String,
    /// Access key used for SigV4 signing.
    pub(crate) access_key: String,
    /// Secret key used for SigV4 signing.
    pub(crate) secret_key: String,
    /// Optional temporary credential token.
    pub(crate) session_token: Option<String>,
    /// Optional outbound proxy.
    pub(crate) proxy: Option<String>,
}

pub(crate) fn from_mount(mount: &config::MountConfig) -> Option<S3Config> {
    Some(S3Config {
        endpoint: options::string(&mount.options, "endpoint")?,
        bucket: options::string(&mount.options, "bucket")?,
        region: options::string(&mount.options, "region")
            .unwrap_or_else(|| "us-east-1".to_string()),
        access_key: options::string(&mount.options, "access_key")?,
        secret_key: options::string(&mount.options, "secret_key")?,
        session_token: options::string(&mount.options, "session_token"),
        proxy: options::string(&mount.options, "proxy"),
    })
}
