/**
 * purchaseConfirmSignals.test.js — 구매확정 판별 기준 확장 회귀가드.
 * 실행: node tests/purchaseConfirmSignals.test.js
 *
 * 신고(2026-08-23): 공고 리뷰타입이 **구매확정**인 작업에서 네이버페이 적립 완료 팝업
 * (`orders.pay.naver.com` · "495원 적립되었어요")이 전건 불량으로 떨어졌다.
 * 원인은 리뷰타입 설정이 아니라 **AI 가 그 화면을 `order_capture` 로 판별**한 것이었다 —
 * 구매확정 작업이 정상으로 보는 종류는 `review`·`purchase_confirm` 둘뿐이라
 * `order_capture` 는 **리뷰타입이 제대로 잡혀도 무조건 불량**이 된다.
 *
 * 사용자 확정(B안): 허용 목록을 넓히지 않고(그건 구매확정 검수를 무력화한다)
 * **판별 기준(프롬프트) + 판별 예시이미지**로 해결한다.
 *
 * 이 가드가 고정하는 것
 *  ① 오래 검증된 판정 기준 3줄(review·receipt·other)은 **한 글자도** 안 바뀐다
 *  ② purchase_confirm 은 "구매확정" 글자가 없어도 완료 신호를 인정한다(넓히는 방향만)
 *  ③ 리뷰 작성 적립은 제외한다(완화가 무한정 넓어지지 않는다)
 *  ④ **캐시 접두 상향** — 안 올리면 옛 판정이 히트해 프롬프트 수정이 조용히 무효가 된다
 *  ⑤ 허용 목록(`_okKinds`)은 그대로 — A안(order_capture 인정)으로 미끄러지지 않는다
 *  ⑥ 화면이 "무엇을 해야 풀리는지"를 말한다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const gem = readS('services/gemini.service.js');
const svc = readS('services/reviewInspect.service.js');
const wd = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

/* ═══ ① 손대지 않은 것 ═════════════════════════════════════════════ */
console.log('\n▶ 오래 검증된 판정 기준은 불변');
ok('★★ review 줄 한 글자도 불변',
  gem.includes('- "review": 쇼핑몰 리뷰 화면. 별점(★), 리뷰 본문, 상품평 목록, "리뷰 작성 완료" 같은 UI가 보임.'));
ok('★★ receipt 줄 한 글자도 불변',
  gem.includes('- "receipt": 현금영수증/결제 영수증. 국세청, 현금영수증, 승인번호, 사업자등록번호, 지출증빙, 거래일시 중 하나 이상이 보임.'));
ok('★★ other 줄 한 글자도 불변',
  gem.includes('- "other": 둘 다 아님(상품 사진, 주문내역, 빈 화면 등).'));
ok('purchase_confirm 종전 정의(구매확정 문구 + 완료 표시)는 그대로 남아 있다 — 넓혔을 뿐 지우지 않았다',
  /- "purchase_confirm": 구매확정 완료 화면\. "구매확정" 문구와 함께 완료됨을 나타내는 표시/.test(gem));

/* ═══ ② 넓힌 것 ═══════════════════════════════════════════════════ */
console.log('\n▶ 구매확정 완료 신호 인정(B안)');
ok('★ "구매확정" 글자가 없어도 완료 신호를 인정한다',
  /"구매확정" 글자가 화면에 없어도[\s\S]{0,80}purchase_confirm 으로 본다/.test(gem));
ok('★ 신고 화면을 예로 못박는다(네이버페이 적립 완료 안내)',
  /orders\.pay\.naver\.com/.test(gem) && /적립되었어요/.test(gem));
ok('★★ 리뷰 작성 적립은 제외 — 완화가 무한정 넓어지지 않는다',
  /리뷰 작성에 대한 적립이라고 화면에 적혀 있으면 purchase_confirm 이 아니다/.test(gem));
ok('★ order_capture 줄이 배타 조건을 말한다(두 종류가 같은 화면을 서로 가져가지 않게)',
  /"구매확정" 완료 표시나 위의 구매확정 적립 완료 안내가 있으면 purchase_confirm/.test(gem));

/* ═══ ③ 캐시 접두 ═════════════════════════════════════════════════ */
console.log('\n▶ 캐시 접두');
ok('★★ 접두를 올렸다 — 안 올리면 같은 이미지의 옛 판정이 히트해 프롬프트 수정이 무효가 된다',
  /_getCacheKey\('classify5:'/.test(gem));
ok('★ 옛 접두로 되돌아가지 않는다', !/_getCacheKey\('classify[1-4]?:'/.test(gem));
ok('kind 화이트리스트는 그대로(종류를 새로 만들지 않았다)',
  gem.includes("['review', 'receipt', 'purchase_confirm', 'order_capture', 'other']"));

/* ═══ ④ 허용 목록은 그대로 — A안 미끄럼 방지 ═══════════════════════ */
console.log('\n▶ 허용 목록(A안으로 미끄러지지 않는다)');
const okKinds = /const _okKinds = effReviewType === 'confirm' \? (\[[^\]]*\]) : (\[[^\]]*\]);/.exec(svc);
assert(okKinds, '_okKinds 선언을 찾지 못했다');
ok('★★ 구매확정 작업의 허용 종류는 review·purchase_confirm 둘뿐 — order_capture 를 더하지 않았다',
  okKinds[1].replace(/\s/g, '') === "['review','purchase_confirm']");
