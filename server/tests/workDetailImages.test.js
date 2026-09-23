/**
 * workDetailImages.test.js — 작업내용 3칸 첨부 이미지 회귀가드
 * 시안 = frontend/docs/design-workdetail-images.html (사용자 확정 2026-08-07)
 *
 * 고정하는 것(완화 금지):
 *  A. 유입가이드 분해→조립 왕복이 **바이트 동일**(글 미수정 시) — 기존 저장분 무손상의 근거
 *  B. 글을 고쳐도 **사진 토큰이 전부 살아남는다** / 순서를 바꾸면 그 순서로 저장된다 — 이 변경의 존재 이유
 *  C. 서버가 **남의 주소·5장째를 버린다** — work_detail 은 JSONB 통째 저장이라 검증이 없으면
 *     임의 주소가 리뷰어 화면의 <img src> 로 그대로 나간다
 *  D. 리뷰어 화면에서 **같은 사진이 두 번 나오지 않는다**(배열 ↔ 유입가이드 카드 추출 중복)
 *  E. **평문 칸이 HTML 로 승격되지 않았다** — reviewGuide/specialNotes 는 여전히 escape 경로
 *     (승격하면 기존 저장분의 '<옵션>' 같은 꺾쇠가 태그로 오인돼 통째로 삭제된다)
 *  F. 넣는 길 3가지가 **한 함수**로 수렴 · onclick 에 주소 문자열 없음 · 팝업 body 직속 ·
 *     키 리스너 1회 · 인플라이트 중 저장 차단
 *
 * 실행: node server/tests/workDetailImages.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const ok = (name, cond) => { assert(cond === true, name); console.log('  ✓ ' + name); pass++; };

const FE = path.join(__dirname, '..', '..', 'frontend', 'js');
const recjs = fs.readFileSync(path.join(FE, 'index-recruit.js'), 'utf8');
const modaljs = fs.readFileSync(path.join(FE, 'recruit-modal.js'), 'utf8');
const wdjs = fs.readFileSync(path.join(FE, 'campaign-workdetail.js'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'campaign.routes.js'), 'utf8');

const TOK = (c) => c.repeat(24);
const URL_OF = (c, host) => `https://${host || 'api.test'}/api/order/guide-image/${TOK(c)}`;

/* ══════════════════════════════════════════════════════════════════════
   위젯 블록을 vm 으로 꺼내 **실제 실행**한다.
   ★ grep 만으로는 스코프·실행경로를 못 본다(레포에 실측 선례가 여럿) —
     조립·분해는 값이 맞는지를 실행으로 봐야 한다.
   ══════════════════════════════════════════════════════════════════════ */
function extractIgBlock() {
  const s = recjs.indexOf('const _IG_MAX = 4;');
  const e = recjs.indexOf('/* 키 리스너는 최상위 1회');
  assert(s > 0 && e > s, '🖼 위젯 블록을 찾지 못함 — 경계 주석이 바뀌었으면 이 테스트도 갱신할 것');
  return recjs.slice(s, e);
}

