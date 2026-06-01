//! URL Tree mount driver.
//!
//! This driver maps atree paths onto a remote URL prefix. It is intentionally
//! thin: atree only joins paths, optionally applies a proxy, and streams the
//! target response back through the S3-compatible surface.

use reqwest::Url;

use crate::config;
use crate::drivers::options;

#[derive(Debug, Clone)]
pub(crate) struct UrlTreeTarget {
    pub(crate) url: String,
    pub(crate) proxy: Option<String>,
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
