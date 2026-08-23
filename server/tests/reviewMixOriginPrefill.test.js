/**
 * 혼합 리뷰 조합 프리필 + 정원 0 리셋 방지 (사용자 확정 2026-08-21).
 *
 *  ① 공고에 조합이 저장돼 있으면 **언제나 그 값**(작업오더가 이기지 않는다).
 *  ② 저장값이 없고 **작업오더에 조합이 있으면 그 값을 불러온다** — 저장해야 반영(조용한 적용 금지).
 *  ③ 작업오더에도 없으면 빈 채로 두고 **"직접 입력해달라"** 고 말한다(없는 값을 지어내지 않는다).
 *  ④ 짝짓기 규칙 사본 0 — 정원 폴백과 **같은 작업오더**를 본다.
 *  ⑤ 작업내용 상품 원문이 빈 공고를 열어도 총인원·일건수가 **0 으로 덮이지 않는다**(실측 버그).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
let pass = 0;
const t = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; };

console.log('\n── A. 짝짓기 규칙 단일 출처 ──');
{
  // 스텁 pool 로 실제 실행 — 컬럼 화이트리스트·우선순위·소프트삭제 제외를 눈으로 본다.
  const poolPath = require.resolve('../src/db/pool');
  const seen = [];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true,
    exports: { query: async (sql, params) => { seen.push({ sql, params }); return { rows: [{ campaign_id: 'c1', review_type_mix: [{ type: 'photo', quantity: 7 }] }] }; } } };
  delete require.cache[require.resolve('../src/services/linkedRecruitQuota.service')];
  const svc = require('../src/services/linkedRecruitQuota.service');

  t('연결 작업오더 조회 창구가 공용으로 열려 있다', typeof svc.linkedWorkOrderForCampaign === 'function');
  (async () => {
    const wo = await svc.linkedWorkOrderForCampaign({ id: 'c1', source_work_order_id: 'w9' }, ['review_type_mix']);
    t('요청한 컬럼만 SELECT 한다', /SELECT DISTINCT ON \(c\.id\) c\.id AS campaign_id, w\.review_type_mix\b/.test(seen[0].sql));
    t('★ 소프트삭제된 오더는 근거가 아니다', /deleted_at IS NULL/.test(seen[0].sql));
    t('★ 역방향 링크 우선 → 정방향(정원 폴백과 같은 우선순위)',
      /\(NULLIF\(w\.linked_campaign_id, ''\) = c\.id\) OR \(NULLIF\(c\.source_work_order_id, ''\) = w\.id\)/.test(seen[0].sql)
      && /ORDER BY c\.id, \(NULLIF\(w\.linked_campaign_id, ''\) = c\.id\) DESC, w\.updated_at DESC/.test(seen[0].sql));
    t('★ 단건도 배치와 같은 규칙을 태운다(사본 0)', seen.length === 1);
    t('행을 그대로 돌려준다', wo && wo.review_type_mix[0].quantity === 7);
    t('★ 내부 키(campaign_id)는 반환에 섞지 않는다', wo && wo.campaign_id === undefined);
    const bad = await svc.linkedWorkOrderForCampaign({ id: 'c1' }, ['review_type_mix; DROP TABLE x']);
    t('★ 컬럼 이름은 화이트리스트 — 이상한 값이면 조회하지 않는다', bad === null);
  })().then(() => {
    delete require.cache[poolPath];
    delete require.cache[require.resolve('../src/services/linkedRecruitQuota.service')];
    rest();
  }).catch(e => { console.error(e); process.exit(1); });
}

function rest() {
  console.log('\n── B. 서버 응답(관리자 상세) ──');
  const routes = fs.readFileSync(path.join(root, 'server/src/routes/campaign.routes.js'), 'utf8');
  t('관리자 상세가 작업오더 조합을 프리필 재료로 함께 내려준다',
    /feeSchedules, orderReviewTypeMix, orderInflowType, orderStartDate \}\);/.test(routes));
  t('★ 공고에 조합이 있으면 조회하지 않는다(공고가 언제나 이긴다)',
    /!\(cur\.mix \|\| \[\]\)\.length/.test(routes));
  t('★ 혼합이 아닌 공고는 대상이 아니다', /normalizeReviewType\(rows\[0\]\.review_type\) === 'mixed'/.test(routes));
  t('★ 저장값(review_type_mix)을 덮지 않는다 — 별도 필드로만 준다',
    !/data: \{ \.\.\.rows\[0\], review_type_mix/.test(routes));
  t('★ fail-soft — 못 읽어도 수정 모달은 열린다',
    /작업오더 프리필\(혼합 조합·유입방식·시작일\) 실패/.test(routes));
  t('★ 짝짓기 규칙 사본을 만들지 않는다', /linkedWorkOrderForCampaign \} = require\('\.\.\/services\/linkedRecruitQuota\.service'\)/.test(routes));

  console.log('\n── C. 화면 프리필·안내 ──');
  const fe = fs.readFileSync(path.join(root, 'frontend/js/index-recruit.js'), 'utf8');
  t('저장값이 있으면 저장값, 없고 작업오더에 있으면 작업오더',
    /const _useOrderMix = !savedReviewMix\.length && orderReviewMix\.length > 0;/.test(fe)
    && /_setRecruitGlobalReviewTypeMix\(_useOrderMix \? orderReviewMix : savedReviewMix\);/.test(fe));
  t('★ 새 모달을 열 때 지난 공고의 안내가 남지 않는다', /window\._rfMixOrigin = '';/.test(fe));
  t('★ 사람이 숫자를 고치면 출처 안내를 지운다(그 순간부터 사람이 정한 값)',
    /window\._rfMixOrigin = '';\s*\/\/ 사람이 고친 순간부터/.test(fe));

  // 안내 렌더러를 실제로 실행한다 — 정적 검사는 문구가 뒤바뀐 변이를 못 잡는다.
  {
    const st = fe.indexOf('function _renderReviewMixOriginNote(');
    const src = fe.slice(st, fe.indexOf('\nfunction getRecruitReviewTypeMix('));
    const mk = (origin) => {
      const notes = {};
      const el = () => ({ id: '', style: {}, textContent: '', remove() { notes.removed = true; } });
      const root = { firstChild: null, _kid: null, insertBefore(n) { this._kid = n; } };
      const ctx = {
        window: { _rfMixOrigin: origin },
        document: {
          getElementById: (id) => (id === 'rf_review_mix' ? root : (root._kid || null)),
          createElement: () => el(),
        },
      };
      vm.createContext(ctx);
      vm.runInContext(src + '\n_renderReviewMixOriginNote();', ctx);
      return root._kid ? root._kid.textContent : '';
    };
    t('② 작업오더에서 불러왔으면 "저장하면 반영된다"고 말한다',
      /작업오더에 적힌 리뷰 조합을 불러왔습니다/.test(mk('order')) && /저장하면 공고에 반영/.test(mk('order')));
    t('③ 작업오더에도 없으면 "직접 입력해달라"고 말한다',
      /작업오더에도 없습니다/.test(mk('empty')) && /직접 입력/.test(mk('empty')));
    t('① 저장값이 있으면 안내를 그리지 않는다', mk('') === '');
  }

  console.log('\n── C2. 유입방식 blank-only 폴백 ──');
  t('★ 판정 사본 0 — _lookupInflowType 도 공유 조각을 태운다(리뷰어 화면과 같은 오더)',
    /linkedWorkOrderForCampaign \} = require\('\.\.\/services\/linkedRecruitQuota\.service'\)[\s\S]{0,200}\['inflow_type'\]/.test(routes)
    && !/SELECT inflow_type\s*\n\s*FROM work_orders/.test(routes));
  t('★ 리뷰어 화면의 폴백 배선은 그대로(work_detail 우선 → 작업오더)',
    /\(workDetail && workDetail\.inflowType\) \|\| \(await _lookupInflowType/.test(routes));
  t('★ 저장값이 있으면 조회하지 않는다(사람이 정한 값을 덮지 않는다)',
    /const needInflow = !_savedInflowType\(rows\[0\]\.work_detail\);/.test(routes));
  // ★ 세 값(혼합 조합·유입방식·시작일)을 **한 번의 조회**로 가져온다 — 사본 조회가 늘면 근거가 갈린다.
  //   (시작일이 합류하며 조건부 조회가 무조건 조회로 바뀌었다 — 검사 의미는 "조회는 1회"로 불변.)
  t('★ 혼합 조합과 **한 번의 조회**로 가져온다(같은 근거·쿼리 순증 0)',
    /linkedWorkOrderForCampaign\(rows\[0\], \['review_type_mix', 'inflow_type', 'start_date'\]\)/.test(routes)
    && (routes.match(/linkedWorkOrderForCampaign\(rows\[0\]/g) || []).length === 1);
  t('★ 관리자 목록은 **배치 1회**(N+1 금지) · 저장값 없는 공고만 대상',
    /linkedWorkOrdersForCampaigns \} = require\('\.\.\/services\/linkedRecruitQuota\.service'\)/.test(routes)
    && /rows\.filter\(r => !_savedInflowType\(r\.work_detail\)\)\.map\(r => r\.id\)/.test(routes));
  t('★ work_detail 을 고쳐 내려보내지 않는다 — 별도 필드로만(저장 시 굳지 않게)',
    /orderInflowType: _oif/.test(routes) && !/work_detail: \{ \.\.\.r\.work_detail/.test(routes));
  t('★ 목록 폴백 실패는 fail-soft(칩 없이 계속)', /admin\/list 유입방식 폴백 실패/.test(routes));

  const cards = fs.readFileSync(path.join(root, 'frontend/js/campaign-cards.js'), 'utf8');
  t('카드 칩도 같은 폴백을 본다(리뷰어 화면과 갈리지 않게)',
    /const inflowType = \(_wd && _wd\.inflowType\) \|\| c\.orderInflowType \|\| ''/.test(cards));

  t('수정 프리필은 저장값 우선 · 없을 때만 작업오더',
    /const _savedInflow = \(wd\.inflowType === "guide" \|\| wd\.inflowType === "link"\) \? wd\.inflowType : "";/.test(fe)
    && /_inflowInput\.value = _savedInflow \|\| _orderInflow \|\| "link";/.test(fe));
  t('★ 옛 형태(값 없으면 무조건 link)가 되살아나지 않는다',
    !/_inflowInput\.value = wd\.inflowType === "guide" \? "guide" : "link";/.test(fe));
  t('★ 모달 오픈 말미의 동기화는 출처 표식을 지우지 않는다(silent)',
    /rfSetInflowType\(document\.getElementById\("rf_inflow_type_value"\)\?\.value \|\| "link", null, \{ silent: true \}\)/.test(fe));
  t('★ 사람이 버튼을 누르면 출처 안내를 지운다',
    /if \(!\(opts && opts\.silent\)\) window\._rfInflowOrigin = "";/.test(fe));
  t('★ 새 모달을 열 때 지난 공고의 유입 안내가 남지 않는다', /window\._rfInflowOrigin = '';/.test(fe));

  console.log('\n── C3. 혼합 안내가 거짓말하지 않는다 ──');
  {
    const st2 = fe.indexOf('function _renderReviewMixOriginNote(');
    const src2 = fe.slice(st2, fe.indexOf('\nfunction getRecruitReviewTypeMix('));
    const mk2 = (origin, sum, expected) => {
      const root = { firstChild: null, _kid: null, insertBefore(n) { this._kid = n; } };
      const ctx = {
        window: { _rfMixOrigin: origin },
        getRecruitReviewTypeMix: () => [{ type: 'photo', quantity: sum }],
        document: {
          getElementById: (id) => (id === 'rf_review_mix' ? root
            : id === 'rf_recruit_total' ? { value: String(expected) } : (root._kid || null)),
          createElement: () => ({ id: '', style: {}, textContent: '', remove() {} }),
        },
      };
      vm.createContext(ctx);
      vm.runInContext(src2 + '\n_renderReviewMixOriginNote();', ctx);
      return root._kid ? root._kid.textContent : '';
    };
    t('★ 합계 ≠ 총건수면 "저장하면 반영된다"고 말하지 않는다',
      /그대로 저장할 수 없습니다/.test(mk2('order', 100, 300))
      && !/저장하면 공고에 반영/.test(mk2('order', 100, 300)));
    t('★ 그 문구는 실제 숫자를 말한다(합계·총건수)',
      /합계 100건/.test(mk2('order', 100, 300)) && /총건수 300건/.test(mk2('order', 100, 300)));
    t('합계가 맞으면 종전 초록 안내', /저장하면 공고에 반영/.test(mk2('order', 300, 300)));
    t('★ 총건수를 모르면(0) 합계 경고를 만들지 않는다', /저장하면 공고에 반영/.test(mk2('order', 100, 0)));
  }

  console.log('\n── D. 정원 0 리셋 방지(실측 버그) ──');
  t('★ 표가 0행이면 총인원·일건수를 다시 만들지 않는다(프리필 값 보존)',
    /const head = live\[0\] \|\| rows\[0\] \|\| null;/.test(fe)
    && /if \(head\) \{\s*\n\s*if \(rt\) rt\.value/.test(fe));
  t('★ 0 으로 덮던 옛 형태가 되살아나지 않는다',
    !/const head = live\[0\] \|\| rows\[0\] \|\| \{\};/.test(fe));

  console.log(`\n✅ reviewMixOriginPrefill: ${pass} cases passed`);
}
