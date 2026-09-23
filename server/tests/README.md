# Server test suite

The repository test gate runs every `*.test.js` file in this directory in a
separate Node.js process. Process isolation prevents one test's module cache,
mock, or environment mutation from leaking into another test.

## Commands

```bash
npm test -- --compact
npm test -- --verbose
npm test -- --match workboard --jobs 1
npm test -- --fail-fast
npm run test:list
```

- The default is up to four parallel workers; `--jobs` accepts 1 through 8.
- Each file has a 120-second timeout.
- Text reads normalize CRLF to LF so source-inspection assertions behave the
  same on Windows and Linux.
- Live database, Drive, AI, webhook, and service credentials are blanked in
  child processes. This is the default unit/contract test path.
- A deliberately provisioned integration job may opt in with
  `TEST_LIVE_SERVICES=1`; never use that switch with production credentials.

GitHub Actions runs `npm test -- --compact` for pull requests and pushes to
`main`. A non-zero result from any test file fails the workflow.
