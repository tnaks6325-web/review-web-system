'use strict';
/**
 * 결정 415 — 리뷰 제출 시각(작업표 「리뷰제출」 칸)은 서버가 KST 로 정한다 · 휴대폰 시계 값은 쓰지 않는다.
 *   A. POST /api/submit/review 를 스텁 pool 로 실제 실행 — 서버 시각을 2026-11-25T15:05:00Z(= KST 11/26 00:05)로 고정하고
 *      화면이 틀린 휴대폰 시계 값(11/25 09:05)을 보내도 칸에는 11/26 00:05 가 쓰인다 · value 없는 옛 화면도 '제출' 대신 시각.
 *      시각 값은 결정 375 의 식 한 벌(SUBMIT_TIME_SQL)을 **실제 PostgreSQL(PGlite)** 로 계산한다(NOW() 만 고정 시각으로 바꿈).
 *   B. 서버 식과 화면 식(search-app.js·campaign.html 의 `M/D HH:MM`)이 같은 순간에 글자 하나까지 같다(0 채움 규칙).
 *   C. 리뷰어 홈 수정요청 사진 업로드가 끊기면 실패 안내는 한 번만(업로드 도구 토스트 끔 { quiet:true }).
 * 실행: cd server && node --test tests/reviewSubmitServerTime.test.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-review-submit-server-time';
delete process.env.DATABASE_URL;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

const SRC = (rel) => require.resolve('../src/' + rel);
const status = require(SRC('services/sheetlessStatus.service.js'));
const sql = new PGlite();
// SUBMIT_TIME_SQL 을 실제 PG 로 — NOW() 만 고정 시각으로 바꾼다(식 자체는 운영 그대로).
const pgTimeAt = async (iso) => {
  const expr = status.SUBMIT_TIME_SQL.replace('NOW()', `'${iso}'::timestamptz`);
  assert.notEqual(expr, status.SUBMIT_TIME_SQL, 'SUBMIT_TIME_SQL 은 NOW() 기준이어야 한다');
  return (await sql.query(`SELECT ${expr} AS v`)).rows[0].v;
};

/* ── 라우트 의존 스텁(라우트 require 전에 — 머리에서 구조분해하는 것들) ── */
require(SRC('services/reviewerSession.service.js')).verifyReviewerSession = () => ({ ownerReviewerId: 'r1', phone8: '12345678' });
require(SRC('services/workKindContext.service.js')).workKindForTab = async () => 'review';
require(SRC('services/reviewTypeContext.service.js')).reviewTypeForTab = async () => null;
require(SRC('services/dualChannelReview.service.js')).bundleTargetForRow = async () => null;
require(SRC('services/reviewerTargetOwnership.service.js')).ownsReviewerTarget = async () => true;
const rct = require(SRC('services/reviewCompletionTransaction.service.js'));
rct.isWorkFinished = async () => false;
rct.lockTarget = async () => ({ is_submitted: false });
require(SRC('services/reviewReminder.service.js')).closedStateForTarget = async () => null;
const cash = require(SRC('services/cashReceiptContext.service.js'));
cash.cashReceiptRequirementsForRows = async () => new Map();
cash.cashReceiptRequiredForTab = async () => false;
require(SRC('services/sheetlessLedger.service.js')).rebuildLedgers = async () => ({ ok: true });
const marks = [];
status.markStatusCell = async (args) => { marks.push({ ...args, client: !!args.client }); return { handled: true, ok: true }; };
status.markSheetlessMemo = async () => ({ handled: true, ok: true });

