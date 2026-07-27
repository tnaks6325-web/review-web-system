/**
 * written 사후검증(유령 written 감지·자가치유) 회귀가드 — 7/24 이지유 사건 재발방지 (migration 062)
 *   ① 신선도 게이트: 미러가 쓰기보다 오래되면 판정 금지(오탐 차단)
 *   ② 정상 행 → row_verified_at 스탬프만
 *   ③ 행 이동(중간 행 삽입 등) → sheet_row 포인터 자가보정 + info 로그(자동 해결 상태)
 *   ④ 소실(유령 written) → critical 한글 로그 + failed 강등(claim 해제) → reconcile 재기록
 *   ⑤ 소실 반복(ORDER_LOST_MAX 이상) → stuck_manual 전환(무한 재기록 루프 차단)
 *   ⑥ 캡처 미첨부 감지: 컷오프 없으면 전면 skip(과거 주문 소급 오탐 방지)
 *   ⑦ 로그 dedup: 미해결 (event_type, order_submission_id) 중복은 skipped
 * 실행: node tests/writtenVerify.test.js
 */
const assert = require('assert');

const wv = require('../src/services/writtenVerify.service');
const relog = require('../src/services/reviewerEventLog.service');

// ── 간이 pool 목: 정규화된 SQL 패턴별 응답 + 호출 기록 ──
function makePool(scn = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ s, params });
      if (/FROM order_submissions os WHERE os\.mirror_status = 'written'/.test(s)) return { rows: scn.writtenOrders || [] };
      if (/SELECT mirrored_at FROM raw_sheet_tabs/.test(s)) return { rows: scn.mirroredAt ? [{ mirrored_at: scn.mirroredAt }] : [] };
      if (/SELECT COUNT\(\*\)::int AS n FROM reviewer_event_logs/.test(s)) return { rows: [{ n: scn.priorLost || 0 }] };
      if (/INSERT INTO reviewer_event_logs/.test(s)) {
        if (scn.logDup) return { rows: [] };            // 미해결 중복 → ON CONFLICT DO NOTHING
        return { rows: [{ id: (scn._logSeq = (scn._logSeq || 0) + 1) }] };
      }
      if (/SELECT display_name, campaign_name FROM tab_configs/.test(s)) return { rows: [] };
      if (/UPDATE order_submissions SET sheet_row = \$2, row_verified_at/.test(s)) return { rowCount: 1 };
      if (/UPDATE sheet_row_claims SET sheet_row/.test(s)) { if (scn.claimMoveConflict) { const e = new Error('dup'); e.code = '23505'; throw e; } return { rowCount: 1 }; }
      if (/DELETE FROM sheet_row_claims/.test(s)) return { rowCount: 1 };
      if (/SET sheet_row = NULL, mirror_status = 'failed'/.test(s)) return { rowCount: 1 };
      if (/SET mirror_status = 'stuck_manual'/.test(s)) return { rowCount: 1 };
      if (/UPDATE order_submissions SET row_verified_at = NOW\(\) WHERE id = ANY/.test(s)) return { rowCount: (params && params[0] && params[0].length) || 0 };
      if (/SELECT value FROM app_settings/.test(s)) return { rows: scn.captureCutoff ? [{ value: scn.captureCutoff }] : [] };
      if (/os\.capture_uploaded_at IS NULL/.test(s)) return { rows: scn.noCaptureOrders || [] };
      if (/os\.mirror_status = 'stuck_manual' OR/.test(s)) return { rows: scn.stuckOrders || [] };
      if (/UPDATE reviewer_event_logs/.test(s)) return { rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}

const HEADERS = ['번호', '담당자', '구매일자', '인애드명단', '주문자제출', '수취인', '쿠팡id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰제출', '입금', '주문번호', '택배송장번호', '비고'];
function row(rowIndex, recip, phone, orderNum) {
  const cells = new Array(HEADERS.length).fill('');
  cells[5] = recip || ''; cells[7] = phone || ''; cells[15] = orderNum || '';
  if (recip) { cells[4] = recip; cells[8] = '어딘가 주소'; }
  return { rowIndex, cells };
}
function osRow(over = {}) {
  return {
    id: '3c3729cb-77b3-49aa-b854-daf1d4007257', sheetId: 'SHEET1', tabName: '탄소매트 900건', gid: '392276654',
    sheetRow: 75, recipient: '이지유', orderer: '이지유', phone: '010-3353-6503', orderNum: '31101822476686',
    writtenAt: new Date('2026-07-24T00:05:00Z'), verifiedAt: null, phone8: '33536503', ...over,
  };
}
function setCtx(dataRows) {
  wv.__setLoadCtxForTest(async () => ({
    sheetId: 'SHEET1', tabGid: '392276654', tabName: '탄소매트 900건',
    headers: HEADERS, headerRowIndex: 9, dataStartRow: 10, dataRows,
  }));
}
const FRESH = new Date(Date.now() - 60 * 1000); // 최근 미러(쓰기보다 훨씬 새로움)

