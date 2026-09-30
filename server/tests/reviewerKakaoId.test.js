/**
 * reviewerKakaoId.test.js — 리뷰어 카카오톡 아이디(사용자 확정 2026-09-30).
 *
 *  ① 가입: 리뷰어 본인 가입은 필수(서버가 세움) · 관리자 경유 등록은 없어도 됨 · 형식 검사 단일 출처
 *  ② 내정보: 본계정 저장(saveKakaoId) · 조회 응답에 kakaoId · 미등록 안내는 "모름"일 때 안 띄움
 *  ③ 작업보드(시안 C): 우클릭 메뉴 맨 위 리뷰어 정보 + 이름 옆 TALK — 판정은 메시지 보내기와 같은
 *     resolveRecipients · 카톡 조회 실패는 "모름"(미등록으로 꾸미지 않음) · 광고주 차단
 * 실행: node tests/reviewerKakaoId.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0;
const ok = (label, cond) => { assert(cond, label); passed++; console.log('  ✓ ' + label); };

const { normalizeKakaoId } = require('../src/utils/kakaoId');
const pool = require('../src/db/pool');
const origQuery = pool.query;
async function withQuery(handler, run) { pool.query = handler; try { await run(); } finally { pool.query = origQuery; } }

// resolveRecipients 스텁(reviewerContact 가 require 시점에 구조분해하므로 먼저 갈아끼운다)
const csRecipient = require('../src/services/csRecipient.service');
let _resolved = [];
csRecipient.resolveRecipients = async ({ participantIds }) => _resolved.filter(r => participantIds.includes(r.participantId));
const { reviewerContactsForRows } = require('../src/services/reviewerContact.service');
const reviewer = require('../src/services/reviewer.service');

(async () => {
  console.log('\n▶ ① 형식 판정');
  ok('앞의 @ 는 떼어 준다', normalizeKakaoId('@review_kim') === 'review_kim');
  ok('빈 값은 빈 문자열', normalizeKakaoId('  ') === '');
  ok('한글·공백이 섞이면 null(추측 수정 금지)', normalizeKakaoId('김 리뷰') === null && normalizeKakaoId('ab cd') === null);
  ok('1자는 거부', normalizeKakaoId('a') === null);
  ok('영문·숫자·._- 허용', normalizeKakaoId('Kim.review-01_x') === 'Kim.review-01_x');

  console.log('\n▶ ② 가입');
  let queries = 0;
  await withQuery(async () => { queries++; return { rows: [], rowCount: 0 }; }, async () => {
    const out = await reviewer.registerReviewer({ name: '김리뷰', phone: '01012345678', consent: true, requireKakaoId: true });
    ok('본인 가입에서 카톡 아이디가 없으면 거부', out.ok === false && out.field === 'kakaoId');
    const bad = await reviewer.registerReviewer({ name: '김리뷰', phone: '01012345678', consent: true, kakaoId: '김리뷰' });
    ok('형식이 틀리면 거부', bad.ok === false && bad.field === 'kakaoId');
  });
  ok('거부 시 DB 쓰기·조회 0건', queries === 0);

  let insertParams = null;
  await withQuery(async (sql, params) => {
    if (/jsonb_array_elements/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO reviewers/.test(sql)) { insertParams = params; return { rows: [{}], rowCount: 1 }; }
    throw new Error('예상하지 못한 쿼리: ' + sql);
  }, async () => {
    const out = await reviewer.registerReviewer({ name: '김리뷰', phone: '01012345678', consent: true, kakaoId: '@review_kim', requireKakaoId: true });
    ok('정상 가입', out.ok === true);
  });
  ok('INSERT 에 정리된 카톡 아이디가 실린다(컬럼 수 ≡ 파라미터 수)', insertParams && insertParams.length === 4 && insertParams[3] === 'review_kim');

  await withQuery(async (sql, params) => {
    if (/jsonb_array_elements/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO reviewers/.test(sql)) { insertParams = params; return { rows: [{}], rowCount: 1 }; }
    throw new Error('예상하지 못한 쿼리');
  }, async () => {
    const out = await reviewer.registerReviewer({ name: '외부리뷰', phone: '01099998888', consent: true });
    ok('관리자 경유 등록(외부모집)은 카톡 아이디 없이도 된다', out.ok === true && insertParams[3] === '');
  });

  let updSql = null;
  await withQuery(async (sql, params) => {
    if (/jsonb_array_elements/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO reviewers/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT name, sub_accounts/.test(sql)) return { rows: [{ name: '김리뷰', sub_accounts: [] }] };
    if (/UPDATE reviewers SET kakao_id/.test(sql)) { updSql = sql; return { rowCount: 1 }; }
    throw new Error('예상하지 못한 쿼리');
  }, async () => {
    const out = await reviewer.registerReviewer({ name: '김리뷰', phone: '01012345678', consent: true, kakaoId: 'kim2', requireKakaoId: true });
    ok('이미 등록된 본인 재가입은 성공', out.ok === true && out.alreadyRegistered === true);
  });
  ok('재가입은 카톡 아이디를 빈 칸일 때만 채운다(내정보 값 보존)', /COALESCE\(kakao_id,''\) = ''/.test(updSql || ''));

  const routes = read('server/src/routes/reviewer.routes.js');
  ok('가입 라우트가 필수를 서버에서 세운다(본문으로 끌 수 없게 spread 뒤)',
    /registerReviewer\(\{ \.\.\.\(req\.body \|\| \{\}\), requireKakaoId: true \}\)/.test(routes));

  console.log('\n▶ ③ 내정보 저장');
  let saved = null;
  await withQuery(async (sql, params) => { saved = { sql, params }; return { rowCount: 1 }; }, async () => {
    const out = await reviewer.handleReviewerProfile({ action: 'saveKakaoId', phone8: '12345678', kakaoId: '@new_id' });
    ok('저장 성공 + 정리된 값 반환', out.ok === true && out.kakaoId === 'new_id');
  });
  ok('저장은 reviewers.kakao_id 한 칸', /UPDATE reviewers SET kakao_id = \$1 WHERE phone8 = \$2/.test(saved.sql) && saved.params[1] === '12345678');
  await withQuery(async () => { throw new Error('쿼리 금지'); }, async () => {
    const out = await reviewer.handleReviewerProfile({ action: 'saveKakaoId', phone8: '12345678', kakaoId: '한글아이디' });
    ok('형식이 틀리면 쓰기 없이 사유를 말한다', out.ok === false && /영문/.test(out.error));
  });
  const svc = read('server/src/services/reviewer.service.js');
  ok('조회(get) 응답에 kakaoId', /kakao_id AS "kakaoId"/.test(svc));
  ok('api.js 액션 등록', /'saveKakaoId':\s*\{ method: 'POST', path: '\/api\/reviewer\/profile', remap: 'saveKakaoId' \}/.test(read('frontend/api.js')));
  ok('부팅 프리플라이트에 컬럼 등록', /\['reviewers', 'kakao_id'\]/.test(read('server/index.js')));
  ok('마이그레이션 170 = 컬럼 추가만', /ADD COLUMN IF NOT EXISTS kakao_id TEXT NOT NULL DEFAULT ''/.test(read('server/migrations/170_reviewer_kakao_id.sql')));

  console.log('\n▶ ④ 화면 — 가입·내정보');
  const search = read('frontend/search.html');
  ok('검색 페이지 로그인창 가입에 카톡 칸', /id="regKakaoInline"/.test(search));
  ok('검색 페이지 등록창에 카톡 칸', /id="regKakao"/.test(search));
  ok('관리자 등록창에도 카톡 칸(서버 필수라 빠지면 막다른 길)', /id="regKakao"/.test(read('frontend/admin.html')) && /id="regKakao"/.test(read('frontend/admin-siand.html')));
  ok('개인정보 수집 항목에 카톡 아이디 고지', /이름, 휴대전화번호, 카카오톡 아이디<\/td>/.test(search));
  const app = read('frontend/js/search-app.js');
  ok('로그인창 가입이 kakaoId 를 보낸다', /registerReviewer", name, phone, consent: "true", kakaoId \}/.test(app));
  for (const f of ['frontend/js/search-register.js', 'frontend/js/index-register.js']) {
    ok(`${path.basename(f)} 가입이 kakaoId 를 보낸다`, /kakaoId:window\._regKakao\|\|''/.test(read(f)));
  }
  const idx = read('frontend/index.html');
  ok('내정보에 카톡 칸(소득 줄 다음)', idx.indexOf('id="pfSelfKakaoId"') > idx.indexOf('id="inlineSelfIncomeName"') && idx.indexOf('id="pfSelfKakaoId"') > 0);
  const fn = idx.slice(idx.indexOf('function renderSelfKakaoId'), idx.indexOf('function focusKakaoIdInput'));
  const els = { pfSelfKakaoId: { value: '', dataset: {} }, pfKakaoNotice: { style: {} } };
  const sb = { document: { getElementById: id => els[id] } };
  vm.runInNewContext(fn + '\nthis.f=renderSelfKakaoId;', sb);
  sb.f(''); ok('값이 비었으면 안내를 띄운다', els.pfKakaoNotice.style.display === 'flex');
  sb.f('kim'); ok('값이 있으면 안내를 숨기고 칸에 채운다', els.pfKakaoNotice.style.display === 'none' && els.pfSelfKakaoId.value === 'kim');
  sb.f(undefined); ok('모르면(구버전 서버) 안내를 띄우지 않는다', els.pfKakaoNotice.style.display === 'none');

  console.log('\n▶ ⑤ 작업보드 재료');
  _resolved = [
    { participantId: 'a', ok: true, phone8: '11112222', phoneFull: '01011112222', name: '김리뷰', rowName: '김리뷰' },
    { participantId: 'b', ok: true, phone8: '33334444', phoneFull: '01033334444', name: '박은비', rowName: '양승호', isSub: true, viaLabel: '타계정' },
    { participantId: 'c', ok: true, phone8: '55556666', phoneFull: '', name: '이중', rowName: '이중' },
    { participantId: 'd', ok: false, reason: '로그인 계정을 찾지 못했습니다' },
  ];
  await withQuery(async (sql, params) => {
    ok('카톡 조회는 판정된 본계정 번호만', /FROM reviewers WHERE phone8 = ANY/.test(sql) && params[0].length === 3);
    return { rows: [
      { phone8: '11112222', kakao: 'kim' },
      { phone8: '55556666', kakao: 'x1' }, { phone8: '55556666', kakao: 'x2' },
    ] };
  }, async () => {
    const r = await reviewerContactsForRows({ sheetId: 's', tabName: 't', participantIds: ['a', 'b', 'c', 'd'] });
    const by = Object.fromEntries(r.items.map(i => [i.participantId, i]));
    ok('등록된 아이디가 실린다', by.a.kakaoKnown && by.a.kakaoId === 'kim');
    ok('타계정 참여 줄은 본계정 정보 + 명의 표시', by.b.isSub && by.b.name === '박은비' && by.b.rowName === '양승호' && by.b.kakaoId === '');
    ok('같은 번호 행이 둘이고 아이디가 다르면 비운다(추측 금지)', by.c.kakaoId === '');
    ok('특정 못 한 줄은 사유를 그대로', by.d.ok === false && /로그인 계정/.test(by.d.reason));
  });
  await withQuery(async () => { throw new Error('boom'); }, async () => {
    const r = await reviewerContactsForRows({ sheetId: 's', tabName: 't', participantIds: ['a'] });
    ok('카톡 조회 실패는 "모름"(미등록으로 꾸미지 않음)', r.kakaoUnavailable === true && r.items[0].kakaoKnown === false && r.items[0].ok === true);
  });

  const tb = read('server/src/routes/trackB.routes.js');
  ok('라우트는 내부인 전용(광고주 차단)', /router\.post\('\/workdesk\/reviewer-contacts', authMiddleware, internalMiddleware,/.test(tb));
  ok('판정 사본 0 — resolveRecipients 를 쓴다', /resolveRecipients/.test(read('server/src/services/reviewerContact.service.js')));

  console.log('\n▶ ⑥ 작업보드 화면(시안 C)');
  const wd = read('frontend/workdesk.html');
  const blk = wd.slice(wd.indexOf('function _contactOf'), wd.indexOf('function renderWorkdesk(wd){'));
  const S = { STATE: { role: 'staff', wd: { _contacts: { map: new Map([
      ['a', { ok: true, name: '김리뷰', phoneFull: '01011112222', phone8: '11112222', kakaoKnown: true, kakaoId: 'kim' }],
      ['b', { ok: true, name: '박은비', phoneFull: '01033334444', phone8: '33334444', isSub: true, rowName: '양승호', kakaoKnown: true, kakaoId: '' }],
      ['d', { ok: false, reason: '로그인 계정을 찾지 못했습니다' }],
    ]) } } },
    esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    _isInternalRole() { return ['master', 'admin', 'staff'].includes(S.STATE.role); } };
  vm.runInNewContext(blk + '\nthis.t=_talkBadge;this.w=_menuWhoHtml;', S);
  ok('등록자 이름 옆 TALK', /class="talk"/.test(S.t({ id: 'a' })));
  ok('미등록자는 자리만(표시 없음)', S.t({ id: 'b' }) === '<span class="talkslot" data-tk="b"></span>');
  ok('메뉴 맨 위에 카톡 아이디 + 복사', /kim/.test(S.w('a')) && /_copyContact\('kakao'/.test(S.w('a')));
  ok('미등록은 "미등록"이라고 말한다', /카톡 아이디 미등록/.test(S.w('b')) && /타계정 참여 · 명의 양승호/.test(S.w('b')));
  ok('특정 못 한 줄은 사유', /로그인 계정을 찾지 못했습니다/.test(S.w('d')));
  S.STATE.wd._contacts = { loading: true };
  ok('도착 전에는 "불러오는 중"', /불러오는 중/.test(S.w('a')));
  S.STATE.role = 'advertiser';
  ok('광고주에게는 아무것도 그리지 않는다', S.t({ id: 'a' }) === '' && S.w('a') === '');
  ok('우클릭 메뉴 맨 앞에 배선', /m\.innerHTML=\n\s+_menuWhoHtml\(STATE\._gMenuRowId\)/.test(wd));
  ok('두 표(기본·그리드) 모두 이름 옆 자리', (wd.match(/_visitBadge\(r\)(\}\$\{| \+ )_talkBadge\(r\)/g) || []).length === 2);
  ok('셀 복사에서 TALK 표시를 뺀다', /\.visit,\.talkslot,/.test(wd));
  ok('탭 렌더 시 재료 요청(비차단)', /STATE\.wd=wd;[^\n]*\n\s+_loadReviewerContacts\(wd\);/.test(wd));
  ok('onclick 에 리뷰어 값 보간 없음(행 id 로 다시 찾는다)', !/_copyContact\('[a-z]+',this,/.test(wd));

  console.log(`\n✅ reviewerKakaoId: ${passed}개 통과`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
