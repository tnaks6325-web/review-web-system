/**
 * 리뷰어 홈 「눌러도 안 되는 버튼 · 화면 밀림」 회귀 가드 (2026-11-09 리뷰어 홈 점검 W3).
 *
 * 고정하는 것:
 *   (a) 옛 방식 모집공고(카톡방 없음) [참여 신청하기] — 같은 신청칸이 로그인 화면 목록과 홈 목록에
 *       두 벌 그려져 id 가 겹친다. 누른 버튼이 든 카드의 신청칸을 열고, 그 칸의 값으로 신청한다.
 *       (종전: getElementById 가 숨겨진 로그인 화면 쪽을 열어 화면 변화 0 = 막다른 길)
 *   (f) L3 카톡 주소·채널명은 따옴표까지 바꾸는 _escAttrX 로 속성에 넣고, 주소는 onclick 코드가 아니라
 *       data- 속성 글자로 읽는다. javascript:/data:/vbscript: 주소는 열지 않는다.
 *   (d) L4 [리뷰제출하기] 잘못된 번호 → 없는 함수 toast 대신 showToast.
 *   (e) L10 리뷰 내역 항목(idxName 동봉 = displayName 이 사람 이름)은 displayName 을 작업 이름으로 쓰지 않는다.
 *       오래된 리뷰 경고·구매 캡처 보완(displayName = 작업 이름)은 종전 그대로.
 *   (b)(c)(g) 가로 넘침·행 보기 띠·제목 자르기·인기 배지·가이드 창 CSS.
 *
 * 실행: node tests/reviewerHomeDeadButtons.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONT = path.join(__dirname, '..', '..', 'frontend');
const page = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
const cards = fs.readFileSync(path.join(FRONT, 'js', 'campaign-cards.js'), 'utf8');
let n = 0;
const ok = (name, cond) => { assert.ok(cond, name); n++; console.log('  ✓ ' + name); };

function slice(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s >= 0, 'marker 없음: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(e > s, 'end marker 없음: ' + endMarker);
  return src.slice(s, e);
}

// ── 아주 작은 가짜 DOM ─────────────────────────────────────────────
function mkInput(type) { return { type, value: '' }; }
function mkForm(id, visibleCard) {
  const name = mkInput('text'), phone = mkInput('tel');
  const form = {
    id, style: { display: 'none' }, _name: name, _phone: phone,
    querySelector(sel) { if (/type="?text/.test(sel)) return name; if (/type="?tel/.test(sel)) return phone; return null; },
  };
  const card = {
    _form: form,
    querySelector(sel) { return sel === '.rc-inline-form' ? form : null; },
    getClientRects() { return visibleCard ? [{}] : []; },
  };
  form.closest = (sel) => (sel === '.rc-card' ? card : null);
  return { form, card };
}

// ── (a) 신청칸은 누른 카드 안에서 찾는다 ───────────────────────────
{
  const handlers = slice(page, '/* ═══ 참여 신청 핸들러 ═══ */', '/* ═══ 👥 타계정 등록 후 공고 복귀');
  const hidden = mkForm('rcForm_l_form', false);   // 로그인 화면 목록(먼저 나온다·숨김)
  const shown = mkForm('rcForm_l_form', true);     // 홈 목록(보임)
  const forms = [hidden.form, shown.form];
  const toasts = [], opened = [], fetches = [];
  const sandbox = {
    document: {
      getElementById: (id) => forms.find(f => f.id === id) || (id === 'loginPhone' ? null : null),
      querySelectorAll: (sel) => (sel === '.rc-inline-form' ? forms : []),
    },
    getSavedUser: () => ({ name: '김예시', phone: '010-0000-0000' }),
    showToast: (m) => toasts.push(m),
    window: { open: (u) => opened.push(u) },
    fetch: async (url, opt) => { fetches.push({ url, body: JSON.parse(opt.body) }); return { json: async () => ({ ok: true }) }; },
    API_BASE_URL: 'http://x',
    loadRecruitPreview: () => {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(handlers, sandbox);

  // 홈 목록 카드의 버튼을 누른다
  const btn = { closest: (sel) => (sel === '.rc-card' ? shown.card : null) };
  sandbox.__btn = btn;
  vm.runInContext("handleApplyClick(null, 'l_form', __btn)", sandbox);
  ok('(a) 누른 카드(홈 목록)의 신청칸이 열린다', shown.form.style.display === '');
  ok('(a) 숨겨진 로그인 화면 쪽 신청칸은 그대로 닫혀 있다', hidden.form.style.display === 'none');
  ok('(a) 열린 칸에 로그인한 이름·연락처가 채워진다', shown.form._name.value === '김예시' && shown.form._phone.value === '010-0000-0000');

  // 버튼 요소 없이 불려도(옛 호출) 보이는 쪽을 고른다
  shown.form.style.display = 'none';
  vm.runInContext("openInlineApply('l_form')", sandbox);
  ok('(a) 버튼 없이 불려도 보이는 카드의 신청칸을 연다', shown.form.style.display === '' && hidden.form.style.display === 'none');

  // [신청 완료] — 그 칸의 값으로 보낸다
  shown.form._name.value = '김예시'; shown.form._phone.value = '010-1111-2222';
  hidden.form._name.value = ''; hidden.form._phone.value = '';
  const submitBtn = { closest: (sel) => (sel === '.rc-card' ? shown.card : null) };
  sandbox.__sb = submitBtn;
  vm.runInContext("submitInlineApply('l_form', __sb)", sandbox);
  setImmediate(() => {
    assert.equal(fetches.length, 1, '(a) 신청 요청 1건');
    assert.equal(fetches[0].url, 'http://x/api/campaign/l_form/apply');
    assert.deepStrictEqual(fetches[0].body, { name: '김예시', phone: '010-1111-2222' }, '(a) 보이는 칸의 값으로 신청');
    assert.ok(!toasts.includes('이름을 입력해주세요'), '(a) 숨겨진 빈 칸을 읽어 "이름을 입력" 으로 막히지 않는다');
    n += 3; console.log('  ✓ (a) [신청 완료] 는 보이는 칸의 이름·연락처로 /apply 를 부른다');
    ok('(a) 신청 성공 뒤 그 칸이 닫힌다', shown.form.style.display === 'none');

    // (f) 위험한 주소는 열지 않는다 / 정상 카톡 주소는 연다
    vm.runInContext("handleApplyClick('javascript:window.__pwn=1')", sandbox);
    vm.runInContext("handleApplyClick(' JavaScript:alert(1)')", sandbox);
    vm.runInContext("handleApplyClick('data:text/html,<script>1</script>')", sandbox);
    ok('(f) javascript:/data: 주소는 새 창으로 열지 않는다', opened.length === 0);
    vm.runInContext("handleApplyClick('https://open.kakao.com/o/abc')", sandbox);
    ok('(f) 정상 카톡 주소는 그대로 연다', opened.length === 1 && opened[0] === 'https://open.kakao.com/o/abc');
    rest();
  });
}

function rest() {
  // ── (a)(f) 카드 템플릿 ───────────────────────────────────────────
  const tpl = slice(page, 'function _renderRecruitPreview(json)', '/* ═══ 참여 신청 핸들러 ═══ */');
  ok('(f) 카톡 주소를 onclick 코드 안에 넣지 않는다(따옴표 주입 차단)',
    !/handleApplyClick\('\$\{[^}]*chat_url/.test(tpl) && !/&apos;/.test(tpl));
  ok('(f) 카톡 주소는 _escAttrX 로 data- 속성에 넣고 글자로 읽는다',
    /data-chat-url="\$\{_escAttrX\(c\.chat_url\)\}"\s+onclick="handleApplyClick\(this\.dataset\.chatUrl\)"/.test(tpl));
  ok('(f) 채널명 속성도 _escAttrX(큰따옴표 차단)', /data-ch="\$\{_escAttrX\(channel\)\}"/.test(tpl) && !/data-ch="\$\{escHtml/.test(tpl));
  ok('(a) [참여 신청하기]·[신청 완료]·[취소] 가 누른 버튼(this)을 넘긴다',
    /handleApplyClick\(null,'\$\{c\.id\}',this\)/.test(tpl)
    && /submitInlineApply\('\$\{c\.id\}',this\)/.test(tpl)
    && /closeInlineApply\('\$\{c\.id\}',this\)/.test(tpl));
  const esc = vm.runInNewContext(slice(page, 'function _escAttrX(s)', '\n') + '; _escAttrX', {});
  const attr = esc(`https://x/o/a');window.__pwn2=1;//"x`);
  ok('(f) _escAttrX 는 큰따옴표를 바꿔 속성 밖으로 못 나가게 한다', !attr.includes('"'));

  // ── (d) L4 ──────────────────────────────────────────────────────
  {
    const fn = slice(page, 'function _partInfoSubmit(index)', '\nfunction _escAttrX');
    const toasts = [];
    const sb = { _partInfoSubmitItems: [{ a: 1 }], showToast: (m) => toasts.push(m), closePartInfo() {}, goToSubmit() { throw new Error('호출되면 안 됨'); } };
    vm.createContext(sb);
    vm.runInContext(fn, sb);
    assert.doesNotThrow(() => vm.runInContext('_partInfoSubmit(5)', sb), '(d) 잘못된 번호에서 오류가 나면 안 된다');
    ok('(d) 잘못된 번호 → 화면 공용 showToast 로 안내', toasts.length === 1 && /선택/.test(toasts[0]));
    ok('(d) 없는 전역 toast( 호출이 화면에 남지 않는다', !/[^.\w]toast\(/.test(page.replace(/showToast\(/g, '')));
  }

  // ── (e) L10 ─────────────────────────────────────────────────────
  {
    const src = slice(page, 'const _INTERNAL_KEY_RE', 'let _mcItems');
    const sb = {};
    vm.createContext(sb);
    vm.runInContext(src, sb);
    const label = vm.runInContext('_taskLabel', sb);
    // 서버 리뷰 내역 항목 모양(search.service: displayName=사람 이름, idxName 동봉)
    ok('(e) 리뷰 내역 항목: 작업 이름이 비면 사람 이름 대신 작업명(campaignName)',
      label({ displayName: '홍길동', idxName: '홍길동', displayNameTC: '', campaignName: '모기위키 기피제', tabName: '탭A' }, '') === '모기위키 기피제');
    ok('(e) 리뷰 내역 항목: 작업명도 없으면 탭 이름 — 사람 이름은 끝까지 안 쓴다',
      label({ displayName: '홍길동', idxName: null, displayNameTC: '', campaignName: '', tabName: '8/15 탭' }, '') === '8/15 탭');
    ok('(e) 리뷰 내역 항목: 다른 이름이 전혀 없으면 호출부 폴백(사람 이름 아님)',
      label({ displayName: '홍길동', idxName: '홍길동', displayNameTC: '', campaignName: '', tabName: 'campaign:camp_x' }) === '참여 작업');
    ok('(e) 리뷰 내역 항목: 공고 제목이 있으면 종전 그대로',
      label({ displayName: '홍길동', idxName: '홍길동', displayNameTC: '위트 탈취제' }) === '위트 탈취제');
    ok('(e) 오래된 리뷰 경고 모양({displayName} = 작업 이름)은 종전 그대로',
      label({ displayName: '[11/05] 위트 탈취제' }, '참여 작업') === '[11/05] 위트 탈취제');
    ok('(e) 구매 캡처 보완 모양(displayName = 작업 이름, idxName 없음)은 종전 그대로',
      label({ displayName: '공고 제목', campaignName: '작업명', tabName: 'campaign:camp_1' }) === '공고 제목');
  }

  // ── (b) 가로 넘침 ────────────────────────────────────────────────
  ok('(b) 종류 탭 줄은 넘치면 줄 안에서만 옆으로 넘긴다(화면 전체가 밀리지 않게)',
    /\.rc-kind-tabs\{[^}]*overflow-x:auto/.test(page));
  ok('(b) 작은 폭(≤360px)에서는 탭 여백을 줄여 세 탭이 한 줄에 들어간다',
    /@media \(max-width:360px\)\{\s*\.rc-kt\{padding:6px 8px\}\s*\}/.test(page));
  ok('(b) 공지 목록의 긴 주소는 칸 안에서 줄바꿈', /#reviewerNoticeList\{[^}]*overflow-wrap:anywhere/.test(page));

  // ── (c) 행 보기 재참여 띠는 썸네일(92px) 안에만 ───────────────────
  ok('(c) 행 보기 띠: 오른쪽 끝을 풀고 썸네일 폭 92px', /\.rc-view-row \.pcard \.pt-sash\{right:auto;width:92px[^}]*\}/.test(cards));
  ok('(c) 카드 보기 띠 규칙은 그대로(시안 A)', cards.includes('.pcard .pt-sash{position:absolute;left:0;right:0;bottom:0'));
  const rowBlock = slice(cards, '.rc-view-row .pcards-grid{', '/* 인기 설정은 관리자에게만');
  ok('(c) 행 보기 규칙은 CSS 만 — 행 전용 HTML 빌더 없음(결정 068)', !/rowHtml|function\s+_?row[A-Z]\w*Html/.test(cards) && rowBlock.length > 0);

  // ── (g) 제목·인기 배지·가이드 창 ─────────────────────────────────
  ok('(g) 행 보기 제목은 한 줄(잘린 뒷줄이 안 보이게 nowrap+ellipsis)',
    /\.rc-view-row \.pcard \.ptitle\{-webkit-line-clamp:1[^}]*overflow:hidden[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/.test(cards));
  ok('(g) 행 보기 인기 배지 줄높이 고정(이모지 글꼴로 배지가 커져 제목을 덮지 않게)',
    /\.rc-view-row \.pcard \.pt-pop\{line-height:1\.2/.test(cards));
  ok('(g) 가이드 창은 화면보다 길면 창 안에서 스크롤', /\.obx\{[^}]*max-height:88vh[^}]*overflow-y:auto/.test(page));

  console.log(`✅ reviewerHomeDeadButtons 테스트 전체 통과 (${n})`);
}