let frozenIso = '2026-11-25T15:05:00Z';
let timeQueryResult = null;   // null = 실제 PG 로 계산 · '' = 빈 값 흉내
const txLog = [];
const client = {
  async query(text) {
    const q = String(text);
    txLog.push(q.trim().split(/\s+/).slice(0, 3).join(' '));
    if (q.includes(status.SUBMIT_TIME_SQL)) {
      return { rows: [{ v: timeQueryResult == null ? await pgTimeAt(frozenIso) : timeQueryResult }] };
    }
    if (/completed_count/.test(q)) return { rows: [{ completed_count: 1, marked_count: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  },
  release() {},
};
const pool = require(SRC('db/pool.js'));
pool.query = async (text) => {
  if (/tc\.capture_slots AS capture_slots/.test(String(text))) return { rows: [{ capture_slots: null, income_type: null, is_submitted: false }] };
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => client;

const router = require(SRC('routes/submit.routes.js'));
const layer = router.stack.find((l) => l.route && l.route.path === '/review' && l.route.methods.post);
async function postReview(body) {
  marks.length = 0; txLog.length = 0;
  const req = { body: { sheetId: 's', tabName: '작업', rowIndex: 3, uploadBatchId: '00000000-0000-0000-0000-000000000001', ...body },
    headers: { 'x-reviewer-token': 'tok' } };
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    layer.route.stack[0].handle(req, res, reject);
  });
}

test('A1 휴대폰 시계가 틀린 화면 값은 무시 — 칸에는 서버 KST 시각(11/26 00:05)', async () => {
  frozenIso = '2026-11-25T15:05:00Z'; timeQueryResult = null;
  const r = await postReview({ value: '11/25 09:05' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].kind, 'submit');
  assert.equal(marks[0].value, '11/26 00:05', '휴대폰 시계 값이 아니라 서버 KST');
  assert.equal(marks[0].client, true, '완료 트랜잭션 안에서 쓴다');
  assert.equal(r.body.submitted, '11/26 00:05', '응답의 submitted 도 실제로 쓴 값');
  const iBegin = txLog.indexOf('BEGIN'), iTime = txLog.findIndex((s) => /^SELECT to_char/.test(s)), iCommit = txLog.indexOf('COMMIT');
  assert.ok(iBegin >= 0 && iTime > iBegin && iCommit > iTime, '시각은 같은 트랜잭션 안에서(NOW() = completed_at 과 같은 순간): ' + txLog.join(' | '));
});

test('A2 value 를 보내지 않는 옛 화면도 칸에는 시각(종전 기본값 「제출」 아님)', async () => {
  frozenIso = '2026-01-04T23:07:00Z'; timeQueryResult = null;   // KST 1/5 08:07 — 월·일 한 자리, 시·분 0 채움
  const r = await postReview({});
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(marks[0].value, '1/5 08:07');
});

test('A3 시각을 못 만들면 「제출」로 접지 않고 실패(재시도 안내 · 칸 쓰기 0 · ROLLBACK)', async () => {
  timeQueryResult = '';
  const r = await postReview({ value: '11/25 09:05' });
  timeQueryResult = null;
  assert.equal(r.status, 503);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.retryable, true);
  assert.equal(marks.length, 0, '화면 값으로도 기본값으로도 쓰지 않는다');
  assert.ok(txLog.includes('ROLLBACK') && !txLog.includes('COMMIT'), txLog.join(' | '));
});

test('A4 라우트에 화면 value 를 칸 값으로 쓰는 갈래가 없다(정적)', () => {
  const src = fs.readFileSync(SRC('routes/submit.routes.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/submitValue\s*=\s*value\b/.test(src) && !/value\s*\|\|\s*'제출'/.test(src), '화면 value 폴백 금지');
  assert.match(src, /submitValue = await require\('\.\.\/services\/sheetlessStatus\.service'\)\.submitTimeValue\(completionClient\)/);
  assert.ok(!src.includes("AT TIME ZONE 'Asia/Seoul', 'FMMM/FMDD"), '시각 식 사본 금지(SUBMIT_TIME_SQL 한 벌)');
});

test('B 서버 식과 화면 식은 같은 순간에 글자까지 같다(search-app.js 2곳 · campaign.html 2곳)', async () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  const app = read('frontend/js/search-app.js');
  const tpl = app.match(/const submitTimeValue = (`[^`]+`);/g) || [];
  assert.equal(tpl.length, 2, '리뷰어 제출 화면의 시각 식 2곳(단건·여러 건)');
  const camp = read('frontend/campaign.html');
  const campExpr = camp.match(/value: (\(now\.getMonth\(\)\+1\) \+ '\/' \+ now\.getDate\(\) \+ ' ' \+ String\(now\.getHours\(\)\)\.padStart\(2,'0'\) \+ ':' \+ String\(now\.getMinutes\(\)\)\.padStart\(2,'0'\)),/g) || [];
  assert.equal(campExpr.length, 2, '모집공고 화면의 시각 식 2곳');
  const exprs = [...new Set([...tpl.map((t) => t.replace(/^const submitTimeValue = |;$/g, '')),
    ...campExpr.map((c) => c.replace(/^value: |,$/g, ''))])];
  for (const iso of ['2026-11-25T15:05:00Z', '2026-01-04T23:07:00Z', '2026-12-31T14:59:00Z', '2026-12-31T15:00:00Z', '2026-10-09T03:30:00Z']) {
    const k = new Date(Date.parse(iso) + 9 * 3600e3);   // 휴대폰 시계가 KST 로 정확한 경우
    const now = { getMonth: () => k.getUTCMonth(), getDate: () => k.getUTCDate(), getHours: () => k.getUTCHours(), getMinutes: () => k.getUTCMinutes() };
    const server = await pgTimeAt(iso);
    for (const e of exprs) assert.equal(vm.runInNewContext(e, { now, String }), server, `${iso}: ${e}`);
    assert.ok(status.SUBMIT_TIME_SQL && /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/.test(server), server);
  }
});

test('C 리뷰어 홈 수정요청 사진 업로드 끊김 — 실패 안내는 한 번(업로드 도구 토스트 끔)', async () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  const API = read('frontend/api.js'); const HTML = read('frontend/index.html');
  const fnSrc = (src, name, prefix = 'async function ') => {
    const i = src.indexOf(prefix + name + '('); assert.ok(i > -1, name);
    let p = src.indexOf('(', i), pd = 0;
    for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
    let depth = 0; const j = src.indexOf('{', p);
    for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1); }
    throw new Error(name);
  };
  for (const mode of ['aborted', 'timeout', '네트워크 오류 — 인터넷 연결을 확인하세요.']) {
    const toasts = []; const els = {};
    const el = (id) => (els[id] = els[id] || { id, innerHTML: '', value: '', disabled: false });
    el('reEditSubmitBtn'); el('reEditReason');
    const ctx = { console, JSON, String, Number, Object, Error, Promise,
      API_BASE_URL: 'http://t', _ACTION_MAP: { reviewEditRequest: { method: 'POST', path: '/x' } },
      _uploadProgress: { show() {}, update() {}, hide() {} },
      _xhrPost: async () => { throw new Error(mode); },
      _apiToast: (m) => toasts.push('[업로드도구] ' + m), showToast: (m) => toasts.push(String(m)),
      document: { getElementById: (id) => els[id] || null } };
    vm.createContext(ctx);
    vm.runInContext(fnSrc(API, 'gasPostUpload') + '\n' + fnSrc(API, 'apiFriendlyErrorMessage', 'function ') + '\n'
      + fnSrc(HTML, '_rhErrMsg', 'function ')
      + `\nlet _reEditCtx = { phone8:'12345678', sheetId:'s', tabName:'t', gid:'', rowIndex:3 }; let _reEditTargetOldId = 'old'; let _reEditNewB64 = 'AAA';
      async function _reEditLoadFiles(){}\n` + fnSrc(HTML, '_reEditSubmit'), ctx);
    await vm.runInContext('_reEditSubmit()', ctx);
    assert.equal(toasts.length, 1, `${mode}: 같은 실패를 두 번 말하지 않는다 ${JSON.stringify(toasts)}`);
    assert.ok(/[가-힣]/.test(toasts[0]) && !/접수되었습니다/.test(toasts[0]) && !/^\[업로드도구\]/.test(toasts[0]), toasts[0]);
    assert.equal(els.reEditSubmitBtn.disabled, false, '버튼 다시 누를 수 있음');
  }
});
