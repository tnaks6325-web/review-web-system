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

const block = serviceSrc.slice(
  serviceSrc.indexOf('async function hideWorkdeskRow'),
  serviceSrc.indexOf('// 주문이 연결된 한 행을 안전하게 취소한다.')
);

assert.match(block, /FOR UPDATE/, '삭제 대상 참여행을 잠가 동시 삭제를 직렬화한다');
assert.match(block, /INSERT INTO workdesk_participant_deletions/, '재투영 차단용 최소 삭제 이력을 남긴다');
assert.match(block, /DELETE FROM campaign_participants/, '참여행은 작업표에서 실제 삭제한다');
assert.doesNotMatch(block, /SET deleted_at=NOW/, '참여행을 논리삭제로 남기지 않는다');
assert.match(block, /DELETE FROM participation_links[\s\S]*?sheet_id=\$1 AND tab_name=\$2 AND row_index=\$3/, '삭제한 정확한 행의 신원 링크만 제거한다');
assert.match(block, /WHERE order_submission_id=\$1::uuid AND status IN \('applied','submitted'\)/, '연결된 구매양식의 참여상태만 취소한다');
assert.doesNotMatch(block, /DELETE FROM order_submissions/, '주문 원장은 감사용으로 보존한다');
assert.match(block, /mode: 'hard_deleted'/, '삭제 결과가 실제 삭제임을 호출부에 명시한다');

// 내 참여현황의 두 원천(review_index + order_submissions) 모두 삭제된 작업표 행을 제외한다.
assert.match(reviewerSrc, /FROM review_index ri[\s\S]*?NOT EXISTS \([\s\S]*?workdesk_participant_deletions wd[\s\S]*?wd\.seq=ri\.row_index/, '시트형 참여내역이 삭제 행을 다시 노출하지 않는다');
assert.match(reviewerSrc, /FROM order_submissions os[\s\S]*?os\.deleted_at IS NULL[\s\S]*?workdesk_participant_deletions wd[\s\S]*?wd\.order_submission_id=os\.id/, 'DB 주문형 참여내역도 삭제 행을 다시 노출하지 않는다');
assert.match(reviewerSrc, /ca\.status <> 'cancelled'/, '참여 신청 이력에서도 취소된 행을 제외한다');
assert.match(workdeskSrc, /작업표와 리뷰어 참여내역에서 제거/, '관리자 확인문구가 실제 삭제 범위를 안내한다');

const importSrc = fs.readFileSync(path.join(root, 'src/services/participants.service.js'), 'utf8');
assert.match(importSrc, /workdesk_participant_deletions[\s\S]*?liveIdx = idx\.filter/, '재임포트가 실제 삭제 행을 다시 만들지 않는다');

test('가상 삭제: 한 참여 행의 링크·확정 참여상태만 같은 트랜잭션에서 해제한다', async () => {
  const trackB = require('../src/services/trackB.service.js');
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT id, seq, phone8, order_submission_id/.test(sql)) {
        return { rows: [{ id: 'row-1', seq: 77, phone8: '12345678', order_submission_id: '00000000-0000-0000-0000-000000000001' }] };
      }
      if (/INSERT INTO workdesk_participant_deletions/.test(sql)) return { rowCount: 1, rows: [] };
      if (/DELETE FROM campaign_participants/.test(sql)) return { rowCount: 1, rows: [] };
      if (/DELETE FROM participation_links/.test(sql)) return { rowCount: 1, rows: [] };
      if (/UPDATE campaign_applications/.test(sql)) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] }; // BEGIN/COMMIT/ROLLBACK
    },
    release() {},
  };
  trackB.__setPoolForTest({ connect: async () => client });
  try {
    const out = await trackB.hideWorkdeskRow({ sheetId: 'sheet-a', tabName: '작업A', rowId: 'row-1', by: 'virtual-test' });
    assert.deepEqual(out, {
      ok: true, mode: 'hard_deleted', removed: 1,
      participationLinksRemoved: 1, applicationsCancelled: 1,
    });
    const links = calls.find(c => /DELETE FROM participation_links/.test(c.sql));
    const app = calls.find(c => /UPDATE campaign_applications/.test(c.sql));
    const participant = calls.find(c => /DELETE FROM campaign_participants/.test(c.sql));
    assert.deepEqual(participant.params, ['row-1', 'sheet-a', '작업A'], '작업보드 참여자 행 자체를 실제 삭제한다');
    assert.deepEqual(links.params, ['sheet-a', '작업A', 77], '다른 작업/행의 신원 링크를 삭제하지 않는다');
    assert.deepEqual(app.params, ['00000000-0000-0000-0000-000000000001'], '주문 UUID가 같은 참여신청만 취소한다');
    assert.ok(calls.some(c => /^COMMIT$/.test(c.sql)), '모든 해제가 완료된 뒤 커밋한다');
  } finally {
    trackB.__setPoolForTest(null);
  }
});

console.log('workdeskParticipantDeleteHistory.test.js: OK');
