# atree

一个 AI 友好的文件树网关：把夸克网盘、配置文件、外部 HTTP 文件等资源挂到同一棵路径树上，通过 S3 path-style HTTP、普通 HTTP 和浏览器文件界面访问。当前优先保证 restic 备份可用，也覆盖 curl、AWS CLI 和 MinIO JS SDK 的基础上传下载语义。

它参考了 `refs/alist/drivers/quark_uc` 里的 AList 夸克驱动，目前实现：

- `GET /`：浏览器返回文件界面壳，S3/curl 返回 bucket XML
- `GET /quark?list-type=2&delimiter=/&prefix=...`：列对象和目录
- `GET /quark/<key>`：下载对象
- `HEAD /quark/<key>`：对象元信息
- `PUT /quark/<key>`：上传对象，必要时自动创建父目录
- `DELETE /quark/<key>`：删除对象
- `GET /quark/<key>` + `Range`：范围读取，供 restic 读取 pack 片段
- S3 multipart upload 的最小流程：`POST ?uploads`、`PUT ?partNumber=&uploadId=`、`POST ?uploadId=`、`DELETE ?uploadId=`
- `GET /api/config.yaml` / `PUT /api/config.yaml`：像修改一个系统文件一样管理 mount、key、权限和 cache，系统文件通过 `system_config` 直接挂载到某个文件路径。
- `GET` / `HEAD` 外部 HTTP 文件挂载：把 GitHub release/raw 等 URL 挂到服务文件树中，可按挂载单独配置代理

这不是完整 S3 实现，暂时没有校验 AWS Signature。服务自己的访问控制由 `Authorization: Bearer <key>`、或 AWS SigV4 `Credential` 里的 access key 映射到本地 key 后完成。

## 运行

```bash
cd atree
export ATREE_ROOT_KEY='换成你的 root key'
cargo run
```

夸克 Cookie、S3 bucket 名和 Quark root fid 都写在 `config.yaml` 里，不再需要单独的 `quark.env`。

首次启动会创建 SQLite 配置库，默认位置：

```text
~/.local/share/atree/atree.sqlite
```

默认配置有两个 mount：`/` 指向夸克根目录，`/api/config.yaml` 作为系统配置文件挂载点：

```bash
curl -H 'Authorization: Bearer <root-key>' \
  'http://127.0.0.1:9000/api/config.yaml' > config.yaml
```

编辑后直接 PUT 回去，YAML 注释会被忽略：

```bash
curl -X PUT \
  -H 'Authorization: Bearer <root-key>' \
  --data @config.yaml \
  'http://127.0.0.1:9000/api/config.yaml'
```

`auth.keys[]` 可以临时传 `plain_key`，服务会保存为 `key_hash` 和 `key_hint`，之后 `GET /api/config.yaml` 不会返回明文 key。

`/api/config.yaml` 也走同一套权限模型：读取需要 `GetObject`，修改需要 `PutObject`，资源路径就是 `/api/config.yaml`。未命中任何 `auth.rules` 的请求，只有 `ATREE_ROOT_KEY` 对应的 `root` 身份还能访问，用作第一次写入配置或救援。

夸克网页登录态放在对应 mount 的 `options.cookie` 里。`s3_bucket` 是 S3 path-style 客户端看到的 bucket 名：

```yaml
s3_bucket: atree
mounts:
  - mount_path: /quark
    type: quark_cookie
    root_path: /
    options:
      cookie: '<从 pan.quark.cn 抓到的 Cookie>'
      root_fid: '0'
```

如果要避免 Cookie 失效，可以用 QuarkOpen OAuth token。`oauth_file` 是本机私密文件，里面保存 access token、refresh token、refresh URL、app id 和 sign key；access token 过期时，atree 会用 refresh token 刷新，并把新 token 写回这个 YAML：

```yaml
mounts:
  - mount_path: /quark
    type: quark_open
    root_path: /
    options:
      oauth_file: quark-open-oauth.yaml
      root_fid: '0'
```

当前 `oauth.example.com/quarkyun/renewapi` 是 OpenList APIPages 的裁剪接口，只返回 access/refresh token，不返回 Quark Open 请求签名所需的 `sign_key`。atree 的私密 OAuth YAML 应该把 `source.refresh_url` 设为飞牛原始刷新接口，这样能同时刷新 token 并保存 `app_id/sign_key`：

