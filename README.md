# atree

AI 友好的文件树网关。协议 MIT。感谢 [OpenList](https://github.com/OpenListTeam/OpenList)，QuarkOpen 相关逻辑参考 `drivers/quark_open`。

## 先看代码

- `src/main.rs`：主逻辑、路由、QuarkOpen、测试。
- `src/config.rs`：配置 schema、默认配置、校验。
- `src/mounts.rs`：mount 解析。
- `src/ui.rs`：内嵌文件浏览器。
- `docs/oauth-notes.md`：OpenList/QuarkOpen 记录。

```bash
rg -n "quark_open|github_releases|system_config|ListBucket|PutObject" src docs
cargo test --quiet
```

## 本地运行

```bash
export ATREE_ROOT_KEY='replace-with-root-key'
export BIND='127.0.0.1:9000'
cargo run
```

环境变量看代码：`ATREE_ROOT_KEY`、`ATREE_DB`、`ATREE_MULTIPART_DIR`、`ATREE_CACHE_DIR`、`BIND`。

## Docker

```bash
docker run --rm \
  -p 9000:9000 \
  -e ATREE_ROOT_KEY='replace-with-root-key' \
  -e ATREE_DB='/data/atree.sqlite' \
  -v atree-data:/data \
  ghcr.io/wangzexi/atree:latest
```

镜像：`ghcr.io/wangzexi/atree:latest` 或 `ghcr.io/wangzexi/atree:<git-sha>`。

K8s：持久化 `/data`，`ATREE_ROOT_KEY` 用 Secret，`ATREE_DB=/data/atree.sqlite`。

## 配置入口

```bash
curl -H 'Authorization: Bearer <root-key>' \
  'http://127.0.0.1:9000/api/config.yaml' > config.yaml

curl -X PUT \
  -H 'Authorization: Bearer <root-key>' \
  --data-binary @config.yaml \
  'http://127.0.0.1:9000/api/config.yaml'
```

配置注释由代码生成：看 `src/config.rs` 的 `config_yaml_comments()` 和 `validate_config()`。mount 支持类型在 `src/mounts.rs`。

OpenList QuarkOpen 默认刷新接口是 `https://api.oplist.org/quarkyun/renewapi`。如果需要让 atree 获取 `app_id/sign_key`，看 `docs/oauth-notes.md`。
