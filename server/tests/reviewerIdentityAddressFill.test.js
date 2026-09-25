'use strict';
/*
 * 참여 직전 빈 주소 한 번 받기 — 명의 카드 조각 5 (결정 기록 181)
 *   A. 배선: 서명 세션 경로 · 읽기 전 잠금 · 빈 칸만 채움 · 채웠을 때만 카드 맞추기
 *   (조각 5 최종 · 사용자 확정 2026-09-26) 참여 전에는 주소를 묻지 않는다. 구매양식에서 캡처로 읽은(또는 고친) 주소를
 *   [저장]으로 그 명의에 넣고, 저장하면 명의 확인을 다시 돌린다. 주소 고르기는 이 명의 주소만(1개 칩 · 2개 이상 드롭다운).
 *   B. 구매양식 화면(vm 실행): [저장] 노출 조건 · 참고 문구 · 고르는 주소 범위 · 칩/드롭다운 · 저장→재확인(고친 주소 보존) ·
 *      실패 시 재시도 · 제출 거절 시 재확인 · 참여 전 주소 칸 없음 · 참여 게이트는 주소 제외
 *   C. PGTEST_URL(전체 마이그레이션 적용 DB) 있으면 진짜 PG: 빈 주소만 채우고 이미 있는 주소는 덮지 않는다 · 카드가 즉시 맞춰진다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); assert.ok(i > 0 && j > i, `블록을 찾지 못했다: ${a}`); return s.slice(i, j); };

(async () => {
  console.log('A. 배선');
  const svc = read('src/services/reviewerOrderIdentity.service.js');
  const fn = between(svc, 'async function saveIdentityAddress', 'async function resolveApplicationIdentity');
  await test('서명된 리뷰어 세션으로만 부른다', async () => {
    const r = read('src/routes/reviewer.routes.js');
    assert.ok(/router\.patch\('\/profile\/identities\/:identityKey\/address', reviewerSessionMiddleware,/.test(r));
    assert.ok(/saveIdentityAddress\(\s*req\.reviewer\.ownerReviewerId/.test(r), '소유자는 요청 본문이 아니라 세션에서');
  });
  await test('읽기 전에 소유자 행을 잠근다', async () => {
    assert.ok(fn.indexOf('FOR NO KEY UPDATE') > 0 && fn.indexOf('FOR NO KEY UPDATE') < fn.indexOf('loadOwnerProfile(ownerReviewerId, client)'));
  });
  await test('빈 칸일 때만 쓴다(본계정 UPDATE 도 빈 칸 조건을 건다)', async () => {
    assert.ok(/UPDATE reviewers SET address = \$2 WHERE id = \$1 AND COALESCE\(address, ''\) ~ '\^\[\[:space:\]\]\*\$'/.test(fn));
    assert.ok(/filled = upd\.rowCount === 1;/.test(fn), '실제로 바뀐 행이 있을 때만 저장됐다고 답한다');
    assert.ok(/if \(!current\) \{\s*subs\[selected\.subIndex\]/.test(fn));
  });
  await test('채웠을 때 같은 트랜잭션에서 카드를 맞춘다', async () => {
    assert.ok(/if \(filled\) await syncCardsAfterWrite\(client, owner\.id/.test(fn));
    assert.ok(fn.indexOf('syncCardsAfterWrite') < fn.indexOf("'COMMIT'"));
  });

  await test('가려진(*) 주소는 서버가 저장을 거절한다', async () => {
    assert.ok(/ADDRESS_MASKED/.test(fn) && fn.indexOf('ADDRESS_MASKED') < fn.indexOf('pool.connect()'));
  });
  await test('참여·제출 게이트는 주소를 요구하지 않는다(주소만 빼고 이름·전화·계좌는 그대로)', async () => {
    const idSvc = require('../src/services/identity.service');
    assert.deepStrictEqual(idSvc.participationProfileMissing({}), ['사용자명', '전화번호', '계좌']);
    assert.deepStrictEqual(idSvc.profileMissing({}), ['사용자명', '전화번호', '주소', '계좌'], '내정보 표시용 4종은 그대로');
    const camp = fs.readFileSync(path.resolve(__dirname, '../src/routes/campaign.routes.js'), 'latin1');
    const sub = read('src/routes/submit.routes.js');
    const rev = read('src/routes/reviewer.routes.js');
    assert.ok(/participationProfileMissing\(reg\.rows\[0\]\)/.test(camp), '참여 신청');
    assert.ok(/participationProfileMissing\(_rv\)/.test(sub), '제출(옛 검사 경로)');
    assert.ok(/participationProfileMissing\(reviewer\)/.test(rev), '구매양식 안내 배너');
    for (const src of [camp, sub, rev]) assert.ok(!/[^n]profileMissing\((reg\.rows\[0\]|_rv|reviewer)\)/.test(src), '옛 4종 게이트가 남아 있지 않다');
  });

  console.log('B. 구매양식 화면(vm 실행)');
  const appJs = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');
  const campHtml = fs.readFileSync(path.resolve(__dirname, '../../frontend/campaign.html'), 'utf8');
  const block = between(appJs, '/* ═══ 조각 5: 배송주소', 'function _renderSavedBankAccountPicker() {');
  function fakeEl(id) {
    const cls = new Set(); const attrs = {}; const kids = {};
    const el = {
      id, value: '', hidden: false, disabled: false, textContent: '', style: {}, children: [],
      _html: '', className: '',
      get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); for (const k in kids) delete kids[k]; this.children = []; },
      classList: { add: (...a) => a.forEach((x) => cls.add(x)), remove: (...a) => a.forEach((x) => cls.delete(x)), toggle: (x, on) => (on ? cls.add(x) : cls.delete(x)), contains: (x) => cls.has(x) },
      setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k], removeAttribute: (k) => { delete attrs[k]; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(k, f) { this['on' + k] = f; },
      focus() {}, parentElement: null,
      querySelector(sel) {
        const key = sel.replace(/^\./, '');
        if (!this._html.includes(key === 'b' || key === 'span' ? '<' + key : key)) return null;
        return kids[sel] || (kids[sel] = fakeEl(id + ' ' + sel));
      },
    };
    return el;
  }
  function ui({ selected, suggestions = [], others = [], cardState = null, fetchImpl, matchImpl } = {}) {
    const els = {}; const get = (id) => els[id] || (els[id] = fakeEl(id));
    ['c_address', 'c_addrSave', 'c_addrSaveText', 'c_addrSaveBtn', 'c_addrHelp', 'c_addrChip', 'c_addrPick'].forEach(get);
    els.c_address.parentElement = { querySelector: () => null };
    const log = { toasts: [], calls: [], invalidated: 0, matched: 0, ctxLoads: 0, rendered: [] };
    const sb = {
      _activeIdentityContext: { selectedIdentity: selected, savedIdentities: [selected, ...others] },
      _orderInfoSuggestions: suggestions, _orderCardIds: ['c'], _cardAiState: { c: cardState || { analysisRequestId: 1 } },
      _identityContextPromise: 'cached', API_BASE_URL: 'http://x', _getAuthHeaders: () => ({ Authorization: 'Bearer t' }),
      _hasIdentityMask: (v) => /[*＊●○◯◉•·xX]/.test(String(v || '')),
      showToast: (m, e) => log.toasts.push([m, e]), _ofClearError: () => {}, _embedSaveForm: () => {}, _syncSubmissionIdentityAction: () => {},
      _invalidateIdentityApproval: () => { log.invalidated++; },
      _loadOrderIdentityContext: async () => { log.ctxLoads++; },
      _renderIdentityMatchState: (cid, st, r) => log.rendered.push(st),
      _matchCardIdentity: async (cid) => { log.matched++; if (matchImpl) matchImpl(sb, els); },
      fetch: async (url, opt) => { log.calls.push({ url, opt }); return fetchImpl(url, opt); },
      document: { getElementById: (id) => els[id] || null, createElement: () => fakeEl('opt'), addEventListener: (k, f) => { log['doc_' + k] = f; } },
    };
    sb.window = sb;
    vm.createContext(sb);
    vm.runInContext(block, sb);
    return { sb, els, log, sync: (fromInput) => vm.runInContext(`_syncAddressTools('c', ${!!fromInput})`, sb) };
  }
  const SUB = () => ({ identityKey: 'card:1', type: 'sub', name: '김민수', phone: '010-1234-5678', address: '' });
  const okRes = (body) => async () => ({ ok: true, status: 200, json: async () => Object.assign({ ok: true }, body) });
  const failRes = (status, body = {}) => async () => ({ ok: false, status, json: async () => Object.assign({ ok: false }, body) });

  await test('[저장]은 그 명의에 주소가 없을 때만 · 5자 미만·가린 주소는 누를 수 없다', async () => {
    const t = ui({ selected: SUB(), fetchImpl: okRes({}) });
    t.els.c_address.value = '서울 강남구 테헤란로 123'; t.sync(true);
    assert.strictEqual(t.els.c_addrSave.hidden, false);
    assert.strictEqual(t.els.c_addrSaveText.textContent, '이 주소를 김민수 명의 주소로');
    assert.strictEqual(t.els.c_addrSaveBtn.disabled, false);
    t.els.c_address.value = '서울 강남구 테헤란로 1**'; t.sync(true);
    assert.strictEqual(t.els.c_addrSaveBtn.disabled, true, '가린 주소');
    assert.ok(/고치면 저장할 수 있어요/.test(t.els.c_addrHelp.textContent) && t.els.c_addrHelp.classList.contains('is-warn'));
    t.els.c_address.value = '서울'; t.sync(true);
    assert.strictEqual(t.els.c_addrSaveBtn.disabled, true, '짧은 주소');
    const t2 = ui({ selected: { ...SUB(), address: '부산 해운대구 센텀로 45' }, fetchImpl: okRes({}) });
    t2.els.c_address.value = '서울 강남구 테헤란로 123'; t2.sync(true);
    assert.strictEqual(t2.els.c_addrSave.hidden, true, '이미 주소가 있으면 [저장]을 안 보인다(덮지 않음)');
  });
  await test('참고 문구는 배지가 아니라 일반 문구 — AI 추출 그대로 / 직접 수정', async () => {
    const t = ui({ selected: SUB(), fetchImpl: okRes({}) });
    vm.runInContext("_addrState('c').aiValue = '서울 강남구 테헤란로 123'", t.sb);
    t.els.c_address.value = '서울 강남구 테헤란로 123'; t.sync(false);
    assert.strictEqual(t.els.c_addrHelp.textContent, '* AI 자동추출 주소 · 오탈자는 직접 수정 가능');
    t.els.c_address.value = '서울 강남구 테헤란로 124'; t.sync(true);
    assert.strictEqual(t.els.c_addrHelp.textContent, '* 직접 수정한 주소');
    assert.ok(!/AI 자동입력/.test(appJs), '"AI 자동입력" 배지 문구가 남아 있지 않다');
  });
  await test('고르는 주소 = 이 명의 저장 주소 + 이 명의 지난 주문 주소(다른 명의 주소 X · 가린 주소 X · 최대 3개 · 저장 주소 먼저)', async () => {
    const t = ui({
      selected: { ...SUB(), address: '서울 강남구 테헤란로 123' },
      others: [{ identityKey: 'self', type: 'self', name: '본인', address: '서울 마포구 월드컵로 12' }],
      suggestions: [
        { address: '경기 성남시 분당구 판교역로 235', useCount: 2 }, { address: '서울 강남구 테헤란로 123', useCount: 4 },
        { address: '부산 *** 1**호', useCount: 9 }, { address: '대전 유성구 대학로 99', useCount: 1 }, { address: '광주 북구 용봉로 77', useCount: 1 },
      ],
      fetchImpl: okRes({}),
    });
    const list = vm.runInContext('_addressChoices()', t.sb).map((c) => [c.address, c.saved, c.uses]);
    assert.deepStrictEqual(list[0], ['서울 강남구 테헤란로 123', true, 4], '저장 주소 먼저 · 같은 주소는 합친다');
    assert.strictEqual(list.length, 3);
    assert.ok(!list.some(([a]) => /\*/.test(a)), '가린 주소 제외');
    assert.ok(!list.some(([a]) => a === '서울 마포구 월드컵로 12'), '다른 명의 주소는 섞지 않는다');
  });
  await test('1개 = 칸 위 칩 [적용] · 2개 이상 = 칸 아래 한 줄 드롭다운', async () => {
    const one = ui({ selected: { ...SUB(), address: '서울 강남구 테헤란로 123' }, fetchImpl: okRes({}) });
    one.sync(false);
    assert.strictEqual(one.els.c_addrChip.hidden, false); assert.strictEqual(one.els.c_addrPick.hidden, true);
    assert.ok(/_applyAddressChoice/.test(one.els.c_addrChip.innerHTML));
    const two = ui({ selected: { ...SUB(), address: '서울 강남구 테헤란로 123' }, suggestions: [{ address: '경기 성남시 분당구 판교역로 235', useCount: 2 }], fetchImpl: okRes({}) });
    two.sync(false);
    assert.strictEqual(two.els.c_addrChip.hidden, true); assert.strictEqual(two.els.c_addrPick.hidden, false);
    assert.ok(!/of-addr-pick-menu/.test(two.els.c_addrPick.innerHTML), '평소엔 접혀 있다(한 줄)');
    vm.runInContext("_toggleAddressPick('c')", two.sb);
    // 누른 버튼은 다시 그리면서 문서에서 떨어진다 — 그 클릭이 문서까지 올라와도 닫히면 안 된다(실측 버그)
    two.log.doc_click({ target: { isConnected: false, closest: () => null } });
    assert.ok(/of-addr-pick-menu/.test(two.els.c_addrPick.innerHTML), '누르면 펼쳐진다(누른 클릭이 바로 닫지 않는다)');
    two.log.doc_click({ target: { isConnected: true, closest: () => null } });
    assert.ok(!/of-addr-pick-menu/.test(two.els.c_addrPick.innerHTML), '바깥을 누르면 닫힌다');
    vm.runInContext("_toggleAddressPick('c')", two.sb);
    vm.runInContext("_applyAddressChoice('c', 1)", two.sb);
    assert.strictEqual(two.els.c_address.value, '경기 성남시 분당구 판교역로 235');
    assert.ok(!/of-addr-pick-menu/.test(two.els.c_addrPick.innerHTML), '고르면 닫힌다');
    assert.strictEqual(two.log.invalidated, 1, '칸 값이 바뀌면 기존 명의 승인을 무효로 한다');
    assert.strictEqual(two.sb._cardAiState.c.savedIdentitySelections.address, undefined, '지난 주문 주소는 저장정보 선택으로 기록하지 않는다');
    vm.runInContext("_applyAddressChoice('c', 0)", two.sb);
    assert.strictEqual(two.sb._cardAiState.c.savedIdentitySelections.address, 'card:1', '저장 주소를 고르면 저장정보 선택으로 기록');
  });
  await test('[저장] → 그 명의 주소로 저장 → "✓ 저장됨" → 명의 확인 다시 돌리기(고친 주소는 지킨다)', async () => {
    const sel = SUB();
    const st = { analysisRequestId: 7, extractToken: 'ex', proofExtracted: { address: '서울 강남구 테헤란로 12' }, extracted: { address: 'x' }, approvalToken: 'old', reviewToken: 'r' };
    const t = ui({ selected: sel, cardState: st, fetchImpl: okRes({ address: '서울 강남구 테헤란로 123', filled: true }),
      matchImpl: (sb, els) => { els.c_address.value = '서울 강남구 테헤란로 12'; sb._cardAiState.c.approvalToken = 'new'; } });
    t.els.c_address.value = '  서울 강남구   테헤란로 123 '; t.sync(true);
    await vm.runInContext("_saveCardAddress('c')", t.sb);
    assert.strictEqual(t.log.calls.length, 1);
    assert.ok(t.log.calls[0].url.endsWith('/api/reviewer/profile/identities/card%3A1/address'));
    assert.strictEqual(t.log.calls[0].opt.method, 'PATCH');
    assert.deepStrictEqual(JSON.parse(t.log.calls[0].opt.body), { address: '서울 강남구 테헤란로 123' });
    assert.strictEqual(sel.address, '서울 강남구 테헤란로 123', '화면이 기억하는 명의 주소도 바뀐다');
    assert.strictEqual(t.els.c_addrSaveBtn.innerHTML, '✓ 저장됨');
    assert.strictEqual(t.els.c_addrSaveText.textContent, '김민수 명의 주소로 저장됐어요');
    assert.ok(t.els.c_addrSave.classList.contains('is-done'));
    assert.strictEqual(t.log.ctxLoads, 1, '명의 정보를 새로 받는다');
    assert.strictEqual(t.sb._identityContextPromise, null);
    assert.strictEqual(t.log.matched, 1, '명의 확인을 다시 돌린다(1나)');
    assert.deepStrictEqual({ ...st.extracted }, { address: '서울 강남구 테헤란로 12' }, '같은 캡처의 원본 추출값으로 대조');
    assert.strictEqual(t.els.c_address.value, '  서울 강남구   테헤란로 123 ', '대조가 칸을 캡처 값으로 되돌려도 저장한 값을 지킨다');
    assert.strictEqual(t.log.invalidated, 1, '되살린 값은 다시 확인받는다');
  });
  await test('캡처 전 [저장]은 명의 정보만 새로 받고 대조하지 않는다 · 실패는 다시 누를 수 있다', async () => {
    const t = ui({ selected: SUB(), fetchImpl: okRes({ address: '서울 강남구 테헤란로 123', filled: true }) });
    t.els.c_address.value = '서울 강남구 테헤란로 123'; t.sync(true);
    await vm.runInContext("_saveCardAddress('c')", t.sb);
    assert.deepStrictEqual([t.log.ctxLoads, t.log.matched], [1, 0]);
    for (const impl of [failRes(404), failRes(500), async () => { throw new Error('net'); }]) {
      const f = ui({ selected: SUB(), fetchImpl: impl });
      f.els.c_address.value = '서울 강남구 테헤란로 123'; f.sync(true);
      await vm.runInContext("_saveCardAddress('c')", f.sb);
      assert.strictEqual(f.els.c_addrSaveBtn.disabled, false, '다시 누를 수 있다');
      assert.strictEqual(f.els.c_addrSaveBtn.innerHTML, '저장');
      assert.ok(f.log.toasts.some(([, e]) => e === 'error'), '실패를 오류 모양으로 알린다(구매양식 showToast(msg, type) — true 는 안내 모양이 된다)');
      assert.strictEqual(f.log.matched, 0);
    }
  });
  await test('제출이 "저장 정보 변경"으로 거절되면 같은 토큰으로 재제출하지 않고 명의 확인을 다시 돌린다', async () => {
    assert.ok(/res\.code === "IDENTITY_APPROVAL_STALE" \|\| res\.code === "IDENTITY_CONTEXT_CHANGED"\)\) \{[\s\S]{0,240}_recheckCardIdentity\(o\.cid\)/.test(appJs));
  });
  await test('주소 칸: 칩은 위 · 참고 문구·드롭다운·[저장]은 아래 · 칸을 고치면 다시 그린다', async () => {
    assert.ok(/\$\{_addressChipMarkup\(cid\)\}\s*<div class="of-input-status-wrap">\s*<textarea id="\$\{cid\}_address"[^>]*_syncAddressTools\('\$\{cid\}',true\)"><\/textarea>\s*<\/div>\s*\$\{_addressToolsMarkup\(cid\)\}/.test(appJs));
    assert.ok(/else if \(field === "address"\) el\.oninput = \(\) => \{[\s\S]{0,160}_syncAddressTools\(cid, true\)/.test(appJs), '저장정보 적용 뒤 입력 핸들러도 다시 그린다');
  });
  await test('참여 전에는 주소를 묻지 않는다(명의 선택 창에 주소 칸 없음)', async () => {
    assert.ok(!/\/address'|_acctNeedAddr|acctAddrIn|주소 필요/.test(campHtml));
  });
  await test('"내 정보를 먼저 등록" 목록에 빈 주소가 ✓(등록됨)로 보이지 않는다 — 서버가 요구할 때만 주소를 보여 준다', async () => {
    const fnSrc = between(campHtml, 'function renderMissing(missing){', '\n}\n');
    const els = { missTtl: {}, missList: {} };
    const sb = { $: (id) => els[id], holdTtlText: () => '30분', show: () => {} };
    vm.createContext(sb); vm.runInContext(fnSrc + '\n}', sb);
    sb.renderMissing(['계좌']);
    assert.ok(!/주소/.test(els.missList.innerHTML), '주소는 참여 조건이 아니다');
    assert.ok(/✗ 계좌/.test(els.missList.innerHTML) && /✓ 사용자명/.test(els.missList.innerHTML));
    sb.renderMissing(['주소']);
    assert.ok(/✗ 주소/.test(els.missList.innerHTML), '서버가 주소를 요구하면 ✗ 로 보인다(옛 서버)');
  });

  if (!process.env.PGTEST_URL) {
    console.log(`\n✅ reviewerIdentityAddressFill: ${passed}개 통과 (PGTEST_URL 없음 — 진짜 PG 단계 생략)`);
    process.exit(0);
  }

  console.log('C. 진짜 PG (전체 마이그레이션 적용 DB)');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.PGTEST_URL });
  const has = (await db.query(`SELECT to_regclass('public.reviewer_identity_cards') c`)).rows[0];
  if (!has.c) {
    console.log('  (전체 마이그레이션이 적용된 DB 가 아니라 C 단계 생략)');
    await db.end();
    console.log(`\n✅ reviewerIdentityAddressFill: ${passed}개 통과`);
    process.exit(0);
  }
  const cards = require('../src/services/reviewerIdentityCards.service');
  const roi = require('../src/services/reviewerOrderIdentity.service');
  const pool = require('../src/db/pool');
  const RID = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5';
  const cleanup = () => db.query('DELETE FROM reviewers WHERE id = $1', [RID]);
  await cleanup();
  const subs = [{ name: '김민수', phone: '010-5151-5678', address: '' }, { name: '이영희', phone: '010-5151-2222', address: '부산 해운대구 센텀로 45' }];
  await db.query(`INSERT INTO reviewers (id, name, phone, address, sub_accounts) VALUES ($1, '주소테스트', '010-5151-1111', '', $2::jsonb)`, [RID, JSON.stringify(subs)]);
  await cards.reconcileCards({ db, dryRun: false, by: 'test' });
  const keyOf = async (name) => (await roi.loadOwnerProfile(RID, db)).identities.find((i) => i.name === name).identityKey;
  const cardAddr = async (name) => (await db.query(`SELECT address FROM reviewer_identity_cards WHERE owner_reviewer_id = $1 AND name = $2 AND status = 'active'`, [RID, name])).rows[0].address;
  try {
    await test('타계정 빈 주소를 채우고 카드도 즉시 맞춘다', async () => {
      const out = await roi.saveIdentityAddress(RID, await keyOf('김민수'), '서울 강남구 테헤란로 123');
      assert.deepStrictEqual([out.filled, out.address], [true, '서울 강남구 테헤란로 123']);
      const row = (await db.query('SELECT sub_accounts FROM reviewers WHERE id = $1', [RID])).rows[0];
      assert.strictEqual(row.sub_accounts[0].address, '서울 강남구 테헤란로 123');
      assert.strictEqual(row.sub_accounts[1].address, '부산 해운대구 센텀로 45', '다른 칸은 그대로');
      assert.strictEqual(await cardAddr('김민수'), '서울 강남구 테헤란로 123');
    });
    await test('이미 있는 주소는 덮지 않는다(타계정·본계정)', async () => {
      const again = await roi.saveIdentityAddress(RID, await keyOf('김민수'), '다른 주소 999번지');
      assert.deepStrictEqual([again.filled, again.address], [false, '서울 강남구 테헤란로 123']);
      const lee = await roi.saveIdentityAddress(RID, await keyOf('이영희'), '다른 주소 999번지');
      assert.strictEqual(lee.filled, false);
      await db.query("UPDATE reviewers SET address = E'\\t\\n ' WHERE id = $1", [RID]);   // 탭·줄바꿈만 든 옛 주소 = 빈 칸
      const self1 = await roi.saveIdentityAddress(RID, 'self', '서울 마포구 월드컵로 12');
      assert.strictEqual(self1.filled, true);
      const self2 = await roi.saveIdentityAddress(RID, 'self', '다른 주소 999번지');
      assert.deepStrictEqual([self2.filled, self2.address], [false, '서울 마포구 월드컵로 12']);
      const row = (await db.query('SELECT address, sub_accounts FROM reviewers WHERE id = $1', [RID])).rows[0];
      assert.strictEqual(row.address, '서울 마포구 월드컵로 12');
      assert.strictEqual(row.sub_accounts[1].address, '부산 해운대구 센텀로 45');
    });
    await test('모르는 명의·너무 짧은 주소·가린 주소는 거절(아무것도 쓰지 않는다)', async () => {
      await assert.rejects(() => roi.saveIdentityAddress(RID, 'card:없음', '서울 강남구 테헤란로 1'), (e) => e.code === 'IDENTITY_NOT_FOUND' && e.status === 404);
      await assert.rejects(() => roi.saveIdentityAddress(RID, 'self', '서울'), (e) => e.code === 'ADDRESS_INVALID' && e.status === 400);
      const kimKey = await keyOf('김민수');
      await assert.rejects(() => roi.saveIdentityAddress(RID, kimKey, '서울 강남구 테헤란로 1**'), (e) => e.code === 'ADDRESS_MASKED' && e.status === 400);
    });
  } finally {
    await cleanup();
    await db.end();
    await pool.end().catch(() => {});
  }
  console.log(`\n✅ reviewerIdentityAddressFill: ${passed}개 통과 (진짜 PG 포함)`);
  process.exit(0);
})().catch((err) => { console.error('❌', err.stack || err.message); process.exit(1); });
