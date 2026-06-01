use std::{path::PathBuf, sync::Arc};

use tokio::sync::RwLock;

use crate::drivers::{GithubReleasesConfig, QuarkOpenConfig, S3Config};
use crate::drivers::{github_releases, quark_open, s3, url_tree};
use crate::{QuarkBackend, config};

#[derive(Debug, Clone)]
pub(crate) enum ResolvedMount {
    QuarkOpen {
        remote_key: String,
        config: QuarkOpenConfig,
        mount_path: String,
    },
    SystemConfig {
        virtual_path: String,
    },
    UrlTree {
        url: String,
        proxy: Option<String>,
        size: Option<u64>,
    },
    GithubReleases {
        rest: String,
        config: GithubReleasesConfig,
    },
    S3 {
        remote_key: String,
        config: S3Config,
    },
}

#[cfg(test)]
pub(crate) fn resolve_remote_key(
    config: &config::ServiceConfig,
    virtual_path: &str,
) -> Option<String> {
    match resolve_mount(config, virtual_path)? {
        ResolvedMount::QuarkOpen { remote_key, .. } => Some(remote_key),
        _ => None,
    }
}

pub(crate) fn resolve_mount(
    config: &config::ServiceConfig,
    virtual_path: &str,
) -> Option<ResolvedMount> {
    let path = normalize_virtual_path(virtual_path);
    let mount = config
        .mounts
        .iter()
        .rev()
        .find(|mount| mount_matches_for_type(mount, &path))?;
    match mount.mount_type.as_str() {
        "quark_open" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            Some(ResolvedMount::QuarkOpen {
                remote_key: join_remote_path(config::mount_root_path(mount), rest),
                config: quark_open::from_mount(mount)?,
                mount_path: mount.mount_path.clone(),
            })
        }
        "system_config" => Some(ResolvedMount::SystemConfig {
            virtual_path: path.to_string(),
        }),
        "url_tree" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            let target = url_tree::target_from_mount(mount, rest)?;
            Some(ResolvedMount::UrlTree {
                url: target.url,
                proxy: target.proxy,
                size: target.size,
            })
        }
        "github_releases" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            Some(ResolvedMount::GithubReleases {
                rest: rest.to_string(),
                config: github_releases::from_mount(mount)?,
            })
        }
        "s3" => {
            let rest = strip_mount_path(&mount.mount_path, &path);
            Some(ResolvedMount::S3 {
                remote_key: join_remote_path(config::mount_root_path(mount), rest),
                config: s3::from_mount(mount)?,
            })
        }
        _ => None,
    }
}

pub(crate) fn resolve_github_release_mounts(
    config: &config::ServiceConfig,
    virtual_path: &str,
) -> Vec<(String, GithubReleasesConfig)> {
    let path = normalize_virtual_path(virtual_path);
    let matches = config
        .mounts
        .iter()
        .filter(|mount| {
            mount.mount_type == "github_releases" && mount_matches(&mount.mount_path, &path)
        })
        .collect::<Vec<_>>();
    let Some(best_len) = matches
        .iter()
        .map(|mount| normalize_virtual_path(&mount.mount_path).len())
        .max()
    else {
        return Vec::new();
    };
    matches
        .into_iter()
        .filter(|mount| normalize_virtual_path(&mount.mount_path).len() == best_len)
        .filter_map(|mount| {
            Some((
                strip_mount_path(&mount.mount_path, &path).to_string(),
                github_releases::from_mount(mount)?,
            ))
        })
        .collect()
}

pub(crate) fn backend_from_mount(
    db_path: PathBuf,
    service_config: Arc<RwLock<config::ServiceConfig>>,
    mount: ResolvedMount,
) -> Option<(String, QuarkBackend)> {
    match mount {
        ResolvedMount::QuarkOpen {
            remote_key,
            config,
            mount_path,
        } => Some((
            remote_key,
            QuarkBackend::Open(
                quark_open::client(config, &mount_path, db_path, service_config).ok()?,
            ),
        )),
        _ => None,
    }
}

fn mount_matches_for_type(mount: &config::MountConfig, path: &str) -> bool {
    if mount.mount_type == "system_config" {
        return normalize_virtual_path(&mount.mount_path) == path;
    }
    mount_matches(&mount.mount_path, path)
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

pub(crate) fn normalize_virtual_path(path: &str) -> String {
    let path = format!("/{}", path.trim_matches('/'));
    if path == "/" {
        path
    } else {
        path.trim_end_matches('/').to_string()
    }
}
