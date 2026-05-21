# quark-s3-demo

一个 Rust 网关：把夸克网盘目录包装成 S3 path-style HTTP 服务，当前主要目标是给 restic 备份使用。

它参考了 `refs/alist/drivers/quark_uc` 里的 AList 夸克驱动，目前实现：

- `GET /`：浏览器返回文件界面，S3/curl 返回 bucket XML
- `GET /quark?list-type=2&delimiter=/&prefix=...`：列对象和目录
- `GET /quark/<key>`：下载对象
- `HEAD /quark/<key>`：对象元信息
- `PUT /quark/<key>`：上传对象，必要时自动创建父目录
- `DELETE /quark/<key>`：删除对象
- `GET /quark/<key>` + `Range`：范围读取，供 restic 读取 pack 片段
- S3 multipart upload 的最小流程：`POST ?uploads`、`PUT ?partNumber=&uploadId=`、`POST ?uploadId=`、`DELETE ?uploadId=`
- `GET /api/help`：返回面向 curl/AI 的接口说明
- `GET /api/config.yaml` / `PUT /api/config.yaml`：像修改一个系统文件一样管理 mount、key、权限和 cache

这不是完整 S3 实现，暂时没有校验 AWS Signature。它优先覆盖 restic、curl、MinIO JS SDK 基础上传下载会用到的 S3 语义。

## 运行

```bash
cargo run
source ./quark.env
export QUARK_S3_SUPER_ADMIN_KEY='换成你的管理 key'
cargo run
```

`quark.env` 放在项目根目录，包含 `QUARK_COOKIE` 等本地敏感配置，已被 `.gitignore` 忽略。

首次启动会创建 SQLite 配置库，默认位置：

```text
~/.local/share/quark-s3-demo/quark-s3-demo.sqlite
```

默认配置只有一个 `/` mount，指向夸克根目录，但没有匿名权限。配置就是 `/api/config.yaml` 这份系统文件：

```bash
curl -H 'Authorization: Bearer <super-admin-key>' \
  'http://127.0.0.1:9000/api/config.yaml' > config.yaml
```

编辑后直接 PUT 回去，YAML 注释会被忽略：

```bash
curl -X PUT \
  -H 'Authorization: Bearer <super-admin-key>' \
  --data @config.yaml \
  'http://127.0.0.1:9000/api/config.yaml'
```

`auth.keys[]` 可以临时传 `plain_key`，服务会保存为 `key_hash` 和 `key_hint`，之后 `GET /api/config.yaml` 不会返回明文 key。

`/api/config.yaml` 也走同一套权限模型：读取需要 `GetObject`，修改需要 `PutObject`，资源路径就是 `/api/config.yaml`。`QUARK_S3_SUPER_ADMIN_KEY` 只是 bootstrap key，用来第一次写入配置或救援。

## 简单测试

不做 AWS Signature 校验；服务自己的权限用 `Authorization: Bearer <key>` 控制。配置里允许匿名时可以用 AWS CLI 的匿名模式：

```bash
aws --endpoint-url http://127.0.0.1:9000 s3 ls s3://quark --no-sign-request
echo hello > /tmp/quark-s3-demo.txt
aws --endpoint-url http://127.0.0.1:9000 s3 cp /tmp/quark-s3-demo.txt s3://quark/demo/quark-s3-demo.txt --no-sign-request
aws --endpoint-url http://127.0.0.1:9000 s3 cp s3://quark/demo/quark-s3-demo.txt - --no-sign-request
aws --endpoint-url http://127.0.0.1:9000 s3 rm s3://quark/demo/quark-s3-demo.txt --no-sign-request
```

## restic 使用

```bash
cargo run
source ./quark.env
cargo run
```

另一个终端：

```bash
export RESTIC_PASSWORD='你的 restic 仓库密码'
export AWS_ACCESS_KEY_ID='你的 quark-s3-demo key'
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
curl -H 'Authorization: Bearer <key>' -T /tmp/quark-s3-demo.txt 'http://127.0.0.1:9000/quark/demo/quark-s3-demo.txt'
curl -H 'Authorization: Bearer <key>' 'http://127.0.0.1:9000/quark/demo/quark-s3-demo.txt'
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

await client.fPutObject("quark", "demo/file.txt", "/tmp/file.txt");
```

浏览器打开 `http://127.0.0.1:9000/` 会进入单文件 HTML 界面。目录访问会优先寻找 `index*` 文件；没有 index 时返回文件列表界面。程序访问同一路径时仍然返回 S3 XML。

## 配置项

- `QUARK_COOKIE`：夸克网页登录态 Cookie。
- `QUARK_ROOT_FID`：对外暴露的夸克目录 fid，默认 `0`。
- `S3_BUCKET`：本地 S3 bucket 名，默认 `quark`。
- `QUARK_S3_DB`：SQLite 配置库路径，默认 `~/.local/share/quark-s3-demo/quark-s3-demo.sqlite`。
- `QUARK_S3_SUPER_ADMIN_KEY`：配置接口的 bootstrap 管理 key。
- `BIND`：监听地址，默认 `127.0.0.1:9000`。
- `MAX_UPLOAD_BYTES`：单个 PUT 最大请求体，默认 `134217728`，也就是 128 MiB。

## 已知限制

- 上传会把单个对象读进内存后再走夸克上传流程。restic 默认 pack 约 16 MiB，当前够用；如调大 `--pack-size`，注意 `MAX_UPLOAD_BYTES` 和内存。
- S3 XML 返回只覆盖常见字段，兼容性主要面向 restic、MinIO JS SDK、`aws s3`/`curl` 的基础操作。
- Multipart upload 会先把分片落到本机 SQLite 旁边的 `multipart/` 临时目录，Complete 时再合并上传到夸克。
- 下载会代理夸克下载链接，而不是返回 302。
- Cookie 自动刷新只保存在进程内，没有写回磁盘。
- 浏览器 UI 是内嵌单 HTML，不需要前后端分离；私有文件的直接地址访问仍需要请求里携带 key。

## 已验证

- `restic init` 成功。
- 备份 8 MiB 测试目录成功，`restic check` 无错误，`restore latest` 成功。
- 备份 16 MiB 随机文件成功，总耗时约 18.8 秒；恢复耗时约 5.8 秒。
- 当前版本新增验证：配置 API、默认拒绝、带 key 列目录、HTML/XML Accept 切换、真实夸克小文件 PUT/HEAD/GET/DELETE。

## 后续 OAuth/Open API 方向

当前 demo 走网页登录 Cookie。关于后续迁移到 OpenList `quark_open` / OAuth-style token 的记录见 `docs/oauth-notes.md`。

## 本地缓存方向

关于 Rust vs Bun、SQLite、write-through 写入、read-through 读取缓存的设计决策见 `docs/cache-design.md`。

## 鉴权和文件界面

关于 API key、公开路径、浏览器 `localStorage` 登录和 Quark-backed file browser 的设计见 `docs/auth-and-file-ui.md`。
