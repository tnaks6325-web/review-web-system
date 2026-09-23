'use strict';

// 작업보드 참여자 행 삭제는 화면만 숨기는 기능이 아니다.
// 같은 참여의 리뷰어 내역까지 빠져야 하며, 다른 행/다른 작업을 건드리면 안 된다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const serviceSrc = fs.readFileSync(path.join(root, 'src/services/trackB.service.js'), 'utf8');
const reviewerSrc = fs.readFileSync(path.join(root, 'src/routes/reviewer.routes.js'), 'utf8');
const workdeskSrc = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');

// 트랜잭션 본문(_hideParticipantInTx)과 그 진입점(hideWorkdeskRow)을 함께 본다.
// 본문은 주문 취소와 한 트랜잭션으로 돌 수 있도록 client 를 주입받는 형태로 분리됐다.
const block = serviceSrc.slice(
  serviceSrc.indexOf('class HideRowError'),
  serviceSrc.indexOf('// 주문이 연결된 한 행을 안전하게 취소한다.')
);

assert.match(block, /FOR UPDATE/, '삭제 대상 참여행을 잠가 동시 삭제를 직렬화한다');
assert.match(block, /INSERT INTO workdesk_participant_deletions/, '재투영 차단용 최소 삭제 이력을 남긴다');
assert.match(block, /DELETE FROM campaign_participants/, '참여행은 작업표에서 실제 삭제한다');
assert.doesNotMatch(block, /SET deleted_at=NOW/, '참여행을 논리삭제로 남기지 않는다');
assert.match(block, /planned_count=planned_count\+1/, '행 삭제가 날짜별 모집 총량을 줄이지 않고 마지막 계획에 1건을 보충한다');
assert.match(block, /INSERT INTO campaign_participants[\s\S]*?'worktable'/, '삭제한 자리 대신 마지막 진행일의 빈 작업표 슬롯을 실제 생성한다');
assert.match(block, /participant_delete_replenish/, '총량 보충은 모집계획 이력에도 남긴다');
assert.match(block, /ca\.campaign_id=rc\.id AND ca\.order_submission_id=\$3::uuid/, '여러 공고가 같은 작업표를 써도 삭제 행의 주문이 연결된 공고만 고른다');
assert.match(block, /DELETE FROM participation_links[\s\S]*?sheet_id=\$1 AND tab_name=\$2 AND row_index=\$3/, '삭제한 정확한 행의 신원 링크만 제거한다');
assert.match(block, /WHERE order_submission_id=\$1::uuid AND status IN \('applied','submitted'\)/, '연결된 구매양식의 참여상태만 취소한다');
assert.doesNotMatch(block, /DELETE FROM order_submissions/, '주문 원장은 감사용으로 보존한다');
assert.match(block, /mode: 'hard_deleted'/, '삭제 결과가 실제 삭제임을 호출부에 명시한다');

// ★★ 보충 슬롯의 다음 번호는 표 전체(소프트삭제·비활성 줄 포함)에서 골라야 한다.
//   `uq_participants_seq` 는 부분 인덱스가 아니라 지워진 줄의 번호도 영구히 점유하므로,
//   여기서 `deleted_at IS NULL`/`active=TRUE` 로 좁히면 예전에 소프트삭제된 더 큰 번호와
//   충돌해 23505 로 행 삭제 전체가 롤백된다(2026-08-24 실사고).
{
  const replBlock = block.slice(block.indexOf('let replacement = null;'), block.indexOf('if (!replacement) throw'));
  assert.notEqual(replBlock.indexOf('let replacement = null;'), -1, '보충 슬롯 재시도 블록을 찾을 수 없습니다');
  assert.match(replBlock, /COALESCE\(MAX\(seq\) FILTER \(WHERE seq < \$\{participants\.MANUAL_SEQ_BASE\}\), 0\) \+ 1/,
    '다음 번호는 실제 행 번호 대역 안에서 표 전체 최댓값+1 이어야 한다(appendSlot 과 같은 계산)');
  assert.match(replBlock, /ON CONFLICT \(sheet_id, tab_name, seq\) DO NOTHING/,
    '번호 충돌 시 예외를 던지지 않고 0행으로 받아 재시도해야 한다');
  assert.doesNotMatch(replBlock, /deleted_at IS NULL/,
    '다음 번호 계산에서 소프트삭제된 줄을 빼면 안 된다(그 줄의 번호도 여전히 점유돼 있다)');
  assert.doesNotMatch(replBlock, /active\s*=\s*TRUE/,
    '다음 번호 계산에서 비활성 줄을 빼면 안 된다(그 줄의 번호도 여전히 점유돼 있다)');
}

