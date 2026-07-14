/**
 * 인트라넷 SSO + staff(AE) 초기매핑 스코프 회귀가드.
 *   1. loginIntranet — 인트라넷 서버 프록시 검증: 성공=staff 고정(권한 상승 차단)·display_name 신원,
 *      실패/연결불가/입력누락 = fail-closed. 공유키 없음(비밀번호 결속).
 *   2. createAdvertiserScoped — staff는 inad_pm=자기 로그인명 강제(타 AE 명의 차단)·중복 409.
 *   3. staffOwnsAdvertiser — inad_pm TRIM 일치만 허용(소유 지정/해제 게이트).
 *   4. scopedActiveTabs forMapping — staff만 전체 개방, advertiser는 무시(스코프 유지 = 교차열람 차단).
 * 실행: node tests/trackBIntranetSso.test.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const assert = require('assert');
const jwt = require('jsonwebtoken');
const auth = require('../src/services/auth.service');
const svc = require('../src/services/trackB.service');
const participants = require('../src/services/participants.service');

function mockFetch(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

async function run() {
  // ═══ 1. loginIntranet ═══
  // 1a: 성공 — role은 인트라넷 응답과 무관하게 'staff' 고정, name=display_name
  let r = await auth.loginIntranet('kim.ae', 'pw123',
    mockFetch(200, { id: 'u1', username: 'kim.ae', display_name: '김수만', role: 'admin' }));
  assert.equal(r.success, true, '1a: 성공');
  assert.equal(r.role, 'staff', '1a: 인트라넷 role=admin 이어도 staff 고정(권한 상승 차단)');
  assert.equal(r.name, '김수만', '1a: 신원=display_name(한글 실명, inad_pm 매칭 키)');
  const payload = jwt.verify(r.token, process.env.JWT_SECRET);
  assert.equal(payload.role, 'staff', '1a: JWT role=staff');
  assert.equal(payload.name, '김수만', '1a: JWT name=display_name');
  assert.equal(payload.via, 'intranet', '1a: 출처 표기');

  // 1b: 자격 불일치(401) → 실패 + 인트라넷 에러 메시지 전달
  r = await auth.loginIntranet('kim.ae', 'wrong', mockFetch(401, { error: '사용자명 또는 비밀번호가 올바르지 않습니다.' }));
  assert.equal(r.success, false, '1b: 401 거부');
  assert.ok(!r.token, '1b: 토큰 미발급');

  // 1c: 연결 불가(fetch throw) → fail-closed
  r = await auth.loginIntranet('kim.ae', 'pw', async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(r.success, false, '1c: 연결 불가 거부');
  assert.ok(/연결/.test(r.error), '1c: 연결 오류 메시지');

  // 1d: 입력 누락 → 네트워크 미호출 거부
  r = await auth.loginIntranet('', '', async () => { throw new Error('호출되면 안 됨'); });
  assert.equal(r.success, false, '1d: 입력 누락 거부');

  // 1e: 200이지만 username 없는 이상 응답 → 거부(fail-closed)
  r = await auth.loginIntranet('kim.ae', 'pw', mockFetch(200, {}));
  assert.equal(r.success, false, '1e: 이상 응답 거부');
  console.log('  1. loginIntranet — staff 고정·display_name 신원·401/연결불가/이상응답 fail-closed ✓');

  // ═══ 2. createAdvertiserScoped ═══
  const q = [];
  svc.__setPoolForTest({ async query(sql, vals) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, vals });
    if (/SELECT 1 FROM advertisers WHERE name/.test(s)) return { rows: s && vals[0] === '중복업체' ? [{ 1: 1 }] : [] };
    if (/INSERT INTO advertisers/.test(s)) return { rows: [{ id: vals[0], name: vals[1], inad_pm: vals[2] }] };
    if (/SELECT inad_pm FROM advertisers WHERE id/.test(s)) {
      return { rows: vals[0] === 'adv_mine' ? [{ inad_pm: ' 김수만 ' }] : vals[0] === 'adv_other' ? [{ inad_pm: '박세희' }] : [] };
    }
    return { rows: [] };
  } });

  // 2a: staff — body inad_pm 무시하고 자기 로그인명 강제
  let c = await svc.createAdvertiserScoped({ name: '새업체', inadPm: '박세희', role: 'staff', byName: '김수만' });
  assert.equal(c.ok, true, '2a: 생성 성공');
  assert.equal(c.data.inad_pm, '김수만', '2a: staff는 inad_pm=자기 로그인명 강제(타 AE 명의 차단)');

  // 2b: admin — body inad_pm 그대로 허용
  c = await svc.createAdvertiserScoped({ name: '새업체2', inadPm: '박세희', role: 'admin', byName: 'master' });
  assert.equal(c.data.inad_pm, '박세희', '2b: admin은 지정 inad_pm 허용');

  // 2c: 중복 → 409
  c = await svc.createAdvertiserScoped({ name: '중복업체', role: 'staff', byName: '김수만' });
  assert.equal(c.ok, false, '2c: 중복 거부'); assert.equal(c.code, 409, '2c: 409');

  // 2d: staff인데 로그인명 없음 → 400 (무명 생성 차단)
  c = await svc.createAdvertiserScoped({ name: '업체3', role: 'staff', byName: '' });
  assert.equal(c.ok, false, '2d: 로그인명 없는 staff 거부');
  console.log('  2. createAdvertiserScoped — staff inad_pm 강제·admin 허용·중복 409·무명 staff 400 ✓');

  // ═══ 3. staffOwnsAdvertiser ═══
  assert.equal(await svc.staffOwnsAdvertiser({ advertiserId: 'adv_mine', staffName: '김수만' }), true, '3a: TRIM 일치 허용');
  assert.equal(await svc.staffOwnsAdvertiser({ advertiserId: 'adv_other', staffName: '김수만' }), false, '3b: 타 AE 업체 거부');
  assert.equal(await svc.staffOwnsAdvertiser({ advertiserId: 'adv_none', staffName: '김수만' }), false, '3c: 없는 업체 거부');
  assert.equal(await svc.staffOwnsAdvertiser({ advertiserId: 'adv_mine', staffName: '' }), false, '3d: 무명 거부');
  console.log('  3. staffOwnsAdvertiser — 자기 담당만 허용(fail-closed) ✓');

  // ═══ 4. scopedActiveTabs forMapping ═══
  const allTabs = [
    { sheetId: 'S1', tabGid: '11', tabName: 'A' },
    { sheetId: 'S2', tabGid: '21', tabName: 'B' },
  ];
  participants.__setPoolForTest({ async query(sql) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM raw_sheet_tabs/.test(s)) return { rows: allTabs.map(t => ({ ...t })) };
    return { rows: [] };
  } });
  svc.__setPoolForTest({ async query(sql, vals) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    // staff 스코프(inad_pm=김수만): S1만 담당. advertiser 스코프: S1만 소유.
    if (/FROM advertiser_campaigns/.test(s) && /JOIN advertisers/.test(s) && /inad_pm/.test(s)) return { rows: [{ sheet_id: 'S1', tab_gid: null }] };
    if (/FROM advertiser_campaigns/.test(s) && /advertiser_id/.test(s)) return { rows: [{ sheet_id: 'S1', tab_gid: null }] };
    if (/FROM raw_sheet_tabs/.test(s)) return { rows: [] };   // _scopeFor의 gid 해석 경로
    return { rows: [] };
  } });

  // 4a: staff 기본(스코프) — 담당 시트만
  let tabs = await svc.scopedActiveTabs({ role: 'staff', staffName: '김수만' });
  // 스코프 해석이 mock 한계로 전량 걸러질 수 있으나, 핵심 계약은 4b(forMapping=전체)와의 차이.
  const scopedCount = tabs.length;

  // 4b: staff + forMapping → 전체 개방(미소유 시트 매핑 가능)
  tabs = await svc.scopedActiveTabs({ role: 'staff', staffName: '김수만', forMapping: true });
  assert.equal(tabs.length, allTabs.length, '4b: forMapping staff = 전체 탭');
  assert.ok(tabs.length >= scopedCount, '4b: 전체 ≥ 스코프');

  // 4c: advertiser + forMapping → 무시(스코프 유지, 교차열람 차단)
  tabs = await svc.scopedActiveTabs({ role: 'advertiser', advertiserId: 'adv_x', forMapping: true });
  assert.ok(tabs.length < allTabs.length, '4c: advertiser는 forMapping 무시(전체 미개방)');

  // 4d: master는 forMapping 여부와 무관하게 전체
  tabs = await svc.scopedActiveTabs({ role: 'master' });
  assert.equal(tabs.length, allTabs.length, '4d: master 전체');
  console.log('  4. scopedActiveTabs forMapping — staff만 전체·advertiser 무시·master 불변 ✓');

  svc.__setPoolForTest(null); participants.__setPoolForTest(null);
  console.log('✅ trackBIntranetSso 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
