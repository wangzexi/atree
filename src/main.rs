use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime},
};

mod config;
mod mounts;
mod ui;

use crate::mounts::{
    GithubReleasesConfig, QuarkOpenConfig, ResolvedMount, backend_from_mount, github_client,
    is_fnnas_quark_refresh_url, persist_quark_open_config, quark_client,
    quark_open_client, resolve_explicit_mount, resolve_mount,
};
#[cfg(test)]
use crate::mounts::resolve_remote_key;
use anyhow::{Context, Result, anyhow, bail};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Path, RawQuery, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use base64::{Engine as _, engine::general_purpose};
use config::{
    ServiceConfig, commented_yaml, config_db_path, hash_key, load_or_init_config, normalize_config,
    parse_config_yaml, save_config_to_db,
};
use futures_util::TryStreamExt;
use reqwest::{Client, Proxy};
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

const QUARK_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
const REFERER: &str = "https://pan.quark.cn";
const API: &str = "https://drive.quark.cn/1/clouddrive";
const OPEN_API: &str = "https://open-api-drive.quark.cn";
const PR: &str = "ucpro";

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
struct QuarkClient {
    http: Client,
    cookie: Arc<Mutex<String>>,
    root_fid: String,
}

#[derive(Clone)]
struct QuarkOpenClient {
    http: Client,
    config: Arc<Mutex<QuarkOpenConfig>>,
}

enum QuarkBackend {
    Cookie(QuarkClient),
    Open(QuarkOpenClient),
}

