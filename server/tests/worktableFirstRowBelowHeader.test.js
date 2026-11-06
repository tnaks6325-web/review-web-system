'use strict';
// 빈 작업표에 첫 줄을 만들 때 1번 줄(열 이름 줄)을 피해야 한다(결정 098: 빈 탭 헤더 = 1행).
// 1번 줄에 주문이 들어가면 장부(buildValues)가 그 줄을 열 이름 줄로 잡아 검색 명단에서 빠지고,
// 리뷰어가 리뷰를 낼 수 없다(2026-11-06 동시진행 로컬 끝까지 시험에서 실측).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const participants = require('../src/services/participants.service');
const ledger = require('../src/services/sheetlessLedger.service');

async function db() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE campaign_participants (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, sheet_id text, tab_gid text, tab_name text,
    campaign_name text, seq int, row_json jsonb, workboard_id uuid, source text, updated_by text, updated_at timestamptz, deleted_at timestamptz,
    active boolean DEFAULT TRUE, UNIQUE (sheet_id, tab_name, seq))`);
  return { query: (s, p) => pg.query(s, p), exec: s => pg.exec(s) };
}

test('confirmed-order append on an empty worktable starts below the header row and stays in the search ledger', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/sheetlessOrder.service.js'), 'utf8');
  const call = src.slice(src.indexOf("require('./participants.service').appendSlot(client, {"), src.indexOf("by: 'sheetless-order-append'") + 60);
  const minSeq = Number((call.match(/minSeq:\s*(\d+)/) || [])[1] || 1);
  const client = await db();
  const row = await participants.appendSlot(client, { sheetId: 's', tabName: 't', rowJson: { 이름: '가' }, minSeq });
  assert.equal(row.seq, 2, 'first appended order must not land on the header row');
  const built = ledger.buildValues({ headers: ['이름'], rows: [row] });
  assert.equal(built.headerRow, 1);
  assert.equal(built.rowIndexOf.get(2), 2, 'the order row is visible to search');
  const next = await participants.appendSlot(client, { sheetId: 's', tabName: 't', rowJson: {}, minSeq });
  assert.equal(next.seq, 3, 'non-empty tabs keep MAX(seq)+1');
});

test('linked recruit quota growth on an empty worktable also starts at row 2', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/linkedRecruitQuota.service.js'), 'utf8');
  const i = src.indexOf('const maxSeq =');
  const line = src.slice(i, src.indexOf('\n', i));
  const maxSeqOf = raw => Function('seqRows', line.replace('const maxSeq =', 'return'))([{ max_seq: raw }]);
  assert.equal(maxSeqOf(0) + 1, 2, 'empty tab: first prepared slot is row 2');
  assert.equal(maxSeqOf(7) + 1, 8, 'existing rows: unchanged');
});
