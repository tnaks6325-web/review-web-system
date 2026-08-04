/**
 * reviewEditCsBridge.test.js — 리뷰이미지 교체요청 ↔ C/S 문의창구 연동 회귀가드
 * 실행: node tests/reviewEditCsBridge.test.js
 *
 * 이 연동의 위험 네 가지를 고정한다.
 *  ① **승인을 깨뜨리는 것** — 승인은 Drive 파일 이동·review_index 갱신까지 끝난 뒤 통지한다.
 *     통지가 throw 하면 "파일은 바뀌었는데 요청은 pending" 인 어긋난 상태가 남는다 → fail-soft 고정.
 *  ② **권한** — 교체요청 승인은 되돌리기 어렵다. AE 는 담당 탭만, 광고주·리뷰어는 차단.
 *  ③ **리뷰어 노출** — meta 는 리뷰어 응답 JSON 에 그대로 실린다. 실명·시트제목이 새면 안 된다.
 *  ④ **사본 드리프트** — 카드가 관리자/리뷰어/전용탭 세 곳에 그려진다. 렌더러는 한 벌이어야 한다.
 *
 * ★★ 코드리뷰가 잡아 준 것 중 **정적 grep 으로는 못 잡은 것**들은 아래 8) 에서
 *    핸들러·모듈을 **실제로 실행**해 확인한다(선언이 '있다'는 것만으로는 부족하다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 리뷰이미지 교체요청 ↔ C/S 연동 회귀가드\n');

const MIG = R('migrations/080_cs_message_card.sql');
const BR = R('src/services/csBridge.service.js');
const RE = R('src/routes/reviewEdit.routes.js');
const TB = R('src/routes/trackB.routes.js');
const CSR = R('src/routes/cs.routes.js');
const RVR = R('src/routes/reviewer.routes.js');
const CARD = F('js/cs-review-edit-card.js');
const CSJ = F('js/cs-inquiry.js');
const RCS = F('js/reviewer-cs.js');
const PAY = F('js/index-payment.js');
const WD = F('workdesk.html');
const ADM = F('admin.html');

/* ── 1) 스키마 ─────────────────────────────────────────────── */
console.log('1) 스키마(080)');
t('카드 타입·메타 컬럼 추가(멱등·기본값)', () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS msg_type TEXT NOT NULL DEFAULT 'text'/.test(MIG));
  assert.ok(/ADD COLUMN IF NOT EXISTS meta\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/.test(MIG),
    '기본값이 없으면 기존 메시지가 NULL 로 남아 프론트가 깨진다');
});
t('★ 값 공간을 CHECK 로 좁히되 **NOT VALID**(운영 테이블 전체 스캔 금지)', () => {
  assert.ok(/CHECK \(msg_type IN \('text', 'review_edit'\)\) NOT VALID/.test(MIG),
    '스캔을 넣으면 러너의 암묵 트랜잭션이 ACCESS EXCLUSIVE 를 그동안 유지한다');
  assert.ok(/SELECT 1 FROM pg_constraint/.test(MIG), 'CHECK 추가가 멱등이 아니다');
});
t('★ 요청 1건 = 카드 1장(부분 유니크)', () => {
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS uq_cs_msg_review_edit/.test(MIG));
  assert.ok(/\(\(meta->>'requestId'\)\)/.test(MIG) && /WHERE msg_type = 'review_edit'/.test(MIG));
});

