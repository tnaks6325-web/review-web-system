/**
 * reviewInspectLearn.test.js — 리뷰검수 수동 확인 = AI 판별 학습 루프 회귀가드 (migration 092).
 *
 * 고정하는 불변식:
 *   A. 확인 2분화(ok=정상/오탐 · bad=불량) — resolution 원장 기록, 모르는 값은 기록 안 함
 *   B. [정상] 확인의 상품명 학습 — 상품명 의심(product warn) 건만, 별칭은 **가산 병합**
 *      (기대 상품명 우선순위 규칙 불변 — manual 있으면 파생 안 보는 규칙을 별칭이 안 바꾼다)
 *   C. 일괄 정상 처리 — suspect/fail 만 종결 + 별칭 일괄 학습 (adminOrMaster)
 *   D. 배선 — REQUIRED_SCHEMA(092)·목록 SELECT·라우트·workdesk 버튼·예시 승격
 *
 * 실행: node tests/reviewInspectLearn.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const readFront = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

const svc = require('../src/services/reviewInspect.service');

/* 스텁 pool — 쿼리 시퀀스를 캡처하고 준비된 응답을 돌려준다 */
function stubPool(handlers) {
  let i = 0;
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const h = handlers[Math.min(i, handlers.length - 1)]; i++;
      return typeof h === 'function' ? h(sql, params) : (h || { rows: [], rowCount: 0 });
    },
  };
}

