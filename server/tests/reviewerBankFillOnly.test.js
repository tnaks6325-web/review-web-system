'use strict';
/**
 * 구매양식 제출 후 계좌 자동 저장 = blank-only (2026-08-19)
 *
 * 사고 경로: search-app.js 는 제출 성공 후 **1번 카드**의 은행/계좌/예금주를 로그인 리뷰어의
 *   마스터 계좌에 무조건 저장했다. 1번 카드가 타계정 명의면 본인 대표계좌가 타계정 계좌로 덮이고,
 *   입금 대상 추출(payment.service._loadAccounts)은 본인 건에 reviewers.bank_account 를 그대로 쓰므로
 *   **본인 리뷰비가 타계정 계좌로 송금**된다. submit.routes 의 타계정 자동보강이 "본인 공통계좌와
 *   다른 계좌일 때만" 타계정에 기록하는 것과 정면으로 어긋났다.
 *
 * ★ 고친 범위 = 그 자동 저장 한 곳(onlyIfEmpty). 내정보 화면의 계좌 "변경"은 종전 덮어쓰기 유지.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SVC = fs.readFileSync(path.resolve(__dirname, '../src/services/reviewer.service.js'), 'utf8');
const APP = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');

// ── 1) 제출 후 자동 저장 호출에 onlyIfEmpty 가 실린다 ──
const callIdx = APP.indexOf('action:        "saveBankInfo"');
assert.ok(callIdx > 0, '제출 후 계좌 자동 저장 호출이 있어야 한다');
const call = APP.slice(callIdx, callIdx + 400);
assert.ok(/onlyIfEmpty:\s*true/.test(call),
  '★ 제출 후 자동 저장은 blank-only 여야 한다 — 빼면 1번 카드가 타계정일 때 본인 대표계좌가 덮인다');

// ── 2) 내정보 화면의 계좌 저장은 그대로 덮어쓴다(범위 축소이지 기능 제거가 아니다) ──
const IDX = fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8');
const inline = IDX.slice(IDX.indexOf('async function saveBankInfoInline'), IDX.indexOf('function openIncomeInfoForm'));
assert.ok(/action:\s*"saveBankInfo"/.test(inline), '내정보 계좌 저장 호출이 있어야 한다');
assert.ok(!/onlyIfEmpty/.test(inline),
  '★ 내정보 화면에서는 계좌를 바꿀 수 있어야 한다 — onlyIfEmpty 를 붙이면 계좌 변경이 막힌다');

// ── 3) 서버: 기본값은 종전 동작(미전송 = 덮어쓰기) ──
const bank = SVC.slice(SVC.indexOf("if (action === 'saveBankInfo')"), SVC.indexOf("if (action === 'saveAddress')"));
assert.ok(/onlyIfEmpty === true \|\| String\(onlyIfEmpty\) === 'true'/.test(bank),
  '★ onlyIfEmpty 는 명시 전송일 때만 켜진다(미전송 = 종전 덮어쓰기)');
for (const col of ['bank_name', 'bank_account', 'account_holder']) {
  assert.ok(new RegExp(`${col}\\s*=\\s*CASE WHEN \\$4::bool AND COALESCE\\(${col}, ''\\)\\s*<> '' THEN ${col}`).test(bank),
    `★ ${col} 은 blank-only 분기를 가져야 한다 (한 칸만 빠지면 그 칸이 계속 덮인다)`);
}

// ── 4) PGTEST_URL 이 있으면 진짜 PG 로 3갈래 실행 ──
async function pgRun() {
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.PGTEST_URL });
  await c.connect();
  const schema = `_fillonly_${Date.now()}`;
  await c.query(`CREATE SCHEMA ${schema}`); await c.query(`SET search_path = ${schema}, public`);
  await c.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await c.query(`CREATE TABLE reviewers (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, phone TEXT,
      phone8 TEXT GENERATED ALWAYS AS (RIGHT(REGEXP_REPLACE(phone,'[^0-9]','','g'),8)) STORED,
      bank_name TEXT, bank_account TEXT, account_holder TEXT)`);

  const SQL = `UPDATE reviewers SET
         bank_name      = CASE WHEN $4::bool AND COALESCE(bank_name, '')      <> '' THEN bank_name
                               ELSE COALESCE(NULLIF($1, ''), bank_name) END,
         bank_account   = CASE WHEN $4::bool AND COALESCE(bank_account, '')   <> '' THEN bank_account
                               ELSE COALESCE(NULLIF($2, ''), bank_account) END,
         account_holder = CASE WHEN $4::bool AND COALESCE(account_holder, '') <> '' THEN account_holder
                               ELSE COALESCE(NULLIF($3, ''), account_holder) END
       WHERE phone8 = $5`;
  // 서버 구현과 문자열이 같은지(사본 드리프트 방지)
  assert.ok(SVC.includes(SQL.trim().split('\n').map(l => l.trim()).join('\n').split('\n')[1].trim()),
    '테스트가 실행하는 SQL 은 서버 구현과 같은 모양이어야 한다');
  const acct = async () => (await c.query(`SELECT bank_name, bank_account, account_holder FROM reviewers WHERE phone8='94493573'`)).rows[0];

  await c.query(`INSERT INTO reviewers(name,phone) VALUES ('김민경','01094493573')`);
  // ① 계좌가 비어 있으면 채운다
  await c.query(SQL, ['신한은행', '110290820674', '김민경', true, '94493573']);
  assert.deepEqual(await acct(), { bank_name: '신한은행', bank_account: '110290820674', account_holder: '김민경' },
    'blank-only 라도 빈 칸은 채워야 한다(원래 의도한 편의)');
  // ② 타계정 명의 주문 제출 → 덮이지 않는다 (이번 사고)
  await c.query(SQL, ['국민은행', '12345678901', '김철수', true, '94493573']);
  assert.deepEqual(await acct(), { bank_name: '신한은행', bank_account: '110290820674', account_holder: '김민경' },
    '★ 이미 등록된 본인 계좌는 제출 후 자동 저장으로 덮이지 않아야 한다');
  // ③ 내정보 화면에서의 변경은 여전히 덮어쓴다
  await c.query(SQL, ['토스뱅크', '100012345678', '김민경', false, '94493573']);
  assert.deepEqual(await acct(), { bank_name: '토스뱅크', bank_account: '100012345678', account_holder: '김민경' },
    '★ 내정보 화면의 계좌 변경은 종전대로 덮어써야 한다(무회귀)');
  // ④ 일부 칸만 비어 있으면 그 칸만 채운다
  await c.query(`UPDATE reviewers SET account_holder = '' WHERE phone8='94493573'`);
  await c.query(SQL, ['국민은행', '12345678901', '김철수', true, '94493573']);
  assert.deepEqual(await acct(), { bank_name: '토스뱅크', bank_account: '100012345678', account_holder: '김철수' },
    '칸 단위 blank-only — 빈 칸만 채우고 나머지는 보존');

  await c.query(`DROP SCHEMA ${schema} CASCADE`); await c.end();
  console.log('  ✅ 진짜 PG 실행 검증 통과 (빈칸 채움 / 덮어쓰기 차단 / 내정보 변경 무회귀 / 칸 단위)');
}

(async () => {
  if (process.env.PGTEST_URL) await pgRun();
  else console.log('  ⏭ PGTEST_URL 미설정 — 정적 검사만 수행');
  console.log('✅ reviewerBankFillOnly 회귀가드 통과');
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
