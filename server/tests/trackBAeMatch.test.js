/**
 * 담당 AE(inad_pm) 매칭 + 인트라넷 사용자(AE) 프록시 회귀가드.
 *   1. setAdvertiserInadPm — TRIM 저장(스코프 키 footgun 방지), 빈 값=해제, 404, 비문자열 방어.
 *   2. intranetStaffUsers — display_name/username/부서만 반환(비밀번호 등 민감필드 미노출), q 필터, fail-soft.
 *   3. listAdvertisersWithOwnership — inadPm 동봉(소유지정 목록/상세 표시용).
 * 실행: node tests/trackBAeMatch.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');

function pool(routes) {
  const q = [];
  return { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [], rowCount: 0 };
  } };
}

async function run() {
  // ═══ 1. setAdvertiserInadPm ═══
  let p = pool([[/UPDATE advertisers SET inad_pm/, (s, prm) => ({ rows: [{ id: prm[0], name: '어니스트캄', inadPm: prm[1] }] })]]);
  svc.__setPoolForTest(p);
  let r = await svc.setAdvertiserInadPm({ advertiserId: 'A1', inadPm: '  박세희  ', by: 'master' });
  assert.equal(r.ok, true); assert.equal(r.advertiser.inadPm, '박세희', '1a: TRIM 저장(inad_pm 스코프 키 정합)');
  r = await svc.setAdvertiserInadPm({ advertiserId: 'A1', inadPm: '', by: 'master' });
  assert.equal(r.ok, true); assert.equal(r.advertiser.inadPm, '', '1b: 빈 값 = 담당 해제 허용');
  r = await svc.setAdvertiserInadPm({ advertiserId: 'A1', inadPm: { evil: 1 }, by: 'master' });
  assert.equal(r.advertiser.inadPm, '', '1c: 비문자열 → 빈 값(객체 오염 방지)');
  r = await svc.setAdvertiserInadPm({ advertiserId: '', inadPm: 'x' });
  assert.equal(r.ok, false, '1d: advertiserId 필수');
  p = pool([[/UPDATE advertisers SET inad_pm/, () => ({ rows: [] })]]); svc.__setPoolForTest(p);
  r = await svc.setAdvertiserInadPm({ advertiserId: 'NOPE', inadPm: 'x' });
  assert.equal(r.code, 404, '1e: 없는 거래처 404');
  console.log('  1. setAdvertiserInadPm — TRIM·해제·타입방어·404 ✓');

  // ═══ 2. intranetStaffUsers — 민감필드 미노출 + 필터 ═══
  const savedFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: [
    { id: 'u1', username: 'psh', password: 'SECRET-HASH', display_name: '박세희', department: '마케팅', birth_date: '1990-01-01' },
    { id: 'u2', username: 'peb', password: 'SECRET2', display_name: '박은비', department: null },
    { id: 'u3', username: 'ghost', password: 'x', display_name: '  ' },
  ] }) });
  r = await svc.intranetStaffUsers({});
  assert.equal(r.ok, true); assert.equal(r.items.length, 2, '2a: display_name 없는 계정 제외');
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['department', 'name', 'username'], '2b: 이름·아이디·부서만(비밀번호 등 미노출)');
  assert.ok(!JSON.stringify(r.items).includes('SECRET'), '2c: 비밀번호 문자열 완전 미포함');
  r = await svc.intranetStaffUsers({ q: '은비' });
  assert.equal(r.items.length, 1, '2d: q 필터'); assert.equal(r.items[0].name, '박은비');
  r = await svc.intranetStaffUsers({ q: 'psh' });
  assert.equal(r.items.length, 1, '2e: username 으로도 검색');
  console.log('  2. intranetStaffUsers — 민감필드 미노출·q 필터 ✓');

  // ═══ 3. listAdvertisersWithOwnership — inadPm 동봉 ═══
  p = pool([[/FROM advertisers a LEFT JOIN trackb_advertiser_prefs/, (s) => {
    assert.ok(/a\.inad_pm AS "inadPm"/.test(s), '3a: inad_pm SELECT');
    return { rows: [{ id: 'A1', name: '어니스트캄', inadPm: '박세희', owned: 3, settlementVisible: true }] };
  }]]);
  svc.__setPoolForTest(p);
  const items = await svc.listAdvertisersWithOwnership();
  assert.equal(items[0].inadPm, '박세희', '3b: inadPm 반환');
  console.log('  3. listAdvertisersWithOwnership — inadPm 동봉 ✓');

  svc.__setPoolForTest(null); global.fetch = savedFetch;
  console.log('✅ trackBAeMatch 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