#[derive(Debug, Deserialize)]
struct ApiStatus {
    #[serde(default)]
    status: i64,
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
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
struct SortResp {
    data: SortData,
    metadata: SortMeta,
}

#[derive(Debug, Deserialize)]
struct SortData {
    list: Vec<QuarkFile>,
}

#[derive(Debug, Deserialize)]
struct SortMeta {
    #[serde(rename = "_total")]
    total: usize,
}

#[derive(Debug, Deserialize)]
struct DownResp {
    data: Vec<DownItem>,
}

#[derive(Debug, Deserialize)]
struct DownItem {
    download_url: String,
}

#[derive(Debug, Deserialize)]
struct UpPreResp {
    data: UpPreData,
    metadata: UpPreMeta,
}

#[derive(Debug, Clone, Deserialize)]
struct UpPreData {
    task_id: String,
    #[serde(default)]
    finish: bool,
    upload_id: String,
    obj_key: String,
    upload_url: String,
    bucket: String,
    auth_info: String,
    callback: Value,
}

#[derive(Debug, Deserialize)]
struct UpPreMeta {
    part_size: usize,
}

#[derive(Debug, Deserialize)]
struct HashResp {
    data: HashData,
}

#[derive(Debug, Deserialize)]
struct HashData {
    #[serde(default)]
    finish: bool,
}

#[derive(Debug, Deserialize)]
struct UpAuthResp {
    data: UpAuthData,
}

#[derive(Debug, Deserialize)]
struct UpAuthData {
    auth_key: String,
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

#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone)]
struct S3Entry {
    key: String,
    size: i64,
    modified: i64,
}

impl QuarkClient {
    fn new(cookie: String, root_fid: String) -> Result<Self> {
        let http = Client::builder()
            .user_agent(QUARK_UA)
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()?;
        Ok(Self {
            http,
            cookie: Arc::new(Mutex::new(cookie)),
            root_fid,
        })
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        pathname: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<T> {
        let url = format!("{API}{pathname}");
        let cookie = self.cookie.lock().await.clone();
        let mut req = self
            .http
            .request(method, url)
            .header(header::COOKIE, cookie)
            .header(header::ACCEPT, "application/json, text/plain, */*")
            .header(header::REFERER, REFERER)
            .query(&[("pr", PR), ("fr", "pc")])
            .query(query);
        if let Some(body) = body {
            req = req.json(&body);
        }

        let res = req.send().await?;
        self.update_cookie(res.headers()).await;
        let status = res.status();
        let bytes = res.bytes().await?;
        if !status.is_success() {
            bail!(
                "quark api http {}: {}",
                status,
                String::from_utf8_lossy(&bytes)
            );
        }

        let api: ApiStatus = serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "invalid quark response: {}",
                String::from_utf8_lossy(&bytes)
            )
        })?;
        if api.status >= 400 || api.code != 0 {
            bail!(
                "quark api error status={} code={}: {}",
                api.status,
                api.code,
                api.message
            );
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    async fn update_cookie(&self, headers: &HeaderMap) {
        let mut cookie = self.cookie.lock().await;
        for value in headers.get_all(header::SET_COOKIE) {
            let Ok(s) = value.to_str() else { continue };
            for name in ["__puus", "__pus"] {
                if let Some(v) = parse_set_cookie_value(s, name) {
                    *cookie = set_cookie_value(&cookie, name, &v);
                }
            }
        }
    }

    async fn list_files(&self, parent_fid: &str) -> Result<Vec<QuarkFile>> {
        let mut files = Vec::new();
        let mut page = 1usize;
        let size = 100usize;
        loop {
            let resp: SortResp = self
                .request(
                    Method::GET,
                    "/file/sort",
                    &[
                        ("pdir_fid", parent_fid.to_string()),
                        ("_size", size.to_string()),
                        ("_page", page.to_string()),
                        ("_fetch_total", "1".into()),
                        ("fetch_all_file", "1".into()),
                        ("fetch_risk_file_name", "1".into()),
                        ("_sort", "file_type:asc,file_name:asc".into()),
                    ],
                    None,
                )
                .await?;
            files.extend(resp.data.list);
            if page * size >= resp.metadata.total {
                break;
            }
            page += 1;
        }
        Ok(files)
    }

    async fn mkdir(&self, parent_fid: &str, name: &str) -> Result<()> {
        self.request::<Value>(
            Method::POST,
            "/file",
            &[],
            Some(json!({
                "dir_init_lock": false,
                "dir_path": "",
                "file_name": name,
                "pdir_fid": parent_fid,
            })),
        )
        .await?;
        Ok(())
    }

    async fn resolve_dir(&self, path: &str, create: bool) -> Result<String> {
        let mut parent = self.root_fid.clone();
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
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
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
        let resp: DownResp = self
            .request(
                Method::POST,
                "/file/download",
                &[],
                Some(json!({ "fids": [fid] })),
            )
            .await?;
        resp.data
            .first()
            .map(|d| d.download_url.clone())
            .filter(|u| !u.is_empty())
            .ok_or_else(|| anyhow!("quark did not return a download URL"))
    }

    async fn delete_fid(&self, fid: &str) -> Result<()> {
        self.request::<Value>(
            Method::POST,
            "/file/delete",
            &[],
            Some(json!({
                "action_type": 1,
                "exclude_fids": [],
                "filelist": [fid],
            })),
        )
        .await?;
        Ok(())
    }

    async fn put_object(&self, key: &str, content_type: &str, body: Bytes) -> Result<()> {
        let total_start = SystemTime::now();
        let expected_size = body.len() as i64;
        if let Some(existing) = self.find_object(key).await? {
            self.delete_fid(&existing.fid).await?;
        }

        let (dir, name) = split_key(key);
        let parent = self.resolve_dir(dir, true).await?;
        let md5_hex = format!("{:x}", md5::compute(&body));
        let sha1_hex = hex::encode(Sha1::digest(&body));
        let now = chrono_millis();

        let pre_start = SystemTime::now();
        let pre: UpPreResp = self
            .request(
                Method::POST,
                "/file/upload/pre",
                &[],
                Some(json!({
                    "ccp_hash_update": true,
                    "dir_name": "",
                    "file_name": name,
                    "format_type": content_type,
                    "l_created_at": now,
                    "l_updated_at": now,
                    "pdir_fid": parent,
                    "size": body.len(),
                })),
            )
            .await?;
        timing_log("upload.pre", key, expected_size, pre_start);
        if pre.data.finish {
            timing_log("upload.total.instant", key, expected_size, total_start);
            return Ok(());
        }

        let hash_start = SystemTime::now();
        let hash: HashResp = self
            .request(
                Method::POST,
                "/file/update/hash",
                &[],
                Some(json!({
                    "md5": md5_hex,
                    "sha1": sha1_hex,
                    "task_id": pre.data.task_id,
                })),
            )
            .await?;
        timing_log("upload.hash", key, expected_size, hash_start);
        if hash.data.finish {
            timing_log("upload.total.dedupe", key, expected_size, total_start);
            return Ok(());
        }

        let part_size = pre.metadata.part_size.max(1024 * 1024);
        let mut etags = Vec::new();
        for (idx, chunk) in body.chunks(part_size).enumerate() {
            let part_start = SystemTime::now();
            let etag = self
                .upload_part(
                    &pre.data,
                    content_type,
                    idx + 1,
                    Bytes::copy_from_slice(chunk),
                )
                .await?;
            timing_log(
                &format!("upload.part.{}", idx + 1),
                key,
                chunk.len() as i64,
                part_start,
            );
            etags.push(etag);
        }
        let commit_start = SystemTime::now();
        self.upload_commit(&pre.data, &etags).await?;
        timing_log("upload.commit", key, expected_size, commit_start);
        let finish_start = SystemTime::now();
        self.upload_finish(&pre.data).await?;
        timing_log("upload.finish", key, expected_size, finish_start);
        let visible_start = SystemTime::now();
        self.wait_until_visible(key, expected_size).await?;
        timing_log("upload.visible", key, expected_size, visible_start);
        timing_log("upload.total", key, expected_size, total_start);
        Ok(())
    }

    async fn wait_until_visible(&self, key: &str, expected_size: i64) -> Result<()> {
        let mut last = None;
        for _ in 0..20 {
            match self.find_object(key).await? {
                Some(file) if file.file && file.size == expected_size => return Ok(()),
                Some(file) => last = Some(format!("visible with size {}", file.size)),
                None => last = Some("not visible".to_string()),
            }
            sleep(Duration::from_millis(500)).await;
        }
        bail!(
            "uploaded object is not visible yet: {}",
            last.unwrap_or_else(|| "unknown".to_string())
        )
    }

    async fn upload_part(
        &self,
        pre: &UpPreData,
        content_type: &str,
        part_number: usize,
        body: Bytes,
    ) -> Result<String> {
        let date = httpdate::fmt_http_date(SystemTime::now());
        let auth_meta = format!(
            "PUT\n\n{content_type}\n{date}\nx-oss-date:{date}\nx-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit\n/{}/{}?partNumber={part_number}&uploadId={}",
            pre.bucket, pre.obj_key, pre.upload_id
        );
        let auth: UpAuthResp = self
            .request(
                Method::POST,
                "/file/upload/auth",
                &[],
                Some(json!({
                    "auth_info": pre.auth_info,
                    "auth_meta": auth_meta,
                    "task_id": pre.task_id,
                })),
            )
            .await?;
        let url = oss_url(pre)?;
        let res = self
            .http
            .put(url)
            .query(&[
                ("partNumber", part_number.to_string()),
                ("uploadId", pre.upload_id.clone()),
            ])
            .header(header::AUTHORIZATION, auth.data.auth_key)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::REFERER, "https://pan.quark.cn/")
            .header("x-oss-date", date)
            .header(
                "x-oss-user-agent",
                "aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit",
            )
            .body(body)
            .send()
            .await?;
        if !res.status().is_success() {
            bail!(
                "oss upload part failed {}: {}",
                res.status(),
                res.text().await?
            );
        }
        Ok(res
            .headers()
            .get(header::ETAG)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string())
    }

    async fn upload_commit(&self, pre: &UpPreData, etags: &[String]) -> Result<()> {
        let mut xml =
            String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CompleteMultipartUpload>\n");
        for (idx, etag) in etags.iter().enumerate() {
            xml.push_str(&format!(
                "<Part>\n<PartNumber>{}</PartNumber>\n<ETag>{}</ETag>\n</Part>\n",
                idx + 1,
                etag
            ));
        }
        xml.push_str("</CompleteMultipartUpload>");

        let content_md5 = general_purpose::STANDARD.encode(md5::compute(xml.as_bytes()).0);
        let callback = general_purpose::STANDARD.encode(serde_json::to_vec(&pre.callback)?);
        let date = httpdate::fmt_http_date(SystemTime::now());
        let auth_meta = format!(
            "POST\n{content_md5}\napplication/xml\n{date}\nx-oss-callback:{callback}\nx-oss-date:{date}\nx-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit\n/{}/{}?uploadId={}",
            pre.bucket, pre.obj_key, pre.upload_id
        );
        let auth: UpAuthResp = self
            .request(
                Method::POST,
                "/file/upload/auth",
                &[],
                Some(json!({
                    "auth_info": pre.auth_info,
                    "auth_meta": auth_meta,
                    "task_id": pre.task_id,
                })),
            )
            .await?;
        let res = self
            .http
            .post(oss_url(pre)?)
            .query(&[("uploadId", pre.upload_id.clone())])
            .header(header::AUTHORIZATION, auth.data.auth_key)
            .header("Content-MD5", content_md5)
            .header(header::CONTENT_TYPE, "application/xml")
            .header(header::REFERER, "https://pan.quark.cn/")
            .header("x-oss-callback", callback)
            .header("x-oss-date", date)
            .header(
                "x-oss-user-agent",
                "aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit",
            )
            .body(xml)
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("oss commit failed {}: {}", res.status(), res.text().await?);
        }
        Ok(())
    }

