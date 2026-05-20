use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime},
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
use futures_util::TryStreamExt;
use reqwest::Client;
use rusqlite::{Connection, params};
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

const QUARK_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
const REFERER: &str = "https://pan.quark.cn";
const API: &str = "https://drive.quark.cn/1/clouddrive";
const PR: &str = "ucpro";

#[derive(Clone)]
struct AppState {
    quark: QuarkClient,
    bucket: String,
    config: Arc<RwLock<ServiceConfig>>,
    db_path: PathBuf,
    super_admin_key: Option<String>,
    multipart_dir: PathBuf,
}

#[derive(Clone)]
struct QuarkClient {
    http: Client,
    cookie: Arc<Mutex<String>>,
    root_fid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServiceConfig {
    #[serde(default = "default_mounts")]
    mounts: Vec<MountConfig>,
    #[serde(default)]
    auth: AuthConfig,
    #[serde(default)]
    cache: CacheConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MountConfig {
    mount_path: String,
    #[serde(rename = "type")]
    mount_type: String,
    root_path: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    options: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AuthConfig {
    #[serde(default)]
    keys: Vec<KeyConfig>,
    #[serde(default)]
    rules: Vec<AuthRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KeyConfig {
    name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    key_hash: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    key_hint: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default, skip_serializing)]
    plain_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuthRule {
    principal: String,
    actions: Vec<String>,
    resources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheConfig {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default = "default_cache_max_bytes")]
    max_bytes: u64,
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

fn default_mounts() -> Vec<MountConfig> {
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

fn config_db_path() -> Result<PathBuf> {
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

fn load_or_init_config(db_path: &PathBuf) -> Result<ServiceConfig> {
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

fn save_config_to_db(db_path: &PathBuf, config: &ServiceConfig) -> Result<()> {
    let conn = Connection::open(db_path)?;
    let raw = serde_json::to_string_pretty(config)?;
    conn.execute(
        "INSERT INTO config (id, json, updated_at) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        params![raw, chrono_millis()],
    )?;
    Ok(())
}

fn normalize_config(mut config: ServiceConfig) -> Result<ServiceConfig> {
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

fn validate_config(config: &ServiceConfig) -> Result<()> {
    if config.mounts.is_empty() {
        bail!("config.mounts must contain at least one mount");
    }
    let mut mount_paths = std::collections::HashSet::new();
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

    let mut names = std::collections::HashSet::new();
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
        if let Some(name) = rule.principal.strip_prefix("key:") {
            if !names.contains(name) {
                bail!("rule references missing key '{}'", name);
            }
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

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cookie = env::var("QUARK_COOKIE").context("QUARK_COOKIE is required")?;
    let root_fid = env::var("QUARK_ROOT_FID").unwrap_or_else(|_| "0".into());
    let bucket = env::var("S3_BUCKET").unwrap_or_else(|_| "quark".into());
    let db_path = config_db_path()?;
    let multipart_dir = db_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("multipart");
    std::fs::create_dir_all(&multipart_dir)?;
    let config = load_or_init_config(&db_path)?;
    let super_admin_key = env::var("QUARK_S3_SUPER_ADMIN_KEY").ok();
    if super_admin_key.is_none() {
        warn!("QUARK_S3_SUPER_ADMIN_KEY is not set; /api/config will be unavailable");
    }
    let max_upload_bytes = env::var("MAX_UPLOAD_BYTES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(128 * 1024 * 1024);
    let bind: SocketAddr = env::var("BIND")
        .unwrap_or_else(|_| "127.0.0.1:9000".into())
        .parse()?;

    let state = AppState {
        quark: QuarkClient::new(cookie, root_fid)?,
        bucket,
        config: Arc::new(RwLock::new(config)),
        db_path,
        super_admin_key,
        multipart_dir,
    };
    let app = build_app(state, max_upload_bytes);
    let listener = TcpListener::bind(bind).await?;
    info!("serving quark-s3-demo at http://{bind}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn build_app(state: AppState, max_upload_bytes: usize) -> Router {
    Router::new()
        .route("/", any(root_handler))
        .route("/api/config", any(config_handler))
        .route("/api/help", any(help_handler))
        .route("/{bucket}", any(bucket_handler))
        .route("/{bucket}/", any(bucket_handler))
        .route("/{bucket}/{*key}", any(object_handler))
        .layer(DefaultBodyLimit::max(max_upload_bytes))
        .with_state(state)
}

async fn root_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    if method == Method::GET && wants_html(&headers) {
        return html_response(StatusCode::OK, file_browser_html(&state.bucket, "/"));
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
        xml_escape(&state.bucket)
    );
    xml_response(StatusCode::OK, xml)
}

async fn config_handler(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_super_admin(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "super admin key is required");
    }
    match method {
        Method::GET => {
            let config = state.config.read().await.clone();
            Json(config).into_response()
        }
        Method::PUT => {
            let config: ServiceConfig = match serde_json::from_slice(&body) {
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
            Json(json!({"ok": true, "config": config})).into_response()
        }
        _ => json_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "supported methods are GET and PUT",
        ),
    }
}

async fn help_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let origin = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|host| format!("http://{host}"))
        .unwrap_or_else(|| "http://127.0.0.1:9000".to_string());
    Json(json!({
        "service": "quark-s3-demo",
        "auth": {
            "user_header": "Authorization: Bearer <key>",
            "admin_header": "Authorization: Bearer <super-admin-key>"
        },
        "config": {
            "get": "GET /api/config",
            "put": "PUT /api/config",
            "note": "Config is one JSON document. Edit mounts, auth.keys, auth.rules, and cache together. PUT rejects invalid config and keeps the old one."
        },
        "s3": {
            "bucket": state.bucket,
            "list": "GET /{bucket}?list-type=2&delimiter=/&prefix=<path>",
            "get": "GET /{bucket}/{key}",
            "head": "HEAD /{bucket}/{key}",
            "put": "PUT /{bucket}/{key}",
            "delete": "DELETE /{bucket}/{key}"
        },
        "browser": {
            "mode": "Send Accept: text/html for the file browser or directory index. Send Accept: application/xml for S3 XML.",
            "login": "The HTML UI stores the service access key in localStorage and sends it as Authorization: Bearer <key> for list/read requests."
        },
        "examples": {
            "get_config": format!("curl -H 'Authorization: Bearer <super-admin-key>' '{origin}/api/config'"),
            "put_config": format!("curl -X PUT -H 'Authorization: Bearer <super-admin-key>' -H 'Content-Type: application/json' --data @config.json '{origin}/api/config'"),
            "list": format!("curl -H 'Authorization: Bearer <key>' '{origin}/{}?list-type=2&delimiter=/&prefix=public/'", state.bucket),
            "upload": format!("curl -X PUT -H 'Authorization: Bearer <key>' -H 'Content-Type: text/plain' --data-binary @./example.txt '{origin}/{}/public/example.txt'", state.bucket),
            "upload_with_curl_T": format!("curl -H 'Authorization: Bearer <key>' -T ./example.txt '{origin}/{}/public/example.txt'", state.bucket),
            "read": format!("curl -H 'Authorization: Bearer <key>' '{origin}/{}/public/example.txt'", state.bucket),
            "delete": format!("curl -X DELETE -H 'Authorization: Bearer <key>' '{origin}/{}/public/example.txt'", state.bucket)
        }
    }))
    .into_response()
}

async fn bucket_handler(
    State(state): State<AppState>,
    Path(bucket): Path<String>,
    RawQuery(raw_query): RawQuery,
    method: Method,
    headers: HeaderMap,
) -> Response {
    if bucket != state.bucket {
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
        return browser_directory(&state, "/", &headers).await;
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
    if bucket != state.bucket {
        return s3_error(StatusCode::NOT_FOUND, "NoSuchBucket", "bucket not found");
    }
    let key = percent_decode_path(&key);
    let virtual_path = format!("/{}", key.trim_start_matches('/'));
    if key.trim_matches('/').is_empty() {
        return match method {
            Method::GET if wants_html(&headers) => browser_directory(&state, "/", &headers).await,
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
        return browser_directory(&state, &virtual_path, &headers).await;
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
    let action = match method {
        Method::GET => "GetObject",
        Method::HEAD => "HeadObject",
        Method::PUT | Method::POST => "PutObject",
        Method::DELETE => "DeleteObject",
        _ => "Unknown",
    };
    if !is_authorized(&state, &headers, action, &virtual_path).await {
        return access_denied(&headers, &state.bucket);
    }
    let config = state.config.read().await;
    let remote_key = match resolve_remote_key(&config, &virtual_path) {
        Some(key) => key,
        None => return s3_error(StatusCode::NOT_FOUND, "NoSuchKey", "mount not found"),
    };
    drop(config);
    if method == Method::POST && params.contains_key("uploads") {
        return initiate_multipart_upload(&state, &key, &remote_key).await;
    }
    if method == Method::PUT && params.contains_key("uploadId") && params.contains_key("partNumber")
    {
        return upload_multipart_part(&state, &params, body).await;
    }
    if method == Method::POST && params.contains_key("uploadId") {
        return complete_multipart_upload(&state, &key, &remote_key, &params).await;
    }
    if method == Method::DELETE && params.contains_key("uploadId") {
        return abort_multipart_upload(&state, &params).await;
    }
    let result = match method {
        Method::GET => get_object(&state, &remote_key, &headers).await,
        Method::HEAD => head_object(&state, &remote_key).await,
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
            state
                .quark
                .put_object(&remote_key, &content_type, body)
                .await
                .map(|_| (StatusCode::OK, [(header::ETAG, etag)]).into_response())
        }
        Method::DELETE => delete_object(&state, &remote_key).await,
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
        return access_denied(headers, &state.bucket);
    }

    let config = state.config.read().await;
    let remote_dir = match resolve_remote_key(&config, &virtual_prefix) {
        Some(key) => key,
        None => {
            return list_xml(
                &state.bucket,
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
    let parent = match state.quark.resolve_dir(&remote_dir, false).await {
        Ok(fid) => fid,
        Err(_) => {
            return list_xml(
                &state.bucket,
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
    let files = match list_files_for_s3(&state.quark, &parent, &dir_path, recursive).await {
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
        &state.bucket,
        &prefix,
        delimiter.as_deref(),
        max_keys,
        next_token.as_deref(),
        objects,
        common_prefixes,
    )
}

async fn list_files_for_s3(
    quark: &QuarkClient,
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
        for f in quark.list_files(&fid).await? {
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

async fn get_object(state: &AppState, key: &str, headers: &HeaderMap) -> Result<Response> {
    let total_start = SystemTime::now();
    let file = state
        .quark
        .find_object(key)
        .await?
        .filter(|f| f.file)
        .ok_or_else(|| anyhow!("object not found"))?;
    let url = state.quark.download_url(&file.fid).await?;
    let cookie = state.quark.cookie.lock().await.clone();
    let range = parse_range_header(headers, file.size)?;
    let mut req = state
        .quark
        .http
        .get(url)
        .header(header::COOKIE, cookie)
        .header(header::REFERER, REFERER)
        .header(header::USER_AGENT, QUARK_UA);
    if let Some((start, end)) = range {
        req = req.header(header::RANGE, format!("bytes={start}-{end}"));
    }
    let res = req.send().await?;
    timing_log("download.headers", key, file.size, total_start);
    let status = res.status();
    if !(status.is_success() || status == StatusCode::PARTIAL_CONTENT) {
        bail!("download failed {status}");
    }
    let stream = res.bytes_stream().map_err(std::io::Error::other);
    let mut resp = Response::new(Body::from_stream(stream));
    if let Some((start, end)) = range {
        *resp.status_mut() = StatusCode::PARTIAL_CONTENT;
        resp.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{}", file.size))?,
        );
        resp.headers_mut().insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&(end - start + 1).to_string())?,
        );
    } else {
        *resp.status_mut() = StatusCode::OK;
        resp.headers_mut().insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&file.size.to_string())?,
        );
    }
    resp.headers_mut().insert(
        header::LAST_MODIFIED,
        HeaderValue::from_str(&http_time(file.updated_at.max(file.created_at)))?,
    );
    resp.headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    timing_log("download.response", key, file.size, total_start);
    Ok(resp)
}

async fn head_object(state: &AppState, key: &str) -> Result<Response> {
    let file = state
        .quark
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

async fn delete_object(state: &AppState, key: &str) -> Result<Response> {
    if let Some(file) = state.quark.find_object(key).await? {
        state.quark.delete_fid(&file.fid).await?;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn initiate_multipart_upload(state: &AppState, key: &str, remote_key: &str) -> Response {
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
            xml_escape(&state.bucket),
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
    match state
        .quark
        .put_object(remote_key, &content_type, Bytes::from(full))
        .await
    {
        Ok(()) => {
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
                    xml_escape(&state.bucket),
                    xml_escape(key),
                    xml_escape(&state.bucket),
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

async fn browser_directory(state: &AppState, virtual_path: &str, headers: &HeaderMap) -> Response {
    if is_authorized(state, headers, "ListBucket", virtual_path).await {
        if let Some(index_key) = find_directory_index(state, virtual_path).await {
            if is_authorized(state, headers, "GetObject", &format!("/{index_key}")).await {
                let config = state.config.read().await;
                if let Some(remote_key) = resolve_remote_key(&config, &format!("/{index_key}")) {
                    if let Ok(resp) = get_object(state, &remote_key, headers).await {
                        return resp;
                    }
                }
            }
        }
    }
    html_response(
        StatusCode::OK,
        file_browser_html(&state.bucket, virtual_path),
    )
}

async fn find_directory_index(state: &AppState, virtual_path: &str) -> Option<String> {
    let prefix = virtual_path.trim_matches('/');
    let config = state.config.read().await;
    let remote_dir = resolve_remote_key(&config, &format!("/{prefix}"))?;
    drop(config);
    let fid = state.quark.resolve_dir(&remote_dir, false).await.ok()?;
    let mut candidates = state
        .quark
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
    if state.super_admin_key.as_deref() == Some(token.as_str()) {
        return "super-admin".to_string();
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
    if principal == "super-admin" {
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

fn resolve_remote_key(config: &ServiceConfig, virtual_path: &str) -> Option<String> {
    let path = normalize_virtual_path(virtual_path);
    let mount = config
        .mounts
        .iter()
        .rev()
        .find(|mount| mount.enabled && mount_matches(&mount.mount_path, &path))?;
    if mount.mount_type != "quark_cookie" {
        return None;
    }
    let rest = strip_mount_path(&mount.mount_path, &path);
    Some(join_remote_path(&mount.root_path, rest))
}

fn mount_matches(mount_path: &str, path: &str) -> bool {
    let mount_path = normalize_virtual_path(mount_path);
    if mount_path == "/" {
        return true;
    }
    path == mount_path || path.starts_with(&format!("{mount_path}/"))
}

fn strip_mount_path<'a>(mount_path: &str, path: &'a str) -> &'a str {
    let mount_path = normalize_virtual_path(mount_path);
    if mount_path == "/" {
        return path.trim_start_matches('/');
    }
    path.strip_prefix(&mount_path)
        .unwrap_or("")
        .trim_start_matches('/')
}

fn join_remote_path(root_path: &str, rest: &str) -> String {
    let root = root_path.trim_matches('/');
    let rest = rest.trim_matches('/');
    match (root.is_empty(), rest.is_empty()) {
        (true, true) => String::new(),
        (true, false) => rest.to_string(),
        (false, true) => root.to_string(),
        (false, false) => format!("{root}/{rest}"),
    }
}

fn normalize_virtual_path(path: &str) -> String {
    let path = format!("/{}", path.trim_matches('/'));
    if path == "/" {
        path
    } else {
        path.trim_end_matches('/').to_string()
    }
}

fn wants_html(headers: &HeaderMap) -> bool {
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !accept
        .split(',')
        .any(|part| part.trim().starts_with("text/html"))
    {
        return false;
    }
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    ![
        "curl",
        "wget",
        "aws-cli",
        "boto3",
        "restic",
        "rclone",
        "go-http-client",
        "python-requests",
    ]
    .iter()
    .any(|tool| ua.contains(tool))
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

fn is_super_admin(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = state.super_admin_key.as_deref() else {
        return false;
    };
    bearer_token(headers).as_deref() == Some(expected)
}

fn hash_key(key: &str) -> String {
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

fn list_xml(
    bucket: &str,
    prefix: &str,
    delimiter: Option<&str>,
    max_keys: usize,
    next_token: Option<&str>,
    objects: Vec<(String, QuarkFile)>,
    common_prefixes: Vec<String>,
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
    for (key, f) in objects {
        xml.push_str(&format!(
            "  <Contents><Key>{}</Key><LastModified>{}</LastModified><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>\n",
            xml_escape(&key),
            iso_time(f.updated_at.max(f.created_at)),
            f.size
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

fn access_denied(headers: &HeaderMap, bucket: &str) -> Response {
    if wants_html(headers) {
        html_response(StatusCode::UNAUTHORIZED, file_browser_html(bucket, "/"))
    } else {
        s3_error(StatusCode::FORBIDDEN, "AccessDenied", "access denied")
    }
}

fn file_browser_html(bucket: &str, virtual_path: &str) -> String {
    let bucket_json = serde_json::to_string(bucket).unwrap_or_else(|_| "\"quark\"".to_string());
    let path_json = serde_json::to_string(virtual_path).unwrap_or_else(|_| "\"/\"".to_string());
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>quark-s3-demo</title>
  <style>
    :root {{ color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    body {{ margin: 0; background: Canvas; color: CanvasText; }}
    header {{ display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }}
    main {{ max-width: 1040px; margin: 0 auto; padding: 18px 20px 40px; }}
    button, input {{ font: inherit; }}
    button {{ border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); background: ButtonFace; color: ButtonText; border-radius: 6px; padding: 7px 10px; cursor: pointer; }}
    input {{ min-width: 220px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 6px; padding: 8px 10px; background: Field; color: FieldText; }}
    .bar {{ display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }}
    .auth {{ display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }}
    .crumbs {{ display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 14px; }}
    .crumbs a {{ color: LinkText; text-decoration: none; }}
    table {{ width: 100%; border-collapse: collapse; }}
    th, td {{ padding: 10px 8px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); text-align: left; }}
    th.size, td.size {{ width: 120px; text-align: right; }}
    th.time, td.time {{ width: 210px; }}
    a {{ color: LinkText; }}
    .muted {{ color: color-mix(in srgb, CanvasText 62%, transparent); }}
    .error {{ color: #b42318; }}
  </style>
</head>
<body>
  <header>
    <strong>quark-s3-demo</strong>
    <button id="copyHelp" type="button">复制 API help curl</button>
  </header>
  <main>
    <div class="bar">
      <nav id="crumbs" class="crumbs"></nav>
      <div class="auth">
        <span id="authState" class="muted"></span>
        <input id="keyInput" type="password" autocomplete="current-password" placeholder="访问 key">
        <button id="saveKey" type="button">保存</button>
        <button id="clearKey" type="button">清除</button>
      </div>
    </div>
    <p id="message" class="muted">加载中...</p>
    <table>
      <thead><tr><th>名称</th><th class="size">大小</th><th class="time">更新时间</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </main>
  <script>
    const BUCKET = {bucket_json};
    const INITIAL_PATH = {path_json};
    const keyName = 'quark_s3_demo_key';
    const keyInput = document.getElementById('keyInput');
    const authState = document.getElementById('authState');
    const message = document.getElementById('message');
    const rows = document.getElementById('rows');
    const crumbs = document.getElementById('crumbs');

    function currentKey() {{ return localStorage.getItem(keyName) || ''; }}
    function setAuthState() {{ authState.textContent = currentKey() ? '已保存 key' : '匿名访问'; }}
    function s3Path() {{
      const path = location.pathname === '/' ? '/' + BUCKET + '/' : location.pathname;
      return path.endsWith('/') ? path : path + '/';
    }}
    function keyPrefixFromPath() {{
      const parts = s3Path().split('/').filter(Boolean);
      if (parts[0] === BUCKET) parts.shift();
      return parts.length ? parts.join('/') + '/' : '';
    }}
    function listUrl() {{
      const u = new URL(s3Path(), location.origin);
      u.searchParams.set('list-type', '2');
      u.searchParams.set('delimiter', '/');
      const prefix = keyPrefixFromPath();
      if (prefix) u.searchParams.set('prefix', prefix);
      return u;
    }}
    function headers(accept = 'application/xml') {{
      const h = {{ 'Accept': accept }};
      const key = currentKey();
      if (key) h.Authorization = 'Bearer ' + key;
      return h;
    }}
    function fmtBytes(n) {{
      if (!n) return '';
      const units = ['B','KiB','MiB','GiB','TiB'];
      let v = Number(n), i = 0;
      while (v >= 1024 && i < units.length - 1) {{ v /= 1024; i++; }}
      return (i ? v.toFixed(1) : v.toFixed(0)) + ' ' + units[i];
    }}
    function renderCrumbs() {{
      const parts = keyPrefixFromPath().split('/').filter(Boolean);
      const links = [`<a href="/${{BUCKET}}/">/${{BUCKET}}</a>`];
      let acc = '';
      for (const part of parts) {{
        acc += encodeURIComponent(part) + '/';
        links.push(`<span>/</span><a href="/${{BUCKET}}/${{acc}}">${{part}}</a>`);
      }}
      crumbs.innerHTML = links.join('');
    }}
    async function load() {{
      setAuthState();
      renderCrumbs();
      rows.innerHTML = '';
      message.textContent = '加载中...';
      const res = await fetch(listUrl(), {{ headers: headers() }});
      if (res.status === 403 || res.status === 401) {{
        message.innerHTML = '<span class="error">需要访问 key。</span>';
        return;
      }}
      if (!res.ok) {{
        message.innerHTML = '<span class="error">列表失败：' + res.status + '</span>';
        return;
      }}
      const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
      const prefix = doc.querySelector('Prefix')?.textContent || keyPrefixFromPath();
      const items = [];
      doc.querySelectorAll('CommonPrefixes > Prefix').forEach(el => {{
        const full = el.textContent || '';
        const name = full.slice(prefix.length).replace(/\/$/, '');
        if (name) items.push({{ type: 'dir', name, href: '/' + BUCKET + '/' + full }});
      }});
      doc.querySelectorAll('Contents').forEach(el => {{
        const full = el.querySelector('Key')?.textContent || '';
        const name = full.slice(prefix.length);
        if (!name || name.includes('/')) return;
        items.push({{
          type: 'file',
          name,
          href: '/' + BUCKET + '/' + full,
          size: el.querySelector('Size')?.textContent || '',
          time: el.querySelector('LastModified')?.textContent || ''
        }});
      }});
      message.textContent = items.length ? '' : '空目录';
      rows.innerHTML = items.map(item => `
        <tr>
          <td>${{item.type === 'dir' ? '[dir]' : '[file]'}} <a href="${{item.href}}">${{item.name}}</a></td>
          <td class="size">${{item.type === 'file' ? fmtBytes(item.size) : ''}}</td>
          <td class="time muted">${{item.time || ''}}</td>
        </tr>
      `).join('');
    }}
    document.getElementById('saveKey').onclick = () => {{ localStorage.setItem(keyName, keyInput.value); keyInput.value = ''; load(); }};
    document.getElementById('clearKey').onclick = () => {{ localStorage.removeItem(keyName); load(); }};
    document.getElementById('copyHelp').onclick = async () => {{
      const cmd = `curl -H 'Authorization: Bearer <super-admin-key>' '${{location.origin}}/api/help'`;
      await navigator.clipboard.writeText(cmd);
      message.textContent = '已复制：' + cmd;
    }};
    load().catch(err => {{ message.innerHTML = '<span class="error">' + err.message + '</span>'; }});
  </script>
</body>
</html>"#
    )
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
    {
        if out.len() != expected {
            bail!(
                "invalid aws-chunked decoded length: got {}, expected {}",
                out.len(),
                expected
            );
        }
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
            (
                urlencoding::decode(k)
                    .unwrap_or_else(|_| k.into())
                    .into_owned(),
                urlencoding::decode(v)
                    .unwrap_or_else(|_| v.into())
                    .into_owned(),
            )
        })
        .collect()
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
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tower::ServiceExt;

    fn config_with_mounts(mounts: Vec<MountConfig>) -> ServiceConfig {
        ServiceConfig {
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
        let db_path = std::env::temp_dir().join(format!(
            "quark-s3-demo-test-{}-{}.sqlite",
            std::process::id(),
            chrono_millis()
        ));
        let config = load_or_init_config(&db_path).unwrap();
        let multipart_dir = db_path.with_extension("multipart");
        std::fs::create_dir_all(&multipart_dir).unwrap();
        AppState {
            quark: QuarkClient::new("dummy=1".to_string(), "0".to_string()).unwrap(),
            bucket: "quark".to_string(),
            config: Arc::new(RwLock::new(config)),
            multipart_dir,
            db_path,
            super_admin_key: Some("admin-test-key".to_string()),
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
    }

    #[tokio::test]
    async fn root_route_negotiates_browser_html_and_s3_xml() {
        let app = build_app(test_state(), 1024 * 1024);

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
        assert!(html.contains("quark-s3-demo"));
        assert!(html.contains("quark_s3_demo_key"));

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
        assert!(xml.contains("<Name>quark</Name>"));
    }

    #[tokio::test]
    async fn config_api_requires_admin_hashes_plain_key_and_rejects_invalid_config() {
        let state = test_state();
        let app = build_app(state, 1024 * 1024);

        let no_auth = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_auth.status(), StatusCode::UNAUTHORIZED);

        let bad = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/config")
                    .header(header::AUTHORIZATION, "Bearer admin-test-key")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"mounts":[{"mount_path":"bad","type":"quark_cookie","root_path":"/","enabled":true}]}"#,
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

        let good_config = r#"{
          "mounts": [{"mount_path": "/", "type": "quark_cookie", "root_path": "/", "enabled": true}],
          "auth": {
            "keys": [{"name": "reader", "plain_key": "reader-test-key", "enabled": true}],
            "rules": [{"principal": "key:reader", "actions": ["ListBucket"], "resources": ["/*"]}]
          },
          "cache": {"enabled": true, "max_bytes": 1048576}
        }"#;
        let put = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri("/api/config")
                    .header(header::AUTHORIZATION, "Bearer admin-test-key")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(good_config))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(put.status(), StatusCode::OK);
        let put_body = response_text(put).await;
        assert!(put_body.contains("\"ok\":true"));
        assert!(put_body.contains("sha256:"));
        assert!(!put_body.contains("reader-test-key"));
        assert!(!put_body.contains("plain_key"));

        let get = app
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::AUTHORIZATION, "Bearer admin-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        let get_body = response_text(get).await;
        assert!(get_body.contains("\"name\":\"reader\""));
        assert!(!get_body.contains("reader-test-key"));
        assert!(!get_body.contains("plain_key"));
    }

    #[tokio::test]
    async fn s3_list_is_default_denied_before_backend_access() {
        let app = build_app(test_state(), 1024 * 1024);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/quark?list-type=2&delimiter=/")
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
    async fn help_endpoint_is_ai_friendly_json() {
        let app = build_app(test_state(), 1024 * 1024);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/help")
                    .header(header::HOST, "127.0.0.1:9000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("\"service\":\"quark-s3-demo\""));
        assert!(body.contains("GET /api/config"));
        assert!(body.contains("GET /{bucket}?list-type=2"));
        assert!(body.contains("--data-binary @./example.txt"));
        assert!(body.contains("-T ./example.txt"));
    }
}
