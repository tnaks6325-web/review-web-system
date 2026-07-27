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

// jobLock 은 전용 PG 커넥션으로 advisory lock 을 잡으므로 단위테스트에선 통과시킨다(락 자체는 별도 가드).
{
  const p = require.resolve('../src/utils/jobLock');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { withJobLock: async (_k, fn) => fn() } };
}

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

  // ═══ 7a. [리뷰 치명#1] 강한 키 없는 주문 = 판정 불가 → 절대 소실로 오판하지 않는다 ═══
  //   (주문번호 6자리 미만 + 연락처 8자리 미만. 과거 구현은 이런 주문을 "무조건 소실"로 확정해
  //    정상 주문을 failed 강등 → 시트 중복 행 + critical 오경보를 만들었다.)
  {
    const cols = wv._identityCols(HEADERS);
    assert.equal(wv._canVerify(osRow(), cols), true, '강한 키 있으면 검증 가능');
    assert.equal(wv._canVerify(osRow({ phone: '', orderNum: '123' }), cols), false, '강한 키 없으면 검증 불가');

    const pool = makePool({ writtenOrders: [osRow({ phone: '', orderNum: '123' })], mirroredAt: FRESH });
    wv.__setPoolForTest(pool); relog.__setPoolForTest(pool);
    setCtx([row(75, '김옥선', '010-5384-9851', '30101824728828')]);
    const r = await wv.verifyWrittenOrders();
    assert.equal(r.unverifiable, 1, '판정 불가로 분류');
    assert.equal(r.lost, 0, '소실 판정 금지(오탐 차단)');
    assert.ok(!pool.calls.some(c => /mirror_status = 'failed'/.test(c.s)), '강등 금지');
    assert.ok(!pool.calls.some(c => /INSERT INTO reviewer_event_logs/.test(c.s)), '오경보 금지');
  }

  // ═══ 7b. 강한 키 충돌 없음 + 수취인 일치 = 내 행(사람이 일부 칸을 지운 상태 → 오탐 방지) ═══
  {
    const cols = wv._identityCols(HEADERS);
    const os = osRow();
    assert.equal(wv._rowVerdict(row(75, '이지유', '', '').cells, cols, os), 'mine', '수취인만 남은 내 행 = mine(강등 금지)');
    assert.equal(wv._rowVerdict(row(75, '김옥선', '010-5384-9851', '').cells, cols, os), 'other', '전화 충돌 = 타인 행');
  }

  // ═══ 7c. 스냅샷 커버리지 밖(미러 최대행보다 아래) → 보류(빈 결과를 소실로 오판 금지) ═══
  {
    const pool = makePool({ writtenOrders: [osRow({ sheetRow: 268 })], mirroredAt: FRESH });
    wv.__setPoolForTest(pool); relog.__setPoolForTest(pool);
    setCtx([row(75, '김옥선', '010-5384-9851', '30101824728828')]); // 미러 최대행 75
    const r = await wv.verifyWrittenOrders();
    assert.equal(r.skippedOutOfRange, 1);
    assert.equal(r.lost, 0, '미러가 못 본 행은 소실 아님');
  }

  // ═══ 7d. [리뷰 중요#4] 관리자 편집이 미러보다 최신 → 판정 보류(시트는 아직 구값) ═══
  {
    const pool = makePool({ writtenOrders: [osRow({ updatedAt: new Date(Date.now() + 60 * 1000) })], mirroredAt: FRESH });
    wv.__setPoolForTest(pool); relog.__setPoolForTest(pool);
    setCtx([row(75, '김옥선', '010-5384-9851', '30101824728828')]);
    const r = await wv.verifyWrittenOrders();
    assert.equal(r.skippedEdited, 1);
    assert.equal(r.lost, 0, '편집 반영 대기 중에는 소실 판정 금지');
  }

  // ═══ 7e. [리뷰 중요#2·#5] 쿼리 구조 고정: 인플라이트 큐 배제 + 검증 회전 정렬 ═══
  {
    const pool = makePool({ writtenOrders: [], mirroredAt: FRESH });
    wv.__setPoolForTest(pool); relog.__setPoolForTest(pool);
    await wv.verifyWrittenOrders();
    const sel = pool.calls.find(c => /FROM order_submissions os WHERE os\.mirror_status = 'written'/.test(c.s));
    assert.ok(sel, '대상 조회 실행');
    assert.ok(/NOT EXISTS \( SELECT 1 FROM sync_queue/.test(sel.s), '인플라이트(order_append/update) 주문 배제');
    assert.ok(/ORDER BY os\.row_verified_at ASC NULLS FIRST/.test(sel.s), '미검증 우선 회전(커버리지 기아 방지)');
  }

  // ═══ 7f. [리뷰 중요#6] staff 스코프: 담당 탭 0이면 로그 미개방 ═══
  {
    const pool = makePool({});
    relog.__setPoolForTest(pool);
    assert.deepEqual(await relog.listReviewerEvents({ scopeTabs: [] }), [], '담당 탭 0 = 빈 목록(전역 열람 차단)');
    assert.deepEqual(await relog.unresolvedCounts([]), { total: 0, critical: 0 });
    await relog.listReviewerEvents({ scopeTabs: [{ sheetId: 'S1', tabName: 'T1' }] });
    const q = pool.calls.find(c => /FROM reviewer_event_logs/.test(c.s));
    assert.ok(q && /sheet_id = \$\d+ AND tab_name = \$\d+/.test(q.s), '스코프 탭 조건이 SQL에 적용');
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

  // ═══ 8. [취소 처리] 1클릭 — 시트에서 지운 게 '의도된 취소'였을 때 재기록을 멈춘다 ═══
  {
    const OSID = '3c3729cb-77b3-49aa-b854-daf1d4007257';
    function cancelPool(scn = {}) {
      const calls = [];
      return {
        calls,
        async query(sql, params) {
          const s = String(sql).replace(/\s+/g, ' ').trim();
          calls.push({ s, params });
          if (/SELECT id, event_type, order_submission_id FROM reviewer_event_logs/.test(s)) {
            return { rows: scn.log ? [scn.log] : [] };
          }
          if (/UPDATE order_submissions SET deleted_at = NOW\(\)/.test(s)) {
            return { rows: scn.alreadyCanceled ? [] : [{ sheet_row: scn.sheetRow ?? null, mirror_status: 'failed' }] };
          }
          return { rows: [], rowCount: 0 };
        },
      };
    }

    // 8a. 소실 알림 → 주문 소프트삭제(=reconcile·사후검증 대상에서 제외) + 알림 자동 해결
    const p1 = cancelPool({ log: { id: 9, event_type: 'order_lost', order_submission_id: OSID }, sheetRow: null });
    relog.__setPoolForTest(p1);
    const r1 = await relog.cancelOrderFromEvent({ id: 9, by: '만두' });
    assert.equal(r1.ok, true); assert.equal(r1.canceled, true);
    assert.ok(p1.calls.some(c => /UPDATE order_submissions SET deleted_at = NOW\(\)/.test(c.s)),
      'deleted_at 설정 — reconcile/사후검증 둘 다 deleted_at IS NULL 필터라 되살아남이 멈춘다');
    assert.ok(p1.calls.some(c => /SET mirror_status = 'canceled'/.test(c.s)), '시트행 없으면 DB 상태만 확정');
    assert.ok(p1.calls.some(c => /resolved_by = \$2 WHERE id = \$1/.test(c.s)), '누른 알림 해결');
    assert.ok(p1.calls.some(c => /WHERE order_submission_id = \$1 AND resolved_at IS NULL/.test(c.s)),
      '같은 주문의 다른 미해결 알림도 함께 정리');

    // 8b. 취소 대상이 아닌 알림(캡처 미첨부)은 거부 — 주문이 사라지는 오조작 차단
    const p2 = cancelPool({ log: { id: 10, event_type: 'order_no_capture', order_submission_id: OSID } });
    relog.__setPoolForTest(p2);
    const r2 = await relog.cancelOrderFromEvent({ id: 10, by: '만두' });
    assert.equal(r2.ok, false, '캡처 미첨부 알림으로는 주문취소 불가');
    assert.ok(!p2.calls.some(c => /deleted_at = NOW\(\)/.test(c.s)), '취소 UPDATE 미실행');

    // 8c. 주문 연결이 없는 알림도 거부
    const p3 = cancelPool({ log: { id: 11, event_type: 'order_lost', order_submission_id: null } });
    relog.__setPoolForTest(p3);
    assert.equal((await relog.cancelOrderFromEvent({ id: 11 })).ok, false);

    // 8d. 이미 취소된 주문 → 멱등(중복 취소 아님)
    const p4 = cancelPool({ log: { id: 12, event_type: 'order_lost_manual', order_submission_id: OSID }, alreadyCanceled: true });
    relog.__setPoolForTest(p4);
    const r4 = await relog.cancelOrderFromEvent({ id: 12 });
    assert.equal(r4.ok, true); assert.equal(r4.alreadyCanceled, true);
  }

  // 뒷정리 — 다른 테스트에 목 누수 방지
  wv.__setPoolForTest(null); wv.__setLoadCtxForTest(null); relog.__setPoolForTest(null);
  console.log('✅ writtenVerify.test.js — 전체 통과');
}

// utils/sse 의 ping 인터벌이 이벤트루프를 잡고 있으므로 명시 종료
run().then(() => process.exit(0)).catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