    async fn upload_finish(&self, pre: &UpPreData) -> Result<()> {
        self.request::<Value>(
            Method::POST,
            "/file/upload/finish",
            &[],
            Some(json!({
                "obj_key": pre.obj_key,
                "task_id": pre.task_id,
            })),
        )
        .await?;
        Ok(())
    }
}

impl QuarkBackend {
    fn http(&self) -> &Client {
        match self {
            QuarkBackend::Cookie(client) => &client.http,
            QuarkBackend::Open(client) => &client.http,
        }
    }

    async fn list_files(&self, parent_fid: &str) -> Result<Vec<QuarkFile>> {
        match self {
            QuarkBackend::Cookie(client) => client.list_files(parent_fid).await,
            QuarkBackend::Open(client) => client.list_files(parent_fid).await,
        }
    }

    async fn resolve_dir(&self, path: &str, create: bool) -> Result<String> {
        match self {
            QuarkBackend::Cookie(client) => client.resolve_dir(path, create).await,
            QuarkBackend::Open(client) => client.resolve_dir(path, create).await,
        }
    }

    async fn find_object(&self, key: &str) -> Result<Option<QuarkFile>> {
        match self {
            QuarkBackend::Cookie(client) => client.find_object(key).await,
            QuarkBackend::Open(client) => client.find_object(key).await,
        }
    }

    async fn download_url_and_cookie(&self, fid: &str) -> Result<(String, String)> {
        match self {
            QuarkBackend::Cookie(client) => {
                let url = client.download_url(fid).await?;
                let cookie = client.cookie.lock().await.clone();
                Ok((url, cookie))
            }
            QuarkBackend::Open(client) => {
                let url = client.download_url(fid).await?;
                let cookie = client.auth_cookie().await;
                Ok((url, cookie))
            }
        }
    }

    async fn delete_fid(&self, fid: &str) -> Result<()> {
        match self {
            QuarkBackend::Cookie(client) => client.delete_fid(fid).await,
            QuarkBackend::Open(client) => client.delete_fid(fid).await,
        }
    }

    async fn put_object(&self, key: &str, content_type: &str, body: Bytes) -> Result<()> {
        match self {
            QuarkBackend::Cookie(client) => client.put_object(key, content_type, body).await,
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
        if self.needs_bootstrap_refresh().await {
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
        if self.needs_bootstrap_refresh().await {
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

    async fn needs_bootstrap_refresh(&self) -> bool {
        let config = self.config.lock().await;
        config.access_token.is_empty() || config.app_id.is_empty() || config.sign_key.is_empty()
    }

    async fn ensure_open_credentials(&self) -> Result<()> {
        let config = self.config.lock().await;
        if config.access_token.is_empty() {
            bail!("quark_open needs access_token; refresh did not return one");
        }
        if config.app_id.is_empty() {
            bail!("quark_open needs app_id; set options.app_id or include it in oauth_file");
        }
        if config.sign_key.is_empty() {
            bail!(
                "quark_open needs sign_key; OpenList's public helper does not expose it, so set options.sign_key or include sign_key in oauth_file"
            );
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
        persist_quark_open_config(&snapshot)?;
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
    let bootstrap_config_path = env::var_os("ATREE_BOOTSTRAP_CONFIG").map(PathBuf::from);
    let config = load_or_init_config(&db_path, bootstrap_config_path.as_deref())?;
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
        .find(|mount| mount.enabled && mount.mount_type == "system_config")
        .map(|mount| mount.mount_path.clone())
        .unwrap_or_else(|| "/api/config.yaml".to_string())
}

fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/", any(root_handler))
        .route("/{bucket}", any(bucket_handler))
        .route("/{bucket}/", any(bucket_handler))
        .route("/{bucket}/{*key}", any(object_handler))
        .with_state(state)
}

async fn browser_virtual_entries_response(
    state: &AppState,
    headers: &HeaderMap,
    virtual_path: &str,
) -> Response {
    {
        let config = state.config.read().await;
        if !has_virtual_directory(&config, virtual_path) {
            return s3_error(StatusCode::NOT_FOUND, "NoSuchBucket", "bucket not found");
        }
    }
    if !is_authorized(state, headers, "ListBucket", virtual_path).await {
        return json_error(StatusCode::FORBIDDEN, "access denied");
    }
    let entries = browser_virtual_entries_json(state, virtual_path)
        .await
        .unwrap_or_else(|| "[]".to_string());
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        entries,
    )
        .into_response()
}

fn normalize_browser_virtual_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return "/".to_string();
    }
    format!("/{}", trimmed.trim_matches('/'))
}

fn has_virtual_directory(config: &ServiceConfig, virtual_path: &str) -> bool {
    let current = normalize_browser_virtual_path(virtual_path);
    if current == "/" {
        return true;
    }
    let prefix = format!("{}/", current.trim_end_matches('/'));
    config
        .mounts
        .iter()
        .filter(|mount| mount.enabled)
        .map(|mount| normalize_browser_virtual_path(&mount.mount_path))
        .any(|mount_path| mount_path.starts_with(&prefix))
}

async fn browser_virtual_entries_json(state: &AppState, virtual_path: &str) -> Option<String> {
    let current = normalize_browser_virtual_path(virtual_path);
    let bucket = state_bucket(state).await;
    let config = state.config.read().await;
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if current == "/" {
        entries.push(json!({
            "type": "dir",
            "name": bucket.clone(),
            "href": format!("/{}/", bucket),
        }));
        seen.insert(bucket);
    }

    for mount in &config.mounts {
        if !mount.enabled || mount.mount_path == "/" {
            continue;
        }
        let normalized = normalize_browser_virtual_path(&mount.mount_path);
        if current == "/" {
            let Some(first) = normalized.trim_start_matches('/').split('/').next() else {
                continue;
            };
            if first.is_empty() || !seen.insert(first.to_string()) {
                continue;
            }
            entries.push(json!({
                "type": "dir",
                "name": first,
                "href": format!("/{}/", first),
            }));
            continue;
        }

        let prefix = format!("{}/", current.trim_end_matches('/'));
        if !normalized.starts_with(&prefix) {
            continue;
        }
        let rest = &normalized[prefix.len()..];
        if rest.is_empty() {
            continue;
        }
        let mut parts = rest.split('/');
        let Some(first) = parts.next() else {
            continue;
        };
        if first.is_empty() || !seen.insert(first.to_string()) {
            continue;
        }
        let is_file = parts.next().is_none();
        let href = if is_file {
            format!("{}/{}", current.trim_end_matches('/'), first)
        } else {
            format!("{}/{}/", current.trim_end_matches('/'), first)
        };
        entries.push(json!({
            "type": if is_file { "file" } else { "dir" },
            "name": first,
            "href": href,
        }));
    }
    (!entries.is_empty())
        .then(|| serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string()))
}

async fn root_handler(
    State(state): State<AppState>,
    RawQuery(raw_query): RawQuery,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let bucket = state_bucket(&state).await;
    let config_path = state_config_path(&state).await;
    let raw_query = raw_query.unwrap_or_default();
    let params = parse_query(&raw_query);
    if method == Method::GET && params.contains_key("atree-browser-list") {
        return browser_virtual_entries_response(&state, &headers, "/").await;
    }
    if method == Method::GET && wants_html(&headers) {
        return html_response(
            StatusCode::OK,
            file_browser_html(&bucket, &config_path, "null", "null"),
        );
    }
    if method != Method::GET {
        return s3_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "MethodNotAllowed",
            "unsupported method",
        );
    }
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Buckets><Bucket><Name>{}</Name></Bucket></Buckets>
</ListAllMyBucketsResult>"#,
        xml_escape(&bucket)
    );
    xml_response(StatusCode::OK, xml)
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

