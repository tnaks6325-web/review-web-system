/**
 * homeProgressColumns.test.js — 홈 작업목록 진행 숫자 4칸 + 「아직 안 낸 사람」 팝오버
 *   (시안 확정 2026-09-22 · 시안 frontend/docs/design-pending-popover.html · animate-ui(Prototyper) 버전)
 * 실행: node tests/homeProgressColumns.test.js
 *
 * 무엇을 고정하나 — 이게 깨지면 아픈 것 다섯.
 *  ① **한 칸에 겹쳐 그리던 것을 네 칸으로 세운 이유** — 종전 `인원/제출` 한 칸은 게이지 + `48/50` +
 *     회색 `제출 48` 을 겹쳐 그려서 **50/50 으로 다 찬 것처럼 보이는데 실제 제출은 48** 인 상태가
 *     눈에 안 띄었다(사용자 신고). 칸을 도로 합치면 그 사고가 그대로 돌아온다.
 *  ② **목록 건수 ≡ 화면의 "N명 남음"** — 서버 목록과 화면 잔여가 **같은 기준**이라야 한다.
 *     제출 = 참여자 중 안 낸 사람 · 입금 = **제출까지 한 사람 중** 입금 안 된 사람(홈 미입금 필터와 같은 함수).
 *     한쪽만 고치면 "11명 남음이라 눌렀더니 12명"이 된다.
 *  ③ **명단·채움 판정 사본 0** — 목록은 마감자료가 쓰는 `_closeoutRoster` 를 그대로 태우고,
 *     사람 수는 `rowNumbering.isFilledRow`(홈 게이지 분자와 같은 기준)로 센다. 빈 슬롯은 사람이 아니다.
 *  ④ **데이터 최소화** — 홈 목록은 명단 화면이 아니다. 연락처는 **뒤 4자리만** 나간다.
 *  ⑤ **팝오버 규율** — body 직속(표는 가로 스크롤 컨테이너라 안에 그리면 잘린다) · 스크롤·리사이즈에는
 *     닫는다(앵커를 못 따라가는 팝오버는 엉뚱한 자리를 가리킨다) · onclick 에는 **인덱스만**.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 홈 작업목록 진행 숫자 4칸 + 미완료 팝오버\n');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const WD = F('workdesk.html');
const MOCK = F('docs/design-pending-popover.html');
const ROUTES = S('src/routes/trackB.routes.js');
const SVC_SRC = S('src/services/trackB.service.js');

const pool = require('../src/db/pool');
const svc = require('../src/services/trackB.service');

/* 함수 경계로 자른다 — 파일 전체 검사는 "다른 함수에 그 문자열이 있으면" 통과시킨다(레포 실측 함정). */
const cut = (src, head, tailMark) => {
  const a = src.indexOf(head);
  assert(a > 0, head + ' 를 찾지 못했습니다');
  const b = src.indexOf(tailMark, a);
  return src.slice(a, b > a ? b : a + 8000);
};
const PP = cut(SVC_SRC, 'async function pendingParticipants(', '\n// ');

