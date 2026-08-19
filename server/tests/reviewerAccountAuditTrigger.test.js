'use strict';
/**
 * 리뷰어 계좌 감사 트리거 회귀가드 (2026-08-19 사고)
 *
 * 사고: migration 123 이 PL/pgSQL 변수 `phone8` 과 서브쿼리 컬럼 별칭 `phone8` 을 겹쳐
 *       reviewers UPDATE 가 전부 42702(ambiguous)로 죽었다 →
 *       리뷰어 계좌 등록·타계정 저장·구매양식 제출 중 계좌 보강·관리자 계좌 보완 전면 실패.
 *
 * ★★ 트리거 함수 본문은 CREATE 시점에 파싱되지 않는다 — 마이그레이션은 "성공"으로 기록되고
 *    실행 시점에만 터진다. 그래서 정적 검사만으로는 부족하고, PGTEST_URL 이 있으면
 *    진짜 PG 로 UPDATE 를 돌려 감사 행이 실제로 쌓이는지까지 확인한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MIG_DIR = path.resolve(__dirname, '../migrations');
const FN = 'audit_reviewer_account_change';

// ── 1) 이 함수를 정의하는 마지막(=운영에 최종 적용되는) 마이그레이션을 찾는다 ──
const defFiles = fs.readdirSync(MIG_DIR)
  .filter(f => f.endsWith('.sql'))
  .filter(f => fs.readFileSync(path.join(MIG_DIR, f), 'utf8').includes(`FUNCTION ${FN}()`))
  .sort();
assert.ok(defFiles.length >= 1, `${FN} 을 정의하는 마이그레이션이 있어야 한다`);
const latestFile = defFiles[defFiles.length - 1];
const latestSql = fs.readFileSync(path.join(MIG_DIR, latestFile), 'utf8');

// ── 2) 선언 변수명이 쿼리 별칭(AS ...)과 겹치면 42702 — 사고 그 자체를 고정 ──
const body = latestSql.slice(latestSql.indexOf(`FUNCTION ${FN}()`));
const declare = body.slice(body.indexOf('DECLARE') + 7, body.indexOf('BEGIN'));
const declaredVars = new Set(
  declare.split(/[;\n]/)
    .map(line => (line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+[A-Za-z]/) || [])[1])
    .filter(Boolean)
    .map(v => v.toLowerCase())
);
assert.ok(declaredVars.size >= 5, '선언 변수 파싱이 되어야 한다 (가드가 무력화되지 않도록)');

const aliases = new Set();
let m;
const aliasRe = /\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
while ((m = aliasRe.exec(body))) aliases.add(m[1].toLowerCase());
// 테이블 별칭(x(item,ordinal) 같은 컬럼 정의 목록)도 함께 본다
const colListRe = /\bAS\s+[a-zA-Z_][a-zA-Z0-9_]*\(([^)]*)\)/gi;
while ((m = colListRe.exec(body))) m[1].split(',').forEach(c => aliases.add(c.trim().toLowerCase()));

const collide = [...declaredVars].filter(v => aliases.has(v));
assert.deepEqual(collide, [],
  `★ PL/pgSQL 변수와 쿼리 별칭 이름이 겹치면 실행 시점 42702 로 reviewers UPDATE 가 전부 죽는다 `
  + `(${latestFile}: ${collide.join(', ')}) — 변수/별칭 중 하나의 이름을 바꿀 것`);

// 사고 당시의 정확한 형태가 되살아나지 않게 못박는다
assert.ok(!/AS\s+phone8\b/i.test(body),
  '★ 서브쿼리 별칭을 다시 phone8 로 두지 말 것 — 함수가 phone8 변수를 선언하고 있어 ambiguous 가 재현된다');

// ── 3) 트리거 결속(어느 컬럼 UPDATE 에 붙는가)이 유지되는지 ──
assert.ok(/AFTER UPDATE OF bank_name, bank_account, account_holder, sub_accounts ON reviewers/.test(latestSql),
  '감사 트리거는 계좌 4칸 UPDATE 에 붙어 있어야 한다');

// ── 4) PGTEST_URL 이 있으면 진짜 PG 로 실행 검증 ──
async function pgRun() {
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.PGTEST_URL });
  await c.connect();
  const schema = `_acct_audit_${Date.now()}`;
  await c.query(`CREATE SCHEMA ${schema}`);
  await c.query(`SET search_path = ${schema}, public`);
  await c.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await c.query(`CREATE TABLE reviewers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, phone TEXT NOT NULL,
      phone8 TEXT GENERATED ALWAYS AS (RIGHT(REGEXP_REPLACE(phone,'[^0-9]','','g'),8)) STORED,
      sub_accounts JSONB DEFAULT '[]', bank_name TEXT, bank_account TEXT, account_holder TEXT)`);
  await c.query(`CREATE TABLE reviewer_account_change_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reviewer_id UUID NOT NULL REFERENCES reviewers(id) ON DELETE RESTRICT,
      sub_phone8 TEXT,
      before_bank_name TEXT NOT NULL DEFAULT '', before_account_tail TEXT NOT NULL DEFAULT '',
      before_fingerprint TEXT NOT NULL DEFAULT '', after_bank_name TEXT NOT NULL DEFAULT '',
      after_account_tail TEXT NOT NULL DEFAULT '', after_fingerprint TEXT NOT NULL DEFAULT '',
      changed_by TEXT NOT NULL DEFAULT '', changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  // 함수 정의부만 실행(트리거 결속 포함)
  await c.query(latestSql.slice(latestSql.indexOf('CREATE OR REPLACE FUNCTION')));

  await c.query(`INSERT INTO reviewers(name,phone) VALUES ('김민경','01094493573')`);
  // ① 본인 계좌 등록 = reviewer.service saveBankInfo 와 같은 쿼리 모양
  await c.query(`UPDATE reviewers SET
       bank_name      = COALESCE(NULLIF($1,''), bank_name),
       bank_account   = COALESCE(NULLIF($2,''), bank_account),
       account_holder = COALESCE(NULLIF($3,''), account_holder)
     WHERE phone8 = $4`, ['신한은행', '110290820674', '김민경', '94493573']);
  // ② 타계정 저장
  await c.query(`UPDATE reviewers SET sub_accounts = $1::jsonb WHERE phone8 = $2`,
    [JSON.stringify([{ name: '홍길동', phone: '01011112222', bankName: '국민', bankAccount: '12345678', accountHolder: '홍길동' }]), '94493573']);

  const { rows } = await c.query(`SELECT sub_phone8, after_bank_name, after_account_tail FROM reviewer_account_change_audit ORDER BY changed_at, sub_phone8 NULLS FIRST`);
  assert.equal(rows.length, 2, '본인 계좌 변경 1건 + 타계정 계좌 변경 1건이 감사에 남아야 한다');
  assert.deepEqual({ ...rows[0] }, { sub_phone8: null, after_bank_name: '신한은행', after_account_tail: '0674' },
    '본인 계좌 감사행이 마스킹된 값으로 기록되어야 한다');
  assert.deepEqual({ ...rows[1] }, { sub_phone8: '11112222', after_bank_name: '국민', after_account_tail: '5678' },
    '타계정 계좌 감사행이 그 명의(phone8)로 기록되어야 한다');

  await c.query(`DROP SCHEMA ${schema} CASCADE`);
  await c.end();
  console.log('  ✅ 진짜 PG 실행 검증 통과 (계좌 저장 + 타계정 저장 + 감사 2행)');
}

(async () => {
  if (process.env.PGTEST_URL) await pgRun();
  else console.log('  ⏭ PGTEST_URL 미설정 — 정적 검사만 수행 (실행 검증은 PGTEST_URL=postgres://... 로)');
  console.log('✅ reviewerAccountAuditTrigger 회귀가드 통과');
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
