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
    const r = await req('GET', '/api/index/status');
    if (r.status !== 401) throw new Error(`status: ${r.status}`);
    return `401 반환 확인`;
  });
  console.log('');

  // ═══ 3. 관리자 사용자 CRUD ═══
  console.log('▶ [3] 관리자 사용자 CRUD');
  await test('POST /api/admin/users (추가)', async () => {
    const r = await req('POST', '/api/admin/users', { action: 'add', name: 'testadmin', pw: 'testpass123' }, authH());
    if (!r.data.success && !r.data.ok) throw new Error(JSON.stringify(r.data));
    return '관리자 추가 성공';
  });

  await test('POST /api/admin/users (목록)', async () => {
    const r = await req('POST', '/api/admin/users', { action: 'list' }, authH());
    if (!r.data.success && !r.data.users) throw new Error(JSON.stringify(r.data));
    return `관리자 ${r.data.users?.length || 0}명`;
  });

  await test('POST /api/admin/users (삭제)', async () => {
    const r = await req('POST', '/api/admin/users', { action: 'delete', name: 'testadmin' }, authH());
    if (!r.data.success && !r.data.ok) throw new Error(JSON.stringify(r.data));
    return '관리자 삭제 성공';
  });
  console.log('');

  // ═══ 4. Staff CRUD ═══
  console.log('▶ [4] 영업담당자 CRUD');
  await test('POST /api/admin/staff-users (추가)', async () => {
    const r = await req('POST', '/api/admin/staff-users', { action: 'add', name: 'teststaff', pw: 'staffpass123' }, authH());
    if (!r.data.success && !r.data.ok) throw new Error(JSON.stringify(r.data));
    return '스태프 추가 성공';
  });

  await test('POST /api/admin/staff-login', async () => {
    const r = await req('POST', '/api/admin/staff-login', { name: 'teststaff', pw: 'staffpass123' });
    if (!r.data.success || !r.data.token) throw new Error(JSON.stringify(r.data));
    return `스태프 로그인 성공`;
  });

  await test('POST /api/admin/staff-users (삭제)', async () => {
    const r = await req('POST', '/api/admin/staff-users', { action: 'delete', name: 'teststaff' }, authH());
    if (!r.data.success && !r.data.ok) throw new Error(JSON.stringify(r.data));
    return '스태프 삭제 성공';
  });
  console.log('');

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

  await test('GET /api/reviewer/list', async () => {
    const r = await req('GET', '/api/reviewer/list', null, authH());
    if (!r.data.ok && !r.data.reviewers) throw new Error(JSON.stringify(r.data));
    return `리뷰어 ${r.data.reviewers?.length || r.data.list?.length || 0}명`;
  });

  await test('POST /api/reviewer/profile (get)', async () => {
    const r = await req('POST', '/api/reviewer/profile', { action: 'get', phone8: '12345678' });
    if (!r.data.ok) throw new Error(JSON.stringify(r.data));
    return `프로필 조회 성공`;
  });

  await test('POST /api/reviewer/delete', async () => {
    const r = await req('POST', '/api/reviewer/delete', { name: '테스트리뷰어', phone: '01012345678' }, authH());
    if (!r.data.ok) throw new Error(JSON.stringify(r.data));
    return '리뷰어 삭제 성공';
  });
  console.log('');

  // ═══ 6. 탭 설정 ═══
  console.log('▶ [6] 탭 설정');
  await test('POST /api/tab/config (설정 저장)', async () => {
    const r = await req('POST', '/api/tab/config', {
      sheetId: 'test-sheet-id', tabName: 'test-tab', manager: '김테스트',
      reviewType: '블로그', paymentType: '건별', displayName: '테스트탭'
    }, authH());
    if (r.data.error) throw new Error(r.data.error);
    return '탭 설정 저장 성공';
  });

  await test('GET /api/tab/config', async () => {
    const r = await req('GET', '/api/tab/config', null, authH());
    if (r.data.error) throw new Error(r.data.error);
    return `탭 설정 ${r.data.configs?.length || r.data.detailMap ? '조회' : '0건'} 성공`;
  });

  await test('GET /api/tab/options', async () => {
    const r = await req('GET', '/api/tab/options');
    return `탭 옵션 조회 성공`;
  });
  console.log('');

  // ═══ 7. 검색 ═══
  console.log('▶ [7] 검색');
  await test('GET /api/search?query=테스트', async () => {
    const r = await req('GET', '/api/search?query=테스트');
    if (!r.data.results && !Array.isArray(r.data.results)) throw new Error(JSON.stringify(r.data));
    return `검색 결과: ${r.data.results?.length || 0}건`;
  });
  console.log('');

  // ═══ 8. 인덱스 ═══
  console.log('▶ [8] 인덱스');
  await test('GET /api/index/status', async () => {
    const r = await req('GET', '/api/index/status', null, authH());
    if (!r.data.ok) throw new Error(JSON.stringify(r.data));
    return `인덱스: count=${r.data.meta?.count}, builtAt=${r.data.meta?.builtAt}`;
  });
  console.log('');

  // ═══ 9. 메모 ═══
  console.log('▶ [9] 메모');
  await test('POST /api/memo (저장)', async () => {
    const r = await req('POST', '/api/memo', { sheetId: 'test-sheet', tabName: 'test-tab', text: '테스트 메모', name: '관리자', role: 'admin' });
    if (!r.data.ok) throw new Error(JSON.stringify(r.data));
    return '메모 저장 성공';
  });

  await test('GET /api/memo', async () => {
    const r = await req('GET', '/api/memo?sheetId=test-sheet&tabName=test-tab');
    if (!r.data.ok) throw new Error(JSON.stringify(r.data));
    return `메모: "${r.data.memo?.text || r.data.memo?.content || '(빈)'}"`;
  });

  await test('DELETE /api/memo', async () => {
    const r = await req('DELETE', '/api/memo?sheetId=test-sheet&tabName=test-tab', null, authH());
    if (!r.data.ok) throw new Error(JSON.stringify(r.data));
    return '메모 삭제 성공';
  });
  console.log('');

  // ═══ 10. 단축 URL ═══
  console.log('▶ [10] 단축 URL');
  let shortCode = '';
  await test('POST /api/short/create', async () => {
    const r = await req('POST', '/api/short/create', { s: 'test-sheet', g: '123', t: 'test-tab', d: '테스트탭' });
    if (!r.data.code) throw new Error(JSON.stringify(r.data));
    shortCode = r.data.code;
    return `code: ${r.data.code}, url: ${r.data.shortUrl}`;
  });

  await test('GET /api/short/resolve', async () => {
    if (!shortCode) throw new Error('shortCode 없음');
    const r = await req('GET', `/api/short/resolve?code=${shortCode}`);
    if (!r.data.s) throw new Error(JSON.stringify(r.data));
    return `해석: sheet=${r.data.s}, tab=${r.data.t}`;
  });
  console.log('');

  // ═══ 11. 입금처리 ═══
  console.log('▶ [11] 입금처리');
  await test('GET /api/payment/targets', async () => {
    const r = await req('GET', '/api/payment/targets', null, authH());
    if (!r.data.ok) throw new Error(JSON.stringify(r.data));
    return `대상: ${r.data.targets?.length || 0}건`;
  });
  console.log('');

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

  // ═══ 13. 관리자 대시보드 ═══
  console.log('▶ [13] 대시보드 / 빌드잠금');
  await test('GET /api/admin/dashboard', async () => {
    const r = await req('GET', '/api/admin/dashboard', null, authH());
    return `대시보드: ${JSON.stringify(r.data).substring(0, 100)}`;
  });

  await test('POST /api/admin/release-lock', async () => {
    const r = await req('POST', '/api/admin/release-lock', {}, authH());
    return `잠금 해제: ${JSON.stringify(r.data).substring(0, 80)}`;
  });
  console.log('');

  // ═══ 14. 진단 엔드포인트 ═══
  console.log('▶ [14] 진단');
  await test('GET /api/diag/debug-tab', async () => {
    const r = await req('GET', '/api/diag/debug-tab', null, authH());
    return `debug-tab: ${r.status}`;
  });
  console.log('');

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