async fn bucket_handler(
    State(state): State<AppState>,
    Path(bucket): Path<String>,
    RawQuery(raw_query): RawQuery,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let current_bucket = state_bucket(&state).await;
    if bucket != current_bucket {
        let virtual_path = format!("/{}", percent_decode_path(&bucket).trim_matches('/'));
        let query = raw_query.as_deref().unwrap_or_default();
        let params = parse_query(query);
        if method == Method::GET && params.contains_key("atree-browser-list") {
            return browser_virtual_entries_response(&state, &headers, &virtual_path).await;
        }
        if method == Method::GET && wants_html(&headers) {
            let config = state.config.read().await;
            let is_virtual_dir = has_virtual_directory(&config, &virtual_path);
            drop(config);
            if is_virtual_dir {
                return browser_directory(&state, &virtual_path, &headers, true).await;
            }
        }
        let config = state.config.read().await;
        let mount = resolve_explicit_mount(&config, &virtual_path);
        drop(config);
        match mount {
            Some(ResolvedMount::SystemConfig { virtual_path }) => {
                return system_file_handler(&state, method, &headers, Bytes::new(), &virtual_path)
                    .await;
            }
            Some(ResolvedMount::UrlTree { url, proxy }) => {
                let action = match method {
                    Method::GET => "GetObject",
                    Method::HEAD => "HeadObject",
                    _ => "Unknown",
                };
                if !is_authorized(&state, &headers, action, &virtual_path).await {
                    return access_denied_response(&state, &headers, &current_bucket).await;
                }
                return url_object(method, &headers, url, proxy).await;
            }
            Some(ResolvedMount::GithubReleases { rest, config }) => {
                let action = match method {
                    Method::GET => "ListBucket",
                    Method::HEAD => "HeadObject",
                    _ => "Unknown",
                };
                if !is_authorized(&state, &headers, action, &virtual_path).await {
                    return access_denied_response(&state, &headers, &current_bucket).await;
                }
                return github_releases_object(method, &headers, rest, config).await;
            }
            _ => {}
        }
        return s3_error(StatusCode::NOT_FOUND, "NoSuchBucket", "bucket not found");
    }
    let raw_query = raw_query.unwrap_or_default();
    if method == Method::GET && parse_query(&raw_query).contains_key("location") {
        return xml_response(
            StatusCode::OK,
            r#"<?xml version="1.0" encoding="UTF-8"?>
<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>"#
                .to_string(),
        );
    }
    if method == Method::GET && wants_html(&headers) {
        return browser_directory(&state, "/", &headers, false).await;
    }
    match method {
        Method::GET => list_objects(state, raw_query, "/", &headers).await,
        Method::HEAD => StatusCode::OK.into_response(),
        Method::PUT => StatusCode::OK.into_response(),
        _ => s3_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "MethodNotAllowed",
            "unsupported method",
        ),
    }
}

