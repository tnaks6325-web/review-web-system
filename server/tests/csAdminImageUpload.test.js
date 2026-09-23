/**
 * csAdminImageUpload.test.js — 관리자 1:1문의 사진 첨부(파일선택·Ctrl+V·드래그앤드롭) 회귀가드
 * 실행: node tests/csAdminImageUpload.test.js
 *
 * 배경: 리뷰어는 문의에 사진을 첨부할 수 있는데(PR #398) 관리자 답장에는 첨부 창구가 없었다.
 * 이 변경은 리뷰어측(POST /api/reviewer/cs/upload)과 **같은 Drive 업로드 인프라**를 관리자
 * 인증 계층으로 재사용한다 — 신규 저장소 0, 검증 규칙(mime·8MB·URL 화이트리스트) 동일.
 *
 * ★ 화면 코드는 공유 모듈 `js/cs-inquiry.js`에 있다(admin.html·admin-siand.html·workdesk.html
 *   세 화면이 사본 없이 같은 모듈을 마운트 — csInquiryTab.test.js가 "사본 없음"을 별도로 고정).
 *   여기서는 그 모듈 안의 사진 첨부 배선만 검사한다.
 *
 * 고정하는 불변식
 *  ① 업로드 라우트는 authMiddleware+adminOrMaster 보호 아래(router.use 상속) 위치한다.
 *  ② 업로드 검증 규칙(mime 화이트리스트·8MB 상한)이 리뷰어측과 동일 — 갈라지면 한쪽만
 *     느슨해져 우회 경로가 생긴다.
 *  ③ 반환 URL은 기존 _sanitizeCsImageUrls 화이트리스트(guide-image 프록시)를 통과해야
 *     답장에 실릴 수 있다 — 업로드가 그 형태의 URL만 만들어야 한다.
 *  ④ 프론트: 첨부 3경로(파일선택 버튼·Ctrl+V·드래그앤드롭)가 전부 같은 업로드 함수로 수렴
 *     (사본을 두면 한쪽만 8MB·5장 제한이 걸리는 드리프트가 난다).
 *  ⑤ 전송은 업로드 완료된 첨부만 대상(인플라이트 업로드 중 전송 차단) — 리뷰어측과 동일 규칙.
 *  ⑥ 리뷰웹시스템[3버전](Track B) 프록시도 `/upload`를 위임한다 — 관리자 화면에만 넣으면 워크데스크만
 *     이 기능이 조용히 빠진 채로 남는다(다른 6개 경로와 같은 1:1 대칭 유지).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const csRoutes = read('src/routes/cs.routes.js');
const revRoutes = read('src/routes/reviewer.routes.js');
const trackBRoutes = read('src/routes/trackB.routes.js');
const appJs = read('../frontend/js/cs-inquiry.js');
const apiJs = read('../frontend/api.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

console.log('\n① 라우트 위치·보호');
ok('업로드 라우트 존재(POST /upload)', /router\.post\('\/upload'/.test(csRoutes));
{
  // router.use(authMiddleware, adminOrMasterMiddleware) 아래(이전)에 있어야 보호가 상속된다.
  const useIdx = csRoutes.indexOf("router.use(authMiddleware, adminOrMasterMiddleware)");
  const upIdx = csRoutes.indexOf("router.post('/upload'");
  ok('업로드 라우트가 router.use 보호 이후에 선언(인증 상속)', useIdx > -1 && upIdx > useIdx);
}

console.log('\n② 업로드 검증 규칙 = 리뷰어측과 동일');
function uploadBody(src) {
  let i = src.indexOf("router.post('/upload'");
  if (i < 0) i = src.indexOf("router.post('/cs/upload'");
  assert(i >= 0, '업로드 라우트를 찾지 못함');
  return src.slice(i, i + 1800);
}
const adminUp = uploadBody(csRoutes);
const revUp = uploadBody(revRoutes);
ok('관리자: mime 화이트리스트(png/jpeg/gif/webp/heic/heif)', adminUp.includes(String.raw`image\/(png|jpe?g|gif|webp|heic|heif)`));
ok('관리자: 8MB 상한(같은 계산식)', /8 \* 1024 \* 1024/.test(adminUp) && /data\.length \* 0\.75/.test(adminUp));
ok('리뷰어: 같은 mime 화이트리스트(드리프트 없음)', revUp.includes(String.raw`image\/(png|jpe?g|gif|webp|heic|heif)`));
ok('관리자: guide-image Drive 인프라 재사용([문의첨부] 폴더)', /\[문의첨부\]/.test(adminUp));
ok('관리자: 응답 URL이 guide-image 프록시 형태(화이트리스트 통과 형태)',
  /\/api\/order\/guide-image\/\$\{up\.id\}/.test(adminUp));

console.log('\n③ 첨부 3경로가 한 업로드 함수로 수렴');
ok('파일선택 버튼 → csPickFiles', /onclick="document\.getElementById\('csAttachFile'\)\.click\(\)"/.test(appJs) &&
  /function csPickFiles/.test(appJs));
ok('Ctrl+V 붙여넣기 → csHandlePaste(textarea onpaste)', /onpaste="csHandlePaste\(event\)"/.test(appJs) &&
  /function csHandlePaste/.test(appJs));
ok('드래그앤드롭 → _csBindDropZone(dragover/drop 리스너)', /function _csBindDropZone/.test(appJs) &&
  /addEventListener\('drop'/.test(appJs));
ok('★ 세 경로 모두 _csUploadFile 한 곳으로 수렴(사본 금지)',
  (appJs.match(/_csUploadFile\(/g) || []).length >= 4);   // 정의 1 + 호출 3곳(picker/paste/drop)
ok('붙여넣기는 이미지일 때만 preventDefault(텍스트 붙여넣기 기본 동작 보존)',
  /const imgItems = items\.filter\(it => it\.kind === 'file' && \/\^image\\\/\/\.test\(it\.type\)\);/.test(appJs) &&
  /if \(!imgItems\.length\) return;/.test(appJs));
ok('드래그오버는 파일 드래그일 때만 반응(텍스트 드래그로 오버레이 안 뜸)',
  /isFileDrag = \(e\) => \[\.\.\.\(e\.dataTransfer\?\.types \|\| \[\]\)\]\.includes\('Files'\)/.test(appJs));

console.log('\n④ 전송 규칙 · 배선');
ok('업로드 중이면 전송 차단(리뷰어측과 동일 규칙)',
  /_csPending\.some\(p => !p\.url\)/.test(appJs) && /사진 업로드가 끝나면 전송할 수 있어요/.test(appJs));
ok('전송 시 imageUrls 동봉', /gasPost\(\{ action: "csAdminReply", threadId, content, imageUrls \}\)/.test(appJs));
ok('실패 시 첨부 복구(전송 실패해도 사진 안 사라짐)', /_csPending = sentAttach; csRenderAttachBar\(\);/.test(appJs));
ok('방 전환 시 이전 첨부 폐기(다른 방에 잘못 붙는 사고 방지)', /_csPending = \[\];   \/\/ 방을 바꾸면 이전 첨부는 버린다/.test(appJs));
ok('api.js 액션 매핑(csAdminUpload)', /'csAdminUpload':\s*\{ method: 'POST', path: '\/api\/cs\/upload' \}/.test(apiJs));
ok('최대 5장 제한(리뷰어측과 동일)', /_csPending\.length >= 5/.test(appJs));
ok('8MB 초과 파일 차단(프론트 사전 검증)', /f\.size > 8 \* 1024 \* 1024/.test(appJs));

console.log('\n⑤ 리뷰웹시스템[3버전](Track B) 프록시 대칭');
ok('trackB가 /cs/upload도 위임(다른 6개 경로와 동일 패턴)',
  /upload:\s*_delegate\(_csRoutes, 'post', '\/upload'\)/.test(trackBRoutes));
ok('trackB 마운트 경로도 authMiddleware+adminOrMaster로 보호',
  /router\.post\('\/cs\/upload', authMiddleware, adminOrMasterMiddleware/.test(trackBRoutes));

console.log(`\n✅ csAdminImageUpload: ${passed}개 통과\n`);
