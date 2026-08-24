/* 썸네일 = 구글 CDN 직결 회귀가드 — 사용자 확정 2026-08-24
 *
 * 배경(실측): 프록시 `/api/drive/image/<id>` 는 장당 1.7~1.8초(31KB·631KB 가 비슷 =
 *   Drive 지연 + 전송량 지배)인데 같은 이미지의 drive.google.com/thumbnail 은 0.4초 안팎이고
 *   바이트도 3~7배 작다. **원본 화질이 필요 없는 자리만** CDN 으로 돌린다.
 *
 * [A] 규칙 단일 출처 = js/drive-thumb.js (프록시 URL 사본 0 · 형식 검증 · 상한 · 폴백 1회)
 * [B] vm 실행 — 속성 3종 · 불량 id · 폴백 1회/2회차
 * [C] 소비처 — 썸네일 자리는 CDN, **원본 자리는 프록시 유지(완화 금지)**
 * [D] 배선 — 모듈을 쓰는 모든 페이지에 script 태그 · 모듈 부재 시 원본으로 접는다
 *
 * 실행: node tests/previewThumbnail.test.js
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = f => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
const MOD = R('frontend/js/drive-thumb.js');
const WD = R('frontend/workdesk.html');
const SA = R('frontend/js/search-app.js');
const CS = R('frontend/js/cs-review-edit-card.js');
const IA = R('frontend/js/index-app.js');
const RP = R('frontend/report.html');
const IX = R('frontend/index.html');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x ? ' — ' + String(x).slice(0, 300) : '')); } };

/** 함수 본문 잘라내기 — 다음 최상위 선언 전까지(고정 길이 슬라이스 금지) */
function bodyOf(src, name) {
  const at = src.indexOf('\nfunction ' + name + '(');
  if (at < 0) throw new Error('not found: ' + name);
  const rest = src.slice(at + 1);
  const m = rest.slice(1).search(/\n(function |const |\/\* |\/\/ ══)/);
  return rest.slice(0, m < 0 ? rest.length : m + 1);
}

console.log('\nA) 규칙 단일 출처 — js/drive-thumb.js');
ok('모듈이 url/attrs/fall 을 노출한다',
  /window\.DriveThumb\s*=\s*\{\s*url: url,\s*attrs: attrs,\s*fall: fall\s*\}/.test(MOD));
ok('★ 파일ID 형식 검증 후에만 CDN URL 을 만든다(임의 문자열 주입 차단)',
  /\/\^\[-\\w\]\{20,\}\$\/\.test\(s\)/.test(MOD));