// 내 참여현황의 두 원천(review_index + order_submissions) 모두 삭제된 작업표 행을 제외한다.
assert.match(reviewerSrc, /FROM review_index ri[\s\S]*?NOT EXISTS \([\s\S]*?workdesk_participant_deletions wd[\s\S]*?wd\.seq=ri\.row_index/, '시트형 참여내역이 삭제 행을 다시 노출하지 않는다');
assert.match(reviewerSrc, /FROM order_submissions os[\s\S]*?os\.deleted_at IS NULL[\s\S]*?workdesk_participant_deletions wd[\s\S]*?wd\.order_submission_id=os\.id/, 'DB 주문형 참여내역도 삭제 행을 다시 노출하지 않는다');
assert.match(reviewerSrc, /ca\.status <> 'cancelled'/, '참여 신청 이력에서도 취소된 행을 제외한다');
assert.match(workdeskSrc, /마지막 진행일에 미진행 1건이 보충/, '관리자 확인문구가 총량 보충을 안내한다');

const importSrc = fs.readFileSync(path.join(root, 'src/services/participants.service.js'), 'utf8');
assert.match(importSrc, /workdesk_participant_deletions[\s\S]*?liveIdx = idx\.filter/, '재임포트가 실제 삭제 행을 다시 만들지 않는다');

test('가상 삭제: 참여기록을 실제 삭제해도 마지막 진행일에 빈 슬롯을 보충해 총량을 유지한다', async () => {
  const trackB = require('../src/services/trackB.service.js');
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT id, seq, phone8, row_json, order_submission_id/.test(sql)) {
        return { rows: [{ id: 'row-1', seq: 77, phone8: '12345678', row_json: { '구매일자': '8/18 (화)' }, order_submission_id: '00000000-0000-0000-0000-000000000001' }] };
      }
      // 무시트 게이트가 공고 조회 SQL 밖 명시 검사로 빠졌다(공고 없이도 삭제 가능해지면서).
      if (/COALESCE\(sheetless,FALSE\) AS sheetless/.test(sql)) return { rows: [{ sheetless: true }] };
      if (/FROM recruit_campaigns rc/.test(sql)) return { rows: [{ campaign_id: 'camp-1', is_open: true, is_linked: true }] };
      if (/FROM campaign_daily_plans/.test(sql) && /plan_date=\$2::date/.test(sql)) return { rows: [{ date: '2026-08-18', planned_count: 30 }] };
      if (/FROM campaign_daily_plans/.test(sql)) return { rows: [{ date: '2026-08-21', planned_count: 10 }] };
      if (/SELECT seq, tab_gid, row_json/.test(sql)) return { rows: [
        { tab_gid: 'gid-1', seq: 77, row_json: { '구매일자': '8/18 (화)' } },
        { tab_gid: 'gid-1', seq: 100, row_json: { '구매일자': '8/21 (금)' } },
      ] };
      if (/INSERT INTO workdesk_participant_deletions/.test(sql)) return { rowCount: 1, rows: [] };
      if (/DELETE FROM campaign_participants/.test(sql)) return { rowCount: 1, rows: [] };
      if (/DELETE FROM participation_links/.test(sql)) return { rowCount: 1, rows: [] };
      if (/UPDATE campaign_applications/.test(sql)) return { rowCount: 1, rows: [] };
      if (/INSERT INTO campaign_participants/.test(sql)) return { rowCount: 1, rows: [{ id: 'blank-101', seq: 101 }] };
      if (/UPDATE campaign_daily_plans/.test(sql)) return { rowCount: 1, rows: [] };
      if (/INSERT INTO campaign_plan_events/.test(sql)) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] }; // BEGIN/COMMIT/ROLLBACK
    },
    release() {},
  };
  // 이 시나리오는 "살아 있는 구매양식이 없는 행"이다(진입점의 선조회가 빈 결과).
  // 구매기록이 붙은 행이 주문 취소와 한 트랜잭션으로 지워지는 경로는
  // workdeskRowDeleteOrderCancel.test.js 가 따로 실행해 고정한다.
  trackB.__setPoolForTest({ connect: async () => client, query: async () => ({ rows: [] }) });
  // 삭제 후 장부 재생성 호출 자체도 검증하되, 단위 테스트에서는 외부 DB를 열지 않는다.
  let ledgerArgs = null;
  trackB.__setLedgerRebuildForTest(async args => { ledgerArgs = args; return { ok: true, indexRows: 99 }; });
  try {
    const out = await trackB.hideWorkdeskRow({ sheetId: 'sheet-a', tabName: '작업A', rowId: 'row-1', by: 'virtual-test' });
    assert.equal(out.ok, true);
    assert.equal(out.mode, 'hard_deleted');
    assert.equal(out.removed, 1);
    assert.equal(out.participationLinksRemoved, 1);
    assert.equal(out.applicationsCancelled, 1);
    assert.equal(out.replenished, 1);
    assert.equal(out.finalPlanDate, '2026-08-21');
    assert.equal(out.replacementSeq, 101);
    const links = calls.find(c => /DELETE FROM participation_links/.test(c.sql));
    const app = calls.find(c => /UPDATE campaign_applications/.test(c.sql));
    const participant = calls.find(c => /DELETE FROM campaign_participants/.test(c.sql));
    assert.deepEqual(participant.params, ['row-1', 'sheet-a', '작업A'], '작업보드 참여자 행 자체를 실제 삭제한다');
    assert.deepEqual(links.params, ['sheet-a', '작업A', 77], '다른 작업/행의 신원 링크를 삭제하지 않는다');
    assert.deepEqual(app.params, ['00000000-0000-0000-0000-000000000001'], '주문 UUID가 같은 참여신청만 취소한다');
    const replacement = calls.find(c => /INSERT INTO campaign_participants/.test(c.sql));
    // ★ 다음 번호(101)는 더 이상 JS 가 계산해 넘기는 값이 아니라 이 쿼리 자신이
    //   `SELECT COALESCE(MAX(seq)...)+1 FROM campaign_participants ...` 로 계산한다 —
    //   그래서 params 에는 더 이상 seq 정수가 없다(sheetId, tabGid, tabName, start_date, row_json, by).
    assert.deepEqual(replacement.params.slice(0, 4), ['sheet-a', 'gid-1', '작업A', '8/21 (금)'], '빈 슬롯은 마지막 진행일의 새 작업표 행으로 보충한다');
    const plan = calls.find(c => /UPDATE campaign_daily_plans/.test(c.sql));
    assert.deepEqual(plan.params.slice(0, 2), ['camp-1', '2026-08-21'], '마지막 날짜의 계획만 1건 늘린다');
    const sourcePlan = calls.find(c => /INSERT INTO campaign_daily_plans/.test(c.sql));
    assert.deepEqual(sourcePlan.params.slice(0, 3), ['camp-1', '2026-08-18', 29], '삭제된 날짜는 1건 줄여 계획 총량이 증가하지 않는다');
    const scope = calls.find(c => /FROM recruit_campaigns rc/.test(c.sql));
    assert.deepEqual(scope.params, ['sheet-a', '작업A', '00000000-0000-0000-0000-000000000001'], '계획 이동 대상은 삭제한 행의 주문으로 연결된 공고로 한정한다');
    assert.deepEqual(ledgerArgs, { sheetId: 'sheet-a', tabName: '작업A', by: 'participant-delete:virtual-test' }, '삭제 뒤 작업표 장부도 다시 만든다');
    assert.ok(calls.some(c => /^COMMIT$/.test(c.sql)), '모든 해제가 완료된 뒤 커밋한다');
  } finally {
    trackB.__setPoolForTest(null);
    trackB.__setLedgerRebuildForTest(null);
  }
});

console.log('workdeskParticipantDeleteHistory.test.js: OK');
