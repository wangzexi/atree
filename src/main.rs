use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime},
};

mod config;
mod drivers;
mod mounts;
mod ui;

#[cfg(test)]
use crate::mounts::resolve_remote_key;
use crate::mounts::{
    ResolvedMount, backend_from_mount, resolve_github_release_mounts, resolve_mount,
};
use anyhow::{Context, Result, anyhow, bail};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, RawQuery, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use base64::{Engine as _, engine::general_purpose};
use config::{
    ServiceConfig, commented_yaml, config_db_path, hash_key, load_or_init_config, normalize_config,
    parse_config_yaml, save_config_to_db,
};
use drivers::{
    GithubReleasesConfig, QuarkOpenConfig, S3Config, github_client, is_fnnas_quark_refresh_url,
    quark_open_client,
};
use futures_util::TryStreamExt;
use reqwest::{Client, Proxy, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use tokio::{
    net::TcpListener,
    sync::{Mutex, RwLock},
    time::sleep,
};
use tracing::{info, warn};
use ui::{file_browser_html, wants_html};

const REFERER: &str = "https://pan.quark.cn";
const OPEN_API: &str = "https://open-api-drive.quark.cn";

#[derive(Clone)]
struct AppState {
    config: Arc<RwLock<ServiceConfig>>,
    db_path: PathBuf,
    root_key: Option<String>,
    cache_dir: PathBuf,
    multipart_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheMeta {
    size: u64,
    modified: i64,
    fetched_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
}

#[derive(Debug, Clone)]
struct CachedObject {
    bytes: Bytes,
    meta: CacheMeta,
}

#[derive(Clone)]
struct QuarkOpenClient {
    http: Client,
    config: Arc<Mutex<QuarkOpenConfig>>,
    db_path: PathBuf,
    service_config: Arc<RwLock<ServiceConfig>>,
    path: String,
}

enum QuarkBackend {
    Open(QuarkOpenClient),
}

#[derive(Debug, Clone, Deserialize)]
struct QuarkFile {
    fid: String,
    file_name: String,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    file: bool,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
struct OpenStatus {
    #[serde(default)]
    status: i64,
    #[serde(default)]
    errno: i64,
    #[serde(default)]
    error_info: String,
}

#[derive(Debug, Deserialize)]
struct OpenUserInfoResp {
    data: OpenUserInfo,
}

#[derive(Debug, Deserialize)]
struct OpenUserInfo {
    user_id: String,
}

#[derive(Debug, Deserialize)]
struct OpenFileListResp {
    data: OpenFileListData,
}

#[derive(Debug, Deserialize)]
struct OpenFileListData {
    #[serde(default)]
    file_list: Vec<OpenFile>,
    #[serde(default)]
    last_page: bool,
    #[serde(default)]
    next_query_cursor: Option<OpenQueryCursor>,
}

#[derive(Debug, Clone, Deserialize)]
struct OpenFile {
    fid: String,
    filename: String,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    file_type: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct OpenQueryCursor {
    version: String,
    token: String,
}

#[derive(Debug, Deserialize)]
struct OpenDownloadResp {
    data: OpenDownloadData,
}

#[derive(Debug, Deserialize)]
struct OpenDownloadData {
    download_url: String,
}

#[derive(Debug, Deserialize)]
struct OpenUploadPreResp {
    data: OpenUploadPreData,
}

#[derive(Debug, Clone, Deserialize)]
struct OpenUploadPreData {
    #[serde(default)]
    finish: bool,
    task_id: String,
    part_size: i64,
}

#[derive(Debug, Deserialize)]
struct OpenUploadUrlsResp {
    data: OpenUploadUrlsData,
}

#[derive(Debug, Deserialize)]
struct OpenUploadUrlsData {
    upload_urls: Vec<OpenUploadUrl>,
    common_headers: OpenCommonUploadHeaders,
}

#[derive(Debug, Deserialize)]
struct OpenUploadUrl {
    part_number: usize,
    upload_url: String,
    signature_info: OpenSignatureInfo,
}

#[derive(Debug, Deserialize)]
struct OpenSignatureInfo {
    signature: String,
}

#[derive(Debug, Deserialize)]
struct OpenCommonUploadHeaders {
    #[serde(rename = "X-Oss-Content-Sha256")]
    x_oss_content_sha256: String,
    #[serde(rename = "X-Oss-Date")]
    x_oss_date: String,
}

#[derive(Debug, Deserialize)]
struct OpenUploadFinishResp {
    data: OpenUploadFinishData,
}

#[derive(Debug, Deserialize)]
struct OpenUploadFinishData {
    #[serde(default)]
    finish: bool,
}

#[derive(Debug, Deserialize)]
struct OpenRefreshResp {
    refresh_token: String,
    access_token: String,
    #[serde(default)]
    app_id: String,
    #[serde(default)]
    sign_key: String,
    #[serde(default, rename = "text")]
    error_message: String,
}

#[derive(Debug, Deserialize)]
struct DirectOpenRefreshResp {
    #[serde(default)]
    msg: String,
    data: Option<DirectOpenRefreshData>,
}

#[derive(Debug, Deserialize)]
struct DirectOpenRefreshData {
    #[serde(rename = "tokenInfo")]
    token_info: DirectOpenTokenInfo,
}

#[derive(Debug, Deserialize)]
struct DirectOpenTokenInfo {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
    #[serde(default, rename = "appId")]
    app_id: String,
    #[serde(default, rename = "signKey")]
    sign_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct GithubRelease {
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
    #[serde(default)]
    tarball_url: String,
    #[serde(default)]
    zipball_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct GithubAsset {
    name: String,
    #[serde(default)]
    content_type: String,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct S3Entry {
    key: String,
    size: i64,
    modified: i64,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct S3Object {
    key: String,
    size: i64,
    modified: i64,
    content_type: Option<String>,
}

struct S3List {
    objects: Vec<S3Object>,
    common_prefixes: Vec<String>,
    next_offset: Option<String>,
}

impl QuarkBackend {
    fn http(&self) -> &Client {
        match self {
            QuarkBackend::Open(client) => &client.http,
        }
    }

    async fn list_files(&self, parent_fid: &str) -> Result<Vec<QuarkFile>> {
        match self {
            QuarkBackend::Open(client) => client.list_files(parent_fid).await,
        }
    }

    async fn resolve_dir(&self, path: &str, create: bool) -> Result<String> {
        match self {
            QuarkBackend::Open(client) => client.resolve_dir(path, create).await,
        }
    }

    async fn find_object(&self, key: &str) -> Result<Option<QuarkFile>> {
        match self {
            QuarkBackend::Open(client) => client.find_object(key).await,
        }
    }

    async fn download_request_parts(&self, fid: &str) -> Result<(String, String)> {
        match self {
            QuarkBackend::Open(client) => {
                let url = client.download_url(fid).await?;
                let auth_cookie = client.auth_cookie().await;
                Ok((url, auth_cookie))
            }
        }
    }

    async fn delete_fid(&self, fid: &str) -> Result<()> {
        match self {
            QuarkBackend::Open(client) => client.delete_fid(fid).await,
        }
    }

    async fn put_object(&self, key: &str, content_type: &str, body: Bytes) -> Result<()> {
        match self {
            QuarkBackend::Open(client) => client.put_object(key, content_type, body).await,
        }
    }
}

impl QuarkOpenClient {
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        pathname: &str,
        body: Option<Value>,
    ) -> Result<T> {
        let method_name = method.as_str().to_string();
        if self.needs_initial_refresh().await {
            self.refresh_token().await?;
        }
        self.ensure_open_credentials().await?;
        let (bytes, expired) = self
            .request_bytes(method.clone(), pathname, body.clone(), None)
            .await?;
        let bytes = if expired {
            self.refresh_token().await?;
            self.request_bytes(method, pathname, body, None).await?.0
        } else {
            bytes
        };
        serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "failed to decode quark open response for {} {}: {}",
                method_name,
                pathname,
                String::from_utf8_lossy(&bytes)
            )
        })
    }

    async fn request_with_sign<T: DeserializeOwned>(
        &self,
        method: Method,
        pathname: &str,
        body: Option<Value>,
        sign: (String, String, String),
    ) -> Result<T> {
        let method_name = method.as_str().to_string();
        if self.needs_initial_refresh().await {
            self.refresh_token().await?;
        }
        self.ensure_open_credentials().await?;
        let (bytes, expired) = self
            .request_bytes(method.clone(), pathname, body.clone(), Some(sign.clone()))
            .await?;
        let bytes = if expired {
            self.refresh_token().await?;
            self.request_bytes(method, pathname, body, Some(sign))
                .await?
                .0
        } else {
            bytes
        };
        serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "failed to decode quark open response for {} {}: {}",
                method_name,
                pathname,
                String::from_utf8_lossy(&bytes)
            )
        })
    }

    async fn request_bytes(
        &self,
        method: Method,
        pathname: &str,
        body: Option<Value>,
        sign: Option<(String, String, String)>,
    ) -> Result<(Bytes, bool)> {
        let (tm, token, req_id, app_id, access_token) = {
            let config = self.config.lock().await;
            let (tm, token, req_id) = sign.clone().unwrap_or_else(|| {
                generate_open_req_sign(method.as_str(), pathname, &config.sign_key)
            });
            (
                tm,
                token,
                req_id,
                config.app_id.clone(),
                config.access_token.clone(),
            )
        };
        let mut req = self
            .http
            .request(method.clone(), format!("{OPEN_API}{pathname}"))
            .header(header::ACCEPT, "application/json, text/plain, */*")
            .header("x-pan-tm", tm)
            .header("x-pan-token", token)
            .header("x-pan-client-id", app_id)
            .query(&[("req_id", req_id), ("access_token", access_token)]);
        if let Some(body) = body.clone() {
            req = req.json(&body);
        }
        let res = req.send().await?;
        let status = res.status();
        let bytes = res.bytes().await?;
        let expired = quark_open_response_expired(status, &bytes)?;
        if expired {
            return Ok((bytes, true));
        }
        if !status.is_success() {
            bail!(
                "quark open api http {}: {}",
                status,
                String::from_utf8_lossy(&bytes)
            );
        }
        let api: OpenStatus = serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "invalid quark open response: {}",
                String::from_utf8_lossy(&bytes)
            )
        })?;
        if api.status >= 400 || api.errno != 0 {
            bail!(
                "quark open api error status={} errno={}: {}",
                api.status,
                api.errno,
                api.error_info
            );
        }
        Ok((bytes, false))
    }

    async fn needs_initial_refresh(&self) -> bool {
        let config = self.config.lock().await;
        config.access_token.is_empty() || config.app_id.is_empty() || config.sign_key.is_empty()
    }

    async fn ensure_open_credentials(&self) -> Result<()> {
        let config = self.config.lock().await;
        if config.access_token.is_empty() {
            bail!("quark_open needs access_token; refresh did not return one");
        }
        if config.app_id.is_empty() {
            bail!("quark_open needs options.app_id; refresh did not return one");
        }
        if config.sign_key.is_empty() {
            bail!("quark_open needs options.sign_key; refresh did not return one");
        }
        Ok(())
    }

    async fn refresh_token(&self) -> Result<()> {
        let (refresh_url, refresh_token) = {
            let config = self.config.lock().await;
            (config.refresh_url.clone(), config.refresh_token.clone())
        };
        let resp = self.refresh_token_at(&refresh_url, &refresh_token).await?;
        if resp.refresh_token.is_empty() || resp.access_token.is_empty() {
            bail!(
                "failed to refresh quark open token: {}",
                if resp.error_message.is_empty() {
                    "empty token returned"
                } else {
                    resp.error_message.as_str()
                }
            );
        }
        let snapshot = {
            let mut config = self.config.lock().await;
            config.refresh_token = resp.refresh_token;
            config.access_token = resp.access_token;
            if !resp.app_id.is_empty() {
                config.app_id = resp.app_id;
            }
            if !resp.sign_key.is_empty() {
                config.sign_key = resp.sign_key;
            }
            config.clone()
        };
        self.save_config_snapshot(&snapshot).await?;
        Ok(())
    }

    async fn save_config_snapshot(&self, snapshot: &QuarkOpenConfig) -> Result<()> {
        let mut service_config = self.service_config.write().await;
        let Some(mount) = service_config
            .mounts
            .iter_mut()
            .find(|mount| mount.mount_type == "quark_open" && mount.path == self.path)
        else {
            bail!("quark_open mount {} no longer exists", self.path);
        };
        mount.options = serde_json::to_value(snapshot)?;
        save_config_to_db(&self.db_path, &service_config)?;
        Ok(())
    }

    async fn refresh_token_at(
        &self,
        refresh_url: &str,
        refresh_token: &str,
    ) -> Result<OpenRefreshResp> {
        if is_fnnas_quark_refresh_url(refresh_url) {
            let resp: DirectOpenRefreshResp = self
                .http
                .post(refresh_url)
                .json(&json!({
                    "authType": 4,
                    "refreshToken": refresh_token,
                    "trimAppId": "com.trim.cloudstorage",
                }))
                .send()
                .await?
                .json()
                .await?;
            let Some(data) = resp.data else {
                return Ok(OpenRefreshResp {
                    refresh_token: String::new(),
                    access_token: String::new(),
                    app_id: String::new(),
                    sign_key: String::new(),
                    error_message: resp.msg,
                });
            };
            return Ok(OpenRefreshResp {
                refresh_token: data.token_info.refresh_token,
                access_token: data.token_info.access_token,
                app_id: data.token_info.app_id,
                sign_key: data.token_info.sign_key,
                error_message: resp.msg,
            });
        }

        Ok(self
            .http
            .get(refresh_url)
            .query(&[
                ("refresh_ui", refresh_token.to_string()),
                ("server_use", "true".to_string()),
                ("driver_txt", "quarkyun_oa".to_string()),
            ])
            .send()
            .await?
            .json()
            .await?)
    }

    async fn user_id(&self) -> Result<String> {
        let resp: OpenUserInfoResp = self
            .request(Method::GET, "/open/v1/user/info", None)
            .await?;
        if resp.data.user_id.is_empty() {
            bail!("quark open did not return user_id");
        }
        Ok(resp.data.user_id)
    }

    async fn list_files(&self, parent_fid: &str) -> Result<Vec<QuarkFile>> {
        let mut files = Vec::new();
        let mut cursor: Option<OpenQueryCursor> = None;
        loop {
            let mut body = json!({
                "parent_fid": parent_fid,
                "size": 100,
                "sort": "file_name:asc",
            });
            if let Some(cursor) = cursor.clone() {
                body["query_cursor"] = serde_json::to_value(cursor)?;
            }
            let resp: OpenFileListResp = self
                .request(Method::POST, "/open/v1/file/list", Some(body))
                .await?;
            files.extend(resp.data.file_list.into_iter().map(open_file_to_quark_file));
            if resp.data.last_page {
                break;
            }
            cursor = resp.data.next_query_cursor;
            if cursor.as_ref().is_none_or(|cursor| cursor.token.is_empty()) {
                break;
            }
        }
        Ok(files)
    }

    async fn mkdir(&self, parent_fid: &str, name: &str) -> Result<()> {
        self.request::<Value>(
            Method::POST,
            "/open/v1/dir",
            Some(json!({
                "dir_path": name,
                "pdir_fid": parent_fid,
            })),
        )
        .await?;
        Ok(())
    }

    async fn resolve_dir(&self, path: &str, create: bool) -> Result<String> {
        let mut parent = self.config.lock().await.root_fid.clone();
        for part in path.split('/').filter(|p| !p.is_empty()) {
            let files = self.list_files(&parent).await?;
            if let Some(dir) = files.iter().find(|f| !f.file && f.file_name == part) {
                parent = dir.fid.clone();
                continue;
            }
            if !create {
                bail!("directory not found: {path}");
            }
            self.mkdir(&parent, part).await?;
            sleep(Duration::from_secs(1)).await;
            let files = self.list_files(&parent).await?;
            let dir = files
                .into_iter()
                .find(|f| !f.file && f.file_name == part)
                .ok_or_else(|| anyhow!("created directory did not appear: {part}"))?;
            parent = dir.fid;
        }
        Ok(parent)
    }

    async fn find_object(&self, key: &str) -> Result<Option<QuarkFile>> {
        let key = key.trim_matches('/');
        if key.is_empty() {
            return Ok(None);
        }
        let (dir, name) = split_key(key);
        let parent = match self.resolve_dir(dir, false).await {
            Ok(fid) => fid,
            Err(_) => return Ok(None),
        };
        let files = self.list_files(&parent).await?;
        Ok(files.into_iter().find(|f| f.file_name == name))
    }

    async fn download_url(&self, fid: &str) -> Result<String> {
        let resp: OpenDownloadResp = self
            .request(
                Method::POST,
                "/open/v1/file/get_download_url",
                Some(json!({ "fid": fid })),
            )
            .await?;
        if resp.data.download_url.is_empty() {
            bail!("quark open did not return a download URL");
        }
        Ok(resp.data.download_url)
    }

    async fn auth_cookie(&self) -> String {
        let config = self.config.lock().await;
        format!(
            "x_pan_client_id={}; x_pan_access_token={}",
            config.app_id, config.access_token
        )
    }

    async fn delete_fid(&self, fid: &str) -> Result<()> {
        self.request::<Value>(
            Method::POST,
            "/open/v1/file/delete",
            Some(json!({
                "action_type": 1,
                "fid_list": [fid],
            })),
        )
        .await?;
        Ok(())
    }

    async fn put_object(&self, key: &str, content_type: &str, body: Bytes) -> Result<()> {
        if let Some(existing) = self.find_object(key).await? {
            self.delete_fid(&existing.fid).await?;
        }
        let (dir, name) = split_key(key);
        let parent = self.resolve_dir(dir, true).await?;
        let md5_hex = format!("{:x}", md5::compute(&body));
        let sha1_hex = hex::encode(Sha1::digest(&body));
        let upload_pre_sign = {
            let config = self.config.lock().await;
            generate_open_req_sign("POST", "/open/v1/file/upload_pre", &config.sign_key)
        };
        let (proof_seed1, proof_seed2, proof_code1, proof_code2) =
            self.upload_proof_codes(&body, &upload_pre_sign.1).await?;
        let now = chrono_millis();
        let pre: OpenUploadPreResp = self
            .request_with_sign(
                Method::POST,
                "/open/v1/file/upload_pre",
                Some(json!({
                    "file_name": name,
                    "size": body.len(),
                    "format_type": content_type,
                    "md5": md5_hex,
                    "sha1": sha1_hex,
                    "l_created_at": now,
                    "l_updated_at": now,
                    "pdir_fid": parent,
                    "same_path_reuse": true,
                    "proof_version": "v1",
                    "proof_seed1": proof_seed1,
                    "proof_seed2": proof_seed2,
                    "proof_code1": proof_code1,
                    "proof_code2": proof_code2,
                })),
                upload_pre_sign,
            )
            .await?;
        if pre.data.finish {
            return Ok(());
        }
        let part_size = pre.data.part_size.max(1024 * 1024) as usize;
        let part_info = body
            .chunks(part_size)
            .enumerate()
            .map(|(idx, chunk)| {
                json!({
                    "part_number": idx + 1,
                    "part_size": chunk.len(),
                })
            })
            .collect::<Vec<_>>();
        let urls: OpenUploadUrlsResp = self
            .request(
                Method::POST,
                "/open/v1/file/get_upload_urls",
                Some(json!({
                    "task_id": pre.data.task_id,
                    "part_info_list": part_info,
                })),
            )
            .await?;
        let mut etags = Vec::new();
        for chunk in body.chunks(part_size) {
            let info = urls
                .data
                .upload_urls
                .get(etags.len())
                .ok_or_else(|| anyhow!("missing upload URL for part {}", etags.len() + 1))?;
            let res = self
                .http
                .put(&info.upload_url)
                .header(header::AUTHORIZATION, &info.signature_info.signature)
                .header("X-Oss-Date", &urls.data.common_headers.x_oss_date)
                .header(
                    "X-Oss-Content-Sha256",
                    &urls.data.common_headers.x_oss_content_sha256,
                )
                .header(header::ACCEPT_ENCODING, "gzip")
                .body(Bytes::copy_from_slice(chunk))
                .send()
                .await?;
            if !res.status().is_success() {
                bail!(
                    "quark open upload part {} failed {}: {}",
                    info.part_number,
                    res.status(),
                    res.text().await?
                );
            }
            etags.push(
                res.headers()
                    .get(header::ETAG)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string(),
            );
        }
        let part_info_list = part_info
            .into_iter()
            .zip(etags)
            .map(|(mut part, etag)| {
                part["etag"] = Value::String(etag);
                part
            })
            .collect::<Vec<_>>();
        let finish: OpenUploadFinishResp = self
            .request(
                Method::POST,
                "/open/v1/file/upload_finish",
                Some(json!({
                    "task_id": pre.data.task_id,
                    "part_info_list": part_info_list,
                })),
            )
            .await?;
        if !finish.data.finish {
            bail!("quark open upload finish did not complete");
        }
        self.wait_until_visible(key, body.len() as i64).await
    }

    async fn wait_until_visible(&self, key: &str, expected_size: i64) -> Result<()> {
        for _ in 0..20 {
            if let Some(file) = self.find_object(key).await?
                && file.file
                && file.size == expected_size
            {
                return Ok(());
            }
            sleep(Duration::from_millis(500)).await;
        }
        bail!("uploaded object is not visible yet")
    }

    async fn upload_proof_codes(
        &self,
        body: &Bytes,
        x_pan_token: &str,
    ) -> Result<(String, String, String, String)> {
        let user_id = self.user_id().await?;
        let proof_seed1 = format!("{:x}", md5::compute(format!("{user_id}{x_pan_token}")));
        let proof_seed2 = format!("{:x}", md5::compute(body.len().to_string()));
        let proof_code1 = proof_code(body, &proof_seed1)?;
        let proof_code2 = proof_code(body, &proof_seed2)?;
        Ok((proof_seed1, proof_seed2, proof_code1, proof_code2))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let db_path = config_db_path()?;
    let multipart_dir = multipart_dir_path();
    std::fs::create_dir_all(&multipart_dir)?;
    let cache_dir = cache_dir_path();
    std::fs::create_dir_all(&cache_dir)?;
    let config = load_or_init_config(&db_path)?;
    let root_key = env::var("ATREE_ROOT_KEY").ok();
    if root_key.is_none() {
        warn!("ATREE_ROOT_KEY is not set; only explicit auth rules will grant access");
    }
    let bind: SocketAddr = env::var("BIND")
        .unwrap_or_else(|_| "127.0.0.1:9000".into())
        .parse()?;

    let state = AppState {
        config: Arc::new(RwLock::new(config)),
        db_path,
        root_key,
        cache_dir,
        multipart_dir,
    };
    let app = build_app(state);
    let listener = TcpListener::bind(bind).await?;
    info!("serving atree at http://{bind}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn multipart_dir_path() -> PathBuf {
    env::var("ATREE_MULTIPART_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir().join("atree").join("multipart"))
}

fn cache_dir_path() -> PathBuf {
    env::var("ATREE_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir().join("atree").join("cache"))
}

async fn state_bucket(state: &AppState) -> String {
    state.config.read().await.s3_bucket.clone()
}

async fn state_config_path(state: &AppState) -> String {
    state
        .config
        .read()
        .await
        .mounts
        .iter()
        .rev()
        .find(|mount| mount.mount_type == "system_config")
        .map(|mount| mount.path.clone())
        .unwrap_or_else(|| "/api/config.yaml".to_string())
}

fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/", any(root_handler))
        .route("/{*path}", any(object_handler))
        .layer(DefaultBodyLimit::disable())
        .with_state(state)
}

fn normalize_tree_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return "/".to_string();
    }
    format!("/{}", trimmed.trim_matches('/'))
}

