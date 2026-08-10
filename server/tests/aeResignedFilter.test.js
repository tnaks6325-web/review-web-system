/**
 * 담당 AE 후보에서 퇴사자 제외 회귀가드.
 *   1. _isResignedUser 판정 — 인트라넷 규칙(`is_active === 0 || resigned_at`) 그대로 + 필드 부재 fail-open.
 *   2. intranetStaffUsers — 퇴사자 items 제외 · resignedNames 동봉 · 응답 shape 3필드 불변 · dept 스코프.
 *   3. 프론트 배선 — 후보 수신 단일 지점(_aeApply)·퇴사자 안내(_advPmCheck/_aeWarnCheck)·사본 부재.
 * 실행: node tests/aeResignedFilter.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const svc = require('../src/services/trackB.service');

const WD = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');

// 인트라넷 users 스텁을 갈아끼우고 캐시를 비운 뒤 조회한다(60초 캐시가 시나리오를 섞지 않게).
async function fetchWith(rows, opts) {
  global.fetch = async () => ({ ok: true, json: async () => ({ data: rows }) });
  svc.__resetIntraUserCacheForTest();
  return svc.intranetStaffUsers(opts || {});
}

async function run() {
  const savedFetch = global.fetch;

  // ═══ 1. 판정 규칙 — 인트라넷과 같은 기준, 모르면 포함(fail-open) ═══
  const ROWS = [
    { username: 'a1', display_name: '재직A', department: 'AE' },                                   // 필드 자체 없음
    { username: 'a2', display_name: '재직B', department: 'AE', resigned_at: null, is_active: 1 },
    { username: 'a3', display_name: '재직C', department: 'AE', resigned_at: '', is_active: 1 },     // 빈 문자열 = 재직
    { username: 'r1', display_name: '퇴사A', department: 'AE', resigned_at: '2026-03-01', is_active: 0 },
    { username: 'r2', display_name: '퇴사B', department: 'AE', resigned_at: '2026-05-10', is_active: 1 }, // 퇴사일만
    { username: 'r3', display_name: '비활성C', department: 'AE', resigned_at: null, is_active: 0 },       // 비활성만
    { username: 'x1', display_name: '타부서', department: '개발', resigned_at: null, is_active: 1 },
    { username: 'x2', display_name: '타부서퇴사', department: '개발', resigned_at: '2026-01-01', is_active: 0 },
  ];

  let r = await fetchWith(ROWS, { dept: 'AE', limit: 50 });
  assert.equal(r.ok, true);
  let names = r.items.map(u => u.name);
  assert.deepEqual(names.sort(), ['재직A', '재직B', '재직C'], '1a: 퇴사일 있음·비활성(is_active=0) 전부 후보에서 제외');
  assert.ok(!names.includes('퇴사A') && !names.includes('퇴사B') && !names.includes('비활성C'), '1b: 세 갈래 모두 제외');
  assert.ok(names.includes('재직A'), '1c: 두 필드가 아예 없으면 판정 불가 = 포함(fail-open — 구버전 인트라넷에서 전 직원이 사라지면 안 된다)');
  assert.ok(names.includes('재직C'), '1d: resigned_at 빈 문자열은 재직(인트라넷 판정과 동일)');

  // is_active 가 null/undefined 인 것을 "비활성"으로 접지 않는다
  r = await fetchWith([{ username: 'n1', display_name: '널액티브', department: 'AE', is_active: null }], { dept: 'AE' });
  assert.equal(r.items.length, 1, '1e: is_active=null 은 "모름"이라 제외하지 않는다');
  console.log('  1. 퇴사 판정 — 인트라넷 규칙 동일 + 필드 부재 fail-open ✓');

  // ═══ 2. 응답 계약 ═══
  r = await fetchWith(ROWS, { dept: 'AE', limit: 50 });
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['department', 'name', 'username'],
    '2a: items shape 3필드 불변(resigned 내부 플래그 미노출)');
  assert.ok(Array.isArray(r.resignedNames), '2b: resignedNames 동봉');
  assert.deepEqual(r.resignedNames.slice().sort(), ['비활성C', '퇴사A', '퇴사B'].sort(),
    '2c: resignedNames = 그 스코프의 퇴사자만(타부서 퇴사자 미포함)');
  assert.ok(!r.resignedNames.includes('타부서퇴사'), '2d: dept 스코프가 resignedNames 에도 적용');

  // 부서 필터 없이 조회하면 전 부서 기준
  r = await fetchWith(ROWS, { limit: 50 });
  assert.ok(r.items.map(u => u.name).includes('타부서'), '2e: dept 미지정이면 전 부서 재직자');
  assert.ok(!r.items.map(u => u.name).includes('타부서퇴사'), '2f: dept 미지정이어도 퇴사자는 제외(편집 허용명단 후보도 같은 경로)');

  // q 검색이 퇴사자를 되살리지 않는다
  r = await fetchWith(ROWS, { q: '퇴사', limit: 50 });
  assert.equal(r.items.length, 0, '2g: 이름으로 검색해도 퇴사자는 후보에 없다');

  // 조회 실패 fail-soft(기존 계약 불변)
  global.fetch = async () => { throw new Error('boom'); };
  svc.__resetIntraUserCacheForTest();
  r = await svc.intranetStaffUsers({ dept: 'AE' });
  assert.equal(r.ok, false, '2h: 인트라넷 도달 불가 = fail-soft(ok:false, items 빈 배열)');
  assert.deepEqual(r.items, []);
  console.log('  2. intranetStaffUsers — 퇴사자 제외·resignedNames·shape 불변 ✓');

  // ═══ 3. 프론트 배선 ═══
  // 후보 수신 지점이 단일(_aeApply)인지 — 사본을 두면 한쪽 화면만 퇴사자를 계속 그린다.
  const applyDefs = (WD.match(/function _aeApply\s*\(/g) || []).length;
  assert.equal(applyDefs, 1, '3a: _aeApply 정의 1개(단일 수신 지점)');
  const applyCalls = (WD.match(/\n\s*_aeApply\(r\);/g) || []).length;   // 정의(function _aeApply(r){)는 제외
  assert.equal(applyCalls, 2, '3b: 담당AE 후보 조회 2곳(업체추가 폼·[변경] 박스) 모두 _aeApply 경유');
  assert.ok(!/_aeItems\s*=\s*\(r&&r\.ok&&r\.items\)/.test(WD.replace(/function _aeApply[\s\S]*?\n}/, '')),
    '3c: _aeApply 밖에서 _aeItems 를 직접 대입하는 사본 부재');

  // 두 조회 모두 dept=AE 를 유지(퇴사자 제외는 서버가 하지만 부서 스코프 계약은 그대로)
  assert.equal((WD.match(/\/api\/trackb\/intranet\/users\?dept=AE/g) || []).length, 2, '3d: 담당AE 후보 조회는 dept=AE 2곳');

  // 퇴사자 안내 — "직접 입력값"으로 뭉뚱그리지 않는다
  assert.ok(/_aeIsResigned\(val\)[\s\S]{0,200}퇴사한 직원/.test(WD), '3e: _advPmCheck 가 퇴사자 사유를 구분해 안내');
  assert.ok(/function _aeWarnCheck\(\)/.test(WD) && /_aeIsResigned\(el\.value\)/.test(WD), '3f: [변경] 박스도 퇴사자 경고');
  assert.ok(/oninput="_aeWarnCheck\(\)"/.test(WD) && /_aeWarnCheck\(\);\s*\/\//.test(WD),
    '3g: 입력 중·목록 도착 후 양쪽에서 재판정(이미 지정된 퇴사자는 목록이 와야 알 수 있다)');

  // 구버전 백엔드(resignedNames 미동봉) = 종전 문구 그대로
  const sandbox = { _aeItems: [], _aeResigned: [] };
  const src = WD.slice(WD.indexOf('function _aeApply('), WD.indexOf('function intraSuggest('));
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  sandbox._aeApply({ ok: true, items: [{ name: '재직A' }] });        // resignedNames 없음
  assert.deepEqual(sandbox._aeResigned, [], '3h: resignedNames 미동봉이면 빈 배열(구버전 백엔드)');
  assert.equal(sandbox._aeIsResigned('아무개'), false, '3i: 모르면 퇴사자로 단정하지 않는다');
  sandbox._aeApply({ ok: true, items: [], resignedNames: ['퇴사A'] });
  assert.equal(sandbox._aeIsResigned(' 퇴사A '), true, '3j: 공백·대소문자 무시 일치');
  assert.equal(sandbox._aeIsResigned(''), false, '3k: 빈 값은 판정 대상 아님');
  console.log('  3. 프론트 배선 — 단일 수신 지점·퇴사자 안내·구버전 폴백 ✓');

  global.fetch = savedFetch;
  console.log('\n✅ aeResignedFilter — 전 케이스 통과');
}

run().then(() => process.exit(0)).catch(e => { console.error('❌', e.message); process.exit(1); });
