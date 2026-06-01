# Auth And File UI Design

This document records the simplified auth, config, and file UI model for `atree`.

## Core Idea

Keep the service small. It has one public resource model:

```text
one mounted tree
  -> S3-style object operations
  -> optional browser shell for humans
```

The S3 URL space is also the file browser URL space.

There should not be separate browser-only path families such as `/api/files` or `/api/download`. A browser visiting an S3 path gets a file-browser HTML shell when appropriate. S3 clients and curl still get normal S3 XML/object responses.

The browser shell does not have its own listing API. It renders the same tree by making the same S3 ListObjectsV2 request a client would make:

```text
GET <same path>?list-type=2&delimiter=/&prefix=<current-prefix>
Accept: application/xml
Authorization: Bearer <key>
```

## Route Model

S3/object routes:

```text
GET    /?list-type=2&delimiter=/
GET    /{key}
HEAD   /{key}
PUT    /{key}
DELETE /{key}
POST   /{key}?uploads
PUT    /{key}?partNumber=<n>&uploadId=<id>
POST   /{key}?uploadId=<id>
DELETE /{key}?uploadId=<id>
```

For S3 path-style clients, the configured `s3_bucket` is just the bucket label for the same tree. A client request like `/atree/quark/file.txt` is normalized to the internal tree path `/quark/file.txt` when it is recognizably an S3 request. Human/browser paths can still use `/quark/file.txt` directly.

Config is not a separate API family. It is one mounted file in the same tree:

```text
GET  /api/config.yaml
PUT  /api/config.yaml
```

No separate key CRUD routes are needed. Keys, auth rules, and cache settings are all just fields in the config document.

`system_config` is a mounted config file path. You can move it by editing mounts, for example to `/system/live.yaml`.

## Browser Versus S3 Behavior

The same path can behave differently depending on the request.

This is a mixed interface:

```text
same resource URL
  -> human browser navigation gets HTML, index files, or file bytes
  -> curl/restic/S3 clients get S3 XML, S3 errors, or file bytes
```

Request mode should be decided primarily by the HTTP `Accept` header.

Browser navigation is likely when:

- method is `GET`
- `Accept` contains `text/html`
- `User-Agent` looks like a browser
- `User-Agent` is not an obvious tool such as `curl`, `wget`, `aws-cli`, `Boto3`, `restic`, `rclone`, `go-http-client`, or `python-requests`

Suggested behavior:

```text
GET directory + Accept: text/html        -> HTML/index/filebrowser
GET directory + Accept: application/xml  -> S3 listing XML
GET directory + Accept: */*              -> S3 listing XML
GET file                                 -> file bytes
```

This uses standard HTTP content negotiation, so no `?format=html` or `?format=s3` override is needed.

Examples:

```bash
curl -H 'Accept: application/xml' 'http://127.0.0.1:9000/public/'
curl -H 'Accept: text/html' 'http://127.0.0.1:9000/public/'
```

This keeps one URL space while making both humans and curl-using AI agents comfortable.

### Directory Path

Browser request:

```http
GET /public/
Accept: text/html
User-Agent: Mozilla/...
```

Response:

```text
directory handling:
  1. if an index file exists, return that file
  2. otherwise return the HTML file browser shell
```

This makes a directory usable as a small static website. For example, visiting:

```text
/public/site/
```

can serve:

```text
/public/site/index.html
```

The HTML file browser shell is only the fallback when there is no index file.

If the fallback file browser shell is returned, it reads the key from `localStorage`, then requests the same path with S3 ListObjectsV2 and auth header to render the listing:

```text
GET /public/?list-type=2&delimiter=/&prefix=public/
Authorization: Bearer <key>
Accept: application/xml
```

If no key is stored, it tries anonymously. If the listing returns `AccessDenied`, the UI asks for a key, stores it in `localStorage`, then retries the same request with `Authorization: Bearer <key>`.

Programmatic request:

```http
GET /public/?list-type=2&delimiter=/
Accept: application/xml
```

Response:

```text
S3 ListBucket XML
```

Plain `curl /public/` without browser headers can keep returning the S3-compatible response, even if that response is empty or XML-ish. The browser UI is mainly selected for real browser navigation.

### Directory Index File Lookup

Directory paths should support automatic index lookup, modeled after common static file servers.

Reference behavior:

- normalize the requested directory to a prefix ending with `/`
- list direct children under that prefix
- find direct children whose basename starts with `index`
- ignore nested matches
- sort candidates
- prefer exact `index`
- otherwise use lexical order

