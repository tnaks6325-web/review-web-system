/**
 * optionLandingUrl.test.js — 옵션별 유입링크(101) 회귀가드 · M1+M2
 * 실행: node tests/optionLandingUrl.test.js
 *
 * PRD = frontend/docs/prd-option-landing-url.html (v1.0 확정)
 *
 * 이 변경의 위험은 여섯이다.
 *  ① **기존 공고 회귀** — 옵션 URL이 빈 값(=지금 전 공고)일 때 공고 랜딩 URL이 안 나가면
 *     [상품 페이지 열기] 버튼이 통째로 사라진다.
 *  ② **미리보기 ≠ 실제 화면** — work-detail 과 관리자 미리보기가 다른 규칙을 쓰면
 *     이 레포가 공용 렌더러로 없앤 문제가 되살아난다.
 *  ③ **참여 전 URL 노출** — 공개 목록·상세에 링크가 실리면 자리를 안 잡고 구매부터 하는
 *     지각(late) 건을 시스템이 스스로 유도한다(옵션 금액 "참여 후 공개"와 같은 성질).
 *  ④ **조용한 삭제** — URL 칸이 없는 화면이 옵션표를 저장하거나 오타가 들어왔을 때
 *     이미 넣어 둔 링크가 지워지면 리뷰어가 엉뚱한 상품으로 들어간다.
 *  ⑤ **INSERT 정합** — 컬럼을 끼워 넣으면 컬럼 수 ≡ 자리표시자 수 ≡ 파라미터 수가 조용히
 *     어긋나 발행·수정이 통째로 죽는다(088·090·097·099 에서 반복해 밟은 자리).
 *  ⑥ **권한 상승** — 리뷰어앱 스코프 토큰이 유입방식을 바꾸면 검수·유입 정책이 흔들린다.
 *
 * ★ 순수함수는 **실제로 실행**해 검증한다(문자열 존재만 보는 grep 은 스코프·실행경로를 못 본다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/** ⚠ campaign.routes.js 는 **의도된 NUL**(복합키 구분자)을 포함한다 — 이스케이프 표기로 제거하고 본다. */
const SNUL = p => S(p).split(String.fromCharCode(0)).join('');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 옵션별 유입링크(101) — M1+M2 회귀가드\n');

const OL = require('../src/utils/optionLanding');
const IT = require('../src/utils/inflowType');
const OC = require('../src/utils/optionUrlChannels');

/* ── 1) resolveLandingUrl — 판정 순수함수 (실행) ───────────────── */
console.log('1) resolveLandingUrl / 위생 — 실행 검증');

t('옵션 URL이 있으면 옵션 URL',
  OL.resolveLandingUrl({ optionLandingUrl: 'https://a', campaignLandingUrl: 'https://b' }) === 'https://a');

t('★ 옵션 URL이 비면 공고 랜딩 URL(기존 공고 무회귀)',
  OL.resolveLandingUrl({ optionLandingUrl: '', campaignLandingUrl: 'https://b' }) === 'https://b'
  && OL.resolveLandingUrl({ campaignLandingUrl: 'https://b' }) === 'https://b');

t('둘 다 없으면 빈 값(버튼 미노출)',
  OL.resolveLandingUrl({}) === '' && OL.resolveLandingUrl(null) === '');

t('★ https 아닌 값은 열지 않는다(javascript: 차단) — 폴백으로 내려간다',
  OL.resolveLandingUrl({ optionLandingUrl: 'javascript:alert(1)', campaignLandingUrl: 'https://b' }) === 'https://b'
  && OL.sanitizeLandingUrl('javascript:alert(1)') === ''
  && OL.sanitizeLandingUrl('  https://x  ') === 'https://x'
  && OL.sanitizeLandingUrl('http://x') === 'http://x');

t('사유는 화면이 말한다(빈 값은 오류 아님)',
  OL.landingUrlError('') === null && OL.landingUrlError('  ') === null
  && typeof OL.landingUrlError('abc') === 'string'
  && OL.landingUrlError('https://x') === null);

t('deriveCampaignLandingUrl — 첫 상품 URL + 다상품 상이 신호(D5)',
  OL.deriveCampaignLandingUrl([{ landingUrl: 'https://a' }, { landingUrl: 'https://c' }]).url === 'https://a'
  && OL.deriveCampaignLandingUrl([{ landingUrl: 'https://a' }, { landingUrl: 'https://c' }]).multiDistinct === true
  && OL.deriveCampaignLandingUrl([{ landingUrl: 'https://a' }, { landingUrl: 'https://a' }]).multiDistinct === false
  && OL.deriveCampaignLandingUrl([]).url === ''
  && OL.deriveCampaignLandingUrl(null).multiDistinct === false);

t('★ 빈 칸은 다상품 판정에서 빠진다(비어 있다고 "서로 다름"이 되면 안 된다)',
  OL.deriveCampaignLandingUrl([{ landingUrl: 'https://a' }, { landingUrl: '' }]).multiDistinct === false);

t('킬스위치가 존재한다(CAMPAIGN_OPTION_LANDING=0 → 항상 공고 URL)',
  /CAMPAIGN_OPTION_LANDING/.test(S('src/utils/optionLanding.js'))
  && /OPTION_LANDING_ENABLED\s*\?|if\s*\(OPTION_LANDING_ENABLED\)/.test(S('src/utils/optionLanding.js')));

{ // 킬스위치를 실제로 켠 자식 프로세스에서 동작 확인(문자열 존재만으로는 못 잡는다)
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e',
    "const L=require('./src/utils/optionLanding');" +
    "process.stdout.write(L.resolveLandingUrl({optionLandingUrl:'https://a',campaignLandingUrl:'https://b'}))"],
  { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { CAMPAIGN_OPTION_LANDING: '0' }) }).toString();
  t('★ 킬스위치 실행 확인 — 0이면 옵션 URL을 아예 읽지 않는다', out === 'https://b');
}

/* ── 2) resolveInflowType — D1 (실행) ─────────────────────────── */
console.log('\n2) resolveInflowType — 공고 값 > 작업오더 역조회');

t('공고 값이 있으면 그것이 최종',
  IT.resolveInflowType({ campaignInflowType: 'link', orderInflowType: 'guide' }) === 'link'
  && IT.resolveInflowType({ campaignInflowType: '링크유입', orderInflowType: 'guide' }) === 'link');

t('★ 공고 값이 비면 작업오더 역조회(기발행분 동작 불변)',
  IT.resolveInflowType({ campaignInflowType: '', orderInflowType: 'guide' }) === 'guide'
  && IT.resolveInflowType({ orderInflowType: 'link' }) === 'link');

t('★★ 불명을 추측하지 않는다(빈 값 유지)',
  IT.resolveInflowType({}) === ''
  && IT.resolveInflowType({ campaignInflowType: '아무거나', orderInflowType: '' }) === ''
  && IT.normalizeInflowType('몰라') === '');

t('★ inflowTypeForStore — 미전송(null)=변경없음 / ""=해제 / 값=저장',
  IT.inflowTypeForStore(undefined) === null
  && IT.inflowTypeForStore(null) === null
  && IT.inflowTypeForStore('') === ''
  && IT.inflowTypeForStore('  ') === ''
  && IT.inflowTypeForStore('link') === 'link'
  && IT.inflowTypeForStore('쓰레기') === '');

t('라벨(화면 공용)', IT.inflowTypeLabel('link') === '링크유입'
  && IT.inflowTypeLabel('guide') === '유입가이드' && IT.inflowTypeLabel('') === '미지정');

/* ── 3) supportsOptionUrl — 보충 ㉮ (실행) ────────────────────── */
console.log('\n3) supportsOptionUrl — 네이버만 false · 채널 미상 fail-open');

t('★★ 네이버는 옵션별 주소가 없다(사용자 확정)', OC.supportsOptionUrl('네이버') === false);
t('쿠팡·올리브영·카카오메이커스는 지원',
  OC.supportsOptionUrl('쿠팡') === true && OC.supportsOptionUrl('올리브영') === true
  && OC.supportsOptionUrl('카카오메이커스') === true);
t('★★ 채널 미상은 잠그지 않는다(fail-open)',
  OC.supportsOptionUrl('') === true && OC.supportsOptionUrl(null) === true
  && OC.supportsOptionUrl('지마켓') === true);
t('비활성 사유는 문장으로(지원 채널은 null)',
  /네이버/.test(OC.optionUrlUnsupportedNote('네이버') || '')
  && OC.optionUrlUnsupportedNote('쿠팡') === null);
t('★ 채널 목록 사본 금지 — cashReceiptChannels 를 그대로 쓴다',
  /require\(['"]\.\/cashReceiptChannels['"]\)/.test(S('src/utils/optionUrlChannels.js'))
  && !/match:\s*\//.test(S('src/utils/optionUrlChannels.js')));

/* ── 4) migration 101 — 모양 고정 ─────────────────────────────── */
console.log('\n4) migration 101 — 컬럼 추가만 · 백필 0 · CHECK 없음 · TEXT');

const M = S('migrations/101_option_landing_url.sql');
t('campaign_options.landing_url TEXT DEFAULT \'\'',
  /ALTER TABLE campaign_options\s+ADD COLUMN IF NOT EXISTS landing_url TEXT DEFAULT ''/.test(M));
t('recruit_campaigns.inflow_type TEXT DEFAULT \'\'',
  /ALTER TABLE recruit_campaigns\s+ADD COLUMN IF NOT EXISTS inflow_type TEXT DEFAULT ''/.test(M));
// ★ 주석(설명문)에 'REFERENCES'·'UPDATE' 같은 단어가 들어갈 수 있으므로 **실행문만** 본다
//   (줄 주석만 제거 — 이 레포엔 블록 주석 정규식이 코드를 통째로 먹은 실측 사고가 있다).
const MSQL = M.replace(/^\s*--.*$/gm, '');
t('★ 백필(UPDATE) 0 — 기존 공고 동작 불변', !/\bUPDATE\b/i.test(MSQL));
t('★ DB CHECK·FK 없음(082 의 42804 계열 회피 · 어휘 확장 시 저장 실패 방지)',
  !/\bCHECK\s*\(/i.test(MSQL) && !/REFERENCES/i.test(MSQL));

const IDX = S('index.js');
t('★ REQUIRED_SCHEMA 등록 2건(없으면 발행·수정·옵션 저장이 전면 42703)',
  /\['campaign_options',\s*'landing_url'\]/.test(IDX)
  && /\['recruit_campaigns',\s*'inflow_type'\]/.test(IDX));

/* ── 5) campaign.routes 배선 (정적 + 계수) ────────────────────── */
console.log('\n5) campaign.routes — 저장·조회 배선');

const R = SNUL('src/routes/campaign.routes.js');

t('판정 사본 금지 — 두 util 을 require 한다',
  /require\(['"]\.\.\/utils\/optionLanding['"]\)/.test(R)
  && /require\(['"]\.\.\/utils\/inflowType['"]\)/.test(R));

t('★★ work-detail 이 resolveLandingUrl 을 태운다(고른 옵션 URL → 공고 URL)',
  /landingUrl:\s*resolveLandingUrl\(\{[\s\S]{0,200}?optionLandingUrl:\s*selectedOption/.test(R));

t('★★ 관리자 미리보기도 **같은 함수** — 미리보기 ≠ 실제 화면 차단',
  (R.match(/landingUrl:\s*resolveLandingUrl\(/g) || []).length === 2
  && /optionLandingUrl:\s*sample\s*&&\s*sample\.landingUrl/.test(R));

t('★ 두 경로 모두 resolveInflowType 을 태운다(공고 값 우선)',
  (R.match(/resolveInflowType\(\{/g) || []).length === 2
  && /campaignInflowType:\s*camp\.inflow_type/.test(R));

t('옵션 뷰에 landingUrl 이 실린다(홀드 게이트 뒤 소비용)',
  /SELECT opt_key, pay_amount, recruit_total, daily_limit, status, landing_url/.test(R)
  && /landingUrl:\s*sanitizeLandingUrl\(r\.landing_url\)/.test(R));

t('★★ 공개 응답 화이트리스트에 URL 없음(참여 전 비공개 — 지각 유도 차단)', (() => {
  const i = R.indexOf('function _publicOptionView');
  const body = R.slice(i, R.indexOf('\n}', i));
  return !/landing/i.test(body) && /optKey/.test(body) && !/payAmount/.test(body);
})());

t('관리 편집용 원본 조회는 landingUrl 을 돌려준다(프리필)',
  /landing_url AS "landingUrl"/.test(R));

t('★★ 옵션 저장은 미전달=유지(COALESCE) — URL 칸 없는 화면이 링크를 지우지 않는다',
  /landing_url=COALESCE\(\$8,\s*campaign_options\.landing_url\)/.test(R)
  && /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,COALESCE\(\$7,'active'\),COALESCE\(\$8,''\),NOW\(\)\)/.test(R));

t('★★ 잘못된 URL은 기존 값을 지우지 않는다(_optLandingUrl 실행)', (() => {
  const vm = require('vm');
  const i = R.indexOf('function _optLandingUrl');
  const src = R.slice(i, R.indexOf('\n}', i) + 2);
  const ctx = { sanitizeLandingUrl: OL.sanitizeLandingUrl };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.f=_optLandingUrl;', ctx);
  return ctx.f(undefined) === null && ctx.f(null) === null
    && ctx.f('') === '' && ctx.f('   ') === ''
    && ctx.f('https://a') === 'https://a'
    && ctx.f('javascript:x') === null && ctx.f('abc') === null;
})());

t('★ 유입방식 저장은 CASE 센티널(null=유지 / \'\'=해제)',
  /inflow_type = CASE WHEN \$42::text IS NULL THEN inflow_type ELSE \$42::text END/.test(R)
  && /inflowTypeForStore\(inflow_type\)/.test(R));

t('★ 발행(create) INSERT 에도 유입방식 — 선택이 조용히 낙하하지 않는다',
  /review_type, carry_mode, work_kind, inflow_type\)/.test(R)
  && /inflowTypeForStore\(inflow_type\) \?\? ''/.test(R));

/* ⑤ INSERT/UPDATE 정합 — 컬럼 수 ≡ 자리표시자 ≡ 파라미터 수 */
t('★★ create INSERT: 컬럼 수 ≡ 자리표시자 수(연속) — 099 에서 실제로 깨졌던 자리', (() => {
  const i = R.indexOf('INSERT INTO recruit_campaigns');
  const seg = R.slice(i, R.indexOf('RETURNING *`', i));
  const cols = seg.slice(seg.indexOf('('), seg.indexOf('VALUES'));
  const nCols = cols.split(',').filter(s => s.replace(/[()\s]/g, '')).length;
  const ph = [...new Set((seg.slice(seg.indexOf('VALUES')).match(/\$(\d+)/g) || [])
    .map(s => +s.slice(1)))].sort((a, b) => a - b);
  return nCols === ph.length && ph[ph.length - 1] === nCols
    && ph.every((n, k) => n === k + 1);
})());

t('★★ update SET: 자리표시자 연속 + $42 가 마지막', (() => {
  const k = R.indexOf('inflow_type = CASE WHEN $42');
  const start = R.lastIndexOf('UPDATE recruit_campaigns', k);
  const seg = R.slice(start, R.indexOf('RETURNING *`', k));
  const ph = [...new Set((seg.match(/\$(\d+)/g) || []).map(s => +s.slice(1)))].sort((a, b) => a - b);
  return ph[ph.length - 1] === 42 && ph.every((n, i2) => n === i2 + 1);
})());

/* ⑥ 권한 경계 */
t('★★ 리뷰어앱 스코프 편집은 유입방식을 못 바꾼다(화이트리스트 미포함)', (() => {
  const i = R.indexOf('async function _scopedCampaignEdit');
  const end = R.indexOf('\n// ', i) > i ? R.indexOf('\nrouter.', i) : R.length;
  const body = R.slice(i, end > i ? end : R.length);
  return !/inflow_type\s*=/.test(body);
})());

/* ── 6) 스텁 pool 로 옵션 저장 실제 실행 ──────────────────────── */
console.log('\n6) _saveCampaignOptions — 스텁 pool 실행(파라미터 정합)');

t('★ 저장 쿼리에 landingUrl 이 8번째 파라미터로 실린다', (() => {
  const i = R.indexOf('async function _saveCampaignOptions');
  const body = R.slice(i, R.indexOf('\n}', R.indexOf('client.release();', i)));
  return /\[campaignId, o\.optKey, o\.payAmount, o\.recruitTotal, o\.dailyLimit, o\.sortOrder, o\.status, o\.landingUrl\]/.test(body);
})());

t('★ _normalizeOptionsInput 이 landingUrl 을 만든다(실행)', (() => {
  const vm = require('vm');
  const i = R.indexOf('function _normOptKey');
  const end = R.indexOf('\n// ═', i);
  const src = R.slice(i, end > i ? end : i + 4000);
  const ctx = { sanitizeLandingUrl: OL.sanitizeLandingUrl };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.f=_normalizeOptionsInput;', ctx);
  const out = ctx.f([
    { optKey: '화이트', payAmount: 1000, landingUrl: 'https://w' },
    { optKey: '블랙', payAmount: 1000 },                       // 미전송 = null(유지)
    { optKey: '베이지', landingUrl: '' },                       // 명시 해제
  ]);
  return out.length === 3 && out[0].landingUrl === 'https://w'
    && out[1].landingUrl === null && out[2].landingUrl === '';
})());

console.log(`\n✅ ${pass}개 통과\n`);