fn has_virtual_directory(config: &ServiceConfig, virtual_path: &str) -> bool {
    let current = normalize_tree_path(virtual_path);
    if current == "/" {
        return true;
    }
    let prefix = format!("{}/", current.trim_end_matches('/'));
    config
        .mounts
        .iter()
        .map(|mount| normalize_tree_path(&mount.path))
        .any(|path| path == current || path.starts_with(&prefix))
}

fn is_list_query(params: &HashMap<String, String>) -> bool {
    params.contains_key("list-type")
        || params.contains_key("prefix")
        || params.contains_key("delimiter")
        || params.contains_key("max-keys")
        || params.contains_key("marker")
        || params.contains_key("continuation-token")
}

fn is_s3_path_style_request(
    method: &Method,
    headers: &HeaderMap,
    params: &HashMap<String, String>,
) -> bool {
    if is_list_query(params)
        || params.contains_key("location")
        || params.contains_key("uploads")
        || params.contains_key("uploadId")
        || params.contains_key("partNumber")
    {
        return true;
    }
    if !matches!(method, &Method::GET) {
        return true;
    }
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("AWS4-HMAC-SHA256"))
    {
        return true;
    }
    headers
        .keys()
        .any(|name| name.as_str().starts_with("x-amz-"))
}

fn request_virtual_path(
    decoded_path: &str,
    has_trailing_slash: bool,
    bucket: &str,
    method: &Method,
    headers: &HeaderMap,
    params: &HashMap<String, String>,
) -> String {
    let mut path = decoded_path.trim_matches('/').to_string();
    if is_s3_path_style_request(method, headers, params) {
        let bucket = bucket.trim_matches('/');
        if path == bucket {
            path.clear();
        } else if let Some(rest) = path.strip_prefix(&format!("{bucket}/")) {
            path = rest.to_string();
        }
    }
    if path.is_empty() {
        return "/".to_string();
    }
    if has_trailing_slash {
        format!("/{}/", path.trim_matches('/'))
    } else {
        format!("/{}", path.trim_matches('/'))
    }
}

fn is_bucket_root_request(
    decoded_path: &str,
    bucket: &str,
    method: &Method,
    headers: &HeaderMap,
    params: &HashMap<String, String>,
) -> bool {
    is_s3_path_style_request(method, headers, params)
        && decoded_path.trim_matches('/') == bucket.trim_matches('/')
}

async fn root_handler(
    State(state): State<AppState>,
    RawQuery(raw_query): RawQuery,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let _bucket = state_bucket(&state).await;
    let config_path = state_config_path(&state).await;
    let raw_query = raw_query.unwrap_or_default();
    let params = parse_query(&raw_query);
    if method == Method::HEAD {
        return StatusCode::OK.into_response();
    }
    if method != Method::GET {
        return s3_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "MethodNotAllowed",
            "unsupported method",
        );
    }
    if method == Method::GET && wants_html(&headers) {
        return html_response(StatusCode::OK, file_browser_html(&config_path));
    }
    if params.contains_key("location") {
        return xml_response(
            StatusCode::OK,
            r#"<?xml version="1.0" encoding="UTF-8"?>
<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>"#
                .to_string(),
        );
    }
    if is_list_query(&params) {
        return list_objects(state, raw_query, "/", &headers).await;
    }
    list_objects(state, raw_query, "/", &headers).await
}

async fn config_handler(
    state: &AppState,
    method: Method,
    headers: &HeaderMap,
    body: Bytes,
    virtual_path: &str,
) -> Response {
    let public_base_url = request_public_base_url(headers);
    match method {
        Method::GET => {
            if !is_authorized(state, headers, "GetObject", virtual_path).await {
                let bucket = state_bucket(state).await;
                return access_denied_response(state, headers, &bucket).await;
            }
            let config = state.config.read().await.clone();
            match commented_yaml(&config, &public_base_url, virtual_path) {
                Ok(yaml) => yaml_response(StatusCode::OK, yaml),
                Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
            }
        }
        Method::PUT => {
            if !is_authorized(state, headers, "PutObject", virtual_path).await {
                let bucket = state_bucket(state).await;
                return access_denied_response(state, headers, &bucket).await;
            }
            let config: ServiceConfig = match parse_config_yaml(&body) {
                Ok(config) => config,
                Err(err) => return json_error(StatusCode::BAD_REQUEST, &err.to_string()),
            };
            let config = match normalize_config(config) {
                Ok(config) => config,
                Err(err) => return json_error(StatusCode::BAD_REQUEST, &err.to_string()),
            };
            if let Err(err) = save_config_to_db(&state.db_path, &config) {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string());
            }
            *state.config.write().await = config.clone();
            clear_cache_dir(state).await;
            let config_path = state_config_path(state).await;
            match commented_yaml(&config, &public_base_url, &config_path) {
                Ok(yaml) => yaml_response(StatusCode::OK, yaml),
                Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
            }
        }
        _ => json_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "supported methods are GET and PUT",
        ),
    }
}

async fn system_file_handler(
    state: &AppState,
    method: Method,
    headers: &HeaderMap,
    body: Bytes,
    virtual_path: &str,
) -> Response {
    config_handler(state, method, headers, body, virtual_path).await
}

fn request_public_base_url(headers: &HeaderMap) -> String {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(',').next().unwrap_or(value).trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("http");
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(',').next().unwrap_or(value).trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1:9000");
    format!("{scheme}://{host}")
}

async fn object_handler(
    State(state): State<AppState>,
    Path(path): Path<String>,
    RawQuery(raw_query): RawQuery,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let bucket = state_bucket(&state).await;
    let path = percent_decode_path(&path);
    let has_trailing_slash = path.ends_with('/') && !path.is_empty();
    let raw_query = raw_query.unwrap_or_default();
    let params = parse_query(&raw_query);
    let virtual_path = request_virtual_path(
        &path,
        has_trailing_slash,
        &bucket,
        &method,
        &headers,
        &params,
    );
    let is_bucket_root = is_bucket_root_request(&path, &bucket, &method, &headers, &params);
    if is_bucket_root {
        if params.contains_key("location") {
            return xml_response(
                StatusCode::OK,
                r#"<?xml version="1.0" encoding="UTF-8"?>
<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>"#
                    .to_string(),
            );
        }
        if method == Method::HEAD {
            return StatusCode::OK.into_response();
        }
        if method == Method::PUT && params.keys().all(|key| key == "x-id") {
            if !is_authorized(&state, &headers, "PutObject", "/").await {
                return access_denied_response(&state, &headers, &bucket).await;
            }
            return StatusCode::OK.into_response();
        }
    }
    if method == Method::GET && wants_html(&headers) {
        if let Some(response) = browser_directory_index(&state, &virtual_path, &headers).await {
            return response;
        }
        let config = state.config.read().await;
        let is_virtual_dir = has_virtual_directory(&config, &virtual_path);
        drop(config);
        if is_virtual_dir || has_trailing_slash {
            return browser_directory(&state, &virtual_path, &headers, true).await;
        }
    }
    if virtual_path == "/" {
        if is_list_query(&params) {
            return list_objects(state, raw_query, &virtual_path, &headers).await;
        }
        return s3_error(StatusCode::NOT_FOUND, "NoSuchKey", "key not found");
    }
    if method == Method::GET && (has_trailing_slash || is_list_query(&params)) {
        return list_objects(state, raw_query, &virtual_path, &headers).await;
    }
    if method == Method::HEAD && has_trailing_slash {
        return StatusCode::OK.into_response();
    }
    if method == Method::PUT && has_trailing_slash {
        return s3_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "MethodNotAllowed",
            "unsupported method",
        );
    }

    let config = state.config.read().await;
    let resolved_mount = resolve_mount(&config, &virtual_path);
    let action = match method {
        Method::GET => "GetObject",
        Method::HEAD => "HeadObject",
        Method::PUT | Method::POST => "PutObject",
        Method::DELETE => "DeleteObject",
        _ => "Unknown",
    };
    if !is_authorized(&state, &headers, action, &virtual_path).await {
        return access_denied_response(&state, &headers, &bucket).await;
    }
    let mount = match resolved_mount {
        Some(mount) => mount,
        None => return s3_error(StatusCode::NOT_FOUND, "NoSuchKey", "mount not found"),
    };
    let (remote_key, backend) = match mount {
        ResolvedMount::QuarkOpen {
            remote_key,
            config: quark_config,
            path,
        } => {
            drop(config);
            let quark = match quark_open_client(
                quark_config,
                &path,
                state.db_path.clone(),
                state.config.clone(),
            ) {
                Ok(quark) => quark,
                Err(err) => {
                    return s3_error(StatusCode::BAD_REQUEST, "InvalidConfig", &err.to_string());
                }
            };
            (remote_key, QuarkBackend::Open(quark))
        }
        ResolvedMount::SystemConfig { virtual_path } => {
            drop(config);
            return system_file_handler(&state, method, &headers, body, &virtual_path).await;
        }
        ResolvedMount::UrlTree { url, proxy, size } => {
            drop(config);
            return url_object(method, &headers, &virtual_path, url, proxy, size).await;
        }
        ResolvedMount::GithubReleases {
            rest,
            config: release_config,
        } => {
            let github_release_mounts = if matches!(method, Method::GET | Method::HEAD) {
                resolve_github_release_mounts(&config, &virtual_path)
            } else {
                Vec::new()
            };
            drop(config);
            if github_release_mounts.len() > 1 {
                return github_releases_object_any(
                    &state,
                    method,
                    &headers,
                    &virtual_path,
                    github_release_mounts,
                )
                .await;
            }
            return github_releases_object(
                &state,
                method,
                &headers,
                &virtual_path,
                rest,
                release_config,
            )
            .await;
        }
        ResolvedMount::S3 {
            remote_key,
            config: s3_config,
        } => {
            drop(config);
            return s3_object(
                &state,
                method,
                &headers,
                body,
                &virtual_path,
                remote_key,
                s3_config,
            )
            .await;
        }
    };
    if method == Method::POST && params.contains_key("uploads") {
        return initiate_multipart_upload(&state, &path, &remote_key).await;
    }
    if method == Method::PUT && params.contains_key("uploadId") && params.contains_key("partNumber")
    {
        return upload_multipart_part(&state, &params, body).await;
    }
    if method == Method::POST && params.contains_key("uploadId") {
        return complete_multipart_upload(&state, &backend, &path, &remote_key, &params).await;
    }
    if method == Method::DELETE && params.contains_key("uploadId") {
        return abort_multipart_upload(&state, &params).await;
    }
    let result = match method {
        Method::GET => {
            get_object_cached(&state, &backend, &virtual_path, &remote_key, &headers).await
        }
        Method::HEAD => head_object_cached(&state, &backend, &virtual_path, &remote_key).await,
        Method::PUT => {
            let body = match decode_request_body(&headers, body) {
                Ok(body) => body,
                Err(err) => return s3_error_for(&err),
            };
            let etag = format!("\"{:x}\"", md5::compute(&body));
            let content_type = headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    mime_guess::from_path(&remote_key)
                        .first_or_octet_stream()
                        .essence_str()
                        .to_string()
                });
            backend
                .put_object(&remote_key, &content_type, body)
                .await
                .map(|_| {
                    let state = state.clone();
                    let virtual_path = virtual_path.to_string();
                    tokio::spawn(async move {
                        invalidate_cached_object(&state, &virtual_path).await;
                        clear_cache_dir(&state).await;
                    });
                    (StatusCode::OK, [(header::ETAG, etag)]).into_response()
                })
        }
        Method::DELETE => delete_object_cached(&state, &backend, &virtual_path, &remote_key).await,
        _ => Ok(s3_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "MethodNotAllowed",
            "unsupported method",
        )),
    };
    match result {
        Ok(resp) => resp,
        Err(err) => {
            warn!("request failed: {err:#}");
            s3_error_for(&err)
        }
    }
}

