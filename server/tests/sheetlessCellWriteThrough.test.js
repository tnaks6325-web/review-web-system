'use strict';
/**
 * sheetlessCellWriteThrough.test.js — 무시트 셀 편집 쓰기-through(130) 회귀가드
 * 실행: node tests/sheetlessCellWriteThrough.test.js
 *
 * 고정하는 것:
 *  ① 거부 규칙 — 입금·금액·주문번호·이름·연락처 열은 원본에 쓰지 않는다(리뷰비 미지급·소유권 이동 차단)
 *  ② `decide` 는 편집 tx 의 client 만 쓴다(pool 재획득 = 붙여넣기 500 동시에서 풀 고갈 교착)
 *  ③ 편집 경로는 `rebuildLedgers` 를 부르지 않는다(락 점유) — dirty 만 찍는다
 *  ④ dirty 마킹은 `ledger_dirty_at IS NULL` 조건(첫 편집만 행 잠금)
 *  ⑤ 스윕 클리어는 `<= $3`(재생성 중 들어온 편집 유실 금지)
 *  ⑥ 투영이 무시트 row_json 을 덮지 않는다(10분 뒤 조용한 롤백 차단)
 *  ⑦ 되돌리기 — prev 복원 / 키 삭제 / superseded 는 원본 미변경
 */
process.env.SHEETLESS_CELL_WRITE = 'allow';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

const scw = require('../src/utils/sheetlessCellWrite');
const svc = require('../src/services/trackB.service');

console.log('\n▶ 무시트 셀 편집 쓰기-through(130) 회귀가드\n');

/* ── 1) 거부 규칙 (판정 원본 재사용) ───────────────────────── */
const deps = {
  linkedToggle: svc.linkedToggleHeader,
  nameKeywords: require('../src/services/indexBuilder.service').getKeywords().NAME_KEYWORDS,
};
t('1a: 입금 계열 열 거부 — status lock 을 통과하는 `입금확인`·`페이백` 포함', () => {
  for (const h of ['입금', '입금확인', '페이백', '입금여부', '비고(입금확인)']) {
    assert.ok(scw.denyReason(h, deps), '거부되어야 함: ' + h);
  }
});
t('1b: 금액·주문번호 열 거부(이체 금액·주문 링크 판정 보호)', () => {
  for (const h of ['결제금액', '옵션금액', '상품금액', '주문번호']) {
    assert.ok(scw.denyReason(h, deps), '거부되어야 함: ' + h);
  }
});
t('1c: 이름·연락처 열 거부(줄 소멸·소유권 이동 차단)', () => {
  for (const h of ['수취인', '이름', '주문자', '연락처', '전화번호', '휴대폰']) {
    assert.ok(scw.denyReason(h, deps), '거부되어야 함: ' + h);
  }
});
t('1d: 정보 열은 통과(비고·송장·옵션·차수)', () => {
  for (const h of ['비고', '택배송장번호', '옵션', '차수', '특이사항']) {
    assert.equal(scw.denyReason(h, deps), null, '허용되어야 함: ' + h);
    assert.ok(scw.DEFAULT_ALLOW.test(h), '허용목록에 있어야 함: ' + h);
  }
});

