/**
 * worktableTemplateSaveGuard.test.js — 작업표 표준 열 **저장 안전장치 3종** 회귀가드.
 *
 * 왜: 8/23 에 이 설정이 통째로 비워져 작업표를 아무것도 못 만드는 상태가 됐다. 원인은
 * `saveTemplate` 이 `_emptyTemplate()` 에서 시작하는 **전체 교체**인데 막는 장치가 하나도
 * 없던 것 — `core` 를 뺀 POST 한 번이 공통 열·채널 열·작업유형·템플릿 시트를 함께 지웠다.
 *
 * 고정하는 것:
 *  ① **빈 저장 차단** — 저장된 공통 열이 있는데 0열로 저장하면 거부(쓰기 0건).
 *     `confirmClear:true` 일 때만 통과.
 *  ② **부분 저장** — `undefined` 인 항목은 기존 값 유지. 빈 배열 `[]` 은 "비우기"로 반영(구분).
 *  ③ **되돌리기** — 저장 직전 값이 `history` 에 쌓이고, 그 시각으로 복구된다.
 *     같은 값 반복 저장은 이력을 밀지 않는다.
 *  ④ **직전 값을 못 읽으면 저장하지 않는다**(fail-closed) — 모르는 채로 전체 교체 금지.
 *  ⑤ 거부는 **라우트가 400 으로 명시** — 이 경로는 오류 마스킹 예외가 아니라, 그냥 throw 하면
 *     `서버 오류가 발생했습니다.` 로 뭉개져 담당자가 무엇을 고칠지 모른다.
 *
 * 실행: node tests/worktableTemplateSaveGuard.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const routes = read('src/routes/trackB.routes.js');
const errMw = read('src/middleware/error.middleware.js');
const setJs = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'admin-settings.js'), 'utf8');

/* 스텁 pool — 서비스를 **실제로 실행**한다(정적 검사만으로는 `if(false&&…)` 를 통과시킨다). */
const _poolPath = require.resolve('../src/db/pool');
let _calls = [];
let _stored = null;      // app_settings 에 저장된 JSON 문자열(=한 행)
let _readFails = false;
require.cache[_poolPath] = {
  id: _poolPath, filename: _poolPath, loaded: true,
  exports: {
    query: async (sql, params) => {
      _calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) {
        if (_readFails) throw new Error('boom');
        return { rows: _stored == null ? [] : [{ value: _stored }] };
      }
      if (/^\s*INSERT INTO app_settings/i.test(sql)) { _stored = params[1]; return { rows: [] }; }
      return { rows: [] };
    },
  },
};

const svc = require('../src/services/worktable.service');

let passed = 0;
const ok = (name, cond, extra) => {
  assert(cond, name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  passed++; console.log('  ✓ ' + name);
};
const writes = () => _calls.filter(c => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.sql.trim()));
const reset = () => { _calls = []; };
const saved = () => JSON.parse(_stored);
function routeBody(src, decl) {
  const i = src.indexOf(decl);
  assert(i > -1, '라우트를 찾지 못함: ' + decl);
  const j = src.indexOf('\nrouter.', i + 10);
  return src.slice(i, j > i ? j : src.length);
}
/* 함수 본문만 잘라 본다 — ★ 고정 폭 창(`{0,900}`)으로 자르면 **다음 함수의 코드가 대신
   통과**시킨다(이 가드를 만들 때 실제로 밟았다: 로더의 호출을 지워도 바로 아래
   `_wtRenderHistory` 정의가 창 안에 들어와 초록이었다). */
