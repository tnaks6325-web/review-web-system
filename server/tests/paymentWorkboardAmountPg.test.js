'use strict';

const assert = require('assert');
const { PGlite } = require('@electric-sql/pglite');
const svc = require('../src/services/paymentWorkboardAmount.service');

(async () => {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE campaign_participants (
      id uuid PRIMARY KEY, sheet_id text NOT NULL, tab_name text NOT NULL, seq integer NOT NULL,
      row_json jsonb, order_submission_id uuid, source text, identity_key text,
      active boolean NOT NULL DEFAULT true, deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE participant_edits (
      id bigserial PRIMARY KEY, sheet_id text NOT NULL, tab_name text NOT NULL,
      anchor_type text NOT NULL, anchor_value text NOT NULL, field text NOT NULL,
      kind text NOT NULL, value_bool boolean, value_text text, reverted_at timestamptz
    );
  `);
  const ids = {
    unique: '00000000-0000-0000-0000-000000000001',
    duplicateA: '00000000-0000-0000-0000-000000000002',
    duplicateB: '00000000-0000-0000-0000-000000000003',
    identityA: '00000000-0000-0000-0000-000000000004',
    identityB: '00000000-0000-0000-0000-000000000005',
    manual: '00000000-0000-0000-0000-000000000006',
    orderUnique: '10000000-0000-0000-0000-000000000001',
    orderDuplicate: '10000000-0000-0000-0000-000000000002',
  };
  await pg.query(`INSERT INTO campaign_participants
    (id,sheet_id,tab_name,seq,row_json,order_submission_id,source,identity_key) VALUES
    ($1,'S','T',1,'{"결제금액":"100"}'::jsonb,$7,'order','u'),
    ($2,'S','T',2,'{"결제금액":"200"}'::jsonb,$8,'order','d'),
    ($3,'S','T',3,'{"결제금액":"300"}'::jsonb,$8,'order','d'),
    ($4,'S','T',4,'{"결제금액":"400"}'::jsonb,NULL,'sheet','same'),
    ($5,'S','T',5,'{"결제금액":"500"}'::jsonb,NULL,'sheet','same'),
    ($6,'S','T',6,'{"결제금액":"600"}'::jsonb,NULL,'manual',NULL)`,
    [ids.unique, ids.duplicateA, ids.duplicateB, ids.identityA, ids.identityB, ids.manual,
      ids.orderUnique, ids.orderDuplicate]);
  await pg.query(`INSERT INTO participant_edits
    (sheet_id,tab_name,anchor_type,anchor_value,field,kind,value_text) VALUES
    ('S','T','order',$1,'col:결제금액','text','110'),
    ('S','T','order',$2,'col:결제금액','text','999'),
    ('S','T','identity','same','col:결제금액','text','999'),
    ('S','T','manual',$3,'col:결제금액','text','610')`,
    [ids.orderUnique, ids.orderDuplicate, ids.manual]);

  const db = { query: (text, params) => pg.query(text, params) };
  const rows = [1, 2, 4, 6].map(rowIndex => ({ sheetId: 'S', tabName: 'T', rowIndex }));
  const result = await svc.loadWorkboardAmounts(db, rows);
  assert.equal(result.get('S\tT\t1').amount, 110, '유일한 주문 앵커 편집은 반영해야 한다');
  assert.equal(result.get('S\tT\t2').amount, 200, '중복 주문 앵커 편집은 다른 행에 번지면 안 된다');
  assert.equal(result.get('S\tT\t4').amount, 400, '중복 신원 앵커 편집은 다른 행에 번지면 안 된다');
  assert.equal(result.get('S\tT\t6').amount, 610, '수동 행 편집은 기존대로 반영해야 한다');
  await pg.close();
  console.log('payment workboard amount PostgreSQL tests passed');
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