async fn list_objects(
    state: AppState,
    raw_query: String,
    base_virtual_path: &str,
    headers: &HeaderMap,
) -> Response {
    let bucket = state_bucket(&state).await;
    let params = parse_query(&raw_query);
    let requested_prefix = params.get("prefix").cloned().unwrap_or_default();
    let base_prefix = base_virtual_path.trim_matches('/');
    let prefix = if requested_prefix.is_empty() && !base_prefix.is_empty() {
        format!("{base_prefix}/")
    } else {
        requested_prefix
    };
    let virtual_prefix = format!("/{}", prefix.trim_matches('/'));
    let delimiter = params.get("delimiter").cloned();
    let max_keys = params
        .get("max-keys")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1000)
        .max(1);
    let offset = params
        .get("continuation-token")
        .or_else(|| params.get("marker"))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let s3_continuation_token = params
        .get("continuation-token")
        .or_else(|| params.get("marker"))
        .cloned();
    let dir_path = if delimiter.as_deref() == Some("/") {
        prefix.trim_end_matches('/').to_string()
    } else {
        prefix.clone()
    };

    let principal = resolve_principal(&state, headers).await;
    let config = state.config.read().await;
    if !policy_allows(&config, &principal, "ListBucket", &virtual_prefix) {
        drop(config);
        return access_denied_response(&state, headers, &bucket).await;
    }
    drop(config);

    let list_cache_key = tree_list_cache_key(
        &bucket,
        &principal,
        &virtual_prefix,
        &prefix,
        delimiter.as_deref(),
        max_keys,
        offset,
    );
    if let Some(cached) = read_cached_object(&state, &list_cache_key).await {
        return cached_list_response(cached);
    }

    let config = state.config.read().await;
    let github_release_mounts = resolve_github_release_mounts(&config, &virtual_prefix);
    if !github_release_mounts.is_empty()
        && github_release_mounts
            .iter()
            .all(|(rest, _)| rest.trim_matches('/').is_empty())
    {
        let (synthetic_entries, synthetic_prefixes) =
            synthetic_mount_listing(&config, &principal, &prefix, delimiter.as_deref());
        drop(config);
        return list_github_releases_many(
            &state,
            Some(&list_cache_key),
            github_release_mounts
                .into_iter()
                .map(|(_, config)| config)
                .collect(),
            &bucket,
            &prefix,
            delimiter.as_deref(),
            max_keys,
            offset,
            synthetic_entries,
            synthetic_prefixes,
        )
        .await;
    }
    let (remote_dir, backend) = match resolve_mount(&config, &virtual_prefix) {
        Some(ResolvedMount::QuarkOpen {
            remote_key,
            config: quark_config,
            path,
        }) => {
            let quark = match quark_open_client(
                quark_config,
                &path,
                state.db_path.clone(),
                state.config.clone(),
            ) {
                Ok(quark) => quark,
                Err(err) => {
                    return s3_error(StatusCode::BAD_REQUEST, "InvalidConfig", &err.to_string());
                }
            };
            (remote_key, QuarkBackend::Open(quark))
        }
        Some(ResolvedMount::GithubReleases { rest, config }) => {
            if rest.trim_matches('/').is_empty() {
                return list_github_releases(
                    &state,
                    Some(&list_cache_key),
                    &config,
                    headers,
                    &bucket,
                    &prefix,
                )
                .await;
            }
            return list_xml_cached(
                &state,
                &list_cache_key,
                &bucket,
                &prefix,
                delimiter.as_deref(),
                max_keys,
                None,
                Vec::new(),
                Vec::new(),
            )
            .await;
        }
        Some(ResolvedMount::S3 {
            remote_key,
            config: s3_config,
        }) => {
            let synthetic_listing =
                synthetic_mount_listing(&config, &principal, &prefix, delimiter.as_deref());
            let hidden_listing_identities =
                hidden_mount_identities(&config, &principal, &prefix, delimiter.as_deref());
            drop(config);
            return list_s3_mount(
                &state,
                &list_cache_key,
                &bucket,
                &prefix,
                delimiter.as_deref(),
                max_keys,
                offset,
                s3_continuation_token.as_deref(),
                &virtual_prefix,
                remote_key,
                s3_config,
                synthetic_listing,
                hidden_listing_identities,
            )
            .await;
        }
        None => {
            let (entries, common_prefixes) =
                synthetic_mount_listing(&config, &principal, &prefix, delimiter.as_deref());
            if !entries.is_empty() || !common_prefixes.is_empty() {
                drop(config);
                let xml = list_xml_string(
                    &bucket,
                    &prefix,
                    delimiter.as_deref(),
                    entries,
                    common_prefixes,
                    max_keys,
                    None,
                );
                cache_list_xml(&state, &list_cache_key, &xml).await;
                return xml_response(StatusCode::OK, xml);
            }
            return list_xml_cached(
                &state,
                &list_cache_key,
                &bucket,
                &prefix,
                delimiter.as_deref(),
                max_keys,
                None,
                Vec::new(),
                Vec::new(),
            )
            .await;
        }
        _ => {
            return list_xml_cached(
                &state,
                &list_cache_key,
                &bucket,
                &prefix,
                delimiter.as_deref(),
                max_keys,
                None,
                Vec::new(),
                Vec::new(),
            )
            .await;
        }
    };
    drop(config);

    let parent = match backend.resolve_dir(&remote_dir, false).await {
        Ok(fid) => fid,
        Err(_) => {
            return list_xml_cached(
                &state,
                &list_cache_key,
                &bucket,
                &prefix,
                delimiter.as_deref(),
                max_keys,
                None,
                Vec::new(),
                Vec::new(),
            )
            .await;
        }
    };
    let recursive = delimiter.as_deref() != Some("/");
    let files = match list_files_for_s3(&backend, &parent, &dir_path, recursive).await {
        Ok(files) => files,
        Err(err) => return s3_error(StatusCode::BAD_GATEWAY, "QuarkError", &err.to_string()),
    };

    let mut objects = Vec::new();
    let mut common_prefixes = Vec::new();
    for (key, f) in files {
        if f.file {
            objects.push((key, f));
        } else {
            common_prefixes.push(format!("{key}/"));
        }
    }
    let total = objects.len() + common_prefixes.len();
    let next_token = if offset + max_keys < total {
        Some((offset + max_keys).to_string())
    } else {
        None
    };
    let objects_len = objects.len();
    let objects = objects
        .into_iter()
        .skip(offset)
        .take(max_keys)
        .collect::<Vec<_>>();
    let remaining = max_keys.saturating_sub(objects.len());
    let common_prefixes = common_prefixes
        .into_iter()
        .skip(offset.saturating_sub(objects_len))
        .take(remaining)
        .collect::<Vec<_>>();
    let entries = objects
        .into_iter()
        .map(|(key, f)| S3Entry {
            key,
            size: f.size,
            modified: f.updated_at.max(f.created_at),
        })
        .collect();
    let xml = list_xml_string(
        &bucket,
        &prefix,
        delimiter.as_deref(),
        entries,
        common_prefixes,
        max_keys,
        next_token.as_deref(),
    );
    cache_list_xml(&state, &list_cache_key, &xml).await;
    xml_response(StatusCode::OK, xml)
}

fn synthetic_mount_listing(
    config: &ServiceConfig,
    principal: &str,
    prefix: &str,
    delimiter: Option<&str>,
) -> (Vec<S3Entry>, Vec<String>) {
    if delimiter != Some("/") {
        return (Vec::new(), Vec::new());
    }
    let current = normalize_tree_path(prefix.trim_end_matches('/'));
    let mut entries = Vec::new();
    let mut common_prefixes = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for mount in &config.mounts {
        if mount.path == "/" {
            continue;
        }
        let normalized = normalize_tree_path(&mount.path);
        let rest = if current == "/" {
            normalized.trim_start_matches('/')
        } else {
            let current_prefix = format!("{}/", current.trim_end_matches('/'));
            let Some(rest) = normalized.strip_prefix(&current_prefix) else {
                continue;
            };
            rest
        };
        if rest.is_empty() {
            continue;
        }
        let Some(first) = rest.split('/').next().filter(|part| !part.is_empty()) else {
            continue;
        };
        if mount_hidden_from_parent(mount) {
            continue;
        }
        let key = if current == "/" {
            first.to_string()
        } else {
            format!("{}/{}", current.trim_start_matches('/'), first)
        };
        let resource = format!("/{}", key.trim_matches('/'));
        if !policy_allows(config, principal, "ListBucket", &resource) {
            continue;
        }
        if !seen.insert(key.clone()) {
            continue;
        }
        let is_file = synthetic_mount_is_file(mount, rest);
        if is_file {
            entries.push(S3Entry {
                key,
                size: drivers::options::u64(&mount.options, "size").unwrap_or(0) as i64,
                modified: chrono_millis(),
            });
        } else {
            common_prefixes.push(format!("{}/", key.trim_end_matches('/')));
        }
    }
    (entries, common_prefixes)
}

fn hidden_mount_identities(
    config: &ServiceConfig,
    principal: &str,
    prefix: &str,
    delimiter: Option<&str>,
) -> HashSet<String> {
    if delimiter != Some("/") {
        return HashSet::new();
    }
    let current = normalize_tree_path(prefix.trim_end_matches('/'));
    config
        .mounts
        .iter()
        .filter(|mount| {
            if mount.path == "/" {
                return false;
            }
            if mount_hidden_from_parent(mount) {
                return true;
            }
            let resource = normalize_tree_path(&mount.path);
            !policy_allows(config, principal, "ListBucket", &resource)
        })
        .filter_map(|mount| {
            let normalized = normalize_tree_path(&mount.path);
            let rest = if current == "/" {
                normalized.trim_start_matches('/')
            } else {
                let current_prefix = format!("{}/", current.trim_end_matches('/'));
                normalized.strip_prefix(&current_prefix)?
            };
            let first = rest.split('/').next().filter(|part| !part.is_empty())?;
            let key = if current == "/" {
                first.to_string()
            } else {
                format!("{}/{}", current.trim_start_matches('/'), first)
            };
            Some(listing_identity(&key))
        })
        .collect()
}

fn mount_hidden_from_parent(mount: &config::MountConfig) -> bool {
    mount_option_bool(&mount.options, "hide_from_parent")
}

fn mount_option_bool(options: &Value, key: &str) -> bool {
    options
        .get(key)
        .and_then(|value| {
            value.as_bool().or_else(|| {
                value
                    .as_str()
                    .map(|value| matches!(value, "true" | "yes" | "1"))
            })
        })
        .unwrap_or(false)
}

fn synthetic_mount_is_file(mount: &config::MountConfig, rest: &str) -> bool {
    if rest.contains('/') {
        return false;
    }
    if mount.mount_type == "system_config" {
        return true;
    }
    mount.mount_type == "url_tree"
        && rest.rsplit_once('.').is_some_and(|(_, ext)| {
            !ext.is_empty() && ext.chars().all(|ch| ch.is_ascii_alphanumeric())
        })
}

async fn list_s3_mount(
    state: &AppState,
    list_cache_key: &str,
    bucket: &str,
    prefix: &str,
    delimiter: Option<&str>,
    max_keys: usize,
    _offset: usize,
    continuation_token: Option<&str>,
    virtual_prefix: &str,
    remote_prefix: String,
    config: S3Config,
    synthetic_listing: (Vec<S3Entry>, Vec<String>),
    hidden_listing_identities: HashSet<String>,
) -> Response {
    let remote_delimiter = delimiter.filter(|value| *value == "/");
    let listing = match s3_list_objects(
        &config,
        &remote_prefix,
        remote_delimiter,
        max_keys,
        continuation_token,
    )
    .await
    {
        Ok(listing) => listing,
        Err(err) => return s3_error(StatusCode::BAD_GATEWAY, "S3Error", &err.to_string()),
    };
    let base_virtual = virtual_prefix.trim_matches('/');
    let base_remote = remote_prefix.trim_matches('/');
    let mut entries = listing
        .objects
        .into_iter()
        .map(|object| S3Entry {
            key: join_s3_tree_path(base_virtual, strip_s3_prefix(base_remote, &object.key)),
            size: object.size,
            modified: object.modified,
        })
        .collect::<Vec<_>>();
    let mut common_prefixes = listing
        .common_prefixes
        .into_iter()
        .map(|prefix| {
            let key = join_s3_tree_path(base_virtual, strip_s3_prefix(base_remote, &prefix));
            if key.is_empty() {
                String::new()
            } else {
                format!("{}/", key.trim_end_matches('/'))
            }
        })
        .filter(|prefix| !prefix.is_empty())
        .collect::<Vec<_>>();
    if !hidden_listing_identities.is_empty() {
        entries.retain(|entry| !hidden_listing_identities.contains(&listing_identity(&entry.key)));
        common_prefixes
            .retain(|prefix| !hidden_listing_identities.contains(&listing_identity(prefix)));
    }
    merge_later_listing(&mut entries, &mut common_prefixes, synthetic_listing);
    let xml = list_xml_string(
        bucket,
        prefix,
        delimiter,
        entries,
        common_prefixes,
        max_keys,
        listing.next_offset.as_deref(),
    );
    cache_list_xml(state, list_cache_key, &xml).await;
    xml_response(StatusCode::OK, xml)
}

fn merge_later_listing(
    entries: &mut Vec<S3Entry>,
    common_prefixes: &mut Vec<String>,
    later: (Vec<S3Entry>, Vec<String>),
) {
    let (later_entries, later_common_prefixes) = later;
    if later_entries.is_empty() && later_common_prefixes.is_empty() {
        return;
    }
    let mut overridden = std::collections::HashSet::new();
    for entry in &later_entries {
        overridden.insert(listing_identity(&entry.key));
    }
    for prefix in &later_common_prefixes {
        overridden.insert(listing_identity(prefix));
    }
    entries.retain(|entry| !overridden.contains(&listing_identity(&entry.key)));
    common_prefixes.retain(|prefix| !overridden.contains(&listing_identity(prefix)));
    entries.extend(later_entries);
    common_prefixes.extend(later_common_prefixes);
}

fn listing_identity(value: &str) -> String {
    value.trim_matches('/').to_string()
}

async fn s3_list_objects(
    config: &S3Config,
    prefix: &str,
    delimiter: Option<&str>,
    max_keys: usize,
    continuation_token: Option<&str>,
) -> Result<S3List> {
    let mut query = vec![
        ("list-type".to_string(), "2".to_string()),
        ("prefix".to_string(), s3_dir_prefix(prefix, delimiter)),
        ("max-keys".to_string(), max_keys.to_string()),
    ];
    if let Some(delimiter) = delimiter {
        query.push(("delimiter".to_string(), delimiter.to_string()));
    }
    if let Some(token) = continuation_token.filter(|token| !token.is_empty()) {
        query.push(("continuation-token".to_string(), token.to_string()));
    }
    let response = s3_send(
        config,
        Method::GET,
        "",
        Vec::new(),
        Bytes::new(),
        Some(query),
    )
    .await?;
    if !response.status().is_success() {
        return s3_upstream_error(response).await;
    }
    parse_s3_listing(&response.text().await?)
}

async fn s3_object(
    state: &AppState,
    method: Method,
    headers: &HeaderMap,
    body: Bytes,
    virtual_path: &str,
    remote_key: String,
    config: S3Config,
) -> Response {
    let result = match method {
        Method::GET => s3_get_object(&config, &remote_key, virtual_path, headers).await,
        Method::HEAD => s3_head_object(&config, &remote_key, virtual_path).await,
        Method::PUT => {
            let body = match decode_request_body(headers, body) {
                Ok(body) => body,
                Err(err) => return s3_error_for(&err),
            };
            let content_type = headers
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(ToString::to_string)
                .unwrap_or_else(|| {
                    mime_guess::from_path(&remote_key)
                        .first_or_octet_stream()
                        .essence_str()
                        .to_string()
                });
            s3_put_object(&config, &remote_key, &content_type, body).await
        }
        Method::DELETE => s3_delete_object(&config, &remote_key).await,
        _ => Ok(s3_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "MethodNotAllowed",
            "unsupported method",
        )),
    };
    match result {
        Ok(response) => {
            if matches!(method, Method::PUT | Method::DELETE) {
                invalidate_cached_object(state, virtual_path).await;
                clear_cache_dir(state).await;
            }
            response
        }
        Err(err) => {
            warn!("s3 backend request failed: {err:#}");
            s3_backend_error(&err)
        }
    }
}

async fn s3_head_object(config: &S3Config, key: &str, virtual_path: &str) -> Result<Response> {
    let response = s3_send(config, Method::HEAD, key, Vec::new(), Bytes::new(), None).await?;
    s3_passthrough_response(response, virtual_path, true).await
}

async fn s3_get_object(
    config: &S3Config,
    key: &str,
    virtual_path: &str,
    headers: &HeaderMap,
) -> Result<Response> {
    let mut extra_headers = Vec::new();
    if let Some(range) = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        extra_headers.push((header::RANGE.as_str().to_string(), range.to_string()));
    }
    let response = s3_send(config, Method::GET, key, extra_headers, Bytes::new(), None).await?;
    s3_passthrough_response(response, virtual_path, false).await
}

async fn s3_put_object(
    config: &S3Config,
    key: &str,
    content_type: &str,
    body: Bytes,
) -> Result<Response> {
    let etag = format!("\"{:x}\"", md5::compute(&body));
    let extra_headers = vec![(
        header::CONTENT_TYPE.as_str().to_string(),
        content_type.to_string(),
    )];
    let response = s3_send(config, Method::PUT, key, extra_headers, body, None).await?;
    if !response.status().is_success() {
        return s3_upstream_error(response).await;
    }
    Ok((StatusCode::OK, [(header::ETAG, etag)]).into_response())
}

async fn s3_delete_object(config: &S3Config, key: &str) -> Result<Response> {
    let response = s3_send(config, Method::DELETE, key, Vec::new(), Bytes::new(), None).await?;
    if !response.status().is_success() {
        return s3_upstream_error(response).await;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn s3_passthrough_response(
    response: reqwest::Response,
    virtual_path: &str,
    head_only: bool,
) -> Result<Response> {
    let status = response.status();
    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return s3_upstream_error(response).await;
    }
    let upstream_headers = response.headers().clone();
    let mut resp = if head_only {
        Response::new(Body::empty())
    } else {
        Response::new(Body::from_stream(
            response.bytes_stream().map_err(std::io::Error::other),
        ))
    };
    *resp.status_mut() = status;
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::LAST_MODIFIED,
        header::ETAG,
        header::CACHE_CONTROL,
        header::ACCEPT_RANGES,
        header::CONTENT_DISPOSITION,
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            resp.headers_mut().insert(name, value.clone());
        }
    }
    apply_browser_content_headers(&mut resp, virtual_path);
    Ok(resp)
}

async fn s3_upstream_error<T>(response: reqwest::Response) -> Result<T> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status == StatusCode::NOT_FOUND {
        bail!("object not found");
    }
    bail!("s3 backend returned {status}: {body}");
}

