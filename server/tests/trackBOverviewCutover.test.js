/**
 * Track B 관측 대시보드 — cutover 종합 판정(fail-closed) + write-back 건강 매핑 회귀가드.
 *   overview() 신호 계약 고정:
 *   - cutoverCandidate = 시트원본·카운트일치·소유·발주·비유령 (경량 triage — 자동화 소비 금지)
 *   - cutoverReady     = candidate + 신선한 정밀 스냅샷 real=0 (real 게이트 내장 — 필드 단독 소비도 안전)
 *   - ghost            = A·B 모두 활성 0행(아카이브/리네임 잔재) → 후보 제외 (0==0 카운트일치 오판 차단)
 *   - writeback        = 토글 스코프 {engineOn, pending(미시도 NULL), held, blocked} — gate_off/양보가 '정상'으로 못 샘
 * 실행: node tests/trackBOverviewCutover.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');

function poolReturning(rows) {
  return { async query(sql) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM b LEFT JOIN LATERAL/.test(s)) return { rows };
    return { rows: [] };
  } };
}
const H = 3600 * 1000;
function row(over) {
  return Object.assign({
    sheetId: 'S1', tabName: 'T', tabGid: '1', bTotal: 10, bSub: 5, bPaid: 3, bLinked: 4, lastProjectedAt: null,
    spreadsheetTitle: '시트', aTotal: 10, aSub: 5, aPaid: 3, owned: true, woLinked: true, sourceOfTruth: 'sheet',
    editCount: 0, editToggle: 0, wbPending: 0, wbHeld: 0, wbBlocked: 0, snapReal: null, snapAt: null,
  }, over);
}

async function run() {
  const savedWB = process.env.TRACK_B_WRITEBACK;
  delete process.env.TRACK_B_WRITEBACK;
  try {
    const rows = [
      row({ tabName: 'A',  snapReal: 0, snapAt: new Date(Date.now() - 1 * H) }),          // 신선 real=0
      row({ tabName: 'A2' }),                                                              // 스냅샷 없음
      row({ tabName: 'A3', snapReal: 0, snapAt: new Date(Date.now() - 25 * H) }),          // 스냅샷 낡음(>24h)
      row({ tabName: 'A4', snapReal: 2, snapAt: new Date(Date.now() - 1 * H) }),           // 신선하지만 불일치
      row({ tabName: 'B',  owned: false }),
      row({ tabName: 'C',  bTotal: 9 }),
      row({ tabName: 'D',  sourceOfTruth: 'db', editCount: 5, editToggle: 3, wbPending: 3, wbHeld: 1, wbBlocked: 2 }),
      row({ tabName: 'E',  aTotal: 0, aSub: 0, aPaid: 0, bTotal: 0, bSub: 0, bPaid: 0,
            snapReal: 0, snapAt: new Date(Date.now() - 1 * H) }),                          // 유령(전부 0행)
    ];
    svc.__setPoolForTest(poolReturning(rows));
    const items = await svc.overview();
    const by = Object.fromEntries(items.map(x => [x.tabName, x]));

    // 1. ready = candidate + 신선 스냅샷 real=0 (real 게이트 내장)
    assert.equal(by.A.cutoverCandidate, true, 'A: triage 충족');
    assert.equal(by.A.cutoverReady, true, 'A: 신선 real=0 → ready');
    assert.deepEqual(by.A.lastParity, { real: 0, takenAt: rows[0].snapAt, fresh: true }, 'A: lastParity 매핑');
    assert.equal(by.A2.cutoverCandidate, true, 'A2: triage 충족');
    assert.equal(by.A2.cutoverReady, false, 'A2: 스냅샷 없음(real 미상) → ready 아님(fail-closed)');
    assert.equal(by.A3.cutoverReady, false, 'A3: 낡은 스냅샷 → ready 아님');
    assert.equal(by.A3.lastParity.fresh, false, 'A3: fresh=false');
    assert.equal(by.A4.cutoverReady, false, 'A4: real=2 → ready 아님');
    assert.equal(by.A4.lastParity.real, 2, 'A4: lastParity.real 노출');

    // 2. triage 결격 사유
    assert.equal(by.B.cutoverCandidate, false, 'B: 미소유');
    assert.equal(by.C.cutoverCandidate, false, 'C: 카운트 불일치');
    assert.equal(by.C.countMatch, false, 'C: countMatch false');
    assert.equal(by.D.cutoverCandidate, false, 'D: 이미 db 전환됨');
    assert.equal(by.D.sourceOfTruth, 'db', 'D: 원본 db');

    // 3. 유령 탭: 0==0 카운트일치·소유·발주·신선 real=0이어도 후보/ready 아님
    assert.equal(by.E.ghost, true, 'E: ghost 판정');
    assert.equal(by.E.countMatch, true, 'E: 0==0 은 countMatch true (그래서 ghost 가드가 필요)');
    assert.equal(by.E.cutoverCandidate, false, 'E: 유령 → 후보 제외');
    assert.equal(by.E.cutoverReady, false, 'E: 유령 → ready 아님');

    // 4. write-back 건강: pending(미시도) 포함 + engineOn(글로벌 게이트) 반영
    assert.deepEqual(by.D.writeback, { engineOn: false, pending: 3, held: 1, blocked: 2 }, 'D: 토글 스코프 + pending + engineOn=false');
    assert.equal(by.D.editCount, 5, 'D: 전체 편집수');
    assert.equal(by.D.editToggle, 3, 'D: 토글 편집수 분리');

    process.env.TRACK_B_WRITEBACK = '1';
    const items2 = await svc.overview();
    assert.equal(items2.find(x => x.tabName === 'D').writeback.engineOn, true, 'engineOn: TRACK_B_WRITEBACK=1 반영');

    svc.__setPoolForTest(null);
    console.log('  overview — candidate/ready 분리(real 게이트 내장)·ghost·write-back(pending/engineOn) ✓');
    console.log('✅ trackBOverviewCutover 테스트 통과');
  } finally {
    if (savedWB === undefined) delete process.env.TRACK_B_WRITEBACK; else process.env.TRACK_B_WRITEBACK = savedWB;
  }
}

run().catch(e => { console.error('❌', e); process.exit(1); });
