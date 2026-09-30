'use strict';
/**
 * 회차 입금일 기록 — 탭당 재생성 1회 회귀가드 (2026-08-19 회차 #12 실사고)
 *
 * 사고: 결과 반영이 건별로 장부를 재생성해(517건 = 재생성 517번) 커밋 뒤 루프가 6번째에서
 *       끊겼다. 입금 원장은 517건인데 작업보드 입금일은 5건만 남았고, 루프 끝의
 *       `_saveBoardWriteOutcome` 에 도달하지 못해 board_* 가 전부 0 이었다.
 *
 * ★ 정적 검사만으로는 "재생성을 몇 번 부르는가"를 못 본다 → 두 함수를 vm 으로 꺼내 **실행**한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'services', 'paymentResult.service.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0;
const done = [];
const t = (name, fn) => { const r = fn(); done.push(Promise.resolve(r).then(() => { pass++; console.log('  ✓ ' + name); })); };

/* 실행 준비: 공용 실행부만 잘라 가짜 의존성 위에 올린다 */
function loadBoardFns({ sheetlessMap = {}, rebuildFail = new Set(), markResult, verifyResult } = {}) {
  const start = src.indexOf('async function _rebuildTouchedLedgers');
  const end = src.indexOf('/** DB 행 → 짝맞추기 입력 모양');
  assert.ok(start > 0 && end > start, '공용 실행부를 찾지 못했다');
  const code = src.slice(start, end);

  const calls = { mark: [], verify: [], rebuild: [], probe: [] };
  const sandbox = {
    console,
    _db: () => ({}),
    logger: { warn() {}, info() {} },
    rebuildLedgers: async ({ sheetId, tabName }) => {
      calls.rebuild.push(tabName);
      if (rebuildFail.has(tabName)) throw new Error('boom');
    },
    paymentApply: {
      markDepositCells: async (items, opts) => {
        calls.mark.push({ n: items.length, opts });
        return markResult || { recorded: 0, queued: 0, skipped: 0, failed: 0 };
      },
      verifyDepositCells: async (items) => {
        calls.verify.push(items.length);
        return verifyResult || { verified: items.length, missing: 0 };
      },
    },
    require: (p) => {
      if (p === '../utils/sheetlessScope') {
        return { isSheetless: async (_db, _s, tabName) => { calls.probe.push(tabName); return sheetlessMap[tabName] !== false; } };
      }
      throw new Error('예상치 못한 require: ' + p);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.__fns = { _rebuildTouchedLedgers, _writeBoardDeposits };', sandbox);
  return { fns: sandbox.__fns, calls };
}

const item = (tab, row, extra) => Object.assign({ sheetId: 'wt_1', tabName: tab, rowIndex: row, stamp: '8/19 16:33' }, extra || {});

console.log('회차 입금일 기록 — 탭당 재생성 1회');

t('★★ 517건·3탭이어도 장부 재생성은 탭당 1회(=3회)', () => {
  const { fns, calls } = loadBoardFns();
  const items = [];
  for (let i = 0; i < 500; i++) items.push(item('A', i + 1));
  for (let i = 0; i < 15; i++) items.push(item('B', i + 1));
  items.push(item('C', 1), item('C', 2));
  return fns._writeBoardDeposits(items, { by: 'tester' }).then(() => {
    assert.strictEqual(calls.rebuild.length, 3, '재생성 ' + calls.rebuild.length + '회 — 탭 수(3)와 같아야 한다');
    assert.strictEqual(calls.mark.length, 1, '쓰기는 모아서 한 번');
  });
});

t('★★ 쓰기는 항상 deferSheetlessRebuild: true (건별 재생성 금지)', () => {
  const { fns, calls } = loadBoardFns();
  return fns._writeBoardDeposits([item('A', 1)], { by: 'tester' }).then(() => {
    assert.strictEqual(calls.mark[0].opts.deferSheetlessRebuild, true,
      'deferSheetlessRebuild 가 빠지면 건별 재생성으로 되돌아간다(#12 재현)');
  });
});

t('★ 시트 기반 탭은 재생성하지 않는다', () => {
  const { fns, calls } = loadBoardFns({ sheetlessMap: { SHEET: false } });
  return fns._writeBoardDeposits([item('SHEET', 1), item('A', 1)], { by: 'x' }).then(() => {
    assert.deepStrictEqual(calls.rebuild, ['A']);
  });
});

t('★ 호출부가 sheetless 를 알면 판정을 다시 묻지 않는다(조회 순증 0)', () => {
  const { fns, calls } = loadBoardFns();
  return fns._writeBoardDeposits([item('A', 1, { sheetless: true })], { by: 'x' }).then(() => {
    assert.strictEqual(calls.probe.length, 0);
    assert.strictEqual(calls.rebuild.length, 1);
  });
});

t('★ 한 탭의 재생성이 실패해도 나머지 탭은 계속 간다', () => {
  const { fns, calls } = loadBoardFns({ rebuildFail: new Set(['A']) });
  return fns._writeBoardDeposits([item('A', 1), item('B', 1), item('C', 1)], { by: 'x' }).then((out) => {
    assert.strictEqual(calls.rebuild.length, 3, '실패한 탭에서 멈추면 안 된다');
    assert.ok(out && typeof out.recorded === 'number');
  });
});

t('★ 반환 모양은 종전과 동일(recorded/queued/skipped/failed)', () => {
  const { fns } = loadBoardFns({
    markResult: { recorded: 0, queued: 2, skipped: 3, failed: 1 },
    verifyResult: { verified: 7, missing: 4 },
  });
  return fns._writeBoardDeposits([item('A', 1)], { by: 'x' }).then((out) => {
    // vm 컨텍스트 반환값이라 프로토타입이 달라 deepStrictEqual 은 못 쓴다 — 값으로 본다.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(out)),
      { recorded: 7, queued: 2, skipped: 3, failed: 3 });
  });
});

/* 배선: 두 소비처가 사본을 두지 않고 같은 실행부를 쓴다 */
const applyBlock = src.slice(src.indexOf('const boardItems = paidItems.filter'), src.indexOf('const boardStamp = '));
t('★ 결과 반영 경로가 공용 실행부를 쓴다(사본 금지)', () => {
  assert.match(applyBlock, /_writeBoardDeposits\(boardItems/);
  assert.doesNotMatch(applyBlock, /markDepositCells\(/,
    '결과 반영이 markDepositCells 를 직접 부르면 defer 옵션이 다시 갈린다');
});

const backfillBlock = src.slice(src.indexOf('const datedItems = items.filter'), src.indexOf('await _saveBoardWriteOutcome({ batchId, outcome,'));
t('★ 소급 백필 경로도 같은 실행부를 쓴다', () => {
  assert.match(backfillBlock, /_writeBoardDeposits\(datedItems/);
  assert.doesNotMatch(backfillBlock, /rebuildLedgers\(/, '백필에 재생성 사본이 남으면 두 벌이 된다');
});

t('★★ deferSheetlessRebuild 지정은 이 파일에 한 곳뿐', () => {
  const n = (src.match(/deferSheetlessRebuild/g) || []).length;
  assert.strictEqual(n, 1, 'deferSheetlessRebuild 가 ' + n + '곳 — 실행부는 하나여야 한다');
});

t('★ 리터럴 NUL 없음(복합키는 이스케이프 표기)', () => {
  assert.ok(src.indexOf(String.fromCharCode(0)) === -1,
    'git 이 파일을 바이너리로 취급해 grep 가드가 무력화된다');
});

/* 화면: 미기록 회차에 조치 수단이 있다 */
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
const wb = html.slice(html.indexOf('function _pmBatchWorkboard'), html.indexOf('function _pmBoardApplyText'));
const fn = html.slice(html.indexOf('async function _pmDepositBackfill'), html.indexOf('async function _pmDepositBackfill') + 1400);

t('★ "입금일 미기록" 회차에 [입금일 기록] 버튼이 있다', () => {
  assert.match(wb, /입금일 미기록[\s\S]*_pmDepositBackfill\(/);
});
t('★ 기록실패가 남은 회차도 다시 시도할 수 있다', () => {
  assert.match(wb, /입금일 다시 기록/);
});
t('★ 취소된 회차에는 버튼을 만들지 않는다(눌러도 안 되는 버튼 금지)', () => {
  assert.match(wb, /b\.status!=='cancelled'/);
});
t('★ onclick 은 인덱스만 넘긴다', () => {
  assert.match(wb, /_pmDepositBackfill\(\$\{i\}\)/);
  assert.doesNotMatch(wb, /_pmDepositBackfill\('/);
});
t('★ 실행 전 확인창을 거친다', () => {
  assert.match(fn, /if\(!confirm\(/);
  assert.match(fn, /deposit-date-backfill/);
});
t('★ 실패를 조용히 삼키지 않는다', () => {
  assert.match(fn, /입금일 기록 실패/);
});

Promise.all(done).then(() => {
  console.log('\n✅ paymentBoardRebuildBatching 회귀가드 통과 — ' + pass + '케이스');
  process.exit(0);
}).catch((e) => { console.error('❌ 실패:', e.message); process.exit(1); });