async fn object_handler(
    State(state): State<AppState>,
    Path((bucket, key)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let key = percent_decode_path(&key);
    let current_bucket = state_bucket(&state).await;
    let is_bucket_path = bucket == current_bucket;
    let virtual_path = if is_bucket_path {
        format!("/{}", key.trim_start_matches('/'))
    } else {
        let bucket = percent_decode_path(&bucket);
        format!(
            "/{}/{}",
            bucket.trim_matches('/'),
            key.trim_start_matches('/')
        )
    };
    if key.trim_matches('/').is_empty() {
        if !is_bucket_path {
            let query = raw_query.as_deref().unwrap_or_default();
            let params = parse_query(query);
            if method == Method::GET && params.contains_key("atree-browser-list") {
                return browser_virtual_entries_response(&state, &headers, &virtual_path).await;
            }
            if method == Method::GET && wants_html(&headers) {
                let config = state.config.read().await;
                let is_virtual_dir = has_virtual_directory(&config, &virtual_path);
                drop(config);
                if is_virtual_dir {
                    return browser_directory(&state, &virtual_path, &headers, true).await;
                }
            }
            let config = state.config.read().await;
            let mount = resolve_explicit_mount(&config, &virtual_path);
            drop(config);
            if let Some(ResolvedMount::SystemConfig { virtual_path }) = mount {
                return system_file_handler(&state, method, &headers, body, &virtual_path).await;
            }
            return s3_error(StatusCode::NOT_FOUND, "NoSuchBucket", "bucket not found");
        }
        return match method {
            Method::GET if wants_html(&headers) => {
                browser_directory(&state, "/", &headers, false).await
            }
            Method::GET => list_objects(state, raw_query.unwrap_or_default(), "/", &headers).await,
            Method::HEAD | Method::PUT => StatusCode::OK.into_response(),
            _ => s3_error(
                StatusCode::METHOD_NOT_ALLOWED,
                "MethodNotAllowed",
                "unsupported method",
            ),
        };
    }
    if method == Method::GET && key.ends_with('/') && wants_html(&headers) {
        return browser_directory(&state, &virtual_path, &headers, false).await;
    }
    if method == Method::GET && key.ends_with('/') {
        return list_objects(
            state,
            raw_query.unwrap_or_default(),
            &virtual_path,
            &headers,
        )
        .await;
    }

    let params = parse_query(raw_query.as_deref().unwrap_or_default());
    let config = state.config.read().await;
    let resolved_mount = if is_bucket_path {
        resolve_mount(&config, &virtual_path)
    } else {
        resolve_explicit_mount(&config, &virtual_path)
    };
    let action = match method {
        Method::GET => "GetObject",
        Method::HEAD => "HeadObject",
        Method::PUT | Method::POST => "PutObject",
        Method::DELETE => "DeleteObject",
        _ => "Unknown",
    };
    if !is_authorized(&state, &headers, action, &virtual_path).await {
        return access_denied_response(&state, &headers, &current_bucket).await;
    }
    let mount = match resolved_mount {
        Some(mount) => mount,
        None if is_bucket_path => {
            return s3_error(StatusCode::NOT_FOUND, "NoSuchKey", "mount not found");
        }
        None => return s3_error(StatusCode::NOT_FOUND, "NoSuchBucket", "bucket not found"),
    };
    drop(config);
    let (remote_key, backend) = match mount {
        ResolvedMount::Quark {
            remote_key,
            cookie,
            root_fid,
        } => {
            let quark = match quark_client(cookie, root_fid) {
                Ok(quark) => quark,
                Err(err) => {
                    return s3_error(StatusCode::BAD_REQUEST, "InvalidConfig", &err.to_string());
                }
            };
            (remote_key, QuarkBackend::Cookie(quark))
        }
        ResolvedMount::QuarkOpen { remote_key, config } => {
            let quark = match quark_open_client(config) {
                Ok(quark) => quark,
                Err(err) => {
                    return s3_error(StatusCode::BAD_REQUEST, "InvalidConfig", &err.to_string());
                }
            };
            (remote_key, QuarkBackend::Open(quark))
        }
        ResolvedMount::SystemConfig { virtual_path } => {
            return system_file_handler(&state, method, &headers, body, &virtual_path).await;
        }
        ResolvedMount::UrlTree { url, proxy } => {
            return url_object(method, &headers, url, proxy).await;
        }
        ResolvedMount::GithubReleases { rest, config } => {
            return github_releases_object(method, &headers, rest, config).await;
        }
    };
    if method == Method::POST && params.contains_key("uploads") {
        return initiate_multipart_upload(&state, &key, &remote_key).await;
    }
    if method == Method::PUT && params.contains_key("uploadId") && params.contains_key("partNumber")
    {
        return upload_multipart_part(&state, &params, body).await;
    }
    if method == Method::POST && params.contains_key("uploadId") {
        return complete_multipart_upload(&state, &backend, &key, &remote_key, &params).await;
    }
    if method == Method::DELETE && params.contains_key("uploadId") {
        return abort_multipart_upload(&state, &params).await;
    }
    let result = match method {
        Method::GET => get_object_cached(&state, &backend, &virtual_path, &remote_key, &headers).await,
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
    let dir_path = if delimiter.as_deref() == Some("/") {
        prefix.trim_end_matches('/').to_string()
    } else {
        prefix.clone()
    };

    if !is_authorized(&state, headers, "ListBucket", &virtual_prefix).await {
        return access_denied_response(&state, headers, &bucket).await;
    }

    let config = state.config.read().await;
    let (remote_dir, backend) = match resolve_mount(&config, &virtual_prefix) {
        Some(ResolvedMount::Quark {
            remote_key,
            cookie,
            root_fid,
        }) => {
            let quark = match quark_client(cookie, root_fid) {
                Ok(quark) => quark,
                Err(err) => {
                    return s3_error(StatusCode::BAD_REQUEST, "InvalidConfig", &err.to_string());
                }
            };
            (remote_key, QuarkBackend::Cookie(quark))
        }
        Some(ResolvedMount::QuarkOpen { remote_key, config }) => {
            let quark = match quark_open_client(config) {
                Ok(quark) => quark,
                Err(err) => {
                    return s3_error(StatusCode::BAD_REQUEST, "InvalidConfig", &err.to_string());
                }
            };
            (remote_key, QuarkBackend::Open(quark))
        }
        Some(ResolvedMount::GithubReleases { rest, config }) => {
            if rest.trim_matches('/').is_empty() {
                return list_github_releases(&config, headers, &bucket, prefix.trim_matches('/'))
                    .await;
            }
            return list_xml(
                &bucket,
                &prefix,
                delimiter.as_deref(),
                max_keys,
                None,
                Vec::new(),
                Vec::new(),
            );
        }
        None => {
            return list_xml(
                &bucket,
                &prefix,
                delimiter.as_deref(),
                max_keys,
                None,
                Vec::new(),
                Vec::new(),
            );
        }
        _ => {
            return list_xml(
                &bucket,
                &prefix,
                delimiter.as_deref(),
                max_keys,
                None,
                Vec::new(),
                Vec::new(),
            );
        }
    };
    drop(config);
    let parent = match backend.resolve_dir(&remote_dir, false).await {
        Ok(fid) => fid,
        Err(_) => {
            return list_xml(
                &bucket,
                &prefix,
                delimiter.as_deref(),
                max_keys,
                None,
                Vec::new(),
                Vec::new(),
            );
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
    list_xml(
        &bucket,
        &prefix,
        delimiter.as_deref(),
        max_keys,
        next_token.as_deref(),
        objects,
        common_prefixes,
    )
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
    Ok(resp)
}

async fn get_object_bytes(backend: &QuarkBackend, key: &str) -> Result<CachedObject> {
    let file = backend
        .find_object(key)
        .await?
        .filter(|f| f.file)
        .ok_or_else(|| anyhow!("object not found"))?;
    let (url, cookie) = backend.download_url_and_cookie(&file.fid).await?;
    let res = backend
        .http()
        .get(url)
        .header(header::COOKIE, cookie)
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
        return cached_object_response(cached, headers, false);
    }
    let cached = get_object_bytes(backend, key).await?;
    write_cached_object(state, virtual_path, &cached).await;
    cached_object_response(cached, headers, false)
}

async fn head_object_cached(
    state: &AppState,
    backend: &QuarkBackend,
    virtual_path: &str,
    key: &str,
) -> Result<Response> {
    if let Some(cached) = read_cached_object(state, virtual_path).await {
        return cached_object_response(cached, &HeaderMap::new(), true);
    }
    head_object(backend, key).await
}

fn cached_object_response(
    cached: CachedObject,
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
        Response::new(Body::from(cached.bytes.slice(start as usize..(end + 1) as usize)))
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
    if let Some(content_type) = cached.meta.content_type
        && let Ok(value) = HeaderValue::from_str(&content_type)
    {
        resp.headers_mut().insert(header::CONTENT_TYPE, value);
    }
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
    url: String,
    proxy: Option<String>,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return s3_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "MethodNotAllowed",
            "url_tree mounts are read-only",
        );
    }
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(120));
    if let Some(proxy_url) = proxy {
        match Proxy::all(&proxy_url) {
            Ok(proxy) => builder = builder.proxy(proxy),
            Err(err) => return s3_error(StatusCode::BAD_REQUEST, "InvalidProxy", &err.to_string()),
        }
    }
    let client = match builder.build() {
        Ok(client) => client,
        Err(err) => {
            return s3_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ProxyError",
                &err.to_string(),
            );
        }
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
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            resp.headers_mut().insert(name, value.clone());
        }
    }
    resp
}

