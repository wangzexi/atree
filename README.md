# atree

AI 友好的文件树网关。

atree 把不同后端挂成同一棵树：浏览器访问时是文件树界面，API 访问时是 S3 path-style 协议。配置本身也是树上的一个文件，适合 AI 直接读写 `/api/config.yaml` 来管理 mount、key 和权限。权限模型保持极简：本地 key、allow-list rule、默认拒绝。

## Docker

```bash
docker run --rm \
  -p 9000:9000 \
  -e ATREE_ROOT_KEY='replace-with-root-key' \
  -e ATREE_DB='/data/atree.sqlite' \
  -v atree-data:/data \
  ghcr.io/wangzexi/atree:latest
```

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

## 致谢

感谢 [OpenList](https://github.com/OpenListTeam/OpenList)，QuarkOpen 相关逻辑参考 `drivers/quark_open`。

## 协议

MIT
