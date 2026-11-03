'use strict';
/**
 * 결정 328 — 직원이 직접 섭외한 블로거를 공고·승인 없이 넣기 (2026-11-03).
 *
 *   ① 사전등록 줄은 칸(reviewer_name·phone8)까지 채운다 — row_json 에만 두면 빈 줄 판정(openSlotRowSql)이 빈 줄로 봐
 *      그 블로거의 구매양식이 맨 위 빈 줄로 가고 본인 줄은 주문 없이 남았다(로컬 실제 제출 경로로 재현).
 *   ② 주문은 등록 줄로 — 줄 번호 원장 경로(submit.routes → createOrderLedgerEntry slotRowNumber)와
 *      큐 반영 경로(sheetlessOrder.writeOrderToWorktable) 두 곳 모두. 판정은 blogRegister.preRegisteredSeq 한 곳.
 *   ③ 여러 명 붙여넣기 라우트(add-bloggers) · 화면 파서(_brParse) · 안내문 복사.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SUBMIT = read('src/routes/submit.routes.js');
const WRITER = read('src/services/sheetlessOrder.service.js');
const ROUTES = read('src/routes/trackB.routes.js');
const PARTS = read('src/services/participants.service.js');
const HTML = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'workdesk.html'), 'utf8');
const svc = require('../src/services/blogRegister.service');

test('① fillPreparedRow — 빈 줄 조건(openSlotRowSql)으로 다시 확인하며 이름·연락처 칸까지 쓴다', async () => {
  const m = /async function fillPreparedRow\(client, \{[\s\S]*?\n\}/.exec(PARTS);
  assert.ok(m, 'fillPreparedRow 정의');
  assert.match(m[0], /SET reviewer_name = \$4, recipient_name = \$4, phone8 = \$5/);
  assert.match(m[0], /openSlotRowSql\('cp', \{ sheet: '\$1', tab: '\$2', workboard: 'NULL' \}\)/);
  assert.match(m[0], /return rowCount === 1;/, '0행(그 사이 주문이 들어옴) = false — 덮지 않는다');
  const { fillPreparedRow } = require('../src/services/participants.service');
  const calls = [];
  const ok = await fillPreparedRow({ query: async (sql, p) => { calls.push({ sql, p }); return { rowCount: 1 }; } },
    { sheetId: 'S', tabName: 'T', seq: 3, name: '홍길동', phone8: '12345678', rowPatch: { 수취인: '홍길동' } });
  assert.equal(ok, true);
  assert.deepEqual(calls[0].p.slice(0, 5), ['S', 'T', 3, '홍길동', '12345678']);
});

function stubQ({ kind = 'blog', seq = 6, fail = false } = {}) {
  const seen = [];
  return {
    seen,
    query: async (sql, p) => {
      seen.push(String(sql));
      if (fail) throw new Error('boom');
      if (/FROM tab_configs/.test(sql)) return { rows: [{ work_kind: kind }] };
      if (/FROM campaign_participants/.test(sql)) return { rows: seq ? [{ seq }] : [] };
      return { rows: [] };
    },
  };
}

test('② preRegisteredSeq — 블로그 작업·같은 연락처·주문 없는 줄만 · 실패는 null(종전 경로)', async () => {
  const wkc = require('../src/services/workKindContext.service');
  const orig = wkc.workKindForTab;
  wkc.workKindForTab = async () => null;
  try {
    const q = stubQ();
    assert.equal(await svc.preRegisteredSeq(q, { sheetId: 'S', tabName: 'T', phone8: '010-3333-4444' }), 6);
    const sql = q.seen.find(s => /FROM campaign_participants/.test(s));
    assert.match(sql, /order_submission_id IS NULL AND phone8 = \$3/);
    assert.match(sql, /active = TRUE/);
    assert.equal(await svc.preRegisteredSeq(stubQ({ kind: 'review' }), { sheetId: 'S', tabName: 'T', phone8: '01033334444' }), null,
      '★ 리뷰 작업의 줄 고르기는 종전 그대로');
    assert.equal(await svc.preRegisteredSeq(stubQ({ fail: true }), { sheetId: 'S', tabName: 'T', phone8: '01033334444' }), null,
      '판정 실패 = null(주문을 막지 않는다)');
    assert.equal(await svc.preRegisteredSeq(stubQ(), { sheetId: 'S', tabName: 'T', phone8: '1234' }), null, '연락처 8자리 아님 = null');
    const lq = stubQ();
    await svc.preRegisteredSeq(lq, { sheetId: 'S', tabName: 'T', phone8: '01033334444', lock: true });
    assert.match(lq.seen.find(s => /FROM campaign_participants/.test(s)), /FOR UPDATE$/);
    wkc.workKindForTab = async () => 'blog';
    assert.equal(await svc.preRegisteredSeq(stubQ({ kind: '' }), { sheetId: 'S', tabName: 'T', phone8: '01033334444' }), 6,
      '종류 판정은 공고 > 탭');
  } finally { wkc.workKindForTab = orig; }
});

test('② 줄 번호 원장 경로 — 홀드·큐·줄 번호가 없는 리뷰어 제출만 등록 줄을 찾고, 그 번호를 원장에 넘긴다', () => {
  assert.match(SUBMIT, /let ledgerSlotRow = slotRowNumber \|\| null;\n\s*if \(!ledgerSlotRow && !holdCtx && !queuedWorkboardApply && _idPhone8\.length === 8\) \{/);
  assert.match(SUBMIT, /\.preRegisteredSeq\(pool, \{ sheetId: orderScope\.sheetId, tabName: orderScope\.tabName, phone8: _idPhone8 \}\)/);
  assert.match(SUBMIT, /slotRowNumber: ledgerSlotRow,\n/);
  assert.ok(SUBMIT.indexOf('let ledgerSlotRow') < SUBMIT.indexOf('const ledger = await createOrderLedgerEntry('), '원장 만들기 전에 정한다');
});

test('② 큐 반영 경로 — 빈 줄 고르기 앞에서, SAVEPOINT 안에서, 옵션이 맞을 때만 등록 줄을 쓴다', () => {
  const i = WRITER.indexOf("await client.query('SAVEPOINT blog_prereg');");
  const pick = WRITER.indexOf('const picked = await _pickOpenSlot(client, {');
  assert.ok(i > 0 && pick > i, '빈 줄 고르기보다 앞');
  assert.ok(WRITER.indexOf('isQnaTab(client, sheetId, tabName)') < i, 'Q&A 자리 번호 규칙 뒤(Q&A 는 그대로)');
  const block = WRITER.slice(i, pick);
  assert.match(block, /preRegisteredSeq\(client, \{\s*sheetId, tabName, phone8: loginPhone8, workboardId, lock: true \}\)/);
  assert.match(block, /RELEASE SAVEPOINT blog_prereg/);
  assert.match(block, /ROLLBACK TO SAVEPOINT blog_prereg/, '판정 실패가 주문 기록 트랜잭션을 망가뜨리지 않는다');
  assert.match(block, /_stagedLabelMatches\(preOpt, scheduledOptionKey\)/, '옵션 불일치면 쓰지 않는다(옵션 불일치 거절로 주문이 멈추지 않게)');
  assert.ok((WRITER.match(/openSlotRowSql\(/g) || []).length >= 3, '빈 줄 판정 공용 함수 사용처 유지');
});

test('③ 여러 명 라우트 — 편집 스코프 → 서비스, 거부는 400', () => {
  const i = ROUTES.indexOf("router.post('/worktable/add-bloggers', authMiddleware, async");
  assert.ok(i > 0);
  const body = ROUTES.slice(i, ROUTES.indexOf('\nrouter.', i + 10));
  assert.ok(body.indexOf('_ensureEditScope(req, sheetId, tabName)') < body.indexOf('registerBloggers('));
  assert.match(body, /BlogRegisterError\) return res\.status\(400\)/);
  assert.match(body, /dryRun: b\.dryRun === true/);
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'x';
  const router = require('../src/routes/trackB.routes');
  assert.ok((router.stack || []).some(l => l.route && l.route.path === '/worktable/add-bloggers' && l.route.methods.post));
});

test('③ 화면 파서 — 이름·연락처·주소 순서·구분자 무관, 빈 줄 무시', () => {
  const m = HTML.match(/function _brParse\(text\)\{[\s\S]*?\n\}/);
  assert.ok(m, '_brParse 추출');
  const sb = {}; vm.createContext(sb); vm.runInContext(m[0], sb);
  const r = sb._brParse('홍길동 010-1234-5678 https://blog.naver.com/hong\n\n https://blog.naver.com/kim, 김블로, 01098765432\n박\t010 5555 7777\thttps://m.blog.naver.com/park/1');
  assert.equal(r.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(r[0])), { name: '홍길동', phone: '010-1234-5678', blogUrl: 'https://blog.naver.com/hong' });
  assert.deepEqual(JSON.parse(JSON.stringify(r[1])), { name: '김블로', phone: '01098765432', blogUrl: 'https://blog.naver.com/kim' });
  assert.equal(r[2].name, '박'); assert.equal(r[2].phone, '010 5555 7777');
});

test('③ 화면 — 미리보기(dryRun) 뒤에만 넣고, 넣은 뒤 구매양식 링크가 담긴 안내문을 준다', () => {
  assert.match(HTML, /async function brPreview\(\)\{[\s\S]{0,600}_brCall\(true\)/);
  assert.match(HTML, /async function brSubmit\(\)\{\n\s*if \(!_BR \|\| _BR\.busy \|\| _BR\.step !== 'preview'\) return;/);
  assert.match(HTML, /\/api\/trackb\/worktable\/add-bloggers/);
  assert.match(HTML, /api\('\/api\/trackb\/form-link'[\s\S]{0,200}API_BASE \+ '\/r\/' \+ encodeURIComponent\(r\.code\)/, '링크 = [구매양식 링크]와 같은 주소');
  assert.match(HTML, /function _brGuide\(\)\{[\s\S]{0,400}휴대폰 번호로 가입해야/, '안내문에 "그 번호로 가입" — 다른 번호면 본인 줄에 안 붙는다');
});