(async () => {
  /* ═══ A. 확인 2분화 ═══ */
  {
    // A1: ok 확인 + 상품명 의심 → 별칭 학습(3쿼리: UPDATE→별칭 SELECT→별칭 UPDATE)
    const p = stubPool([
      { rows: [{ sheet_id: 's', tab_name: 't', ocr_product: '이노크아든 빨아쓰는 면마스크 다회용…',
                 checks: { product: { verdict: 'warn' } } }] },
      { rows: [{ inspect_product_aliases: '' }] },
      { rows: [], rowCount: 1 },
    ]);
    svc.__setPoolForTest ? svc.__setPoolForTest(p) : null;
    // reviewInspect 는 __setPoolForTest 가 없을 수 있다 — _db 주입 방식 확인
    assert.ok(typeof svc.resolveInspection === 'function');
    const r = await svc.resolveInspection({ fileId: 'F', by: '만두', resolution: 'ok' });
    assert.strictEqual(r.resolved, 1);
    assert.strictEqual(r.aliasAdded, 1, '상품명 의심 + ok 확인 = 별칭 1건 학습');
    assert.ok(/SET status = 'resolved', resolution = COALESCE\(\$3, resolution\)/.test(p.calls[0].sql));
    assert.strictEqual(p.calls[0].params[2], 'ok');
    assert.ok(/inspect_product_aliases = \$1/.test(p.calls[2].sql), '별칭이 tab_configs 에 저장');
    assert.ok(String(p.calls[2].params[0]).includes('이노크아든'), '캡처 표기(정리본)가 별칭으로');
    ok('A1: [정상] 확인 → 상품명 의심 건의 캡처 표기를 인정 별칭으로 학습');

    // A2: bad 확인 = 학습 없음(원장 기록만)
    const p2 = stubPool([
      { rows: [{ sheet_id: 's', tab_name: 't', ocr_product: 'X', checks: { product: { verdict: 'warn' } } }] },
    ]);
    svc.__setPoolForTest(p2);
    const r2 = await svc.resolveInspection({ fileId: 'F', by: '만두', resolution: 'bad' });
    assert.strictEqual(r2.aliasAdded, 0);
    assert.strictEqual(p2.calls.length, 1, 'bad 는 별칭 쿼리 자체가 없다');
    ok('A2: [불량 맞음] = 원장 기록만(학습 없음)');

    // A3: 모르는 resolution 값은 기록하지 않는다(COALESCE null = 기존 유지)
    const p3 = stubPool([{ rows: [] }]);
    svc.__setPoolForTest(p3);
    await svc.resolveInspection({ fileId: 'F', by: '만두', resolution: 'weird' });
    assert.strictEqual(p3.calls[0].params[2], null);
    ok('A3: resolution 화이트리스트(ok/bad 외 = null)');

    // A4: ok 라도 상품명 의심이 아니면(형식 불량 등) 별칭을 만들지 않는다
    const p4 = stubPool([
      { rows: [{ sheet_id: 's', tab_name: 't', ocr_product: '이노크아든 면마스크',
                 checks: { format: { verdict: 'fail' } } }] },
    ]);
    svc.__setPoolForTest(p4);
    const r4 = await svc.resolveInspection({ fileId: 'F', by: '만두', resolution: 'ok' });
    assert.strictEqual(r4.aliasAdded, 0);
    ok('A4: ★ 별칭 학습은 상품명 의심(product warn) 건만 — 아무 확인이나 기대값을 넓히지 않는다');

    // A5: 상품명 의심이 있어도 다른 사유가 섞인 전체 종결은 상품명 정답이 아니다.
    const p5 = stubPool([
      { rows: [{ sheet_id: 's', tab_name: 't', ocr_product: '메디큐브 파라다이스 그레인',
                 checks: { product: { verdict: 'warn' }, duplicate: { verdict: 'fail' } } }] },
    ]);
    svc.__setPoolForTest(p5);
    const r5 = await svc.resolveInspection({ fileId: 'F', by: '만두', resolution: 'ok' });
    assert.strictEqual(r5.aliasAdded, 0);
    assert.strictEqual(p5.calls.length, 1, '복합 사유 전체 종결은 탭 별칭을 오염시키지 않는다');
    ok('A5: ★★ 복합 사유 전체 종결은 상품명 학습에서 제외');
  }

  /* ═══ B. 별칭 = 가산 병합 (우선순위 불변) ═══ */
  {
    const riSrc = read('src/services/reviewInspect.service.js');
    assert.ok(riSrc.includes('_mergeProductNames(out.productNames, aliases)'), 'manual 에 별칭 가산');
    assert.ok(riSrc.includes('_mergeProductNames(derived, aliases)'), 'work_order 파생에 별칭 가산');
    assert.ok(riSrc.includes("if (out.productNames.length) {") && riSrc.includes("out.productSource = 'manual'"),
      'manual 우선 규칙 생존(별칭이 소스 전환을 만들지 않는다)');
    ok('B1: ★★ 별칭은 어느 소스든 가산만 — manual/work_order 우선순위 규칙 불변');

    // B2: 중복(정규화 기준)은 다시 안 쌓인다
    const p = stubPool([
      { rows: [{ sheet_id: 's', tab_name: 't', ocr_product: '이노크아든 면마스크',
                 checks: { product: { verdict: 'warn' } } }] },
      { rows: [{ inspect_product_aliases: '이노크아든 면마스크' }] },
    ]);
    svc.__setPoolForTest(p);
    const r = await svc.resolveInspection({ fileId: 'F', by: '만두', resolution: 'ok' });
    assert.strictEqual(r.aliasAdded, 0, '이미 있는 별칭 = 추가 0 (UPDATE 미실행)');
    assert.strictEqual(p.calls.length, 2, '변화 없으면 별칭 UPDATE 를 쏘지 않는다');
    ok('B2: 별칭 중복(정규화 기준) 재적재 없음');

    // B3: 짧은 조각(4자 미만)은 별칭으로 삼지 않는다 — 아무거나 통과 방지
    const p3 = stubPool([
      { rows: [{ sheet_id: 's', tab_name: 't', ocr_product: '상품',
                 checks: { product: { verdict: 'warn' } } }] },
    ]);
    svc.__setPoolForTest(p3);
    const r3 = await svc.resolveInspection({ fileId: 'F', by: '만두', resolution: 'ok' });
    assert.strictEqual(r3.aliasAdded, 0);
    ok('B3: 4자 미만 조각은 별칭 제외(대조가 무의미해지는 것 방지)');
  }

  /* ═══ C. 일괄 정상 처리 ═══ */
  {
    const p = stubPool([
      { rows: [
        { sheet_id: 's', tab_name: 't', ocr_product: '이노크아든 빨아쓰는 면마스크…', checks: { product: { verdict: 'warn' } } },
        { sheet_id: 's', tab_name: 't', ocr_product: '이노크아든 빨아쓰는 면마스크…', checks: { product: { verdict: 'warn' } } },
        { sheet_id: 's', tab_name: 't', ocr_product: '', checks: { format: { verdict: 'fail' } } },
      ] },
      { rows: [{ inspect_product_aliases: '' }] },
      { rows: [], rowCount: 1 },
    ]);
    svc.__setPoolForTest(p);
    const r = await svc.resolveInspectionsBulk({ sheetId: 's', tabName: 't', resolution: 'ok', by: '만두' });
    assert.strictEqual(r.resolved, 3);
    assert.strictEqual(r.aliasAdded, 1, '같은 표기 2건 = 별칭 1건(중복 접힘)');
    assert.ok(/status IN \('suspect', 'fail'\)/.test(p.calls[0].sql), '일괄 대상 = 미확인 의심·불량만(resolved·pass·pending 무접촉)');
    ok('C1: 일괄 정상 처리 — suspect/fail 만 종결 + 별칭 일괄 학습(중복 접힘)');
    assert.deepStrictEqual(await svc.resolveInspectionsBulk({}), { ok: false, error: 'sheetId, tabName이 필요합니다.' });
    ok('C2: 탭 미지정 일괄 거부(전 시스템 일괄 종결 사고 방지)');
    svc.__setPoolForTest(null);
  }

  /* ═══ D. 배선 ═══ */
  {
    const idx = read('index.js');
    assert.ok(idx.includes("['review_inspections', 'resolution']") && idx.includes("['tab_configs', 'inspect_product_aliases']"),
      'REQUIRED_SCHEMA 에 092 컬럼 2종(없으면 리뷰검수 목록 전면 42703)');
    const mig = read('migrations/092_review_inspect_learning.sql');
    assert.ok(mig.includes('ADD COLUMN IF NOT EXISTS resolution') && mig.includes('ADD COLUMN IF NOT EXISTS inspect_product_aliases'),
      '092 멱등');
    ok('D1: migration 092 + 부팅 프리플라이트 등록');

    const ri = read('src/services/reviewInspect.service.js');
    assert.ok(/i\.resolution,[\s\S]*i\.inspected_at/.test(ri), '목록 SELECT 에 resolution');
    const tb = read('src/routes/trackB.routes.js');
    // ⚠ 반려 통지 도입으로 배선 형태가 바뀌었다(const 분리) — 검사 의미 불변: resolution 이 서비스까지 간다.
    assert.ok(tb.includes("const resolution = String((req.body || {}).resolution || '')")
      && tb.includes('resolveInspection({ fileId, by, resolution })'), 'resolve 라우트가 resolution 전달');
    assert.ok(/'\/review-inspect\/resolve-bulk', authMiddleware, adminOrMasterMiddleware/.test(tb),
      '일괄 = adminOrMaster(건별은 종전대로 staff 담당 탭)');
    ok('D2: 라우트 배선 + 일괄 권한 경계');

    const wd = readFront('workdesk.html');
    // ⚠ 불량은 전용 팝업(riBadPopup — 반려 사유 전송)으로 배선이 바뀌었다 — 검사 의미 불변: 2분화 생존.
    assert.ok(wd.includes("riResolve('${esc(r.file_id)}','ok')") && wd.includes('riBadPopup(${i})'),
      '카드 [✓ 정상]/[✕ 불량] 2분화');
    assert.ok(wd.includes('riResolveAllTab') && wd.includes('/review-inspect/resolve-bulk'), '[✔ 일괄 정상] 배선');
    assert.ok(wd.includes('riPromoteSample') && wd.includes("API_BASE+'/api/drive/image/'+st.fileId"),
      '판별 예시 승격 — 기존 무인증 프록시 URL 재사용(신규 저장소 0)');
    assert.ok(wd.includes('riPromotePick(${si})'), '예시 슬롯 선택은 인덱스만 전달(문자열 보간 금지)');
    assert.ok(wd.includes("kind:'route', key:s.key") && wd.includes("kind:'receipt', channel:s.key"),
      '승격 페이로드가 슬롯 종류별 저장 창구와 일치');
    ok('D3: workdesk — 2분화 버튼·일괄·예시 승격 배선');

    // 별칭 가시성 — 조용한 자동수정 금지: 기대 상품명 화면이 학습 별칭을 보여주고 편집 가능
    assert.ok(wd.includes('학습된 인정 별칭') && tb.includes('saveProductAliases'),
      '학습 별칭 표시 + 편집 경로(조용한 자동수정 금지)');
    ok('D4: 학습 별칭은 화면에 드러나고 사람이 다듬을 수 있다');
  }

  console.log(`\n✅ reviewInspectLearn 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
