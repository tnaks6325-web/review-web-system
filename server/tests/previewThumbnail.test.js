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
// (IA = index-app.js — 옛 관리자 대시보드 폐기(결정 267)로 파일째 삭제)
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
// (결정 354 — 빠른 길 seed/edgeUrl/kindOf 가 더해졌다. url/attrs/fall 세 개는 그대로 — 검사 의미 불변)
ok('모듈이 url/attrs/fall 을 노출한다(+ 빠른 길 seed/edgeUrl/kindOf)',
  /window\.DriveThumb\s*=\s*\{\s*url: url,\s*attrs: attrs,\s*fall: fall,\s*seed: seed,\s*edgeUrl: edgeUrl,\s*kindOf: kindOf\s*\}/.test(MOD));
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

console.log('\nB-2) 결정 354 빠른 길 — 서명 주소 우선 · 실패 사다리 · 늦은 서명 갈아 끼우기 (vm 실행)');
{
  const FID = 'F1bbbbbbbbbbbbbbbbbbbb';
  const FID2 = 'F2cccccccccccccccccccc';
  const FULL = 'https://api.example.com/api/drive/image/' + FID;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const SIG = 'A'.repeat(43);
  const E1 = `/img/t/${FID}?e=${exp}&s=${SIG}`;
  const E2 = `/img/t/${FID2}?e=${exp}&s=${SIG}`;
  const mem = {};
  const fetches = [];
  let reply = null;
  const imgs = [];
  function mkImg(attrStr) {
    const a = {}; attrStr.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { a[k] = v.replace(/&amp;/g, '&'); });
    const img = { a, dataset: {}, complete: false, naturalWidth: 0,
      getAttribute(k) { return this.a[k]; }, setAttribute(k, v) { this.a[k] = String(v); },
      removeAttribute(k) { delete this.a[k]; if (k === 'src') this.removed = true; },
      get src() { return this.a.src; }, set src(v) { this.a.src = v; } };
    imgs.push(img); return img;
  }
  const timers = [];
  const sb = {
    console, Date, JSON, Math, Object, String, Number, Promise,
    setTimeout: (fn) => { timers.push(fn); return 1; },
    sessionStorage: { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } },
    fetch: (u, init) => { fetches.push({ u, init }); return Promise.resolve({ ok: true, json: () => Promise.resolve(reply) }); },
    document: { querySelectorAll: () => imgs.filter(i => i.a['data-dt'] === 'g' && i.a['data-dt-id']) },
    API_BASE_URL: 'https://api.example.com',
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(MOD, sb);
  const T = sb.DriveThumb;
  const tick = async () => { while (timers.length) timers.shift()(); for (let i = 0; i < 5; i++) await Promise.resolve(); };

  (async () => {
    // ① 비로그인(토큰 없음) = 서명 요청 0 · 종전 그대로
    let a = T.attrs(FID, 400, FULL); await tick();
    ok('★ 토큰 없는 화면은 서명을 묻지 않는다(무인증 화면은 seed 로만)', fetches.length === 0 && /src="https:\/\/drive\.google\.com\/thumbnail/.test(a), a);
    // ② seed → attrs 가 빠른 길을 먼저 쓴다(+ 구글·원본 사다리 속성)
    ok('seed 는 형식이 맞는 서명 주소만 받는다', T.seed([E1, 'https://evil.example/img/t/x', '/img/t/' + FID + '?e=1&s=' + SIG, undefined]) === 1);
    a = T.attrs(FID, 400, FULL);
    ok('★ 서명 주소가 있으면 src = 우리 사이트 빠른 길', a.includes('src="' + E1.replace(/&/g, '&amp;') + '"') && /data-dt="e"/.test(a), a);
    ok('★ 사다리 속성 — 구글(data-g) · 원본(data-full) · onerror', /data-g="https:\/\/drive\.google\.com\/thumbnail\?id=/.test(a) && a.includes('data-full="' + FULL + '"') && /onerror="DriveThumb\.fall\(this\)"/.test(a), a);
    ok('★ 401~1600 은 m(크게 보기용), 400 이하는 t', T.kindOf(600) === 'm' && T.kindOf(400) === 't' && T.edgeUrl(FID, 'm') === '');
    // ③ 실패 사다리: 빠른 길 → 구글 → 원본 → 멈춤
    const img = mkImg(a);
    T.fall(img);
    ok('★ 빠른 길 실패 1회차 → 구글 썸네일', /^https:\/\/drive\.google\.com\/thumbnail/.test(img.src) && img.a['data-dt'] === 'g', img.src);
    T.fall(img);
    ok('★ 2회차 → 원본 프록시', img.src === FULL, img.src);
    img.src = 'THIRD'; T.fall(img);
    ok('★ 3회차는 아무 일도 하지 않는다(무한 루프 금지)', img.src === 'THIRD');
    ok('★ 빠른 길이 한 번 실패한 사진은 이 페이지에서 다시 쓰지 않는다', T.edgeUrl(FID, 't') === '' && /data-dt="g"/.test(T.attrs(FID, 400, FULL)));
    // ④ 로그인 화면: 서명을 한 번에 묻고, 늦게 온 서명으로 아직 안 뜬 사진만 갈아 끼운다
    mem.admin_token = 'TOK';
    reply = { ok: true, enabled: true, urls: { [FID2]: E2 } };
    const pending = mkImg(T.attrs(FID2, 400, FULL));
    const loaded = mkImg(T.attrs('F3dddddddddddddddddddd', 400, FULL)); loaded.complete = true; loaded.naturalWidth = 400;
    await tick();
    const f = fetches[0];
    const body = f && JSON.parse(f.init.body);
    ok('★ 일괄 서명 1회 — POST /api/img/sign · 직원 토큰 · kind t · 두 장 같이', fetches.length === 1 && f.u === 'https://api.example.com/api/img/sign'
      && f.init.headers.Authorization === 'Bearer TOK' && body.kind === 't' && body.ids.length === 2, JSON.stringify(body));
    ok('★ 늦게 온 서명 → 아직 안 뜬 사진은 빠른 길로 갈아 끼운다', pending.src === E2 && pending.a['data-dt'] === 'e', pending.src);
    ok('★ 이미 다 뜬 사진은 건드리지 않는다', /^https:\/\/drive\.google\.com/.test(loaded.src));
    // 구글이 이미 실패해 원본으로 가던 사진도 갈아 끼우고, 빠른 길이 또 실패하면 원본으로 되돌린 뒤 멈춘다
    {
      const FID6 = 'F6gggggggggggggggggggg';
      T.seed([`/img/t/${FID6}?e=${exp}&s=${SIG}`]);
      const slow = mkImg(T.attrs(FID6, 400, FULL).replace('data-dt="e"', 'data-dt="g"'));
      slow.dataset.tf = '1'; slow.src = FULL;
      T.seed([`/img/t/${FID6}?e=${exp}&s=${SIG}`]);
      ok('★ 느린 원본으로 가던 사진도 빠른 길로 갈아 끼운다', slow.a['data-dt'] === 'e' && /^\/img\/t\//.test(slow.src), slow.src);
      T.fall(slow);
      ok('★ 그 빠른 길이 실패하면 원본으로 되돌린다(구글은 이미 실패)', slow.src === FULL && slow.a['data-dt'] === 'x', slow.src);
      slow.src = 'AFTER'; T.fall(slow);
      ok('★ 그다음 실패는 멈춘다(무한 루프 금지)', slow.src === 'AFTER');
    }
    T.attrs('F3dddddddddddddddddddd', 400, FULL); await tick();
    ok('★ 서명을 못 받은 번호(허용 목록 밖)는 다시 묻지 않는다', fetches.length === 1);
    ok('서명은 탭 보관소(sessionStorage)에 남아 새로고침 첫 화면부터 빠른 길', /F2c/.test(mem.dt_edge_v1 || ''));
    // ⑤ 서버가 꺼 두면(enabled:false) 그 페이지에서 그만 묻는다
    reply = { ok: true, enabled: false, urls: {} };
    T.attrs('F4eeeeeeeeeeeeeeeeeeee', 400, FULL); await tick();
    T.attrs('F5ffffffffffffffffffff', 400, FULL); await tick();
    ok('★ 서버가 빠른 길을 꺼 두면(열쇠 없음) 한 번 묻고 그친다', fetches.length === 2, fetches.length);
    ok('★ 모듈 코드에 원본 프록시 주소 규칙이 여전히 없다', !/api\/drive\/image/.test(MOD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
    ok('★ 보고 페이지는 응답이 실어 준 서명(t)을 seed 로 넣는다', /DriveThumb\.seed\(data\.images\.map\(function\(im\)\{ return im\.t; \}\)\)/.test(RP));
    finish();
  })().catch(e => { ok('B-2 실행', false, e && e.stack); finish(); });
}

function finish() {
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
// ⑧ (옛 대시보드 「리뷰 캡처 정리」 인라인 펼침은 결정 186 72번에서 창째 제거 · 옛 대시보드 자체가 결정 267 로 폐기 — 검사 대상 파일 없음)

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
  const pages = ['frontend/search.html',
    'frontend/index.html', 'frontend/workdesk.html', 'frontend/report.html'];   // (admin-siand.html 은 결정 186 44번 · admin.html 은 결정 267 에서 제거)
  const missing = pages.filter(p => !/<script src="js\/drive-thumb\.js"><\/script>/.test(R(p)));
  ok('★ 소비처를 로드하는 4개 페이지 전부에 script 태그', missing.length === 0, missing.join(','));
  // api.js 보다 뒤(= API_BASE_URL 이 먼저) — 순서 계약
  /* ⚠ 위치 비교는 **태그 문자열**로 한다 — 파일 안 설명 주석이 먼저 나오면 오판한다(실측). */
  ok('★ api.js 다음에 온다', pages.every(p => {
    const s = R(p);
    return s.indexOf('<script src="js/drive-thumb.js"></script>') > s.indexOf('<script src="api.js"></script>');
  }));
}
ok('★ 모듈이 없으면 원본으로 접는다 — 소비처 5곳 모두 window.DriveThumb 를 확인한다',
  (SA.match(/window\.DriveThumb \?/g) || []).length === 2
  && /window\.DriveThumb \?/.test(CS)
  && /window\.DriveThumb \?/.test(RP) && /window\.DriveThumb \? DriveThumb\.url\(fileId, 400\)/.test(IX)
  && /window\.DriveThumb \? DriveThumb\.attrs\(id, px, full\)/.test(WD));

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
}
