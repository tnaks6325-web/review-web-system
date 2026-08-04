/**
 * 리뷰웹시스템[3버전] 작업오더 — 처리 열 재설계 회귀가드
 *
 * 사용자 신고(2026-08-04):
 *   ① 상태변경이 `prompt()` 로 **영문 상태값**(submitted/reviewing/…)을 직접 타이핑하게 해서
 *      비개발자는 바꿀 상태를 알 수도, 바꿀 수도 없었다.
 *   ② 행을 누르면 상세가 펼쳐지는데 처리 열에 [상세] 버튼이 또 있었다(하는 일이 겹침).
 *   ③ 접수하기 / 접수완료가 구분되지 않았다.
 *   ④ 모집공고를 즉시 미리볼 수 없었다(작업오더 → 공고로 가는 다리가 아예 없었다).
 *
 * ★ 이 가드가 고정하는 것
 *   - 상태 이름·전이표·접수 판정은 **공유 모듈 하나**(js/work-order-detail.js)가 갖는다.
 *     사본을 두면 관리자 대시보드와 이름이 갈라지고("검토중" vs "접수됨"),
 *     전이표가 서버(ORDER_TRANSITIONS)와 어긋나면 화면이 통과시킨 버튼이 400 으로 튕긴다.
 *   - 프리필 조립(_woCampaignPrefill)도 한 벌 — 두 화면이 서로 다른 공고를 만들 수 없다.
 *   - 화면 전이표 ⊆ 서버 전이표 (파일에서 실제로 읽어 대조 — grep 으로는 못 잡는다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const F = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const S = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

const HTML = F('workdesk.html');
const WOD = F('js/work-order-detail.js');
const APP = F('js/index-app.js');
const REC = F('js/index-recruit.js');
const CAMP = F('campaign.html');
const ORD = S('routes/order.routes.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

/* ══════════════════════════════════════════════════════════
   1. 상태 표기·전이 — 단일 출처
   ══════════════════════════════════════════════════════════ */
console.log('\n1) 상태 표기·전이표는 공유 모듈 한 벌');

t('공유 모듈이 라벨·설명·전이표·접수판정을 갖는다', () => {
  ['const WO_LABELS = {', 'const WO_STATUS_HINTS = {', 'const WO_TRANSITIONS = {',
   'const WO_ACCEPT_ELIGIBLE =', 'function _woAcceptable(o)'].forEach(s =>
    assert.ok(WOD.includes(s), '모듈에 없음: ' + s));
  ['WO_LABELS: WO_LABELS', 'WO_STATUS_HINTS: WO_STATUS_HINTS', 'WO_TRANSITIONS: WO_TRANSITIONS',
   '_woAcceptable: _woAcceptable', '_woCampaignPrefill: _woCampaignPrefill'].forEach(s =>
    assert.ok(WOD.includes(s), '전역 미공개: ' + s));
});

t('★ 사본 금지 — workdesk·index-app 어디에도 두 번째 표가 없다', () => {
  assert.ok(!/const WO_STATUS\s*=/.test(HTML), 'workdesk 에 WO_STATUS 사본이 되살아났다');
  [HTML, APP].forEach((src, i) => {
    ['WO_LABELS', 'WO_TRANSITIONS', 'WO_COLORS', 'WO_DELIVERY_MAP', 'WO_CHANNEL_HOSTS'].forEach(n =>
      assert.ok(!new RegExp('(const|let|var)\\s+' + n + '\\s*=').test(src),
        (i ? 'index-app' : 'workdesk') + ' 에 ' + n + ' 사본이 있다'));
  });
  ['_woOptionRows', '_woFirstProductInfo', '_woBuildInflowHtml', '_woPlainGuideToHtml',
   '_woReviewImgHtml', '_woChannel', '_woChannelFromUrl', '_woCampaignPrefill'].forEach(n =>
    assert.ok(!new RegExp('function\\s+' + n + '\\s*\\(').test(APP),
      'index-app 에 ' + n + ' 사본이 남아 있다(공유 모듈로 이관됨)'));
});

