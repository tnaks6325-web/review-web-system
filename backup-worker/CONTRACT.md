# Private group-backup Worker — v1 contract

Single source: handover `judge.md` §§3–5 (2026-11-11), plus the parent's environment-name clarification. This file describes that wire contract, not a replacement API. This package is a **separate Worker**, not a Pages Function. No server, frontend or existing `/img` files are changed.

## Configuration / trust boundary

- `BACKUP` → **new** `review-web-group-backups`; `SOURCE_IMAGES` → existing `review-web-images`. Neither bucket is provisioned by this change. The parent must create the new private bucket and verify public `r2.dev`/custom domains are disabled, and verify no public Pages application receives `BACKUP`.
- `workers_dev: true` provides an authenticated endpoint; preview URLs disabled. Every method/path, including unknown routes and HEAD/OPTIONS, authenticates before touching either R2 binding. No CORS headers or DELETE endpoint exist.
- New independent secret **`IMAGE_BACKUP_API_KEY`** is shared only by Worker and server. This task does not generate, print, register or read a production secret. Missing/short secret fails closed. JWT, image signing/origin keys and advertiser credentials must not be reused. The local test config's literal credential is a public non-production test fixture only.
- Both server and Worker use **`IMAGE_BACKUP_ALLOWED_ROOT_IDS`** and **`IMAGE_BACKUP_EXCLUDED_ROOT_IDS`**, JSON arrays of Drive ID strings. Checked-in values are `[]`: object writes fail closed until configured. Parent supplies the two actual allowed roots and excluded transfer root as deployment variables; no real ID is checked in. Any excluded ancestor wins over an allowed first root.
- `SOURCE_IMAGES` is accessed through an `orig/<validated fileId>` **get/head-only code wrapper**. The R2 binding is **not** a read-only capability; compromise of the Worker is not claimed incapable of source writes. The production code contains no source put/delete or external fetch.
- Authenticated server supplies actual Drive ID/name ancestry, classification and stable proof. Worker rechecks syntax/allow/exclude roots but does **not** independently attest Drive ownership, ancestry, version stability or MD5 authenticity. MD5 is an integrity comparison, not a cryptographic authenticity guarantee. Transfer IDs/source and private classification are server responsibilities in addition to the Worker's excluded-root check.
- Observability disables invocation URL logging and tracing to avoid recording reversible names in object paths. No request bodies, keys, names or tokens are logged by production source. The local runtime harness is never a deployment entry.

## Exported ESM storage API

Import has no I/O. Bindings/config are supplied as `env` on every call. The HTTP entry calls these same functions.

```js
buildObjectKey({descriptor,sha256}) // string
putVerifiedObject(env,{descriptor,proof,body}) // Promise<Receipt>
copyVerifiedOrig(env,{descriptor,proof}) // Promise<Receipt>
getObject(env,{key,head}) // Promise<{body,size,mime,sha256,etag}|null>
putManifestPart(env,{generation,part,bytes,sha256}) // Promise<{key,sha256,size}>
commitManifest(env,{generation,baseGeneration,expectedEtag,indexBytes}) // Promise<Current>
readManifest(env,{generation,part}) // Promise<{bytes,etag}|null>
getReceipt(env,{receiptId}) // Promise<{bytes,etag}|null>
readCurrent(env) // Promise<Current|null>
listManifests(env,{kind,cursor,limit}) // Promise<{items,truncated,cursor}>
```

`body`/`bytes` accepts Uint8Array/ArrayBuffer or a ReadableStream. Stream reads are bounded and canceled on overflow/30-second read deadline. Additional internal helpers are exported for shared validation and local tests, not additional HTTP APIs.

## Data definitions

```js
Envelope = {v:1,descriptor:D,proof:P}
D = {fileId,rootId,chain:[{id,name}],name,mime,size,sourceVersion,section}
P = {kind:'drive-md5',md5,size,sourceVersion}
  | {kind:'drive-sha256',sha256,size,sourceVersion}
Receipt = {v:1,key,fileId,sha256,size,mime,objectEtag,receiptId,verified:true}
Current = {v:1,generation,indexSha256,etag}
```