```yaml
kind: quark_open_oauth
source:
  token_page: https://oauth.example.com/
  callback_url: https://oauth.example.com/quarkyun/callback
  refresh_url: https://oauth.fnnas.com/api/v1/oauth/refreshToken
  driver: quarkyun_fn
application:
  client_id: '<private app id>'
  sign_key: '<private sign key>'
tokens:
  access_token: '<private>'
  refresh_token: '<private>'
```

配置文件本身也是挂载树的一部分。`system_config` 直接挂到某个单文件路径上，默认是 `/api/config.yaml`，也可以改到其它路径。例如：

```yaml
mounts:
  - mount_path: /
    type: quark_cookie
    root_path: /
  - mount_path: /system/live.yaml
    type: system_config
```

外部只读文件可以用 `url_tree` 挂载。`root_path` 是上游 http(s) URL 前缀，`options.proxy` 只影响这个挂载，适合把 raw URL、固定版本下载地址等资源通过服务端和本机代理中转出来。这里的挂载类型叫 `url_tree`，代理只是访问选项：

```yaml
mounts:
  - mount_path: /github/sing-box
    type: url_tree
    root_path: https://github.com/SagerNet/sing-box/releases/download/v1.12.0
    options:
      proxy: http://127.0.0.1:1080
auth:
  rules:
    - principal: anonymous
      actions: [HeadObject, GetObject]
      resources: [/github/sing-box/*]
```

访问 `/github/sing-box/sing-box-1.12.0-darwin-amd64.tar.gz` 时，服务会转发到对应 GitHub URL。当前 `url_tree` 是只读的文件/前缀代理，不支持目录列举。

如果上游是 GitHub Release，优先用 `github_releases`。它会从 GitHub API 读取 latest release assets，并把 assets 暴露成可列举、可下载的文件；`options.proxy` 同样只是访问 GitHub API 和下载资源时的出站代理：

```yaml
mounts:
  - mount_path: /hiddify
    type: github_releases
    root_path: hiddify/hiddify-app
    options:
      proxy: http://127.0.0.1:1080
      token: <github token>
      show_source_code: true
      asset_allow:
        - Hiddify-Android-universal.apk
        - Hiddify-MacOS.dmg
        - Hiddify-Windows-Portable-x64.zip
auth:
  rules:
    - principal: anonymous
      actions: [ListBucket, HeadObject, GetObject]
      resources: [/hiddify, /hiddify/*]
```

`/hiddify/*` matches descendants at any depth, but not `/hiddify` itself. Listable directories should be granted explicitly.

## 简单测试

不做 AWS Signature 校验；服务自己的权限用 `Authorization: Bearer <key>` 控制。配置里允许匿名时可以用 AWS CLI 的匿名模式：

```bash
aws --endpoint-url http://127.0.0.1:9000 s3 ls s3://atree --no-sign-request
echo hello > /tmp/atree.txt
aws --endpoint-url http://127.0.0.1:9000 s3 cp /tmp/atree.txt s3://atree/examples/atree.txt --no-sign-request
aws --endpoint-url http://127.0.0.1:9000 s3 cp s3://atree/examples/atree.txt - --no-sign-request
aws --endpoint-url http://127.0.0.1:9000 s3 rm s3://atree/examples/atree.txt --no-sign-request
```

## restic 使用

```bash
cd atree
cargo run
```

另一个终端：

```bash
export RESTIC_PASSWORD='你的 restic 仓库密码'
export AWS_ACCESS_KEY_ID='你的 atree key'
export AWS_SECRET_ACCESS_KEY=dummy

restic -r 's3:http://127.0.0.1:9000/quark/restic-repo' \
  -o s3.bucket-lookup=path \
  init

restic -r 's3:http://127.0.0.1:9000/quark/restic-repo' \
  -o s3.bucket-lookup=path \
  backup ~/Documents
```

如果要放到夸克的某个目录里，可以直接把目录写进 repo path，例如：

```bash
restic -r 's3:http://127.0.0.1:9000/quark/我的备份/restic-repo' \
  -o s3.bucket-lookup=path \
  snapshots
```

当前网关不校验 AWS Signature，但会把 AWS access key 当作服务访问 key 的来源之一。也可以直接用 HTTP Bearer key 调 curl。