/* ── 2) fail-soft ──────────────────────────────────────────── */
console.log('\n2) ★★ fail-soft (승인을 절대 깨뜨리지 않는다)');
t('브리지의 세 진입점이 모두 try/catch — throw 없음', () => {
  ['postReviewEditRequest', 'postReviewEditDecision', 'markReviewEditCancelled'].forEach(fn => {
    const i = BR.indexOf('async function ' + fn);
    assert.ok(i > 0, fn + ' 없음');
    const body = BR.slice(i, BR.indexOf('\n}', i));
    assert.ok(/try \{/.test(body) && /catch \(err\)/.test(body), fn + ': try/catch 없음');
    assert.ok(/logger\.warn/.test(body), fn + ': 실패를 삼키기만 하고 로그가 없다');
    assert.ok(!/\bthrow /.test(body), fn + ': throw 가 있으면 승인이 깨진다');
  });
});
t('★ 통지는 Drive·DB 작업이 **끝난 뒤**에 부른다', () => {
  const i = RE.indexOf("action: 'approved'");
  const j = RE.indexOf("postReviewEditDecision(committed, 'approved'");
  assert.ok(i > 0 && j > i, '승인 통지가 커밋/보관 처리보다 앞에 있다');
});
t('★ 반려는 **커넥션을 반납한 뒤** 통지한다(풀 자기교착 방지)', () => {
  const i = RE.indexOf("router.post('/reject'");
  const seg = RE.slice(i, i + 3000);
  const rel = seg.indexOf('client.release()');
  const call = seg.indexOf("postReviewEditDecision(committed, 'rejected'");
  assert.ok(rel > 0 && call > rel, '커넥션을 쥔 채 csBridge(새 커넥션 4회)를 부른다');
});
t('네 시점 모두 배선(요청·승인·반려·취소)', () => {
  assert.ok(/csBridge\.postReviewEditRequest\(/.test(RE), '요청 시 카드 없음');
  assert.ok(/postReviewEditDecision\(committed, 'approved'/.test(RE), '승인 통지 없음');
  assert.ok(/postReviewEditDecision\(committed, 'rejected'/.test(RE), '반려 통지 없음');
  assert.ok(/csBridge\.markReviewEditCancelled\(/.test(RE),
    '취소 배선이 없으면 [승인]/[반려] 가 살아 있는 좀비 카드가 남는다');
});

/* ── 3) 스레드 결속 ────────────────────────────────────────── */
console.log('\n3) 스레드 결속');
t('★ C/S 스레드 키가 리뷰어 UI 규칙과 같다(sheetId||tabName)', () => {
  assert.ok(/return `\$\{String\(sheetId \|\| ''\)\}\|\|\$\{String\(tabName \|\| ''\)\}`/.test(BR));
  assert.ok(/\|\|['"]\s*\+|\+ ['"]\|\|['"]/.test(F('index.html')),
    '리뷰어 UI 의 키 합성 규칙을 찾지 못함(가드 갱신 필요)');
});
t('★★ 기존 스레드의 라벨·이름을 덮어쓰지 않는다(시트제목 유출 차단)', () => {
  const i = BR.indexOf('ON CONFLICT (reviewer_phone8, campaign_key) DO UPDATE SET');
  const seg = BR.slice(i, BR.indexOf('RETURNING', i));
  assert.ok(!/campaign_label = EXCLUDED/.test(seg),
    '라벨 출처에 시트 제목이 섞이는데 그 값은 리뷰어 문의방 이름으로 그대로 나간다');
  assert.ok(!/reviewer_name = EXCLUDED/.test(seg));
  assert.ok(/admin_unread_count = cs_threads\.admin_unread_count \+ 1/.test(seg), '관리자 뱃지에 안 잡힌다');
});
t('★ 승인/반려는 카드를 제자리 갱신 + 통지 메시지는 따로', () => {
  assert.ok(/SET meta = meta \|\| \$2::jsonb/.test(BR), 'meta 를 통째로 덮으면 requestId·파일ID 가 날아간다');
  assert.ok(/리뷰이미지 수정요청이 승인되었습니다\./.test(BR));
  assert.ok(/리뷰이미지 수정요청이 반려되었습니다[\s\S]{0,40}사유/.test(BR));
  assert.ok(/reviewer_unread_count = reviewer_unread_count \+ 1/.test(BR));
});
t('★ 처리 중 뒤늦은 스레드 생성은 "새 문의" 알림을 내지 않고, 재귀는 1회 제한', () => {
  assert.ok(/postReviewEditRequest\(r, \{ silent: true \}\)/.test(BR));
  assert.ok(/if \(!opts\.silent\)/.test(BR));
  assert.ok(/if \(_depth\)/.test(BR), '무한 재귀 가드가 없다');
});

/* ── 4) 반려 사유 필수 ─────────────────────────────────────── */
console.log('\n4) 반려 사유');
t('★ 서버가 빈 사유를 거부한다', () => {
  assert.ok(/const rejectNote = _sanitizeReason\(note \|\| ''\)/.test(RE));
  assert.ok(/if \(!rejectNote\.trim\(\)\) return res\.json\(\{ ok: false/.test(RE));
});
t('★ 프론트 **세 화면 모두** 빈 사유를 막는다', () => {
  assert.ok(/if \(!String\(note\)\.trim\(\)\) \{ showToast\('반려 사유를 입력해 주세요/.test(CSJ),
    'C/S·전용탭 공용 핸들러');
  assert.ok(/if \(!String\(note\)\.trim\(\)\) \{ showToast\('반려 사유를 입력해 주세요/.test(PAY),
    '기존 관리자페이지가 빈 사유를 그대로 보낸다');
  const i = PAY.indexOf('async function rejectReviewEdit');
  const body = PAY.slice(i, PAY.indexOf('\n}', i));
  assert.ok(body.indexOf('String(note).trim()') < body.indexOf('_reviewEditRemoveCard'),
    '빈 사유 검사가 낙관적 카드 제거보다 뒤에 있으면 "반려한 줄 알았는데 그대로"가 된다');
});

/* ── 5) 권한 ───────────────────────────────────────────────── */
console.log('\n5) 권한');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const router = require('../src/routes/trackB.routes');
const L = {};
router.stack.filter(l => l.route).forEach(l => {
  const m = Object.keys(l.route.methods)[0];
  L[m.toUpperCase() + ' ' + l.route.path] = l.route.stack.map(s => s.name);
});
t('Track B 프록시 3경로 + 내부인 게이트', () => {
  ['GET /review-edit/list', 'POST /review-edit/approve', 'POST /review-edit/reject'].forEach(k => {
    assert.ok(L[k], '없는 라우트: ' + k);
    assert.ok(L[k].includes('authMiddleware') && L[k].includes('_reInternal'), k + ': 게이트 부족');
  });
});
t('★ AE 는 담당 탭만 — 승인/반려는 **위임 전에** 확인', () => {
  assert.ok(/async function _reCanTouch\(req, id\)/.test(TB));
  ['approve', 'reject'].forEach(a => {
    const re = new RegExp("router\\.post\\('/review-edit/" + a + "'[\\s\\S]{0,300}?_reCanTouch\\(req[\\s\\S]{0,200}?_reHandlers\\." + a);
    assert.ok(re.test(TB), a + ': 스코프 확인 없이 위임한다');
  });
});
t('★★ _reCanTouch 는 throw 하지 않는다(Express4 async rejection = 응답 영구 미전송)', () => {
  const i = TB.indexOf('async function _reCanTouch');
  const body = TB.slice(i, TB.indexOf('\n}', i));
  assert.ok(/_UUID_RE\.test\(rid\)/.test(body), 'UUID 형식 선검사가 없으면 22P02 로 hang 한다');
  assert.ok(/try \{/.test(body) && /catch \(err\)/.test(body), 'DB 오류를 잡지 않는다');
});
t('★ 스코프 판정 실패 = fail-closed', () => {
  assert.ok(/담당 범위를 확인하지 못했습니다/.test(TB));
});
t('스코프 조회가 행마다 돌지 않는다((시트,탭)당 1회) + 키를 쪼개지 않는다', () => {
  assert.ok(/const uniq = new Map\(\)/.test(TB) && /\[\.\.\.uniq\.entries\(\)\]/.test(TB));
  assert.ok(/JSON\.stringify\(\[/.test(TB), '키를 문자열로 이어 붙이면 탭명 구분자에 갈린다');
});
t('로직 복제 0 — 기존 reviewEdit 핸들러에 위임', () => {
  assert.ok(/const _reRoutes = require\('\.\/reviewEdit\.routes'\)/.test(TB));
  ['/list', '/approve', '/reject'].forEach(p =>
    assert.ok(new RegExp("_delegate\\(_reRoutes, '(get|post)', '" + p + "'\\)").test(TB), '위임 아님: ' + p));
  assert.ok(!/FROM review_edit_requests\s+WHERE status/.test(TB), 'trackB 에 목록 쿼리 사본이 있다');
});
t('원본 /api/review-edit/* 정책 불변(admin/master)', () => {
  ['/list', '/approve', '/reject'].forEach(p =>
    assert.ok(new RegExp("router\\.(get|post)\\('" + p + "', authMiddleware, adminOrMasterMiddleware").test(RE),
      '원본 게이트가 바뀌었다: ' + p));
});

/* ── 6) 리뷰어 노출 ────────────────────────────────────────── */
console.log('\n6) 리뷰어 노출');
t('★★ meta 에 관리자 실명을 담지 않는다 — meta 는 리뷰어 응답에 그대로 실린다', () => {
  // adminNickname.maskMessages 는 senderName 만 치환한다(meta 는 손대지 않는다)
  assert.ok(!/resolvedBy:/.test(BR), 'meta 에 resolvedBy 를 넣으면 리뷰어 JSON 으로 샌다');
  assert.ok(!/meta\.resolvedBy/.test(CARD), '카드가 실명을 그린다');
});
t('★★ 리뷰어 SSE 푸시도 리뷰어용 이름으로 치환', () => {
  assert.ok(/senderName: adminNickname\.toReviewerName\(senderName, nickMap\)/.test(BR),
    '화면이 안 그려도 페이로드로는 샌다(cs.routes 답장과 같은 규칙)');
  assert.ok(/sender_name, content\)\s*\n\s*VALUES \(\$1,'admin',\$2,\$3\)/.test(BR),
    'DB 에는 로그인명을 남겨 책임추적을 유지해야 한다');
});
t('두 조회 엔드포인트가 msgType·meta 를 내려준다', () => {
  [['cs.routes.js', CSR], ['reviewer.routes.js', RVR]].forEach(([n, s]) =>
    assert.ok(/msg_type AS "msgType", meta/.test(s), n + ': msgType/meta 미반환'));
});
t('★ 기존 CS 이미지 허용목록을 넓히지 않았다(파일ID로 그린다)', () => {
  assert.ok(/\/api\/drive\/image\/' \+ encodeURIComponent\(id\)/.test(CARD));
  assert.ok(/\/\^\[-\\w\]\{20,\}\$\/\.test\(id\)/.test(CARD), '파일ID 형식 검증 없이 <img src> 에 넣는다');
  [['cs.routes.js', CSR], ['reviewer.routes.js', RVR]].forEach(([n, s]) =>
    assert.ok(/\/api\\\/order\\\/guide-image\\\/\[-\\w\]\{20,\}\$/.test(s), n + ': 이미지 허용목록이 바뀌었다'));
});

/* ── 7) 사본 금지 · 배선 ───────────────────────────────────── */
console.log('\n7) 사본 금지 · 배선');
t('★ 카드 렌더러는 공유 모듈 하나뿐', () => {
  assert.ok(/window\.CsReviewEditCard = \{/.test(CARD));
  [['cs-inquiry.js', CSJ], ['reviewer-cs.js', RCS], ['workdesk.html', WD]].forEach(([n, s]) => {
    assert.ok(/CsReviewEditCard\.html\(/.test(s), n + ' 가 공용 렌더러를 안 쓴다');
    assert.ok(!/리뷰이미지 교체요청<\/span>/.test(s), n + ' 에 카드 마크업 사본이 있다');
  });
});
t('네 화면이 같은 모듈을 로드한다', () => {
  [['admin.html', ADM], ['admin-siand.html', F('admin-siand.html')],
   ['workdesk.html', WD], ['index.html', F('index.html')]].forEach(([n, s]) =>
    assert.ok(/<script src="js\/cs-review-edit-card\.js"><\/script>/.test(s), n + ' 미로드'));
});
t('★ 리뷰어 화면은 읽기 전용', () => {
  assert.ok(/if \(isAdmin && opts\.canAct !== false && meta\.status === 'pending' && rid\)/.test(CARD));
  assert.ok(/CsReviewEditCard\.html\(m\.meta \|\| \{\}, \{ admin: false \}\)/.test(RCS));
});
t('★★ API 베이스는 bare 식별자 — window.API_BASE_URL 은 존재하지 않는다', () => {
  assert.ok(/typeof API_BASE_URL !== 'undefined' && API_BASE_URL/.test(CARD),
    'api.js 의 최상위 const 는 window 프로퍼티가 아니다 → 상대경로가 되어 이미지가 전부 404');
  // ★ 주석은 제외하고 본다 — "window.API_BASE_URL 로 읽지 말라"는 설명 자체가 파일에 있다
  const cardCode = CARD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/window\.API_BASE_URL/.test(cardCode), '코드에서 window.API_BASE_URL 을 읽고 있다');
  assert.ok(/typeof API_BASE_URL !== 'undefined' && API_BASE_URL/.test(CSJ), 'cs-inquiry 의 _reCall 도 동일');
});
/* ★★ 교체요청은 전용 탭에서 **C/S 문의 화면 위의 대기 큐 띠**로 옮겼다(시안 C).
   그래서 nav 는 양쪽 다 'cs' 하나뿐이고, **AE 에게 무엇을 안 그리는지**가 보안 경계가 된다.
   시안 문서 = frontend/docs/design-cs-review-edit-merge.html */
t('★ C/S 메뉴는 관리자·AE 양쪽 / 옛 전용 탭 버튼은 없다', () => {
  const adminNav = WD.slice(WD.indexOf('${isAdmin?`<nav'), WD.indexOf(':isStaff?`<nav'));
  const staffNav = WD.slice(WD.indexOf(':isStaff?`<nav'), WD.indexOf("</nav>`:''}"));
  assert.ok(/data-v="cs"/.test(adminNav) && /data-v="cs"/.test(staffNav),
    '교체요청을 C/S 안에 넣었으면 AE 에게도 그 메뉴가 보여야 한다(안 그러면 AE 가 처리 못 함)');
  assert.ok(!/data-v="reedit"/.test(adminNav) && !/data-v="reedit"/.test(staffNav),
    '옛 전용 탭 버튼이 남아 있다 — 같은 화면으로 가는 문이 둘이 되면 다시 갈라진다');
  assert.ok(/id="reNavBadge"/.test(adminNav) && /id="reNavBadge"/.test(staffNav), '대기 건수 뱃지가 없다');
  assert.ok(/if\(v==='reedit'\)\{ v='cs'/.test(WD), "옛 'reedit' 뷰 이름이 빈 화면으로 떨어진다");
});
t('★ 대기 큐 — 세 모드 + 공용 카드 렌더러 + 문의 화면 높이 보정', () => {
  assert.ok(/const _RE_MODES = \{ rail:1, full:1, collapsed:1 \}/.test(WD), '큐 모드 정의가 없다');
  assert.ok(/function _reRailHtml/.test(WD) && /function _reFullHtml/.test(WD));
  // full 모드는 옛 전용 탭 화면 그대로 — 이미지 대조 폭이 필요한 작업이라 격자를 유지한다
  const full = WD.slice(WD.indexOf('function _reFullHtml'), WD.indexOf('function _reSyncNavBadge'));
  assert.ok(/class="recards"/.test(full) && /CsReviewEditCard\.html\(_reMeta\(r\)/.test(full),
    'full 모드가 공용 카드 격자를 안 쓴다(사본 드리프트)');
  // rail 에서도 승인·반려는 **대화창과 같은 핸들러**여야 한다
  const rail = WD.slice(WD.indexOf('function _reRailHtml'), WD.indexOf('function _reFullHtml'));
  assert.ok(/csApproveReviewEdit\(/.test(rail) && /csRejectReviewEdit\(/.test(rail));
  assert.ok(/CsReviewEditCard\.zoomPair\(/.test(rail), 'rail 썸네일이 기존↔변경 대조로 안 열린다');
  // ★ 띠가 먹은 높이만큼 아래 문의 화면을 줄인다 — 안 하면 답장 입력칸이 화면 밖으로 밀린다
  assert.ok(/function _reFitCsHeight/.test(WD) && /calc\(100vh - 250px - \$\{h\}px\)/.test(WD));
  // ★ 공유 모듈(cs-inquiry.js)은 이 통합으로 바뀌지 않는다 — 관리자 대시보드엔 이 띠가 없다
  assert.ok(!/reQueueMount|requeue|_reFitCsHeight/.test(CSJ),
    '공유 문의창구 모듈이 통합 작업대 전용 띠를 알고 있다(관리자 대시보드까지 같이 바뀐다)');
});
t('★ 처리 후 갱신은 뷰 이름이 아니라 **띠의 존재**로 판정', () => {
  assert.ok(/CS_REVIEW_EDIT_ON_RESOLVED = function\(\)\{ try\{ if\(document\.getElementById\('reQueueMount'\)\)/.test(WD),
    "뷰 이름으로 판정하면 'reedit'→'cs' 같은 이름 변경 때 갱신이 조용히 멈춘다");
});
t('경로 재기준 — 통합 작업대만 Track B', () => {
  assert.ok(/window\.REVIEW_EDIT_API_BASE = '\/api\/trackb\/review-edit'/.test(WD));
  assert.ok(!/REVIEW_EDIT_API_BASE\s*=/.test(ADM), 'admin 이 베이스를 바꾸면 기존 경로가 죽는다');
  assert.ok(/'\/api\/review-edit'/.test(CSJ), '기본값이 기존 경로가 아니다');
});
t('★ 목록 새로고침은 C/S 화면이 있을 때만(AE 403·unhandled rejection 방지)', () => {
  assert.ok(/if \(document\.getElementById\('csRoomListWrap'\)\)/.test(CSJ));
  assert.ok(/p\.catch\(\(\) => \{\}\)/.test(CSJ));
});
t('전용 탭 뱃지는 부팅 때도 채운다 + 클래스가 기존 이름과 안 겹친다', () => {
  assert.ok(/async function _reBootBadge\(\)/.test(WD) && /_reBootBadge\(\);/.test(WD));
  assert.ok(/\.recards\{display:grid/.test(WD) && /\.recard\{/.test(WD));
});

/* ── 8) ★★ 런타임 — 정적 grep 이 못 잡는 것 ────────────────── */
console.log('\n8) ★★ 런타임 확인(선언만으로는 부족한 것들)');
t('★★ 잘못된 id 로 승인/반려해도 **응답이 온다**(Express4 hang 재발 방지)', async () => {
  // 동기 t() 안에서 즉시 확인하기 위해 핸들러 스택만 검사 + 아래 별도 실행으로 보강
  assert.ok(/const _UUID_RE = /.test(TB));
});
(async () => {
  const svc = require('../src/services/trackB.service');
  const pool = require('../src/db/pool');
  svc.canAccessTab = async () => true;
  pool.query = async () => ({ rows: [] });
  const layer = router.stack.find(l => l.route && l.route.path === '/review-edit/approve' && l.route.methods.post);
  const run = (body) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, body: b }); } };
    const stack = layer.route.stack.map(s => s.handle).filter(h => h.name !== 'authMiddleware');
    let i = 0; const next = () => { const h = stack[i++]; if (!h) return resolve({ code: 0 }); h({ admin: { role: 'master', name: 'm' }, body, query: {}, headers: {} }, res, next); };
    next();
  });
  const timeout = (ms) => new Promise(r => setTimeout(() => r({ code: -1 }), ms));
  const bad = await Promise.race([run({ id: 'not-a-uuid' }), timeout(1500)]);
  assert.strictEqual(bad.code, 400, '잘못된 id 에 응답이 오지 않는다(hang) 또는 상태코드가 다르다');
  pass++; console.log('  ✓ ★★ 잘못된 id → 400 즉시 응답(hang 없음)');

  // 카드 렌더러를 실제로 실행 — 리뷰어에게 실명이 그려지지 않는지 확인
  const vm = require('vm');
  const ctx = { window: {}, document: { getElementById: () => null, createElement: () => ({ style: {}, addEventListener() {} }), body: { appendChild() {} } } };
  ctx.window = ctx; ctx.API_BASE_URL = 'https://api.example.com';
  vm.createContext(ctx);
  vm.runInContext(CARD, ctx);
  const html = ctx.window.CsReviewEditCard.html(
    { requestId: 'r1', status: 'approved', resolvedBy: '김수만', oldFileId: 'A'.repeat(22), newFileId: 'B'.repeat(22) },
    { admin: true });
  assert.ok(!/김수만/.test(html), '★ 관리자 실명이 카드에 그려진다(리뷰어 화면에도 같은 렌더러가 쓰인다)');
  assert.ok(/https:\/\/api\.example\.com\/api\/drive\/image\//.test(html), '★ 이미지가 절대 URL 이 아니다');
  assert.ok(!/src="\/api\//.test(html), '상대경로면 프론트(Pages)에서 API(Railway) 이미지를 못 부른다');
  const ro = ctx.window.CsReviewEditCard.html({ requestId: 'r1', status: 'pending' }, { admin: false });
  assert.ok(!/<button/.test(ro), '★ 리뷰어 카드에 버튼이 있다');
  pass += 1; console.log('  ✓ ★★ 카드 실제 렌더 — 실명 미노출 · 절대 URL · 리뷰어 버튼 없음');

  /* ★ 이미지 클릭 = 기존↔변경 **둘 다** 크게 보기(한 장만 뜨면 대조가 안 된다) */
  const OLD = 'A'.repeat(22), NEW = 'B'.repeat(22);
  const clicks = (html.match(/onclick="([^"]*zoomPair[^"]*)"/g) || []);
  assert.strictEqual(clicks.length, 2, '★ 두 썸네일 모두 zoomPair(둘 다 보기)로 열려야 한다');
  clicks.forEach((c) => {
    assert.ok(c.includes(OLD) && c.includes(NEW), '★ 클릭 호출에 기존·변경 파일ID 가 모두 실려야 한다');
  });
  assert.ok(!/zoom\(this\.src\)/.test(html), '★ 클릭한 한 장만 띄우는 옛 호출이 남아 있다');
  assert.ok(/function zoomPair/.test(CARD) && /zoomPair: zoomPair/.test(CARD), 'zoomPair 가 없거나 노출되지 않는다');
  // 호스트 라이트박스(URL 한 장짜리)로 위임하면 "클릭한 것만 보인다"로 되돌아간다
  const pairBody = CARD.slice(CARD.indexOf('function zoomPair'));
  assert.ok(!/woImageModal/.test(pairBody.slice(0, pairBody.indexOf('window.CsReviewEditCard'))),
    '★ zoomPair 가 단일 이미지 라이트박스로 위임한다');
  // onclick 문자열 탈출 차단(파일ID 문자셋 밖은 제거)
  const evil = ctx.window.CsReviewEditCard.html(
    { requestId: 'r2', status: 'pending', oldFileId: OLD + '", alert(1), "', newFileId: NEW }, { admin: true });
  assert.ok(!/alert\(1\)/.test(evil), '★ 파일ID 를 통한 onclick 문자열 탈출이 가능하다');
  pass += 1; console.log('  ✓ ★ 이미지 클릭 → 기존·변경 동시 보기(단일 위임 없음 · onclick 탈출 차단)');

  /* ★★ AE 화면에는 문의창구를 **마운트조차 하지 않는다**
     교체요청이 C/S 문의 안으로 들어가면서 그 메뉴가 AE 에게도 열렸다. 보안 경계는 이제
     "메뉴가 보이나"가 아니라 **"AE 화면에 문의 본문을 그리나"** 다.
     ★ grep 으로 "isAdmin 분기가 있다"만 보면 스코프·실행경로를 못 본다(레포에서 이미 밟은 맹점)
       → renderCsView 를 꺼내 **역할별로 실제 호출**하고 mount/목록조회 횟수를 센다. */
  {
    const src = WD.slice(WD.indexOf('async function renderCsView()'));
    const body = src.slice(0, src.indexOf('\n}\n') + 3);
    const run = async (role) => {
      const calls = { mount: 0, rooms: 0, queue: 0, load: 0 };
      const els = {};
      const el = (id) => (els[id] = els[id] || { innerHTML: '', classList: { add() {} } });
      const win = { CsInquiry: { mount: () => { calls.mount++; } } };
      const fn = new Function('STATE', '$', 'document', 'window', 'CsInquiry', 'loadCsRooms',
        '_reRenderQueue', '_loadReedit', body + '\nreturn renderCsView();');
      await fn({ role }, (sel) => el(String(sel).replace('#', '')),
        { getElementById: (id) => (id === 'tab-cs-inquiry' ? null : el(id)) },
        win, win.CsInquiry,
        async () => { calls.rooms++; }, () => { calls.queue++; }, async () => { calls.load++; });
      return { calls, els };
    };
    const s = await run('staff'), a = await run('admin');
    assert.strictEqual(s.calls.mount, 0, '★★ AE 화면에 문의창구가 마운트됐다 — 리뷰어 실명·연락처·주소가 그려진다');
    assert.strictEqual(s.calls.rooms, 0, '★★ AE 인데 문의 목록을 조회한다(서버 403 이어도 그리려는 시도 자체가 회귀)');
    assert.ok(/관리자만 열람/.test(s.els.csTopNote.innerHTML), 'AE 에게 "왜 문의가 없는지" 안내가 없다(고장으로 오해)');
    assert.strictEqual(a.calls.mount, 1, '관리자 화면에 문의창구가 안 뜬다');
    assert.strictEqual(a.calls.rooms, 1, '관리자 문의 목록을 안 읽는다');
    assert.ok(!(a.els.csTopNote && a.els.csTopNote.innerHTML), '관리자 화면에 AE 안내가 뜬다');
    // 교체요청 큐는 **양쪽 다** — AE 가 이 화면에서 하는 일이 그것뿐이다
    assert.ok(s.calls.queue >= 1 && s.calls.load === 1 && a.calls.queue >= 1 && a.calls.load === 1,
      '역할에 따라 교체요청 큐가 안 뜬다');
    pass += 1; console.log('  ✓ ★★ 역할별 renderCsView 실행 — AE 는 문의 미마운트·미조회 / 교체요청 큐는 양쪽');
  }

  console.log(`\n✅ ${pass} checks passed\n`);
  process.exit(0);
})();
