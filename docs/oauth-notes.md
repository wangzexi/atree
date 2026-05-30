# QuarkOpen OAuth Notes

atree only supports the QuarkOpen OAuth driver for Quark mounts. The older web-cookie driver was removed so there is one Quark auth model to understand and operate.

## OpenList Findings

OpenList has a `quark_open` driver:

- reference path: `OpenList drivers/quark_open`
- API base: `https://open-api-drive.quark.cn`
- main APIs:
  - `/open/v1/user/info`
  - `/open/v1/file/list`
  - `/open/v1/file/get_download_url`
  - `/open/v1/file/upload_pre`
  - `/open/v1/file/get_upload_urls`
  - `/open/v1/file/upload_finish`

It uses:

- `access_token`
- `refresh_token`
- `app_id`
- `sign_key`
- `x-pan-tm`
- `x-pan-token`
- `x-pan-client-id`

`x-pan-token` is generated as:

```text
sha256(method + "&" + pathname + "&" + timestamp_ms + "&" + sign_key)
```

Upload also requires proof fields:

- `proof_version`
- `proof_seed1`
- `proof_seed2`
- `proof_code1`
- `proof_code2`

OpenList computes proof ranges from MD5-derived offsets and base64-encodes the selected bytes.

## Refresh Path

OpenList's default token refresh path calls:

```text
https://api.oplist.org/quarkyun/renewapi
```

For the self-hosted APIPages flow used by `oauth.example.com`, `/quarkyun/renewapi` returns only `access_token` and `refresh_token`. The underlying FnOS Quark OAuth refresh endpoint returns the app signing fields under `data.tokenInfo.appId` and `data.tokenInfo.signKey`, so atree uses that endpoint directly when the private OAuth YAML sets:

```yaml
source:
  refresh_url: https://oauth.fnnas.com/api/v1/oauth/refreshToken
```

The token page does not print `sign_key` because OpenList APIPages normally treats application keys as server-side credentials. atree stores the refreshed `access_token`, `refresh_token`, `app_id`, and `sign_key` in the corresponding `quark_open` mount's `options` inside `/api/config.yaml`.

This has been tested with real Quark OAuth credentials: atree can list the root directory and complete a small-object PUT, GET, byte-for-byte readback, and DELETE loop through the `quark_open` mount.

## Operating Model

1. Use `type: quark_open` for Quark mounts.
2. Store OAuth state in that mount's `options`: `refresh_token`, optional current `access_token`, `app_id`, `sign_key`, and `refresh_url`.
3. Refresh rotated tokens back into the same mount options in `/api/config.yaml`.
4. Keep `options.refresh_url` pointed at `https://oauth.fnnas.com/api/v1/oauth/refreshToken` for FnOS-backed Quark OAuth tokens; the OpenList APIPages renew endpoint is not enough for atree because it omits `sign_key`.

## Near-Term Improvements

- Move large uploads away from whole-object-in-memory buffering.
- Add a fully local `quark_open` refresh implementation if Quark/FnOS publishes a stable documented protocol.