Candidate examples:

```text
index
index.html
index.htm
index.md
index.txt
```

This means browser access to a directory should be resolved in this order:

```text
GET /quark/path/
  -> /quark/path/index
  -> /quark/path/index.html
  -> /quark/path/index.htm
  -> /quark/path/index.md
  -> fallback file browser shell
```

For non-browser clients, keep S3 listing behavior instead of serving index files unless the path explicitly names the index object.

### File Path

Browser or programmatic request:

```http
GET /public/photo.jpg
```

Response:

```text
file bytes
```

If the file is previewable, the response can be inline. If not, it can use `Content-Disposition: attachment`.

If a browser requests a file without permission, return a small HTML login/permission page. If a programmatic client requests the same file without permission, return an S3-style `AccessDenied` XML error.

### Root Path

Browser request to `/` returns the main HTML shell.

The shell is enough for normal human use:

- browse files when the current key is allowed to list `/`
- enter/save an access key
- see the config entry command

The config entry command should render inline using the current origin:

```bash
curl -H 'Authorization: Bearer <root-key>' 'https://current.example.com/api/config.yaml'
```

For local development:

```bash
curl -H 'Authorization: Bearer <root-key>' 'http://127.0.0.1:9000/api/config.yaml'
```

The copied command is for AI/Codex or shell use. The `config.yaml` header comments should explain how to read and write config, list objects, fetch files, and update auth rules.

The root shell should not bypass auth. It follows the same rule as any other directory shell:

```text
GET /                                      -> HTML shell for browsers
GET /?list-type=2&delimiter=/             -> requires ListBucket on /
```

If the current caller is not allowed to list `/`, the shell stays visible but the file list should not render.

## Browser Login Model

The browser UI uses a simple key as a lightweight login.

1. User opens `/` or a tree path URL.
2. UI tries to list the current path anonymously.
3. If anonymous listing is denied, UI asks for an access key.
4. UI stores the key in `localStorage`.
5. UI retries the same S3 listing request with:

```http
Authorization: Bearer <key>
```

The key is not the Quark OAuth token. It is only a local service credential mapped to allowed actions and prefixes.

`localStorage` is acceptable for a personal lightweight file browser, but admin keys should not be used casually in the browser.

This means public UI is not a separate switch. If `anonymous` has `ListBucket` on a path, the browser can render that path without a key. If not, the same UI shell becomes a login prompt.

## Config As One Document

Config should be managed as one document.

The API should not expose separate endpoints for keys, public rules, cache settings, or UI settings.

Use:

```text
GET /api/config.yaml
PUT /api/config.yaml
```

The config API is YAML-only at the HTTP boundary. `GET /api/config.yaml` returns explanatory comments for humans and AI agents, and `PUT /api/config.yaml` ignores those comments naturally. This path behaves like a mounted system file: reading it requires `GetObject` on the current config path, and updating it requires `PutObject` on that same path. Requests that do not match any allow rule still remain accessible to the environment root key for bootstrap and recovery.

The config endpoint is not special outside the mount model. It is a `system_config` mount. A user can move it by editing `mounts`, but validation must require at least one enabled `system_config` mount so the service cannot easily lose its editable config file.

To add a key, remove a key, or change permissions:

1. `GET /api/config.yaml`
2. edit the config YAML
3. `PUT /api/config.yaml`

This is simple for humans, scripts, and AI agents.

## Mount Model

Use one user-facing concept: `mount`.

A mount maps a path in this service to a path in some remote system.

Fields:

- `mount_path`: where the mount appears in this service
- `type`: how to access the remote system, such as `quark_open`, `system_config`, `url_tree`, `github_releases`, or future `s3`
- `root_path`: where this mount starts in the remote system. It is only present for mount types backed by a remote tree, not for `system_config`.
- To disable a mount, comment it out of the YAML.
- `options`: mount-specific settings, such as an outbound proxy for `url_tree` or `github_releases`

`mount_path` is usually unique. Multiple `github_releases` mounts may share one `mount_path`; their latest release assets are merged into a single flat directory. A separate `name` field is not needed in the first version.

`root_path` is a human-readable string. Normal configs should not need internal IDs such as Quark `fid`. Driver-specific internal IDs should usually be resolved at runtime and cached in SQLite.

Example:

```json
{
  "mount_path": "/quark/restic-repo",
  "type": "quark_open",
  "root_path": "/我的备份/restic-repo"
}
```

Current mount types:

- `quark_open`: read/write Quark Drive through QuarkOpen OAuth credentials.
- `system_config`: exposes the service config as one mounted file path. The default mount is `/api/config.yaml`, but the file name does not need to stay `config.yaml`.
- `url_tree`: read-only `GET`/`HEAD` access to URL-backed files. This is useful for raw URLs or fixed download prefixes that need a server-side proxy in mainland China.
- `github_releases`: read-only latest GitHub Release asset tree. This is better than `url_tree` for release assets because it supports listing the files through S3/ListBucket.

Example URL tree mount:

```yaml
mounts:
  - mount_path: /github/sing-box
    type: url_tree
    root_path: https://github.com/SagerNet/sing-box/releases/download/v1.12.0
    options:
      proxy: http://127.0.0.1:1080
auth:
  rules:
    - user: anonymous
      actions: [HeadObject, GetObject]
      paths: [/github/sing-box/*]
```

Example GitHub releases mount:

```yaml
mounts:
  - mount_path: /client
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
  - mount_path: /client
    type: github_releases
    root_path: SagerNet/sing-box
    options:
      proxy: http://127.0.0.1:1080
      asset_allow:
        - sing-box-*-linux-amd64.tar.gz
        - sing-box-*-darwin-arm64.tar.gz
auth:
  rules:
    - user: anonymous
      actions: [ListBucket, HeadObject, GetObject]
      paths: [/client, /client/*]
```

`/github/sing-box/file.tar.gz` maps to `https://github.com/SagerNet/sing-box/releases/download/v1.12.0/file.tar.gz`. The proxy option belongs to this mount only; other mounts can stay direct.

For `github_releases`, sharing `mount_path` creates one flat release asset directory, so `/client/` can contain both Hiddify and sing-box assets. `/client/*` matches descendants at any depth, but not `/client` itself. Listable directories should be granted explicitly.

The routing rule should be:

```text
request path
  -> find mount by scanning mounts from back to front
  -> the first path-segment match wins
  -> strip mount_path from request path
  -> join the remaining path with root_path
  -> call the mount implementation
```

Later mounts have higher priority. This supports simple overriding and subpath mounts.

Example:

```json
{
  "mounts": [
    {
      "mount_path": "/",
      "type": "quark_open",
      "root_path": "/"
    },
    {
      "mount_path": "/public",
      "type": "quark_open",
      "root_path": "/公开"
    },
    {
      "mount_path": "/public/site",
      "type": "quark_open",
      "root_path": "/网站首页"
    }
  ]
}
```

Matches:

```text
/public/site/index.html -> /网站首页/index.html
/public/a.jpg           -> /公开/a.jpg
/anything               -> /anything
```

Path matching must be segment-aware:

```text
/public matches /public and /public/a.jpg
/public does not match /publication/a.jpg
/ matches everything
```

The mounted namespace is independent from S3 bucket naming. The first version can keep one bucket, but the path routing should be based on `mount_path`.

## Field Naming

Use `snake_case` for config and HTTP API JSON fields.

Examples:

```json
{
  "mount_path": "/public",
  "root_path": "/公开",
  "key_hash": "sha256:...",
}
```

Reasons:

- OpenList's JSON fields use names like `mount_path`, `root_path`, and `access_token`.
- Rust `serde` can handle this cleanly with `rename_all = "snake_case"`.
- Environment variables naturally use upper snake case, such as `ATREE_ROOT_KEY`.
- Frontend code can still use camelCase internally, but API/config boundaries should stay snake_case.

## Config Storage

The config can live in SQLite if the service is mainly configured through HTTP.

Recommended split:

```text
SQLite:
  runtime config
  key hashes
  auth rules
  cache settings
  object/cache metadata

Environment:
  bootstrap root key

Docs:
  design notes
  API explanation
```

Even if SQLite stores the normalized runtime state internally, `GET /api/config.yaml` should expose the user-facing config as readable YAML with comments.

## Root And Config Access

The config file uses the same policy model as other mounted files:

- `GET /api/config.yaml` requires `GetObject` on `/api/config.yaml`.
- `PUT /api/config.yaml` requires `PutObject` on `/api/config.yaml`.
- The environment root key bypasses policy checks and is meant for bootstrap and recovery.

This means config can be delegated to a normal configured key by adding explicit rules. The default generated config has no allow rules, so the root key is the only practical way to read or write config at first startup.

The root key is a bootstrap secret loaded from environment:

```text
ATREE_ROOT_KEY
```