async fn github_releases_object(
    method: Method,
    headers: &HeaderMap,
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
        return list_github_releases(&config, headers, "github_releases", "").await;
    }
    let release = match fetch_github_release(&config).await {
        Ok(release) => release,
        Err(err) => return s3_error(StatusCode::BAD_GATEWAY, "GithubError", &err.to_string()),
    };
    let Some((url, size, modified, content_type)) = github_release_file(&release, &config, rest)
    else {
        return s3_error(StatusCode::NOT_FOUND, "NoSuchKey", "object not found");
    };
    let mut response = url_object(method, headers, url, config.proxy.clone()).await;
    if response.status().is_success() {
        if let Ok(value) = HeaderValue::from_str(&size.to_string()) {
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

async fn list_github_releases(
    config: &GithubReleasesConfig,
    headers: &HeaderMap,
    bucket: &str,
    prefix: &str,
) -> Response {
    let release = match fetch_github_release(config).await {
        Ok(release) => release,
        Err(err) => return s3_error(StatusCode::BAD_GATEWAY, "GithubError", &err.to_string()),
    };
    let entries = github_release_entries(&release, config);
    if wants_html(headers) {
        return html_response(StatusCode::OK, github_release_html(&config.repo, &entries));
    }
    let entries = entries
        .into_iter()
        .map(|mut entry| {
            let prefix = prefix.trim_matches('/');
            if !prefix.is_empty() {
                entry.key = format!("{prefix}/{}", entry.key);
            }
            entry
        })
        .collect();
    list_xml_entries(bucket, prefix, Some("/"), entries, Vec::new(), 1000, None)
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
    let bucket = state_bucket(state).await;
    let config_path = state_config_path(state).await;
    let html = |error_json: &str| {
        html_response(
            StatusCode::OK,
            file_browser_html(&bucket, &config_path, "null", error_json),
        )
    };
    if synthetic || virtual_path == "/" {
        return html("null");
    }
    if !is_authorized(state, headers, "ListBucket", virtual_path).await {
        return html("null");
    }
    let Some(index_key) = find_directory_index(state, virtual_path).await else {
        return html("null");
    };
    let index_path = format!("/{index_key}");
    if !is_authorized(state, headers, "GetObject", &index_path).await {
        return html("null");
    }
    let config = state.config.read().await;
    let Some((remote_key, backend)) =
        resolve_mount(&config, &index_path).and_then(backend_from_mount)
    else {
        return html("null");
    };
    match get_object_cached(state, &backend, &index_path, &remote_key, headers).await {
        Ok(resp) => resp,
        Err(_) => html("null"),
    }
}

async fn find_directory_index(state: &AppState, virtual_path: &str) -> Option<String> {
    let prefix = virtual_path.trim_matches('/');
    let config = state.config.read().await;
    let (remote_key, backend) = backend_from_mount(resolve_mount(&config, &format!("/{prefix}"))?)?;
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
        .map(|key| format!("key:{}", key.name))
        .unwrap_or_else(|| "anonymous".to_string())
}

fn policy_allows(config: &ServiceConfig, principal: &str, action: &str, resource: &str) -> bool {
    if principal == "root" {
        return true;
    }
    config.auth.rules.iter().any(|rule| {
        rule.principal == principal
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
        return resource == prefix || resource.starts_with(&format!("{prefix}/"));
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

fn list_xml(
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
    list_xml_entries(
        bucket,
        prefix,
        delimiter,
        entries,
        common_prefixes,
        max_keys,
        next_token,
    )
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
    xml_response(StatusCode::OK, xml)
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

fn access_denied(headers: &HeaderMap, bucket: &str, config_path: &str) -> Response {
    if wants_html(headers) {
        html_response(
            StatusCode::UNAUTHORIZED,
            file_browser_html(bucket, config_path, "null", r#""需要访问 key。""#),
        )
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

fn parse_set_cookie_value(set_cookie: &str, name: &str) -> Option<String> {
    set_cookie
        .split(';')
        .next()?
        .strip_prefix(&format!("{name}="))
        .map(str::to_string)
}

fn set_cookie_value(cookie: &str, name: &str, value: &str) -> String {
    let mut found = false;
    let mut parts = Vec::new();
    for part in cookie.split(';').map(str::trim).filter(|p| !p.is_empty()) {
        if part.starts_with(&format!("{name}=")) {
            parts.push(format!("{name}={value}"));
            found = true;
        } else {
            parts.push(part.to_string());
        }
    }
    if !found {
        parts.push(format!("{name}={value}"));
    }
    parts.join("; ")
}

fn oss_url(pre: &UpPreData) -> Result<String> {
    let host = pre
        .upload_url
        .strip_prefix("https://")
        .or_else(|| pre.upload_url.strip_prefix("http://"))
        .ok_or_else(|| anyhow!("unexpected upload_url: {}", pre.upload_url))?;
    Ok(format!("https://{}.{}/{}", pre.bucket, host, pre.obj_key))
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

fn timing_log(stage: &str, key: &str, bytes: i64, start: SystemTime) {
    if env::var_os("TIMING_LOG").is_none() {
        return;
    }
    let elapsed = start.elapsed().unwrap_or_default();
    eprintln!(
        "timing stage={} ms={} bytes={} key={}",
        stage,
        elapsed.as_millis(),
        bytes,
        key
    );
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
    use std::sync::atomic::{AtomicU64, Ordering};
    use tower::ServiceExt;

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn config_with_mounts(mounts: Vec<MountConfig>) -> ServiceConfig {
        ServiceConfig {
            s3_bucket: "atree".to_string(),
            mounts,
            auth: AuthConfig::default(),
            cache: CacheConfig::default(),
        }
    }

    fn mount(mount_path: &str, root_path: &str) -> MountConfig {
        MountConfig {
            mount_path: mount_path.to_string(),
            mount_type: "quark_cookie".to_string(),
            root_path: root_path.to_string(),
            enabled: true,
            options: Value::Null,
        }
    }

    fn test_state() -> AppState {
        let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let db_path = std::env::temp_dir().join(format!(
            "atree-test-{}-{}-{}.sqlite",
            std::process::id(),
            chrono_millis(),
            id
        ));
        let config = load_or_init_config(&db_path, None).unwrap();
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
        AppState {
            config: Arc::new(RwLock::new(config)),
            cache_dir,
            multipart_dir,
            db_path,
            root_key: Some("root-test-key".to_string()),
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
        assert!(read_cached_object(&state, "/atree/demo.txt").await.is_none());
    }

    #[test]
    fn bootstrap_config_can_seed_empty_db() {
        let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "atree-bootstrap-{}-{}-{}",
            std::process::id(),
            chrono_millis(),
            id
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db_path = root.join("atree.sqlite");
        let bootstrap_path = root.join("config.yaml");
        std::fs::write(
            &bootstrap_path,
            r#"
s3_bucket: atree
mounts:
  - mount_path: /
    type: quark_open
    root_path: /
    enabled: true
    options:
      oauth_file: /data/quark-open-oauth.yaml
  - mount_path: /api/config.yaml
    type: system_config
    root_path: /
    enabled: true
auth:
  keys: []
  rules: []
cache:
  enabled: true
  ttl_seconds: 600
  max_bytes: 1048576
"#,
        )
        .unwrap();
        let config = load_or_init_config(&db_path, Some(&bootstrap_path)).unwrap();
        assert_eq!(config.s3_bucket, "atree");
        assert_eq!(config.cache.ttl_seconds, 600);
        assert_eq!(config.mounts[0].mount_type, "quark_open");
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
                mount_path: "/github".to_string(),
                mount_type: "url_tree".to_string(),
                root_path: "https://github.com/example-org/releases".to_string(),
                enabled: true,
                options: json!({"proxy": "http://127.0.0.1:1080"}),
            },
            MountConfig {
                mount_path: "/api/config.yaml".to_string(),
                mount_type: "system_config".to_string(),
                root_path: "/".to_string(),
                enabled: true,
                options: Value::Null,
            },
        ]);

        assert!(matches!(
            resolve_mount(&config, "/api/config.yaml"),
            Some(ResolvedMount::SystemConfig { virtual_path }) if virtual_path == "/api/config.yaml"
        ));
        assert!(matches!(
            resolve_mount(&config, "/github/client.tar.gz"),
            Some(ResolvedMount::UrlTree { url, proxy })
                if url == "https://github.com/example-org/releases/client.tar.gz"
                    && proxy.as_deref() == Some("http://127.0.0.1:1080")
        ));
        assert!(!matches!(resolve_mount(&config, "/api/"), Some(ResolvedMount::SystemConfig { .. })));
    }

    #[test]
    fn quark_open_expired_response_is_detected_even_on_http_400() {
        let body =
            Bytes::from(r#"{"status":-1,"errno":11001,"error_info":"Access Token无效"}"#);
        assert!(quark_open_response_expired(StatusCode::BAD_REQUEST, &body).unwrap());
    }

    #[test]
    fn quark_open_non_json_http_error_still_reports_http_failure() {
        let body = Bytes::from_static(b"upstream exploded");
        let err = quark_open_response_expired(StatusCode::BAD_GATEWAY, &body).unwrap_err();
        assert!(err
            .to_string()
            .contains("quark open api http 502 Bad Gateway: upstream exploded"));
    }

    #[test]
    fn github_releases_mount_resolves_and_filters_assets() {
        let config = config_with_mounts(vec![
            mount("/", "/root"),
            MountConfig {
                mount_path: "/clients/hiddify".to_string(),
                mount_type: "github_releases".to_string(),
                root_path: "hiddify/hiddify-app".to_string(),
                enabled: true,
                options: json!({
                    "asset_allow": ["*MacOS.dmg", "*Windows*.zip"],
                    "show_source_code": true,
                    "proxy": "http://127.0.0.1:1080"
                }),
            },
            MountConfig {
                mount_path: "/api/config.yaml".to_string(),
                mount_type: "system_config".to_string(),
                root_path: "/".to_string(),
                enabled: true,
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
        assert!(policy_allows(&config, "anonymous", "GetObject", "/public"));
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
    fn plain_key_is_hashed_and_not_serialized() {
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
                    principal: "key:reader".to_string(),
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
        assert!(!raw.contains("plain_key"));
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
        let mut config = ServiceConfig::default();
        config.mounts[0].root_path = "../bad".to_string();
        assert!(validate_config(&config).is_err());

        let mut config = ServiceConfig::default();
        config.auth.rules.push(AuthRule {
            principal: "key:missing".to_string(),
            actions: vec!["GetObject".to_string()],
            resources: vec!["/*".to_string()],
        });
        assert!(validate_config(&config).is_err());

        let mut config = ServiceConfig::default();
        config.mounts[1].mount_path = "/".to_string();
        assert!(validate_config(&config).is_err());
    }

    #[tokio::test]
    async fn root_route_negotiates_browser_html_and_s3_xml() {
        let app = build_app(test_state());

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
        assert!(html.contains("var DIRECTORY_ENTRIES = null;"));

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
        assert_eq!(xml_resp.status(), StatusCode::OK);
        let xml = response_text(xml_resp).await;
        assert!(xml.contains("<ListAllMyBucketsResult"));
        assert!(xml.contains("<Name>atree</Name>"));
    }

    #[tokio::test]
    async fn root_browser_list_requires_auth_and_root_can_read_it() {
        let app = build_app(test_state());

        let no_auth = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/?atree-browser-list=1")
                    .header(header::ACCEPT, "application/json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_auth.status(), StatusCode::FORBIDDEN);

        let root = app
            .oneshot(
                Request::builder()
                    .uri("/?atree-browser-list=1")
                    .header(header::ACCEPT, "application/json")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(root.status(), StatusCode::OK);
        let body = response_text(root).await;
        assert!(body.contains("\"name\":\"atree\""));
        assert!(body.contains("\"name\":\"api\""));
    }

    #[tokio::test]
    async fn synthetic_directory_browser_shell_defers_auth_to_client_fetch() {
        let app = build_app(test_state());

        let response = app
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
        assert!(body.contains("var DIRECTORY_ENTRIES = null;"));
        assert!(!body.contains("var DIRECTORY_ERROR = \"需要访问 key。\";"));
    }

    #[tokio::test]
    async fn synthetic_directory_browser_list_requires_auth_and_root_can_read_it() {
        let app = build_app(test_state());

        let no_auth = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/?atree-browser-list=1")
                    .header(header::ACCEPT, "application/json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_auth.status(), StatusCode::FORBIDDEN);

        let root = app
            .oneshot(
                Request::builder()
                    .uri("/api/?atree-browser-list=1")
                    .header(header::ACCEPT, "application/json")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(root.status(), StatusCode::OK);
        let body = response_text(root).await;
        assert!(body.contains("\"name\":\"config.yaml\""));
    }

    #[tokio::test]
    async fn root_browser_view_shows_top_level_entries() {
        let app = build_app(test_state());

        let response = app
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
        assert!(body.contains("var DIRECTORY_ENTRIES = null;"));
        assert!(body.contains("u.searchParams.set('atree-browser-list', '1');"));
    }

    #[tokio::test]
    async fn config_api_yaml_requires_root_hashes_plain_key_and_rejects_invalid_config() {
        let app = build_app(test_state());

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
  - mount_path: bad
    type: quark_cookie
    root_path: /
    enabled: true
"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
        assert!(
            response_text(bad)
                .await
                .contains("mount_path must start with /")
        );

        let good_config = r#"
mounts:
  - mount_path: /
    type: quark_cookie
    root_path: /
    enabled: true
  - mount_path: /api/config.yaml
    type: system_config
    root_path: /
    enabled: true
auth:
  keys:
    - name: reader
      plain_key: reader-test-key
      enabled: true
  rules:
    - principal: key:reader
      actions: [ListBucket]
      resources: [/*]
cache:
  enabled: true
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
        assert!(put_body.contains("# mounts[].mount_path"));
        assert!(put_body.contains("key_hash: sha256:"));
        assert!(!put_body.contains("reader-test-key"));
        assert!(!put_body.contains("\nplain_key:"));

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
        assert!(!get_body.contains("\nplain_key:"));
    }

    #[tokio::test]
    async fn config_api_supports_commented_yaml_roundtrip() {
        let app = build_app(test_state());
        let yaml_config = r#"
# This comment should be ignored on PUT.
mounts:
  - mount_path: /
    type: quark_cookie
    root_path: /
    enabled: true
  - mount_path: /api/config.yaml
    type: system_config
    root_path: /
    enabled: true
auth:
  keys:
    # plain_key is accepted only on write and removed on read.
    - name: yaml-reader
      plain_key: yaml-reader-key
      enabled: true
  rules:
    - principal: key:yaml-reader
      actions: [ListBucket, GetObject]
      resources: [/*]
cache:
  enabled: true
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
        assert!(body.contains("# mounts[].mount_path"));
        assert!(body.contains("name: yaml-reader"));
        assert!(body.contains("key_hash: sha256:"));
        assert!(!body.contains("yaml-reader-key"));
        assert!(!body.contains("\nplain_key:"));
    }

    #[tokio::test]
    async fn config_yaml_can_be_delegated_with_normal_auth_rules() {
        let app = build_app(test_state());
        let bootstrap_config = r#"
mounts:
  - mount_path: /
    type: quark_cookie
    root_path: /
    enabled: true
  - mount_path: /api/config.yaml
    type: system_config
    root_path: /
    enabled: true
auth:
  keys:
    - name: config-editor
      plain_key: config-editor-key
      enabled: true
  rules:
    - principal: key:config-editor
      actions: [GetObject, PutObject]
      resources: [/api/config.yaml]
cache:
  enabled: true
  max_bytes: 1048576
"#;
        let bootstrap = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/config.yaml")
                    .header(header::AUTHORIZATION, "Bearer root-test-key")
                    .body(Body::from(bootstrap_config))
                    .unwrap(),
            )
            .await
            .unwrap();
        if bootstrap.status() != StatusCode::OK {
            let status = bootstrap.status();
            let body = response_text(bootstrap).await;
            panic!("bootstrap status {status}: {body}");
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
                    .body(Body::from(bootstrap_config))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(delegated_put.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn system_config_mount_path_can_be_any_file_path() {
        let app = build_app(test_state());
        let moved_config = r#"
mounts:
  - mount_path: /
    type: quark_cookie
    root_path: /
    enabled: true
  - mount_path: /system/live.yaml
    type: system_config
    root_path: /
    enabled: true
auth:
  keys:
    - name: config-reader
      plain_key: config-reader-key
      enabled: true
  rules:
    - principal: key:config-reader
      actions: [GetObject]
      resources: [/system/live.yaml]
cache:
  enabled: true
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
        async fn upstream() -> Response {
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
                    mount_path: "/".to_string(),
                    mount_type: "quark_cookie".to_string(),
                    root_path: "/".to_string(),
                    enabled: true,
                    options: Value::Null,
                },
                MountConfig {
                    mount_path: "/api/config.yaml".to_string(),
                    mount_type: "system_config".to_string(),
                    root_path: "/".to_string(),
                    enabled: true,
                    options: Value::Null,
                },
                MountConfig {
                    mount_path: "/github".to_string(),
                    mount_type: "url_tree".to_string(),
                    root_path: format!("http://{addr}/files"),
                    enabled: true,
                    options: Value::Null,
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
        let app = build_app(state);

        let response = app
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
    }

    #[tokio::test]
    async fn old_json_config_route_is_not_exposed() {
        let app = build_app(test_state());
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
    async fn old_help_route_is_not_supported() {
        let app = build_app(test_state());
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
        let app = build_app(test_state());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/atree?list-type=2&delimiter=/")
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
    async fn config_yaml_comments_include_ai_friendly_examples() {
        let app = build_app(test_state());
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
