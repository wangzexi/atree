# Auth And File UI Design

This document records the simplified auth, config, and file UI model for `quark-s3-demo`.

## Core Idea

Keep the service small. It has only two API families:

```text
1. S3-style object routes
2. Whole-config read/write routes
```

The S3 URL space is also the file browser URL space.

There should not be separate browser-only download/list endpoints such as `/api/files` or `/api/download`. A browser visiting an S3 path gets a file-browser HTML shell when appropriate. S3 clients and curl still get normal S3 XML/object responses.

## Route Model

S3/object routes:

```text
GET    /
GET    /{bucket}
HEAD   /{bucket}
PUT    /{bucket}
GET    /{bucket}/{key}
HEAD   /{bucket}/{key}
PUT    /{bucket}/{key}
DELETE /{bucket}/{key}
POST   /{bucket}/{key}?uploads
PUT    /{bucket}/{key}?partNumber=<n>&uploadId=<id>
POST   /{bucket}/{key}?uploadId=<id>
DELETE /{bucket}/{key}?uploadId=<id>
```

Config routes:

```text
GET  /api/config
PUT  /api/config
GET  /api/help
```

No separate key CRUD routes are needed. Keys, auth rules, and cache settings are all just fields in the config document.

`GET /api/help` is the small AI-facing help endpoint. It replaces a separate settings page or large API index.

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
curl -H 'Accept: application/xml' 'http://127.0.0.1:9000/quark/public/'
curl -H 'Accept: text/html' 'http://127.0.0.1:9000/quark/public/'
```

This keeps one URL space while making both humans and curl-using AI agents comfortable.

### Directory Path

Browser request:

```http
GET /quark/public/
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
/quark/public/site/
```

can serve:

```text
/quark/public/site/index.html
```

The HTML file browser shell is only the fallback when there is no index file.

If the fallback file browser shell is returned, it reads the key from `localStorage`, then requests the same S3 path with an API/S3-oriented accept header and auth header to render the listing.

The file browser should not need a separate list API. It should call the same S3 listing URL:

```text
GET /quark/public/?list-type=2&delimiter=/
Authorization: Bearer <key>
Accept: application/xml
```

If no key is stored, it tries anonymously. If the listing returns `AccessDenied`, the UI asks for a key, stores it in `localStorage`, then retries the same request with `Authorization: Bearer <key>`.

Programmatic request:

```http
GET /quark/public/?list-type=2&delimiter=/
Accept: application/xml
```

Response:

```text
S3 ListBucket XML
```

Plain `curl /quark/public/` without browser headers can keep returning the S3-compatible response, even if that response is empty or XML-ish. The browser UI is mainly selected for real browser navigation.

### Directory Index File Lookup

Directory paths should support automatic index lookup, modeled after `example-file-service`.

Reference behavior:

- normalize the requested directory to a prefix ending with `/`
- list direct children under that prefix
- find direct children whose basename starts with `index`
- ignore nested matches
- sort candidates
- prefer exact `index`
- otherwise use lexical order

Reference source:

- `example-file-service/server/src/fileServing.ts`

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
GET /quark/public/photo.jpg
```

Response:

```text
file bytes
```

If the file is previewable, the response can be inline. If not, it can use `Content-Disposition: attachment`.

If a browser requests a file without permission, return a small HTML login/permission page. If a programmatic client requests the same file without permission, return an S3-style `AccessDenied` XML error.

### Root Path

Browser request to `/` can show:

- file browser entry
- login/key input
- concise API documentation
- a top-right copy button for the current domain's AI help curl command

S3 request to `/` can still return ListBuckets XML.

The browser homepage is the main HTML shell. It should be enough for normal human use:

- browse files
- enter/save an access key
- see current auth state
- copy an AI-help command

The top-right copy action should generate a command using the current origin:

```bash
curl -H 'Authorization: Bearer <super-admin-key>' 'https://current.example.com/api/help'
```

For local development:

```bash
curl -H 'Authorization: Bearer <super-admin-key>' 'http://127.0.0.1:9000/api/help'
```

The copied command is for AI/Codex or shell use. The help endpoint should explain how to read and write config, list objects, fetch files, and update auth rules.

## Browser Login Model

The browser UI uses a simple key as a lightweight login.

1. User opens `/` or a bucket/path URL.
2. UI tries to list the current path anonymously.
3. If anonymous listing is denied, UI asks for an access key.
4. UI stores the key in `localStorage`.
5. UI retries the same S3 listing request with:

```http
Authorization: Bearer <key>
```

The key is not the Quark cookie. It is only a local service credential mapped to allowed actions and prefixes.

`localStorage` is acceptable for a personal lightweight file browser, but admin keys should not be used casually in the browser.

This means public UI is not a separate switch. If `anonymous` has `ListBucket` on a path, the browser can render that path without a key. If not, the same UI shell becomes a login prompt.

## Config As One Document

Config should be managed as one document.

The API should not expose separate endpoints for keys, public rules, cache settings, or UI settings.

Use:

```text
GET /api/config
PUT /api/config
```

To add a key, remove a key, or change permissions:

1. `GET /api/config`
2. edit the config JSON
3. `PUT /api/config`

This is simple for humans, scripts, and AI agents.

## Mount Model

Use one user-facing concept: `mount`.

A mount maps a path in this service to a path in some remote system.

Fields:

- `mount_path`: where the mount appears in this service
- `type`: how to access the remote system, such as `quark_cookie`, `quark_open`, `s3`, or `local`
- `root_path`: where this mount starts in the remote system
- `enabled`: whether the mount is active

`mount_path` is the mount's unique identifier. A separate `name` field is not needed in the first version.

`root_path` is a human-readable string. Do not require internal IDs such as Quark `fid` in config. Driver-specific internal IDs should be resolved at runtime and cached in SQLite.

Example:

```json
{
  "mount_path": "/quark/restic-repo",
  "type": "quark_cookie",
  "root_path": "/我的备份/restic-repo",
  "enabled": true
}
```

The routing rule should be:

```text
request path
  -> find enabled mount by scanning mounts from back to front
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
      "type": "quark_cookie",
      "root_path": "/",
      "enabled": true
    },
    {
      "mount_path": "/public",
      "type": "quark_cookie",
      "root_path": "/公开",
      "enabled": true
    },
    {
      "mount_path": "/public/site",
      "type": "quark_cookie",
      "root_path": "/网站首页",
      "enabled": true
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
  "max_upload_bytes": 134217728
}
```

Reasons:

- OpenList's JSON fields use names like `mount_path`, `root_path`, and `access_token`.
- Rust `serde` can handle this cleanly with `rename_all = "snake_case"`.
- Environment variables naturally use upper snake case, such as `QUARK_S3_SUPER_ADMIN_KEY`.
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
  bootstrap super-admin key
  Quark cookie or Quark OAuth tokens

Docs:
  design notes
  API explanation
