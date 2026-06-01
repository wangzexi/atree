pub(crate) mod github_releases;
pub(crate) mod options;
pub(crate) mod quark_open;
pub(crate) mod s3;
pub(crate) mod url_tree;

pub(crate) use github_releases::{GithubReleasesConfig, client as github_client};
pub(crate) use quark_open::{
    QuarkOpenConfig, client as quark_open_client, is_fnnas_quark_refresh_url,
};
pub(crate) use s3::S3Config;
