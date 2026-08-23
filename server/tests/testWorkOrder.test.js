/**
 * testWorkOrder.test.js — 🧪 테스트 작업오더 (사용자 요청 2026-08-21)
 *
 * 고정하는 계약
 *   ① 오더를 만드는 코드를 새로 쓰지 않는다 — AE 제출과 **같은 핸들러**에 위임(사본 0)
 *   ② 프록시 게이트는 원본보다 **좁다**(내부인 + 편집 허용명단) — 넓어지면 안 된다
 *   ③ 창구는 작업오더 탭 헤더 하나 · 편집 권한자에게만 그린다(서버 게이트와 1:1)
 *   ④ 구글시트탭URL 은 비운다 — 그래야 접수가 무시트 경로(시스템 작업표)를 탄다
 *   ⑤ 사람이 확인해야 만들어진다(누르자마자 데이터가 생기지 않는다)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const tb = read('src/routes/trackB.routes.js');
const ord = read('src/routes/order.routes.js');
const wd = read('../frontend/workdesk.html');

console.log('\n[A] 서버 — 위임 한 벌 · 게이트는 좁게');
ok('★ 오더 생성 로직 사본 0 — `/api/order/submit` 핸들러에 위임한다',
  /_woSubmitHandler = _delegate\(_orderRoutes, 'post', '\/submit'\)/.test(tb));
ok('★ 프록시에 INSERT 가 없다(실행부는 원본 하나)',
  !/INSERT INTO work_orders/i.test(tb));
{
  const line = /router\.post\('\/work-orders\/submit',([^)]*)\)/.exec(tb);
  ok('라우트가 등록돼 있다', !!line);
  ok('★ 게이트 = 내부인 + 편집 허용명단(접수·발행과 같은 2단)',
    !!line && /authMiddleware/.test(line[1]) && /internalMiddleware/.test(line[1])
    && /editorOnlyMiddleware/.test(line[1]));
}
ok('★ 원본 `/submit` 게이트는 무변경(프록시만 좁혔다)',
  /router\.post\('\/submit', authMiddleware, async/.test(ord));
ok('상태는 서버가 항상 submitted 로 넣는다(그래야 [접수하기] 가 보인다)',
  /VALUES \(\$1[^)]*'submitted'/.test(ord));

console.log('\n[B] 라우터 스택 실검사');
{
  const layers = require('../src/routes/trackB.routes').stack || [];
  const hit = layers.filter(l => l.route && l.route.path === '/work-orders/submit');
  ok('스택에 실제로 올라 있다', hit.length === 1);
  ok('POST 만 열려 있다', hit[0].route.methods.post === true && !hit[0].route.methods.get);
  const names = hit[0].route.stack.map(h => h.name || '');
  ok('★ 미들웨어 3단이 실제로 붙어 있다(문자열 검사만으로는 못 본다)',
    names.some(n => /auth/i.test(n)) && names.some(n => /internal/i.test(n))
    && names.some(n => /editorOnly/i.test(n)));
}

console.log('\n[C] 화면 — 창구 하나 · 권한자에게만');
{
  ok('작업오더 탭 헤더에 버튼이 있다', /onclick="makeTestWorkOrder\(\)"/.test(wd));
  ok('★ 편집 권한자에게만 그린다(서버 게이트와 1:1)',
    /\$\{STATE\.canEdit\?'<button class="btn" onclick="makeTestWorkOrder\(\)"/.test(wd));
  ok('★ 창구는 하나 — 다른 화면에 사본이 없다',
    (wd.match(/makeTestWorkOrder\(\)/g) || []).length === 2);   // 버튼 1 + 함수 선언 1
  const i = wd.indexOf('async function makeTestWorkOrder(){');
  const fn = wd.slice(i, wd.indexOf('\n}', wd.indexOf('else _toast', i)) + 2);
  ok('★ 사람이 확인해야 만들어진다(누르자마자 데이터 생성 금지)',
    /if\(!confirm\(/.test(fn) && /return;/.test(fn));
  ok('★ 권한 없으면 만들지 않는다(화면도 최종 방어)', /if\(!STATE\.canEdit\)\{ _toast/.test(fn));
  ok('★ 구글시트탭URL 은 비운다 — 무시트 접수 경로를 타게', /work_sheet_url: ''/.test(fn));
  ok('★ 경로는 Track B(인트라넷 SSO 토큰이 /api/order/* 에 못 간다)',
    /'\/api\/trackb\/work-orders\/submit'/.test(fn) && !/'\/api\/order\/submit'/.test(fn));
  ok('실패를 성공으로 꾸미지 않는다(사유를 말한다)', /⚠ 만들지 못했습니다/.test(fn));

  // 제목·본문을 실제로 만들어 본다
  const sb = { STATE: { canEdit: true }, confirm: () => false, _toast: () => {}, api: async () => ({ ok: true }) };
  let asked = '';
  sb.confirm = m => { asked = m; return false; };
  vm.createContext(sb);
  vm.runInContext(fn + '\n;this.__m=makeTestWorkOrder;', sb);
  return sb.__m().then(() => {
    ok('★ 제목에 🧪 [테스트] 와 만든 시각이 들어간다(실제 오더와 눈으로 구분·중복 없음)',
      /🧪 \[테스트\] 접수→모집공고 검증 \d\d\/\d\d \d\d:\d\d/.test(asked));
    ok('확인창이 무엇이 만들어지는지 말한다',
      /총 10건 · 일 5건/.test(asked) && /구글시트 없이/.test(asked) && /언제든 지울 수 있습니다/.test(asked));
    console.log(`\n✅ testWorkOrder: ${pass} 케이스 통과`);
    process.exit(0);
  });
}