async function run() {
  // ═══ 0. 순수함수: 행 신원 판정 ═══
  {
    const cols = wv._identityCols(HEADERS);
    assert.equal(cols.phoneCol, 7); assert.equal(cols.recipCol, 5); assert.equal(cols.orderNumCol, 15);
    const os = osRow();
    assert.equal(wv._rowVerdict(row(75, '이지유', '010-3353-6503', '31101822476686').cells, cols, os), 'mine', '주문번호+전화 일치 = mine');
    assert.equal(wv._rowVerdict(row(75, '이지유', '010-0000-0000', '').cells, cols, os), 'other', '이름만 같고 강한 키 불일치 = other(이름 단독 불인정)');
    assert.equal(wv._rowVerdict(row(75, '김옥선', '010-5384-9851', '30101824728828').cells, cols, os), 'other', '타인 데이터 = other');
    assert.equal(wv._rowVerdict(row(75, '', '', '').cells, cols, os), 'other', '빈 행 = other(내 데이터 소실)');
    // 주문번호만 일치해도 mine (전화가 비어있는 행 — 부분 소실)
    assert.equal(wv._rowVerdict(row(75, '', '', '31101822476686').cells, cols, os), 'mine');
  }

  // ═══ 1. 신선도 게이트: 미러가 쓰기보다 오래됨 → 판정 금지(무액션) ═══
  {
    const pool = makePool({
      writtenOrders: [osRow()],
      mirroredAt: new Date('2026-07-24T00:04:00Z'), // 쓰기(00:05)보다 오래된 스냅샷
    });
    wv.__setPoolForTest(pool); relog.__setPoolForTest(pool);
    setCtx([row(75, '김옥선', '010-5384-9851', '30101824728828')]); // 내용이 달라도
    const r = await wv.verifyWrittenOrders();
    assert.equal(r.skippedStale, 1, '오래된 미러로는 판정하지 않는다');
    assert.equal(r.lost + r.shifted + r.lostManual, 0);
    assert.ok(!pool.calls.some(c => /mirror_status = 'failed'/.test(c.s)), 'stale 미러에서 강등 금지');
  }

  // ═══ 2. 정상 행 → 스탬프만 ═══
  {
    const pool = makePool({ writtenOrders: [osRow()], mirroredAt: FRESH });
    wv.__setPoolForTest(pool); relog.__setPoolForTest(pool);
    setCtx([row(75, '이지유', '010-3353-6503', '31101822476686')]);
    const r = await wv.verifyWrittenOrders();
    assert.equal(r.verified, 1);
    assert.ok(pool.calls.some(c => /row_verified_at = NOW\(\) WHERE id = ANY/.test(c.s)), '검증 스탬프 기록');
    assert.ok(!pool.calls.some(c => /INSERT INTO reviewer_event_logs/.test(c.s)), '정상 건은 로그 없음');
  }

  // ═══ 3. 행 이동(7/27 중간 행 삽입 유형) → 포인터 자가보정 + info 로그 ═══
  {
    const pool = makePool({ writtenOrders: [osRow()], mirroredAt: FRESH });
    wv.__setPoolForTest(pool); relog.__setPoolForTest(pool);
    setCtx([row(75, '김옥선', '010-5384-9851', '30101824728828'), row(76, '이지유', '010-3353-6503', '31101822476686')]);
    const r = await wv.verifyWrittenOrders();
    assert.equal(r.shifted, 1, '행 이동 감지');
    const upd = pool.calls.find(c => /UPDATE order_submissions SET sheet_row = \$2, row_verified_at/.test(c.s));
    assert.ok(upd, '포인터 보정 UPDATE 실행');
    assert.equal(upd.params[1], 76, '새 행 76으로 보정');
    assert.equal(upd.params[2], 75, 'CAS: 원래 행(75)일 때만');
    const log = pool.calls.find(c => /INSERT INTO reviewer_event_logs/.test(c.s));
    assert.ok(log && /order_row_shifted/.test(JSON.stringify(log.params)), '행이동 info 로그');
    assert.ok(!pool.calls.some(c => /mirror_status = 'failed'/.test(c.s)), '행 이동은 강등 아님(시트 무접촉)');
  }

  // ═══ 4. 유령 written(이지유 유형) → critical 로그 + failed 강등 + claim 해제 ═══
  {
    const pool = makePool({ writtenOrders: [osRow()], mirroredAt: FRESH, priorLost: 0 });
    wv.__setPoolForTest(pool); relog.__setPoolForTest(pool);
    setCtx([row(75, '김옥선', '010-5384-9851', '30101824728828')]); // 내 데이터가 어디에도 없음
    const r = await wv.verifyWrittenOrders();
    assert.equal(r.lost, 1, '유령 written 감지');
    assert.ok(pool.calls.some(c => /SET sheet_row = NULL, mirror_status = 'failed'/.test(c.s)), 'failed 강등 → reconcile 재기록 경로');
    assert.ok(pool.calls.some(c => /DELETE FROM sheet_row_claims/.test(c.s)), '자기 claim 해제');
    const log = pool.calls.find(c => /INSERT INTO reviewer_event_logs/.test(c.s));
    assert.ok(log, 'critical 로그 기록');
    const pj = JSON.stringify(log.params);
    assert.ok(/order_lost/.test(pj) && /critical/.test(pj), 'event_type=order_lost, severity=critical');
    assert.ok(/구매양식이 시트에서 사라졌습니다/.test(pj), '한글 자연어 메시지');
  }

  // ═══ 5. 소실 반복 → stuck_manual(무한 재기록 루프 차단) ═══
  {
    const pool = makePool({ writtenOrders: [osRow()], mirroredAt: FRESH, priorLost: 2 });
    wv.__setPoolForTest(pool); relog.__setPoolForTest(pool);
    setCtx([row(75, '김옥선', '010-5384-9851', '30101824728828')]);
    const r = await wv.verifyWrittenOrders();
    assert.equal(r.lostManual, 1);
    assert.ok(pool.calls.some(c => /SET mirror_status = 'stuck_manual'/.test(c.s)), '수동전환');
    assert.ok(!pool.calls.some(c => /SET sheet_row = NULL, mirror_status = 'failed'/.test(c.s)), '재기록 강등 안 함');
    const log = pool.calls.find(c => /INSERT INTO reviewer_event_logs/.test(c.s));
    assert.ok(log && /order_lost_manual/.test(JSON.stringify(log.params)), '수동 필요 critical 로그');
  }

  // ═══ 6. 캡처 미첨부: 컷오프 없으면 전면 skip(소급 오탐 방지) / 있으면 warn 로그 ═══
  {
    const pool = makePool({});
    wv.__setPoolForTest(pool); relog.__setPoolForTest(pool);
    const r0 = await wv.detectMissingCaptures();
    assert.equal(r0.skipped, 'no_cutoff', '컷오프 미설정 = 감지 안 함');

    const pool2 = makePool({
      captureCutoff: '2026-07-27T00:00:00Z',
      noCaptureOrders: [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', sheetId: 'SHEET1', tabName: '탄소매트 900건', tabGid: null, recipient: '노대송', orderer: '이지유', phone8: '23562884' }],
    });
    wv.__setPoolForTest(pool2); relog.__setPoolForTest(pool2);
    const r1 = await wv.detectMissingCaptures();
    assert.equal(r1.flagged, 1);
    const log = pool2.calls.find(c => /INSERT INTO reviewer_event_logs/.test(c.s));
    assert.ok(log && /구매캡쳐를 첨부하지 않았습니다/.test(JSON.stringify(log.params)), '캡처 미첨부 한글 문장');
  }

  // ═══ 7. 로그 dedup: 미해결 중복 INSERT는 skipped(도배 방지) ═══
  {
    const pool = makePool({ logDup: true });
    relog.__setPoolForTest(pool);
    const r = await relog.logReviewerEvent({
      sheetId: 'S', tabName: 'T', eventType: 'order_lost', severity: 'critical',
      message: 'x', orderSubmissionId: '3c3729cb-77b3-49aa-b854-daf1d4007257',
    });
    assert.equal(r.ok, true); assert.equal(r.skipped, true);
  }

  // 뒷정리 — 다른 테스트에 목 누수 방지
  wv.__setPoolForTest(null); wv.__setLoadCtxForTest(null); relog.__setPoolForTest(null);
  console.log('✅ writtenVerify.test.js — 전체 통과');
}

// utils/sse 의 ping 인터벌이 이벤트루프를 잡고 있으므로 명시 종료
run().then(() => process.exit(0)).catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