async fn s3_send(
    config: &S3Config,
    method: Method,
    key: &str,
    extra_headers: Vec<(String, String)>,
    body: Bytes,
    query: Option<Vec<(String, String)>>,
) -> Result<reqwest::Response> {
    if !config.path_style {
        bail!("s3 backend currently supports path_style endpoints only");
    }
    let client = http_client_with_proxy(config.proxy.as_deref())?;
    let mut url = Url::parse(config.endpoint.trim_end_matches('/'))?;
    url.set_path(&s3_path_style_path(&config.bucket, key));
    if let Some(query) = &query {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    let body_hash = sha256_hex(&body);
    let signed = s3_signed_headers(config, &method, &url, &extra_headers, &body_hash)?;
    let mut req = client.request(method, url).body(body);
    for (name, value) in extra_headers {
        req = req.header(name, value);
    }
    for (name, value) in signed {
        req = req.header(name, value);
    }
    Ok(req.send().await?)
}

fn s3_signed_headers(
    config: &S3Config,
    method: &Method,
    url: &Url,
    extra_headers: &[(String, String)],
    body_hash: &str,
) -> Result<Vec<(String, String)>> {
    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let host = url
        .host_str()
        .map(|host| {
            if let Some(port) = url.port() {
                format!("{host}:{port}")
            } else {
                host.to_string()
            }
        })
        .ok_or_else(|| anyhow!("s3 endpoint needs a host"))?;
    let mut headers = BTreeMap::new();
    headers.insert("host".to_string(), host);
    headers.insert("x-amz-content-sha256".to_string(), body_hash.to_string());
    headers.insert("x-amz-date".to_string(), amz_date.clone());
    if let Some(token) = config.session_token.as_deref() {
        headers.insert("x-amz-security-token".to_string(), token.to_string());
    }
    for (name, value) in extra_headers {
        headers.insert(name.to_ascii_lowercase(), value.trim().to_string());
    }
    let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical_headers = headers
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect::<String>();
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        s3_canonical_uri(url.path()),
        s3_canonical_query(url),
        canonical_headers,
        signed_headers,
        body_hash,
    );
    let scope = format!("{date}/{}/s3/aws4_request", config.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        scope,
        sha256_hex(canonical_request.as_bytes())
    );
    let signing_key = s3_signing_key(&config.secret_key, &date, &config.region);
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));
    let mut out = vec![
        ("x-amz-content-sha256".to_string(), body_hash.to_string()),
        ("x-amz-date".to_string(), amz_date),
        (
            header::AUTHORIZATION.as_str().to_string(),
            format!(
                "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
                config.access_key, scope, signed_headers, signature
            ),
        ),
    ];
    if let Some(token) = config.session_token.as_deref() {
        out.push(("x-amz-security-token".to_string(), token.to_string()));
    }
    Ok(out)
}

fn parse_s3_listing(xml: &str) -> Result<S3List> {
    let objects = xml_blocks(xml, "Contents")
        .into_iter()
        .filter_map(|block| {
            let key = xml_tag_text(block, "Key")?;
            let size = xml_tag_text(block, "Size")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0);
            let modified = xml_tag_text(block, "LastModified")
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
                .map(|value| value.timestamp_millis())
                .unwrap_or_else(chrono_millis);
            Some(S3Object {
                key,
                size,
                modified,
                content_type: None,
            })
        })
        .collect();
    let common_prefixes = xml_blocks(xml, "CommonPrefixes")
        .into_iter()
        .filter_map(|block| xml_tag_text(block, "Prefix"))
        .collect();
    let next_offset =
        xml_tag_text(xml, "NextContinuationToken").or_else(|| xml_tag_text(xml, "NextMarker"));
    Ok(S3List {
        objects,
        common_prefixes,
        next_offset,
    })
}

fn xml_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut rest = xml;
    let mut blocks = Vec::new();
    while let Some(start) = rest.find(&open) {
        let after_open = &rest[start + open.len()..];
        let Some(end) = after_open.find(&close) else {
            break;
        };
        blocks.push(&after_open[..end]);
        rest = &after_open[end + close.len()..];
    }
    blocks
}

fn xml_tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml_unescape(&xml[start..end]))
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn s3_backend_error(err: &anyhow::Error) -> Response {
    let message = err.to_string();
    if message.contains("object not found") {
        s3_error(StatusCode::NOT_FOUND, "NoSuchKey", "object not found")
    } else {
        s3_error(StatusCode::BAD_GATEWAY, "S3Error", &message)
    }
}

fn s3_dir_prefix(prefix: &str, delimiter: Option<&str>) -> String {
    let prefix = prefix.trim_matches('/');
    if delimiter == Some("/") && !prefix.is_empty() {
        format!("{prefix}/")
    } else {
        prefix.to_string()
    }
}

fn s3_path_style_path(bucket: &str, key: &str) -> String {
    let mut path = format!("/{bucket}");
    for segment in key
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
    {
        path.push('/');
        path.push_str(segment);
    }
    path
}

fn s3_canonical_uri(path: &str) -> String {
    if path.is_empty() {
        return "/".to_string();
    }
    path.to_string()
}

fn s3_canonical_query(url: &Url) -> String {
    let mut pairs = url.query_pairs().into_owned().collect::<Vec<_>>();
    pairs.sort();
    pairs
        .into_iter()
        .map(|(key, value)| format!("{}={}", s3_encode_query(&key), s3_encode_query(&value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn s3_encode_path_segment(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn s3_encode_query(value: &str) -> String {
    s3_encode_path_segment(value)
}

fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

fn s3_signing_key(secret_key: &str, date: &str, region: &str) -> Vec<u8> {
    let date_key = hmac_sha256(format!("AWS4{secret_key}").as_bytes(), date.as_bytes());
    let date_region_key = hmac_sha256(&date_key, region.as_bytes());
    let date_region_service_key = hmac_sha256(&date_region_key, b"s3");
    hmac_sha256(&date_region_service_key, b"aws4_request")
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    const BLOCK_SIZE: usize = 64;
    let mut key_block = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let digest = Sha256::digest(key);
        key_block[..digest.len()].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut outer = [0x5cu8; BLOCK_SIZE];
    let mut inner = [0x36u8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        outer[i] ^= key_block[i];
        inner[i] ^= key_block[i];
    }
    let mut inner_hasher = Sha256::new();
    inner_hasher.update(inner);
    inner_hasher.update(message);
    let inner_hash = inner_hasher.finalize();
    let mut outer_hasher = Sha256::new();
    outer_hasher.update(outer);
    outer_hasher.update(inner_hash);
    outer_hasher.finalize().to_vec()
}

fn join_s3_tree_path(base: &str, rest: &str) -> String {
    let base = base.trim_matches('/');
    let rest = rest.trim_matches('/');
    match (base.is_empty(), rest.is_empty()) {
        (true, true) => String::new(),
        (true, false) => rest.to_string(),
        (false, true) => base.to_string(),
        (false, false) => format!("{base}/{rest}"),
    }
}

fn strip_s3_prefix<'a>(base: &str, key: &'a str) -> &'a str {
    let base = base.trim_matches('/');
    if base.is_empty() {
        return key.trim_start_matches('/');
    }
    key.trim_start_matches('/')
        .strip_prefix(base)
        .unwrap_or(key)
        .trim_start_matches('/')
}

async fn list_files_for_s3(
    backend: &QuarkBackend,
    parent: &str,
    dir_path: &str,
    recursive: bool,
) -> Result<Vec<(String, QuarkFile)>> {
    let base_prefix = if dir_path.is_empty() {
        String::new()
    } else {
        format!("{}/", dir_path.trim_matches('/'))
    };
    let mut out = Vec::new();
    let mut stack = vec![(parent.to_string(), base_prefix)];
    while let Some((fid, base)) = stack.pop() {
        for f in backend.list_files(&fid).await? {
            let key = format!("{base}{}", f.file_name);
            if recursive && !f.file {
                stack.push((f.fid.clone(), format!("{key}/")));
            } else {
                out.push((key, f));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

async fn head_object(backend: &QuarkBackend, key: &str) -> Result<Response> {
    let file = backend
        .find_object(key)
        .await?
        .filter(|f| f.file)
        .ok_or_else(|| anyhow!("object not found"))?;
    let mut resp = StatusCode::OK.into_response();
    resp.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&file.size.to_string())?,
    );
    resp.headers_mut().insert(
        header::LAST_MODIFIED,
        HeaderValue::from_str(&http_time(file.updated_at.max(file.created_at)))?,
    );
    resp.headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Ok(value) = HeaderValue::from_str(&content_type_for_path(key)) {
        resp.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    apply_browser_content_headers(&mut resp, key);
    Ok(resp)
}

async fn get_object_bytes(backend: &QuarkBackend, key: &str) -> Result<CachedObject> {
    let file = backend
        .find_object(key)
        .await?
        .filter(|f| f.file)
        .ok_or_else(|| anyhow!("object not found"))?;
    let (url, auth_cookie) = backend.download_request_parts(&file.fid).await?;
    let res = backend
        .http()
        .get(url)
        .header(header::COOKIE, auth_cookie)
        .header(header::REFERER, REFERER)
        .send()
        .await?;
    let status = res.status();
    if !status.is_success() {
        bail!("download failed {status}");
    }
    let content_type = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string);
    let bytes = res.bytes().await?;
    Ok(CachedObject {
        meta: CacheMeta {
            size: bytes.len() as u64,
            modified: file.updated_at.max(file.created_at),
            fetched_at: chrono_millis(),
            content_type,
        },
        bytes,
    })
}

async fn get_object_cached(
    state: &AppState,
    backend: &QuarkBackend,
    virtual_path: &str,
    key: &str,
    headers: &HeaderMap,
) -> Result<Response> {
    if let Some(cached) = read_cached_object(state, virtual_path).await {
        return cached_object_response(cached, virtual_path, headers, false);
    }
    let cached = get_object_bytes(backend, key).await?;
    write_cached_object(state, virtual_path, &cached).await;
    cached_object_response(cached, virtual_path, headers, false)
}

async fn head_object_cached(
    state: &AppState,
    backend: &QuarkBackend,
    virtual_path: &str,
    key: &str,
) -> Result<Response> {
    if let Some(cached) = read_cached_object(state, virtual_path).await {
        return cached_object_response(cached, virtual_path, &HeaderMap::new(), true);
    }
    head_object(backend, key).await
}

fn cached_object_response(
    cached: CachedObject,
    virtual_path: &str,
    headers: &HeaderMap,
    head_only: bool,
) -> Result<Response> {
    let total_size = cached.meta.size as i64;
    let range = if head_only {
        None
    } else {
        parse_range_header(headers, total_size)?
    };
    let mut resp = if head_only {
        Response::new(Body::empty())
    } else if let Some((start, end)) = range {
        Response::new(Body::from(
            cached.bytes.slice(start as usize..(end + 1) as usize),
        ))
    } else {
        Response::new(Body::from(cached.bytes.clone()))
    };
    *resp.status_mut() = if range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    if let Some((start, end)) = range {
        resp.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{total_size}"))?,
        );
        resp.headers_mut().insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&(end - start + 1).to_string())?,
        );
    } else {
        resp.headers_mut().insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&cached.meta.size.to_string())?,
        );
    }
    resp.headers_mut().insert(
        header::LAST_MODIFIED,
        HeaderValue::from_str(&http_time(cached.meta.modified))?,
    );
    resp.headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let content_type = cached
        .meta
        .content_type
        .clone()
        .unwrap_or_else(|| content_type_for_path(virtual_path));
    if let Ok(value) = HeaderValue::from_str(&content_type) {
        resp.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    apply_browser_content_headers(&mut resp, virtual_path);
    Ok(resp)
}

async fn read_cached_object(state: &AppState, virtual_path: &str) -> Option<CachedObject> {
    let cache = state.config.read().await.cache.clone();
    if !cache.enabled {
        return None;
    }
    let (body_path, meta_path) = cache_paths(&state.cache_dir, virtual_path);
    let meta_bytes = tokio::fs::read(&meta_path).await.ok()?;
    let meta: CacheMeta = serde_json::from_slice(&meta_bytes).ok()?;
    if !cache_is_fresh(&meta, cache.ttl_seconds) {
        let _ = tokio::fs::remove_file(&body_path).await;
        let _ = tokio::fs::remove_file(&meta_path).await;
        return None;
    }
    let bytes = tokio::fs::read(&body_path).await.ok()?;
    Some(CachedObject {
        bytes: Bytes::from(bytes),
        meta,
    })
}

async fn write_cached_object(state: &AppState, virtual_path: &str, cached: &CachedObject) {
    let cache = state.config.read().await.cache.clone();
    if !cache.enabled || cached.meta.size > cache.max_bytes {
        return;
    }
    let (body_path, meta_path) = cache_paths(&state.cache_dir, virtual_path);
    let _ = tokio::fs::create_dir_all(&state.cache_dir).await;
    let meta = match serde_json::to_vec(&cached.meta) {
        Ok(meta) => meta,
        Err(_) => return,
    };
    if tokio::fs::write(&body_path, &cached.bytes).await.is_ok() {
        let _ = tokio::fs::write(&meta_path, meta).await;
        cleanup_cache_dir(state, &cache).await;
    }
}

async fn invalidate_cached_object(state: &AppState, virtual_path: &str) {
    let (body_path, meta_path) = cache_paths(&state.cache_dir, virtual_path);
    let _ = tokio::fs::remove_file(&body_path).await;
    let _ = tokio::fs::remove_file(&meta_path).await;
}

async fn clear_cache_dir(state: &AppState) {
    let _ = tokio::fs::remove_dir_all(&state.cache_dir).await;
    let _ = tokio::fs::create_dir_all(&state.cache_dir).await;
}

async fn read_cached_json<T>(state: &AppState, cache_key: &str) -> Option<T>
where
    T: DeserializeOwned,
{
    let cached = read_cached_object(state, cache_key).await?;
    serde_json::from_slice(&cached.bytes).ok()
}

async fn write_cached_json<T>(state: &AppState, cache_key: &str, value: &T)
where
    T: Serialize,
{
    let Ok(bytes) = serde_json::to_vec(value) else {
        return;
    };
    let cached = CachedObject {
        meta: CacheMeta {
            size: bytes.len() as u64,
            modified: chrono_millis(),
            fetched_at: chrono_millis(),
            content_type: Some("application/json".to_string()),
        },
        bytes: Bytes::from(bytes),
    };
    write_cached_object(state, cache_key, &cached).await;
}

fn tree_list_cache_key(
    bucket: &str,
    principal: &str,
    resource: &str,
    prefix: &str,
    delimiter: Option<&str>,
    max_keys: usize,
    offset: usize,
) -> String {
    format!(
        "/.atree/cache/tree/ListBucket/bucket={bucket}/principal={principal}/resource={resource}/prefix={prefix}/delimiter={}/max={max_keys}/offset={offset}",
        delimiter.unwrap_or("")
    )
}

fn cached_list_response(cached: CachedObject) -> Response {
    let mut response = Response::new(Body::from(cached.bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/xml; charset=utf-8"),
    );
    response
}

async fn cache_list_xml(state: &AppState, cache_key: &str, xml: &str) {
    let cached = CachedObject {
        meta: CacheMeta {
            size: xml.len() as u64,
            modified: chrono_millis(),
            fetched_at: chrono_millis(),
            content_type: Some("application/xml; charset=utf-8".to_string()),
        },
        bytes: Bytes::copy_from_slice(xml.as_bytes()),
    };
    write_cached_object(state, cache_key, &cached).await;
}

async fn list_xml_cached(
    state: &AppState,
    cache_key: &str,
    bucket: &str,
    prefix: &str,
    delimiter: Option<&str>,
    max_keys: usize,
    next_token: Option<&str>,
    objects: Vec<(String, QuarkFile)>,
    common_prefixes: Vec<String>,
) -> Response {
    let entries = objects
        .into_iter()
        .map(|(key, f)| S3Entry {
            key,
            size: f.size,
            modified: f.updated_at.max(f.created_at),
        })
        .collect();
    let xml = list_xml_string(
        bucket,
        prefix,
        delimiter,
        entries,
        common_prefixes,
        max_keys,
        next_token,
    );
    cache_list_xml(state, cache_key, &xml).await;
    xml_response(StatusCode::OK, xml)
}

fn cache_paths(cache_dir: &PathBuf, virtual_path: &str) -> (PathBuf, PathBuf) {
    let key = hex::encode(Sha256::digest(virtual_path.as_bytes()));
    (
        cache_dir.join(format!("{key}.bin")),
        cache_dir.join(format!("{key}.json")),
    )
}

fn cache_is_fresh(meta: &CacheMeta, ttl_seconds: u64) -> bool {
    chrono_millis() - meta.fetched_at <= (ttl_seconds as i64) * 1000
}

async fn cleanup_cache_dir(state: &AppState, cache: &config::CacheConfig) {
    let mut entries = Vec::new();
    let Ok(read_dir) = std::fs::read_dir(&state.cache_dir) else {
        return;
    };
    for entry in read_dir.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(meta_bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(meta) = serde_json::from_slice::<CacheMeta>(&meta_bytes) else {
            continue;
        };
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let body_path = state.cache_dir.join(format!("{stem}.bin"));
        if !body_path.exists() || !cache_is_fresh(&meta, cache.ttl_seconds) {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(&body_path);
            continue;
        }
        entries.push((meta.fetched_at, meta.size, body_path, path));
    }
    let mut total_bytes: u64 = entries.iter().map(|(_, size, _, _)| *size).sum();
    entries.sort_by_key(|(fetched_at, _, _, _)| *fetched_at);
    for (_, size, body_path, meta_path) in entries {
        if total_bytes <= cache.max_bytes {
            break;
        }
        let _ = std::fs::remove_file(&body_path);
        let _ = std::fs::remove_file(&meta_path);
        total_bytes = total_bytes.saturating_sub(size);
    }
}

async fn url_object(
    method: Method,
    headers: &HeaderMap,
    virtual_path: &str,
    url: String,
    proxy: Option<String>,
    size: Option<u64>,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return s3_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "MethodNotAllowed",
            "url_tree mounts are read-only",
        );
    }
    let client = match http_client_with_proxy(proxy.as_deref()) {
        Ok(client) => client,
        Err(err) => return s3_error(StatusCode::BAD_REQUEST, "InvalidProxy", &err.to_string()),
    };
    let mut req = match method {
        Method::GET => client.get(&url),
        Method::HEAD => client.head(&url),
        _ => unreachable!(),
    }
    .header(header::USER_AGENT, "atree/url-tree");
    if let Some(range) = headers.get(header::RANGE) {
        req = req.header(header::RANGE, range);
    }
    let upstream = match req.send().await {
        Ok(resp) => resp,
        Err(err) => return s3_error(StatusCode::BAD_GATEWAY, "UpstreamError", &err.to_string()),
    };
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let mut resp = if method == Method::HEAD {
        status.into_response()
    } else {
        Response::new(Body::from_stream(
            upstream.bytes_stream().map_err(std::io::Error::other),
        ))
    };
    *resp.status_mut() = status;
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::LAST_MODIFIED,
        header::ETAG,
        header::CACHE_CONTROL,
        header::ACCEPT_RANGES,
        header::CONTENT_DISPOSITION,
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            resp.headers_mut().insert(name, value.clone());
        }
    }
    if let Some(size) = size
        && method == Method::HEAD
        && let Ok(value) = HeaderValue::from_str(&size.to_string())
    {
        resp.headers_mut().insert(header::CONTENT_LENGTH, value);
    }
    apply_browser_content_headers(&mut resp, virtual_path);
    resp
}