/* ═══ 1) 판정·명단 사본 0 ═══════════════════════════════════════════════ */
console.log('1) 판정·명단 사본 0');
t('★★ 목록은 마감자료와 **같은 명단 함수**를 태운다(_closeoutRoster)', /_closeoutRoster\(/.test(PP));
t('★★ 사람 수는 채움 판정 단일 출처(isFilledRow) — 빈 슬롯은 사람이 아니다',
  /_isFilledRow\(/.test(PP));
t('★ 명단을 직접 조회하지 않는다(사본 금지)', !/FROM campaign_participants/i.test(PP));
t('★★ 입금 미완료 = **제출까지 한 사람 중** 입금 안 된 사람(홈 미입금 필터와 같은 기준)',
  /r\.submitted && !r\.paid/.test(PP));
t('★ 제출 미완료 = 참여자 중 안 낸 사람', /:\s*!r\.submitted/.test(PP));

/* ═══ 2) 데이터 최소화 · 조용한 절단 금지 ══════════════════════════════ */
console.log('\n2) 데이터 최소화 · 조용한 절단 금지');
t('★★ 연락처는 뒤 4자리만 나간다', /slice\(-4\)/.test(PP) && !/phone8:\s*r\.phone8/.test(PP));
t('★ 상한을 넘기면 자른 사실을 말한다', /truncated:/.test(PP));
t('★ 상한이 있다(한 작업의 명단 전체가 홈으로 흘러들지 않는다)', /Math\.min\(500/.test(PP));

/* ═══ 3) 라우트 — 내부인 전용 + 스코프 ═════════════════════════════════ */
console.log('\n3) 라우트');
const router = require('../src/routes/trackB.routes');
const layer = router.stack.filter(l => l.route && l.route.path === '/workdesk/pending');
t('/workdesk/pending 이 등록돼 있다', layer.length === 1);
t('★ GET 만 연다(읽기 전용)', layer[0].route.methods.get === true && !layer[0].route.methods.post);
t('★★ 내부인 전용 — 인증 + internalMiddleware 를 지난다',
  /router\.get\('\/workdesk\/pending', authMiddleware, internalMiddleware/.test(ROUTES));
const RT = cut(ROUTES, "router.get('/workdesk/pending'", '\n});');
t('★ 작업보드·스레드와 같은 스코프 게이트를 한 번 더 태운다', /_ensureThreadScope\(req, sheetId, tabName\)/.test(RT));
t('★ 라우트에 판정 사본이 없다(서비스가 단독으로 갖는다)',
  !/isFilledRow|submitted && !/.test(RT) && /svc\.pendingParticipants\(/.test(RT));

/* ═══ 4) 서비스 실제 실행 ══════════════════════════════════════════════ */
console.log('\n4) 서비스 실제 실행 — 스텁 명단으로');
const origQuery = pool.query.bind(pool);
const ROSTER = [
  // 채워진 줄 4 + 빈 슬롯 2. 제출 2명 · 그중 입금 1명.
  { id: 1, seq: 1, name: '김서연', recipient: '', phone8: '12341234', round: 1, option: '', product: '',
    submitted: true, paid: true, submittedAt: '2026-08-18T00:00:00Z', startDate: '8 / 18 (월)', source: 'import', order_submission_id: null, identity_key: 'a' },
  { id: 2, seq: 2, name: '이준호', recipient: '', phone8: '22225678', round: 1, option: '', product: '',
    submitted: true, paid: false, submittedAt: '2026-08-19T00:00:00Z', startDate: '8 / 19 (화)', source: 'import', order_submission_id: null, identity_key: 'b' },
  { id: 3, seq: 3, name: '박민지', recipient: '', phone8: '33339999', round: 1, option: '', product: '',
    submitted: false, paid: false, submittedAt: null, startDate: '8 / 20 (수)', source: 'import', order_submission_id: null, identity_key: 'c' },
  { id: 4, seq: 4, name: '', recipient: '', phone8: '', round: 1, option: '', product: '',
    submitted: false, paid: false, submittedAt: null, startDate: '8 / 21 (목)', source: 'worktable', order_submission_id: 'o-9', identity_key: null },
  { id: 5, seq: 5, name: '', recipient: '', phone8: '', round: 1, option: '', product: '',
    submitted: false, paid: false, submittedAt: null, startDate: '8 / 22 (금)', source: 'worktable', order_submission_id: null, identity_key: null },
  { id: 6, seq: 6, name: '   ', recipient: '  ', phone8: '  ', round: 1, option: '', product: '',
    submitted: false, paid: false, submittedAt: null, startDate: '', source: 'worktable', order_submission_id: null, identity_key: null },
];
pool.query = async (q) => {
  const sql = String(q);
  if (/FROM campaign_participants/i.test(sql)) return { rows: ROSTER, rowCount: ROSTER.length };
  if (/FROM participant_edits/i.test(sql)) return { rows: [], rowCount: 0 };
  return { rows: [], rowCount: 0 };
};

(async () => {
  const sub = await svc.pendingParticipants({ sheetId: 'S', tabName: 'T', kind: 'submit' });
  t('★★ 빈 슬롯은 사람이 아니다 — 참여자는 4명(주문만 붙은 줄 포함, 공백뿐인 줄 제외)',
    sub.filled === 4, 'filled=' + sub.filled);
  t('제출 미완료 = 2명(박민지 + 주문만 붙은 줄)', sub.pending === 2, 'pending=' + sub.pending);
  t('★ 목록에 이름·줄번호·구매일이 있다',
    sub.items.some(x => x.name === '박민지' && x.seq === 3 && x.day === '8 / 20 (수)'));
  t('★★ 연락처는 뒤 4자리만(전체 번호가 홈으로 나가지 않는다)',
    sub.items.every(x => !x.tail || x.tail.length === 4) && sub.items.some(x => x.tail === '9999')
    && !JSON.stringify(sub.items).includes('33339999'));

  const paid = await svc.pendingParticipants({ sheetId: 'S', tabName: 'T', kind: 'paid' });
  t('★★ 입금 미완료 = 제출한 사람 중 1명(참여만 한 사람은 아직 입금 대상이 아니다)',
    paid.pending === 1 && paid.items[0].name === '이준호', 'pending=' + paid.pending);

  const capped = await svc.pendingParticipants({ sheetId: 'S', tabName: 'T', kind: 'submit', limit: 1 });
  t('★ 상한을 넘기면 자른 사실을 말한다', capped.items.length === 1 && capped.truncated === true);

  pool.query = origQuery;

  /* ═══ 5) 화면 — 네 칸 + 시안 값 ═════════════════════════════════════ */
  console.log('\n5) 화면 — 네 칸 · 시안 값');
  t('★★ 헤더가 네 칸으로 서 있다(총건수·참여·제출·입금)',
    /<th class="nh">총건수<\/th><th class="nh">참여<\/th><th class="nh">제출<\/th><th class="nh">입금<\/th>/.test(WD));
  t('★★ 종전 한 칸 표기로 되돌아가지 않았다(`인원/제출` 머리글·게이지 없음)',
    !/<th>인원\/제출<\/th>/.test(WD) && !/_finProgHtml/.test(WD));
  t('★ 보관함의 마감일·마감자는 상태 칸 안으로(열 수를 같게 유지)',
    /wbl-s fin[\s\S]{0,120}wbl-s-sub/.test(WD));
  const CELLS = cut(WD, 'function _finNumCells(', '\n/* ══');
  t('★ 총건수를 모르면 줄 수로 접고 `*` 로 말한다(0 위장 금지)', /total==null\?'\*':''/.test(CELLS));
  t('★★ 초과는 색으로만(참여 상자를 붉게) — 숫자를 지어내지 않는다', /over\?'isover'/.test(CELLS));
  t('★★ onclick 에는 인덱스만 넘긴다(작업명은 시트에서 온 문자열)',
    /openPendingFromHome\(\$\{i\},'\$\{kind\}',this\)/.test(CELLS) && !/openPendingFromHome\([^)]*tabName/.test(CELLS));

  /* 시안 ≡ 실제 — 사용자가 확정한 수치가 화면에 그대로 있는가 */
  const px = (src, re) => { const m = src.match(re); return m ? m[1] : null; };
  t('★★ 상자 높이는 시안과 같다(네 칸 통일)',
    px(WD, /td\.nc \.box\{[^}]*min-height:(\d+)px/) === px(MOCK, /td\.nc \.box\{[^}]*min-height:(\d+)px/));
  t('★★ 상태 배지 곡률은 숫자 상자와 같다(알약 999px 로 되돌리지 않는다)',
    /\.wbl-s\{[^}]*border-radius:6px/.test(WD) && !/\.wbl-s\{[^}]*border-radius:999px/.test(WD));
  t('★ 배지 글자는 담당 칸 값과 같은 크기·굵기(12px/400 — 굵은 750 으로 되돌리지 않는다)',
    /\.wbl-s\{[^}]*font-size:12px;font-weight:400/.test(WD));
  t('★ 녹색을 쓰지 않는다(사용자 지시)', !/\.wbl-s\.run\{[^}]*safe/.test(WD));
  t('★ 밑줄로 클릭을 알리지 않는다(사용자 결정 — 연파랑 상자로 구분)',
    !/box\.clickable\{[^}]*text-decoration/.test(WD));

  /* ═══ 6) 팝오버 — animate-ui 규율 ═══════════════════════════════════ */
  console.log('\n6) 팝오버 — animate-ui(Prototyper)');
  const POP = cut(WD, 'function openPendingFromHome(', '\nfunction _finBodyHtml(');
  const WPEL = cut(WD, 'function _wpEl(', '\nfunction closePendingPop(');
  t('★★ body 직속으로 띄운다(표는 가로 스크롤 컨테이너라 안에 그리면 잘린다)',
    /document\.body\.appendChild\(d\)/.test(WPEL));
  t('★★ 스크롤·리사이즈에는 닫는다(앵커를 못 따라가는 팝오버를 남기지 않는다)',
    /addEventListener\('scroll',[\s\S]{0,40}closePendingPop/.test(WPEL) && /addEventListener\('resize',[\s\S]{0,40}closePendingPop/.test(WPEL));
  t('★ 바깥 클릭·Esc 로 닫힌다', /addEventListener\('click',function\(\)\{ closePendingPop\(\); \}\)/.test(WPEL)
    && /e\.key==='Escape'/.test(WPEL));
  t('★ 전역 리스너는 최상위 1회만 건다(열 때마다 쌓지 않는다)', /_WPEND\.bound/.test(WPEL));
  t('★ 늦게 온 응답이 화면을 덮지 않는다(seq 가드)', /my!==_WPEND\.seq/.test(POP));
  t('★ 실패를 조용히 넘기지 않는다(사유를 말한다)', /불러오지 못했습니다/.test(POP));
  t('★★ 서버가 준 목록을 그대로 그린다(화면에서 다시 세지 않는다)',
    /j\.pending/.test(POP) && !/filter\(/.test(POP));
  const CLOSE = cut(WD, 'function closePendingPop(', '\n/* 앵커');
  t('★ 애니메이션 이벤트가 안 와도 반드시 닫는다(setTimeout 백스톱)', /setTimeout\(done/.test(CLOSE));
  t('★★ animate-ui 수치 — 열기 150ms / 닫기 100ms',
    /#wblPend\.open\{[^}]*animation:wpIn 150ms/.test(WD) && /#wblPend\.closing\{[^}]*animation:wpOut 100ms/.test(WD));
  t('★ 움직임을 줄이는 설정을 존중한다', /prefers-reduced-motion:reduce\)\{#wblPend\.open/.test(WD));

  /* ═══ 7) 좁은 화면 — 칸 번호가 밀린 것을 따라갔다 ═══════════════════ */
  console.log('\n7) 좁은 화면');
  t('★★ 숨김 범위가 새 칸 번호를 따라간다(n+8 → n+10)',
    /td:nth-child\(n\+10\)\{display:none\}/.test(WD) && !/td:nth-child\(n\+8\)\{display:none\}/.test(WD));
  t('★ 숫자 네 칸이 둘째 줄에 나란히 선다', /td:nth-child\(8\)\{grid-column:5\}/.test(WD));
  t('★ 상태 배지는 작업명과 같은 줄 오른쪽에', /td:nth-child\(9\)\{grid-column:1\/-1;grid-row:1;justify-self:end/.test(WD));

  console.log(`\n✅ ${pass} 케이스 통과\n`);
  process.exit(0);
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
