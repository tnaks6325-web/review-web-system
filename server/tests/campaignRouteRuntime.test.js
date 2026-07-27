/**
 * campaignRouteRuntime.test.js — 캠페인 라우트 "런타임 스코프" 회귀가드
 * 실행: node tests/campaignRouteRuntime.test.js
 *
 * 왜 필요한가(실사고 재발방지): 063에서 admin update 라우트가 UPDATE 파라미터로
 * `multi_account_mode` 등을 참조하면서 `req.body` 구조분해에는 넣지 않아
 * **공고 수정 저장이 전부 ReferenceError(500)** 였다. 기존 가드는 전부 SQL 문자열 grep이라
 * "선언 누락"을 볼 수 없었다 → 여기서는 **핸들러의 구조분해 블록을 실제로 실행**해
 * 파라미터 배열이 참조하는 식별자가 전부 선언돼 있는지 확인한다(DB·서버 기동 불필요).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/campaign.routes.js'), 'utf8');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

/** 라우트 본문에서 `const {...} = req.body;` 구조분해 블록과 파라미터 배열 식별자를 뽑아
 *  "선언 없이 참조되는 이름"이 있으면 반환한다. */
function undeclaredInRoute(routeStart, routeEnd) {
  const body = src.slice(src.indexOf(routeStart), src.indexOf(routeEnd));
  const dIdx = body.indexOf('const {', body.indexOf('req.params') > -1 ? body.indexOf('req.params') : 0);
  const dEnd = body.indexOf('} = req.body;', dIdx);
  assert(dIdx > -1 && dEnd > -1, 'req.body 구조분해 블록을 찾지 못함: ' + routeStart);
  const destructure = body.slice(dIdx, dEnd + 13);
  // 선언된 이름 = 구조분해 블록의 식별자 + 라우트 안의 const/let 선언
  const declared = new Set();
  for (const m of destructure.replace(/\/\/[^\n]*/g, '').matchAll(/([A-Za-z_$][\w$]*)\s*(?:[,}]|$)/g)) declared.add(m[1]);
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of body.matchAll(/\b(?:const|let)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const nm = part.split(':').pop().trim().replace(/\s*=.*$/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) declared.add(nm);
    }
  }
  // 파라미터 배열(`[ ... ]`)에서 참조되는 snake_case 식별자만 검사(본문 컬럼명과 동형인 이름들)
  const paramBlocks = body.match(/\n\s*\[\n[\s\S]*?\n\s*\]\s*\n?\s*\)/g) || [];
  const missing = [];
  for (const blk of paramBlocks) {
    for (const m of blk.replace(/\/\/[^\n]*/g, '').replace(/'[^']*'/g, "''").matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) {
      const nm = m[1];
      if (!declared.has(nm) && !missing.includes(nm)) missing.push(nm);
    }
  }
  return missing;
}

// ── admin update: 063 사고 재발방지(핵심) ──
{
  const missing = undeclaredInRoute("router.put('/admin/:id'", "router.delete('/admin/:id'");
  ok('PUT /admin/:id — 파라미터 배열이 참조하는 이름이 전부 선언됨' +
     (missing.length ? ' (누락: ' + missing.join(', ') + ')' : ''), missing.length === 0);
}
// ── admin create도 동일 규율 ──
{
  const missing = undeclaredInRoute("router.post('/admin/create'", "router.put('/admin/:id'");
  ok('POST /admin/create — 파라미터 배열이 참조하는 이름이 전부 선언됨' +
     (missing.length ? ' (누락: ' + missing.join(', ') + ')' : ''), missing.length === 0);
}
// ── 063 3필드가 update 경로에서 실제로 살아있는지(선언 + SQL + 파라미터 3중) ──
{
  const upd = src.slice(src.indexOf("router.put('/admin/:id'"), src.indexOf("router.delete('/admin/:id'"));
  for (const f of ['multi_account_mode', 'multi_daily_limit', 'sub_hold_ttl_min']) {
    const declared = new RegExp(`multi_account_mode, multi_daily_limit, sub_hold_ttl_min`).test(upd);
    ok(`update: ${f} 구조분해 선언됨`, declared && upd.includes(f));
  }
  ok('update: 3필드 COALESCE UPDATE 유지', /multi_account_mode = COALESCE\(\$33/.test(upd) && /multi_daily_limit = COALESCE\(\$34/.test(upd) && /sub_hold_ttl_min = COALESCE\(\$35/.test(upd));
}
// ── 구조분해 블록 자체를 실행해 ReferenceError 부재 실증 ──
{
  const body = src.slice(src.indexOf("router.put('/admin/:id'"), src.indexOf("router.delete('/admin/:id'"));
  const dIdx = body.indexOf('const {', body.indexOf('req.params'));
  const dEnd = body.indexOf('} = req.body;', dIdx) + 13;
  const fn = new Function('req', body.slice(dIdx, dEnd) + '\n return [multi_account_mode, multi_daily_limit, sub_hold_ttl_min];');
  let threw = null;
  try { fn({ body: {} }); } catch (e) { threw = e; }
  ok('update 구조분해 실행: 063 3필드 ReferenceError 없음', threw === null);
}

console.log(`\n✅ campaignRouteRuntime: ${passed}개 통과`);
