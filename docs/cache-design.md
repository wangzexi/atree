# Cache Design Notes

This document records the design direction for adding a local fast cache in front of Quark Drive for `atree`.

## Goal

Expose Quark Drive through a local S3-ish service, while making frequently accessed files fast to read.

The important simplifying assumption is:

> Quark Drive data managed by this service is only modified through this service.

The current implementation already stores runtime config in SQLite and uses a tmp-backed `multipart/` directory for S3 multipart upload assembly. The read-through/write-through object cache described below is not implemented yet.

Because of that, the local metadata database can be treated as a trusted index for objects this service has seen or written.

## Runtime Choice

Keep the core service in Rust.

Rust is a good fit for the long-running storage gateway parts:

- S3-compatible HTTP service
- large-file streaming
- local filesystem cache
- SQLite metadata
- background maintenance workers
- stable single-binary deployment

TypeScript/Bun is still useful for:

- quick API experiments
- one-off Quark/OpenList probes
- a future web file UI frontend

But the daemon itself should stay Rust because this is closer to a small storage service than a short-lived script.

## Consistency Model

Use write-through for writes and read-through for reads.

### Writes

Writes must wait until Quark confirms success before returning success to the S3 client.

```text
PUT object
  -> write request body to a local temporary file
  -> upload the object to Quark
  -> persist/update SQLite metadata
  -> keep the local file as cache
  -> return success
```

This means a successful `PUT` implies the remote Quark backend has the object.

This is slower than async write-back, but much safer for the first real version.

### Reads

Reads should prefer local cache.

```text
GET object
  -> if local cached file exists, return it directly
  -> otherwise download from Quark
     -> stream response to the client
     -> write the same bytes into the local cache
     -> update SQLite metadata
```

Frequently accessed files become fast after the first read.

### Deletes

Deletes should remove the remote object first, then remove local state.

```text
DELETE object
  -> delete from Quark
  -> delete local cached file if present
  -> delete/update SQLite metadata
  -> return success
```

## Why Not Async Write-Back First

Async write-back would be:

```text
PUT object
  -> write local cache
  -> mark upload pending
  -> return success immediately
  -> background worker uploads to Quark later
```

This is attractive, but it adds more failure modes:

- process crash while upload is pending
- upload fails after client already saw success
- retry/backoff state
- local disk pressure while unsynced data exists
- shutdown and recovery semantics
- harder S3 compatibility expectations

It can be added later with a durable job queue, but should not be the first version.

## SQLite

Rust + SQLite is fast enough for this workload. The bottleneck will be Quark API/network I/O, not SQLite.

Use `rusqlite` first:

- simple synchronous API
- mature and fast
- good fit for a local daemon
- less machinery than `sqlx` or an ORM

Recommended pragmas:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```

Possible object table:

```sql
CREATE TABLE objects (
  key TEXT PRIMARY KEY,
  remote_fid TEXT,
  size INTEGER NOT NULL,
  etag TEXT,
  content_sha256 TEXT,
  local_path TEXT,
  cache_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_access_at INTEGER
);

CREATE INDEX objects_cache_status_idx ON objects(cache_status);
CREATE INDEX objects_last_access_at_idx ON objects(last_access_at);
```

Possible cache statuses:

- `cached`: local file exists and remote object exists
- `remote_only`: metadata exists, local cached file does not
- `uploading`: local temp file exists, upload in progress
- `deleted`: tombstone, if needed later

## Local Cache Layout

Use content-addressed or key-derived local paths.

Recommended layout:

```text
~/.local/share/atree/
  atree.sqlite
  cache/
    objects/
      ab/
        cd/
          <sha256>
    tmp/
      <uuid>.part
```

Cache eviction should delete only local files and update SQLite to `remote_only`. It must never delete Quark objects.

## Implementation Status

Completed:

- SQLite-backed runtime config.
- tmp-backed local directory for multipart upload parts.
- S3 multipart upload compatibility by assembling local parts before uploading one final object to Quark.
- Quark ListBucket XML and GET/HEAD object read cache with TTL and size cleanup.
- GitHub release metadata cache, so repeated directory listings and file metadata checks do not hit the GitHub API every time.
- Conservative cache invalidation for normal PUT/DELETE, multipart complete, and config PUT.

Planned cache work:

1. Add SQLite metadata for directories and richer object indexes if needed.
2. Change large-object GET to stream from Quark while writing a temp cache file, instead of buffering the whole object before caching.
3. Add a manual refresh command/API to rescan a Quark directory and reconcile cached metadata.
4. Add cache-size reporting and later LRU controls.

## Later Work

- async write-back queue
- crash recovery for `uploading` state
- multipart S3 upload compatibility
- cache pinning
- cache max-size config
- web file UI
- optional `quark_open` OAuth backend
