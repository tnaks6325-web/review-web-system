/**
 * trackingColumnEdit.test.js — 작업보드 "택배송장" 열 편집 개방 회귀가드
 * 실행: node tests/trackingColumnEdit.test.js
 *
 * 사용자 확정(2026-08-19): 택배송장 열은 **업체(광고주)도 직접 입력**한다. AE(staff)는 담당 밖 탭도
 * 이미 편집할 수 있다(_ensureWorkdeskCellEditScope). 이 가드가 고정하는 것 셋:
 *  ① 열 판정 **단일 출처**(utils/trackingColumn) — 서버 사본 0, 화면 사본은 정규식 문자열 일치
 *  ② 광고주는 **송장 열만** · **자기 소유(브랜드 배정) 탭만** — 그 외는 403 이고 서비스 호출 0
 *  ③ 화면은 그 칸만 편집 셀로 그리고, 배경색·행 삭제처럼 서버가 광고주를 막는 기능은 열지 않는다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const workdesk = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 택배송장 열 편집 개방 회귀가드\n');

/* ── 1) 판정 단일 출처 ─────────────────────────────────────── */
console.log('1) 열 판정');
const tc = require('../src/utils/trackingColumn');
t('택배+송장 조합만 정확일치로 인정한다', () => {
  ['택배송장', '택배송장번호', ' 택배 송장 번호 ', '택배송장(롯데택배)'].forEach(h =>
    assert.ok(tc.isTrackingHeader(h), '인정해야 함: ' + h));
  ['배송비고', '송장', '택배사', '주소', '비고(송장확인)', ''].forEach(h =>
    assert.ok(!tc.isTrackingHeader(h), '넓히면 안 됨: ' + h));
});
t('편집 필드는 col:<헤더> 형태만 인정(물리필드·커스텀열 제외)', () => {
  assert.ok(tc.isTrackingField('col:택배송장번호'));
  assert.ok(!tc.isTrackingField('col:주소'));
  assert.ok(!tc.isTrackingField('ccol:택배송장'));
  assert.ok(!tc.isTrackingField('recipient_name'));
  assert.ok(!tc.isTrackingField(undefined));
});
t('★ 서버에 정규식 사본이 없다(광고주 화이트리스트·작업표 생성이 같은 util 을 쓴다)', () => {
  const svcSrc = R('src/services/trackB.service.js'), planSrc = R('src/utils/worktablePlan.js');
  const copy = /택배\\s\*송장/;   // 정규식 리터럴 사본의 지문
  assert.ok(!copy.test(svcSrc), 'trackB.service 에 택배송장 정규식 사본이 되살아났다');
  assert.ok(!copy.test(planSrc), 'worktablePlan 에 택배송장 정규식 사본이 되살아났다');
  assert.match(svcSrc, /require\('\.\.\/utils\/trackingColumn'\)/);
  assert.match(planSrc, /require\('\.\/trackingColumn'\)/);
});
t('★ 화면 정규식이 서버와 글자 그대로 같다(갈리면 "입력칸은 열리는데 403")', () => {
  const m = workdesk.match(/const _TRACKING_HEADER_RE=(\/.*\/);/);
  assert.ok(m, 'workdesk.html 에 _TRACKING_HEADER_RE 가 없다');
  assert.strictEqual(m[1], String(tc.TRACKING_HEADER_RE), '화면 사본이 서버 정규식과 다르다');
});

/* ── 2) 권한 게이트 — 라우트 실행 ──────────────────────────── */
console.log('\n2) 권한 게이트(라우트 실제 실행)');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const svc = require('../src/services/trackB.service');
const router = require('../src/routes/trackB.routes');

const handlerOf = (method, routePath) => {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, '라우트 없음: ' + method + ' ' + routePath);
  return layer.route.stack[layer.route.stack.length - 1].handle;   // 마지막 = 본문 핸들러
};
const editHandler = handlerOf('post', '/workdesk/edit');
const revertHandler = handlerOf('post', '/workdesk/revert');