也可以用 `curl`：

```bash
curl -H 'Authorization: Bearer <key>' 'http://127.0.0.1:9000/quark?list-type=2&delimiter=/'
curl -H 'Authorization: Bearer <key>' -T /tmp/atree.txt 'http://127.0.0.1:9000/quark/examples/atree.txt'
curl -H 'Authorization: Bearer <key>' 'http://127.0.0.1:9000/quark/examples/atree.txt'
```

MinIO JS SDK 的 path-style 用法也应该可用：

```ts
import { Client } from "minio";

const client = new Client({
  endPoint: "127.0.0.1",
  port: 9000,
  useSSL: false,
  accessKey: "<key>",
  secretKey: "dummy",
  pathStyle: true,
});

await client.fPutObject("quark", "examples/file.txt", "/tmp/file.txt");
```

浏览器打开 `http://127.0.0.1:9000/` 会进入内置文件浏览器壳。目录访问会优先寻找 `index*` 文件；没有 index 时返回文件浏览器壳，再由前端读取本地保存的 key 并请求同路径的列表接口。程序访问同一路径时仍然返回 S3 XML。

浏览器目录页本身不绕过权限。即使是根路径 `/`，前端也会再请求同路径上的浏览器列表接口；如果当前 key 对该路径没有 `ListBucket` 权限，页面会显示“需要访问 key。”而不是偷偷列出内容。

## 配置项

- `ATREE_DB`：SQLite 配置库路径，默认 `~/.local/share/atree/atree.sqlite`。
- `ATREE_ROOT_KEY`：root 恢复 key。未命中任何授权规则时，只有它仍可访问。
- `ATREE_MULTIPART_DIR`：S3 multipart upload 的临时分片目录，默认系统临时目录下的 `atree/multipart`。
- `BIND`：监听地址，默认 `127.0.0.1:9000`。
## 已知限制

- 上传会把单个对象读进内存后再走夸克上传流程。restic 默认 pack 约 16 MiB，当前够用；如调大 `--pack-size`，主要留意服务内存占用。
- S3 XML 返回只覆盖常见字段，兼容性主要面向 restic、MinIO JS SDK、`aws s3`/`curl` 的基础操作。
- Multipart upload 会先把分片落到系统 tmp 里的 `atree/multipart/` 临时目录，Complete 时再合并上传到夸克。可以用 `ATREE_MULTIPART_DIR` 改位置。
- 下载会代理夸克下载链接，而不是返回 302。
- `url_tree` mount 只支持 `GET` 和 `HEAD`，支持透传 `Range`，暂不做目录列表和本地缓存。
- `github_releases` mount 当前支持 latest release assets 的只读列表和下载，暂不支持 all versions、多仓库合并和 README/source code 的完整 OpenList 行为。
- Cookie 自动刷新只保存在进程内，没有写回磁盘。
- 浏览器 UI 是内嵌单 HTML，不需要前后端分离；私有文件的直接地址访问仍需要请求里携带 key。

## 已验证

- `restic init` 成功。
- 备份 8 MiB 测试目录成功，`restic check` 无错误，`restore latest` 成功。
- 备份 16 MiB 随机文件成功，总耗时约 18.8 秒；恢复耗时约 5.8 秒。
- 当前版本新增验证：配置 API、默认拒绝、带 key 列目录、HTML/XML Accept 切换、真实夸克小文件 PUT/HEAD/GET/DELETE。

## 后续 OAuth/Open API 方向

当前服务同时支持网页登录 Cookie 和 `quark_open` OAuth。关于 OAuth/Open API 的历史记录和来源说明见 `docs/oauth-notes.md`。

## 本地缓存方向

关于 Rust vs Bun、SQLite、write-through 写入、read-through 读取缓存的设计决策见 `docs/cache-design.md`。当前已实现 Quark GET/HEAD 对象读缓存和 GitHub release 元数据缓存；普通 PUT/DELETE、multipart complete、配置 PUT 会清理相关缓存，避免读到旧数据。

## 鉴权和文件界面

关于 API key、公开路径、浏览器 `localStorage` 登录和 Quark-backed file browser 的设计见 `docs/auth-and-file-ui.md`。当前给 AI/脚本看的最小入口说明直接写在 `/api/config.yaml` 的头部注释里。
