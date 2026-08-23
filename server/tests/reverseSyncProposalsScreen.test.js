/**
 * ⚠ 원장 불일치 화면 회귀 가드 (2026-08-23).
 *
 * 배경: 역동기화 API 7개(`/api/diag/reverse-sync-*`)가 진작 다 있었는데 **부르는 화면이 0곳**이었다.
 *   그래서 시스템이 89건(금액 61 + 입금대상 28)을 5주간 찾아 기록해 두고도 아무도 보지 않았고,
 *   그중 하나가 9,900원이 99,000원으로 이체된 건이다. 이 가드가 지키는 것:
 *
 *   §1 목록 API — 총계(total)가 **자르기 전** 개수인가 · 종류 필터가 화이트리스트인가
 *   §2 화면이 실제로 그 API 를 부르는가(호출 0 으로 되돌아가는 것을 막는다)
 *   §3 뱃지 — 화면을 열지 않아도 보이고, 모를 때 0 으로 위장하지 않는가
 *   §4 정직성 — 잘린 목록·처리 불가 건수를 말하는가(조용한 누락 금지)
 *
 * 실행: node tests/reverseSyncProposalsScreen.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
let pass = 0;
const t = (name, cond) => { assert.ok(cond, name); pass++; console.log('  ✓ ' + name); };

/** 라우트 핸들러 본문 잘라내기 — 고정 길이 슬라이스 금지(핸들러가 자라면 조용히 빨개진다). */
function handlerBody(src, decl) {
  const i = src.indexOf(decl); if (i < 0) return '';
  const j = src.indexOf('\n});', i + decl.length);
  return j < 0 ? src.slice(i) : src.slice(i, j + 4);
}

console.log('\n▶ ⚠ 원장 불일치 화면 회귀가드\n');

// ══════════════════════════════════════════════════════════════
// §1 목록 API
// ══════════════════════════════════════════════════════════════
console.log('1) 목록 API');
const diag = R('src/routes/diag.routes.js');
const list = handlerBody(diag, "router.get('/reverse-sync-list'");
t('reverse-sync-list 핸들러가 있다', !!list);

t('★★ total 은 LIMIT 을 걸지 않은 COUNT 다 — 잘린 개수를 총계로 말하면 584건이 200건으로 보인다',
  /SELECT COUNT\(\*\)::int AS n FROM reverse_sync_proposals WHERE \$\{where\}/.test(list)
  && !/COUNT[\s\S]{0,120}LIMIT/.test(list));
t('★ total 과 목록이 **같은 조건**을 쓴다(where 를 공유 — 사본을 만들면 숫자가 갈린다)',
  (list.match(/WHERE \$\{where\}/g) || []).length === 2);
t('★ truncated 를 함께 실어 호출부가 잘렸음을 알 수 있다', /truncated: total > rows\.length/.test(list));
t('★ 종류 필터는 화이트리스트다(임의 문자열이 SQL 로 들어가지 않는다)',
  /\['edit', 'cancel_suspect'\]\.includes\(req\.query\.type\)/.test(list));
t('★ 종류도 자리표시자로만 바인딩한다', /conds\.push\(`proposal_type = \$\$\{params\.length\}`\)/.test(list));
t('★ 여전히 읽기 전용이다(목록 조회가 쓰기를 하지 않는다)',
  !/INSERT|UPDATE|DELETE/i.test(list));