function makeSandbox() {
  const els = {};
  const el = (id) => (els[id] = els[id] || {
    id, value: '', textContent: '', className: '', innerHTML: '', dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, appendChild() {}, click() {},
  });
  const sandbox = {
    console, setTimeout, clearTimeout,
    document: { getElementById: el, createElement: () => el('__new'), body: { appendChild() {} },
                addEventListener() {} },
    escHtml: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    API_BASE_URL: '', _getAuthHeaders: () => ({}), showToast() {}, confirm: () => true,
    _onPreviewInput() {}, fetch: () => Promise.reject(new Error('no net')),
    _els: els,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // const/let 은 vm 컨텍스트의 렉시컬 스코프라 sandbox 프로퍼티가 되지 않는다 → 끝에서 꺼내 붙인다
  vm.runInContext(extractIgBlock()
    + '\n;globalThis.__ig={_IG_MAX,_igOk,_igUrls,_igBusy,_igTok,_igSetList,'
    + '_igSplitInflow,_igComposeInflow,_igLoadInflowHtml,_igImgTags};', sandbox);
  Object.assign(sandbox, sandbox.__ig);
  return sandbox;
}

console.log('\n=== A. 유입가이드 분해 → 조립 왕복 ===');
{
  const S = makeSandbox();
  const orig = `<p>쿠팡 검색어 : 장수매트</p><img src="${URL_OF('a')}"><p>두 번째 안내</p><img src="${URL_OF('b')}">`;
  const text = S._igLoadInflowHtml(orig);
  S.window._wdInflowRawHtml = orig;
  const ta = S.document.getElementById('rf_wd_inflow');
  ta.dataset.rawHtml = '1';

  ok('사진 2장이 본문에서 분리된다', S._igOk('inflow').length === 2);
  ok('남는 글에는 <img> 가 없다', !/<img/i.test(text));
  ok('★ 글 미수정 + 사진 구성 그대로 → 조립이 원본과 **바이트 동일**', S._igComposeInflow() === orig);

  // 우리 프록시 형식이 아닌 <img> 는 사진 목록에 담지 않는다(그 태그는 본문에서 사라지지도 않게 유지)
  const S2 = makeSandbox();
  S2._igLoadInflowHtml(`<p>x</p><img src="https://evil.kr/a.png">`);
  ok('★ 남의 주소 <img> 는 사진 목록에 담기지 않는다', S2._igOk('inflow').length === 0);
}

console.log('\n=== B. 글을 고쳐도 사진이 살아남는다 / 순서 반영 ===');
{
  const S = makeSandbox();
  const orig = `<p>원문</p><img src="${URL_OF('a')}"><img src="${URL_OF('b')}">`;
  S._igLoadInflowHtml(orig);
  S.window._wdInflowRawHtml = orig;
  const ta = S.document.getElementById('rf_wd_inflow');

  ta.dataset.rawHtml = '';            // 사람이 글을 고친 상태(평문 모드 전환)
  ta.value = '새 안내문';
  const composed = S._igComposeInflow();
  ok('★ 글을 고쳐도 사진 2장이 그대로 실린다(이 변경의 존재 이유)',
    (composed.match(/<img/g) || []).length === 2);
  ok('고친 글이 escape 되어 앞에 온다', composed.startsWith('새 안내문<img'));

  // 순서 바꾸기
  const list = S.window._igState.inflow;
  list.splice(0, 0, list.splice(1, 1)[0]);         // 2번을 맨 앞으로
  const reordered = S._igComposeInflow();
  ok('★ 순서를 바꾸면 그 순서로 저장된다',
    reordered.indexOf(TOK('b')) < reordered.indexOf(TOK('a')));

  // 사진을 빼면 그 사진만 빠진다
  S.window._igState.inflow = [list[0]];
  ok('사진을 빼면 그 장만 빠진다', (S._igComposeInflow().match(/<img/g) || []).length === 1);
}

console.log('\n=== B-2. 상한(4장)과 "초과분은 자르지 않는다" ===');
{
  const S = makeSandbox();
  ok('칸당 상한은 4장', S._IG_MAX === 4);
  S._igSetList('review', ['a', 'b', 'c', 'd', 'e', 'f'].map(c => URL_OF(c)));
  ok('★ 이미 상한을 넘겨 들어온 공고는 **자르지 않는다**(무엇을 뺄지는 사람이 고른다)',
    S._igUrls('review').length === 6);
  ok('중복(호스트만 다른 같은 파일)은 접힌다', (() => {
    const S2 = makeSandbox();
    S2._igSetList('notes', [URL_OF('a'), URL_OF('a', 'pages.dev')]);
    return S2._igUrls('notes').length === 1;
  })());
  ok('우리 프록시 형식이 아닌 주소는 담기지 않는다', (() => {
    const S2 = makeSandbox();
    S2._igSetList('notes', ['https://evil.kr/a.png', 'javascript:alert(1)', URL_OF('a')]);
    return S2._igUrls('notes').length === 1;
  })());
}

console.log('\n=== C. 서버 검증 (sanitizeGuideImages) ===');
{
  const S = require('../src/utils/sanitizeGuideHtml');
  ok('★ 우리 프록시 주소만 통과 — 남의 주소는 버린다',
    S.sanitizeGuideImages(['https://evil.kr/a.png', 'javascript:alert(1)', URL_OF('a')]).length === 1);
  ok('★ 칸당 4장 — 5장째는 버린다(화면만 믿지 않는다)',
    S.sanitizeGuideImages(['a', 'b', 'c', 'd', 'e'].map(c => URL_OF(c))).length === 4);
  ok('파일ID 기준 중복 제거(호스트가 달라도 같은 장)',
    S.sanitizeGuideImages([URL_OF('a'), URL_OF('a', 'pages.dev')]).length === 1);
  ok('배열이 아니면 빈 배열', Array.isArray(S.sanitizeGuideImages('x')) && S.sanitizeGuideImages('x').length === 0);
  ok('상한 상수는 4', S.GUIDE_IMAGE_MAX === 4);

  const wd = S.sanitizeWorkDetail({ reviewGuide: '<옵션> 그대로', specialNotes: '주의' });
  ok('★ 평문 칸은 손대지 않는다(꺾쇠 글자 보존)', wd.reviewGuide === '<옵션> 그대로');
  ok('★ 없는 필드를 새로 만들지 않는다(옛 스냅샷 무변경)',
    !('reviewGuideImages' in wd) && !('specialNotesImages' in wd));
  const wd2 = S.sanitizeWorkDetail({ reviewGuideImages: ['https://evil.kr/a.png', URL_OF('a')] });
  ok('응답 직전에도 다시 정화한다(이중 적용)', wd2.reviewGuideImages.length === 1);

  ok('★ 저장 경로(_prepWorkDetail)도 같은 정화를 태운다',
    /function _prepWorkDetail/.test(routes)
    && /for \(const f of GUIDE_IMAGE_FIELDS\)[\s\S]{0,120}sanitizeGuideImages\(out\[f\]\)/.test(routes));
  ok('저장 경로가 미전송 필드를 만들지 않는다', /if \(out\[f\] !== undefined\) out\[f\] = sanitizeGuideImages/.test(routes));
}

console.log('\n=== D. 리뷰어 화면 렌더러 ===');
{
  const g = { window: {}, document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}) } };
  const ctx = vm.createContext(g);
  vm.runInContext(wdjs, ctx);
  const C = g.window.CampWorkDetail;

  const h = C.cardsHtml({ workDetail: {
    inflowGuideHtml: '<p>유입</p>', reviewGuide: '리뷰 5건', specialNotes: '주의',
    reviewGuideImages: [URL_OF('a')], specialNotesImages: [URL_OF('b')],
  } }, { apiBase: 'https://base' });
  const seg = (t) => { const i = h.indexOf(t); const j = h.indexOf('cwd-box', i); return h.slice(i, j < 0 ? h.length : j); };
  ok('★ 리뷰가이드 사진은 **리뷰 가이드 카드 안**에', (seg('📝 리뷰 가이드').match(/<img/g) || []).length === 1);
  ok('★ 특이사항 사진은 **특이사항 카드 안**에', (seg('📌 특이사항').match(/<img/g) || []).length === 1);
  ok('★ 호스트는 신뢰 베이스로 재구성(배열의 임의 호스트를 그대로 쓰지 않는다)',
    h.includes('https://base/api/order/guide-image/' + TOK('a')) && !h.includes('https://api.test/'));

  const dup = C.cardsHtml({ workDetail: {
    inflowGuideHtml: '', reviewGuide: '참고 ' + URL_OF('a'), reviewGuideImages: [URL_OF('a')],
  } }, { apiBase: '' });
  ok('★ 같은 사진이 두 번 나오지 않는다(배열 ↔ 유입가이드 카드 추출 중복)',
    (dup.match(/<img/g) || []).length === 1);

  const only = C.cardsHtml({ workDetail: { reviewGuideImages: [URL_OF('a')], specialNotesImages: [URL_OF('b')] } }, { apiBase: '' });
  ok('★ 글이 비고 사진만 있어도 카드를 낸다(안 그리면 넣은 사진이 통째로 사라진다)',
    only.includes('📝 리뷰 가이드') && only.includes('📌 특이사항'));

  const none = C.cardsHtml({ workDetail: { inflowGuideHtml: '<p>유입</p>', reviewGuide: '리뷰', specialNotes: '주의' } }, { apiBase: '' });
  ok('★ 배열이 없으면 종전과 동일(무회귀)', (none.match(/<img/g) || []).length === 0);

  const evil = C.cardsHtml({ workDetail: { reviewGuideImages: ['https://evil.kr/a.png'] } }, { apiBase: '' });
  ok('남의 주소는 그리지 않는다', !evil.includes('evil.kr'));
}