fn http_client_with_proxy(proxy: Option<&str>) -> Result<Client> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(120));
    if let Some(proxy_url) = proxy {
        builder = builder.proxy(Proxy::all(proxy_url)?);
    } else {
        builder = builder.no_proxy();
    }
    Ok(builder.build()?)
}

async fn github_releases_object(
    state: &AppState,
    method: Method,
    headers: &HeaderMap,
    virtual_path: &str,
    rest: String,
    config: GithubReleasesConfig,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return s3_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "MethodNotAllowed",
            "github_releases mounts are read-only",
        );
    }
    let rest = rest.trim_matches('/');
    if rest.is_empty() {
        return list_github_releases(state, None, &config, headers, "github_releases", "").await;
    }
    if method == Method::GET
        && !headers.contains_key(header::RANGE)
        && let Some(cached) = read_cached_object(state, virtual_path).await
    {
        return cached_object_response(cached, virtual_path, headers, false)
            .unwrap_or_else(|err| s3_error_for(&err));
    }
    if method == Method::HEAD
        && let Some(cached) = read_cached_object(state, virtual_path).await
    {
        return cached_object_response(cached, virtual_path, headers, true)
            .unwrap_or_else(|err| s3_error_for(&err));
    }
    let release = match fetch_github_release_cached(state, &config).await {
        Ok(release) => release,
        Err(err) => return s3_error(StatusCode::BAD_GATEWAY, "GithubError", &err.to_string()),
    };
    let Some((url, size, modified, content_type)) = github_release_file(&release, &config, rest)
    else {
        return s3_error(StatusCode::NOT_FOUND, "NoSuchKey", "object not found");
    };
    if method == Method::HEAD {
        return match github_release_head_response(
            headers,
            virtual_path,
            size,
            modified,
            content_type.as_deref(),
        ) {
            Ok(response) => response,
            Err(err) => s3_error_for(&err),
        };
    }
    if !headers.contains_key(header::RANGE) {
        return github_release_get_cached(
            state,
            headers,
            virtual_path,
            &url,
            config.proxy.as_deref(),
            size,
            modified,
            content_type.as_deref(),
        )
        .await;
    }
    let mut response = url_object(
        method,
        headers,
        virtual_path,
        url,
        config.proxy.clone(),
        None,
    )
    .await;
    if response.status().is_success() {
        let partial = response.status() == StatusCode::PARTIAL_CONTENT
            || response.headers().contains_key(header::CONTENT_RANGE);
        if !partial && let Ok(value) = HeaderValue::from_str(&size.to_string()) {
            response.headers_mut().insert(header::CONTENT_LENGTH, value);
        }
        if let Ok(value) = HeaderValue::from_str(&http_time(modified)) {
            response.headers_mut().insert(header::LAST_MODIFIED, value);
        }
        if let Some(content_type) = content_type
            && let Ok(value) = HeaderValue::from_str(&content_type)
        {
            response.headers_mut().insert(header::CONTENT_TYPE, value);
        }
    }
    response
}

async fn github_releases_object_any(
    state: &AppState,
    method: Method,
    headers: &HeaderMap,
    virtual_path: &str,
    mounts: Vec<(String, GithubReleasesConfig)>,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return s3_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "MethodNotAllowed",
            "github_releases mounts are read-only",
        );
    }
    let Some((rest, _)) = mounts.first() else {
        return s3_error(StatusCode::NOT_FOUND, "NoSuchKey", "object not found");
    };
    if rest.trim_matches('/').is_empty() {
        return list_github_releases_many(
            state,
            None,
            mounts.into_iter().map(|(_, config)| config).collect(),
            "github_releases",
            "",
            Some("/"),
            1000,
            0,
            Vec::new(),
            Vec::new(),
        )
        .await;
    }
    for (rest, config) in mounts.into_iter().rev() {
        let release = match fetch_github_release_cached(state, &config).await {
            Ok(release) => release,
            Err(err) => return s3_error(StatusCode::BAD_GATEWAY, "GithubError", &err.to_string()),
        };
        if github_release_file(&release, &config, rest.trim_matches('/')).is_some() {
            return github_releases_object(state, method, headers, virtual_path, rest, config)
                .await;
        }
    }
    s3_error(StatusCode::NOT_FOUND, "NoSuchKey", "object not found")
}

async fn github_release_get_cached(
    state: &AppState,
    headers: &HeaderMap,
    virtual_path: &str,
    url: &str,
    proxy: Option<&str>,
    size: i64,
    modified: i64,
    content_type: Option<&str>,
) -> Response {
    let client = match http_client_with_proxy(proxy) {
        Ok(client) => client,
        Err(err) => return s3_error(StatusCode::BAD_REQUEST, "InvalidConfig", &err.to_string()),
    };
    let response = match client.get(url).send().await {
        Ok(response) => response,
        Err(err) => return s3_error(StatusCode::BAD_GATEWAY, "DownloadError", &err.to_string()),
    };
    let status = response.status();
    if !status.is_success() {
        return s3_error(
            StatusCode::BAD_GATEWAY,
            "DownloadError",
            &format!("download returned {status}"),
        );
    }
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => return s3_error(StatusCode::BAD_GATEWAY, "DownloadError", &err.to_string()),
    };
    let cached = CachedObject {
        meta: CacheMeta {
            size: size.max(bytes.len() as i64) as u64,
            modified,
            fetched_at: chrono_millis(),
            content_type: content_type.map(ToString::to_string),
        },
        bytes,
    };
    write_cached_object(state, virtual_path, &cached).await;
    cached_object_response(cached, virtual_path, headers, false)
        .unwrap_or_else(|err| s3_error_for(&err))
}

fn github_release_head_response(
    headers: &HeaderMap,
    virtual_path: &str,
    size: i64,
    modified: i64,
    content_type: Option<&str>,
) -> Result<Response> {
    let range = parse_range_header(headers, size)?;
    let mut response = Response::new(Body::empty());
    *response.status_mut() = if range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    if let Some((start, end)) = range {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{size}"))?,
        );
        response.headers_mut().insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&(end - start + 1).to_string())?,
        );
    } else {
        response.headers_mut().insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&size.to_string())?,
        );
    }
    response.headers_mut().insert(
        header::LAST_MODIFIED,
        HeaderValue::from_str(&http_time(modified))?,
    );
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Some(content_type) = content_type
        && let Ok(value) = HeaderValue::from_str(content_type)
    {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    apply_browser_content_headers(&mut response, virtual_path);
    Ok(response)
}

async fn list_github_releases(
    state: &AppState,
    list_cache_key: Option<&str>,
    config: &GithubReleasesConfig,
    headers: &HeaderMap,
    bucket: &str,
    prefix: &str,
) -> Response {
    let release = match fetch_github_release_cached(state, config).await {
        Ok(release) => release,
        Err(err) => return s3_error(StatusCode::BAD_GATEWAY, "GithubError", &err.to_string()),
    };
    let entries = github_release_entries(&release, config);
    if wants_html(headers) {
        return html_response(StatusCode::OK, github_release_html(&config.repo, &entries));
    }
    let entries: Vec<S3Entry> = entries
        .into_iter()
        .map(|mut entry| {
            let key_prefix = prefix.trim_matches('/');
            if !key_prefix.is_empty() {
                entry.key = format!("{key_prefix}/{}", entry.key);
            }
            entry
        })
        .collect();
    let xml = list_xml_string(bucket, prefix, Some("/"), entries, Vec::new(), 1000, None);
    if let Some(cache_key) = list_cache_key {
        cache_list_xml(state, cache_key, &xml).await;
    }
    xml_response(StatusCode::OK, xml)
}

async fn list_github_releases_many(
    state: &AppState,
    list_cache_key: Option<&str>,
    configs: Vec<GithubReleasesConfig>,
    bucket: &str,
    prefix: &str,
    delimiter: Option<&str>,
    max_keys: usize,
    offset: usize,
    extra_entries: Vec<S3Entry>,
    extra_common_prefixes: Vec<String>,
) -> Response {
    let mut by_name = HashMap::<String, S3Entry>::new();
    for config in &configs {
        let release = match fetch_github_release_cached(state, config).await {
            Ok(release) => release,
            Err(err) => return s3_error(StatusCode::BAD_GATEWAY, "GithubError", &err.to_string()),
        };
        for entry in github_release_entries(&release, config) {
            by_name.insert(entry.key.clone(), entry);
        }
    }
    let key_prefix = prefix.trim_matches('/');
    for mut entry in extra_entries {
        entry.key = strip_s3_prefix(key_prefix, &entry.key).to_string();
        by_name.insert(entry.key.clone(), entry);
    }
    let mut entries = by_name.into_values().collect::<Vec<_>>();
    entries.sort_by(|a, b| a.key.cmp(&b.key));
    let total = entries.len() + extra_common_prefixes.len();
    let next_token = if offset + max_keys < total {
        Some((offset + max_keys).to_string())
    } else {
        None
    };
    let entries_len = entries.len();
    let entries: Vec<S3Entry> = entries
        .into_iter()
        .skip(offset)
        .take(max_keys)
        .map(|mut entry| {
            if !key_prefix.is_empty() {
                entry.key = format!("{key_prefix}/{}", entry.key);
            }
            entry
        })
        .collect();
    let remaining = max_keys.saturating_sub(entries.len());
    let common_prefixes = extra_common_prefixes
        .into_iter()
        .skip(offset.saturating_sub(entries_len))
        .take(remaining)
        .collect::<Vec<_>>();
    let xml = list_xml_string(
        bucket,
        prefix,
        delimiter,
        entries,
        common_prefixes,
        max_keys,
        next_token.as_deref(),
    );
    if let Some(cache_key) = list_cache_key {
        cache_list_xml(state, cache_key, &xml).await;
    }
    xml_response(StatusCode::OK, xml)
}

async fn fetch_github_release_cached(
    state: &AppState,
    config: &GithubReleasesConfig,
) -> Result<GithubRelease> {
    let cache_key = github_release_cache_key(config);
    if let Some(release) = read_cached_json::<GithubRelease>(state, &cache_key).await {
        return Ok(release);
    }
    let release = fetch_github_release(config).await?;
    write_cached_json(state, &cache_key, &release).await;
    Ok(release)
}

fn github_release_cache_key(config: &GithubReleasesConfig) -> String {
    let token_hash = config
        .token
        .as_deref()
        .map(|token| hex::encode(Sha256::digest(token.as_bytes())))
        .unwrap_or_else(|| "anonymous".to_string());
    format!(
        "/.atree/cache/github_releases/{}/{}",
        config.repo, token_hash
    )
}

async fn fetch_github_release(config: &GithubReleasesConfig) -> Result<GithubRelease> {
    let client = github_client(config)?;
    let url = format!(
        "https://api.github.com/repos/{}/releases/latest",
        config.repo
    );
    let mut req = client
        .get(url)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = config.token.as_deref() {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await?;
    let status = resp.status();
    if !status.is_success() {
        bail!("GitHub API returned {status}");
    }
    Ok(resp.json().await?)
}

fn github_release_entries(release: &GithubRelease, config: &GithubReleasesConfig) -> Vec<S3Entry> {
    let mut entries = release
        .assets
        .iter()
        .filter(|asset| asset_allowed(&asset.name, &config.asset_allow))
        .map(|asset| S3Entry {
            key: asset.name.clone(),
            size: asset.size,
            modified: github_time(&asset.updated_at).unwrap_or_else(chrono_millis),
        })
        .collect::<Vec<_>>();
    if config.show_source_code {
        let modified = github_time(&release.created_at).unwrap_or_else(chrono_millis);
        if !release.zipball_url.is_empty() {
            entries.push(S3Entry {
                key: "Source code (zip)".to_string(),
                size: 1,
                modified,
            });
        }
        if !release.tarball_url.is_empty() {
            entries.push(S3Entry {
                key: "Source code (tar.gz)".to_string(),
                size: 1,
                modified,
            });
        }
    }
    entries
}

fn github_release_file(
    release: &GithubRelease,
    config: &GithubReleasesConfig,
    name: &str,
) -> Option<(String, i64, i64, Option<String>)> {
    if config.show_source_code && name == "Source code (zip)" && !release.zipball_url.is_empty() {
        return Some((
            release.zipball_url.clone(),
            1,
            github_time(&release.created_at).unwrap_or_else(chrono_millis),
            Some("application/zip".to_string()),
        ));
    }
    if config.show_source_code && name == "Source code (tar.gz)" && !release.tarball_url.is_empty()
    {
        return Some((
            release.tarball_url.clone(),
            1,
            github_time(&release.created_at).unwrap_or_else(chrono_millis),
            Some("application/gzip".to_string()),
        ));
    }
    release
        .assets
        .iter()
        .find(|asset| asset.name == name && asset_allowed(&asset.name, &config.asset_allow))
        .map(|asset| {
            (
                asset.browser_download_url.clone(),
                asset.size,
                github_time(&asset.updated_at)
                    .or_else(|| github_time(&asset.created_at))
                    .unwrap_or_else(chrono_millis),
                if asset.content_type.is_empty() {
                    None
                } else {
                    Some(asset.content_type.clone())
                },
            )
        })
}

fn github_release_html(repo: &str, entries: &[S3Entry]) -> String {
    let mut html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{}</title><h1>{}</h1><ul>",
        xml_escape(repo),
        xml_escape(repo)
    );
    for entry in entries {
        html.push_str(&format!(
            "<li><a href=\"{}\">{}</a> <small>{} bytes</small></li>",
            urlencoding::encode(&entry.key),
            xml_escape(&entry.key),
            entry.size
        ));
    }
    html.push_str("</ul>");
    html
}

fn github_time(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn asset_allowed(name: &str, patterns: &[String]) -> bool {
    patterns.is_empty()
        || patterns
            .iter()
            .any(|pattern| wildcard_match(pattern.trim(), name))
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    if pattern == "*" || pattern.is_empty() {
        return true;
    }
    if !pattern.contains('*') {
        return pattern == text;
    }
    let mut rest = text;
    let starts_with_star = pattern.starts_with('*');
    let ends_with_star = pattern.ends_with('*');
    let parts = pattern
        .split('*')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        let Some(pos) = rest.find(part) else {
            return false;
        };
        if index == 0 && !starts_with_star && pos != 0 {
            return false;
        }
        rest = &rest[pos + part.len()..];
    }
    ends_with_star || rest.is_empty()
}

async fn delete_object(backend: &QuarkBackend, key: &str) -> Result<Response> {
    if let Some(file) = backend.find_object(key).await? {
        backend.delete_fid(&file.fid).await?;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn delete_object_cached(
    state: &AppState,
    backend: &QuarkBackend,
    virtual_path: &str,
    key: &str,
) -> Result<Response> {
    let response = delete_object(backend, key).await?;
    invalidate_cached_object(state, virtual_path).await;
    clear_cache_dir(state).await;
    Ok(response)
}

async fn initiate_multipart_upload(state: &AppState, key: &str, remote_key: &str) -> Response {
    let bucket = state_bucket(state).await;
    let upload_id = new_upload_id(remote_key);
    let dir = state.multipart_dir.join(&upload_id);
    if let Err(err) = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(dir.join("key"), remote_key.as_bytes()))
    {
        return s3_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "InternalError",
            &err.to_string(),
        );
    }
    xml_response(
        StatusCode::OK,
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>{}</Bucket>
  <Key>{}</Key>
  <UploadId>{}</UploadId>
</InitiateMultipartUploadResult>"#,
            xml_escape(&bucket),
            xml_escape(key),
            xml_escape(&upload_id)
        ),
    )
}

async fn upload_multipart_part(
    state: &AppState,
    params: &HashMap<String, String>,
    body: Bytes,
) -> Response {
    let Some(upload_id) = params.get("uploadId") else {
        return s3_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "missing uploadId",
        );
    };
    let Some(part_number) = params
        .get("partNumber")
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|v| *v > 0)
    else {
        return s3_error(StatusCode::BAD_REQUEST, "InvalidPart", "invalid partNumber");
    };
    let dir = state.multipart_dir.join(safe_upload_id(upload_id));
    if !dir.join("key").exists() {
        return s3_error(
            StatusCode::NOT_FOUND,
            "NoSuchUpload",
            "multipart upload not found",
        );
    }
    let etag = format!("\"{:x}\"", md5::compute(&body));
    let path = dir.join(format!("{part_number:05}.part"));
    let meta_path = dir.join(format!("{part_number:05}.etag"));
    if let Err(err) =
        std::fs::write(&path, &body).and_then(|_| std::fs::write(&meta_path, etag.as_bytes()))
    {
        return s3_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "InternalError",
            &err.to_string(),
        );
    }
    (StatusCode::OK, [(header::ETAG, etag)]).into_response()
}