t('★ 권한 게이트 유지(admin/master 전용)',
  /router\.get\('\/reverse-sync-list', authMiddleware, adminOrMasterMiddleware/.test(diag));

// ══════════════════════════════════════════════════════════════
// §2 화면이 실제로 부른다
// ══════════════════════════════════════════════════════════════
console.log('\n2) 화면 배선');
t('★★ 화면이 목록 API 를 부른다 — 이 가드의 핵심(호출 0 으로 되돌아가면 다시 아무도 못 본다)',
  /api\('\/api\/diag\/reverse-sync-list\?status=open&type=edit&limit=500'\)/.test(html));
t('입금관리 서브탭에 들어간다(별도 nav 를 만들지 않는다 — 안 들어가는 화면을 또 만들지 않게)',
  /STATE\.pmSub==='sync'\) _rsOpen\(\)/.test(html)
  && /t\('sync','⚠ 원장 불일치'/.test(html));
t('적용·기각이 기존 API 를 그대로 부른다(신규 저장소 0)',
  /api\('\/api\/diag\/reverse-sync-apply',\{method:'POST'/.test(html)
  && /api\('\/api\/diag\/reverse-sync-dismiss',\{method:'POST'/.test(html));
t('★ 원장을 바꾸는 적용에는 확인을 받는다(되돌리기 어려운 쓰기)',
  /async function _rsApply\([\s\S]{0,600}?confirm\(/.test(html));
t('★ 기각은 확인을 받지 않는다(원장을 건드리지 않고 되돌릴 수 있다)',
  !/async function _rsDismiss\([\s\S]{0,400}?confirm\(/.test(html));
t('★ 실패를 삼키지 않는다 — 사유를 화면이 말한다',
  /toast\('적용 실패'\+\(r&&r\.error\?' — '\+r\.error:''\)\)/.test(html)
  && /toast\('기각 실패'/.test(html));
/* ★ 시트에서 온 자유입력(예금주에 "ㅊ", 은행 칸에 주소 전체)이 그대로 HTML 이 되면 안 된다.
   빈칸 표시 헬퍼는 값을 esc 로 감싸고, 행 템플릿에는 날값 보간이 하나도 없어야 한다. */
// ⚠ `[\s\S]{0,120}?esc(` 처럼 느슨하게 보면 **문자열이 안 닫힌 채로도 통과**한다(실제로 밟았다 —
//   닫는 따옴표가 빠져 인라인 스크립트 전체가 죽었는데 이 단언은 초록이었다). 닫는 따옴표까지 고정한다.
t('★ 빈칸 헬퍼가 값을 esc 로 감싼다(문자열이 제대로 닫힌 채로)',
  /\?'<span class="rsempty">\(빈칸\)<\/span>':esc\(String\(s\)\)/.test(html));
t('★ HTML 렌더 함수에 날값 보간이 없다(모든 값이 esc 또는 v() 경유)', (() => {
  // ⚠ 파일 전체로 보면 안 된다 — `confirm()` 은 **평문 대화상자**라 거기서는 esc 가 오히려 틀린
  //   표시(&amp;)를 만든다. HTML 을 만드는 함수 본문만 본다.
  const i = html.indexOf('function _rsHtml(');
  const body = i < 0 ? '' : html.slice(i, html.indexOf('\n}', i) + 2);
  return !!body && !/\$\{it\.(oldValue|newValue|tabName|sheetRow|field|id)\}/.test(body);
})());
t('★ 클래스는 rs 접두로 격리(기존 화면과 겹쳐 무너지지 않게)',
  /\.rswrap\{/.test(html) && /\.rstbl\{/.test(html) && /\.rsact\{/.test(html));

// ══════════════════════════════════════════════════════════════
// §3 뱃지
// ══════════════════════════════════════════════════════════════
console.log('\n3) nav 뱃지');
t('★★ 부팅 시 1회 조회한다 — 화면을 열지 않아도 쌓인 건수가 보여야 한다(이번 사고의 본질)',
  /if\(isAdmin\) _rsBootBadge\(\);/.test(html) && /async function _rsBootBadge\(/.test(html));
t('★ 뱃지는 limit=1 로 총계만 받는다(목록 전체를 끌어오지 않는다)',
  /reverse-sync-list\?status=open&type=edit&limit=1'\)/.test(html));
t('★ 모를 때 0 으로 위장하지 않는다(조용한 정상 위장 금지)',
  /if\(_NAVRS\.n===null\) return;/.test(html));
t('입금관리 nav 에 뱃지 자리가 있다', /data-v="payment"[^>]*>입금관리<span id="pmNavBadge"><\/span>/.test(html));
t('★ 뱃지는 **손댈 수 있는 것만** 센다(type=edit) — 처리 불가한 삭제 의심까지 세면 곧 무시하게 된다',
  !/reverse-sync-list\?status=open&limit=1'/.test(html));

// ══════════════════════════════════════════════════════════════
// §4 정직성
// ══════════════════════════════════════════════════════════════
console.log('\n4) 조용한 누락 금지');
t('★ 목록이 잘렸으면 잘렸다고 말한다', /if\(r\.truncated\) notes\.push\(/.test(html));
t('★ 처리 대상이 아닌 삭제 의심 건수도 말한다(숨기면 "다 처리했다"는 거짓 안심이 된다)',
  /삭제 의심 <b>\$\{suspN\}건<\/b>/.test(html));
t('★ 어느 쪽이 원장이고 어느 쪽이 시트인지 화면이 밝힌다(방향을 헷갈리면 반대로 덮어쓴다)',
  /왼쪽이 원장\(지금 값\), 오른쪽이 시트/.test(html));
t('★ 시트가 항상 맞다고 말하지 않는다(실측: 예금주가 시트에서 "ㅊ" 로 깨진 행이 있었다)',
  /시트가 깨져 있는 경우도 있습니다/.test(html));
t('★ 돈이 걸린 칸은 먼저 눈에 띈다', /_RS_MONEY = \['price','account','bank','depositor'\]/.test(html)
  && /\.rstbl tr\.rsmoney td\{/.test(html));

console.log(`\n▶ ${pass}건 통과`);
console.log('reverseSyncProposalsScreen tests passed');