ok('★ 크기는 100~1600 으로 접는다', /Math\.max\(100, Math\.min\(1600,/.test(MOD));
ok('★ 폴백은 한 번만 — 무한 루프 금지', /img\.dataset\.tf/.test(MOD));
ok('★ 원본도 없으면 깨진 아이콘 대신 빈 칸', /removeAttribute\('src'\)/.test(MOD));
ok('★ 모듈에 프록시 URL 규칙 사본이 없다(full 은 호출부가 넘긴다)', (() => {
  /* ⚠ 설명 주석에 경로가 적혀 있다 — **주석을 지우고** 코드만 본다(주석이 대신 통과/실패시키면
     검사가 조용히 무의미해진다). 이 모듈에는 블록주석 종료 표시를 품는 정규식 리터럴이 없어 안전하다. */
  const code = MOD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return !/api\/drive\/image/.test(code);
})());
ok('★ CDN URL 규칙은 모듈에만 — 다른 번들에 사본이 없다', (() => {
  const others = { 'workdesk.html': WD, 'search-app.js': SA, 'cs-review-edit-card.js': CS,
    'index.html': IX };
  return Object.entries(others).every(([, s]) => !/drive\.google\.com\/thumbnail\?id=/.test(s));
})());

console.log('\nB) 실행 — 속성·폴백 (grep 만으로는 "그린다"를 못 본다)');
{
  const sb = { window: {}, console };
  sb.window = sb;                      // 모듈이 window.DriveThumb 에 붙인다
  vm.createContext(sb);
  vm.runInContext(MOD, sb);
  const T = sb.DriveThumb;

  const FID = 'F1aaaaaaaaaaaaaaaaaaaa';
  const FULL = 'https://api.example.com/api/drive/image/' + FID;

  ok('CDN URL — drive.google.com/thumbnail + sz',
    T.url(FID, 600) === 'https://drive.google.com/thumbnail?id=' + FID + '&sz=w600', T.url(FID, 600));
  ok('★ 크기 상한 적용', T.url(FID, 99999).endsWith('sz=w1600'), T.url(FID, 99999));
  ok('★ 불량 fileId 는 빈 문자열', T.url('짧음', 400) === '');

  const a = T.attrs(FID, 600, FULL);
  ok('src 는 CDN', /src="https:\/\/drive\.google\.com\/thumbnail\?id=/.test(a), a);
  ok('data-full 에 원본 프록시 URL', a.includes('data-full="' + FULL + '"'), a);
  ok('onerror 폴백 배선', /onerror="DriveThumb\.fall\(this\)"/.test(a), a);

  const bad = T.attrs('짧음', 600, FULL);
  ok('★ 불량 fileId = 종전 동작(원본만, onerror 없음)',
    bad.includes('src="' + FULL + '"') && !/onerror/.test(bad), bad);

  const img = { dataset: {}, attrs: { 'data-full': FULL }, src: 'CDN',
    getAttribute(k) { return this.attrs[k]; }, removeAttribute() { this.removed = true; } };
  T.fall(img);
  ok('★ 폴백 1회차 — 원본 프록시로 갈아탄다', img.src === FULL, img.src);
  img.src = 'SECOND'; T.fall(img);
  ok('★ 폴백 2회차는 아무 일도 하지 않는다(무한 루프 금지)', img.src === 'SECOND', img.src);

  const img2 = { dataset: {}, getAttribute() { return ''; }, removeAttribute() { this.removed = true; } };
  T.fall(img2);
  ok('★ 원본 URL 이 없으면 src 를 제거', img2.removed === true);
}

console.log('\nC) 소비처 — 썸네일 자리만 CDN');
ok('① 작업보드 제출물 미리보기 패널(rvone)',
  /<img class="rvone"\$\{_thumbAttrs\(list\[i\]\.fileId,600,list\[i\]\.url\)\}/.test(WD));
ok('② 리뷰검수 카드 썸네일', /<img\$\{_thumbAttrs\(r\.file_id,400,thumb\)\}/.test(WD));
ok('③ 중복 정리 확인 팝업의 비교 2장',
  (WD.match(/_thumbAttrs\((?:r\.file_id|dup\.matchFileId),400,_riImg\(/g) || []).length === 2);
ok('④ 리뷰어 중복 안내 목록(34×44)', /DriveThumb\.attrs\(it\.reviewFileId, 400, _tu\)/.test(SA));
ok('⑤ 리뷰어 중복 경고 카드(44×58)', /DriveThumb\.attrs\(d\.fileId, 400, _du\)/.test(SA));
ok('⑥ C/S 교체요청 카드(132×132)', /DriveThumb\.attrs\(fileId, 400, u\)/.test(CS));
ok('⑦ 리뷰 보고 페이지 그리드(150px)', /DriveThumb\.attrs\(im\.id, 400, IMG\(im\.id\)\)/.test(RP));
ok('⑧ 캡처 정리 인라인 펼침(440px) — 원본 우선 순서를 뒤집었다',
  /DriveThumb\.attrs\(id, 800, proxy\)/.test(IA));

console.log('\nC-2) 원본 유지 자리 (완화 금지)');
ok('★ 작업보드 크게 보기 팝업은 원본 프록시', (() => {
  const b = bodyOf(WD, '_rvPopCol');
  return /<img src="\$\{esc\(list\[i\]\.url\)\}"/.test(b) && !/_thumbAttrs/.test(b);
})());
ok('★ 검수 상세의 대조 이미지(rizoomable)는 원본',
  (WD.match(/class="rizoomable" src="\$\{_riImg\(/g) || []).length >= 3);
ok('★ C/S 교체요청 확대(zoomPair)는 원본', /var uOld = imgUrl\(oldId\), uNew = imgUrl\(newId\);/.test(CS));
ok('★ 리뷰 보고 라이트박스·이미지 저장은 원본',
  /im\.src=IMG\(id\);/.test(RP) && /dl\.href=IMG\(id\);/.test(RP));
ok('★ 원본 프록시 URL 규칙(_rvUrl/_riImg/imgUrl)은 그대로',
  /function _rvUrl\(id\)\{ return \/\^\[-\\w\]\{20,\}\$\/\.test\(String\(id\|\|''\)\) \? API_BASE\+'\/api\/drive\/image\/'/.test(WD)
  && /function _riImg\(id\)\{ return \/\^\[-\\w\]\{20,\}\$\/\.test\(String\(id\|\|''\)\) \? API_BASE\+'\/api\/drive\/image\/'/.test(WD)
  && /_base\(\) \+ '\/api\/drive\/image\/' \+ encodeURIComponent\(id\)/.test(CS));
ok('★ 서버 무접촉 — 프록시에는 종전 302 폴백 하나뿐', (() => {
  const S = R('server/src/routes/drive.routes.js');
  return (S.match(/thumbnail\?id=/g) || []).length === 1 && /redirect\(302,/.test(S);
})());

console.log('\nD) 배선 — 스크립트 태그 · 모듈 부재 시 원본으로 접는다');
{
  const pages = ['frontend/search.html', 'frontend/admin.html', 'frontend/admin-siand.html',
    'frontend/index.html', 'frontend/workdesk.html', 'frontend/report.html'];
  const missing = pages.filter(p => !/<script src="js\/drive-thumb\.js"><\/script>/.test(R(p)));
  ok('★ 소비처를 로드하는 6개 페이지 전부에 script 태그', missing.length === 0, missing.join(','));
  // api.js 보다 뒤(= API_BASE_URL 이 먼저) — 순서 계약
  /* ⚠ 위치 비교는 **태그 문자열**로 한다 — 파일 안 설명 주석이 먼저 나오면 오판한다(실측). */
  ok('★ api.js 다음에 온다', pages.every(p => {
    const s = R(p);
    return s.indexOf('<script src="js/drive-thumb.js"></script>') > s.indexOf('<script src="api.js"></script>');
  }));
}
ok('★ 모듈이 없으면 원본으로 접는다 — 소비처 6곳 모두 window.DriveThumb 를 확인한다',
  (SA.match(/window\.DriveThumb \?/g) || []).length === 2
  && /window\.DriveThumb \?/.test(CS) && /window\.DriveThumb\s*$|window\.DriveThumb\n/.test(IA + '\n')
  && /window\.DriveThumb \?/.test(RP) && /window\.DriveThumb \? DriveThumb\.url\(fileId, 400\)/.test(IX)
  && /window\.DriveThumb \? DriveThumb\.attrs\(id, px, full\)/.test(WD));

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
