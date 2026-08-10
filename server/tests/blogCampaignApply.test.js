#!/usr/bin/env node
/**
 * 회귀가드 — 블로그체험단 M5: 블로그 주소(blog_url)
 *
 * 고정하는 계약
 *  §1 migration 101 = 컬럼 추가만(백필 0 · DB CHECK 0 · FK 0)  + REQUIRED_SCHEMA 등록
 *  §2 apply 게이트: **홀드 INSERT·pool.connect 전** 403 `blog_url_required`(자리 미점유)
 *  §3 apply INSERT 컬럼 수 ≡ VALUES 자리 수 ≡ 파라미터 수
 *  §4 홀드→주문 전파는 COALESCE(기존 값 미덮음) · 값의 출처는 **서버 홀드**(요청 본문 불신)
 *  §5 매퍼: 블로그 규칙이 주문자·주소 규칙보다 **먼저** · 빈 값은 `''` 가 아니라 **null**
 *  §6 공개 응답에 work_kind 동봉(리뷰어 화면이 블로그 공고를 알아야 주소를 받는다)
 *  §7 프론트 형식 규칙 = 서버 `isPostUrl` 과 동일(14케이스 실행 대조) · 배선
 *  §8 소스 위생(리터럴 NUL 금지)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FRONT = path.join(ROOT, '..', 'frontend');
let fail = 0, pass = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + name); } }
function read(p) { return fs.readFileSync(p, 'utf8'); }
/** campaign.routes.js 는 의도된 NUL(복합키 구분자)이 있어 grep 전에 제거해야 한다 */
function readNoNul(p) { return read(p).split(String.fromCharCode(0)).join(''); }

const MIG = read(path.join(ROOT, 'migrations', '101_blog_url.sql'));
const INDEX = read(path.join(ROOT, 'index.js'));
const CAMP = readNoNul(path.join(ROOT, 'src', 'routes', 'campaign.routes.js'));
const SUBMIT = read(path.join(ROOT, 'src', 'routes', 'submit.routes.js'));
const HOLD = read(path.join(ROOT, 'src', 'services', 'campaignHold.service.js'));
const LEDGER = read(path.join(ROOT, 'src', 'services', 'orderLedger.service.js'));
const UTIL = read(path.join(ROOT, 'src', 'utils', 'blogPostUrl.js'));
const HTML = read(path.join(FRONT, 'campaign.html'));