t('★★ 화면 전이표 ⊆ 서버 전이표 — 화면이 통과시킨 버튼이 400 으로 튕기지 않는다', () => {
  const grab = (src, name) => {
    const i = src.indexOf('const ' + name + ' = {');
    assert.ok(i >= 0, name + ' 를 찾지 못함');
    const j = src.indexOf('\n};', i);
    return vm.runInNewContext('(' + src.slice(i + ('const ' + name + ' = ').length, j + 2) + ')');
  };
  const front = grab(WOD, 'WO_TRANSITIONS');
  const server = grab(ORD, 'ORDER_TRANSITIONS');
  assert.deepStrictEqual(Object.keys(front).sort(), Object.keys(server).sort(), '상태 집합이 다르다');
  for (const st of Object.keys(front)) {
    for (const to of front[st]) {
      assert.ok(server[st].includes(to),
        `화면이 제시하는 전이 ${st}→${to} 를 서버가 허용하지 않는다(누르면 400)`);
    }
  }
});

t('접수 판정도 서버 ACCEPT_ELIGIBLE 과 같은 표', () => {
  const front = vm.runInNewContext('(' +
    WOD.slice(WOD.indexOf('const WO_ACCEPT_ELIGIBLE = [') + 'const WO_ACCEPT_ELIGIBLE = '.length,
              WOD.indexOf('];', WOD.indexOf('const WO_ACCEPT_ELIGIBLE = [')) + 1) + ')');
  const m = ORD.match(/const ACCEPT_ELIGIBLE = (\[[^\]]*\])/);
  assert.ok(m, '서버 ACCEPT_ELIGIBLE 를 찾지 못함');
  // vm 산 배열은 프로토타입이 달라 deepStrictEqual 이 값이 같아도 실패한다 → 값으로 비교
  assert.deepStrictEqual([...front].sort(), [...vm.runInNewContext('(' + m[1] + ')')].sort());
});

t('라벨은 한국어 — 영문 상태값을 화면에 노출하지 않는다', () => {
  const labels = vm.runInNewContext('(' +
    WOD.slice(WOD.indexOf('const WO_LABELS = {') + 'const WO_LABELS = '.length,
              WOD.indexOf('\n};', WOD.indexOf('const WO_LABELS = {')) + 2) + ')');
  Object.entries(labels).forEach(([k, v]) => {
    assert.ok(/[가-힣]/.test(v), k + ' 라벨이 한국어가 아니다: ' + v);
    assert.ok(v !== k, k + ' 라벨이 영문 상태값 그대로다');
  });
  // 사용자가 요구한 구분 — 접수 전/후가 말로 갈려야 한다
  assert.strictEqual(labels.submitted, '접수대기');
  assert.strictEqual(labels.reviewing, '접수완료');
  // 고를 수 있는 상태마다 "누르면 무슨 일이 일어나는가" 한 줄이 있어야 한다
  const hints = WOD.slice(WOD.indexOf('const WO_STATUS_HINTS = {'));
  Object.keys(labels).forEach(k => assert.ok(new RegExp('\\b' + k + ':').test(hints.slice(0, 1200)),
    k + ' 설명 문구가 없다'));
});

/* ══════════════════════════════════════════════════════════
   2. 처리 열 — 상세 제거 · 접수하기/접수완료 구분
   ══════════════════════════════════════════════════════════ */
console.log('\n2) 처리 열');

