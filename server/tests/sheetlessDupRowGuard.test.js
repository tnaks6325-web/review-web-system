/**
 * sheetlessDupRowGuard.test.js — 회귀가드: 무시트 주문 기록의 중복 줄 방어 (2026-08-19 실사고)
 * 실행: node tests/sheetlessDupRowGuard.test.js
 *
 * 사고: 「8/3(쿠팡)위프_블랙 탈취제 800건」에서 권정현 한 사람에게 8/19 16:40~18:20 사이
 *   **10분마다 한 줄씩 11줄**이 생겼다. 10분 복구 크론(`sheetless_worktable_recover`)이 매 주기
 *   같은 주문을 새 빈 슬롯에 기입한 것.
 *   원인 = 중복 방어가 `cp.order_submission_id → order_submissions` **링크를 타고** 판정하는데
 *   그 링크가 오염돼(다른 주문을 가리켜) 이미 반영된 줄을 못 봤다.
 *
 * 고정하는 것:
 *  A. 링크가 성한 경우의 1차 방어는 종전 그대로(무회귀)
 *  B. 링크가 오염돼도 **표에 적힌 주문번호 + 명의(phone8)** 로 막는다  ← 이번 수정
 *  C. 모르면 막지 않는다 — 주문번호 6자리 미만·연락처 8자리 미만은 종전대로 진행(fail-open)
 *  D. 명의가 다르면 막지 않는다(표 주문번호만으로 정상 주문을 가두지 않는다)
 *  E. 표 주문번호 추출 규칙은 중복 정리(dedupeRows)와 **같은 조각**(사본 금지)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const S = require('../src/services/sheetlessOrder.service');

/* ── 스텁 pool ─────────────────────────────────────────────────────────
   ★ 더 좁은 조건을 먼저 둔다(스텁 매칭 순서 함정 — CLAUDE.md 규율). */
function makePool({ linkedDup = [], rowNumDup = [], openSlot = [] } = {}) {
  const seen = [];
  const client = {
    query: async (sql, params) => {
      const q = String(sql).replace(/\s+/g, ' ');
      seen.push({ q, params });
      if (/^BEGIN|^ROLLBACK|^COMMIT|pg_advisory_xact_lock/.test(q)) return { rows: [] };
      // 1차 방어(링크 조인)
      if (/JOIN order_submissions os2/.test(q)) return { rows: linkedDup };
      // 2차 방어(표 주문번호) — 링크 조인이 없고 jsonb_each_text 를 쓴다
      if (/jsonb_each_text/.test(q) && /cp\.phone8 = \$5/.test(q)) return { rows: rowNumDup };
      // 이미 연결된 줄
      if (/order_submission_id = \$3::uuid/.test(q)) return { rows: [] };
      // 빈 슬롯 선점
      if (/order_submission_id IS NULL/.test(q) && /FOR UPDATE SKIP LOCKED/.test(q)) return { rows: openSlot };
      return { rows: [] };
    },
    release: () => {},
  };
  return { seen, connect: async () => client, query: client.query };
}

const ORDER = {
  orderer: '권정현', recipient: '권정현', userId: 'u', phone: '010-8950-8885',
  address: 'a', bank: '', account: '', depositor: '', price: '10000',
  dateStr: '8 / 19 (수)', orderNum: '5102385176784', memo: '', selectedOptKey: '',
};
const ARGS = {
  sheetId: 's1', tabName: 't1', tabGid: '1',
  orderSubmissionId: '11111111-1111-1111-1111-111111111111',
  loginPhone8: '89508885', loginName: '권정현', recovered: true, orderData: ORDER,
};

// 열 구성(headers)은 loadRawTabContext 대신 저장된 row_json 폴백으로 공급한다.
function poolWithHeaders(opts) {
  const p = makePool(opts);
  const inner = p.query;
  p.query = async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ');
    if (/row_json IS NOT NULL/.test(q) && /ORDER BY seq LIMIT 1/.test(q)) {
      return { rows: [{ row_json: { 번호: '', 주문번호: '', 수취인: '', 연락처: '' } }] };
    }
    return inner(sql, params);
  };
  return p;
}

