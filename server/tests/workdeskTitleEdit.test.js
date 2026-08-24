/**
 * 작업보드 제목 편집 — 탭 식별키(tab_name)를 바꾸지 않고 display_name만 바꾼다.
 * 실행: node tests/workdeskTitleEdit.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/trackB.service');

const ROOT = path.join(__dirname, '..', '..');
const routes = fs.readFileSync(path.join(ROOT, 'server/src/routes/trackB.routes.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(ROOT, 'frontend/workdesk.html'), 'utf8');

function routeBody(routePath) {
  const start = routes.indexOf(`router.post('${routePath}'`);
  assert.ok(start >= 0, `${routePath} 라우트가 있어야 합니다.`);
  const end = routes.indexOf('\nrouter.', start + 1);
  return routes.slice(start, end < 0 ? routes.length : end);
}

(async () => {
  const calls = [];
  svc.__setPoolForTest({
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ displayName: params[2] }], rowCount: 1 };
    },
  });

  try {
    const out = await svc.setWorkdeskTitle({ sheetId: 'S1', tabName: '원본 탭명', displayName: '  새 작업명  ', by: '만두' });
    assert.deepStrictEqual(out, { ok: true, displayName: '새 작업명', cleaned: true },
      '공백을 정리한 표시명을 돌려주고, 값이 달라졌음을 화면에 알려야 합니다.');
    assert.match(calls[0].sql, /INSERT\s+INTO\s+tab_configs[\s\S]*display_name/i,
      '표시명은 tab_configs에 저장해야 합니다.');
    assert.match(calls[0].sql, /ON\s+CONFLICT\s*\(sheet_id,\s*tab_name\)\s+DO\s+UPDATE\s+SET[\s\S]*display_name\s*=\s*EXCLUDED\.display_name/i,
      '탭 식별키가 아니라 display_name만 갱신해야 합니다.');
    assert.doesNotMatch(calls[0].sql, /SET\s+tab_name\s*=/i, 'tab_name 변경은 연결 데이터를 끊으므로 금지합니다.');
    assert.deepStrictEqual(calls[0].params, ['S1', '원본 탭명', '새 작업명'], 'SQL 값은 매개변수로 전달해야 합니다.');
    await assert.rejects(
      () => svc.setWorkdeskTitle({ sheetId: 'S1', tabName: 'T1', displayName: '   ' }),
      /작업명/, '빈 작업명은 저장하면 안 됩니다.'
    );

    /* ── 저장 시점 자동 정리 (2026-08-24 실사고: 이름 안에 탭 문자가 박혔다) ──
       ★ 지우는 것은 보이지 않는 문자와 공백뿐 — 글자·기호는 사람 몫이다. */
    calls.length = 0;
    const dirty = await svc.setWorkdeskTitle({
      sheetId: 'S1', tabName: 'T1', displayName: '0_쟈니베어_쿠팡_온열안대_500건\t—' });
    assert.strictEqual(dirty.displayName, '0_쟈니베어_쿠팡_온열안대_500건 —',
      '탭 문자는 공백으로 바뀌어야 합니다(지우면 앞뒤 글자가 붙는다).');
    assert.strictEqual(calls[0].params[2], dirty.displayName, '정리한 값이 DB 로 가야 합니다.');
    assert.strictEqual(dirty.cleaned, true, '정리했음을 화면이 말할 수 있어야 합니다.');

    calls.length = 0;
    const clean = await svc.setWorkdeskTitle({ sheetId: 'S1', tabName: 'T1', displayName: '정상 작업명' });
    assert.strictEqual(clean.cleaned, false, '멀쩡한 값은 정리했다고 말하지 않아야 합니다.');

    await assert.rejects(
      () => svc.setWorkdeskTitle({ sheetId: 'S1', tabName: 'T1', displayName: '\t\u200b\u00a0' }),
      /작업명/, '보이지 않는 문자만 있는 입력은 이름이 아니므로 거부해야 합니다.'
    );
  } finally {
    svc.__setPoolForTest(null);
  }

  const titleRoute = routeBody('/workdesk/title');
  assert.match(titleRoute, /const title = String\(displayName == null \? '' : displayName\)\.trim\(\);/,
    'HTTP 경계에서 작업명을 문자열·공백 제거로 정규화해야 합니다.');
  assert.match(titleRoute, /if \(!title \|\| title\.length > 120\) return res\.status\(400\)/,
    '빈 값·과도하게 긴 작업명은 DB 전에 차단해야 합니다.');
  assert.match(titleRoute, /_ensureWorkdeskCellEditScope\(req\)/,
    '내부 직원만 제목을 편집할 수 있어야 합니다.');
  assert.match(titleRoute, /svc\.setWorkdeskTitle\(/, '저장은 서비스 단일 경로를 써야 합니다.');
  assert.match(workdesk, /function editWorkdeskTitle\(/, '작업보드 제목 편집 함수가 있어야 합니다.');
  assert.match(workdesk, /\/api\/trackb\/workdesk\/title/, '제목 저장 API를 호출해야 합니다.');
  assert.match(workdesk, /m\.displayName\|\|STATE\.cur\.displayName\|\|STATE\.cur\.tabName/,
    '표시명이 있으면 작업보드 제목에 우선 표시해야 합니다.');

  /* ── 정리 규칙(순수함수) — 무엇을 지우고 무엇을 남기는가 ── */
  const nz = svc.normalizeDisplayName;
  assert.strictEqual(typeof nz, 'function', '정리 함수는 단일 출처로 노출돼야 합니다(가드가 직접 돌린다).');
  assert.strictEqual(nz('줄\n바꿈'), '줄 바꿈', '개행도 공백으로.');
  assert.strictEqual(nz('연속   공백'), '연속 공백', '연속 공백은 하나로.');
  assert.strictEqual(nz('제로폭\u200b문자'), '제로폭문자', '폭 없는 문자는 지운다(공백으로 바꾸면 없던 띄어쓰기가 생긴다).');
  assert.strictEqual(nz('NBSP\u00a0전각\u3000공백'), 'NBSP 전각 공백', '유니코드 공백류도 일반 공백으로.');
  assert.strictEqual(nz('  앞뒤  '), '앞뒤', '앞뒤 공백 제거.');
  // ★★ 완화 금지 — 내용 판단은 사람 몫이다(대시·기호를 군더더기로 지우지 않는다)
  assert.strictEqual(nz('7/6 스팟리무버 — 쿠팡'), '7/6 스팟리무버 — 쿠팡', '글자·기호는 건드리지 않는다.');
  assert.strictEqual(nz(null), '', 'null 도 터지지 않는다.');

  /* ── 인라인 편집(사용자 확정 2026-08-24) — prompt 창구 폐지 ── */
  assert.doesNotMatch(workdesk, /prompt\(\s*'작업명/, '★ 작업명 편집은 브라우저 prompt 창을 쓰지 않는다(인라인으로 대체).');
  assert.match(workdesk, /wrap\.innerHTML='<input class="mh-title-in"/,
    '제목 자리를 input 으로 갈아끼워야 합니다.');
  // ★ 함수 본문으로 잘라서 본다 — 파일 전체를 훑으면 다른 핸들러의 'Escape' 가 대신 통과시킨다
  //   (변이시험이 실제로 뚫었다: Esc 분기를 없애도 초록이었다).
  const keyFn = workdesk.slice(workdesk.indexOf('function _wtTitleKey(ev){'),
    workdesk.indexOf('async function saveWorkdeskTitle('));
  assert.match(keyFn, /Enter/, 'Enter 로 저장.');
  assert.match(keyFn, /Escape/, 'Esc 로 취소 (업체관리 비고 편집과 같은 관용구).');
  assert.match(keyFn, /dataset\.esc='1'/, 'Esc 는 취소 표식을 남겨 저장을 건너뛴다.');
  assert.match(workdesk, /onblur="saveWorkdeskTitle\(this\)"/, '포커스가 빠지면 저장.');
  // ★ 저장 실패 시 입력 내용을 지우지 않는다 — 다시 쳐야 하면 그건 막다른 길이다
  const saveFn = workdesk.slice(workdesk.indexOf('async function saveWorkdeskTitle('),
    workdesk.indexOf('function _tcell('));
  assert.match(saveFn, /delete inp\.dataset\.busy; inp\.disabled=false; inp\.focus\(\);/,
    '★ 저장 실패 시 입력 내용을 유지하고 포커스를 돌려줘야 합니다.');
  assert.match(saveFn, /if\(displayName===orig\)\{ restore\(\); return; \}/,
    '★ 같은 값이면 요청하지 않는다(헛된 왕복·"저장됨" 오해 방지).');
  assert.match(saveFn, /if\(inp\.dataset\.busy\) return;/, '★ 저장 중 blur 재진입을 막아야 합니다.');
  assert.match(saveFn, /j\.cleaned \?/, '★ 서버가 정리했으면 화면이 말해야 합니다(조용한 자동수정 금지).');
  // ★ 편집 중에는 머리를 다시 그리지 않는다(IME 조합 파괴) — 재렌더는 성공 경로에만
  const editFn = workdesk.slice(workdesk.indexOf('function editWorkdeskTitle()'),
    workdesk.indexOf('function _wtTitleKey('));
  assert.doesNotMatch(editFn, /renderWorkdesk\(/, '★ 편집을 여는 함수는 전체 재렌더를 하지 않는다.');
  assert.match(workdesk, /\.mh-title-in\{font-size:19px;font-weight:800/,
    '★ 입력칸은 제목과 같은 글자 크기·굵기여야 합니다(열 때 글자가 튀지 않게).');

  console.log('✅ workdeskTitleEdit: 작업명 표시·저장·정리·인라인 편집 회귀 가드 통과');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
