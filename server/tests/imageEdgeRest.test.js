'use strict';
/**
 * 결정 354 「남은 화면(2026-11-09)」 — 아직 빠른 길(R2 엣지 /img/…)이 아니던 화면을 옮긴다.
 *   ① 리뷰어 화면(비로그인 · 리뷰어 세션) — 그 사진 번호를 내주는 서버 응답이 서명 주소를 함께 싣는다
 *      (보고 페이지 withThumbs 와 같은 방식 · 무인증 서명 입구를 새로 열지 않는다)
 *   ② 가이드·공고 사진 — 저장 값(주소)은 그대로, 응답이 서명을 싣고 화면이 그릴 때 갈아 끼운다(m/t)
 *   ③ 업체(광고주) 화면 — 업체 스코프를 통과한 review-images 응답이 서명을 싣는다(/img/sign 은 광고주에게 닫힌 채)
 * 실패 사다리는 drive-thumb.js 한 곳(빠른 길 → 종전 주소 → 화면 자기 폴백), 서명 열쇠가 없으면 응답에 싣지 않는다.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER = path.resolve(__dirname, '..');
const ROOT = path.resolve(SERVER, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

process.env.IMG_SIGNING_KEY = 'k'.repeat(48);
const edge = require(path.join(SERVER, 'src/services/imageEdge.service'));
const allow = require(path.join(SERVER, 'src/services/imageAllowlist.service'));

const id = (tag) => (tag + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3').slice(0, 33);
const G1 = id('GDA'), G2 = id('GDB'), D1 = id('DRA'), NO = id('NOP'), FO = id('FOP');

let dbDown = false;
const queried = [];
allow.__setPoolForTest({ async query(sql, [fid]) {
  queried.push(fid);
  if (dbDown || fid === FO) throw new Error('db down');
  const guide = /guide_image_files/.test(sql);
  const allowed = guide ? [G1, G2].includes(fid) : fid === D1;
  return { rows: [{ private: false, allowed }] };
} });

function withoutKey(fn) {
  const save = process.env.IMG_SIGNING_KEY; process.env.IMG_SIGNING_KEY = '';
  return Promise.resolve().then(fn).finally(() => { process.env.IMG_SIGNING_KEY = save; });
}

// ─────────────────────────── A. 서버 단일 출처 ───────────────────────────
test('A1) guideIdsIn — 저장된 가이드 값 속 우리 가이드 사진 주소·드라이브 주소에서만 번호를 뽑는다', () => {
  const v = {
    workDetail: {
      inflowGuideHtml: `<p>검색</p><img src="https://x.up.railway.app/api/order/guide-image/${G1}" alt="">`,
      reviewGuide: `참고 https://drive.google.com/file/d/${D1}/view?usp=sharing 그리고 https://evil.example/${NO}`,
      reviewGuideImages: [`https://review-web-system.pages.dev/api/order/guide-image/${G1}`],
      nested: [{ deep: `https://drive.google.com/thumbnail?id=${G2}&sz=w1600` }],
    },
    n: 3, b: null,
  };
  assert.deepEqual(edge.guideIdsIn(v).sort(), [G1, G2, D1].sort());
  assert.deepEqual(edge.guideIdsIn('그냥 글'), []);
  assert.equal(edge.guideIdsIn(Array.from({ length: 100 }, (_, i) => `https://h/api/order/guide-image/${id('Z' + i)}`)).length, 40, '상한 40');
});

test('A2) signAllowed — 허용 목록 통과 번호만 서명 · 조회 실패(fail-open)는 서명 0 · 열쇠 없으면 {}', async () => {
  const out = await edge.signAllowed([G1, NO, FO, D1, G1, 'short'], 'm');
  assert.deepEqual(Object.keys(out).sort(), [G1, D1].sort());
  assert.match(out[G1], /^\/img\/m\/[-\w]+\?e=\d+&s=[-\w]{43}$/);
  assert.equal(out[G1], edge.signImage(G1, 'm'), '서명은 signImage 한 곳');
  await withoutKey(async () => { assert.deepEqual(await edge.signAllowed([G1], 'm'), {}); });
  assert.deepEqual(await edge.signAllowed([G1], 'x'), {}, '모르는 kind 0');
});

test('A3) signAllowed budgetMs — 판정이 늦으면 기다리지 않고 그때까지 끝난 것만(화면은 종전 길)', async () => {
  allow.__setPoolForTest({ query: () => new Promise(r => setTimeout(() => r({ rows: [{ private: false, allowed: true }] }), 400)) });
  try {
    const t0 = Date.now();
    const out = await edge.signAllowed([id('SLW')], 't', { budgetMs: 50 });
    assert.ok(Date.now() - t0 < 300, '예산 안에 돌아온다');
    assert.deepEqual(out, {});
  } finally {
    allow.__setPoolForTest({ async query(sql, [fid]) {
      if (dbDown || fid === FO) throw new Error('db down');
      const guide = /guide_image_files/.test(sql);
      return { rows: [{ private: false, allowed: guide ? [G1, G2].includes(fid) : fid === D1 }] };
    } });
  }
});

test('A4) 일괄 서명 입구는 같은 signAllowed 를 태운다(판정 사본 0)', () => {
  const s = strip(R('server/src/routes/imageEdge.routes.js'));
  assert.match(s, /edge\.signAllowed\(/);
  assert.doesNotMatch(s, /checkGuideImage|checkDriveImage/, '판정은 서비스 한 곳(allowVerdict)');
});

test('A5) signedList — 서버가 고른 번호 목록 → 서명 주소 배열(열쇠 없으면 빈 배열)', async () => {
  const l = edge.signedList([D1, D1, 'bad', G1], 'm');
  assert.equal(l.length, 2);
  assert.ok(l.every(u => /^\/img\/m\//.test(u)));
  await withoutKey(() => { assert.deepEqual(edge.signedList([D1], 'm'), []); });
});

// ─────────────────────────── B. 응답 배선(서버) ───────────────────────────
test('B1) 리뷰어 화면 응답 — 내 제출 현황 · 중복 안내 · 수정요청 파일 목록이 서명 주소 t 를 싣는다', () => {
  const search = strip(R('server/src/services/search.service.js'));
  const n = (search.match(/reviewThumb:\s*_thumbT\(row\.reviewFileId\)/g) || []).length;
  assert.equal(n, 2, '검색 응답 두 곳(본검색·대체검색) 모두');
  assert.match(search, /function _thumbT\(fid\)[\s\S]{0,200}signImage\(fid, 't'\)/);
  const diag = strip(R('server/src/routes/diag.routes.js'));
  assert.match(diag, /findOwnDuplicate\([\s\S]{0,400}?\)\s*;?[\s\S]{0,200}imageEdge\.signImage\(\w+\.fileId, 't'\)/);
  const re = strip(R('server/src/routes/reviewEdit.routes.js'));
  assert.match(re, /files: files\.map\(f => _withT\(\{/);
  assert.match(re, /function _withT\(o\)[\s\S]{0,200}signImage\(o\.fileId, 't'\)/);
});

test('B2) 가이드 사진 — 리뷰어 작업내용 응답(+관리자 미리보기)이 guideThumbs(m)를 싣는다 · 저장 값 불변', () => {
  const c = strip(R('server/src/routes/campaign.routes.js'));
  const n = (c.match(/guideThumbs: await _guideThumbs\(/g) || []).length;
  assert.equal(n, 2, '/:id/work-detail 과 /admin/:id/preview 두 곳');
  assert.match(c, /async function _guideThumbs\([\s\S]{0,400}imageEdge\.signAllowed\(imageEdge\.guideIdsIn\(parts\), 'm'/);
  assert.match(c, /guideThumbs\.push|Object\.values\(/);
  // 저장 경로는 이 함수를 부르지 않는다(응답에만 가산)
  assert.doesNotMatch(c, /UPDATE[^`]*guideThumbs/);
});

test('B3) 공고 목록 — thumbs(t)를 싣되 예산 안에서만(목록 지연 0에 가깝게)', () => {
  const c = strip(R('server/src/routes/campaign.routes.js'));
  assert.match(c, /res\.json\(\{ ok: true, data, serverNow: now\.toISOString\(\)(, \.\.\.\(thumbs \? \{ thumbs \} : \{\}\))? \}\)/);
  assert.match(c, /const thumbs = await _listThumbs\(data\)/);
  assert.match(c, /async function _listThumbs\([\s\S]{0,600}signAllowed\([^)]*'t',\s*\{\s*budgetMs:/);
});

test('B4) 업체 화면 — review-images 는 업체 스코프 통과 뒤 같은 rows 에서만 서명(m) · 내부인은 싣지 않는다', () => {
  const t = R('server/src/routes/trackB.routes.js');   // strip() 은 '/api/trackb/*' 같은 문자열에서 주석으로 오인해 지운다
  const i = t.indexOf("router.get('/workdesk/review-images'");
  const body = t.slice(i, t.indexOf('function _reviewImageIds', i));
  assert.ok(i > 0);
  assert.ok(body.indexOf('_ensureThreadScope') < body.indexOf('signedList'), '스코프 판정 뒤');
  assert.match(body, /const rows = await svc\.reviewImagesForTab\(/);
  assert.match(body, /!includeReceipt \? \{ edge: imageEdge\.signedList\(_reviewImageIds\(rows\), 'm'\) \}/);
  // 광고주에게 일괄 서명 입구를 열지 않는다
  assert.match(t, /router\.post\('\/img\/sign', authMiddleware, internalMiddleware,/);
});

test('B5) _reviewImageIds — 그 응답 rows 의 번호만(다른 탭 번호가 섞일 길 없음)', () => {
  const t = R('server/src/routes/trackB.routes.js');
  const m = t.match(/function _reviewImageIds\(rows\) \{[\s\S]*?\n\}/);
  assert.ok(m, '함수가 있다');
  const fn = new Function(`${m[0]}; return _reviewImageIds;`)();
  const rows = { 3: [{ fileId: D1, slot: 'review' }, { fileId: G1, slot: 'capture' }], 7: [{ fileId: D1 }], 9: [{}] };
  assert.deepEqual(fn(rows).sort(), [D1, G1].sort());
  assert.deepEqual(fn(null), []);
});

// ─────────────────────────── C. 화면 단일 출처(drive-thumb) — vm 실행 ───────────────────────────
function loadThumb({ token } = {}) {
  const mem = token ? { admin_token: token } : {};
  const fetches = [];
  const imgs = [];
  const timers = [];
  const sb = {
    console, Date, JSON, Math, Object, String, Number, Promise, RegExp, Array,
    setTimeout: (fn) => { timers.push(fn); return 1; },
    sessionStorage: { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } },
    fetch: (u, init) => { fetches.push({ u, init }); return Promise.resolve({ ok: true, json: () => Promise.resolve(sb.__reply || null) }); },
    document: { querySelectorAll: () => imgs.filter(i => i.a['data-dt'] === 'g' && i.a['data-dt-id']) },
    API_BASE_URL: 'https://api.example.com',
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(R('frontend/js/drive-thumb.js'), sb);
  const tick = async () => { while (timers.length) timers.shift()(); for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { T: sb.DriveThumb, sb, fetches, imgs, tick };
}
function mkImg(attrStr, imgs) {
  const a = {}; attrStr.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { a[k] = v.replace(/&amp;/g, '&'); });
  const img = { a, dataset: {}, complete: false, naturalWidth: 0, tagName: 'IMG',
    getAttribute(k) { return k in this.a ? this.a[k] : null; }, setAttribute(k, v) { this.a[k] = String(v); },
    hasAttribute(k) { return k in this.a; }, removeAttribute(k) { delete this.a[k]; },
    get src() { return this.a.src; }, set src(v) { this.a.src = v; } };
  if (imgs) imgs.push(img);
  return img;
}
const EXP = () => Math.floor(Date.now() / 1000) + 12 * 3600;
const SIG = 'A'.repeat(43);
const PROXY = `https://api.example.com/api/order/guide-image/${G1}`;
const GTHUMB = `https://drive.google.com/thumbnail?id=${G2}&sz=w1600`;

test('C1) guideId — 가이드 프록시·구글 썸네일 주소만 번호로 본다', () => {
  const { T } = loadThumb();
  assert.equal(T.guideId(PROXY), G1);
  assert.equal(T.guideId(GTHUMB), G2);
  assert.equal(T.guideId('https://cdn.coupang.com/x.jpg'), '');
  assert.equal(T.guideId(`https://api.example.com/api/drive/image/${D1}`), '', '리뷰 캡처 원본 통로는 이 길이 아니다');
  assert.equal(T.guideId(''), '');
});

test('C2) guideAttrs — 서명이 없고 직원 토큰도 없으면 종전과 같은 src 한 개(+화면 자기 onerror)', async () => {
  const { T, fetches, tick } = loadThumb();
  assert.equal(T.guideAttrs(PROXY, 1600), ` src="${PROXY}"`);
  assert.equal(T.guideAttrs(PROXY, 1600, '_woImgError(this)'), ` src="${PROXY}" onerror="_woImgError(this)"`);
  assert.equal(T.guideAttrs('https://cdn.example/x.jpg', 400), ' src="https://cdn.example/x.jpg"');
  await tick();
  assert.equal(fetches.length, 0, '무인증 화면은 서명을 묻지 않는다');
});

test('C3) guideAttrs + seed — 빠른 길 먼저 · 실패하면 종전 주소 · 그것도 실패하면 화면 자기 폴백', () => {
  const { T } = loadThumb();
  const E = `/img/m/${G1}?e=${EXP()}&s=${SIG}`;
  assert.equal(T.seed([E]), 1);
  const a = T.guideAttrs(PROXY, 1600, '_woImgError(this)');
  assert.ok(a.includes(`src="${E.replace(/&/g, '&amp;')}"`), a);
  assert.match(a, /data-dt="e"/);
  assert.ok(a.includes(`data-g="${PROXY}"`), a);
  assert.match(a, /onerror="if\(!DriveThumb\.guideFall\(this\)\)\{_woImgError\(this\)\}"/);
  const img = mkImg(a);
  assert.equal(T.guideFall(img), true);
  assert.equal(img.src, PROXY, '빠른 길 실패 → 종전 주소');
  assert.equal(img.a['data-dt'], 'x');
  assert.equal(T.guideFall(img), false, '종전 주소 실패 → 화면 자기 폴백 몫(무한 루프 0)');
  assert.equal(T.guideAttrs(PROXY, 1600), ` src="${PROXY}"`, '실패한 번호는 이 페이지에서 다시 빠른 길로 가지 않는다');
  // 400 이하 = t 를 찾는다(m 서명만 있으면 종전)
  assert.equal(T.guideAttrs(PROXY, 400), ` src="${PROXY}"`);
});

test('C4) upgrade(root) — 가이드 사진 <img> 만 갈아 끼우고 다른 사진·속성은 그대로', () => {
  const { T } = loadThumb();
  const E2 = `/img/m/${G2}?e=${EXP()}&s=${SIG}`;
  T.seed([E2]);
  const g = mkImg(`src="${GTHUMB}" alt="유입가이드 이미지"`);
  const p = mkImg(`src="${PROXY}" alt="첨부"`);       // 서명 없음
  const other = mkImg('src="https://cdn.example/x.jpg"');
  const root = { querySelectorAll: () => [g, p, other] };
  assert.equal(T.upgrade(root, 1600), 1);
  assert.equal(g.src, E2);
  assert.equal(g.a['data-g'], GTHUMB);
  assert.equal(g.a.onerror, 'DriveThumb.guideFall(this)');
  assert.equal(g.a.alt, '유입가이드 이미지');
  assert.equal(p.src, PROXY); assert.equal(p.a.onerror, undefined, '서명 없는 사진은 손대지 않는다');
  assert.equal(other.src, 'https://cdn.example/x.jpg');
  assert.equal(T.upgrade(null), 0);
});

test('C5) 로그인 화면(직원 토큰) — 가이드 사진도 일괄 서명으로 받아 아직 안 뜬 것만 갈아 끼운다', async () => {
  const { T, sb, fetches, imgs, tick } = loadThumb({ token: 'TOK' });
  const E = `/img/m/${G1}?e=${EXP()}&s=${SIG}`;
  sb.__reply = { ok: true, enabled: true, urls: { [G1]: E } };
  const img = mkImg(T.guideAttrs(PROXY, 1600, '_woImgError(this)'), imgs);
  assert.equal(img.src, PROXY, '처음엔 종전 주소');
  await tick();
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].u, 'https://api.example.com/api/trackb/img/sign');
  assert.deepEqual(JSON.parse(fetches[0].init.body), { kind: 'm', ids: [G1] });
  assert.equal(img.src, E, '서명이 오면 갈아 끼운다');
  assert.equal(T.guideFall(img), true);
  assert.equal(img.src, PROXY);
});

// ─────────────────────────── D. 화면 배선 ───────────────────────────
test('D1) 리뷰어 화면 4곳 — 응답의 서명을 seed 하고 그리기는 DriveThumb.attrs(사다리 사본 0)', () => {
  const sa = strip(R('frontend/js/search-app.js'));
  assert.match(sa, /DriveThumb\.seed\(list\.map\(it => it && it\.reviewThumb\)\)[\s\S]{0,1500}DriveThumb\.attrs\(it\.reviewFileId, 400, _tu\)/);
  assert.match(sa, /DriveThumb\.seed\(\[d\.t\]\)[\s\S]{0,300}DriveThumb\.attrs\(d\.fileId, 400, _du\)/);
  const ix = strip(R('frontend/index.html'));
  assert.match(ix, /DriveThumb\.seed\(_reEditFiles\.map\(f => f && f\.t\)\)/);
  assert.equal((ix.match(/_reEditImgAttrs\((f\.fileId|oldFileId)\)/g) || []).length, 2);
  assert.match(ix, /function _reEditImgAttrs\(fileId\)\{[\s\S]{0,200}DriveThumb\.attrs\(fileId, 400, _reEditImgUrl\(fileId\)\)/);
  assert.doesNotMatch(ix, /onerror="this\.onerror=null;this\.src=\\'' \+ _reEditImgUrl/, '자체 폴백 사본 제거');
});

test('D2) 가이드 사진 — 공용 렌더러가 upgrade 로 갈아 끼우고, 참여 화면이 guideThumbs 를 seed', () => {
  const cw = strip(R('frontend/js/campaign-workdetail.js'));
  assert.match(cw, /DriveThumb\.upgrade\(/);
  const ch = R('frontend/campaign.html');
  assert.match(ch, /<script src="js\/drive-thumb\.js"><\/script>/);
  assert.match(strip(ch), /DriveThumb\.seed\(j\.guideThumbs\)[\s\S]{0,400}CampWorkDetail\.renderInto\(\$\('wdCards'\)/);
  const wo = strip(R('frontend/js/work-order-detail.js'));
  assert.match(wo, /function _woImgTag\(src, openUrl\) \{[\s\S]{0,300}DriveThumb\.guideAttrs\(src, 1600, "_woImgError\(this\)"\)/);
  assert.match(wo, /data-openurl="\$\{escHtml\(openUrl \|\| src\)\}"/, '크게 보기는 원본 주소 그대로(결정 008)');
});

test('D3) 공고 목록 썸네일 — 목록 응답 thumbs 를 seed 하고 카드는 guideAttrs(t)', () => {
  const cc = strip(R('frontend/js/campaign-cards.js'));
  assert.match(cc, /<img class="pt-img"\$\{_ptImgAttrs\(c\.thumbnail_url\)\} alt="" loading="lazy">/);
  assert.match(cc, /function _ptImgAttrs\(u\)[\s\S]{0,200}DriveThumb\.guideAttrs\(u, 400\)/);
  assert.match(cc, /seedThumbs|DriveThumb\.seed\(/);
});

test('D4) 업체 화면 — 작업보드 제출물 미리보기가 review-images 응답의 edge 를 seed', () => {
  const wd = R('frontend/workdesk.html');
  assert.equal((wd.match(/(?<!function )_rvSeedEdge\(r\)/g) || []).length, 2, '_rvBoot · _capRefreshImages 두 곳');
  assert.match(wd, /function _rvSeedEdge\(r\)\{[\s\S]{0,200}DriveThumb\.seed\(r\.edge\)/);
});
