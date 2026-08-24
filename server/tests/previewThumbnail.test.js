/* 미리보기 썸네일(CDN) 회귀가드 — 사용자 확정 2026-08-24
 *
 * 배경(실측): 프록시 원본은 파일 1장당 1.7~1.8초(31KB 기준 · 왕복 지연 지배)인데
 *   같은 이미지의 drive.google.com/thumbnail 은 0.4초 안팎이고 바이트도 3~5배 작다.
 *   미리보기·카드 썸네일만 CDN 으로 돌리고 **원본이 필요한 자리는 프록시 그대로** 둔다.
 *
 * [A] 헬퍼 단일 출처 — 형식 검증·상한·프록시 URL 사본 0
 * [B] vm 실행 — 속성 3종(src/data-full/onerror) · 불량 id 폴백 · 폴백 1회
 * [C] 소비처 — 썸네일 자리 4곳은 CDN, 원본 자리는 프록시 유지(완화 금지)
 *
 * 실행: node tests/previewThumbnail.test.js
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = f => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
const WD = R('frontend/workdesk.html');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x ? ' — ' + String(x).slice(0, 300) : '')); } };

/** 함수 본문 잘라내기 — 다음 최상위 선언 전까지(고정 길이 슬라이스 금지) */
function body(name) {
  const at = WD.indexOf('\nfunction ' + name + '(');
  if (at < 0) throw new Error('not found: ' + name);
  const rest = WD.slice(at + 1);
  const m = rest.slice(1).search(/\n(function |const |\/\* |\/\/ ══)/);
  return rest.slice(0, m < 0 ? rest.length : m + 1);
}

console.log('\nA) 헬퍼 — 단일 출처·형식 검증·사본 0');
ok('_thumbUrl / _thumbAttrs / _thumbFall 세 함수가 있다',
  /function _thumbUrl\(/.test(WD) && /function _thumbAttrs\(/.test(WD) && /function _thumbFall\(/.test(WD));
ok('★ 파일ID 형식 검증 후에만 CDN URL 을 만든다(임의 문자열 주입 차단)',
  /\/\^\[-\\w\]\{20,\}\$\/\.test\(s\)/.test(body('_thumbUrl')));
ok('★ 프록시 URL 규칙 사본 0 — full 은 호출부가 만든 값을 넘긴다',
  !/api\/drive\/image/.test(body('_thumbUrl')) && !/api\/drive\/image/.test(body('_thumbAttrs')));
ok('★ 크기는 상·하한으로 접는다(임의 값 방지)',
  /Math\.max\(100,\s*Math\.min\(1600,/.test(body('_thumbUrl')));
ok('★ 폴백은 한 번만 — 무한 루프 금지', /dataset\.tf/.test(body('_thumbFall')));
ok('★ 원본도 없으면 깨진 아이콘 대신 빈 칸', /removeAttribute\('src'\)/.test(body('_thumbFall')));

console.log('\nB) 실행 — 속성·폴백 (grep 만으로는 "그린다"를 못 본다)');
{
  const sb = {
    esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    console,
  };
  vm.createContext(sb);
  vm.runInContext([body('_thumbUrl'), body('_thumbAttrs'), body('_thumbFall')].join('\n'), sb);

  const FID = 'F1aaaaaaaaaaaaaaaaaaaa';
  const FULL = 'https://api.example.com/api/drive/image/' + FID;

  const u = sb._thumbUrl(FID, 600);
  ok('CDN URL — drive.google.com/thumbnail + sz', u === 'https://drive.google.com/thumbnail?id=' + FID + '&sz=w600', u);
  ok('★ 크기 상한 적용', sb._thumbUrl(FID, 99999).endsWith('sz=w1600'), sb._thumbUrl(FID, 99999));
  ok('★ 불량 fileId 는 빈 문자열(종전과 동일)', sb._thumbUrl('짧음', 400) === '');

  const a = sb._thumbAttrs(FID, 600, FULL);
  ok('src 는 CDN', /src="https:\/\/drive\.google\.com\/thumbnail\?id=/.test(a), a);
  ok('data-full 에 원본 프록시 URL', a.includes('data-full="' + FULL + '"'), a);
  ok('onerror 폴백 배선', /onerror="_thumbFall\(this\)"/.test(a), a);

  const bad = sb._thumbAttrs('짧음', 600, FULL);
  ok('★ 불량 fileId = 종전 동작(원본만, onerror 없음)',
    bad.includes('src="' + FULL + '"') && !/onerror/.test(bad), bad);

  // 폴백 실행
  const img = { dataset: {}, attrs: { 'data-full': FULL }, src: u,
    getAttribute(k) { return this.attrs[k]; }, removeAttribute() { this.removed = true; } };
  sb._thumbFall(img);
  ok('★ 폴백 1회차 — 원본 프록시로 갈아탄다', img.src === FULL, img.src);
  img.src = 'SECOND';
  sb._thumbFall(img);
  ok('★ 폴백 2회차는 아무 일도 하지 않는다(무한 루프 금지)', img.src === 'SECOND', img.src);

  const img2 = { dataset: {}, attrs: {}, getAttribute() { return ''; }, removeAttribute() { this.removed = true; } };
  sb._thumbFall(img2);
  ok('★ 원본 URL 이 없으면 src 를 제거', img2.removed === true);
}

console.log('\nC) 소비처 — 썸네일 자리만 CDN, 원본 자리는 그대로');
ok('제출물 미리보기 패널(rvone) = 썸네일',
  /<img class="rvone"\$\{_thumbAttrs\(list\[i\]\.fileId,600,list\[i\]\.url\)\}/.test(WD));
ok('리뷰검수 카드 썸네일 = 썸네일', /<img\$\{_thumbAttrs\(r\.file_id,400,thumb\)\}/.test(WD));
ok('중복 정리 확인 팝업의 비교 2장 = 썸네일',
  (WD.match(/_thumbAttrs\((?:r\.file_id|dup\.matchFileId),400,_riImg\(/g) || []).length === 2);

ok('★ 크게 보기 팝업은 원본 프록시 유지(대조용 — 완화 금지)', (() => {
  const b = body('_rvPopCol');
  return /<img src="\$\{esc\(list\[i\]\.url\)\}"/.test(b) && !/_thumbAttrs/.test(b);
})());
ok('★ 검수 상세의 대조 이미지(rizoomable)는 원본 유지',
  (WD.match(/class="rizoomable" src="\$\{_riImg\(/g) || []).length >= 3
  && !/rizoomable"\$\{_thumbAttrs/.test(WD));
ok('★ _rvUrl / _riImg(원본 프록시 규칙)는 그대로 — 팝업·판정이 계속 쓴다',
  /function _rvUrl\(id\)\{ return \/\^\[-\\w\]\{20,\}\$\/\.test\(String\(id\|\|''\)\) \? API_BASE\+'\/api\/drive\/image\/'/.test(WD)
  && /function _riImg\(id\)\{ return \/\^\[-\\w\]\{20,\}\$\/\.test\(String\(id\|\|''\)\) \? API_BASE\+'\/api\/drive\/image\/'/.test(WD));
ok('★ 서버 무접촉 — 프록시에는 종전 302 폴백 하나뿐(새 썸네일 경로를 만들지 않았다)', (() => {
  const S = R('server/src/routes/drive.routes.js');
  return (S.match(/thumbnail\?id=/g) || []).length === 1 && /redirect\(302,/.test(S);
})());

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