(async () => {
  console.log('\n[A] 링크가 성한 경우 — 1차 방어(무회귀)');
  {
    const pool = poolWithHeaders({ linkedDup: [{ seq: 60, order_submission_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }] });
    S.__setPoolForTest(pool);
    const r = await S.writeOrderToWorktable(ARGS);
    S.__setPoolForTest(null);
    ok('중복으로 판정', r.reason === 'duplicate_row', JSON.stringify(r));
    ok('그 줄을 가리킨다', r.seq === 60);
    ok('새 슬롯을 먹지 않는다', !pool.seen.some(c => /FOR UPDATE SKIP LOCKED/.test(c.q)));
  }

  console.log('\n[B] 링크가 오염된 경우 — 표 주문번호로 막는다(이번 수정)');
  {
    const pool = poolWithHeaders({ linkedDup: [], rowNumDup: [{ seq: 639, order_submission_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }] });
    S.__setPoolForTest(pool);
    const r = await S.writeOrderToWorktable(ARGS);
    S.__setPoolForTest(null);
    ok('1차가 못 잡아도 2차가 잡는다', r.reason === 'duplicate_row', JSON.stringify(r));
    ok('그 줄을 가리킨다', r.seq === 639);
    ok('★ 새 빈 슬롯을 먹지 않는다(사고 재현 차단)', !pool.seen.some(c => /FOR UPDATE SKIP LOCKED/.test(c.q)));
    const g = pool.seen.find(c => /jsonb_each_text/.test(c.q) && /cp\.phone8/.test(c.q));
    ok('2차 방어가 실제로 조회됐다', !!g);
    ok('연락처는 뒤 8자리로 넘긴다', g.params[4] === '89508885', JSON.stringify(g.params));
    ok('주문번호는 숫자만 넘긴다', g.params[3] === '5102385176784');
  }

  console.log('\n[C] 링크 없는 줄(담당자 수기 입력)도 막는다 — 응답이 거짓을 말하지 않는다');
  {
    const pool = poolWithHeaders({ rowNumDup: [{ seq: 700, order_submission_id: null }] });
    S.__setPoolForTest(pool);
    const r = await S.writeOrderToWorktable(ARGS);
    S.__setPoolForTest(null);
    ok('중복으로 판정', r.reason === 'duplicate_row');
    ok('duplicateOf 는 문자열 "null" 이 아니라 null', r.duplicateOf === null, JSON.stringify(r));
  }

  console.log('\n[D] 모르면 막지 않는다(fail-open)');
  {
    // 연락처가 8자리를 못 만든다 → 2차 방어 자체를 건너뛴다
    const pool = poolWithHeaders({ rowNumDup: [{ seq: 1, order_submission_id: null }], openSlot: [] });
    S.__setPoolForTest(pool);
    await S.writeOrderToWorktable({ ...ARGS, orderData: { ...ORDER, phone: '123' } });
    S.__setPoolForTest(null);
    ok('연락처 8자리 미만이면 2차 방어 미조회', !pool.seen.some(c => /jsonb_each_text/.test(c.q) && /cp\.phone8/.test(c.q)));
  }
  {
    // 주문번호가 6자리 미만 → 1·2차 방어 모두 건너뛴다(종전 규칙)
    const pool = poolWithHeaders({ rowNumDup: [{ seq: 1, order_submission_id: null }] });
    S.__setPoolForTest(pool);
    await S.writeOrderToWorktable({ ...ARGS, orderData: { ...ORDER, orderNum: '123' } });
    S.__setPoolForTest(null);
    ok('주문번호 6자리 미만이면 방어 미조회', !pool.seen.some(c => /jsonb_each_text/.test(c.q) || /JOIN order_submissions os2/.test(c.q)));
  }
  {
    // 명의가 다른 줄은 SQL 이 걸러낸다 → 스텁이 빈 결과를 주면 막지 않아야 한다
    const pool = poolWithHeaders({ rowNumDup: [], openSlot: [] });
    S.__setPoolForTest(pool);
    const r = await S.writeOrderToWorktable(ARGS);
    S.__setPoolForTest(null);
    ok('중복이 아니면 종전대로 진행(빈 슬롯 조회까지 간다)',
      r.reason !== 'duplicate_row' && pool.seen.some(c => /FOR UPDATE SKIP LOCKED/.test(c.q)), JSON.stringify(r));
  }

  console.log('\n[E] 판정 SQL 은 한 벌 — 중복 정리와 같은 조각');
  {
    const { tableOrderNumSql } = require('../src/utils/tableOrderNum');
    const frag = tableOrderNumSql('cp');
    const led = read('src/services/sheetlessLedger.service.js');
    const ord = read('src/services/sheetlessOrder.service.js');
    ok('중복 정리가 공유 조각을 쓴다', /tableOrderNumSql\('cp'\)/.test(led));
    ok('주문 기록이 공유 조각을 쓴다', /tableOrderNumSql\('cp'\)/.test(ord));
    ok('두 파일에 인라인 사본이 없다',
      !/jsonb_each_text\(COALESCE\(cp\.row_json/.test(led) && !/jsonb_each_text\(COALESCE\(cp\.row_json/.test(ord));
    ok('조각이 그 별칭의 row_json 을 본다', frag.includes('cp.row_json'));
    ok('별칭은 검증한다(주입 차단)', (() => { try { tableOrderNumSql("cp; DROP TABLE x"); return false; } catch (_) { return true; } })());
    ok('명의 조건은 완화되지 않는다(phone8 = $5)', /AND cp\.phone8 = \$5/.test(ord));
    ok('자기 줄은 제외한다', /cp\.order_submission_id IS NULL OR cp\.order_submission_id <> \$3::uuid/.test(ord));
    ok('삭제된 줄은 근거가 아니다', /jsonb_each_text[\s\S]{0,400}cp\.deleted_at IS NULL/.test(ord.replace(/\s+/g, ' ')) ||
      /cp\.deleted_at IS NULL[\s\S]{0,400}cp\.phone8 = \$5/.test(ord.replace(/\s+/g, ' ')));
  }

  console.log('\n통과: ' + passed + '건');
  process.exit(0);
})().catch(e => { console.error('\n✗ ' + e.message); process.exit(1); });
