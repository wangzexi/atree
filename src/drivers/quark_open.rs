//! QuarkOpen mount driver.
//!
//! This driver mounts Quark Drive through its open-api shape. The default
//! refresh endpoint follows OpenList's `drivers/quark_open` behavior:
//! `https://api.oplist.org/quarkyun/renewapi`.
//!
//! When `app_id` and `sign_key` are already configured, that OpenList endpoint
//! is enough to refresh tokens. When atree must learn `app_id`/`sign_key` from a
//! refresh response, point `refresh_url` at the FnOS OAuth endpoint:
//! `https://oauth.fnnas.com/api/v1/oauth/refreshToken`.

use std::{path::PathBuf, sync::Arc};

use anyhow::{Result, bail};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::drivers::options;
use crate::{QuarkOpenClient, config};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct QuarkOpenConfig {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) app_id: String,
    pub(crate) sign_key: String,
    pub(crate) refresh_url: String,
    #[serde(default)]
    pub(crate) root_fid: String,
}

pub(crate) fn from_mount(mount: &config::MountConfig) -> Option<QuarkOpenConfig> {
    Some(QuarkOpenConfig {
        access_token: options::string(&mount.options, "access_token").unwrap_or_default(),
        refresh_token: options::string(&mount.options, "refresh_token")?,
        app_id: options::string(&mount.options, "app_id").unwrap_or_default(),
        sign_key: options::string(&mount.options, "sign_key").unwrap_or_default(),
        refresh_url: options::string(&mount.options, "refresh_url")
            .unwrap_or_else(|| "https://api.oplist.org/quarkyun/renewapi".to_string()),
        root_fid: options::string(&mount.options, "root_fid").unwrap_or_else(|| "0".to_string()),
    })
}

pub(crate) fn client(
    config: QuarkOpenConfig,
    mount_path: &str,
    db_path: PathBuf,
    service_config: Arc<RwLock<config::ServiceConfig>>,
) -> Result<QuarkOpenClient> {
    if config.refresh_token.trim().is_empty() {
        bail!("quark_open mount {mount_path} needs options.refresh_token");
    }
    let http = Client::builder()
        .user_agent("atree/quark-open")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()?;
    Ok(QuarkOpenClient {
        http,
        config: std::sync::Arc::new(tokio::sync::Mutex::new(config)),
        db_path,
        service_config,
        mount_path: mount_path.to_string(),
    })
}

pub(crate) fn is_fnnas_quark_refresh_url(refresh_url: &str) -> bool {
    let Ok(url) = Url::parse(refresh_url) else {
        return false;
    };
    matches!(url.host_str(), Some("oauth.fnnas.com")) && url.path() == "/api/v1/oauth/refreshToken"
}