t('★ [상세] 버튼 제거 — 행을 누르면 펼쳐진다(하는 일이 겹치지 않게)', () => {
  assert.ok(!/function _woActions\s*\(/.test(HTML), '_woActions(상세 버튼 래퍼)가 되살아났다');
  assert.ok(/onclick="_woToggle\(\$\{i\}\)" title="클릭하면 상세가 아래로 펼쳐집니다"/.test(HTML),
    '행 클릭 펼침이 사라졌다 — 상세로 가는 길이 없어진다');
  assert.ok(/>\$\{_woEditActions\(o\)\}<\/td>/.test(HTML), '처리 셀은 _woEditActions 한 곳에서만 만든다');
});

t('★ 접수하기 ↔ ✓ 접수완료 — 눌러도 아무 일 없는 버튼을 두지 않는다', () => {
  const i = HTML.indexOf('function _woEditActions(o){');
  assert.ok(i >= 0);
  const body = HTML.slice(i, i + 1600);
  assert.ok(/_woAcceptable\(o\)/.test(body), '접수 가능 판정을 공유 모듈에 묻지 않는다(사본 위험)');
  assert.ok(/접수하기<\/button>/.test(body) && /✓ 접수완료<\/button>/.test(body));
  assert.ok(/class="btn xs wodone" disabled/.test(body), '접수완료 버튼이 비활성이 아니다');
  assert.ok(/등록된 탭 — /.test(body), '접수완료 버튼이 어느 탭에 등록됐는지 말하지 않는다');
  assert.ok(/\.btn\.xs\.wodone\{/.test(HTML), '접수완료 버튼 스타일(초록)이 없다 — 접수하기와 안 갈린다');
});

t('편집 게이트는 한 곳(canEdit) — 표 셀과 펼침 패널이 같은 것을 쓴다', () => {
  assert.ok(/function _woEditActions\(o\)\{\s*\n\s*if\(!STATE\.canEdit\) return '';/.test(HTML));
  assert.strictEqual((HTML.match(/_woAccept\('\$\{id\}'\)/g) || []).length, 1);
});

/* ══════════════════════════════════════════════════════════
   3. 상태 변경 — prompt 제거, 고를 수 있는 것만 버튼으로
   ══════════════════════════════════════════════════════════ */
console.log('\n3) 상태 변경 모달');

t('★★ prompt() 로 영문 상태값을 타이핑시키지 않는다', () => {
  const i = HTML.indexOf('function _woStatus(id){');
  assert.ok(i >= 0, '_woStatus 가 없다');
  const body = HTML.slice(i, HTML.indexOf('async function _woStatusPick', i));
  assert.ok(!/prompt\(/.test(body), 'prompt() 가 되살아났다 — 비개발자는 상태 이름을 알 수 없다');
  assert.ok(!/submitted \/ reviewing/.test(HTML), '영문 상태값 안내 문구가 남아 있다');
  assert.ok(/window\.WO_TRANSITIONS/.test(body), '전이표를 공유 모듈에서 읽지 않는다');
  assert.ok(/WO_STATUS_HINTS/.test(body), '설명 한 줄을 붙이지 않는다');
  assert.ok(/_woStatusPick\(/.test(body), '버튼이 전이를 실행하지 않는다');
});

t('종착 상태는 버튼 대신 이유를 말한다', () => {
  assert.ok(/더 바꿀 수 있는 상태가 없습니다/.test(HTML));
});

t('서버가 요구하는 두 조건을 누르기 전에 화면에서 받는다', () => {
  const i = HTML.indexOf('async function _woStatusPick(id, to){');
  const body = HTML.slice(i, i + 1200);
  assert.ok(/to==='published' && !chat/.test(body), '발행 시 카톡 URL 필수 검사가 없다');
  assert.ok(/to==='rejected'\|\|to==='revision'/.test(body) && /confirm\(/.test(body),
    '반려·보완요청 사유 확인이 없다');
  assert.ok(/chat_room_url:chat/.test(body) && /admin_memo:memo/.test(body), '메모·URL 을 함께 보내지 않는다');
  // 서버도 같은 조건을 강제하고 있어야 한다(화면만 막으면 우회 가능)
  assert.ok(/카톡 팀채팅방URL이 있어야 모집공고발행이 가능합니다/.test(ORD));
});

/* ══════════════════════════════════════════════════════════
   4. 모집공고 즉시 미리보기
   ══════════════════════════════════════════════════════════ */
console.log('\n4) 모집공고 즉시 미리보기');

t('작업오더 → 공고 다리가 있다(연결 여부로 문구가 갈린다)', () => {
  const i = HTML.indexOf('function _woEditActions(o){');
  const body = HTML.slice(i, i + 1600);
  assert.ok(/o\.linked_campaign_id/.test(body), '연결된 공고 여부를 보지 않는다');
  assert.ok(/👁 모집공고/.test(body) && /📢 모집공고/.test(body));
  assert.ok(/_woCampaign\('\$\{id\}'\)/.test(body));
});

t('★ 프리필은 공유 모듈 — 관리자 대시보드와 같은 공고가 만들어진다', () => {
  assert.ok(/_woCampaignPrefill\(o\)/.test(HTML), 'workdesk 가 공유 프리필을 쓰지 않는다');
  assert.ok(/const prefill = _woCampaignPrefill\(o\);/.test(APP), 'index-app 이 공유 프리필을 쓰지 않는다');
  const i = HTML.indexOf('async function _woCampaign(id){');
  const body = HTML.slice(i, i + 1200);
  assert.ok(/o\.linked_campaign_id\) await openRecruitModal\(o\.linked_campaign_id\)/.test(body),
    '연결된 공고는 그 공고를 열어야 한다(새 공고를 또 만들면 중복 발행)');
  assert.ok(/await loadRecruitTabOptions\(\)/.test(body),
    '연결 탭 목록을 기다리지 않으면 드롭다운이 빈 채로 열린다');
});

t('★ 미리보기 렌더러가 로드된다 — 없으면 미리보기 카드가 조용히 비어 보인다', () => {
  assert.ok(/<script src="js\/campaign-workdetail\.js"><\/script>/.test(HTML),
    'workdesk 에 campaign-workdetail.js 미로드');
  assert.ok(HTML.indexOf('js/campaign-workdetail.js') < HTML.indexOf('js/index-recruit.js'),
    'index-recruit.js 보다 뒤면 _renderPreview 가 window.CampWorkDetail 을 못 찾는다');
});

/* ══════════════════════════════════════════════════════════
   5. 경로 재기준 — 인트라넷 SSO 토큰이 닿는 경로로만
   ══════════════════════════════════════════════════════════ */
console.log('\n5) 경로 재기준(SSO 토큰 격리)');

t('연결 탭 목록은 호스트가 재기준(RECRUIT_TABS_API)', () => {
  assert.ok(/window\.RECRUIT_TABS_API\) \|\| "\/api\/tab\/dashboard"/.test(REC),
    '전역 미설정 시 기존 경로 폴백이 없다(관리자 대시보드 동작 불변이어야 한다)');
  assert.ok(/API_BASE_URL \+ _recruitTabsApi\(\)/.test(REC));
  assert.ok(/window\.RECRUIT_TABS_API = '\/api\/trackb\/tabs'/.test(HTML));
  assert.ok(/r\.spreadsheetTitle/.test(REC), 'trackb 응답의 시트 제목 필드를 읽지 않는다');
});

t('★ 공고 상세(수정 프리필)도 재기준 — 안 하면 공개뷰가 와서 모달이 빈 칸으로 열린다', () => {
  assert.ok(/window\.CAMPAIGN_ADMIN_API\)\s*\n\s*\? _campApi\(`\/\$\{encodeURIComponent\(id\)\}`\)/.test(REC));
  assert.ok(REC.includes(': API_BASE_URL + `/api/campaign/${id}`'), '관리자 대시보드 경로 폴백이 없다');
});

t('Track B 에 GET /campaigns/:id 가 실제로 등록돼 있다(라우터 스택 실검사)', () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:5432/x';
  const router = require('../src/routes/trackB.routes.js');
  const has = (m, p) => router.stack.some(l => l.route && l.route.path === p && l.route.methods[m]);
  assert.ok(has('get', '/campaigns/:id'), 'GET /campaigns/:id 미등록 — 수정 모달 프리필이 404');
  // /campaigns/list 가 먼저 등록돼야 :id 가 'list' 를 삼키지 않는다
  const iList = router.stack.findIndex(l => l.route && l.route.path === '/campaigns/list');
  const iId = router.stack.findIndex(l => l.route && l.route.path === '/campaigns/:id' && l.route.methods.get);
  assert.ok(iList >= 0 && iList < iId, '/campaigns/list 가 /campaigns/:id 뒤에 있으면 목록이 삼켜진다');
  // 내부인 게이트(광고주 차단)
  const layer = router.stack.find(l => l.route && l.route.path === '/campaigns/:id' && l.route.methods.get);
  const names = layer.route.stack.map(s => s.handle.name);
  assert.ok(names.includes('authMiddleware') && names.includes('internalMiddleware'),
    '인증·내부인 게이트 없음: ' + names.join(','));
});

t('리뷰어 화면 미리보기는 401/403 일 때만 Track B 로 폴백', () => {
  assert.ok(/if\(r\.status === 401 \|\| r\.status === 403\)\s*\n\s*r = await _pvGet\('\/api\/trackb\/campaigns\/'/.test(CAMP),
    '그 외 오류까지 재시도하면 실패 원인이 가려진다');
  assert.ok(/_pvGet\('\/api\/campaign\/admin\/'/.test(CAMP), '관리자 경로가 먼저여야 한다(기존 동작 불변)');
});

/* ══════════════════════════════════════════════════════════
   6. ★★ 편집 권한자 = 전체 편집 페이로드 (Codex 리뷰 P1)

   편집 허용명단에는 `staff`(AE)도 들어갈 수 있다. 그 사람은 공고를 **수정할 수 있는데**
   JWT role 이 admin/master 가 아니라 원본 핸들러의 `_isAdminReq` 에서 공개 화이트리스트 뷰를
   받았다 → 수정 모달이 work_detail·연결탭·정원·옵션을 **빈 기본값으로 초기화**하고,
   그대로 저장하면 기존 설정이 조용히 0·빈값·`options:[]` 로 지워진다.
   grep 으로는 못 잡는다 → **스텁 pool 로 실제 핸들러를 호출**해 응답 모양을 본다.
   ══════════════════════════════════════════════════════════ */
const ROW = {
  id: 'camp-1', title: '탈취제', status: 'active', participation_mode: true,
  work_detail: { productLines: '탈취제 - 9,900원' }, linked_sheet_id: 'SHEET1',
  linked_tab_name: '0803 탈취제', daily_limit: 40, recruit_total: 800,
  chat_url: 'https://open.kakao.com/o/x', notes: '내부 메모',
};
const pool = require('../src/db/pool');
pool.query = async (sql) => (/FROM recruit_campaigns WHERE id/.test(sql) ? { rows: [ROW] } : { rows: [] });
const campRouter = require('../src/routes/campaign.routes');
const detailLayer = campRouter.stack.find(l => l.route && l.route.path === '/:id' && l.route.methods.get);
assert.ok(detailLayer, 'campaign.routes GET /:id 없음');
const detail = detailLayer.route.stack[detailLayer.route.stack.length - 1].handle;
const callDetail = (req) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
                json(b) { resolve({ statusCode: this.statusCode, body: b }); return this; } };
  Promise.resolve(detail(Object.assign({ params: { id: 'camp-1' }, headers: {}, query: {} }, req), res,
    (e) => resolve({ next: true, e }))).catch((e) => resolve({ threw: true, e }));
});

(async () => {
  console.log('\n6) 편집 권한자에게 전체 편집 페이로드');

  const trusted = await callDetail({ _trustedAdminView: true });
  t('\u2605\u2605 신뢰 플래그가 있으면 staff 편집자도 전체 행 + 옵션 + 리뷰비 구간을 받는다', () => {
    assert.ok(trusted.body && trusted.body.ok, '응답 실패: ' + JSON.stringify(trusted).slice(0, 200));
    assert.ok(trusted.body.data.work_detail, 'work_detail 이 빠졌다 — 저장 시 작업내용이 지워진다');
    assert.strictEqual(trusted.body.data.linked_tab_name, '0803 탈취제', '연결 탭이 빠졌다');
    assert.strictEqual(trusted.body.data.daily_limit, 40, '정원이 빠졌다 — 저장 시 0 으로 덮인다');
    assert.ok('options' in trusted.body && 'feeSchedules' in trusted.body, '옵션·리뷰비 구간 프리필이 없다');
  });

  const plain = await callDetail({});
  t('플래그가 없으면 종전대로 공개 화이트리스트 뷰(권한 상승 아님)', () => {
    assert.ok(plain.body && plain.body.ok);
    assert.ok(!('work_detail' in plain.body.data), '무권한에 work_detail 이 샜다');
    assert.ok(!('chat_url' in plain.body.data) && !('notes' in plain.body.data), '무권한에 내부 필드가 샜다');
  });

  Object.prototype._trustedAdminView = true;                 // 프로토타입 오염 시나리오
  let polluted; try { polluted = await callDetail({}); } finally { delete Object.prototype._trustedAdminView; }
  t('\u2605 플래그는 요청으로 만들 수 없다 — 오염 방어(자기 프로퍼티만 인정)', () => {
    assert.ok(polluted.body && polluted.body.ok);
    assert.ok(!('work_detail' in polluted.body.data),
      'Object.prototype 오염만으로 전체 행이 나갔다 — hasOwnProperty 검사가 없다');
  });

  t('Track B 라우트가 canEdit 일 때만 플래그를 세운다(세우는 곳은 한 곳뿐)', () => {
    const dir = path.join(__dirname, '..', 'src', 'routes');
    const tb = fs.readFileSync(path.join(dir, 'trackB.routes.js'), 'utf8');
    assert.ok(/if \(await canEdit\(req\.admin\)\) req\._trustedAdminView = true;/.test(tb));
    assert.ok(/catch \(_\) \{ \/\* 공개 뷰로 수렴 \*\/ \}/.test(tb), '판정 실패가 fail-closed 가 아니다');
    const n = (fs.readdirSync(dir).filter(f => f.endsWith('.js'))
      .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
      .match(/_trustedAdminView\s*=\s*true/g) || []).length;
    assert.strictEqual(n, 1, '_trustedAdminView 를 세우는 곳이 늘었다: ' + n);
  });

  console.log('\n\u2705 workdeskOrderActions: ' + pass + '개 통과\n');
  process.exit(0);   // trackB/campaign routes 를 require 하면 DB 풀 핸들이 열려 프로세스가 안 끝난다
})();