/* ── 2) decide 갈래 ────────────────────────────────────────── */
function fakeClient(row) {
  const q = [];
  return {
    q,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/FROM tab_configs tc/.test(s)) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
  };
}
const ARGS = { sheetId: 's', tabName: 'T', field: 'col:비고' };
t('2a: 시트 기반 탭이면 쓰지 않는다(sheet_backed) — 무회귀', async () => {});
(async () => {
  const cases = [
    [null, 'tab_not_registered'],
    [{ sheetless: false, gid: '1', dh: ['비고'] }, 'sheet_backed'],
    [{ sheetless: true, gid: '', dh: ['비고'] }, 'no_tab_gid'],
    [{ sheetless: true, gid: '1', dh: ['수취인'] }, 'header_not_in_ledger'],
    [{ sheetless: true, gid: '1', dh: ['비고'] }, 'ok'],
  ];
  for (const [row, want] of cases) {
    const c = fakeClient(row);
    const r = await scw.decide(c, ARGS);
    assert.equal(r.reason, want, '2: decide 사유=' + want + ' (받음 ' + r.reason + ')');
    assert.equal(r.write, want === 'ok', '2: write 플래그');
  }
  // 조회 실패 = 쓰지 않는다(fail-safe)
  const boom = { async query() { throw new Error('db down'); } };
  assert.equal((await scw.decide(boom, ARGS)).reason, 'lookup_failed', '2b: 조회 실패는 lookup_failed');
  // 거부 열은 허용목록 이전에 사유로 막힌다
  const c2 = fakeClient({ sheetless: true, gid: '1', dh: ['입금확인'] });
  assert.equal((await scw.decide(c2, { sheetId: 's', tabName: 'T', field: 'col:입금확인' })).reason, 'payment_column', '2c: 입금 열');
  // off 스위치
  process.env.SHEETLESS_CELL_WRITE = 'off';
  assert.equal((await scw.decide(fakeClient({ sheetless: true, gid: '1', dh: ['비고'] }), ARGS)).reason, 'disabled', '2d: off = 종전 동작');
  process.env.SHEETLESS_CELL_WRITE = 'dry';
  const dry = await scw.decide(fakeClient({ sheetless: true, gid: '1', dh: ['비고'] }), ARGS);
  assert.equal(dry.reason, 'dry_run', '2e: dry = 판정만');
  assert.equal(dry.write, false, '2e2: dry 는 쓰지 않는다');
  process.env.SHEETLESS_CELL_WRITE = 'allow';
  pass += 5; console.log('  ✓ 2: decide 갈래(미등록·시트기반·gid없음·헤더밖·ok·조회실패·off·dry)');

  /* ── 3) editWorkdeskRow 실행 ───────────────────────────── */
  function editPool({ header = '비고', sheetless = true, dh = ['비고'] } = {}) {
    const q = []; let connects = 0;
    const client = {
      async query(sql, params) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        q.push({ s, params });
        if (/^BEGIN|^ROLLBACK|^COMMIT/.test(s)) return { rows: [] };
        if (/FROM campaign_participants WHERE id=\$1 .* FOR UPDATE/.test(s)) {
          return { rows: [{ id: 'r1', seq: 7, source: 'import', order_submission_id: null,
                            identity_key: 'phone8:1', phone8: '1', recipient_name: null,
                            option_text: null, row_json: { [header]: '옛값' }, tab_gid: '1' }] };
        }
        if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(s)) return { rows: [{ n: 1 }] };
        if (/FROM raw_sheet_tabs WHERE sheet_id/.test(s)) return { rows: [{ detected_headers: dh }] };
        if (/FROM tab_configs tc/.test(s)) return { rows: [{ sheetless, gid: '1', dh }] };
        if (/UPDATE participant_edits SET reverted_at/.test(s)) return { rows: [], rowCount: 1 };
        if (/INSERT INTO participant_edits/.test(s)) return { rows: [{ id: 9 }] };
        if (/UPDATE campaign_participants SET row_json/.test(s)) return { rowCount: 1, rows: [] };
        return { rows: [] };
      },
      release() {},
    };
    return { q, get connects() { return connects; }, async connect() { connects++; return client; },
             async query(sql, p) { return client.query(sql, p); } };
  }

  const p1 = editPool();
  svc.__setPoolForTest(p1);
  const e1 = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:비고', value: '새값' });
  assert.ok(e1.ok, '3a: 허용 열 편집 성공');
  assert.ok(e1.writeThrough && e1.writeThrough.column === '비고', '3a2: writeThrough 보고');
  const sqls = p1.q.map(x => x.s);
  const iBegin = sqls.findIndex(s => /^BEGIN/.test(s));
  const iWrite = sqls.findIndex(s => /UPDATE campaign_participants SET row_json/.test(s));
  const iDirty = sqls.findIndex(s => /UPDATE tab_configs SET ledger_dirty_at/.test(s));
  const iCommit = sqls.findIndex(s => /^COMMIT/.test(s));
  assert.ok(iWrite > iBegin && iWrite < iCommit, '3b: row_json 쓰기가 같은 tx 안(BEGIN~COMMIT)');
  assert.ok(iDirty > iBegin && iDirty < iCommit, '3b2: dirty 마킹도 같은 tx 안');
  assert.equal(p1.connects, 1, '3c: 편집당 커넥션 1개 — decide 가 pool 을 다시 잡지 않는다(교착 차단)');
  const insP = p1.q.find(x => /INSERT INTO participant_edits/.test(x.s));
  assert.equal(insP.params.length, 12, '3d: INSERT 파라미터 12개(prev_text·had_prev·wrote_row_json)');
  assert.equal(insP.params[9], '옛값', '3d2: prev_text 는 잠근 행의 옛 값');
  assert.equal(insP.params[10], true, '3d3: had_prev');
  assert.equal(insP.params[11], true, '3d4: wrote_row_json');

  const p2 = editPool({ header: '입금확인', dh: ['입금확인'] });
  svc.__setPoolForTest(p2);
  const e2 = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:입금확인', value: '8/11' });
  assert.ok(e2.ok, '3e: 거부 열도 편집 자체는 성공(오버레이)');
  assert.equal(e2.writeThroughSkipped, 'payment_column', '3e2: 사유를 화면에 알린다');
  assert.ok(!p2.q.some(x => /UPDATE campaign_participants SET row_json/.test(x.s)), '3f: 거부 열은 원본 쓰기 0회');
  assert.ok(!p2.q.some(x => /UPDATE tab_configs SET ledger_dirty_at/.test(x.s)), '3f2: 거부 열은 dirty 0회');

  const p3 = editPool({ sheetless: false });
  svc.__setPoolForTest(p3);
  const e3 = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:비고', value: 'x' });
  assert.equal(e3.writeThroughSkipped, 'sheet_backed', '3g: 시트 기반 탭은 종전 동작(무회귀)');
  assert.ok(!p3.q.some(x => /UPDATE campaign_participants SET row_json/.test(x.s)), '3g2: 시트 기반은 원본 쓰기 0회');
  pass += 3; console.log('  ✓ 3: editWorkdeskRow — tx 통합·커넥션 1개·거부 열 쓰기 0·시트기반 무회귀');

  svc.__setPoolForTest(null);
})().then(() => {
  /* ── 4) 정적 계약 ───────────────────────────────────────── */
  const tb = R('server/src/services/trackB.service.js');
  // ★ 편집 경로 = `_editOneInTx`(실행부) + 단건/일괄 래퍼 — 세 함수를 한 구간으로 본다.
  //   실행부만 보면 래퍼가 rebuildLedgers 를 부르는 회귀를 놓치고, 래퍼만 보면 실행부 회귀를 놓친다.
  const edit = tb.slice(tb.indexOf('async function _editOneInTx'), tb.indexOf('async function revertWorkdeskEdit'));
  t('4a: 편집 경로는 rebuildLedgers 를 직접 부르지 않는다(락 점유 차단)', () => {
    assert.ok(!/rebuildLedgers/.test(edit), '편집 함수 안에 rebuildLedgers 호출이 있으면 안 된다');
  });
  t('4b: decide 에 넘기는 것은 tx client(pool 금지)', () => {
    assert.ok(/_scw\.decide\(client,/.test(edit), 'decide(client, …) 형태여야 한다');
  });
  const ss = R('server/src/services/sheetlessStatus.service.js');
  t('4c: dirty 마킹은 ledger_dirty_at IS NULL 조건(첫 편집만 행 잠금)', () => {
    const fn = ss.slice(ss.indexOf('async function markLedgerDirty'));
    assert.ok(/ledger_dirty_at IS NULL/.test(fn.slice(0, 600)), '조건이 없으면 500 동시 편집이 같은 행에 줄 선다');
  });
  const sw = R('server/src/services/sheetlessLedgerSweep.service.js');
  t('4d: 스윕 클리어는 `<= $3`(재생성 중 들어온 편집 유실 금지)', () => {
    assert.ok(/SET ledger_dirty_at = NULL[\s\S]{0,200}ledger_dirty_at <= \$3/.test(sw), '조건부 클리어여야 한다');
  });
  t('4d-2: 클리어 기준은 startedAt — 되보낸 dirtyAt 은 마이크로초가 잘려 한 행도 안 맞는다', () => {
    // PG timestamptz(마이크로초) → JS Date(밀리초) 절삭. `t.dirtyAt` 을 그대로 되보내면
    // dirty 가 영영 안 지워져 같은 탭을 매 주기 재생성하는 무한 루프가 된다(테섭 실측).
    assert.ok(/const startedAt = new Date\(\);[\s\S]{0,400}ledger_dirty_at <= \$3/.test(sw),
      'rebuild 시작 시각을 기준으로 클리어해야 한다');
    assert.ok(!/\[t\.sheetId, t\.tabName, t\.dirtyAt\]/.test(sw), 'dirtyAt 되보내기 부활 금지');
  });
  t('4e: 스윕 실패는 dirty 를 지우지 않는다(자가치유)', () => {
    assert.ok(/catch \(e\) \{ failed\+\+;/.test(sw), '실패 시 클리어로 넘어가면 안 된다');
  });
  const pa = R('server/src/services/participants.service.js');
  t('4f: 투영이 무시트 row_json 을 덮지 않는다(10분 롤백 차단)', () => {
    assert.ok(/row_json = CASE WHEN \$20 THEN campaign_participants\.row_json ELSE EXCLUDED\.row_json END/.test(pa),
      'CASE 동결이 없으면 편집이 다음 투영에서 사라진다');
    assert.ok(/isSheetless\(db, sheetId, tabName\)/.test(pa), '판정은 sheetlessScope 단일 출처');
  });
  t('4g: 무시트 탭은 _reconcileSeen 을 건너뛴다(줄 소멸 차단)', () => {
    const pt = tb.slice(tb.indexOf('async function projectTab'), tb.indexOf('async function projectTab') + 1400);
    assert.ok(/sheetless \? \{ deactivated: 0, reconcileSkipped: 'sheetless' \}/.test(pt), '건너뜀 분기 필요');
  });
  const revert = tb.slice(tb.indexOf('async function revertWorkdeskEdit'));
  t('4g-2: 빈 준비 자리도 되돌릴 수 있다 — 편집만 되고 ↩ 는 죽는 막다른 길 금지', () => {
    // 편집은 물리행 앵커로 저장되는데 _deriveAnchor 가 null 이면 revert 가 no_stable_anchor 로 죽는다(테섭 실측).
    assert.ok(/_rowAnchorId\(row\) \? \{ type: 'manual', value: _rowAnchorId\(row\) \} : null/.test(tb),
      '_deriveAnchor 에 물리행 앵커 폴백 필요');
    assert.ok(/const rowKey = _akey\('manual', _rowAnchorId\(r\)\)/.test(tb),
      '앵커 승격 후에도 그 값이 화면에서 사라지지 않게 밑에 깔아 합성해야 한다');
  });
  t('4h: 되돌리기 — 원본이 그 사이 바뀌었으면 덮지 않는다(superseded)', () => {
    assert.ok(/supersededReason = 'superseded'/.test(revert.slice(0, 4000)), 'stale 감지 필요');
    assert.ok(/removeRowJsonCell/.test(revert.slice(0, 4000)), 'had_prev=false 면 키 삭제');
  });
  const mig = R('server/migrations/130_sheetless_cell_writethrough.sql');
  t('4i: 마이그레이션은 컬럼 추가만(백필·CHECK 0)', () => {
    assert.ok(/ADD COLUMN IF NOT EXISTS prev_text/.test(mig) && /ADD COLUMN IF NOT EXISTS ledger_dirty_at/.test(mig));
    assert.ok(!/UPDATE |DELETE |CHECK \(/.test(mig), '백필·CHECK 가 있으면 안 된다');
  });
  const idx = R('server/index.js');
  t('4j: REQUIRED_SCHEMA 등록(없으면 편집만 조용히 42703)', () => {
    assert.ok(/'participant_edits', 'wrote_row_json'/.test(idx) && /'tab_configs', 'ledger_dirty_at'/.test(idx));
  });
  const wd = R('frontend/workdesk.html');
  t('4k: 화면이 거부 사유를 말한다(조용한 무반영 금지)', () => {
    assert.ok(/_WT_SKIP_MSG/.test(wd) && /_wtNotice\(resp\)/.test(wd), '사유 표기 배선 필요');
    assert.ok(/_wtNoticed=\{\}/.test(wd), '사유별 1회 접기 상태 필요');
  });
  t('4l-1: 크론 없는 배포를 위한 수동 스윕 창구(adminOrMaster)', () => {
    // server/index.js 는 NODE_ENV==='production' 일 때만 크론을 켠다 → 그 밖의 배포에서는
    // 사람이 눌러 장부를 반영할 수 있어야 한다(안 그러면 편집이 원본에만 남는다).
    const rt = R('server/src/routes/trackB.routes.js');
    assert.ok(/router\.post\('\/sheetless\/ledger-sweep', authMiddleware, adminOrMasterMiddleware/.test(rt), '수동 스윕 라우트 필요');
    assert.ok(/withJobLock\('sheetless_ledger_sweep'/.test(rt), '크론과 같은 락을 써야 한다(이중 실행 차단)');
    const sw2 = R('server/src/services/sheetlessLedgerSweep.service.js');
    assert.ok(/pending, oldestWaitSec/.test(sw2), '밀린 대기 건수를 보고해야 한다(무신호 금지)');
  });
  t('4l: 기본값은 테섭에서만 allow — 본섭 표식이 없으면 off', () => {
    const u = R('server/src/utils/sheetlessCellWrite.js');
    assert.ok(/TEST_AUTO_LOGIN === '1' \? 'allow' : 'off'/.test(u), '본섭에서 자동으로 켜지면 안 된다');
  });
  console.log(`\n✅ ${pass}개 통과\n`);
  process.exit(0);
}).catch(e => { console.error('❌', e.message); process.exit(1); });
