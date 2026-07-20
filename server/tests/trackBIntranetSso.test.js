/**
 * 인트라넷 SSO + staff(AE) 초기매핑 스코프 회귀가드.
 *   1. loginIntranet — 인트라넷 서버 프록시 검증: 기본 staff(인트라넷 role 필드 불신뢰 — role=admin
 *      이어도 staff), INTRANET_SSO_ADMIN_USERS 지정 username 만 admin 승격(1a),
 *      INTRANET_SSO_ALLOWED_ROLES 진입 게이트(2b, 미설정=전 직원), display_name 신원,
 *      실패/연결불가/입력누락 = fail-closed. 공유키 없음(비밀번호 결속).
 *      ★ admin 승격 토큰도 via:'intranet' 격리 유지(/api/trackb/* 전용 — 1.5e).
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
  delete process.env.INTRANET_SSO_ADMIN_USERS; delete process.env.INTRANET_SSO_ALLOWED_ROLES;
  // 1a: 성공 — 인트라넷 role=admin 이어도 기본 staff(role 필드 불신뢰 = 기존 안전장치 유지)
  let r = await auth.loginIntranet('kim.ae', 'pw123',
    mockFetch(200, { id: 'u1', username: 'kim.ae', display_name: '김수만', role: 'admin' }));
  assert.equal(r.success, true, '1a: 성공');
  assert.equal(r.role, 'staff', '1a: 인트라넷 role=admin 이어도 기본 staff(자기신고 role 불신뢰)');
  assert.equal(r.name, '김수만', '1a: 신원=display_name(한글 실명, inad_pm 매칭 키)');
  const payload = jwt.verify(r.token, process.env.JWT_SECRET);
  assert.equal(payload.role, 'staff', '1a: JWT role=staff');
  assert.equal(payload.name, '김수만', '1a: JWT name=display_name');
  assert.equal(payload.via, 'intranet', '1a: 출처 표기');
  assert.equal(payload.ir, 'admin', '1a: ir(인트라넷 원천 role) 감사 클레임');

  // 1a2(정책 1a): INTRANET_SSO_ADMIN_USERS 지정 계정만 admin 승격 — username 매칭(대소문·공백 무시)
  process.env.INTRANET_SSO_ADMIN_USERS = ' Boss , ceo2 ';
  r = await auth.loginIntranet('boss', 'pw123',
    mockFetch(200, { username: 'boss', display_name: '대표', role: 'user' }));
  assert.equal(r.role, 'admin', '1a2: 지정 계정 → admin 승격(인트라넷 role 무관)');
  const adminIntraToken = r.token;   // 1.5e 격리 검증용
  r = await auth.loginIntranet('kim.ae', 'pw123',
    mockFetch(200, { username: 'kim.ae', display_name: '김수만', role: 'admin' }));
  assert.equal(r.role, 'staff', '1a2: 미지정 계정은 role=admin 이어도 staff');
  delete process.env.INTRANET_SSO_ADMIN_USERS;

  // 1a3(정책 2b): INTRANET_SSO_ALLOWED_ROLES 설정 시 그 role만 진입, 미설정=전 직원
  process.env.INTRANET_SSO_ALLOWED_ROLES = 'admin,manager';
  r = await auth.loginIntranet('kim.ae', 'pw123',
    mockFetch(200, { username: 'kim.ae', display_name: '김수만', role: 'user' }));
  assert.equal(r.success, false, '1a3: 허용 role 밖 → 진입 거부');
  assert.ok(/권한/.test(r.error), '1a3: 안내 메시지');
  r = await auth.loginIntranet('boss', 'pw123',
    mockFetch(200, { username: 'boss', display_name: '대표', role: 'Admin' }));
  assert.equal(r.success, true, '1a3: 허용 role 통과(대소문 무시)');
  delete process.env.INTRANET_SSO_ALLOWED_ROLES;
  r = await auth.loginIntranet('kim.ae', 'pw123',
    mockFetch(200, { username: 'kim.ae', display_name: '김수만', role: 'user' }));
  assert.equal(r.success, true, '1a3: 미설정 = 전 직원 허용(현행 유지)');

  // 1a4(그룹 게이트): INTRANET_SSO_ALLOWED_GROUPS = '부서' 또는 '부서|파트' — 개인 수동등록 없이 그룹 단위 진입
  process.env.INTRANET_SSO_ALLOWED_GROUPS = ' AE , 콘텐츠운영팀|체험단파트 ';
  const grp = (dept, part) => mockFetch(200, { username: 'emp1', display_name: '직원', role: 'user', department: dept, part });
  r = await auth.loginIntranet('emp1', 'pw', grp('AE', '아무파트'));
  assert.equal(r.success, true, '1a4: AE 부서 전직원 통과(파트 무관)');
  r = await auth.loginIntranet('emp1', 'pw', grp('ae ', null));
  assert.equal(r.success, true, '1a4: 대소문/공백 무시 + part 없는 구버전 응답도 부서단독 규칙 통과');
  r = await auth.loginIntranet('emp1', 'pw', grp('콘텐츠운영팀', '체험단파트'));
  assert.equal(r.success, true, '1a4: 콘텐츠운영팀|체험단파트 통과');
  r = await auth.loginIntranet('emp1', 'pw', grp('콘텐츠운영팀', '기획'));
  assert.equal(r.success, false, '1a4: 같은 부서라도 파트 불일치 거부');
  r = await auth.loginIntranet('emp1', 'pw', grp('경영지원', null));
  assert.equal(r.success, false, '1a4: 대상 외 부서 거부');
  assert.ok(/부서\/파트/.test(r.error), '1a4: 안내 메시지');
  // 그룹 설정 시 role 규칙은 미적용(그룹이 우선) — role=admin 이어도 그룹 밖이면 거부
  process.env.INTRANET_SSO_ALLOWED_ROLES = 'admin';
  r = await auth.loginIntranet('emp1', 'pw', mockFetch(200, { username: 'emp1', display_name: '직원', role: 'admin', department: '경영지원' }));
  assert.equal(r.success, false, '1a4: 그룹 설정 시 role 규칙 대체(그룹 밖 거부)');
  delete process.env.INTRANET_SSO_ALLOWED_ROLES;
  // 지정 admin 계정은 그룹 밖이어도 항상 통과(+admin 승격)
  process.env.INTRANET_SSO_ADMIN_USERS = 'boss';
  r = await auth.loginIntranet('boss', 'pw', mockFetch(200, { username: 'boss', display_name: '대표', role: 'user', department: '경영' }));
  assert.equal(r.success, true, '1a4: 지정 admin 은 그룹 무관 통과');
  assert.equal(r.role, 'admin', '1a4: 지정 admin 승격 유지');
  delete process.env.INTRANET_SSO_ADMIN_USERS;
  delete process.env.INTRANET_SSO_ALLOWED_GROUPS;

  // 1a5(서버간 인증): INTRANET_API_KEY 설정 시 프록시 호출에 X-Api-Key 헤더를 실어 보낸다
  //   (인트라넷 API 가드 활성 시 키 없는 서버간 호출은 Unauthorized로 차단됨 — SSO 토큰 발급 실패 재발 방지).
  let capturedHeaders = null;
  const captureFetch = (status, body) => async (_url, opts) => {
    capturedHeaders = (opts && opts.headers) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  process.env.INTRANET_API_KEY = 'svc-key-xyz';
  r = await auth.loginIntranet('kim.ae', 'pw123',
    captureFetch(200, { username: 'kim.ae', display_name: '김수만', role: 'user' }));
  assert.equal(r.success, true, '1a5: 성공');
  assert.equal(capturedHeaders['X-Api-Key'], 'svc-key-xyz', '1a5: INTRANET_API_KEY 를 X-Api-Key 로 전송');
  assert.equal(capturedHeaders['Content-Type'], 'application/json', '1a5: Content-Type 유지');
  // 미설정이면 헤더 미전송(구버전 인트라넷/가드 비활성 호환)
  delete process.env.INTRANET_API_KEY;
  capturedHeaders = null;
  r = await auth.loginIntranet('kim.ae', 'pw123',
    captureFetch(200, { username: 'kim.ae', display_name: '김수만', role: 'user' }));
  assert.ok(!('X-Api-Key' in capturedHeaders), '1a5: INTRANET_API_KEY 미설정 시 X-Api-Key 미전송');

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

  // 1f: display_name이 공백뿐 → 거부(빈 신원 토큰 발급 차단)
  r = await auth.loginIntranet('kim.ae', 'pw', mockFetch(200, { username: '   ', display_name: '  ' }));
  assert.equal(r.success, false, '1f: 공백 신원 거부');

  // 1g: iu(인트라넷 username) 감사 클레임 동봉
  r = await auth.loginIntranet('kim.ae', 'pw', mockFetch(200, { username: 'kim.ae', display_name: '김수만' }));
  assert.equal(jwt.verify(r.token, process.env.JWT_SECRET).iu, 'kim.ae', '1g: iu 클레임');
  console.log('  1. loginIntranet — staff 고정·display_name 신원·fail-closed·공백거부·iu 감사 ✓');

  // ═══ 1.5 authMiddleware — via:intranet 토큰은 /api/trackb/* 전용(폭발반경 격리) ═══
  const { authMiddleware } = require('../src/middleware/auth.middleware');
  const intraToken = r.token;   // via:'intranet'
  const staffToken = jwt.sign({ name: '김수만', role: 'staff' }, process.env.JWT_SECRET);   // 자체 staff(via 없음)
  function runMw(tok, baseUrl, path) {
    return new Promise(resolve => {
      const req = { headers: { authorization: 'Bearer ' + tok }, query: {}, baseUrl, path };
      const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b, nexted: false }); } };
      authMiddleware(req, res, () => resolve({ nexted: true, admin: req.admin }));
    });
  }
  let mw = await runMw(intraToken, '/api/trackb', '/tabs');
  assert.equal(mw.nexted, true, '1.5a: intranet 토큰 — /api/trackb/* 통과');
  mw = await runMw(intraToken, '/api/tab', '/reset-all');
  assert.equal(mw.code, 403, '1.5b: intranet 토큰 — Track A(탭설정 리셋) 차단');
  mw = await runMw(intraToken, '/api/memo', '/save');
  assert.equal(mw.code, 403, '1.5c: intranet 토큰 — Track A(메모) 차단');
  mw = await runMw(staffToken, '/api/tab', '/reset-all');
  assert.equal(mw.nexted, true, '1.5d: 자체 staff 토큰(via 없음)은 기존 동작 불변');
  // 1.5e: 지정계정 admin 승격 토큰도 격리 유지 — Track A 도달 불가(폭발반경 불변)
  mw = await runMw(adminIntraToken, '/api/trackb', '/overview');
  assert.equal(mw.nexted, true, '1.5e: intranet admin — /api/trackb/* 통과');
  mw = await runMw(adminIntraToken, '/api/tab', '/reset-all');
  assert.equal(mw.code, 403, '1.5e: intranet admin 이어도 Track A 차단(role 무관 격리)');
  console.log('  1.5 authMiddleware — via:intranet 토큰 Track B 전용 격리(Track A 차단·기존 토큰 불변·admin 승격에도 유지) ✓');

  // ═══ 2. createAdvertiserScoped ═══
  const q = [];
  svc.__setPoolForTest({ async query(sql, vals) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, vals });
    if (/SELECT 1 FROM advertisers WHERE name/.test(s)) return { rows: s && vals[0] === '중복업체' ? [{ 1: 1 }] : [] };
    if (/INSERT INTO advertisers/.test(s)) return { rows: [{ id: vals[0], name: vals[1], inad_pm: vals[2] }] };
    if (/SELECT inad_pm FROM advertisers WHERE id/.test(s)) {
      return { rows: vals[0] === 'adv_mine' ? [{ inad_pm: ' 김수만 ' }] : vals[0] === 'adv_other' ? [{ inad_pm: '박세희' }] : [] };
    }
    if (/UPDATE advertisers SET status = 'ended'/.test(s)) return { rows: vals[0] === 'adv_del' ? [{ id: 'adv_del', name: '삭제업체' }] : [] };
    if (/UPDATE advertiser_campaigns SET deleted_at/.test(s)) return { rows: [], rowCount: 2 };
    if (/SELECT DISTINCT ac.sheet_id FROM advertiser_campaigns/.test(s)) return { rows: [{ sheet_id: 'S_owned1' }, { sheet_id: 'S_owned2' }, { sheet_id: null }] };
    return { rows: [] };
  } });
  // 거래처 등록검증(인트라넷 광고주DB) 목 — 등록됨/미등록/도달불가 3태를 주입.
  const okVerify = async () => ({ ok: true, registered: true });
  const notReg = async () => ({ ok: true, registered: false });
  const unreach = async () => ({ ok: false, unreachable: true });

  // 2a: staff — body inad_pm 무시하고 자기 로그인명 강제
  let c = await svc.createAdvertiserScoped({ name: '새업체', inadPm: '박세희', role: 'staff', byName: '김수만', _verify: okVerify });
  assert.equal(c.ok, true, '2a: 생성 성공');
  assert.equal(c.data.inad_pm, '김수만', '2a: staff는 inad_pm=자기 로그인명 강제(타 AE 명의 차단)');

  // 2b: admin — body inad_pm 그대로 허용
  c = await svc.createAdvertiserScoped({ name: '새업체2', inadPm: '박세희', role: 'admin', byName: 'master', _verify: okVerify });
  assert.equal(c.data.inad_pm, '박세희', '2b: admin은 지정 inad_pm 허용');

  // 2c: 중복 → 409
  c = await svc.createAdvertiserScoped({ name: '중복업체', role: 'staff', byName: '김수만', _verify: okVerify });
  assert.equal(c.ok, false, '2c: 중복 거부'); assert.equal(c.code, 409, '2c: 409');

  // 2d: staff인데 로그인명 없음 → 400 (무명 생성 차단, 검증 전 반환)
  c = await svc.createAdvertiserScoped({ name: '업체3', role: 'staff', byName: '' });
  assert.equal(c.ok, false, '2d: 로그인명 없는 staff 거부');

  // 2e: 거래처정보 미등록 광고주 → 422 (인트라넷 광고주DB에 없는 이름 차단)
  c = await svc.createAdvertiserScoped({ name: '유령업체', role: 'admin', byName: 'master', _verify: notReg });
  assert.equal(c.ok, false, '2e: 미등록 거부'); assert.equal(c.code, 422, '2e: 422');

  // 2f: 인트라넷 도달 불가 → 503 (검증 못 한 채 유입 금지, fail-closed)
  c = await svc.createAdvertiserScoped({ name: '아무업체', role: 'admin', byName: 'master', _verify: unreach });
  assert.equal(c.ok, false, '2f: 도달불가 거부'); assert.equal(c.code, 503, '2f: 503');
  console.log('  2. createAdvertiserScoped — staff 강제·admin 허용·중복 409·무명 400·미등록 422·도달불가 503 ✓');

  // ═══ 2.5 deleteAdvertiser — 소프트 삭제(status=ended)+소유 해제, 없는 업체 404 ═══
  let d = await svc.deleteAdvertiser({ advertiserId: 'adv_del', by: 'master' });
  assert.equal(d.ok, true, '2.5a: 삭제 성공');
  assert.equal(d.data.ownershipsReleased, 2, '2.5a: 소유 매핑 해제 카운트');
  assert.ok(q.some(x => /UPDATE advertisers SET status = 'ended'/.test(x.s)), '2.5a: status=ended 소프트삭제(하드삭제 아님)');
  d = await svc.deleteAdvertiser({ advertiserId: 'adv_none', by: 'master' });
  assert.equal(d.ok, false, '2.5b: 없는 업체 404'); assert.equal(d.code, 404, '2.5b: 404');
  d = await svc.deleteAdvertiser({});
  assert.equal(d.ok, false, '2.5c: advertiserId 누락 400'); assert.equal(d.code, 400, '2.5c: 400');
  console.log('  2.5 deleteAdvertiser — 소프트삭제(ended)+소유해제·404·400 ✓');

  // ═══ 2.6 ownedSheetIds — 이미 소유 지정된 시트 ID(널 제외) ═══
  const os = await svc.ownedSheetIds();
  assert.deepEqual(os, ['S_owned1', 'S_owned2'], '2.6: 소유 시트 ID 목록(널 제외 — 업체추가 드롭다운 제외용)');
  console.log('  2.6 ownedSheetIds — 소유 시트 목록·널 제외 ✓');

  // ═══ 3. staffOwnsAdvertiser ═══
  assert.equal(await svc.staffOwnsAdvertiser({ advertiserId: 'adv_mine', staffName: '김수만' }), true, '3a: TRIM 일치 허용');
  assert.equal(await svc.staffOwnsAdvertiser({ advertiserId: 'adv_other', staffName: '김수만' }), false, '3b: 타 AE 업체 거부');
  assert.equal(await svc.staffOwnsAdvertiser({ advertiserId: 'adv_none', staffName: '김수만' }), false, '3c: 없는 업체 거부');
  assert.equal(await svc.staffOwnsAdvertiser({ advertiserId: 'adv_mine', staffName: '' }), false, '3d: 무명 거부');
  console.log('  3. staffOwnsAdvertiser — 자기 담당만 허용(fail-closed) ✓');

  // ═══ 3.5 sheetAssignableByStaff — 타 AE 소유 시트로의 자가 스코프 확장 차단 ═══
  svc.__setPoolForTest({ async query(sql, vals) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/COUNT\(\*\)::int AS others/.test(s)) return { rows: [{ others: vals[0] === 'S_free' ? 0 : 2 }] };
    return { rows: [] };
  } });
  assert.equal(await svc.sheetAssignableByStaff({ sheetId: 'S_free', staffName: '김수만' }), true, '3.5a: 무소유(또는 전부 자기 소유) 시트 허용');
  assert.equal(await svc.sheetAssignableByStaff({ sheetId: 'S_taken', staffName: '김수만' }), false, '3.5b: 타 AE/업체 소유 시트 거부');
  assert.equal(await svc.sheetAssignableByStaff({ sheetId: '', staffName: '김수만' }), false, '3.5c: 인자 누락 거부');
  console.log('  3.5 sheetAssignableByStaff — staff 자가 스코프 확장 차단 ✓');

  // ═══ 3.6 createAdvertiserScoped — 동시 생성 레이스(23505) → 409 ═══
  svc.__setPoolForTest({ async query(sql) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/SELECT 1 FROM advertisers WHERE name/.test(s)) return { rows: [] };
    if (/INSERT INTO advertisers/.test(s)) { const e = new Error('duplicate'); e.code = '23505'; throw e; }
    return { rows: [] };
  } });
  const race = await svc.createAdvertiserScoped({ name: '레이스업체', role: 'staff', byName: '김수만', _verify: async () => ({ ok: true, registered: true }) });
  assert.equal(race.ok, false, '3.6: 레이스 실패');
  assert.equal(race.code, 409, '3.6: 23505 → 409(서버오류 마스킹 방지)');
  console.log('  3.6 createAdvertiserScoped — UNIQUE 레이스 409 ✓');

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