console.log('\n=== E. 평문 칸을 HTML 로 승격하지 않았다 (가장 위험한 회귀) ===');
{
  ok('★ 리뷰가이드 본문은 여전히 escAttr 경로', /escAttr\(reviewOnly\)/.test(wdjs));
  ok('★ 특이사항 본문은 여전히 escAttr 경로', /escAttr\(wd\.specialNotes/.test(wdjs));
  ok('★ 서버 sanitize 는 reviewGuide·specialNotes 를 HTML 로 다루지 않는다',
    !/sanitizeGuideHtml\(wd\.reviewGuide/.test(routes) && !/sanitizeGuideHtml\(wd\.specialNotes/.test(routes));
}

console.log('\n=== F. 배선·안전 규율 ===');
{
  const igBlock = extractIgBlock();
  // 3경로가 한 함수로 수렴
  ok('★ 파일선택·붙여넣기·드래그가 모두 _igUpload 로 수렴(사본 금지)', (() => {
    const calls = (igBlock.match(/_igUpload\(/g) || []).length;
    return /function igPickFiles/.test(igBlock) && /getAsFile\(\)/.test(igBlock)
      && /dataTransfer && e\.dataTransfer\.files/.test(igBlock) && calls >= 4;
  })());
  ok('업로드는 기존 엔드포인트 재사용(신규 엔드포인트 0)',
    /API_BASE_URL \+ "\/api\/order\/guide-image"/.test(igBlock));
  ok('★ 서버가 돌려준 주소도 형식 검증 후에만 저장(임의 문자열 금지)',
    /_IG_URL_RE\.test\(String\(j\.url\)\)/.test(igBlock));
  ok('붙여넣기는 이미지일 때만 가로챈다(텍스트 붙여넣기 기본 동작 보존)',
    /kind === "file" && \/\^image\\\//.test(igBlock));
  ok('드래그는 파일 드래그일 때만 업로드로 받는다(순서 변경과 구분)',
    /includes\("Files"\)/.test(igBlock) && /application\/x-ig-reorder/.test(igBlock));
  ok('★ 순서 드롭은 오른쪽=대상 뒤(항상 앞이면 끝자리로 옮길 수 없다)',
    /after: \(e\.clientX - r\.left\) > r\.width \/ 2/.test(igBlock));

  // onclick 에 주소 문자열 보간 금지 — 넘기는 것은 인덱스뿐
  ok('★ 썸네일 마크업에 onclick 이 없다(위임)', !/onclick=/.test(igBlock.slice(igBlock.indexOf('function _igRender'))));
  ok('★ 넘기는 값은 인덱스뿐(data-igi/data-igdel)',
    /data-igi="\$\{i\}"/.test(igBlock) && /data-igdel="\$\{i\}"/.test(igBlock));
  ok('썸네일 <img src> 는 escHtml 을 통과한다', /<img src="\$\{escHtml\(im\.src \|\| im\.url\)\}"/.test(igBlock));

  // 확대 팝업
  ok('★ 확대 팝업은 body 직속', /document\.body\.appendChild\(el\)/.test(igBlock));
  ok('★ 끝에서 순환하지 않는다', /if \(n < 0 \|\| n >= _igLbList\.length\) return;/.test(igBlock));
  ok('★ 팝업은 그 칸의 사진만 묶는다', /_igLbList = _igOk\(field\)/.test(igBlock));
  ok('실패·업로드중 사진은 확대 대상이 아니다', /state === "ok"/.test(igBlock));
  ok('★ 키 리스너는 최상위 1회(window._igKeyBound 가드)',
    /!window\._igKeyBound/.test(recjs) && (recjs.match(/window\._igKeyBound = true/g) || []).length === 1);
  /* ⚠ 패턴 갱신(2026-08-07 · 사용자 확정): 확대 팝업이 **열려 있는 동안**에는 포커스가
     input/textarea 에 남아 있어도 ← → Esc 를 받는다 — 글을 쓰다가 썸네일을 누르면 포커스가
     textarea 에 그대로 남아 **방향키가 죽었다**(브라우저로 재현). "타이핑 중 방향키를 뺏지
     않는다"는 원래 의도는 **팝업이 닫혀 있으면 아무것도 하지 않는다**(.on 검사)로 유지된다. */
  ok('팝업이 닫혀 있으면 방향키를 가로채지 않는다 + 브라우저 단축키는 흘려보낸다',
    /if \(!el \|\| !el\.classList\.contains\("on"\)\) return;/.test(recjs) &&
    /if \(e\.ctrlKey \|\| e\.altKey \|\| e\.metaKey\) return;/.test(recjs));

  // 저장 배선
  /* ⚠ 패턴 갱신(2026-08-07): 모달이 떠 있는 동안의 차단 사유는 토스트가 아니라 **모달 안 인라인**
     (`_rfSaveBlocked`)으로 나간다 — 리뷰웹시스템[3버전]의 토스트(z-index 60)는 이 모달
     (5000+blur) 아래로 깔려 보이지 않는다. 검사 의미는 불변(업로드 중이면 안내 후 저장 중단). */
  ok('★ 인플라이트(업로드 중) 저장 차단', /if \(_igBusy\(\)\) \{ _rfSaveBlocked\("사진 업로드가 끝나면[\s\S]{0,60}?return; \}/.test(recjs));
  ok('저장 payload 에 두 배열이 실린다',
    /reviewGuideImages: _igUrls\("review"\)/.test(recjs) && /specialNotesImages: _igUrls\("notes"\)/.test(recjs));
  ok('★ 미리보기와 저장이 같은 조립 함수를 쓴다(갈라질 수 없다)',
    (recjs.match(/_igComposeInflow\(\)/g) || []).length >= 2);
  ok('★ 확인창 문구가 "사진 유지"로 바뀌었다(종전 "이미지가 빠진 평문" 은 사실이 아니었다)',
    /사진 \$\{_n\}장은 그대로 유지되고/.test(recjs) && !/원본에 있던 이미지가 빠진 평문으로 게시됩니다/.test(recjs));
  ok('미리보기 평문에 [이미지] 자리표시자·꼬리표를 남기지 않는다', (() => {
    const s = recjs.indexOf('function _htmlToPlainPreview');
    const body = recjs.slice(s, recjs.indexOf('\n}', s));
    return !/\[이미지\]/.test(body) && !/※ 이미지/.test(body);
  })());
  ok('모달을 열 때 상태·배선을 다시 잡는다(리뷰웹시스템[3버전]은 뷰 진입 시 마운트)',
    /Object\.keys\(_IG_FIELDS\)\.forEach\(_igBind\)/.test(recjs) && /_igResetAll\(\);/.test(recjs));

  // 마크업
  ok('세 칸 모두 스트립·파일입력이 있다', ['inflow', 'review', 'notes'].every(f =>
    modaljs.includes(`id="rf_ig_${f}"`) && modaljs.includes(`id="rf_igf_${f}"`) && modaljs.includes(`id="rf_igm_${f}"`)));
  ok('★ 기존 필드 id 는 그대로(프리필·저장·정리 도우미가 묶여 있다)',
    ['rf_wd_inflow', 'rf_wd_review', 'rf_wd_notes'].every(i => modaljs.includes(`id="${i}"`)));
  ok('★ 세 칸의 높이가 같다(rows=3 · 스트립 82px)', (() => {
    const rows = ['rf_wd_inflow', 'rf_wd_review', 'rf_wd_notes'].map(id => {
      const m = modaljs.match(new RegExp(`id="${id}"[^>]*rows="(\\d)"`));
      return m ? m[1] : '';
    });
    return rows.every(r => r === '3') && /\.ig-strip\{[^}]*height:82px/.test(modaljs)
      && /\.ig-wrap>textarea\.rform-input\{[^}]*height:82px/.test(modaljs);
  })());
  ok('★ box-sizing 을 호스트 리셋에 기대지 않는다(높이 어긋남 실측 방지)',
    /#recruitModal \.ig-wrap,#recruitModal \.ig-wrap \*\{box-sizing:border-box\}/.test(modaljs));
}

console.log(`\n총 ${pass}건 통과\n`);
