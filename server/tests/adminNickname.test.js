/**
 * adminNickname.test.js — 관리자 닉네임(1:1문의 실명 노출 차단) 회귀가드 · migration 078
 * 실행: node tests/adminNickname.test.js
 *
 * ★★ 완화 금지 불변식
 *  ① **리뷰어 화면에는 관리자 로그인 계정명(실명)이 절대 나가지 않는다.**
 *     닉네임 미설정이면 '관리자'로 가린다(fail-closed). "설정 전까지 실명 노출"로 바꾸면
 *     이 기능이 막으려던 사고가 그대로 남는다.
 *  ② 저장은 **로그인명 그대로**, 치환은 **읽는 시점**에 한다 → 닉네임을 바꾸면 이미 보낸
 *     답장의 이름까지 함께 바뀐다(이미 유출된 이름을 되돌릴 유일한 방법).
 *  ③ 관리자 화면은 닉네임 || 로그인명 — 내부 책임추적은 유지(외부/내부 표시 분리).
 *  ④ 실시간 푸시(SSE)에도 같은 규칙을 적용한다(목록 API만 막으면 푸시로 실명이 샌다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const svcSrc = read('src/services/adminNickname.service.js');
const csRoutes = read('src/routes/cs.routes.js');
const revRoutes = read('src/routes/reviewer.routes.js');
const adminRoutes = read('src/routes/admin.routes.js');
const migration = read('migrations/078_admin_nicknames.sql');
const adminHtml = read('../frontend/admin.html');
const siandHtml = read('../frontend/admin-siand.html');
const appJs = read('../frontend/js/index-app.js');
const apiJs = read('../frontend/api.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

console.log('\n① 순수함수: 표시 이름 규칙');
const svc = require('../src/services/adminNickname.service');
const MAP = { '박세희': '만두', '박은비': '망고' };
ok('리뷰어: 닉네임 있으면 닉네임', svc.toReviewerName('박세희', MAP) === '만두');
ok('★ 리뷰어: 닉네임 없는 실명은 "관리자"로 가림(실명 유출 0)', svc.toReviewerName('김대리', MAP) === '관리자');
ok('★ 리뷰어: master 계정도 가려짐', svc.toReviewerName('master', MAP) === '관리자');
ok('리뷰어: 빈 값도 "관리자"', svc.toReviewerName('', MAP) === '관리자' && svc.toReviewerName(null, MAP) === '관리자');
ok('★ 리뷰어: 맵에 없는 값은 무조건 가림(fail-closed — 실명인지 아닌지 판단 불가)',
  svc.toReviewerName('알수없는이름', MAP) === '관리자');
ok('관리자: 닉네임 있으면 닉네임', svc.toAdminName('박은비', MAP) === '망고');
ok('관리자: 닉네임 없으면 로그인명 유지(내부 책임추적)', svc.toAdminName('김대리', MAP) === '김대리');
ok('공백 흡수', svc.toReviewerName(' 박세희 ', MAP) === '만두' && svc.toAdminName(' 김대리 ', MAP) === '김대리');

console.log('\n② 메시지 마스킹(리뷰어 메시지는 손대지 않음)');
{
  // 캐시된 맵을 쓰도록 주입(DB 없이 순수 동작 검증)
  const pool = require('../src/db/pool');
  pool.query = async () => ({ rows: [{ login_name: '박세희', nickname: '만두' }] });
  svc._invalidate();
  (async () => {
    const msgs = [
      { senderRole: 'reviewer', senderName: '김리아', content: 'a' },
      { senderRole: 'admin', senderName: '박세희', content: 'b' },
      { senderRole: 'admin', senderName: '김대리', content: 'c' },
    ];
    const forRev = await svc.maskMessages(msgs, 'reviewer');
    const forAdm = await svc.maskMessages(msgs, 'admin');
    ok('리뷰어용: 리뷰어 이름은 그대로', forRev[0].senderName === '김리아');
    ok('리뷰어용: 매핑 적용 + 미설정은 관리자', forRev[1].senderName === '만두' && forRev[2].senderName === '관리자');
    ok('관리자용: 매핑 적용 + 미설정은 로그인명', forAdm[1].senderName === '만두' && forAdm[2].senderName === '김대리');
    ok('원본 배열 불변(부수효과 없음)', msgs[1].senderName === '박세희');

    console.log('\n③ 배선: 두 읽기 경로 + 실시간 푸시');
    ok('리뷰어 대화 조회가 리뷰어용으로 마스킹',
      /maskMessages\(messages, 'reviewer'\)/.test(revRoutes));
    ok('관리자 대화 조회가 관리자용으로 치환',
      /maskMessages\(messages, 'admin'\)/.test(csRoutes));
    ok('★ 리뷰어 SSE 푸시도 리뷰어용 이름(푸시로 새는 경로 차단)',
      /emitCsReplyToReviewer\([\s\S]{0,200}toReviewerName\(senderName, nickMap\)/.test(csRoutes));
    ok('★ 저장은 로그인명 그대로(닉네임 변경 시 과거 답장까지 소급 적용)',
      /const senderName = req\.admin\?\.name \|\| '관리자';/.test(csRoutes) &&
      !/sender_name[^)]*toReviewerName/.test(csRoutes));
    ok('답장 응답(관리자 화면)은 관리자용 이름', /senderName: adminNickname\.toAdminName\(senderName, nickMap\)/.test(csRoutes));

    console.log('\n④ 설정 엔드포인트(본인 것만)');
    ok('GET /my-nickname (authMiddleware)', /router\.get\('\/my-nickname', authMiddleware/.test(adminRoutes));
    ok('POST /my-nickname (authMiddleware)', /router\.post\('\/my-nickname', authMiddleware/.test(adminRoutes));
    ok('★ 대상은 항상 로그인 계정 본인(body로 남의 닉네임 못 바꿈)',
      /const loginName = req\.admin\?\.name \|\| '';[\s\S]{0,600}setNickname\(loginName/.test(adminRoutes) &&
      !/req\.body[^\n]*loginName/.test(adminRoutes));
    ok('★ 로그인명과 같은 닉네임은 거부(실명 우회 저장 차단)',
      /raw === loginName/.test(adminRoutes));
    ok('길이 상한(20자)', /raw\.length > 20/.test(adminRoutes) && /slice\(0, 20\)/.test(svcSrc));
    ok('/api/admin/* 경로 = intranet·reviewer_campaign 스코프 토큰 도달 불가(경로 격리 유지)',
      /\/api\/admin\/\* 경로라/.test(adminRoutes));

    console.log('\n⑤ 마이그레이션 · 프론트');
    ok('078 테이블 생성(IF NOT EXISTS)', /CREATE TABLE IF NOT EXISTS admin_nicknames/.test(migration));
    ok('운영 매핑 시드(박세희→만두 · 박은비→망고)',
      /'박세희', '만두'/.test(migration) && /'박은비', '망고'/.test(migration));
    ok('★ 시드는 기존 값을 덮지 않음(관리자가 바꾼 닉네임 보존)',
      /ON CONFLICT \(login_name\) DO NOTHING/.test(migration));
    ok('api.js 액션 매핑', /'adminMyNickname'/.test(apiJs) && /'adminSaveNickname'/.test(apiJs));
    ok('설정 탭 UI(admin.html)', /id="myNicknameInput"/.test(adminHtml) && /saveMyNickname\(\)/.test(adminHtml));
    ok('설정 탭 UI(admin-siand.html) — 두 화면 동일', /id="myNicknameInput"/.test(siandHtml) && /saveMyNickname\(\)/.test(siandHtml));
    ok('설정 탭 진입 시 로드', /loadMyNickname\(\);/.test(appJs) && /tabName === "settings"[\s\S]{0,400}loadMyNickname/.test(appJs));
    ok('미설정 안내 문구(리뷰어에겐 "관리자"로 보임)', /관리자<\/b>로만? 보입니다/.test(appJs));

    console.log(`\n✅ adminNickname: ${passed}개 통과\n`);
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