async fn complete_multipart_upload(
    state: &AppState,
    backend: &QuarkBackend,
    key: &str,
    remote_key: &str,
    params: &HashMap<String, String>,
) -> Response {
    let Some(upload_id) = params.get("uploadId") else {
        return s3_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "missing uploadId",
        );
    };
    let dir = state.multipart_dir.join(safe_upload_id(upload_id));
    if !dir.join("key").exists() {
        return s3_error(
            StatusCode::NOT_FOUND,
            "NoSuchUpload",
            "multipart upload not found",
        );
    }

    let mut part_paths = match std::fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("part"))
            .collect::<Vec<_>>(),
        Err(err) => {
            return s3_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "InternalError",
                &err.to_string(),
            );
        }
    };
    part_paths.sort();
    if part_paths.is_empty() {
        return s3_error(StatusCode::BAD_REQUEST, "InvalidPart", "no uploaded parts");
    }

    let mut full = Vec::new();
    for path in &part_paths {
        match std::fs::read(path) {
            Ok(bytes) => full.extend_from_slice(&bytes),
            Err(err) => {
                return s3_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "InternalError",
                    &err.to_string(),
                );
            }
        }
    }
    let etag = format!("\"{:x}-{}\"", md5::compute(&full), part_paths.len());
    let content_type = mime_guess::from_path(remote_key)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    match backend
        .put_object(remote_key, &content_type, Bytes::from(full))
        .await
    {
        Ok(()) => {
            let bucket = state_bucket(state).await;
            invalidate_cached_object(state, &format!("/{}", key.trim_matches('/'))).await;
            clear_cache_dir(state).await;
            let _ = std::fs::remove_dir_all(&dir);
            xml_response(
                StatusCode::OK,
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>/{}/{}</Location>
  <Bucket>{}</Bucket>
  <Key>{}</Key>
  <ETag>{}</ETag>
</CompleteMultipartUploadResult>"#,
                    xml_escape(&bucket),
                    xml_escape(key),
                    xml_escape(&bucket),
                    xml_escape(key),
                    xml_escape(&etag)
                ),
            )
        }
        Err(err) => s3_error(StatusCode::BAD_GATEWAY, "QuarkError", &err.to_string()),
    }
}

async fn abort_multipart_upload(state: &AppState, params: &HashMap<String, String>) -> Response {
    let Some(upload_id) = params.get("uploadId") else {
        return s3_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "missing uploadId",
        );
    };
    let _ = std::fs::remove_dir_all(state.multipart_dir.join(safe_upload_id(upload_id)));
    StatusCode::NO_CONTENT.into_response()
}

fn new_upload_id(key: &str) -> String {
    let seed = format!("{}:{}:{}", chrono_millis(), key, std::process::id());
    hex::encode(Sha256::digest(seed.as_bytes()))
}

fn safe_upload_id(upload_id: &str) -> String {
    upload_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect()
}

async fn browser_directory(
    state: &AppState,
    virtual_path: &str,
    headers: &HeaderMap,
    synthetic: bool,
) -> Response {
    let config_path = state_config_path(state).await;
    let html = || html_response(StatusCode::OK, file_browser_html(&config_path));
    if synthetic || virtual_path == "/" {
        return html();
    }
    if !is_authorized(state, headers, "ListBucket", virtual_path).await {
        return html();
    }
    let Some(index_key) = find_directory_index(state, virtual_path).await else {
        return html();
    };
    let index_path = format!("/{index_key}");
    if !is_authorized(state, headers, "GetObject", &index_path).await {
        return html();
    }
    let config = state.config.read().await;
    let Some((remote_key, backend)) = resolve_mount(&config, &index_path)
        .and_then(|mount| backend_from_mount(state.db_path.clone(), state.config.clone(), mount))
    else {
        return html();
    };
    match get_object_cached(state, &backend, &index_path, &remote_key, headers).await {
        Ok(resp) => resp,
        Err(_) => html(),
    }
}

async fn browser_directory_index(
    state: &AppState,
    virtual_path: &str,
    headers: &HeaderMap,
) -> Option<Response> {
    let index_path = directory_index_path(virtual_path);
    if !is_authorized(state, headers, "GetObject", &index_path).await {
        return None;
    }
    let config = state.config.read().await;
    let mount = resolve_mount(&config, &index_path)?;
    drop(config);
    match mount {
        ResolvedMount::QuarkOpen {
            remote_key,
            config: quark_config,
            path,
        } => {
            let backend = QuarkBackend::Open(
                quark_open_client(
                    quark_config,
                    &path,
                    state.db_path.clone(),
                    state.config.clone(),
                )
                .ok()?,
            );
            get_object_cached(state, &backend, &index_path, &remote_key, headers)
                .await
                .ok()
        }
        ResolvedMount::S3 { remote_key, config } => {
            s3_get_object(&config, &remote_key, &index_path, headers)
                .await
                .ok()
        }
        ResolvedMount::UrlTree { url, proxy, size } => {
            Some(url_object(Method::GET, headers, &index_path, url, proxy, size).await)
                .filter(|response| response.status().is_success())
        }
        _ => None,
    }
}

fn directory_index_path(virtual_path: &str) -> String {
    let base = virtual_path.trim_end_matches('/');
    if base.is_empty() {
        "/index.html".to_string()
    } else {
        format!("{base}/index.html")
    }
}

