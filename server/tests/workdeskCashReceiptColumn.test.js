'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const trackB = require('../src/services/trackB.service');

function makePool() {
  const queries = [];
  return {
    queries,
    async query(sql) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      queries.push(text);
      if (/SELECT tc\.campaign_name AS "campaignName"/.test(text)) {
        return { rows: [{
          campaignName: '가상 현영 작업', displayName: '가상 현영 작업', incomeType: '사업자현영',
          captureSlots: [{ key: 'review', label: '리뷰' }, { key: 'receipt', label: '현금영수증' }],
          sourceOfTruth: 'db', sheetless: false,
        }] };
      }
      if (/WITH requested AS \(.*tc\.capture_slots AS "captureSlots"/.test(text)) {
        return { rows: [{
          sheetId: 'S', tabName: 'T', incomeType: '사업자현영',
          captureSlots: [{ key: 'review', label: '리뷰' }, { key: 'receipt', label: '현금영수증' }],
        }] };
      }
      if (/picked\.cash_receipt_required/.test(text)) {
        return { rows: [{ sheet_id: 'S', tab_name: 'T', cash_receipt_required: false }] };
      }
      if (/FROM review_submissions rs/.test(text)) {
        return { rows: [{ sheetId: 'S', tabName: 'T', rowIndex: 146 }] };
      }
      if (/cp\.reviewer_name AS name.*FROM campaign_participants cp/.test(text)) {
        return { rows: [
          { id: 'r145', seq: 145, name: '리뷰어A', recipient: '수취인A', phone8: '11112222', submitted: true, paid: false, source: 'import', row_json: { 번호: 1, 리뷰제출: '9/14' }, submit_col: '리뷰제출' },
          { id: 'r146', seq: 146, name: '리뷰어B', recipient: '수취인B', phone8: '33334444', submitted: true, paid: false, source: 'import', row_json: { 번호: 2, 리뷰제출: '9/14' }, submit_col: '리뷰제출' },
        ] };
      }
      if (/SELECT detected_headers FROM raw_sheet_tabs/.test(text)) {
        return { rows: [{ detected_headers: ['번호', '리뷰제출', '입금'] }] };
      }
      if (/FROM participant_edits/.test(text)) return { rows: [] };
      if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(text)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
  };
}

(async () => {
  const internalPool = makePool();
  trackB.__setPoolForTest(internalPool);
  const internal = await trackB.workdeskTab({
    sheetId: 'S', tabName: 'T', role: 'master', allowAllWorkdesk: true,
  });
  assert.deepStrictEqual(internal.cashReceiptColumn, { key: '__cashReceiptStatus', label: '현영' },
    '내부 작업보드에 현영 가상 컬럼 선언이 있어야 한다');
  assert.strictEqual(internal.roster.find(row => row.seq === 145).cashReceiptStatus, 'missing',
    '영수증이 없는 가상 행은 미제출이어야 한다');
  assert.strictEqual(internal.roster.find(row => row.seq === 146).cashReceiptStatus, 'submitted',
    '영수증 원장 행은 제출완료여야 한다');
  assert.ok(internalPool.queries.some(sql => /FROM review_submissions rs/.test(sql)),
    '내부 작업보드는 실제 현금영수증 제출 원장을 확인해야 한다');

  const advertiserPool = makePool();
  trackB.__setPoolForTest(advertiserPool);
  const advertiser = await trackB.workdeskTab({
    sheetId: 'S', tabName: 'T', role: 'advertiser', advertiserId: 'ADV', allowAllWorkdesk: true,
  });
  assert.strictEqual(advertiser.cashReceiptColumn, undefined,
    '업체용 응답에는 현영 컬럼 선언이 없어야 한다');
  assert.ok(advertiser.roster.every(row => row.cashReceiptStatus === undefined),
    '업체용 응답 행에는 현영 상태가 없어야 한다');
  assert.ok(!advertiserPool.queries.some(sql => /FROM review_submissions rs/.test(sql)),
    '업체 권한에서는 현금영수증 제출 원장 조회도 실행하면 안 된다');
  assert.deepStrictEqual(trackB.__advertiserColumnsForTest(['번호', '현영', '현금영수증', '리뷰제출']),
    ['번호', '리뷰제출'], '업체 컬럼 화이트리스트가 동명 시트 열도 제거해야 한다');

  const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
  assert.match(html, /STATE\.role!=='advertiser'&&wd&&wd\.cashReceiptColumn/,
    '화면에서도 업체 역할은 현영 컬럼 생성 조건에서 제외해야 한다');
  assert.match(html, /submitted:'제출완료',missing:'미제출',not_applicable:'해당없음'/,
    '현영 상태의 사용자 표기가 고정돼야 한다');
  assert.match(html, /function _rvReceiptSubmitted\(r\)[\s\S]*cashReceiptStatus\|\|''\)==='submitted'/,
    '현영 집계·필터·체크는 파일 유무가 아니라 지급 게이트 상태를 써야 한다');
  assert.match(html, /function _rvPopHas\(x,kind\)\{[\s\S]{0,160}kind==='receipt' \? _rvReceiptSubmitted\(x&&x\.r\)/,
    '현영 팝업 집계·필터·체크도 같은 상태 함수를 써야 한다');

  console.log('workdesk cash receipt column virtual test: 12 passed');
})().catch(err => { console.error(err); process.exit(1); });
