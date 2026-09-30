/**
 * 리뷰어 화면에 **내부 키가 그대로 찍히던** 회귀 가드 (2026-08-19 신고).
 *   구매 캡처 보완 카드에 `campaign:camp_0df34a3b8664` 가 작업 이름 자리에 표시됐다.
 *   원인 = 참여형(무시트) 주문의 원장 좌표(`campaign:<공고ID>`)를 이름 폴백으로 쓰고 있었다.
 *
 * 고정하는 것:
 *   1. `_taskLabel` 순수함수 — 내부 키(campaign:·wt_)는 절대 반환하지 않고, 이름이 없으면
 *      빈 문자열이 아니라 '참여 작업'으로 말한다(사람이 읽는 문구).
 *   2. 화면 소비처가 **그 함수 하나**만 쓴다(사본 = `|| item.tabName ||` 폴백 부활 금지).
 *   3. 서버 `/my-missing-captures` 가 사람이 읽는 이름을 확정해 내려준다(공고 제목 우선).
 *
 * 실행: node tests/reviewerTaskLabel.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');

// ── 1) 순수함수 실제 실행 ──────────────────────────────────────────────
const start = page.indexOf('const _INTERNAL_KEY_RE');
assert.ok(start > 0, '_INTERNAL_KEY_RE 선언이 있어야 한다');
const end = page.indexOf('let _mcItems', start);
assert.ok(end > start, '헬퍼는 소비처(_mcItems 블록)보다 **앞**에 선언돼야 한다');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(page.slice(start, end), sandbox);
const label = (o, f) => vm.runInContext('_taskLabel', sandbox)(o, f);

assert.equal(label({ displayNameTC: '모기위키 모기기피제' }), '모기위키 모기기피제', '1: 정상 이름');
assert.equal(label({ tabName: 'campaign:camp_0df34a3b8664' }), '참여 작업',
  '1: campaign:<공고ID> 는 이름이 아니다 — 신고 케이스');
assert.equal(label({ displayNameTC: 'campaign:camp_x', campaignName: '모기위키' }), '모기위키',
  '1: 내부 키는 건너뛰고 다음 후보를 쓴다');
assert.equal(label({ tabName: 'wt_9f3a2b1c8d7e6f5a4b3c' }), '참여 작업',
  '1: 가상 시트 ID 도 이름이 아니다');
assert.equal(label({}, ''), '', '1: 폴백 문구는 호출부가 정한다(빈 문자열 허용)');
assert.equal(label({ tabName: '8/15모기위키 모기기피제' }), '8/15모기위키 모기기피제',
  '1: 평범한 탭 이름은 그대로 쓴다(과잉 차단 금지)');
assert.equal(label(null), '참여 작업', '1: 값이 없어도 사람이 읽는 문구');
console.log('  1. _taskLabel 순수함수 ✓');

// ── 2) 사본 금지 — 화면 어디에도 tabName 이름 폴백이 남아 있으면 안 된다 ──
const strippedComments = page.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
assert.ok(!/displayNameTC\s*\|\|[^\n]*\|\|\s*it?e?m?\.?tabName/.test(strippedComments),
  '2: 이름 폴백에 tabName 을 쓰는 사본이 남아 있으면 내부 키가 다시 샌다');
const uses = (page.match(/_taskLabel\(/g) || []).length;
assert.ok(uses >= 7, `2: 소비처가 모두 헬퍼를 쓴다(현재 ${uses}곳)`);
assert.ok(/\$\{esc2\(_taskLabel\(it\)\)\}/.test(page),
  '2: 구매 캡처 보완 카드도 같은 헬퍼로 그린다');
console.log('  2. 사본 금지 ✓');

// ── 3) 서버가 사람이 읽는 이름을 확정한다 ──────────────────────────────
const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reviewer.routes.js'), 'utf8');
const mc = routes.slice(routes.indexOf("router.get('/my-missing-captures'"));
const body = mc.slice(0, mc.indexOf('module.exports'));
assert.ok(/COALESCE\(NULLIF\(rc\.title, ''\), NULLIF\(wt\.display_name, ''\), NULLIF\(wt\.tab_name, ''\)/.test(body),
  '3: 이름은 지금 적용된 공고 제목이 먼저(리뷰 내역 카드와 같은 우선순위)');
assert.ok(/LEFT JOIN campaign_applications ca ON ca\.id = os\.campaign_application_id/.test(body),
  '3: 참여형 주문은 신청 → 공고로 이름을 찾는다');
assert.ok(/LEFT JOIN tab_configs wt[\s\S]{0,160}wt\.sheet_id = rc\.linked_sheet_id/.test(body),
  '3: 공고 미설정 시 연결 작업표 탭 이름으로 접는다');
assert.ok(/os\.tab_name AS "tabName"/.test(body),
  '3: tabName 은 계속 내려보낸다 — 첨부 업로드의 폴더 좌표(이름이 아니다)');
console.log('  3. 서버 이름 확정 ✓');

console.log('✅ reviewerTaskLabel 테스트 전체 통과');