async fn find_directory_index(state: &AppState, virtual_path: &str) -> Option<String> {
    let prefix = virtual_path.trim_matches('/');
    let config = state.config.read().await;
    let (remote_key, backend) = backend_from_mount(
        state.db_path.clone(),
        state.config.clone(),
        resolve_mount(&config, &format!("/{prefix}"))?,
    )?;
    drop(config);
    let fid = backend.resolve_dir(&remote_key, false).await.ok()?;
    let mut candidates = backend
        .list_files(&fid)
        .await
        .ok()?
        .into_iter()
        .filter(|f| f.file && f.file_name.starts_with("index"))
        .map(|f| {
            if prefix.is_empty() {
                f.file_name
            } else {
                format!("{prefix}/{}", f.file_name)
            }
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| {
        let a_base = a.rsplit('/').next().unwrap_or(a);
        let b_base = b.rsplit('/').next().unwrap_or(b);
        (a_base != "index", a).cmp(&(b_base != "index", b))
    });
    candidates.into_iter().next()
}

async fn is_authorized(
    state: &AppState,
    headers: &HeaderMap,
    action: &str,
    resource: &str,
) -> bool {
    let principal = resolve_principal(state, headers).await;
    let config = state.config.read().await;
    policy_allows(&config, &principal, action, resource)
}

async fn resolve_principal(state: &AppState, headers: &HeaderMap) -> String {
    let Some(token) = request_access_key(headers) else {
        return "anonymous".to_string();
    };
    if state.root_key.as_deref() == Some(token.as_str()) {
        return "root".to_string();
    }
    let hash = hash_key(&token);
    let config = state.config.read().await;
    config
        .auth
        .keys
        .iter()
        .find(|key| key.enabled && key.key_hash == hash)
        .map(|key| key.name.clone())
        .unwrap_or_else(|| "anonymous".to_string())
}

fn policy_allows(config: &ServiceConfig, principal: &str, action: &str, resource: &str) -> bool {
    if principal == "root" {
        return true;
    }
    config.auth.rules.iter().any(|rule| {
        rule.principal
            .strip_prefix("key:")
            .unwrap_or(&rule.principal)
            == principal
            && rule
                .actions
                .iter()
                .any(|candidate| candidate == "*" || candidate == action)
            && rule
                .resources
                .iter()
                .any(|candidate| resource_matches(candidate, resource))
    })
}

fn resource_matches(pattern: &str, resource: &str) -> bool {
    if pattern == "*" || pattern == "/*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix("/*") {
        let rest = resource
            .trim_end_matches('/')
            .strip_prefix(&format!("{prefix}/"));
        return rest.is_some_and(|rest| !rest.is_empty());
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return resource.starts_with(prefix);
    }
    pattern.trim_end_matches('/') == resource.trim_end_matches('/')
}

fn generate_open_req_sign(
    method: &str,
    pathname: &str,
    sign_key: &str,
) -> (String, String, String) {
    let tm = chrono_millis().to_string();
    let token_data = format!("{method}&{pathname}&{tm}&{sign_key}");
    let token = hex::encode(Sha256::digest(token_data.as_bytes()));
    let req_seed = format!("{token_data}:{}", std::process::id());
    let req_hash = hex::encode(Sha256::digest(req_seed.as_bytes()));
    let req_id = format!(
        "{}-{}-{}-{}-{}",
        &req_hash[0..8],
        &req_hash[8..12],
        &req_hash[12..16],
        &req_hash[16..20],
        &req_hash[20..32]
    );
    (tm, token, req_id)
}

fn open_file_to_quark_file(file: OpenFile) -> QuarkFile {
    QuarkFile {
        fid: file.fid,
        file_name: file.filename,
        size: file.size,
        file: file.file_type != "0",
        created_at: file.created_at,
        updated_at: file.updated_at,
    }
}

fn proof_code(body: &Bytes, proof_seed: &str) -> Result<String> {
    if body.is_empty() {
        return Ok(String::new());
    }
    let seed_md5 = format!("{:x}", md5::compute(proof_seed));
    let index = u64::from_str_radix(&seed_md5[..16], 16)? as usize % body.len();
    let end = (index + 8).min(body.len());
    Ok(general_purpose::STANDARD.encode(&body[index..end]))
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn request_access_key(headers: &HeaderMap) -> Option<String> {
    bearer_token(headers).or_else(|| aws_access_key(headers))
}

fn aws_access_key(headers: &HeaderMap) -> Option<String> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?;
    let credential = auth
        .split([',', ' '])
        .map(str::trim)
        .find_map(|part| part.strip_prefix("Credential="))?;
    credential.split('/').next().map(str::to_string)
}

fn list_xml_entries(
    bucket: &str,
    prefix: &str,
    delimiter: Option<&str>,
    objects: Vec<S3Entry>,
    common_prefixes: Vec<String>,
    max_keys: usize,
    next_token: Option<&str>,
) -> Response {
    xml_response(
        StatusCode::OK,
        list_xml_string(
            bucket,
            prefix,
            delimiter,
            objects,
            common_prefixes,
            max_keys,
            next_token,
        ),
    )
}

fn list_xml_string(
    bucket: &str,
    prefix: &str,
    delimiter: Option<&str>,
    objects: Vec<S3Entry>,
    common_prefixes: Vec<String>,
    max_keys: usize,
    next_token: Option<&str>,
) -> String {
    let mut xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>{}</Name>
  <Prefix>{}</Prefix>
  <KeyCount>{}</KeyCount>
  <MaxKeys>{}</MaxKeys>
  <IsTruncated>{}</IsTruncated>
"#,
        xml_escape(bucket),
        xml_escape(prefix),
        objects.len() + common_prefixes.len(),
        max_keys,
        next_token.is_some()
    );
    if let Some(token) = next_token {
        xml.push_str(&format!(
            "  <NextContinuationToken>{}</NextContinuationToken>\n",
            xml_escape(token)
        ));
        xml.push_str(&format!(
            "  <NextMarker>{}</NextMarker>\n",
            xml_escape(token)
        ));
    }
    if let Some(delimiter) = delimiter {
        xml.push_str(&format!(
            "  <Delimiter>{}</Delimiter>\n",
            xml_escape(delimiter)
        ));
    }
    for entry in objects {
        xml.push_str(&format!(
            "  <Contents><Key>{}</Key><LastModified>{}</LastModified><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>\n",
            xml_escape(&entry.key),
            iso_time(entry.modified),
            entry.size
        ));
    }
    for p in common_prefixes {
        xml.push_str(&format!(
            "  <CommonPrefixes><Prefix>{}</Prefix></CommonPrefixes>\n",
            xml_escape(&p)
        ));
    }
    xml.push_str("</ListBucketResult>");
    xml
}

fn xml_response(status: StatusCode, xml: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
        xml,
    )
        .into_response()
}

fn html_response(status: StatusCode, html: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"ok": false, "error": message}))).into_response()
}

fn yaml_response(status: StatusCode, yaml: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/yaml; charset=utf-8")],
        yaml,
    )
        .into_response()
}

fn access_denied(headers: &HeaderMap, _bucket: &str, config_path: &str) -> Response {
    if wants_html(headers) {
        html_response(StatusCode::UNAUTHORIZED, file_browser_html(config_path))
    } else {
        s3_error(StatusCode::FORBIDDEN, "AccessDenied", "access denied")
    }
}

async fn access_denied_response(state: &AppState, headers: &HeaderMap, bucket: &str) -> Response {
    let config_path = state_config_path(state).await;
    access_denied(headers, bucket, &config_path)
}

fn s3_error(status: StatusCode, code: &str, message: &str) -> Response {
    xml_response(
        status,
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><Error><Code>{}</Code><Message>{}</Message></Error>"#,
            xml_escape(code),
            xml_escape(message)
        ),
    )
}

fn s3_error_for(err: &anyhow::Error) -> Response {
    let message = err.to_string();
    if message.contains("object not found") {
        s3_error(StatusCode::NOT_FOUND, "NoSuchKey", "object not found")
    } else if message.contains("invalid range") {
        s3_error(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "InvalidRange",
            "invalid range",
        )
    } else {
        s3_error(StatusCode::BAD_GATEWAY, "QuarkError", &message)
    }
}

fn content_type_for_path(path: &str) -> String {
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

fn is_inline_content_type(content_type: &str) -> bool {
    let content_type = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim()
        .to_ascii_lowercase();
    content_type.starts_with("text/")
        || content_type.starts_with("image/")
        || content_type.starts_with("audio/")
        || content_type.starts_with("video/")
        || matches!(
            content_type.as_str(),
            "application/json"
                | "application/pdf"
                | "application/xml"
                | "application/yaml"
                | "application/x-yaml"
                | "application/javascript"
                | "application/ecmascript"
                | "application/xhtml+xml"
        )
}

fn encoded_filename(path: &str) -> String {
    let name = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("download");
    urlencoding::encode(name)
        .replace('+', "%20")
        .replace("%2F", "/")
}

fn apply_browser_content_headers(response: &mut Response, virtual_path: &str) {
    if !response.status().is_success() && response.status() != StatusCode::PARTIAL_CONTENT {
        return;
    }
    if !response.headers().contains_key(header::CONTENT_TYPE)
        && let Ok(value) = HeaderValue::from_str(&content_type_for_path(virtual_path))
    {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    if response.headers().contains_key(header::CONTENT_DISPOSITION) {
        return;
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if is_inline_content_type(content_type) {
        return;
    }
    if let Ok(value) = HeaderValue::from_str(&format!(
        "attachment; filename*=UTF-8''{}",
        encoded_filename(virtual_path)
    )) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
}

fn parse_range_header(headers: &HeaderMap, size: i64) -> Result<Option<(i64, i64)>> {
    let Some(value) = headers.get(header::RANGE) else {
        return Ok(None);
    };
    let value = value.to_str()?.trim();
    let Some(spec) = value.strip_prefix("bytes=") else {
        bail!("invalid range");
    };
    let (start, end) = spec
        .split_once('-')
        .ok_or_else(|| anyhow!("invalid range"))?;
    if size <= 0 {
        bail!("invalid range");
    }
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<i64>().context("invalid range")?;
        if suffix <= 0 {
            bail!("invalid range");
        }
        ((size - suffix).max(0), size - 1)
    } else {
        let start = start.parse::<i64>().context("invalid range")?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<i64>().context("invalid range")?
        };
        (start, end.min(size - 1))
    };
    if start < 0 || start >= size || end < start {
        bail!("invalid range");
    }
    Ok(Some((start, end)))
}

fn decode_request_body(headers: &HeaderMap, body: Bytes) -> Result<Bytes> {
    let is_aws_chunked = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(',')
                .any(|p| p.trim().eq_ignore_ascii_case("aws-chunked"))
        })
        .unwrap_or(false)
        || headers.contains_key("x-amz-decoded-content-length");
    if !is_aws_chunked {
        return Ok(body);
    }

    let mut pos = 0usize;
    let mut out = Vec::new();
    while pos < body.len() {
        let line_end = find_crlf(&body, pos).ok_or_else(|| anyhow!("invalid aws-chunked body"))?;
        let line = std::str::from_utf8(&body[pos..line_end])?;
        let size_hex = line
            .split(';')
            .next()
            .ok_or_else(|| anyhow!("invalid aws-chunked body"))?;
        let size = usize::from_str_radix(size_hex, 16).context("invalid aws-chunked size")?;
        pos = line_end + 2;
        if size == 0 {
            break;
        }
        if pos + size + 2 > body.len() || &body[pos + size..pos + size + 2] != b"\r\n" {
            bail!("invalid aws-chunked body");
        }
        out.extend_from_slice(&body[pos..pos + size]);
        pos += size + 2;
    }

    if let Some(expected) = headers
        .get("x-amz-decoded-content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        && out.len() != expected
    {
        bail!(
            "invalid aws-chunked decoded length: got {}, expected {}",
            out.len(),
            expected
        );
    }

    Ok(Bytes::from(out))
}

fn find_crlf(bytes: &[u8], start: usize) -> Option<usize> {
    bytes[start..]
        .windows(2)
        .position(|w| w == b"\r\n")
        .map(|idx| start + idx)
}

fn parse_query(raw: &str) -> HashMap<String, String> {
    raw.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (decode_query_component(k), decode_query_component(v))
        })
        .collect()
}

fn decode_query_component(value: &str) -> String {
    let plus_fixed = value.replace('+', " ");
    match urlencoding::decode(&plus_fixed) {
        Ok(decoded) => decoded.into_owned(),
        Err(_) => plus_fixed,
    }
}

fn percent_decode_path(path: &str) -> String {
    path.split('/')
        .map(|p| {
            urlencoding::decode(p)
                .unwrap_or_else(|_| p.into())
                .into_owned()
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn quark_open_response_expired(status: StatusCode, bytes: &Bytes) -> Result<bool> {
    let api: OpenStatus = match serde_json::from_slice(bytes) {
        Ok(api) => api,
        Err(err) => {
            if !status.is_success() {
                bail!(
                    "quark open api http {}: {}",
                    status,
                    String::from_utf8_lossy(bytes)
                );
            }
            return Err(err).with_context(|| {
                format!(
                    "invalid quark open response: {}",
                    String::from_utf8_lossy(bytes)
                )
            });
        }
    };
    Ok(api.status == -1
        && (api.errno == 11001 || (api.errno == 14001 && api.error_info.contains("access_token"))))
}

fn split_key(key: &str) -> (&str, &str) {
    let key = key.trim_matches('/');
    key.rsplit_once('/').unwrap_or(("", key))
}

fn chrono_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn iso_time(millis: i64) -> String {
    let secs = (millis.max(0) / 1000) as u64;
    chrono::DateTime::<chrono::Utc>::from(
        SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs),
    )
    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn http_time(millis: i64) -> String {
    let secs = (millis.max(0) / 1000) as u64;
    httpdate::fmt_http_date(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AuthConfig, AuthRule, CacheConfig, KeyConfig, MountConfig, default_mounts, validate_config,
    };
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use std::ops::Deref;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tower::ServiceExt;

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    struct TestState {
        state: AppState,
    }

    impl TestState {
        fn app_state(&self) -> AppState {
            self.state.clone()
        }
    }

    impl Deref for TestState {
        type Target = AppState;

        fn deref(&self) -> &Self::Target {
            &self.state
        }
    }

    impl Drop for TestState {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.state.db_path);
            let _ = std::fs::remove_dir_all(&self.state.cache_dir);
            let _ = std::fs::remove_dir_all(&self.state.multipart_dir);
        }
    }

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(prefix: &str) -> Self {
            let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "{prefix}-{}-{}-{}",
                std::process::id(),
                chrono_millis(),
                id
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Deref for TestDir {
        type Target = PathBuf;

        fn deref(&self) -> &Self::Target {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn config_with_mounts(mounts: Vec<MountConfig>) -> ServiceConfig {
        ServiceConfig {
            s3_bucket: "atree".to_string(),
            mounts,
            auth: AuthConfig::default(),
            cache: CacheConfig::default(),
        }
    }

    fn mount(path: &str, root_path: &str) -> MountConfig {
        MountConfig {
            path: path.to_string(),
            mount_type: "quark_open".to_string(),
            root_path: Some(root_path.to_string()),
            options: json!({
                "access_token": "test-access-token",
                "refresh_token": "test-refresh-token",
                "app_id": "test-app-id",
                "sign_key": "test-sign-key",
                "refresh_url": "https://api.oplist.org/quarkyun/renewapi",
                "root_fid": "0",
            }),
        }
    }

    fn test_state() -> TestState {
        let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let db_path = std::env::temp_dir().join(format!(
            "atree-test-{}-{}-{}.sqlite",
            std::process::id(),
            chrono_millis(),
            id
        ));
        let config = load_or_init_config(&db_path).unwrap();
        let multipart_dir = std::env::temp_dir().join(format!(
            "atree-test-multipart-{}-{}-{}",
            std::process::id(),
            chrono_millis(),
            id
        ));
        let cache_dir = std::env::temp_dir().join(format!(
            "atree-test-cache-{}-{}-{}",
            std::process::id(),
            chrono_millis(),
            id
        ));
        std::fs::create_dir_all(&multipart_dir).unwrap();
        std::fs::create_dir_all(&cache_dir).unwrap();
        TestState {
            state: AppState {
                config: Arc::new(RwLock::new(config)),
                cache_dir,
                multipart_dir,
                db_path,
                root_key: Some("root-test-key".to_string()),
            },
        }
    }

    async fn response_text(response: Response) -> String {
        String::from_utf8(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn cache_roundtrip_and_invalidation_work() {
        let state = test_state();
        let cached = CachedObject {
            bytes: Bytes::from_static(b"hello cache"),
            meta: CacheMeta {
                size: 11,
                modified: chrono_millis(),
                fetched_at: chrono_millis(),
                content_type: Some("text/plain".to_string()),
            },
        };
        write_cached_object(&state, "/atree/demo.txt", &cached).await;
        let loaded = read_cached_object(&state, "/atree/demo.txt").await;
        assert!(loaded.is_some());
        assert_eq!(loaded.unwrap().bytes, Bytes::from_static(b"hello cache"));

        invalidate_cached_object(&state, "/atree/demo.txt").await;
        assert!(
            read_cached_object(&state, "/atree/demo.txt")
                .await
                .is_none()
        );
    }

    #[test]
    fn browser_content_headers_attach_binary_but_not_inline_files() {
        let mut png = Response::new(Body::empty());
        png.headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
        apply_browser_content_headers(&mut png, "/public/photo.png");
        assert!(!png.headers().contains_key(header::CONTENT_DISPOSITION));

        let mut apk = Response::new(Body::empty());
        apk.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/vnd.android.package-archive"),
        );
        apply_browser_content_headers(&mut apk, "/client/Hiddify Android.apk");
        assert_eq!(
            apk.headers().get(header::CONTENT_DISPOSITION).unwrap(),
            "attachment; filename*=UTF-8''Hiddify%20Android.apk"
        );
    }

    #[test]
    fn empty_db_is_initialized_with_default_config() {
        let root = TestDir::new("atree-default-config");
        let db_path = root.join("atree.sqlite");

        let config = load_or_init_config(&db_path).unwrap();

        assert_eq!(config, ServiceConfig::default());

        let reloaded = load_or_init_config(&db_path).unwrap();
        assert_eq!(reloaded, ServiceConfig::default());
    }

    #[test]
    fn mount_matching_is_segment_aware_and_later_mount_wins() {
        let config = config_with_mounts(vec![
            mount("/", "/root"),
            mount("/public", "/public-root"),
            mount("/public/site", "/site-root"),
        ]);
        assert_eq!(
            resolve_remote_key(&config, "/public/site/index.html").as_deref(),
            Some("site-root/index.html")
        );
        assert_eq!(
            resolve_remote_key(&config, "/public/a.jpg").as_deref(),
            Some("public-root/a.jpg")
        );
        assert_eq!(
            resolve_remote_key(&config, "/publication/a.jpg").as_deref(),
            Some("root/publication/a.jpg")
        );
    }

    #[test]
    fn system_config_and_url_tree_mounts_resolve_in_service_tree() {
        let config = config_with_mounts(vec![
            mount("/", "/root"),
            MountConfig {
                path: "/github".to_string(),
                mount_type: "url_tree".to_string(),
                root_path: Some("https://github.com/OpenListTeam/OpenList/releases".to_string()),
                options: json!({"proxy": "http://127.0.0.1:1080"}),
            },
            MountConfig {
                path: "/api/config.yaml".to_string(),
                mount_type: "system_config".to_string(),
                root_path: None,
                options: Value::Null,
            },
        ]);

        assert!(matches!(
            resolve_mount(&config, "/api/config.yaml"),
            Some(ResolvedMount::SystemConfig { virtual_path }) if virtual_path == "/api/config.yaml"
        ));
        assert!(matches!(
            resolve_mount(&config, "/github/client.tar.gz"),
            Some(ResolvedMount::UrlTree { url, proxy, size: _ })
                if url == "https://github.com/OpenListTeam/OpenList/releases/client.tar.gz"
                    && proxy.as_deref() == Some("http://127.0.0.1:1080")
        ));
        assert!(!matches!(
            resolve_mount(&config, "/api/"),
            Some(ResolvedMount::SystemConfig { .. })
        ));
    }

    #[test]
    fn quark_open_expired_response_is_detected_even_on_http_400() {
        let body = Bytes::from(r#"{"status":-1,"errno":11001,"error_info":"Access Token无效"}"#);
        assert!(quark_open_response_expired(StatusCode::BAD_REQUEST, &body).unwrap());
    }

    #[test]
    fn quark_open_non_json_http_error_still_reports_http_failure() {
        let body = Bytes::from_static(b"upstream exploded");
        let err = quark_open_response_expired(StatusCode::BAD_GATEWAY, &body).unwrap_err();
        assert!(
            err.to_string()
                .contains("quark open api http 502 Bad Gateway: upstream exploded")
        );
    }

    #[test]
    fn github_release_head_response_respects_range() {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=0-99"));
        let response = github_release_head_response(
            &headers,
            "/client/readme.txt",
            1000,
            1_700_000_000_000,
            Some("text/plain"),
        )
        .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers().get(header::CONTENT_LENGTH).unwrap(),
            "100"
        );
        assert_eq!(
            response.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 0-99/1000"
        );
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain"
        );
    }

    #[test]
    fn github_releases_mount_resolves_and_filters_assets() {
        let config = config_with_mounts(vec![
            mount("/", "/root"),
            MountConfig {
                path: "/clients/hiddify".to_string(),
                mount_type: "github_releases".to_string(),
                root_path: Some("hiddify/hiddify-app".to_string()),
                options: json!({
                    "asset_allow": ["*MacOS.dmg", "*Windows*.zip"],
                    "show_source_code": true,
                    "proxy": "http://127.0.0.1:1080"
                }),
            },
            MountConfig {
                path: "/api/config.yaml".to_string(),
                mount_type: "system_config".to_string(),
                root_path: None,
                options: Value::Null,
            },
        ]);

        let Some(ResolvedMount::GithubReleases { rest, config }) =
            resolve_mount(&config, "/clients/hiddify/Hiddify-MacOS.dmg")
        else {
            panic!("expected github_releases mount");
        };
        assert_eq!(rest, "Hiddify-MacOS.dmg");
        assert_eq!(config.repo, "hiddify/hiddify-app");
        assert_eq!(config.proxy.as_deref(), Some("http://127.0.0.1:1080"));
        assert!(config.show_source_code);
        assert!(asset_allowed("Hiddify-MacOS.dmg", &config.asset_allow));
        assert!(!asset_allowed("Hiddify-Android.apk", &config.asset_allow));
    }

    #[test]
    fn duplicate_github_release_mounts_can_form_flat_directory() {
        let config = config_with_mounts(vec![
            MountConfig {
                path: "/client".to_string(),
                mount_type: "github_releases".to_string(),
                root_path: Some("hiddify/hiddify-app".to_string()),
                options: json!({"asset_allow": ["Hiddify-MacOS.dmg"]}),
            },
            MountConfig {
                path: "/client".to_string(),
                mount_type: "github_releases".to_string(),
                root_path: Some("SagerNet/sing-box".to_string()),
                options: json!({"asset_allow": ["sing-box-*-linux-amd64.tar.gz"]}),
            },
            MountConfig {
                path: "/api/config.yaml".to_string(),
                mount_type: "system_config".to_string(),
                root_path: None,
                options: Value::Null,
            },
        ]);

        validate_config(&config).unwrap();
        let mounts = resolve_github_release_mounts(&config, "/client/Hiddify-MacOS.dmg");
        assert_eq!(mounts.len(), 2);
        assert!(mounts.iter().all(|(rest, _)| rest == "Hiddify-MacOS.dmg"));
        assert_eq!(mounts[0].1.repo, "hiddify/hiddify-app");
        assert_eq!(mounts[1].1.repo, "SagerNet/sing-box");
    }

    #[test]
    fn github_release_entries_include_allowed_assets_and_source_archives() {
        let release = GithubRelease {
            created_at: "2026-01-01T00:00:00Z".to_string(),
            assets: vec![
                GithubAsset {
                    name: "app.dmg".to_string(),
                    content_type: "application/octet-stream".to_string(),
                    size: 10,
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    updated_at: "2026-01-02T00:00:00Z".to_string(),
                    browser_download_url:
                        "https://github.com/example/repo/releases/download/v1/app.dmg".to_string(),
                },
                GithubAsset {
                    name: "app.apk".to_string(),
                    content_type: "application/octet-stream".to_string(),
                    size: 20,
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    updated_at: "2026-01-02T00:00:00Z".to_string(),
                    browser_download_url:
                        "https://github.com/example/repo/releases/download/v1/app.apk".to_string(),
                },
            ],
            tarball_url: "https://api.github.com/repos/example/repo/tarball/v1".to_string(),
            zipball_url: "https://api.github.com/repos/example/repo/zipball/v1".to_string(),
        };
        let config = GithubReleasesConfig {
            repo: "example/repo".to_string(),
            token: None,
            proxy: None,
            show_source_code: true,
            asset_allow: vec!["*.dmg".to_string()],
        };

        let entries = github_release_entries(&release, &config);
        let names = entries
            .iter()
            .map(|entry| entry.key.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec!["app.dmg", "Source code (zip)", "Source code (tar.gz)"]
        );
        assert!(github_release_file(&release, &config, "app.dmg").is_some());
        assert!(github_release_file(&release, &config, "app.apk").is_none());
    }

    #[tokio::test]
    async fn github_release_list_preserves_directory_prefix_slash() {
        let response = list_xml_entries(
            "atree",
            "hiddify/",
            Some("/"),
            vec![S3Entry {
                key: "hiddify/app.dmg".to_string(),
                size: 42,
                modified: 1_700_000_000_000,
            }],
            Vec::new(),
            1000,
            None,
        );
        let body = response_text(response).await;
        assert!(body.contains("<Prefix>hiddify/</Prefix>"));
        assert!(body.contains("<Key>hiddify/app.dmg</Key>"));
    }

    #[test]
    fn auth_rules_default_deny_and_allow_anonymous_by_rule() {
        let mut config = ServiceConfig::default();
        assert!(!policy_allows(
            &config,
            "anonymous",
            "GetObject",
            "/public/a.txt"
        ));
        config.auth.rules.push(AuthRule {
            principal: "anonymous".to_string(),
            actions: vec!["GetObject".to_string(), "HeadObject".to_string()],
            resources: vec!["/public/*".to_string()],
        });
        assert!(policy_allows(
            &config,
            "anonymous",
            "GetObject",
            "/public/a.txt"
        ));
        assert!(policy_allows(
            &config,
            "anonymous",
            "GetObject",
            "/public/nested/a.txt"
        ));
        assert!(!policy_allows(&config, "anonymous", "GetObject", "/public"));
        assert!(!policy_allows(
            &config,
            "anonymous",
            "GetObject",
            "/public/"
        ));
        assert!(!policy_allows(
            &config,
            "anonymous",
            "PutObject",
            "/public/a.txt"
        ));
        assert!(!policy_allows(
            &config,
            "anonymous",
            "GetObject",
            "/private/a.txt"
        ));
    }

    #[test]
    fn key_is_hashed_and_not_serialized() {
        let config = ServiceConfig {
            s3_bucket: "atree".to_string(),
            mounts: default_mounts(),
            auth: AuthConfig {
                keys: vec![KeyConfig {
                    name: "reader".to_string(),
                    key_hash: String::new(),
                    key_hint: String::new(),
                    enabled: true,
                    plain_key: Some("reader-secret".to_string()),
                }],
                rules: vec![AuthRule {
                    principal: "reader".to_string(),
                    actions: vec!["ListBucket".to_string()],
                    resources: vec!["/*".to_string()],
                }],
            },
            cache: CacheConfig::default(),
        };
        let config = normalize_config(config).expect("valid config");
        let key = &config.auth.keys[0];
        assert!(key.key_hash.starts_with("sha256:"));
        assert_eq!(key.key_hint, "read...cret");
        let raw = serde_json::to_string(&config).unwrap();
        assert!(!raw.contains("reader-secret"));
        assert!(!raw.contains("\"key\""));
    }

    #[test]
    fn legacy_config_names_are_normalized() {
        let config = parse_config_yaml(
            br#"
mounts:
  - mount_path: /api/config.yaml
    type: system_config
auth:
  keys:
    - name: reader
      plain_key: reader-secret
  rules:
    - principal: key:reader
      actions: [ListBucket]
      resources: [/*]
"#,
        )
        .and_then(normalize_config)
        .expect("legacy auth config remains valid");

        assert_eq!(config.auth.rules[0].principal, "reader");
        let yaml = serde_yaml::to_string(&config).unwrap();
        assert!(yaml.contains("type: system_config\n  path: /api/config.yaml"));
        assert!(!yaml.contains("mount_path:"));
        assert!(yaml.contains("users:"));
        assert!(yaml.contains("user: reader"));
        assert!(yaml.contains("paths:"));
        assert!(!yaml.contains("plain_key:"));
        assert!(!yaml.contains("principal:"));
        assert!(!yaml.contains("resources:"));
        assert!(!yaml.contains("key:reader"));
    }

    #[test]
    fn aws_sigv4_credential_can_act_as_service_key() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static(
                "AWS4-HMAC-SHA256 Credential=reader-key/20260521/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=abc",
            ),
        );
        assert_eq!(request_access_key(&headers).as_deref(), Some("reader-key"));
    }

    #[test]
    fn invalid_config_is_rejected() {
        let config = config_with_mounts(vec![mount("/quark", "../bad")]);
        assert!(validate_config(&config).is_err());

        let mut config = ServiceConfig::default();
        config.auth.rules.push(AuthRule {
            principal: "key:missing".to_string(),
            actions: vec!["GetObject".to_string()],
            resources: vec!["/*".to_string()],
        });
        assert!(validate_config(&config).is_err());

        let mut config = ServiceConfig::default();
        config.mounts[0].path = "/".to_string();
        assert!(validate_config(&config).is_err());
    }

    #[tokio::test]
    async fn root_route_negotiates_browser_html_and_s3_xml() {
        let state = test_state();
        let app = build_app(state.app_state());

        let html_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header(header::ACCEPT, "text/html")
                    .header(header::USER_AGENT, "Mozilla/5.0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(html_resp.status(), StatusCode::OK);
        let html = response_text(html_resp).await;
        assert!(html.contains("atree"));
        assert!(html.contains("atree_key"));

        let xml_resp = app
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header(header::ACCEPT, "application/xml")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(xml_resp.status(), StatusCode::FORBIDDEN);
        let xml = response_text(xml_resp).await;
        assert!(xml.contains("<Code>AccessDenied"));
    }

    #[test]
    fn s3_path_style_bucket_prefix_maps_to_tree_root() {
        let headers = HeaderMap::new();
        let params = parse_query("list-type=2&delimiter=/");
        assert_eq!(
            request_virtual_path("atree", false, "atree", &Method::GET, &headers, &params),
            "/"
        );
        assert_eq!(
            request_virtual_path(
                "atree/quark/restic-repo",
                false,
                "atree",
                &Method::GET,
                &headers,
                &params
            ),
            "/quark/restic-repo"
        );

        let direct_params = HashMap::new();
        assert_eq!(
            request_virtual_path(
                "atree/quark/restic-repo",
                false,
                "atree",
                &Method::GET,
                &headers,
                &direct_params
            ),
            "/atree/quark/restic-repo"
        );
    }

    #[tokio::test]
    async fn s3_bucket_root_supports_create_head_and_location() {
        let state = test_state();
        let app = build_app(state.app_state());

        let create = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/atree?x-id=CreateBucket")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create.status(), StatusCode::OK);

        let head = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::HEAD)
                    .uri("/atree")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK);

        let location = app
            .oneshot(
                Request::builder()
                    .uri("/atree?location=")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(location.status(), StatusCode::OK);
        assert!(response_text(location).await.contains("us-east-1"));
    }

    #[tokio::test]
    async fn large_put_reaches_s3_handler_without_default_body_limit() {
        let state = test_state();
        let app = build_app(state.app_state());
        let body = vec![b'x'; 3 * 1024 * 1024];

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/missing-large.bin")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(
            response_text(response)
                .await
                .contains("<Code>NoSuchKey</Code>")
        );
    }

    #[tokio::test]
    async fn synthetic_directory_browser_shell_defers_auth_to_client_fetch() {
        let state = test_state();
        let app = build_app(state.app_state());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/")
                    .header(header::ACCEPT, "text/html")
                    .header(header::USER_AGENT, "Mozilla/5.0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("u.searchParams.set('list-type', '2');"));
    }

    #[tokio::test]
    async fn synthetic_directory_parent_without_trailing_slash_returns_browser_shell() {
        let state = test_state();
        let app = build_app(state.app_state());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api")
                    .header(header::ACCEPT, "text/html")
                    .header(header::USER_AGENT, "Mozilla/5.0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("u.searchParams.set('list-type', '2');"));
    }

    #[tokio::test]
    async fn browser_directory_under_mount_returns_shell_without_request_auth() {
        let state = test_state();
        *state.config.write().await = config_with_mounts(vec![
            mount("/quark", "/"),
            MountConfig {
                path: "/api/config.yaml".to_string(),
                mount_type: "system_config".to_string(),
                root_path: None,
                options: Value::Null,
            },
        ]);
        let app = build_app(state.app_state());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/quark/some-dir/")
                    .header(header::ACCEPT, "text/html")
                    .header(header::USER_AGENT, "Mozilla/5.0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("u.searchParams.set('list-type', '2');"));
    }

    #[tokio::test]
    async fn browser_directory_serves_authorized_index_html_before_shell() {
        let state = test_state();
        let mut config = config_with_mounts(vec![
            mount("/public", "/"),
            MountConfig {
                path: "/api/config.yaml".to_string(),
                mount_type: "system_config".to_string(),
                root_path: None,
                options: Value::Null,
            },
        ]);
        config.auth.rules.push(AuthRule {
            principal: "anonymous".to_string(),
            actions: vec!["GetObject".to_string()],
            resources: vec!["/public/site/index.html".to_string()],
        });
        *state.config.write().await = config;
        write_cached_object(
            &state,
            "/public/site/index.html",
            &CachedObject {
                bytes: Bytes::from_static(b"<!doctype html><title>site index</title>"),
                meta: CacheMeta {
                    size: 40,
                    modified: chrono_millis(),
                    fetched_at: chrono_millis(),
                    content_type: Some("text/html; charset=utf-8".to_string()),
                },
            },
        )
        .await;
        let app = build_app(state.app_state());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/public/site")
                    .header(header::ACCEPT, "text/html")
                    .header(header::USER_AGENT, "Mozilla/5.0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("site index"));
        assert!(!body.contains("u.searchParams.set('list-type', '2');"));
    }

    #[tokio::test]
    async fn root_browser_view_shows_top_level_entries() {
        let state = test_state();
        let app = build_app(state.app_state());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header(header::ACCEPT, "text/html")
                    .header(header::USER_AGENT, "Mozilla/5.0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("u.searchParams.set('list-type', '2');"));
    }

    #[tokio::test]
    async fn config_api_yaml_requires_root_hashes_key_and_rejects_invalid_config() {
        let state = test_state();
        let app = build_app(state.app_state());

        let no_auth = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/config.yaml")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_auth.status(), StatusCode::FORBIDDEN);

        let bad = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::from(
                        r#"mounts:
  - type: quark_open
    path: bad
    root_path: /
"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
        assert!(response_text(bad).await.contains("path must start with /"));

        let good_config = r#"
mounts:
  - type: quark_open
    path: /quark
    root_path: /
    options:
      refresh_token: test-refresh-token
  - type: system_config
    path: /api/config.yaml
auth:
  users:
    - name: reader
      key: reader-test-key
  rules:
    - user: reader
      paths: [/*]
      actions: [ListBucket]
cache:
  max_bytes: 1048576
"#;
        let put = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::from(good_config))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::OK);
        let put_body = response_text(put).await;
        assert!(put_body.contains("# mounts[].path"));
        assert!(put_body.contains("key_hash: sha256:"));
        assert!(!put_body.contains("reader-test-key"));
        assert!(!put_body.contains("\nkey:"));

        let get = app
            .oneshot(
                Request::builder()
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        let get_body = response_text(get).await;
        assert!(get_body.contains("name: reader"));
        assert!(!get_body.contains("reader-test-key"));
        assert!(!get_body.contains("\nkey:"));
    }

    #[tokio::test]
    async fn config_api_supports_commented_yaml_roundtrip() {
        let state = test_state();
        let app = build_app(state.app_state());
        let yaml_config = r#"
# This comment should be ignored on PUT.
mounts:
  - type: quark_open
    path: /quark
    root_path: /
    options:
      refresh_token: test-refresh-token
  - type: system_config
    path: /api/config.yaml
auth:
  users:
    # key is accepted only on write and removed on read.
    - name: yaml-reader
      key: yaml-reader-key
  rules:
    - user: yaml-reader
      paths: [/*]
      actions: [ListBucket, GetObject]
cache:
  max_bytes: 2097152
"#;
        let put = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::from(yaml_config))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::OK);
        let put_body = response_text(put).await;
        assert!(put_body.contains("sha256:"));
        assert!(!put_body.contains("yaml-reader-key"));

        let get = app
            .oneshot(
                Request::builder()
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        assert_eq!(
            get.headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/yaml; charset=utf-8")
        );
        let body = response_text(get).await;
        assert!(body.contains("# mounts[].path"));
        assert!(body.contains("name: yaml-reader"));
        assert!(body.contains("key_hash: sha256:"));
        assert!(!body.contains("yaml-reader-key"));
        assert!(!body.contains("\nkey:"));
    }

    #[tokio::test]
    async fn config_yaml_can_be_delegated_with_normal_auth_rules() {
        let state = test_state();
        let app = build_app(state.app_state());
        let delegated_config = r#"
mounts:
  - type: quark_open
    path: /
    root_path: /
    options:
      refresh_token: test-refresh-token
  - type: system_config
    path: /api/config.yaml
auth:
  users:
    - name: config-editor
      key: config-editor-key
  rules:
    - user: config-editor
      paths: [/api/config.yaml]
      actions: [GetObject, PutObject]
cache:
  max_bytes: 1048576
"#;
        let seed_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::from(delegated_config))
                    .unwrap(),
            )
            .await
            .unwrap();
        if seed_response.status() != StatusCode::OK {
            let status = seed_response.status();
            let body = response_text(seed_response).await;
            panic!("seed config status {status}: {body}");
        }

        let delegated_get = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer config-editor-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(delegated_get.status(), StatusCode::OK);
        assert!(response_text(delegated_get).await.contains("config-editor"));

        let delegated_put = app
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer config-editor-key")
                    .body(Body::from(delegated_config))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(delegated_put.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn system_config_path_can_be_any_file_path() {
        let state = test_state();
        let app = build_app(state.app_state());
        let moved_config = r#"
mounts:
  - type: quark_open
    path: /quark
    root_path: /
    options:
      refresh_token: test-refresh-token
  - type: system_config
    path: /system/live.yaml
auth:
  users:
    - name: config-reader
      key: config-reader-key
  rules:
    - user: config-reader
      paths: [/system/live.yaml]
      actions: [GetObject]
cache:
  max_bytes: 1048576
"#;
        let put = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::from(moved_config))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::OK);

        let moved_get = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/system/live.yaml")
                    .header(header::AUTHORIZATION, "Bearer config-reader-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(moved_get.status(), StatusCode::OK);
        assert!(response_text(moved_get).await.contains("/system/live.yaml"));

        let old_get = app
            .oneshot(
                Request::builder()
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(old_get.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn url_tree_mount_streams_external_file() {
        async fn upstream(method: Method) -> Response {
            if method == Method::HEAD {
                return (
                    StatusCode::OK,
                    [
                        (header::CONTENT_TYPE, "text/plain"),
                        (header::CONTENT_LENGTH, "0"),
                    ],
                )
                    .into_response();
            }
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/plain")],
                "proxied payload",
            )
                .into_response()
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app = Router::new().route("/files/client.txt", any(upstream));
            axum::serve(listener, app).await.unwrap();
        });

        let state = test_state();
        *state.config.write().await = ServiceConfig {
            s3_bucket: "quark".to_string(),
            mounts: vec![
                MountConfig {
                    path: "/".to_string(),
                    mount_type: "quark_open".to_string(),
                    root_path: Some("/".to_string()),
                    options: Value::Null,
                },
                MountConfig {
                    path: "/api/config.yaml".to_string(),
                    mount_type: "system_config".to_string(),
                    root_path: None,
                    options: Value::Null,
                },
                MountConfig {
                    path: "/github".to_string(),
                    mount_type: "url_tree".to_string(),
                    root_path: Some(format!("http://{addr}/files")),
                    options: json!({"size": 15}),
                },
            ],
            auth: AuthConfig {
                keys: Vec::new(),
                rules: vec![AuthRule {
                    principal: "anonymous".to_string(),
                    actions: vec!["GetObject".to_string(), "HeadObject".to_string()],
                    resources: vec!["/github/*".to_string()],
                }],
            },
            cache: CacheConfig::default(),
        };
        let app = build_app(state.app_state());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/github/client.txt")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_text(response).await, "proxied payload");

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::HEAD)
                    .uri("/github/client.txt")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_LENGTH).unwrap(),
            "15"
        );
    }

    #[tokio::test]
    async fn json_config_route_is_not_exposed() {
        let state = test_state();
        *state.config.write().await = ServiceConfig {
            s3_bucket: "atree".to_string(),
            mounts: vec![MountConfig {
                path: "/api/config.yaml".to_string(),
                mount_type: "system_config".to_string(),
                root_path: None,
                options: Value::Null,
            }],
            auth: AuthConfig::default(),
            cache: CacheConfig::default(),
        };
        let app = build_app(state.app_state());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn help_route_is_not_supported() {
        let state = test_state();
        *state.config.write().await = ServiceConfig {
            s3_bucket: "atree".to_string(),
            mounts: vec![MountConfig {
                path: "/api/config.yaml".to_string(),
                mount_type: "system_config".to_string(),
                root_path: None,
                options: Value::Null,
            }],
            auth: AuthConfig::default(),
            cache: CacheConfig::default(),
        };
        let app = build_app(state.app_state());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/help")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/help.md")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn s3_list_is_default_denied_before_backend_access() {
        let state = test_state();
        let app = build_app(state.app_state());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/?list-type=2&delimiter=/")
                    .header(header::ACCEPT, "application/xml")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(
            response_text(response)
                .await
                .contains("<Code>AccessDenied</Code>")
        );
    }

    #[tokio::test]
    async fn s3_root_list_includes_synthetic_mount_directories() {
        let state = test_state();
        *state.config.write().await = ServiceConfig {
            s3_bucket: "atree".to_string(),
            mounts: vec![
                MountConfig {
                    path: "/api/config.yaml".to_string(),
                    mount_type: "system_config".to_string(),
                    root_path: None,
                    options: Value::Null,
                },
                MountConfig {
                    path: "/release/yacd-gh-pages.zip".to_string(),
                    mount_type: "url_tree".to_string(),
                    root_path: Some(
                        "https://github.com/MetaCubeX/Yacd-meta/archive/gh-pages.zip".to_string(),
                    ),
                    options: json!({"size": 2277966}),
                },
            ],
            auth: AuthConfig {
                keys: Vec::new(),
                rules: vec![AuthRule {
                    principal: "anonymous".to_string(),
                    actions: vec!["ListBucket".to_string()],
                    resources: vec![
                        "/".to_string(),
                        "/release".to_string(),
                        "/release/*".to_string(),
                    ],
                }],
            },
            cache: CacheConfig::default(),
        };
        let app = build_app(state.app_state());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/?list-type=2&delimiter=/")
                    .header(header::ACCEPT, "application/xml")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("<Prefix>release/</Prefix>"));
        assert!(!body.contains("<Prefix>api/</Prefix>"));
        assert_eq!(body.matches("<Prefix>release/</Prefix>").count(), 1);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/?list-type=2&delimiter=/&prefix=release/")
                    .header(header::ACCEPT, "application/xml")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("<Key>release/yacd-gh-pages.zip</Key>"));
        assert!(body.contains("<Size>2277966</Size>"));
        assert!(!body.contains("<Prefix>release/yacd-gh-pages.zip/</Prefix>"));
    }

    #[test]
    fn hide_from_parent_suppresses_mount_in_parent_listing_only() {
        let config = ServiceConfig {
            s3_bucket: "atree".to_string(),
            mounts: vec![
                MountConfig {
                    path: "/api/config.yaml".to_string(),
                    mount_type: "system_config".to_string(),
                    root_path: None,
                    options: Value::Null,
                },
                MountConfig {
                    path: "/tmp".to_string(),
                    mount_type: "s3".to_string(),
                    root_path: Some("/tmp".to_string()),
                    options: json!({
                        "endpoint": "http://minio.local:9000",
                        "bucket": "file",
                        "access_key": "key",
                        "secret_key": "secret",
                        "hide_from_parent": true
                    }),
                },
            ],
            auth: AuthConfig {
                keys: Vec::new(),
                rules: vec![AuthRule {
                    principal: "anonymous".to_string(),
                    actions: vec!["ListBucket".to_string()],
                    resources: vec!["/".to_string(), "/tmp".to_string(), "/tmp/*".to_string()],
                }],
            },
            cache: CacheConfig::default(),
        };

        let (_, root_prefixes) = synthetic_mount_listing(&config, "anonymous", "", Some("/"));
        assert!(!root_prefixes.contains(&"tmp/".to_string()));
        assert!(hidden_mount_identities(&config, "anonymous", "", Some("/")).contains("tmp"));
        assert!(hidden_mount_identities(&config, "anonymous", "tmp/", Some("/")).is_empty());

        let (tmp_entries, tmp_prefixes) =
            synthetic_mount_listing(&config, "anonymous", "tmp/", Some("/"));
        assert!(tmp_entries.is_empty());
        assert!(tmp_prefixes.is_empty());
    }

    #[test]
    fn unauthorized_mount_is_suppressed_from_parent_s3_listing() {
        let config = ServiceConfig {
            s3_bucket: "atree".to_string(),
            mounts: vec![
                MountConfig {
                    path: "/".to_string(),
                    mount_type: "s3".to_string(),
                    root_path: Some("/".to_string()),
                    options: json!({
                        "endpoint": "http://minio.local:9000",
                        "bucket": "file",
                        "access_key": "key",
                        "secret_key": "secret"
                    }),
                },
                MountConfig {
                    path: "/quark".to_string(),
                    mount_type: "quark_open".to_string(),
                    root_path: Some("/".to_string()),
                    options: json!({
                        "refresh_token": "refresh"
                    }),
                },
                MountConfig {
                    path: "/external".to_string(),
                    mount_type: "github_releases".to_string(),
                    root_path: Some("example/repo".to_string()),
                    options: Value::Null,
                },
            ],
            auth: AuthConfig {
                keys: Vec::new(),
                rules: vec![AuthRule {
                    principal: "anonymous".to_string(),
                    actions: vec!["ListBucket".to_string()],
                    resources: vec!["/".to_string(), "/external".to_string()],
                }],
            },
            cache: CacheConfig::default(),
        };

        let hidden = hidden_mount_identities(&config, "anonymous", "", Some("/"));
        assert!(hidden.contains("quark"));
        assert!(!hidden.contains("external"));
    }

    #[test]
    fn later_synthetic_listing_overrides_s3_listing_names() {
        let mut entries = vec![
            S3Entry {
                key: "api/config.yaml".to_string(),
                size: 10,
                modified: 1,
            },
            S3Entry {
                key: "plain.txt".to_string(),
                size: 20,
                modified: 1,
            },
        ];
        let mut common_prefixes = vec!["client/".to_string(), "docs/".to_string()];
        merge_later_listing(
            &mut entries,
            &mut common_prefixes,
            (
                vec![S3Entry {
                    key: "api/config.yaml".to_string(),
                    size: 0,
                    modified: 2,
                }],
                vec!["client/".to_string()],
            ),
        );

        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.key.as_str())
                .collect::<Vec<_>>(),
            vec!["plain.txt", "api/config.yaml"]
        );
        assert_eq!(entries[1].modified, 2);
        assert_eq!(
            common_prefixes,
            vec!["docs/".to_string(), "client/".to_string()]
        );
    }

    #[tokio::test]
    async fn config_yaml_comments_include_ai_friendly_examples() {
        let state = test_state();
        let app = build_app(state.app_state());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .header(header::HOST, "atree.example.test")
                    .header("x-forwarded-proto", "https")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("# `atree` is an S3-style file API"));
        assert!(body.contains("curl -H 'Authorization: Bearer <root-key>'"));
        assert!(body.contains("https://atree.example.test/api/config.yaml"));
        assert!(body.contains("curl -I -H 'Authorization: Bearer <key>'"));
        assert!(body.contains("-T ./example.txt"));
        assert!(body.contains("Accept: text/html"));
    }
}
