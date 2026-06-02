//! GitHub Releases mount driver.
//!
//! The mounted tree is generated from one repository's release metadata. It can
//! expose only assets, or include GitHub-generated source archives when
//! `show_source_code` is enabled.
//!
//! Mount config:
//! - `path`: atree directory where release assets appear.
//! - `root_path`: optional `owner/repo`; used when `options.repo` is omitted.
//! - `options.repo`: optional `owner/repo`; preferred explicit repo field.
//! - `options.token`: optional GitHub token for private repos or higher rate limits.
//! - `options.proxy`: optional outbound proxy for API and downloads.
//! - `options.show_source_code`: include GitHub source zip/tarball links.
//! - `options.asset_allow`: optional asset names or `*` globs. String or list.
//!
//! Multiple `github_releases` mounts may share the same `path`; atree merges
//! them into one flat release-asset directory.

use anyhow::Result;
use reqwest::{Client, Proxy};
use serde::Deserialize;

use crate::config;
use crate::drivers::options;

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GithubReleasesConfig {
    /// GitHub repository in `owner/repo` form.
    pub(crate) repo: String,
    /// Optional token for private repos or higher GitHub API rate limits.
    pub(crate) token: Option<String>,
    /// Optional HTTP(S) proxy used for both GitHub API and asset downloads.
    pub(crate) proxy: Option<String>,
    /// Whether to expose GitHub-generated source archive links.
    pub(crate) show_source_code: bool,
    /// Optional allow-list of asset names or `*` globs.
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
