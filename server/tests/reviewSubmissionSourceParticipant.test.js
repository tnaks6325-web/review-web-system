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
// 결정 270: 완료행 재오픈 도구 POST /api/tab/reopen-slots(옛 대시보드 전용 · 호출 화면 0)는 지웠다 —
//   review_index 만 되열고 참여자 상태를 그대로 두는 반쪽 재오픈이 되살아나지 않도록 부재를 고정한다.
assert.ok(!/router\.post\('\/reopen-slots'/.test(tabConfig) && !/WITH reopened AS/.test(tabConfig),
  '지운 재오픈 도구가 되살아났다 — 되살린다면 참여자 제출 상태(campaign_participants)도 함께 해제해야 한다');
assert.match(migration, /UPDATE campaign_participants cp[\s\S]*SET is_submitted = TRUE/,
  '기존 작업표의 제출값도 참여자 제출 상태로 한 번 보정해야 한다');

console.log('review submission participant source contract passed');
