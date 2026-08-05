/**
 * fileAutoRoute.test.js — 제출 이미지 자동 분류·이동(파일 라우팅) 회귀가드.
 *
 * 고정하는 불변식:
 *   A. 전이표 판정(순수함수 실행) — 이동은 정의된 조합만, sure(≥0.9)만, 예시 게이트, 카카오 제외
 *   B. 모드 파싱 — 기본 dry(관측), off/auto 전환, 반려 스위치
 *   C. ★★ 반려의 유일한 근거 = SHA-256 정확 일치(findSlotDuplicate) — AI 단독 반려 경로 부재
 *   D. findSlotDuplicate / recomputePrimary 스텁 pool 실제 실행
 *   E. 배선 — review-upload 라우팅 블록·캐시 접두 상향·kind 추가·샘플 조립 단일화·
 *      trackB 라우트(sweep/revert/route 예시)·프론트(search-app/admin-settings/workdesk)·마이그레이션
 *
 * 실행: node tests/fileAutoRoute.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const readFront = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

/* ═══ A. 전이표 판정 (순수함수 실행) ═══ */
const cr = require('../src/utils/captureRoute');
{
  const sure = (got) => ({ status: 'mismatch', got, sure: true, confidence: 0.95 });
  const unsure = (got) => ({ status: 'mismatch', got, sure: false, confidence: 0.8 });
  const base = { hasReceiptSlot: true, hasRouteSamples: true, expectedChannel: 'coupang' };

  assert.strictEqual(cr.routeDecision({ slotKey: 'review', verdict: sure('receipt'), ...base }).action, 'route');
  assert.strictEqual(cr.routeDecision({ slotKey: 'review', verdict: sure('receipt'), ...base }).target, 'receipt');
  ok('A1: review 칸 + 영수증 판정(sure) → receipt 이동');

  assert.strictEqual(cr.routeDecision({ slotKey: 'review', verdict: sure('receipt'), ...base, hasReceiptSlot: false }).reason, 'no_receipt_slot');
  ok('A2: 현금영수증 슬롯 없는 탭 → 이동 안 함(폴더 있는 경우만 — 사용자 요구)');

  assert.strictEqual(cr.routeDecision({ slotKey: 'review', verdict: unsure('receipt'), ...base }).reason, 'not_sure');
  ok('A3: 확신 0.9 미만(sure 아님) → 이동 안 함(현행 경고 유지)');

  const oc = cr.routeDecision({ slotKey: 'review', verdict: sure('order_capture'), ...base });
  assert.strictEqual(oc.action, 'route'); assert.strictEqual(oc.target, 'capture');
  ok('A4: review 칸 + 구매캡처 판정 → [구매캡처] 이동');

  assert.strictEqual(cr.routeDecision({ slotKey: 'review', verdict: sure('order_capture'), ...base, hasRouteSamples: false }).reason, 'no_route_samples');
  ok('A5: ★ 구매캡처 이동은 예시 2장(구매캡처+구매확정) 등록 필수(사용자 확정)');

  const rv = cr.routeDecision({ slotKey: 'receipt', verdict: sure('review'), ...base });
  assert.strictEqual(rv.action, 'route'); assert.strictEqual(rv.toSlot, 'review');
  ok('A6: 영수증 칸 + 리뷰 판정 → [리뷰] 이동');

  assert.strictEqual(cr.routeDecision({ slotKey: 'review', verdict: sure('purchase_confirm'), ...base }).reason, 'no_transition');
  assert.strictEqual(cr.routeDecision({ slotKey: 'review', verdict: sure('other'), ...base }).reason, 'no_transition');
  ok('A7: 전이표 밖(purchase_confirm·other) → 이동 안 함(표 밖 = 무동작)');

  assert.strictEqual(cr.routeDecision({ slotKey: 'review', verdict: sure('receipt'), ...base, expectedChannel: 'kakao' }).reason, 'channel_exempt');
  ok('A8: 카카오메이커스 채널 전체 제외(피드형 오탐 방지)');

  assert.strictEqual(cr.routeDecision({ slotKey: 'review', verdict: { status: 'ok', got: 'review', sure: false }, ...base }).action, 'none');
  assert.strictEqual(cr.routeDecision({ slotKey: 'review', verdict: null, ...base }).action, 'none');
  ok('A9: 판정 없음/일치 → 무동작');

  // ★★ AI 단독 반려 부재 — 전이표 모듈에는 reject/trash 동작 자체가 없다
  const crSrc = read('src/utils/captureRoute.js');
  assert.ok(!/trashFiles|action:\s*'reject'/.test(crSrc), 'captureRoute 에 반려/삭제 동작이 있으면 안 됨');
  const allActions = new Set();
  for (const sk of ['review', 'receipt']) {
    for (const got of ['review', 'receipt', 'order_capture', 'purchase_confirm', 'other']) {
      allActions.add(cr.routeDecision({ slotKey: sk, verdict: sure(got), ...base }).action);
    }
  }
  assert.deepStrictEqual([...allActions].sort(), ['none', 'route']);
  ok('A10: ★★ routeDecision 의 동작은 none/route 뿐(반려는 해시 일치만 — captureRoute 밖)');
}

