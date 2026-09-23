const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'campaignPlan.service.js'), 'utf8');

assert.match(source, /sheetlessLinked === true && Array\.isArray\(worktableDates\)/,
  'sheetless worktable campaigns must use the worktable progress path');
assert.match(source, /plannerSubmittedAll \+= filled/,
  'planner progress must sum filled worktable rows');
assert.match(source, /submittedAll: plannerSubmittedAll/,
  'daily-plan response must expose the worktable-based progress value');
assert.match(source, /byDateSubmitted: plannerByDateSubmitted/,
  'daily-plan dates must use the same progress basis as the total');
assert.match(source, /plannerProgressSource = 'applications'/,
  'unreadable or unlinked worktables must retain the submitted-application fallback');

console.log('campaignPlanWorktableProgress: passed');