Bootstrap config requests can include:

```http
Authorization: Bearer <root-key>
```

The root key should not be stored in the normal config or browser `localStorage`.

## Example Config

The effective config returned by `GET /api/config.yaml` can look like:

```yaml
s3_bucket: atree
mounts:
  - mount_path: /quark
    type: quark_open
    root_path: /
    options:
      refresh_token: '<private refresh token>'
      refresh_url: https://oauth.fnnas.com/api/v1/oauth/refreshToken
  - mount_path: /api/config.yaml
    type: system_config
  - mount_path: /github/sing-box
    type: url_tree
    root_path: https://github.com/SagerNet/sing-box/releases/download/v1.12.0
    options:
      proxy: http://127.0.0.1:1080
auth:
  users:
    - name: admin
      key_hash: sha256:...
      key_hint: adm_...abcd
    - name: reader
      key_hash: sha256:...
      key_hint: rdr_...wxyz
  rules:
    - user: anonymous
      actions: [HeadObject, GetObject]
      paths: [/public/*]
    - user: anonymous
      actions: [HeadObject, GetObject]
      paths: [/github/sing-box/*]
    - user: reader
      actions: [ListBucket, HeadObject, GetObject]
      paths: [/public, /public/*, /share, /share/*]
cache:
  max_bytes: 53687091200
```

User keys should not be stored in plaintext. Store hashes and hints. If the service later generates a key, show the plaintext key only once.

For manual config updates, `PUT /api/config.yaml` can accept a temporary `key` field on a user. The service hashes it, stores only `key_hash` and `key_hint`, and never returns `key`.

## Policy Model

Each request resolves to a user:

- `anonymous`: no key
- `<name>`: matched configured key
- `root`: bootstrap/recovery key that bypasses policy checks

Actions:

- `ListBucket`
- `HeadObject`
- `GetObject`
- `PutObject`
- `DeleteObject`

`PutObject` also covers S3 multipart upload initiation, part upload, complete, and abort for the first version.

Policy check:

```text
user + action + request path -> allow or deny
```

Anonymous access is not a separate config field. Public access is just a rule for the `anonymous` user.

Example public rule:

```json
{
  "user": "anonymous",
  "actions": ["HeadObject", "GetObject"],
  "paths": ["/public/*"]
}
```

Suggested anonymous behavior:

- allow `HeadObject` / `GetObject` for `public/*`
- optionally allow `ListBucket` for `share/*`
- deny all writes
- deny private paths

## AI-Friendly API Index

Use `GET /api/config.yaml` as the AI-friendly entry point. The YAML header comments can carry the minimal examples for curl and AI agents, so there is no second help file to keep in sync.

## File Browser Behavior

The UI can follow a compact file-browser model:

- breadcrumb navigation
- folder-first table
- file size
- modified time
- direct file links
- markdown preview if useful
- key login stored in `localStorage`

Differences here:

- server is Rust, not Koa/tRPC
- files come through mounts, initially backed by Quark
- S3 routes are also browser routes
- ListBucket responses use the local tree cache; Quark file reads and GitHub release metadata use the same TTL window. Browser listing still follows the same S3 auth rules.

## Security Notes

Storing a key in `localStorage` is simple, but weaker than a server-side session-cookie system.

Implications:

- JavaScript on the same origin can read the key.
- XSS would expose the key.
- Keys should be scoped narrowly.
- Browser keys should usually be read-only.
- The root key should not be stored in browser `localStorage`.

Admin config writes can expose private data or lock the user out, so:

- validate every config before applying it
- reject invalid config without changing the saved config
- never return plaintext stored keys
- return clear change summaries

Config history is not required for the first version.

Auth rules should use a default-deny allow-list model:

```text
if at least one allow rule matches user + action + path:
  allow
else:
  deny
```

## Suggested First Version

Completed in the current implementation:

- Config model stored in SQLite.
- `ATREE_ROOT_KEY` bootstrap/recovery access.
- `GET /api/config.yaml` and `PUT /api/config.yaml`.
- Default-deny policy checks on S3/object routes.
- Browser detection for directory paths and an HTML file browser shell.
- Directory index file lookup for browser directory requests.
- `GET /api/config.yaml` returns the entry comments directly in the YAML header.
- Browser access key storage in `localStorage`.

Later:

- AWS SigV4 validation for real S3 clients
- pre-signed URLs
- browser upload controls
- config export/import
- short-lived browser sessions instead of localStorage keys
- audit logs