/* ═══ B. 모드 파싱 ═══ */
{
  const envBackup = { m: process.env.AUTO_FILE_ROUTE, r: process.env.AUTO_FILE_ROUTE_REJECT };
  delete process.env.AUTO_FILE_ROUTE;
  assert.strictEqual(cr.routeMode(), 'dry');
  ok('B1: 기본 모드 = dry(관측) — 사용자 확정 "관측 1회 후 출시결정", 이동 0 = 배포 순간 동작 불변');
  process.env.AUTO_FILE_ROUTE = '0'; assert.strictEqual(cr.routeMode(), 'off');
  process.env.AUTO_FILE_ROUTE = 'off'; assert.strictEqual(cr.routeMode(), 'off');
  process.env.AUTO_FILE_ROUTE = '1'; assert.strictEqual(cr.routeMode(), 'auto');
  process.env.AUTO_FILE_ROUTE = 'auto'; assert.strictEqual(cr.routeMode(), 'auto');
  process.env.AUTO_FILE_ROUTE = 'dry'; assert.strictEqual(cr.routeMode(), 'dry');
  ok('B2: off/auto/dry 전환(킬스위치)');
  delete process.env.AUTO_FILE_ROUTE_REJECT;
  assert.strictEqual(cr.rejectEnabled(), true);
  process.env.AUTO_FILE_ROUTE_REJECT = '0';
  assert.strictEqual(cr.rejectEnabled(), false);
  ok('B3: 중복 반려 스위치(AUTO_FILE_ROUTE_REJECT=0)');
  if (envBackup.m === undefined) delete process.env.AUTO_FILE_ROUTE; else process.env.AUTO_FILE_ROUTE = envBackup.m;
  if (envBackup.r === undefined) delete process.env.AUTO_FILE_ROUTE_REJECT; else process.env.AUTO_FILE_ROUTE_REJECT = envBackup.r;
}

