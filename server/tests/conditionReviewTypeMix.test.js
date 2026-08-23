/**
 * conditionReviewTypeMix.test.js — 작업 조건 카드의 **혼합 리뷰타입 표기** 회귀가드
 * 실행: node tests/conditionReviewTypeMix.test.js
 *
 * 신고(2026-08-23): 작업오더는 `포토` 였지만 모집공고에서 **혼합(포토 200 · 텍스트 100)** 으로
 * 바꿔 저장했는데, 작업보드 [작업 조건]의 리뷰타입이 **[미설정]** 으로 보였다.
 *
 * 원인 = `resolveReviewType` 이 혼합이면 **일부러 null** 을 돌려준다(어느 행이 무슨 유형인지는
 * 시트 작업옵션 칸만 답할 수 있다 — 완화 금지 규율). 그 null 을 작업 조건이 그대로 그렸다.
 *
 * 그래서 고친 것은 **표기뿐**이다:
 *  ① 판정값 `reviewType` 은 혼합에서 여전히 null — 검수·캡처 슬롯이 보는 값은 불변.
 *  ② 표기값 `reviewTypeLabel`('혼합') + `reviewTypeMix`(유형별 인원)를 따로 싣는다.
 *  ③ 조합 우선순위 = 공고 저장값(106) → 연결 작업오더 문자열(parseWorkOrderReviewType 단일 출처).
 *  ④ 조합을 모르면 0 으로 꾸미지 않고 "유형별 인원 미입력"이라고 말한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

const svcSrc = fs.readFileSync(path.join(root, 'server/src/services/trackB.service.js'), 'utf8');
const wd = fs.readFileSync(path.join(root, 'frontend/workdesk.html'), 'utf8').replace(/\r\n/g, '\n');

/* ── 서비스 함수를 꺼내 실제로 돌린다 (export 되지 않는다 — orderQuotaFallback 과 같은 방식) ── */
function loadCond() {
  const st = svcSrc.indexOf('async function tabConditionSummary(');
  const a = svcSrc.indexOf('\nasync function ', st + 10);
  const b = svcSrc.indexOf('\nfunction ', st + 10);
  const en = a >= 0 ? (b >= 0 ? Math.min(a, b) : a) : b;
  const src = svcSrc.slice(st, en);
  const sandbox = {
    require: (m) => require(m.startsWith('.') ? path.join(root, 'server/src/services', m) : m),
    _condWoOptions: () => [],
    logger: { warn() {}, info() {} },
    module: {}, exports: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nmodule.exports = tabConditionSummary;', sandbox);
  return sandbox.module.exports;
}
const run = loadCond();
const CAMP = {
  id: 'c1', title: 'T', recruitTotal: 300, dailyLimit: 15, channel: '쿠팡', channelCustom: '',
  reviewType: '', reviewTypeMix: [], reviewFee: 500, transferMemo: '', multiAccount: false,
  multiDailyLimit: 0, status: 'active', participationMode: true,
};
const mkDb = (camps) => ({ async query(sql) {
  if (/FROM recruit_campaigns/.test(sql)) return { rows: camps };
  return { rows: [] };
} });

/* ⚠ 파일 끝의 동기 process.exit 는 async 블록보다 먼저 돈다 — 비동기 절은 이 안에서 끝낸다. */
(async () => {
console.log('\n── A. 서버 재료(tabConditionSummary 실제 실행) ──');
{
  const mix = [{ type: 'photo', quantity: 200 }, { type: 'text', quantity: 100 }];
  const out = await run(mkDb([{ ...CAMP, reviewType: 'mixed', reviewTypeMix: mix }]),
    { sheetId: 's1', tabName: 't1', meta: { tabGid: '1' }, wo: { reviewType: '포토' } });
  t('★ 혼합 공고면 라벨을 준다 — [미설정] 로 떨어지지 않는다(신고 재현)', out.reviewTypeLabel === '혼합');
  t('★ 판정값은 여전히 null(행 단위 판정은 시트만 안다 — 검수·슬롯 규율 불변)', out.reviewType === null);
  t('★ 혼합 표식', out.reviewTypeMixed === true);
  t('★ 조합은 공고 저장값(106) 그대로 · 라벨 동봉',
    JSON.stringify(out.reviewTypeMix) === JSON.stringify([
      { type: 'photo', label: '포토', quantity: 200 }, { type: 'text', label: '텍스트', quantity: 100 }]));
  t('★ 작업오더의 `포토` 가 공고 혼합을 이기지 않는다(공고가 판정 근거)', out.reviewTypeLabel === '혼합');
}
{
  const out = await run(mkDb([{ ...CAMP, reviewType: 'mixed', reviewTypeMix: [] }]),
    { sheetId: 's1', tabName: 't1', meta: {}, wo: { reviewType: '혼합(포토 200건, 텍스트 100건, 구매확정 0건)' } });
  t('★ 공고 조합이 비면 연결 작업오더 문자열에서 읽는다',
    JSON.stringify(out.reviewTypeMix.map(m => [m.type, m.quantity])) === JSON.stringify([['photo', 200], ['text', 100]]));
  t('★ 0건 유형은 싣지 않는다(없는 것을 그리지 않는다)', out.reviewTypeMix.every(m => m.quantity > 0));
}
{
  const out = await run(mkDb([{ ...CAMP, reviewType: 'mixed', reviewTypeMix: [] }]),
    { sheetId: 's1', tabName: 't1', meta: {}, wo: { reviewType: '포토' } });
  t('★ 조합을 모르면 빈 배열 — 0 으로 꾸미지 않는다', Array.isArray(out.reviewTypeMix) && out.reviewTypeMix.length === 0);
  t('★ 그래도 혼합이라는 사실은 말한다', out.reviewTypeLabel === '혼합' && out.reviewTypeMixed === true);
}
{
  const out = await run(mkDb([{ ...CAMP, reviewType: 'photo' }]),
    { sheetId: 's1', tabName: 't1', meta: {}, wo: null });
  t('★ 단일 유형은 종전 그대로(판정값·라벨 모두 그 유형)', out.reviewType === 'photo' && out.reviewTypeLabel === '포토');
  t('★ 단일 유형에는 조합을 싣지 않는다', out.reviewTypeMixed === false && out.reviewTypeMix === null);
}
{
  const out = await run(mkDb([]), { sheetId: 's1', tabName: 't1', meta: {}, wo: null });
  t('★ 아무것도 없으면 종전대로 null = [미설정]', out.reviewTypeLabel === null && out.reviewType === null);
  const out2 = await run(mkDb([]), { sheetId: 's1', tabName: 't1', meta: { reviewType: '믹스' }, wo: null });
  t('★ 탭 설정의 옛 표기(믹스)도 혼합으로 읽는다(normalizeReviewType 단일 출처)',
    out2.reviewTypeLabel === '혼합' && out2.reviewType === null);
}

console.log('\n── B. 화면 렌더(_cndRtypeHtml 실제 실행) ──');
{
  const i = wd.indexOf('function _cndRtypeHtml(cd){');
  const j = wd.indexOf('\n}', i);
  const src = wd.slice(i, j + 2);
  const sb = { esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), module: {}, Number };
  vm.createContext(sb);
  vm.runInContext(src + '\nmodule.exports = _cndRtypeHtml;', sb);
  const r = sb.module.exports;

  t('★ 값이 없으면 null → 화면이 [미설정] 배지를 그린다', r({ reviewTypeLabel: null }) === null);
  t('★ 단일 유형은 라벨만(종전 표기 불변)', r({ reviewTypeLabel: '포토', reviewTypeMixed: false }) === '포토');
  const h = r({ reviewTypeLabel: '혼합', reviewTypeMixed: true,
    reviewTypeMix: [{ type: 'photo', label: '포토', quantity: 200 }, { type: 'text', label: '텍스트', quantity: 100 }] });
  t('★ 혼합은 유형별 인원을 함께 그린다(신고 요구)', /혼합/.test(h) && /포토 200/.test(h) && /텍스트 100/.test(h));
  const h2 = r({ reviewTypeLabel: '혼합', reviewTypeMixed: true, reviewTypeMix: [] });
  t('★ 조합을 모르면 사실대로 말한다(0 위장 금지)', /혼합/.test(h2) && /미입력/.test(h2) && !/0/.test(h2));
  const h3 = r({ reviewTypeLabel: '혼합', reviewTypeMixed: true });
  t('★ 구버전 백엔드(필드 부재)도 죽지 않는다', typeof h3 === 'string' && /혼합/.test(h3));
  const h4 = r({ reviewTypeLabel: '혼합', reviewTypeMixed: true,
    reviewTypeMix: [{ type: 'photo', label: '<img src=x onerror=alert(1)>', quantity: 1 }] });
  t('★ 라벨은 escape 한다', !/<img/.test(h4) && /&lt;img/.test(h4));
}

console.log('\n── C. 배선 ──');
t('★ 카드가 헬퍼를 쓴다(렌더 사본 0)', /\['리뷰타입','rtype', _cndRtypeHtml\(cd\)\]/.test(wd));
t('★ 판정 규칙을 화면에서 다시 만들지 않는다(혼합 판정 사본 부재)',
  !/reviewTypeMixed\s*=\s*/.test(wd.slice(wd.indexOf('function _cndRtypeHtml'), wd.indexOf('function _condCardHtml'))));
/* ⚠ 스텁 pool 은 SQL 을 해석하지 않는다 — 컬럼을 SELECT 에서 빼도 위 실행 검사는 통과한다
   (변이시험 실측). 그래서 조회 문장 자체를 고정한다. */
t('★ 공고 조회가 review_type_mix 를 실제로 읽는다', /review_type_mix AS "reviewTypeMix"/.test(svcSrc));
t('★ 조합 정규화는 utils/reviewTypeMix 단일 출처', /require\('\.\.\/utils\/reviewTypeMix'\)/.test(svcSrc));
t('★ 작업오더 조합 파싱은 utils/reviewType.parseWorkOrderReviewType 단일 출처',
  /parseWorkOrderReviewType\(wo\.reviewType\)/.test(svcSrc));

console.log(`\n✅ conditionReviewTypeMix: ${pass} cases passed`);
  process.exit(0);
})();