function fnBody(src, decl) {
  const i = src.indexOf(decl);
  assert(i > -1, '함수를 찾지 못함: ' + decl);
  const rest = src.slice(i + decl.length);
  const m = /\n(?:async )?function /.exec(rest);
  return rest.slice(0, m ? m.index : rest.length);
}
async function refuse(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

(async () => {

// ── A. ② 부분 저장 ─────────────────────────────────────────────
console.log('\n[A] ② 부분 저장 — undefined 는 "변경 없음"');
_stored = null;
await svc.saveTemplate({
  core: ['번호', '수취인'], channels: { coupang: ['쿠팡ID'] },
  workTypes: [{ key: 't1', label: '상품옵션', columns: ['옵션'] }],
  templateSheetId: '1aaaaaaaaaaaaaaaaaaaaaaa', by: '만두',
});
ok('첫 저장이 그대로 들어간다', saved().core.length === 2 && saved().channels.coupang[0] === '쿠팡ID'
  && saved().workTypes.length === 1 && saved().templateSheetId === '1aaaaaaaaaaaaaaaaaaaaaaa');

reset();
await svc.saveTemplate({ by: '망고' });                       // ★ 8/23 사고와 같은 모양의 요청
const a1 = saved();
ok('★ 빈 본문 저장이 공통 열을 지우지 않는다', a1.core.length === 2, a1.core);
ok('★ 채널 열도 유지', (a1.channels.coupang || []).length === 1, a1.channels.coupang);
ok('★ 작업유형도 유지', (a1.workTypes || []).length === 1);
ok('★ 템플릿 시트도 유지', a1.templateSheetId === '1aaaaaaaaaaaaaaaaaaaaaaa');

await svc.saveTemplate({ workTypes: [], by: '망고' });
ok('빈 배열 []은 "비우기"로 반영된다(미전송과 구분)', (saved().workTypes || []).length === 0);
ok('그때도 공통 열은 그대로', saved().core.length === 2);

await svc.saveTemplate({ channels: { coupang: [] }, by: '망고' });
ok('보낸 채널만 비우고 안 보낸 채널은 유지',
  (saved().channels.coupang || []).length === 0 && Array.isArray(saved().channels.naver));

// ── B. ① 빈 저장 차단 ──────────────────────────────────────────
console.log('\n[B] ① 빈 저장 차단(fail-closed)');
reset();
let e = await refuse(() => svc.saveTemplate({ core: [], by: '망고' }));
ok('★ 공통 열 0개 저장은 거부된다', e && e.code === 'empty_core', e && e.message);
ok('★ 거부 시 쓰기 0건', writes().length === 0, writes().map(w => w.sql.trim().slice(0, 24)));
ok('거부 사유가 지금 열 수를 말한다', e.prevCoreCount === 2 && /2개/.test(e.message), e.message);
ok('거부해도 저장값은 그대로', saved().core.length === 2);

await svc.saveTemplate({ core: [], confirmClear: true, by: '망고' });
ok('confirmClear:true 는 통과한다(사람이 명시 확인)', saved().core.length === 0);

reset();
await svc.saveTemplate({ core: [], by: '망고' });
ok('★ 이미 0개면 0개 저장은 막지 않는다(막을 것이 없다)', writes().length === 1);

// ── C. ③ 되돌리기 ──────────────────────────────────────────────
console.log('\n[C] ③ 되돌리기');
_stored = null;
await svc.saveTemplate({ core: ['번호'], by: 'A' });
await svc.saveTemplate({ core: ['번호', '수취인'], by: 'B' });
const h1 = saved().history;
ok('저장 직전 값이 이력에 쌓인다', h1.length === 1 && h1[0].core.length === 1, h1.map(x => x.core));
ok('★ 첫 저장(빈 값)은 이력에 넣지 않는다 — 되돌릴 값이 아니다', h1.length === 1);

reset();
await svc.saveTemplate({ core: ['번호', '수취인'], by: 'B' });   // 같은 값
ok('★ 같은 값 반복 저장은 이력을 밀지 않는다', saved().history.length === 1, saved().history.length);

for (let i = 0; i < 14; i++) await svc.saveTemplate({ core: ['번호', 'c' + i], by: 'B' });
ok('이력은 최근 ' + svc.HISTORY_MAX + '개까지만', saved().history.length === svc.HISTORY_MAX, saved().history.length);

const g = await svc.getTemplate();
ok('★ 조회는 이력을 요약만 내려보낸다(전체 스냅샷 미포함)',
  g.history.length === svc.HISTORY_MAX && g.history[0].coreCount === 2 && g.history[0].core === undefined,
  g.history[0]);

const at = saved().history[0].at;
const before = saved().core.slice();
await svc.restoreTemplate({ at, by: '만두' });
ok('그 시점 값으로 되돌아간다', JSON.stringify(saved().core) !== JSON.stringify(before));
ok('★ 되돌리기도 지금 값을 이력에 남긴다(다시 되돌릴 수 있다)',
  saved().history.some(h => JSON.stringify(h.core) === JSON.stringify(before)));

e = await refuse(() => svc.restoreTemplate({ at: '2000-01-01T00:00:00.000Z', by: '만두' }));
ok('★ 이력에 없는 시각은 거부(추측해서 아무 값이나 쓰지 않는다)', e && e.code === 'not_found');
reset();
e = await refuse(() => svc.restoreTemplate({ by: '만두' }));
ok('시점 미지정도 거부 — 쓰기 0건', e && e.code === 'bad_at' && writes().length === 0);

// ── D. ④ 조회 실패 = 저장 금지 ─────────────────────────────────
console.log('\n[D] ④ 직전 값을 못 읽으면 저장하지 않는다');
reset(); _readFails = true;
e = await refuse(() => svc.saveTemplate({ core: ['번호'], by: '만두' }));
ok('★ 조회 실패 시 저장 거부', e && e.code === 'read_failed', e && e.message);
ok('★ 그때 쓰기 0건 — 모르는 채로 전체 교체하지 않는다', writes().length === 0);
e = await refuse(() => svc.restoreTemplate({ at, by: '만두' }));
ok('복구도 같은 규율', e && e.code === 'read_failed');
_readFails = false;

// ── E. 라우트 배선 ─────────────────────────────────────────────
console.log('\n[E] 라우트 — 거부를 400 으로 명시');
const body = routeBody(routes, "router.post('/worktable/template'");
ok('confirmClear 를 서비스로 넘긴다', /confirmClear:\s*b\.confirmClear === true/.test(body));
ok('restore 분기가 restoreTemplate 을 부른다', /b\.restore[\s\S]{0,120}restoreTemplate\(\{\s*at:\s*b\.restore/.test(body));
ok('★ empty_core / bad_at / not_found → 400',
  /code === 'empty_core'[\s\S]{0,160}status\(400\)/.test(body)
  && /'bad_at'/.test(body) && /'not_found'/.test(body));
ok('read_failed → 503', /code === 'read_failed'[\s\S]{0,80}status\(503\)/.test(body));
ok('★ 사유 코드를 본문에 실어 준다(화면이 갈래를 나눈다)', /code,\s*error:\s*e\.message/.test(body));
ok('★ 전제 — 이 경로는 오류 마스킹 예외 목록에 없다(그래서 400 을 직접 내야 한다)',
  /isAdminApi/.test(errMw) && !/trackb\/worktable/.test(errMw));
ok('게이트는 종전대로 adminOrMaster', /router\.post\('\/worktable\/template', authMiddleware, adminOrMasterMiddleware/.test(routes));

// ── F. 화면 배선 ───────────────────────────────────────────────
console.log('\n[F] 화면 — 확인 후 재전송 · 이력 목록');
/* ★ 함수 본문을 잘라서 본다 — 파일 어딘가에 있으면 통과하는 검사는 **엉뚱한 함수에 붙은
   변경을 통과시킨다**(이 가드를 만들 때 실제로 밟았다: 같은 3줄을 가진 `_smpFetch` 에 붙어
   저장 화면은 종전 그대로였고, 정적 검사는 초록이었다. 실브라우저가 잡았다). */
ok('★ _wtFetch 가 사유 코드를 오류에 싣는다(다른 fetch 헬퍼가 대신 통과시키지 않는다)',
  /e\.code = j\.code/.test(fnBody(setJs, 'async function _wtFetch(url, body)')));
ok('★ empty_core 만 확인창을 띄운다(문구 판정 금지)', /e\.code !== 'empty_core'/.test(setJs));
ok('★ 취소하면 아무것도 저장하지 않는다',
  /confirm\([\s\S]{0,200}\)\)\s*\{\s*\n?\s*showToast\('저장하지 않았습니다'/.test(setJs));
ok('확인하면 confirmClear:true 로 재전송', /payload\.confirmClear = true;[\s\S]{0,80}_wtFetch\(WT_EP\.template, payload\)/.test(setJs));
ok('이력 목록을 그린다', /function _wtRenderHistory\(\)/.test(setJs) && /id="wtHistory"/.test(setJs));
ok('★ 화면을 열자마자 이력이 보인다 — 로더도 그린다(저장한 뒤에야 보이면 사고 직후에 못 쓴다)',
  /_wtRenderHistory\(\)/.test(fnBody(setJs, 'async function loadWorktableTemplate()')));
ok('★ onclick 은 인덱스만(외부발 문자열 보간 금지)',
  /wtRestoreTemplate\('\s*\+ i \+\s*'\)/.test(setJs) && !/wtRestoreTemplate\('\$\{/.test(setJs));
ok('되돌리기는 확인창을 거친다', /async function wtRestoreTemplate[\s\S]{0,600}confirm\(/.test(setJs));
ok('★ 저장·복구 화면 반영은 한 벌(_wtApplySaved)',
  (setJs.match(/_wtApplySaved\(/g) || []).length >= 3 && /function _wtApplySaved\(data\)/.test(setJs));
ok('★ 저장·복구 직후에도 이력이 갱신된다(방금 남긴 값이 목록에 보여야 되돌릴 수 있다)',
  /_wtRenderHistory\(\)/.test(fnBody(setJs, 'function _wtApplySaved(data)')));
ok('이력이 없으면 아무것도 그리지 않는다', /if \(!h\.length\) \{ box\.innerHTML = ''; return; \}/.test(setJs));
ok('window 에 노출(onclick 이 찾는다)', /window\.wtRestoreTemplate = wtRestoreTemplate;/.test(setJs));

console.log('\n✅ worktableTemplateSaveGuard: ' + passed + '개 통과');
process.exit(0);
})();