- Chain starts at the allowed root itself and ends at the real parent. First ID equals `rootId`; duplicate ancestor IDs are invalid. IDs are strings matching `[A-Za-z0-9_-]{10,200}`. Source version is a decimal Drive version string. Size is a nonnegative safe integer and must match proof size; versions must match too. MIME is normalized lowercase `image/*` (including SVG). Section is `work|common|internal`; none is publicly exposed.
- MD5 is 32 lowercase hex; SHA-256 is 64 lowercase hex. Unknown fields on envelope, descriptor, proof, each chain item, part, entry, index, index part descriptor and current request are rejected. `counts` is the contract's open counter map: ASCII identifier labels → nonnegative safe integers.
- `key = v1/<section>/<segment(rootName,rootId)>/.../<segment(parentName,parentId)>/<segment(fileName,fileId)>/<sha256>`.
- `segment(name,id) = base64url(UTF8(name)) + '~' + id`. No Unicode normalization, name truncation or path-character replacement. Slash, backslash, dot-like text and controls are encoded, never path traversal. Malformed Unicode is rejected. Keys above **1000 UTF8 bytes** fail `TOO_LARGE` rather than truncate. Unsupported/oversized items must be reported by the parent, not silently excluded.
- `receiptId = sha256(UTF8(canonical({descriptor,proof,key,sha256,size,mime})))`. Canonical recursively sorts object keys by ASCII order, retains array order, serializes UTF8 JSON, and rejects undefined/non-JSON values. No volatile timestamps. `objectEtag` and current `etag` are R2 etags **without quotes**; HTTP ETag headers are quoted. ETag is not a content SHA proof.

## Fixed HTTP routes

All requests: `Authorization: Bearer <independent secret>`. All responses, including errors and HEAD: `Cache-Control:no-store`, `X-Content-Type-Options:nosniff`, sandbox CSP. Object/manifest/receipt downloads use `Content-Disposition:attachment` with a fixed safe filename. No cross-origin access is enabled.

| Method/path | Request | Successful response |
|---|---|---|
| `PUT /v1/objects` | `Content-Type:application/octet-stream`, raw original bytes; `X-Backup-Descriptor:base64url(UTF8(JSON.stringify(Envelope)))` | 200 JSON Receipt |
| `POST /v1/objects/copy` | `Content-Type:application/json`, Envelope | 200 JSON Receipt |
| `GET /v1/objects/<base64url(UTF8(key))>` | key is decoded once and validated against generated grammar | original bytes, Content-Length/Type, ETag, X-Backup-Sha256 |
| `HEAD /v1/objects/<base64url(UTF8(key))>` | same key grammar | same metadata, no body; **not** a full-byte hash audit |
| `PUT /v1/manifests/<generation>/<part>` | JSON UTF8 raw bytes, `X-Backup-Sha256` of exact bytes | 200 JSON `{key,sha256,size}` |
| `GET /v1/manifests/<generation>/<part>` | — | exact stored JSON bytes, ETag/hash headers |
| `PUT /v1/manifests/current` | JSON `{v:1,generation,baseGeneration,expectedEtag,indexSha256}` | 200 JSON Current |
| `GET /v1/manifests/current` | — | 200 JSON Current; 404 before initial creation |
| `GET /v1/manifests/receipts/<receiptId>` | lowercase SHA ID | exact receipt document JSON bytes |
| `GET /v1/manifests?kind=receipts\|generations&cursor=<opaque>&limit=1..1000` | only these query fields; no duplicates | JSON `{items:[{key,size,etag}],truncated,cursor}` |

Descriptor header decodes to at most **8KiB**; copy JSON also at most 8KiB. Object bodies are at most **25MiB**. Manifest `generation` is a positive decimal string without leading zero, compared with **BigInt**. `part` is `p000000` format or `index`; part body maximum **256KiB**, index **1MiB**. Current request maximum 2KiB.

```js
Part = {v:1,generation,part,entries:[{
  receiptId,key,fileId,sha256,size,mime,descriptor,proof,
  presence // observed|not_observed|unresolved
}]}
Index = {v:1,generation,baseGeneration,rootSetHash,scanComplete:true,
  parts:[{part,sha256,size,count}],counts}
ReceiptDocument = {v:1,descriptor,proof,object:Receipt}
```

Parts have unique receipt IDs, each descriptor/proof/key/hash/receipt identity must agree. Index part names must be ordered ascending without duplicates. `not_observed` is not a confirmed deletion. Parent/server checks **all** part existence/hash/size/count, cross-part uniqueness, scan completeness and cumulative old receipt preservation before publishing. Worker commit reads/checks only the index, **not every part**, so current is not a whole-backup audit certificate.

Listing uses a fixed `manifests/` prefix, filtering numeric generation paths for `kind=generations`. Because the R2 page can contain filtered-out current/receipt keys, an empty page can still have `truncated:true`. **Continue using the opaque cursor until `truncated:false`; final cursor is null.** No arbitrary bucket/prefix is accepted.

## Storage / crash / CAS behavior

