'use strict';
// 결정 224 — 신원 기준 3-4a: 구매양식이 명의 정보를 스스로 바꾸거나 등록을 요구한 사건을 센다(관찰만 · 동작 무변경).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

delete process.env.IDENTITY_RULES_MODE;
const IR = require('../src/services/identityRules.service');
const pool = require('../src/db/pool');
const OWNER = '11111111-1111-4111-8111-111111111111';
const read = (f) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

(async () => {
  // recordEvent: 기록만 · off 면 무동작 · 실패 삼킴 · 이름·번호 없음
  IR._test._resetModeCacheForTest();
  let log = [];
  const okDb = { query: async (sql, params) => { log.push({ sql: String(sql), params }); return { rows: [] }; } };
  assert.strictEqual(await IR.recordEvent({ source: 'order_submit', ownerId: OWNER, code: 'order_enrich_sub', subIndex: 2 }, okDb), true);
  const ins = log.find((x) => /INSERT INTO identity_rule_observations/.test(x.sql));
  assert.deepStrictEqual(ins.params, ['order_submit', OWNER, 'order_enrich_sub', 2, 'observe']);
  IR._test._resetModeCacheForTest(); log = [];
  const offDb = { query: async (sql) => { log.push(String(sql)); return { rows: /app_settings/.test(sql) ? [{ value: 'off' }] : [] }; } };
  assert.strictEqual(await IR.recordEvent({ code: 'order_bank_fill' }, offDb), false);
  assert(!log.some((s) => /INSERT/.test(s)), 'off 면 기록 안 함');
  IR._test._resetModeCacheForTest();
  assert.strictEqual(await IR.recordEvent({ code: 'x' }, { query: async (sql) => { if (/app_settings/.test(sql)) return { rows: [] }; throw new Error('down'); } }), false, '실패 삼킴');
  console.log('PASS 사건 기록 — 기록만 · off 무동작 · 실패 삼킴');

  // 내정보 계좌 "빈 칸만 채우기": 빈 칸이 있었을 때만 사건 · 저장(UPDATE)은 그대로
  const rv = require('../src/services/reviewer.service');
  const origQuery = pool.query, origConnect = pool.connect;
  for (const [label, emptyRows, expectEvent] of [['빈 칸 있음', [{ id: OWNER }], true], ['이미 다 있음', [], false]]) {
    const q = [];
    pool.query = async (sql, params) => {
      q.push(String(sql));
      if (/COALESCE\(bank_name,''\) = '' OR/.test(sql)) return { rows: emptyRows };
      if (/UPDATE reviewers SET[\s\S]*bank_name/.test(sql)) return { rows: [{ id: OWNER }], rowCount: 1 };
      if (/app_settings/.test(sql)) return { rows: [] };
      return { rows: [] };
    };
    pool.connect = async () => { throw new Error('카드 맞추기는 이 시험 밖'); };
    IR._test._resetModeCacheForTest();
    const r = await rv.handleReviewerProfile({ action: 'saveBankInfo', phone8: '41490001', ownerReviewerId: OWNER, bankName: '국민', bankAccount: '111', accountHolder: '갑', onlyIfEmpty: true });
    await new Promise((res) => setTimeout(res, 30));
    assert.strictEqual(r.ok, true, label + ' 저장 응답 그대로');
    assert(q.some((s) => /UPDATE reviewers SET[\s\S]*bank_name/.test(s)), label + ' 저장(UPDATE)은 그대로 실행');
    assert.strictEqual(q.some((s) => /INSERT INTO identity_rule_observations/.test(s)), expectEvent, label + ' 사건 기록 여부');
  }
  pool.query = origQuery; pool.connect = origConnect;
  console.log('PASS 계좌 빈칸 채우기 — 빈 칸 있을 때만 사건 · 저장 동작 불변');

  // 배선: 관찰 표시만 더했고 동작 분기는 그대로
  const sub = read('src/routes/submit.routes.js');
  assert(/recordEvent\(\{ source: 'order_submit', ownerId: _rv\.id, code: 'order_need_sub_register' \}\)[\s\S]{0,200}return res\.json\(\{\s*ok: false, code: 'NEED_SUB_REGISTER'/.test(sub), '제출 관문 등록 요구는 그대로 막고 횟수만 기록');
  assert(/code: 'order_enrich_sub', subIndex: _verdict\.subIndex/.test(sub), '타계정 빈칸 자동 채움 기록');
  const rr = read('src/routes/reviewer.routes.js');
  assert(/code: 'precheck_need_sub_register'/.test(rr), '제출 전 대조 등록 요구 기록');
  const rvs = read('src/services/reviewer.service.js');
  assert(/source: _fromOrderForm \? 'order_form_register' : 'profile'/.test(rvs) && /_event\('order_income_save'/.test(rvs), '구매양식 등록·소득 저장 표시');
  const front = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');
  assert((front.match(/origin: +"order_form"/g) || []).length === 2, '구매양식이 보내는 저장 2곳에 표시');
  console.log('PASS 배선 — 관찰 표시만 · 막는 동작·저장 동작 그대로');
})().catch((e) => { console.error(e); process.exit(1); });