/* ═══ C/D. findSlotDuplicate / recomputePrimary 스텁 실행 ═══ */
const fileRoute = require('../src/services/fileRoute.service');
(async () => {
  {
    let captured = null;
    fileRoute.__setPoolForTest({ query: async (sql, params) => { captured = { sql, params }; return { rows: [] }; } });
    const r0 = await fileRoute.findSlotDuplicate({ fileHash: null, rowIndex: 1, toSlot: 'review' });
    assert.strictEqual(r0, null);
    const r1 = await fileRoute.findSlotDuplicate({ fileHash: 'h', rowIndex: null, toSlot: 'review' });
    assert.strictEqual(r1, null);
    ok('C1: 해시·행 없음 = 판정 불가 = 중복 아님(fail-open, 쿼리 0)');
    assert.strictEqual(captured, null, '판정 불가에서 쿼리가 나가면 안 됨');

    await fileRoute.findSlotDuplicate({ sheetId: 's', tabName: 't', rowIndex: 94, reviewerName: '이지원', toSlot: 'review', fileHash: 'HH', fileId: 'F1' });
    assert.ok(/file_hash = \$1/.test(captured.sql) && /slot_key = \$2/.test(captured.sql), '해시+대상 슬롯 스코프');
    assert.ok(/row_index/.test(captured.sql) && /reviewer_name/.test(captured.sql), '같은 행·같은 리뷰어 스코프');
    assert.ok(/file_id <>/.test(captured.sql), '자기 자신 제외');
    ok('C2: ★★ 중복 스코프 = 같은 행·같은 리뷰어·대상 슬롯·다른 파일 (findDuplicate 와 정반대 — 사본 금지)');

    fileRoute.__setPoolForTest({ query: async () => ({ rows: [{ file_id: 'DUP' }] }) });
    const hit = await fileRoute.findSlotDuplicate({ sheetId: 's', tabName: 't', rowIndex: 1, toSlot: 'review', fileHash: 'HH' });
    assert.strictEqual(hit.file_id, 'DUP');
    fileRoute.__setPoolForTest({ query: async () => { throw new Error('db down'); } });
    const miss = await fileRoute.findSlotDuplicate({ sheetId: 's', tabName: 't', rowIndex: 1, toSlot: 'review', fileHash: 'HH' });
    assert.strictEqual(miss, null);
    ok('C3: 중복 발견 반환 + 쿼리 실패 = 중복 아님(fail-open — 반려는 확실할 때만)');
  }
  {
    const calls = [];
    fileRoute.__setPoolForTest({
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT file_id/.test(sql)) return { rows: [{ file_id: 'A', file_url: 'u', file_name: 'n', uploaded_at: 'ts' }] };
        return { rows: [] };
      },
    });
    await fileRoute.recomputePrimary({ sheetId: 's', tabName: 't', rowIndex: 3 });
    assert.ok(/slot_key = 'review'/.test(calls[0].sql), '대표 후보는 review 슬롯만');
    assert.ok(/review_file_id = \$1/.test(calls[1].sql) && calls[1].params[0] === 'A', '남은 리뷰 파일로 대표 갱신');
    calls.length = 0;
    fileRoute.__setPoolForTest({
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT file_id/.test(sql)) return { rows: [] };
        return { rows: [] };
      },
    });
    await fileRoute.recomputePrimary({ sheetId: 's', tabName: 't', rowIndex: 3 });
    assert.ok(/review_file_id = NULL/.test(calls[1].sql), '리뷰 파일 0장 = 대표 비움(영수증이 대표로 남지 않게)');
    ok('D1: recomputePrimary — 대표 재계산·비움 실행 확인');
    fileRoute.__setPoolForTest(null);
  }

  /* ═══ E. 배선 ═══ */
  const diag = read('src/routes/diag.routes.js');
  {
    assert.ok(diag.includes("require('../utils/captureRoute')"), 'review-upload 이 전이표 모듈을 사용');
    assert.ok(diag.includes('_routeDecision({') && diag.includes('findSlotDuplicate({'), '판정→중복검사 배선');
    // ★★ 휴지통(반려)은 중복 발견 + 반려 스위치일 때만 — AI 단독 반려 경로 부재
    assert.ok(diag.includes('if (dup && _routeRejectEnabled()) {'), '반려 분기 = dup && 스위치');
    const routeBlock = diag.slice(diag.indexOf('자동 분류(파일 라우팅): 오제출'), diag.indexOf('알림 기록은 판정과 분리한다'));
    const trashIdx = routeBlock.indexOf('trashFiles');
    const dupIdx = routeBlock.indexOf('findSlotDuplicate');
    assert.ok(dupIdx >= 0 && trashIdx > dupIdx, 'trashFiles 는 findSlotDuplicate 뒤(중복 확인 후)에만');
    ok('E1: ★★ 반려는 SHA-256 중복 확인 뒤에만(휴지통 — 영구삭제 API 미사용)');
    assert.ok(!/permanentlyDelete|files\.delete/.test(routeBlock), '라우팅 블록에 영구삭제 없음');

    assert.ok(diag.includes("verdict.status === 'mismatch' && !routed && !rejected"), '이동/반려 파일은 capture_mismatch 도배 안 함');
    ok('E2: 이동·반려 시 기존 불일치 알림 대체(도배 방지)');

    assert.ok(diag.includes('reviewBaseFolderId = targetFolderId'), '[리뷰] 기준 폴더를 서브폴더 진입 전에 보관');
    assert.ok(diag.includes('recomputePrimary({ sheetId, tabName, rowIndex: rowIdx })'), '라우팅 후 대표 이미지 재계산');
    assert.ok(diag.includes("r.slotKey || slot"), 'A-2 원장은 라우팅 반영 최종 슬롯으로 기록');
    assert.ok(diag.includes('markRouted({'), '이동 이력 기록(되돌리기 재료)');
    ok('E3: 원장 정합(최종 슬롯·이동 이력·대표 재계산) 배선');

    // 샘플 조립 단일화 — diag 에서 loadSamplesFor/loadReceiptSamplesFor 직접 호출 금지
    assert.ok(!/loadSamplesFor\(/.test(diag) && !/loadReceiptSamplesFor\(/.test(diag),
      'diag.routes 의 예시 조립은 submissionSamples 한 곳이어야 함(캐시 지문 분열 = AI 콜 2배)');
    assert.ok((diag.match(/submissionSamples\(\{/g) || []).length >= 2, 'precheck + upload 양쪽이 submissionSamples 사용');
    ok('E4: ★★ 예시 조립 단일 출처(submissionSamples) — 1차 필터·업로드·2차 검수 캐시 공유');
  }
  {
    const gem = read('src/services/gemini.service.js');
    assert.ok(gem.includes("'classify4:'"), '캐시 접두 상향(classify4:)');
    assert.ok(!gem.includes("_getCacheKey('classify3:"), '옛 접두 키 생성 부재');
    assert.ok(gem.includes('"order_capture"') || gem.includes("'order_capture'"), 'kind 에 order_capture');
    assert.ok(gem.includes("['review', 'receipt', 'purchase_confirm', 'order_capture', 'other']"), '검증 배열에 order_capture');
    // 오래 검증된 판정 기준(리뷰·영수증) 줄은 그대로
    assert.ok(gem.includes('- "review": 쇼핑몰 리뷰 화면. 별점(★), 리뷰 본문, 상품평 목록'), 'review 판정 기준 불변');
    assert.ok(gem.includes('- "receipt": 현금영수증/결제 영수증. 국세청, 현금영수증, 승인번호'), 'receipt 판정 기준 불변');
    ok('E5: gemini — kind 추가는 줄 추가만 + 캐시 접두 상향');

    const cv = read('src/services/captureVerify.service.js');
    assert.ok(cv.includes("order_capture: '구매캡처(주문내역) 화면'"), 'verifyCapture 라벨에 구매캡처');
    ok('E6: captureVerify 라벨 확장');
  }
  {
    const ri = read('src/services/reviewInspect.service.js');
    assert.ok(ri.includes('async function submissionSamples') && ri.includes('loadRouteSamples'), '조립 헬퍼·route 로더 존재');
    assert.ok(ri.includes("opts.samples || await submissionSamples({ expectedChannel: exp.expectedChannel, slotKey })"),
      '2차 검수 폴백도 같은 조립 사용');
    assert.ok(ri.includes("key: 'route_' + s.key"), 'route 예시 key 접두(캐시 지문 충돌 방지)');
    const rk = read('src/utils/routeSampleKinds.js');
    assert.ok(rk.includes('route_sample_order_capture') && rk.includes('route_sample_purchase_confirm'), '예시 2슬롯 단일 출처');
    ok('E7: 예시 슬롯 단일 출처(utils/routeSampleKinds) + 조립 헬퍼');
  }
  {
    const tb = read('src/routes/trackB.routes.js');
    assert.ok(tb.includes('routeSampleSettings()'), 'GET samples 에 routeSamples');
    assert.ok(tb.includes("String(b.kind || '') === 'route'"), 'POST kind route 분기');
    assert.ok(/'\/file-route\/sweep', authMiddleware, adminOrMasterMiddleware/.test(tb), '소급 스윕 = adminOrMaster');
    assert.ok(/'\/reviewer-logs\/route-revert', authMiddleware, adminOrMasterMiddleware/.test(tb), '되돌리기 = adminOrMaster');
    assert.ok(tb.includes('dryRun: b.dryRun !== false'), '스윕 기본 dryRun(명시적 false 만 실행)');
    ok('E8: trackB 라우트(스윕·되돌리기·route 예시) + 권한·dryRun 기본');
  }
  {
    const mig = read('migrations/091_review_submission_routing.sql');
    for (const col of ['routed_from_slot', 'routed_at', 'routed_by']) {
      assert.ok(mig.includes('ADD COLUMN IF NOT EXISTS ' + col), '091 컬럼: ' + col);
    }
    ok('E9: migration 091 (IF NOT EXISTS = 멱등)');
  }
  {
    const sa = readFront('js/search-app.js');
    assert.ok(sa.includes('_csShowRouteNotice') && sa.includes('_csClearRouteNotice'), '슬롯 이동 안내 함수');
    assert.ok(sa.includes('r.rejected') && sa.includes('r.routed'), '업로드 응답의 routed/rejected 처리');
    assert.ok(sa.includes('slotOutcome[slot.key]'), '슬롯 충족 재계산(이동/반려 반영)');
    assert.ok(sa.includes('const _rtStayed = _rtFiles.some(r => r && r.fileId && !r.routed)'), '단일 경로: 남은 파일 0 = 제출 기록 안 함');
    ok('E10: 리뷰어 화면 — 이동 안내·반려 안내·완료 판정 반영');

    const as = readFront('js/admin-settings.js');
    assert.ok(as.includes("kind: 'route'") && as.includes('asSmpRoute'), '설정탭 route 예시 슬롯');
    assert.ok(as.includes('previewRouteSweep') && as.includes('runRouteSweep'), '소급 정리 미리보기→실행');
    assert.ok(as.includes("dryRun: true") && as.includes("dryRun: false"), '스윕 2단계(dryRun)');
    assert.ok(as.includes('window.previewRouteSweep = previewRouteSweep'), 'IIFE 밖 노출(onclick 은 window 필수)');
    assert.ok(!/route_sample_/.test(as), '프론트에 예시 settingKey 사본 없음(서버 응답 그대로 렌더)');
    // ★ onclick 에 시트발 문자열 보간 금지 — 탭 선택은 인덱스만
    assert.ok(as.includes("opts.push('<option value=\"' + i + '\">'"), '탭 옵션 value = 인덱스');
    ok('E11: 설정탭 — 예시 등록 + 소급 정리 UI(인덱스 전달·사본 금지)');

    const wd = readFront('workdesk.html');
    assert.ok(wd.includes("_LOG_REVERTIBLE = new Set(['capture_routed'])"), '되돌리기 대상 = capture_routed 만');
    assert.ok(wd.includes("api('/api/trackb/reviewer-logs/route-revert'"), '되돌리기 API 배선');
    assert.ok(wd.includes('_revertRouteLog(${l.id})'), '버튼은 이벤트 id 만 전달(문자열 보간 금지)');
    ok('E12: 리뷰웹시스템[3버전] 로그 — [↩ 원위치] 버튼');
  }
  {
    // fileRoute.service 안전장치
    const fr = read('src/services/fileRoute.service.js');
    assert.ok(fr.includes('trashFiles') && !/permanentlyDelete|files\.delete\(/.test(fr), '삭제는 휴지통만');
    assert.ok(fr.includes('routed_from_slot IS NULL'), '이미 라우팅된 파일 재라우팅 금지(핑퐁 방지)');
    assert.ok(fr.includes("slot_key IN ('review', 'receipt')"), '스윕 대상은 review/receipt 슬롯만');
    assert.ok(fr.includes('if (dryRun) return'), '스윕 dryRun = 무변경 반환');
    assert.ok(fr.includes('is_submitted 는 건드리지 않는다'), '스윕이 제출 상태를 뒤집지 않음(문서화된 한계)');
    ok('E13: fileRoute — 휴지통·핑퐁 방지·dryRun 무변경');
  }

  console.log(`\n✅ fileAutoRoute 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
