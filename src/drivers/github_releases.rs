//! GitHub Releases mount driver.
//!
//! The mounted tree is generated from one repository's release metadata. It can
//! expose only assets, or include GitHub-generated source archives when
//! `show_source_code` is enabled.

use anyhow::Result;
use reqwest::{Client, Proxy};
use serde::Deserialize;

use crate::config;
use crate::drivers::options;

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GithubReleasesConfig {
    pub(crate) repo: String,
    pub(crate) token: Option<String>,
    pub(crate) proxy: Option<String>,
    pub(crate) show_source_code: bool,
    pub(crate) asset_allow: Vec<String>,
}

pub(crate) fn from_mount(mount: &config::MountConfig) -> Option<GithubReleasesConfig> {
    let repo = options::string(&mount.options, "repo").or_else(|| {
        let root = config::mount_root_path(mount).trim().trim_matches('/');
        (!root.is_empty()).then(|| root.to_string())
    })?;

    Some(GithubReleasesConfig {
        repo,
        token: options::string(&mount.options, "token"),
        proxy: options::string(&mount.options, "proxy"),
        show_source_code: options::bool(&mount.options, "show_source_code"),
        asset_allow: options::string_list(&mount.options, "asset_allow"),
    })
}

pub(crate) fn client(config: &GithubReleasesConfig) -> Result<Client> {
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
