const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const search = fs.readFileSync(path.join(root, 'src', 'services', 'search.service.js'), 'utf8');
const submit = fs.readFileSync(path.join(root, 'src', 'routes', 'submit.routes.js'), 'utf8');
const sheetlessStatus = fs.readFileSync(path.join(root, 'src', 'services', 'sheetlessStatus.service.js'), 'utf8');
const tabConfig = fs.readFileSync(path.join(root, 'src', 'routes', 'tabconfig.routes.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations', '141_participant_submission_source_backfill.sql'), 'utf8');

assert.match(search, /const submittedState = 'COALESCE\(cp\.is_submitted, ri\.is_submitted\)'/,
  '리뷰어 내역은 작업보드 참여자 상태를 우선으로 읽어야 한다');
assert.match(search, /LEFT JOIN campaign_participants cp[\s\S]*cp\.seq = ri\.row_index/,
  '리뷰어 내역은 작업보드 행과 같은 작업·탭·행 번호로 상태를 연결해야 한다');
assert.match(submit, /UPDATE campaign_participants SET is_submitted = TRUE/,
  '리뷰어가 제출하면 시트 기반 작업도 작업보드 참여자 상태를 확정해야 한다');
assert.match(sheetlessStatus, /SET row_json[\s\S]*is_submitted = CASE WHEN \$6::text = 'submit' THEN TRUE ELSE is_submitted END/,
  '무시트 상태 기록은 작업표 셀과 참여자 제출 상태를 함께 저장해야 한다');
assert.match(tabConfig, /WITH reopened AS \([\s\S]*UPDATE campaign_participants cp[\s\S]*SET is_submitted = FALSE[\s\S]*FROM reopened r[\s\S]*cp\.seq = r\.row_index/,
  '필수 캡처 슬롯을 추가해 재오픈하면 참여자 제출 상태도 함께 해제해야 한다');
assert.match(migration, /UPDATE campaign_participants cp[\s\S]*SET is_submitted = TRUE/,
  '기존 작업표의 제출값도 참여자 제출 상태로 한 번 보정해야 한다');

console.log('review submission participant source contract passed');