1. Bound body; compare actual length and MD5 or SHA proof; calculate actual SHA-256. Copy reads only `SOURCE_IMAGES.get('orig/'+fileId)`. Missing orig → `SOURCE_MISSING`; stale/same-length wrong bytes → `SOURCE_MISMATCH`. These **two exact codes only** trigger the server's Drive-download fallback.
2. Write object with `onlyIf: Headers({'If-None-Match':'*'})` and the **single** `sha256` checksum option. Await PUT and perform an independent BACKUP GET body read/hash/length check. A null conditional PUT alone never succeeds: only an existing matching body makes the operation idempotent; conflicting bytes fail.
3. Create-only `manifests/receipts/<receiptId>.json`, also with independent GET byte verification, before returning Receipt. If object stored but receipt failed, request fails; retry verifies/reuses object and repairs receipt. Old objects, old path versions, generations and receipts are never deleted.
4. `commitManifest` verifies supplied index bytes against the actually stored immutable index; verifies index structure/generation/base. Current generation/base/etag must agree with the request, new generation must be greater. First create uses `If-None-Match:*`; later uses `{etagMatches:expectedEtag}`. Conditional null → **412**, never re-read/reinterpret null as success.
5. If the exact requested generation/index hash was already current before this attempt, return it without a write (lost-response recovery). Otherwise old scans cannot rebase and stale requests fail. Two publishers are protected by R2 CAS even if both observed the same base. DB leases/R2 writes are not a distributed transaction or perfect fencing guarantee.
6. Isolate-local admission (`src/admission.js`): at most **4** in-flight requests and a **56MiB** reservation budget per isolate. Every request reserves 2MiB (streaming GET holds it until completed/canceled); PUT/copy then grow by 2×declared size (whole body + R2 read-back are buffered; `readBounded` allocates exactly the validated descriptor size ≤25MiB). Over count or budget returns BUSY (retryable), so a 25MiB body effectively runs alone while sub-MB photos overlap. A 30s request deadline is applied. R2 binding operations have no AbortSignal: timed-out I/O retains its reservation until settled (and uses waitUntil); a late cancel releases only its own reservation. This is not global concurrency control nor a measured production heap guarantee. Actual 25MiB PUT/re-read/GET and 4-overlap/5th-BUSY are covered locally.

## Exact errors

Body `{v:1,error:{code,retryable}}`; HEAD body empty with `X-Backup-Error`. Original exceptions, names and tokens are never returned.

| Code | Status | retryable |
|---|---:|---|
| AUTH_REQUIRED | 401 | false |
| BAD_DESCRIPTOR | 400 | false |
| SCOPE_DENIED | 403 | false |
| NOT_FOUND / SOURCE_MISSING | 404 | false |
| SOURCE_MISMATCH / KEY_CONFLICT | 409 | false |
| SOURCE_CHANGED | 409 | true |
| PRECONDITION_FAILED | 412 | false |
| TOO_LARGE | 413 | false |
| BUSY | 429 | true |
| STORE_UNAVAILABLE | 503 | true |
| VERIFY_FAILED | 502 | true |

Worker cannot detect Drive metadata changes itself; SOURCE_CHANGED remains a shared protocol code for the server's stable-observation flow. Do not alias source fallback codes.

## Local verification / fixtures

```sh
cd backup-worker
npm ci
npm test
npm run test:runtime
```

Wrangler is pinned at **4.160.0** in manifest and lockfile. Native workerd `crypto.subtle.digest('MD5', bytes)` and SHA-256 are exercised in actual `wrangler dev --local` R2 roundtrips: no external MD5 dependency is used. Node's test-only MD5 adapter is explicitly not the runtime proof.

- `tests/fixtures/wire-v1.json`: independently generated Python canonical-byte/hash fixture; B may read this file **without requiring A's implementation**. Envelope/header/receipt/receipt document/canonical material/current shape/fallback codes are fixed here.
- `tests/evidence/*`: original RED and GREEN output; failed intermediate hardening attempt retained. `runtime-wrangler.log` is actual local Wrangler output.
- `tests/runtime/run.mjs`: starts only its own Wrangler PID, uses isolated HOME (no credentials), local-only fake buckets, persistent local state under `~/.hermes/cache/scratch`, and SIGTERM to that PID only. Tests real runtime MD5/SHA, conditional null/CAS, PUT readback, copy mismatch/fallback, receipt failure/crash-restart-retry, immutable part/index, BigInt current, source write-call zero and actual production config without a secret. Injection/seed HTTP routes exist **only** in `tests/runtime/harness.js` and its local test config.
- Unit mutation checks deliberately remove MD5 proof or R2 CAS in isolated imported copies and assert that the corresponding acceptance check fails. No production source is mutated on disk.

Not verified here: operational provisioning/private-domain state, real secrets/roots/Drive permissions, server integration/SQL/leases/scanner, live multi-isolate races, Cloudflare production memory/CPU/latency, customer submissions or real backup/restore/old-workflow transition. Server-wide 814-test baseline belongs to parent and is not rerun or claimed as this task's result. This task performs **no push, PR, deploy, resource creation, production access or workflow disable**.

API reference used for conditional-null/etag/checksum behavior (also exercised locally): Cloudflare R2 Workers API reference, https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ .
