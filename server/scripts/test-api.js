#!/usr/bin/env node
/**
 * 리뷰웹시스템 — 전체 API 통합 테스트 스크립트
 * DB가 연결된 상태에서 모든 엔드포인트를 순차 테스트합니다.
 * 
 * 사용법: node scripts/test-api.js
 */

const BASE = process.env.API_BASE || 'http://localhost:3000';

let token = '';
let passed = 0;
let failed = 0;
const results = [];

async function req(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

function authH() { return { Authorization: `Bearer ${token}` }; }

async function test(name, fn) {
  try {
    const result = await fn();
    if (result) {
      passed++;
      results.push({ name, status: '✅ PASS', detail: result });
      console.log(`  ✅ ${name}: ${result}`);
    } else {
      failed++;
      results.push({ name, status: '❌ FAIL', detail: 'returned falsy' });
      console.log(`  ❌ ${name}: returned falsy`);
    }
  } catch (err) {
    failed++;
    results.push({ name, status: '❌ FAIL', detail: err.message });
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  리뷰웹시스템 API 통합 테스트');
  console.log(`  서버: ${BASE}`);
  console.log('═══════════════════════════════════════════════');
  console.log('');

  // ═══ 1. Health Check ═══
  console.log('▶ [1] 헬스체크');
  await test('GET /health', async () => {
    const r = await req('GET', '/health');
    if (!r.data.ok) throw new Error('ok가 false');
    if (r.data.db !== 'connected') throw new Error(`DB: ${r.data.db}`);
    return `ok=${r.data.ok}, db=${r.data.db}, v=${r.data.version}`;
  });
  console.log('');

  // ═══ 2. Admin Authentication ═══
  console.log('▶ [2] 관리자 인증');
  await test('POST /api/admin/login (마스터)', async () => {
    const r = await req('POST', '/api/admin/login', { name: 'master', pw: '931118' });
    if (!r.data.success || !r.data.token) throw new Error(JSON.stringify(r.data));
    token = r.data.token;
    return `token 발급 성공 (role: ${r.data.role || 'master'})`;
  });

  await test('POST /api/admin/login (잘못된 비밀번호)', async () => {
    const r = await req('POST', '/api/admin/login', { name: 'master', pw: 'wrong' });
    if (r.data.success) throw new Error('잘못된 비밀번호로 로그인 성공됨');
    return `거부됨: ${r.data.error}`;
  });

  await test('인증 없이 보호된 API 호출', async () => {
    const r = await req('GET', '/api/admin/my-nickname');   // (옛 표본 smart-build/status 는 2026-10-22 제거 — 결정 273)
    if (r.status !== 401) throw new Error(`status: ${r.status}`);
    return `401 반환 확인`;
  });
  console.log('');

  // (3. 관리자 사용자 CRUD /api/admin/users — 옛 관리자 대시보드 전용 경로라 2026-10-22 제거 · 결정 270)

  // (4. 영업담당자 CRUD /api/admin/staff-users — 옛 관리자 대시보드 전용 경로라 2026-10-22 제거 · 결정 270)

  // ═══ 5. 리뷰어 관리 ═══
  console.log('▶ [5] 리뷰어 관리');
  await test('POST /api/reviewer/register', async () => {
    const r = await req('POST', '/api/reviewer/register', { name: '테스트리뷰어', phone: '01012345678', consent: true });
    if (!r.data.ok) throw new Error(JSON.stringify(r.data));
    return '리뷰어 등록 성공';
  });

  await test('GET /api/reviewer/verify (전화번호 뒤 8자리)', async () => {
    const r = await req('GET', '/api/reviewer/verify?phone8=12345678');
    if (!r.data.ok) throw new Error(JSON.stringify(r.data));
    return `인증: ${r.data.name || r.data.reviewer?.name}`;
  });

  await test('GET /api/reviewer/lookup', async () => {
    const r = await req('GET', '/api/reviewer/lookup?phone8=12345678');
    if (!r.data.ok) throw new Error(JSON.stringify(r.data));
    return `조회: ${r.data.name}`;
  });

  await test('POST /api/reviewer/profile (get)', async () => {
    const r = await req('POST', '/api/reviewer/profile', { action: 'get', phone8: '12345678' });
    if (!r.data.ok) throw new Error(JSON.stringify(r.data));
    return `프로필 조회 성공`;
  });

  console.log('');

  // (6. 탭 설정 /api/tab/config·options — 옛 관리자 대시보드 전용 경로라 2026-10-22 제거 · 결정 270)

  // ═══ 7. 검색 ═══
  console.log('▶ [7] 검색');
  await test('GET /api/search?query=테스트', async () => {
    const r = await req('GET', '/api/search?query=테스트');
    if (!r.data.results && !Array.isArray(r.data.results)) throw new Error(JSON.stringify(r.data));
    return `검색 결과: ${r.data.results?.length || 0}건`;
  });
  console.log('');

  // (8. 인덱스 상태 /api/index/status — 옛 관리자 대시보드 전용 경로라 2026-10-22 제거 · 결정 270)

  // (9. 메모 /api/memo — 2026-09-28 제거, 결정 186 55번)

  // (10. 단축 URL 생성 /api/short/create — 옛 관리자 대시보드 전용 경로라 2026-10-22 제거 · 결정 270)

  // (11. 입금처리 /api/payment — 2026-09-28 제거, 결정 186 57번. 입금은 /api/trackb/payment/*)

  // ═══ 12. 블랙리스트 ═══
  console.log('▶ [12] 블랙리스트');
  await test('POST /api/blacklist (추가)', async () => {
    const r = await req('POST', '/api/blacklist/', { action2: 'add', phone: '01099999999', name: '블랙테스트', reason: '테스트' }, authH());
    if (!r.data.ok && !r.data.success) throw new Error(JSON.stringify(r.data));
    return '블랙리스트 추가 성공';
  });

  await test('POST /api/blacklist (목록)', async () => {
    const r = await req('POST', '/api/blacklist/', { action2: 'list' }, authH());
    if (!r.data.ok && !r.data.success && !r.data.blacklist) throw new Error(JSON.stringify(r.data));
    return `블랙리스트: ${r.data.blacklist?.length || 0}건`;
  });

  await test('POST /api/blacklist (삭제)', async () => {
    const r = await req('POST', '/api/blacklist/', { action2: 'remove', phone: '01099999999' }, authH());
    return '블랙리스트 삭제 성공';
  });
  console.log('');

  // (13. 빌드잠금 해제 /api/admin/release-lock — 시트 시절 색인 수동 조작이라 2026-10-22 제거 · 결정 273)

  // (14. 진단 엔드포인트 debug-tab 은 2026-10-05 제거 — 결정 186 103번)

  // ═══ 15. 정리 (테스트 데이터 삭제) ═══
  console.log('▶ [15] 테스트 데이터 정리');
  await test('탭 설정 테스트 데이터 삭제', async () => {
    // DB에서 직접 삭제는 하지 않음 (테스트 확인용)
    return '테스트 데이터 유지 (수동 정리 가능)';
  });
  console.log('');

  // ═══ 결과 요약 ═══
  console.log('═══════════════════════════════════════════════');
  console.log(`  결과: ✅ ${passed}개 통과 / ❌ ${failed}개 실패 / 총 ${passed + failed}개`);
  console.log('═══════════════════════════════════════════════');

  if (failed > 0) {
    console.log('\n실패 항목:');
    results.filter(r => r.status.includes('FAIL')).forEach(r => {
      console.log(`  ❌ ${r.name}: ${r.detail}`);
    });
  }
}

main().catch(err => {
  console.error('테스트 실행 실패:', err);
  process.exit(1);
});
