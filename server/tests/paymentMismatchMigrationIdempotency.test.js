'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(__dirname, '../migrations/122_payment_mismatch_reconciliation_upload_scope.sql'), 'utf8');
const replacement = 'payment_account_mismatch_reconciliations_upload_id_result_seq_key';

assert.match(sql, new RegExp(`DROP CONSTRAINT IF EXISTS ${replacement}`),
  '매 부팅마다 재실행되는 마이그레이션은 교체할 제약조건도 먼저 제거해야 한다');
assert.match(sql, new RegExp(`ADD CONSTRAINT ${replacement} UNIQUE \\(upload_id, result_seq\\)`),
  '결과 파일별 행 번호 중복 방지 제약은 유지해야 한다');
console.log('payment mismatch migration idempotency tests passed');