async function call(handler, role, body, { canAccess = true, brandOk = true, brandId = null } = {}) {
  const calls = { edit: 0, revert: 0 };
  const origEdit = svc.editWorkdeskRow, origRevert = svc.revertWorkdeskEdit;
  const origAccess = svc.canAccessTab, origBrand = svc.brandTabAllowed;
  svc.editWorkdeskRow = async () => { calls.edit++; return { ok: true }; };
  svc.revertWorkdeskEdit = async () => { calls.revert++; return { ok: true }; };
  svc.canAccessTab = async () => canAccess;
  svc.brandTabAllowed = async () => brandOk;
  const res = { code: 200, body: null,
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  try {
    await handler({ admin: { role, name: 'tester', advertiser_id: 'adv1', brand_id: brandId }, body }, res, e => { throw e; });
  } finally {
    svc.editWorkdeskRow = origEdit; svc.revertWorkdeskEdit = origRevert;
    svc.canAccessTab = origAccess; svc.brandTabAllowed = origBrand;
  }
  return { res, calls };
}

const BODY = (field) => ({ sheetId: 's1', tabName: 't1', rowId: 'r1', field, value: '123456789' });

(async () => {
  let r = await call(editHandler, 'advertiser', BODY('col:택배송장번호'));
  t('광고주 + 송장 열 = 저장된다', () => {
    assert.strictEqual(r.res.code, 200); assert.strictEqual(r.calls.edit, 1);
  });

  r = await call(editHandler, 'advertiser', BODY('col:주소'));
  t('★ 광고주 + 다른 열 = 403 이고 서비스 호출 0(열람 전용 유지)', () => {
    assert.strictEqual(r.res.code, 403); assert.strictEqual(r.calls.edit, 0);
  });

  r = await call(editHandler, 'advertiser', BODY('is_paid'));
  t('★ 광고주 + 물리필드(입금 등) = 403', () => {
    assert.strictEqual(r.res.code, 403); assert.strictEqual(r.calls.edit, 0);
  });

  r = await call(editHandler, 'advertiser', BODY('col:택배송장번호'), { canAccess: false });
  t('★ 소유하지 않은 탭 = 403(남의 업체 작업 도달 불가)', () => {
    assert.strictEqual(r.res.code, 403); assert.strictEqual(r.calls.edit, 0);
  });

  r = await call(editHandler, 'advertiser', BODY('col:택배송장번호'), { brandOk: false, brandId: 'b1' });
  t('★ 브랜드 링크 세션은 미배정 탭 = 403', () => {
    assert.strictEqual(r.res.code, 403); assert.strictEqual(r.calls.edit, 0);
  });

  r = await call(editHandler, 'reviewer', BODY('col:택배송장번호'));
  t('★ 리뷰어 등 그 외 역할은 송장 열도 403', () => {
    assert.strictEqual(r.res.code, 403); assert.strictEqual(r.calls.edit, 0);
  });

  for (const role of ['master', 'admin', 'staff']) {
    r = await call(editHandler, role, BODY('col:주소'), { canAccess: false });
    t(`내부 역할(${role})은 담당 밖 탭·전 열 편집이 종전대로 유지된다`, () => {
      assert.strictEqual(r.res.code, 200); assert.strictEqual(r.calls.edit, 1);
    });
  }

  r = await call(revertHandler, 'advertiser', { sheetId: 's1', tabName: 't1', rowId: 'r1', field: 'col:택배송장번호' });
  t('되돌리기(↩)도 송장 열은 광고주에게 열린다', () => {
    assert.strictEqual(r.calls.revert, 1);
  });
  r = await call(revertHandler, 'advertiser', { sheetId: 's1', tabName: 't1', rowId: 'r1', field: 'col:연락처' });
  t('★ 되돌리기도 다른 열은 403(게이트가 한쪽만 열려 있지 않다)', () => {
    assert.strictEqual(r.res.code, 403); assert.strictEqual(r.calls.revert, 0);
  });

  /* ── 3) 서버 응답 재료 ───────────────────────────────────── */
  console.log('\n3) 광고주 응답 재료');
  const svcSrc = R('src/services/trackB.service.js');
  t('★ 광고주 행은 editable=false 를 유지하고 trackingEditable 로만 그 칸을 연다', () => {
    assert.match(svcSrc, /syn\.editable = false;[\s\S]{0,600}syn\.trackingEditable = !!anchor && !ambiguous;/);
  });
  t('★ 앵커 없음·중복(ambiguous) 줄은 광고주에게도 잠긴다', () => {
    assert.match(svcSrc, /trackingEditable = !!anchor && !ambiguous/);
  });
  t('광고주에게 실어 보내는 편집 오버레이는 송장 열뿐이다', () => {
    assert.match(svcSrc, /k\.indexOf\('col:'\) === 0 && isTrackingHeader\(k\.slice\(4\)\)/);
  });

  /* ── 4) 화면 ─────────────────────────────────────────────── */
  console.log('\n4) 화면 배선');
  t('★ 셀 편집 가능 판정은 행 단위가 아니라 칸 단위(canE || 송장)', () => {
    assert.match(workdesk, /const advTrackE = !canE && STATE\.role==='advertiser' && r\.trackingEditable===true;/);
    assert.match(workdesk, /const cellE = canE \|\| \(advTrackE && _isTrackingField\(field\)\);/);
    /* ★ 순서만 고정한다: locked → cellE → return cellE.
       고정 폭 창(`{0,120}`)으로 자르면 그 사이에 주석 한 줄만 들어와도 조용히 빨개진다
       (2026-08-23 리뷰제출 표기 보완에서 실제로 밟았다 — 검사 의미는 그대로다). */
    const iL = workdesk.indexOf('const locked=!!statusKind;');
    const iC = workdesk.indexOf('const cellE = canE ||', iL);
    const iR = workdesk.indexOf('return cellE', iC);
    assert.ok(iL > 0 && iC > iL && iR > iC, 'locked → cellE → return cellE 순서가 깨졌다');
  });
  t('붙여넣기 게이트가 _canEditCells 로 열린다(송장 열 일괄 입력)', () => {
    assert.ok(!/if\(!STATE\.canEdit \|\| !STATE\.gSelRange\) return;/.test(workdesk),
      '옛 게이트가 남아 있으면 업체는 송장을 붙여넣을 수 없다');
    assert.match(workdesk, /if\(!_canEditCells\(\) \|\| !STATE\.gSelRange\) return;/);
    assert.match(workdesk, /if\(!_canEditCells\(\)\)\{ toast\('열람 전용 계정입니다'\); return; \}/);
  });
  t('★ 배경색·행 삭제는 여전히 STATE.canEdit(서버가 광고주를 막는 기능 = 막다른 길 금지)', () => {
    assert.match(workdesk, /const canPaint = STATE\.canEdit;/);
    assert.match(workdesk, /\(canPaint\?`<div class="gcmdiv"><\/div><div class="gcmsw">/);
    assert.match(workdesk, /\(canPaint&&STATE\._gMenuRowId\?/);
  });
  t('업체 화면이 "송장 칸은 입력할 수 있다"를 말한다(조용한 개방 금지)', () => {
    assert.match(workdesk, /택배송장 칸은 입력할 수 있습니다/);
  });

  console.log(`\n✅ 통과 ${pass}건`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
