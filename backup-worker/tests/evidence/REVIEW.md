# Verification evidence / local-only review

Scope: only `backup-worker/**`, based on `574a2fac`, branch `Codex/image-group-worker`. No production access, credentials, push, PR, deploy or whole-server suite.

## Test-first evidence (original output)

- `01-boundary-red.log`: two feature assertions fail because key builder / Worker fetch do not exist yet. `02-boundary-green.log`: same assertions pass after first implementation.
- `03-storage-red.log`: six missing storage behavior assertions fail before implementation. `04-storage-green.log`: eight cumulative tests pass.
- `05-manifest-red.log`: missing manifest exports fail. `06-manifest-green.log` deliberately retained although the first concurrent-publication test still failed: both same-request publishers were allowed to finish as exact idempotent recovery because the fixture did not synchronize their reads. The fixture was corrected to force both readers to observe the same old base before writing, without weakening one-CAS-winner assertions. `07-manifest-green.log`: twelve pass.
- `08-http-red.log`: new real HTTP routing assertions fail against authentication-only entry. `09-http-green.log`: seventeen cumulative tests pass.
- `11-hardening-red.log`: actual reproduced bugs, not missing exports: numeric Drive ID was regex-coerced and accepted; an old timed-out response could release a new request's active-body slot. Both fixed, with `12-hardening-green.log` passing nineteen tests.
- `14-key-budget-red.log`: long name was mislabeled BAD_DESCRIPTOR instead of the contract's TOO_LARGE key-byte-budget failure. Fixed without normalization/truncation.
- `17-fixture-red.log`: final commit gate caught a fixture-edit mistake: reading a public base64 fixture through the redacting file viewer and rewriting it had shortened the descriptor header. The header was regenerated from the public envelope, and the exact header/part/index/current fixture roundtrip is now checked before commit. No production credential was involved.
- Subsequent tests add preservation/boundary checks, a complete independently hashed wire fixture join, malformed default config failure and isolated body-proof/CAS mutants; final unit/runtime logs are the commit gate outputs (`17-commit-unit.log`, `18-commit-runtime.log`).

Runtime logs: `10-runtime-first.log`, `13-runtime-budget.log`, `16-final-runtime.log` and final commit-runtime output preserve each invocation's stdout. `runtime-wrangler.log` contains the latest actual Wrangler startup/request output. The first runtime harness inherited the host system TMPDIR; it was corrected to explicitly use `~/.hermes/cache/scratch` for all subsequent local state and isolated HOME. No production credentials were loaded in either case.

## Review: security / caller experience / operational risk

- Security: auth first across every route/method, source wrapper get/head only, independent secret with no checked-in production value, excluded ancestor wins, no arbitrary fetch URL/bucket/prefix or DELETE/CORS, SVG attachment/CSP/no-store. Root syntax is not independent proof of Drive ownership. Public bucket/domain state remains a parent deployment verification.
- Caller experience: fixed SOURCE_MISSING/SOURCE_MISMATCH fallback codes; body receipt required before success; object-before-receipt retry repairs crash window; same bytes replay gives stable receipt identity; precise size/version/root/unknown-field failures. Wire fixture is independently generated with Python, and now includes matching part/index/current hashes and etag.
- Operational risk: native local R2 conditional null and etag CAS checked, BigInt generations above safe-number range, forced same-base race plus isolated CAS-removal mutant, no key/receipt/generation deletion, one active body, actual 25MiB write/readback/get. An old response releasing a newer slot was caught and fixed before commit. R2 cannot be canceled by AbortSignal: timeout retains slot until pending operation settles, rather than spawning unbounded replacement writes. No global concurrency-one/distributed atomicity/production heap claim.

## Limits

Server implementation/SQL/lease/scanner and its use of this fixture must be tested by parent. Only parent runs integration/full server regression. Real cloud provisioning, private/public domains, credentials and root IDs, operational restore, multi-isolate production contention and disabling the old workflow are not tested or changed here. Source seeding and failure injection exist only in the local harness, not the production entry/config.