ok('★ 리뷰 작업은 종전 그대로 review 하나', okKinds[2].replace(/\s/g, '') === "['review']");
ok('★ 업로드 시점 슬롯 검수도 종전 그대로(구매확정 탭 = purchase_confirm 기대)',
  require('../src/services/captureVerify.service')._expectedKind('review', 'confirm') === 'purchase_confirm');

/* ═══ ⑤ 판정 실행 — 넓힌 뒤에도 결과가 의도대로인가 ════════════════ */
console.log('\n▶ 2차 검수 실행(스텁 AI·스텁 pool)');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const gp = require.resolve('../src/services/gemini.service');
let KIND = 'order_capture';
require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: {
  classifySubmissionImage: async () => ({ kind: KIND, confidence: 0.95, channel: 'naver', productName: '', reviewText: '', authorMask: '', signals: [] }),
} };
const RI = require('../src/services/reviewInspect.service');

(async () => {
  const run = async (kind, campType) => {
    KIND = kind;
    let got = null;
    RI.__setPoolForTest({ query: async (sql, p) => {
      const q = String(sql);
      // ★ 탭 설정에는 옛 배송유형('실배송')이 남아 있는 상태 — 공고 값이 이겨야 한다
      if (/FROM tab_configs c/.test(q)) {
        return { rows: [{ inspect_product_names: '', inspect_product_aliases: '', tab_review_type: '실배송',
          tab_work_kind: null, channel: '네이버', channel_custom: null, camp_review_type: campType, camp_work_kind: null }] };
      }
      if (/INSERT INTO review_inspections/i.test(q)) {
        got = JSON.parse(p.find(x => typeof x === 'string' && x.startsWith('{"format')) || '{}');
        return { rows: [] };
      }
      return { rows: [] };
    } });
    await RI.inspectSubmission({ fileId: `f_${kind}_${campType}`, sheetId: 'S', tabName: 'T',
      reviewerName: 'R', slotKey: 'review', base64: 'QUJD', mimeType: 'image/jpeg' });
    return got && got.format;
  };

  const a = await run('purchase_confirm', 'confirm');
  ok('★★ 구매확정 작업 + 구매확정 완료 화면 → 통과(이번 수정이 노리는 결과)', a && a.verdict === 'pass');

  const b = await run('order_capture', 'confirm');
  ok('★★ 같은 작업에 주문내역이 오면 여전히 불량 — 허용 목록을 넓히지 않았다는 증거',
    b && b.verdict === 'fail' && b.kind === 'order_capture');

  const c = await run('review', 'confirm');
  ok('구매확정 작업에 리뷰 화면이 와도 종전대로 통과(잡는 범위를 넓히지 않는다)', c && c.verdict === 'pass');

  const d = await run('purchase_confirm', null);
  ok('★ 리뷰 작업에 구매확정 화면이 오면 종전대로 불량(판정이 느슨해지지 않았다)',
    d && d.verdict === 'fail' && d.kind === 'purchase_confirm');

  RI.__setPoolForTest(null);

  /* ═══ ⑥ 화면 안내 ═══════════════════════════════════════════════ */
  console.log('\n▶ 화면이 조치를 말한다');
  const m = /function _riConfirmNeedsSample\(r\)\{[\s\S]*?\n\}/.exec(wd);
  assert(m, '_riConfirmNeedsSample 을 찾지 못했다');
  const sb = { _riRT: (r) => r.__rt, _riFmtKind: (fm) => (fm && (fm.got || fm.kind)) || '' };
  vm.createContext(sb);
  vm.runInContext(m[0] + '\nthis.__f = _riConfirmNeedsSample;', sb);
  const f = sb.__f;
  const row = (t, kind, verdict) => ({ __rt: t ? { type: t } : null, checks: { format: { verdict, kind } } });
  ok('★ 구매확정 작업 + 주문내역 판별 + 불량 → 안내', f(row('confirm', 'order_capture', 'fail')) === true);
  ok('★ 리뷰타입 미설정이면 이 안내는 안 뜬다(기존 _riConfirmMisset 과 배타)',
    f(row(null, 'order_capture', 'fail')) === false);
  /* ★★ 리뷰타입이 **설정돼 있지만 구매확정이 아닌** 작업(포토·텍스트…)에도 뜨면 안 된다 —
       그쪽은 "구매확정 예시를 등록하라"가 틀린 조치다(변이시험이 잡은 빈틈 2026-08-23). */
  for (const t of ['photo', 'text', 'star', 'mixed']) {
    ok(`★ 리뷰타입 ${t} 작업에는 안 뜬다(틀린 조치 안내 금지)`, f(row(t, 'order_capture', 'fail')) === false);
  }
  ok('통과 건에는 안 뜬다', f(row('confirm', 'order_capture', 'pass')) === false);
  ok('다른 종류로 판별된 불량에는 안 뜬다', f(row('confirm', 'other', 'fail')) === false);
  ok('★ 안내가 "리뷰타입을 다시 저장해도 안 바뀐다"고 못박는다(헛수고 방지)',
    /리뷰타입을 다시 저장해도 바뀌지 않습니다/.test(wd));
  ok('★ 다음 행동 2가지를 말한다(예시 등록 → 재검수)',
    /설정 › AI 판별 예시/.test(wd) && /구매확정 완료 화면<\/b>\(모바일·PC\)/.test(wd));

  console.log(`\n✅ ${n} 케이스 통과`);
  process.exit(0);
})();
