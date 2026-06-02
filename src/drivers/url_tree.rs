//! URL Tree mount driver.
//!
//! This driver maps atree paths onto a remote URL prefix. It is intentionally
//! thin: atree only joins paths, optionally applies a proxy, and streams the
//! target response back through the S3-compatible surface.
//!
//! Mount config:
//! - `path`: atree directory exposed to users.
//! - `root_path`: required upstream HTTP(S) URL prefix. Read-only.
//! - `options.proxy`: optional outbound proxy.
//! - `options.size`: optional fixed file size for file-shaped URL mounts when
//!   upstream `HEAD` is unreliable.

use reqwest::Url;

use crate::config;
use crate::drivers::options;

#[derive(Debug, Clone)]
pub(crate) struct UrlTreeTarget {
    /// Final upstream URL after joining `root_path` and the requested rest path.
    pub(crate) url: String,
    /// Optional outbound proxy.
    pub(crate) proxy: Option<String>,
    /// Optional fixed size exposed in HEAD/List responses.
    pub(crate) size: Option<u64>,
}

pub(crate) fn target_from_mount(mount: &config::MountConfig, rest: &str) -> Option<UrlTreeTarget> {
    Some(UrlTreeTarget {
        url: join_url_path(config::mount_root_path(mount), rest)?,
        proxy: options::string(&mount.options, "proxy"),
        size: options::u64(&mount.options, "size"),
    })
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
