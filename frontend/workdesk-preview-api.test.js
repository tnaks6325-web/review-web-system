const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workdesk = fs.readFileSync(path.join(__dirname, 'workdesk.html'), 'utf8');

assert.match(
  workdesk,
  /preview_api/,
  'Cloudflare PR preview must accept an explicit preview API target.'
);
assert.match(
  workdesk,
  /review-web-system\.pages\.dev/,
  'Preview API override must be restricted to the review-web-system Pages preview host.'
);
assert.match(
  workdesk,
  /isRailwayPrApi[\s\S]*sublime-magic-review-web-system-pr-/,
  'Preview API override must only allow Railway PR service domains.'
);
assert.match(
  workdesk,
  /window\.REVIEW_API_URL\s*=\s*previewApi/,
  'The accepted preview URL must become the shared API base before api.js loads.'
);

console.log('workdesk preview API target guard passed');