console.log('\n=== §1 마이그레이션 101 · 프리플라이트 ===');
{
  // ★ `[\s\S]*` 로 두 문장을 가로질러 재면 **한 쪽을 주석 처리해도 통과**한다(변이시험 실측).
  //   줄 주석을 걷어낸 뒤 문장 단위로 본다.
  const live = MIG.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  const stmts = live.split(';').map(x => x.trim()).filter(Boolean);
  const has = (tbl) => stmts.some(x =>
    new RegExp('ALTER\\s+TABLE\\s+' + tbl + '[\\s\\S]*ADD COLUMN IF NOT EXISTS\\s+blog_url\\s+TEXT', 'i').test(x));
  ok(has('campaign_applications'), '101: campaign_applications.blog_url TEXT');
  ok(has('order_submissions'), '101: order_submissions.blog_url TEXT');
}
ok(!/\bUPDATE\b/i.test(MIG), '101: 백필(UPDATE) 0 — 기존 행 무접촉');
ok(!/\bCHECK\s*\(/i.test(MIG), '101: DB CHECK 없음(087 규율 — 어휘 확장이 저장을 깨지 않게)');
ok(!/REFERENCES/i.test(MIG), '101: FK 없음(082 의 42804 계열 회피)');
ok(/\['campaign_applications',\s*'blog_url'\]/.test(INDEX), 'REQUIRED_SCHEMA: campaign_applications.blog_url');
ok(/\['order_submissions',\s*'blog_url'\]/.test(INDEX), 'REQUIRED_SCHEMA: order_submissions.blog_url');

console.log('\n=== §2 apply 게이트는 자리 미점유 지점에 있다 ===');
const applyIdx = CAMP.indexOf('async function _applyParticipation');
ok(applyIdx > 0, '_applyParticipation 존재');
const applyBody = CAMP.slice(applyIdx, applyIdx + 60000);
const iGate = applyBody.indexOf("reason: 'blog_url_required'");
const iConn = applyBody.indexOf('await pool.connect()');
const iIns = applyBody.indexOf('INSERT INTO campaign_applications');
ok(iGate > 0, '게이트: 403 blog_url_required 반환');
ok(iConn > 0 && iIns > 0, '기준점(pool.connect · 홀드 INSERT) 존재');
ok(iGate < iConn, '★ 게이트가 pool.connect 보다 앞 — 커넥션·자리 점유 전에 거부');
ok(iGate < iIns, '★ 게이트가 홀드 INSERT 보다 앞 — 그날 참여권 미소각');
ok(/isBlogKind\(/.test(applyBody) && /resolveWorkKind\(/.test(applyBody),
  '★ 종류 판정은 utils/workKind 단일 출처(규칙 사본 0)');
ok(/isPostUrl\(/.test(applyBody), '★ 형식 판정은 utils/blogPostUrl 단일 출처');
ok(/BLOG_URL_HINT/.test(applyBody), '거부 사유에 안내문 동봉(무엇을 넣어야 하는지 말한다)');
ok(!/const\s+blogUrlIns\s*=\s*String\(req\.body\.blogUrl/.test(applyBody) &&
   /req\.body\.blogUrl/.test(applyBody), '요청 본문에서 읽되 검증을 통과한 값만 저장');

console.log('\n=== §3 apply INSERT 산술 ===');
const insM = applyBody.match(/INSERT INTO campaign_applications\s*\n?\s*\(([^)]*)\)\s*\n?\s*VALUES\s*\(([^)]*)\)/);
ok(!!insM, 'INSERT 문 파싱');
if (insM) {
  const cols = insM[1].split(',').map(s => s.trim()).filter(Boolean);
  const vals = insM[2].split(',').map(s => s.trim()).filter(Boolean);
  const ph = new Set(vals.filter(v => /^\$\d+$/.test(v)));
  ok(cols.length === vals.length, `컬럼 수(${cols.length}) ≡ VALUES 자리 수(${vals.length})`);
  ok(cols.includes('blog_url'), 'blog_url 컬럼 포함');
  // 파라미터 배열 길이
  const after = applyBody.slice(applyBody.indexOf(insM[0]));
  const argM = after.match(/RETURNING[^`]*`,\s*\n?\s*\[([\s\S]*?)\]\);/);
  ok(!!argM, '파라미터 배열 파싱');
  if (argM) {
    const args = argM[1].split(/,(?![^()]*\))/).map(s => s.trim()).filter(Boolean);
    ok(args.length === ph.size, `자리표시자 수(${ph.size}) ≡ 파라미터 수(${args.length})`);
    ok(/blogUrlIns/.test(argM[1]), '마지막 파라미터로 검증된 값 전달');
  }
}

console.log('\n=== §4 전파 · 서버 권위 ===');
ok(/blog_url\s*=\s*COALESCE\(\s*NULLIF\(\s*os\.blog_url/.test(HOLD),
  '★ 홀드→주문 전파는 COALESCE(NULLIF(...)) — 이미 있는 값(관리자 사전등록)을 덮지 않는다');
const authIdx = SUBMIT.indexOf('_authoritativeHold');
const authBody = SUBMIT.slice(authIdx, authIdx + 4000);
ok(/ca\.blog_url/.test(authBody), '★ 값은 hold_token 으로 조회한 서버 행에서 읽는다(옵션 권위와 같은 규율)');
ok(/ctx\.blogUrl\s*=/.test(SUBMIT), 'holdCtx 에 실어 주문 원장으로 전달');
ok(/blogUrl:\s*\(holdCtx && holdCtx\.blogUrl\)/.test(SUBMIT),
  '★ orderData.blogUrl 의 출처는 홀드뿐 — 요청 본문 값을 그대로 쓰지 않는다');
ok(!/orderData\.blogUrl\s*=\s*b\.blogUrl/.test(SUBMIT), '본문 값 직접 대입 없음');

console.log('\n=== §5 시트 매퍼 규칙(실행) ===');
const { mapOrderToSheetRow } = require(path.join(ROOT, 'src', 'services', 'orderLedger.service.js'));
{
  const headers = ['번호', '블로그주소', '주문자', '수취인', '연락처', '배송주소', '비고'];
  const od = { orderer: '주문자값', recipient: '수취인값', phone: '01012345678', address: '서울시 어딘가', blogUrl: 'https://blog.naver.com/me' };
  const row = mapOrderToSheetRow(headers, od);
  ok(row[1] === 'https://blog.naver.com/me', '★ `블로그주소` 칸에 블로그 주소(배송 주소가 아니다)');
  ok(row[5] === '서울시 어딘가', '`배송주소` 칸은 종전대로 배송 주소');
  const row2 = mapOrderToSheetRow(['블로그URL', '주소'], { address: 'A', blogUrl: 'https://x.kr/a' });
  ok(row2[0] === 'https://x.kr/a', '`블로그URL` 칸도 인식(어느 규칙에도 안 걸리던 것)');
  const row3 = mapOrderToSheetRow(['블로그주소'], { address: 'A' });
  ok(row3[0] === null, '★ 값 없으면 null(=안 씀) — `` 이면 그 칸을 지우는 쓰기가 된다');
  const row4 = mapOrderToSheetRow(['포스팅URL'], { blogUrl: 'https://x.kr/a', memo: '결과물' });
  ok(row4[0] !== 'https://x.kr/a', '★ 포스팅URL 칸은 블로그 규칙이 가져가지 않는다(memo 열 담당)');
}
{
  // ★ 파일 전체로 재면 주석 문장·다른 함수의 같은 표현이 대신 통과시킨다 — 매퍼 본문으로 스코프하고
  //   주석은 제거한 뒤 순서를 본다(줄 주석만 — 블록 주석 정규식은 이 레포의 정규식 리터럴을 문다).
  const mi = LEDGER.indexOf('function mapOrderToSheetRow');
  const mBody = LEDGER.slice(mi, LEDGER.indexOf('\n}', mi))
    .split('\n').filter(l => /^\s*if\s*\(/.test(l)).join('\n');   // 판정 줄만 — 설명문에도 같은 표현이 나온다
  const iBlog = mBody.indexOf("key.includes('블로그')");
  const iOrd  = mBody.indexOf("key.includes('주문자')");
  const iAddr = mBody.indexOf("key.includes('주소')");
  ok(iBlog >= 0 && iOrd >= 0 && iAddr >= 0, '매퍼 본문에서 세 규칙 모두 발견');
  ok(iBlog >= 0 && iOrd >= 0 && iBlog < iOrd, '★ 블로그 규칙이 주문자 규칙보다 앞(소스 순서 = 정확성)');
  ok(iBlog >= 0 && iAddr >= 0 && iBlog < iAddr, '★ 블로그 규칙이 주소 규칙보다 앞');
}
ok(/blogUrl:\s*os\.blog_url/.test(LEDGER), '큐 재실행 경로(_osRowToOrderData)도 같은 값을 싣는다');
{
  const m = LEDGER.match(/ORDER_INSERT_SQL[\s\S]{0,900}?VALUES\s*\(([^)]*)\)/);
  ok(!!m && /blog_url/.test(LEDGER.slice(LEDGER.indexOf('ORDER_INSERT_SQL'), LEDGER.indexOf('ORDER_INSERT_SQL') + 900)),
    '주문 원장 INSERT 에 blog_url 컬럼');
}

console.log('\n=== §6 공개 응답 ===');
ok(/PUBLIC_FIELDS_PARTICIPATION[\s\S]{0,2000}'work_kind'/.test(CAMP),
  "★ 참여형 공개 화이트리스트에 work_kind — 없으면 리뷰어 화면이 블로그 공고를 알 수 없다");

console.log('\n=== §7 프론트 규칙 일치 · 배선 ===');
const sandbox = { };
vm.createContext(sandbox);
{
  const m = HTML.match(/function _isBlogUrl\(v\)\{[\s\S]*?\n\}/);
  ok(!!m, '_isBlogUrl 추출');
  if (m) {
    vm.runInContext(m[0], sandbox);
    const { isPostUrl } = require(path.join(ROOT, 'src', 'utils', 'blogPostUrl.js'));
    const cases = [
      'https://blog.naver.com/abc', 'http://x.co/a', 'https://tistory.com', 'https://브런치.한국/글',
      '', '   ', 'blog.naver.com/abc', 'ftp://x.co/a', 'https://localhost', 'https://a.b',
      'https://x.co/a b', 'https://x.co/"a', "https://x.co/'a", 'https://x.co/<a>',
    ];
    let same = 0;
    for (const c of cases) {
      const f = sandbox._isBlogUrl(c), s = isPostUrl(c);
      if (f === s) same++; else console.error(`    · 불일치: ${JSON.stringify(c)} front=${f} server=${s}`);
    }
    ok(same === cases.length, `★ 프론트 규칙 ≡ 서버 isPostUrl (${same}/${cases.length})`);
    ok(sandbox._isBlogUrl('https://아무데나.kr/x') === true, '도메인 화이트리스트 없음(어느 플랫폼이든 통과)');
  }
}
ok(/work_kind === 'blog'/.test(HTML), "★ 종류 판정은 서버가 준 값 정확 일치(탭명·상품명 추측 금지)");
ok(!/isBlogCampaign[\s\S]{0,200}includes\(/.test(HTML), 'isBlogCampaign 이 문자열 추측을 쓰지 않는다');
{
  const i = HTML.indexOf('async function _doApply');
  const body = HTML.slice(i, i + 2500);
  const iG = body.indexOf('openBlogSheet(optionKey, sub)');
  const iF = body.indexOf('fetch(API_BASE_URL');
  ok(iG > 0 && iF > 0 && iG < iF, '★ 화면도 요청 전에 받는다(서버 왕복 낭비·자리 점유 0)');
  ok(/body\.blogUrl\s*=\s*_blogUrl/.test(body), '검증된 값을 blogUrl 로 전송');
}
// ★ 문자열 존재만 보면 `if(false && …)` 를 통과시킨다(변이시험 실측) — 분기 형태를 통째로 고정한다.
ok(/if\(\s*j\.reason === 'blog_url_required'\s*\)\{[^}]*openBlogSheet\(/.test(HTML),
  '★ 서버 거부(403)를 화면이 받아 다시 입력받는다(막다른 길 금지)');
ok(/id="blogSheet"/.test(HTML) && /id="blogUrlIn"/.test(HTML), '입력 시트 마크업');

console.log('\n=== §8 소스 위생 ===');
for (const [name, src] of [['migration 101', MIG], ['blogPostUrl.js', UTIL], ['campaign.html', HTML]]) {
  ok(src.indexOf(String.fromCharCode(0)) === -1, `${name}: 리터럴 NUL 없음`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} blogCampaignApply: ${pass} pass / ${fail} fail\n`);
process.exit(fail === 0 ? 0 : 1);