```

Even if SQLite is the source of truth, `GET /api/config` should return a readable JSON document, and later it can support export/import as TOML or JSON.

## Super Admin

Only a super-admin key can read or write config.

The super-admin key is a bootstrap secret loaded from environment:

```text
QUARK_S3_SUPER_ADMIN_KEY
```

Every config request must include:

```http
Authorization: Bearer <super-admin-key>
```

The super-admin key should not be stored in the normal config.

## Example Config

The effective config returned by `GET /api/config` can look like:

```json
{
  "mounts": [
    {
      "mount_path": "/",
      "type": "quark_cookie",
      "root_path": "/",
      "enabled": true,
      "options": {
        "order_by": "none",
        "order_direction": "asc"
      }
    }
  ],
  "auth": {
    "keys": [
      {
        "name": "admin",
        "key_hash": "sha256:...",
        "key_hint": "adm_...abcd",
        "enabled": true
      },
      {
        "name": "reader",
        "key_hash": "sha256:...",
        "key_hint": "rdr_...wxyz",
        "enabled": true
      }
    ],
    "rules": [
      {
        "principal": "anonymous",
        "actions": ["HeadObject", "GetObject"],
        "resources": ["/public/*"]
      },
      {
        "principal": "key:reader",
        "actions": ["ListBucket", "HeadObject", "GetObject"],
        "resources": ["/public/*", "/share/*"]
      }
    ]
  },
  "cache": {
    "enabled": true,
    "max_bytes": 53687091200
  }
}
```

Keys should not be stored in plaintext. Store hashes and hints. If the service later generates a key, show the plaintext key only once.

For manual config updates, `PUT /api/config` can accept a temporary `plain_key` field on a key. The service hashes it, stores only `key_hash` and `key_hint`, and never returns `plain_key`.

## Policy Model

Each request resolves to a principal:

- `anonymous`: no key
- `key:<name>`: matched configured key
- `super-admin`: bootstrap admin key, only for config routes unless explicitly allowed elsewhere

Actions:

- `ListBucket`
- `HeadObject`
- `GetObject`
- `PutObject`
- `DeleteObject`

`PutObject` also covers S3 multipart upload initiation, part upload, complete, and abort for the first version.

Policy check:

```text
principal + action + request path -> allow or deny
```

Anonymous access is not a separate config field. Public access is just a rule for the `anonymous` principal.

Example public rule:

```json
{
  "principal": "anonymous",
  "actions": ["HeadObject", "GetObject"],
  "resources": ["/public/*"]
}
```

Suggested anonymous behavior:

- allow `HeadObject` / `GetObject` for `public/*`
- optionally allow `ListBucket` for `share/*`
- deny all writes
- deny private paths

## AI-Friendly API Index

Use `GET /api/help` as the AI-friendly interface description.

It should be plain JSON or Markdown-like JSON that is easy for curl and AI agents to consume. It replaces a separate settings page and avoids many small management endpoints.

Suggested response content:

```json
{
  "service": "quark-s3-demo",
  "auth": {
    "user_header": "Authorization: Bearer <key>",
    "admin_header": "Authorization: Bearer <super-admin-key>"
  },
  "config": {
    "get": "GET /api/config",
    "put": "PUT /api/config",
    "note": "Config is one document. Edit mounts, keys, rules, and cache together."
  },
  "s3": {
    "list": "GET /{bucket}?list-type=2&delimiter=/&prefix=<path>",
    "get": "GET /{bucket}/{key}",
    "put": "PUT /{bucket}/{key}",
    "delete": "DELETE /{bucket}/{key}"
  },
  "examples": {
    "get_config": "curl -H 'Authorization: Bearer <super-admin-key>' '<origin>/api/config'",
    "put_config": "curl -X PUT -H 'Authorization: Bearer <super-admin-key>' -H 'Content-Type: application/json' --data @config.json '<origin>/api/config'",
    "list": "curl -H 'Authorization: Bearer <key>' '<origin>/quark?list-type=2&delimiter=/&prefix=public/'",
    "upload": "curl -X PUT -H 'Authorization: Bearer <key>' -H 'Content-Type: text/plain' --data-binary @./example.txt '<origin>/quark/public/example.txt'",
    "upload_with_curl_T": "curl -H 'Authorization: Bearer <key>' -T ./example.txt '<origin>/quark/public/example.txt'",
    "read": "curl -H 'Authorization: Bearer <key>' '<origin>/quark/public/example.txt'",
    "delete": "curl -X DELETE -H 'Authorization: Bearer <key>' '<origin>/quark/public/example.txt'"
  }
}
```

## File Browser Behavior

The UI can be modeled after `example-file-service`:

- breadcrumb navigation
- folder-first table
- file size
- modified time
- direct file links
- markdown preview if useful
- key login stored in `localStorage`

Reference implementation:

- `example-file-service/web/src/App/FileBrowser.tsx`
- `example-file-service/server/src/appRouter.ts`
- `example-file-service/server/src/fileServing.ts`

Differences here:

- server is Rust, not Koa/tRPC
- files come through mounts, initially backed by Quark
- S3 routes are also browser routes
- listing and file reads can use local SQLite/cache when available

## Security Notes

Storing a key in `localStorage` is simple, but weaker than a server-side session-cookie system.

Implications:

- JavaScript on the same origin can read the key.
- XSS would expose the key.
- Keys should be scoped narrowly.
- Browser keys should usually be read-only.
- The super-admin key should not be stored in browser `localStorage`.

Admin config writes can expose private data or lock the user out, so:

- validate every config before applying it
- reject invalid config without changing the saved config
- never return plaintext stored keys
- return clear change summaries

Config history is not required for the first version.

Auth rules should use a default-deny allow-list model:

```text
if at least one allow rule matches principal + action + path:
  allow
else:
  deny
```

## Suggested First Version

1. Add config model in SQLite.
2. Add `QUARK_S3_SUPER_ADMIN_KEY`.
3. Add `GET /api/config`, `PUT /api/config`, and `GET /api/help`.
4. Add policy checks to existing S3 routes.
5. Add browser detection for directory paths and return an HTML shell.
6. Add directory index file lookup for browser directory requests.
7. Build the homepage/file browser shell using the same S3 paths.
8. Add a top-right copy button for `curl <origin>/api/help`.
9. Store the browser access key in `localStorage`.

Later:

- AWS SigV4 validation for real S3 clients
- pre-signed URLs
- browser upload controls
- config export/import
- short-lived browser sessions instead of localStorage keys
- audit logs
