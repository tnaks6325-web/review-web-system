'use strict';
/**
 * 블로그체험단 — v2 작업표 접수 + 접수 뒤 종류 변경 잠금 (2026-11-03).
 *
 *   ① v2 블로그 오더는 리뷰타입이 없다(인트라넷 reviewOrderApplyBlogRule 이 지워 보낸다). 행별 리뷰 형태를
 *      정하려 들면 `invalid_review_type` 으로 접수가 영영 막혔다(운영 최근 오더 전부 v2 — 실측).
 *   ② v2 블로그 표도 구매일자를 깔지 않는다(결정 138 · 127). v2 도입(#1264) 때 v1 에만 걸려 있었다.
 *   ③ 접수만 되고 광고주·공고가 없는 오더는 종전 잠금(isSourceEditLocked)에 안 걸려 종류가 그대로 저장됐다 —
 *      작업표(블로그 3열·리뷰옵션)와 오더 종류가 갈라진다. 접수된 오더의 종류 변경은 409 로 막는다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildWorktablePlan } = require('../src/utils/worktablePlan');

const template = { core: ['번호', '구매일자', '수취인', '연락처', '주소', '주문번호', '결제금액', '리뷰', '입금', '비고'], channels: {}, workTypes: [] };
const v2 = (over = {}) => ({
  workboard_schema_version: 2,
  recruit_count: 3,
  daily_count: 3,
  start_date: '2026-11-03',
  product_options_json: JSON.stringify([{ name: '간장', product_mode: 'none', base: { count: 3 }, options: [] }]),
  ...over,
});

test('① v2 블로그 오더는 리뷰타입 없이 접수된다(invalid_review_type 없음)', () => {
  const plan = buildWorktablePlan({ workOrder: v2({ work_kind: 'blog', review_type: '' }), template });
  assert.deepEqual(plan.blockers.map(b => b.code), []);
  assert.equal(plan.rows.length, 3);
  assert.ok(plan.rows.every(r => !r.reviewOptionLabel), '블로그 행에는 리뷰 형태를 적지 않는다');
});

test('② v2 블로그 표도 구매일자를 깔지 않고 블로그 3열을 붙인다', () => {
  const plan = buildWorktablePlan({ workOrder: v2({ work_kind: 'blog' }), template });
  assert.ok(plan.rows.every(r => !r.date), 'v2 블로그도 구매일자 공란');
  const names = plan.columns.map(c => c.name);
  for (const n of ['블로그URL', '포스팅결과URL', '포스팅제출일']) assert.ok(names.includes(n), n);
  assert.ok(plan.warnings.some(w => w.code === 'blog_no_dates'));
});

test('리뷰 v2 오더는 무회귀 — 리뷰타입이 없으면 종전대로 막고, 있으면 날짜를 깐다', () => {
  const noType = buildWorktablePlan({ workOrder: v2({ work_kind: '', review_type: '' }), template });
  assert.ok(noType.blockers.some(b => b.code === 'invalid_review_type'));
  const ok = buildWorktablePlan({ workOrder: v2({ work_kind: '', review_type: '포토' }), template });
  assert.deepEqual(ok.blockers.map(b => b.code), []);
  assert.equal(ok.rows.filter(r => r.date).length, 3);
});

const ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/order.routes.js'), 'utf8');

test('③ 판정 함수 — 접수된(작업표 연결) 살아 있는 오더만, 정규화한 종류가 다를 때만', () => {
  const m = /function _acceptedWorkKindChanged\(order, nextKindRaw\) \{[\s\S]*?\n\}/.exec(ROUTES);
  assert.ok(m, '_acceptedWorkKindChanged 정의');
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', `${m[0]}; return _acceptedWorkKindChanged;`)(require('module').createRequire(path.join(__dirname, '../src/routes/order.routes.js')));
  const accepted = { linked_tab_name: '작업', work_kind: 'blog' };
  assert.equal(fn(accepted, 'review'), true);
  assert.equal(fn(accepted, ''), true, '보내지 않은 종류 = 리뷰(전체 갱신이 그렇게 쓴다)');
  assert.equal(fn(accepted, '블로그체험단'), false, '표기만 다른 같은 종류');
  assert.equal(fn({ linked_tab_name: '작업', work_kind: '' }, 'review'), false, '빈 값 = 리뷰');
  assert.equal(fn({ linked_tab_name: '', work_kind: 'review' }, 'blog'), false, '접수 전에는 자유');
  assert.equal(fn({ linked_tab_name: '작업', work_kind: 'review', deleted_at: '2026-11-03' }, 'blog'), false, '삭제된 오더는 다른 잠금이 막는다');
});

test('③ 원본 수정·옛 수정 두 경로 모두 종류 변경을 409 로 막는다(양방향 오더의 기존 응답은 그대로)', () => {
  const src = ROUTES.indexOf("current.bidir_state !== 'on' && _acceptedWorkKindChanged(current, b.work_kind)");
  assert.ok(src > 0, '원본 수정 경로 판정');
  assert.ok(src < ROUTES.indexOf('if (_sourceManagerCapability(b)) {'), '담당자 분기(전체 저장 가능)보다 앞');
  assert.ok(src > ROUTES.indexOf('if (await _qnaCalendarLocked(current)) {'), 'Q&A 자리표 잠금 뒤');
  assert.match(ROUTES, /if \(b\.work_kind !== undefined && _acceptedWorkKindChanged\(cur\[0\], b\.work_kind\)\) \{\s*return res\.status\(409\)\.json\(\{ ok: false, code: 'accepted_kind_locked'/);
  assert.equal((ROUTES.match(/code: 'accepted_kind_locked'/g) || []).length, 2);
});
