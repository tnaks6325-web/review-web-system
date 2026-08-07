/**
 * 시트 우위 동기화(sheet-slot sync) 회귀가드 — 탈 구글시트 1차
 *
 * 이 가드가 고정하는 것
 *   1. 준비 행 판독은 **RAW 미러**에서(시트 API 무접촉) + `cells->>$n::int` 캐스트 필수
 *      (빼면 에러 없이 전 행 NULL — 063 이 배포 이래 무음으로 꺼져 있던 실측 함정).
 *   2. 판정 사본 금지: 날짜 열 = campaignSchedule.findDateColumnIndex ·
 *      **옵션 칸 = orderLedger.optionWriteColumns**(직접 '옵션' 매칭하면 `옵션금액`(결제금액)·
 *      `비고(옵션확인)`을 오분류한다) — 실제 실행으로 대조.
 *   3. 슬롯은 **seq = 시트 실제 행 번호** · `source='worktable'` · ON CONFLICT DO NOTHING(비파괴·멱등).
 *      seq 가 어긋나면 주문이 채워질 때 새 행이 생겨 표가 두 겹이 된다.
 *   4. 백필의 tabGid 는 **서버가 tab_configs 에서 다시 구한다**(클라이언트 gid 불신 — 엉뚱한 탭 오염 차단).
 *   5. 정원 교정은 **더 여는 쪽만** — 0(무제한) 미접촉 · 이미 충분하면 미접촉 ·
 *      옵션 2개 이상이면 자동 배분 금지(사람이) · target 은 서버가 다시 센다 · 연결 검증 필수.
 *   6. 라우트 3개는 authMiddleware + adminOrMasterMiddleware, 백필 기본은 **미리보기**(파괴적 기본값 금지).
 *   7. 프론트는 onclick 에 인덱스만 넘긴다(시트발 문자열 보간 금지).
 *
 * 실행: node tests/sheetSlotSync.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';

const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const FRONT = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const SRC = R('src/services/sheetSlotSync.service.js');
const PSRC = R('src/services/participants.service.js');
const HTML = FRONT('sheet-sync-audit.html');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };
const ta = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };

const svc = require('../src/services/sheetSlotSync.service');
const participants = require('../src/services/participants.service');
const { optionWriteColumns } = require('../src/services/orderLedger.service');
const { findDateColumnIndex } = require('../src/services/campaignSchedule.service');

/* ── 실측 우레온 탭을 본뜬 픽스처 ─────────────────────────── */
const HEADERS = ['번호', '담당자', '구매일자', '리뷰옵션', '인애드명단', '주문자제출', '수취인', 'id',
  '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '옵션금액', '비고(옵션확인)', '리뷰제출'];
const HEADER_ROW = 18;
// 19~20 = 참여자 채워진 행 / 21~23 = 이름 없는 준비 행(시트에만 있는 자리)
function sheetRows() {
  const mk = (idx, name, date, opt) => {
    const c = new Array(HEADERS.length).fill('');
    c[0] = String(idx - HEADER_ROW); c[2] = date; c[3] = opt;
    if (name) { c[4] = name; c[6] = name; c[8] = '010-1111-2222'; }
    return { row_index: idx, cells: c };
  };
  return [
    mk(19, '박세희', '8/3(월)', '텍스트'),
    mk(20, '박은비', '8/3(월)', '텍스트'),
    mk(21, '', '8/4(화)', '포토'),
    mk(22, '', '8/5(수)', '포토'),
    mk(23, '', '설명문구', '포토'),      // 날짜로 해석 안 됨 → 제외 + datelessFilled
  ];
}
function headScan() {
  return [{ row_index: 1, cells: ['캠페인명', '8/3(네이버)우레온'] }, { row_index: HEADER_ROW, cells: HEADERS }];
}
function mkDb(overrides = {}) {
  const calls = [];
  const db = {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const s = String(sql);
      if (overrides.custom) { const r = overrides.custom(s, params); if (r) return r; }
      if (/raw_sheet_rows/.test(s) && /row_index <= 60/.test(s)) return { rows: headScan() };
      if (/raw_sheet_rows/.test(s) && /cells->>/.test(s)) {
        const di = parseInt(params[2], 10), oi = /\$4::int AS o/.test(s) ? parseInt(params[3], 10) : -1;
        return { rows: sheetRows().filter(r => r.row_index > HEADER_ROW).map(r => ({
          row_index: r.row_index, d: r.cells[di], o: oi >= 0 ? r.cells[oi] : null })) };
      }
      if (/SELECT row_index, cells FROM raw_sheet_rows/.test(s)) {
        return { rows: sheetRows().filter(r => r.row_index > HEADER_ROW) };
      }
      return { rows: [] };
    },
  };
  return db;
}

(async () => {

/* ══ 1) 판정 단일 출처 ══════════════════════════════════════ */
console.log('\n1) 판정 단일 출처(사본 금지)');

t('★★ 옵션 칸은 optionWriteColumns 가 고른다 — 옵션금액·비고(옵션확인) 오분류 없음', () => {
  const cols = optionWriteColumns(HEADERS);
  assert.deepStrictEqual(cols.map(i => HEADERS[i]), ['리뷰옵션'],
    '옵션 칸 판정이 리뷰옵션 하나가 아니다 — 결제금액/비고가 섞이면 금액 칸을 옵션으로 오독한다');
  assert.ok(SRC.includes("require('./orderLedger.service')") && SRC.includes('optionWriteColumns'),
    '옵션 칸 판정 사본이 들어왔다 — orderLedger.optionWriteColumns 를 써야 한다');
  assert.ok(!/['"]옵션['"]\s*\)/.test(SRC.replace(/\/\/.*$/gm, '')), '헤더 문자열로 직접 옵션 칸을 고르고 있다');
});
t('날짜 열 판정은 campaignSchedule.findDateColumnIndex 재사용', () => {
  assert.strictEqual(HEADERS[findDateColumnIndex(HEADERS)], '구매일자');
  assert.ok(SRC.includes('findDateColumnIndex'), 'findDateColumnIndex 미사용');
  assert.ok(!SRC.includes('DATE_HEADER_KEYWORDS = ['), '날짜 키워드 표 사본이 들어왔다');
});
t('★★ jsonb 배열 인덱싱은 `cells->>$n::int` — ::int 누락 시 전 행 NULL(무음 고장)', () => {
  const body = SRC.replace(/\/\/.*$/gm, '');
  const hits = body.match(/cells->>\$\d+/g) || [];
  assert.ok(hits.length >= 1, 'cells->> 조회가 없다');
  (body.match(/cells->>\$\d+(::int)?/g) || []).forEach(h =>
    assert.ok(h.endsWith('::int'), '::int 캐스트 누락: ' + h));
});
t('읽기 경로는 RAW 미러만 — 시트 API 호출 0', () => {
  assert.ok(!/sheets\.service|googleapis|throttledCall/.test(SRC), '시트 API 를 직접 부른다');
  assert.ok(SRC.includes('raw_sheet_rows'), 'RAW 미러를 안 읽는다');
});

/* ══ 2) 준비 행 판독 ════════════════════════════════════════ */
console.log('\n2) readPreparedRows — 준비 행 = 날짜가 해석되는 행');

await ta('감사 모드: 준비 3행 중 날짜 해석 2행만 prepared · 나머지는 datelessFilled 로 보고', async () => {
  const out = await svc.readPreparedRows(mkDb(), { sheetId: 'S', tabGid: '278673543' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.headerRow, HEADER_ROW, '헤더 행 번호가 시트 실제 행이 아니다');
  assert.strictEqual(out.dateColumn, '구매일자');
  assert.strictEqual(out.optionColumn, '리뷰옵션');
  assert.deepStrictEqual(out.prepared.map(p => p.seq), [19, 20, 21, 22]);
  assert.strictEqual(out.datelessFilled, 1, '날짜로 못 읽은 칸을 조용히 버렸다');
});
await ta('★ seq = 시트 실제 행 번호(1부터 다시 세지 않는다)', async () => {
  const out = await svc.readPreparedRows(mkDb(), { sheetId: 'S', tabGid: '1' });
  assert.strictEqual(out.prepared[0].seq, 19, 'seq 가 시트 행 번호가 아니다 — 표가 두 겹이 된다');
});
await ta('includeCells 모드: row_json = 헤더명→값 맵(그리드가 그대로 그린다)', async () => {
  const out = await svc.readPreparedRows(mkDb(), { sheetId: 'S', tabGid: '1', includeCells: true });
  const row21 = out.prepared.find(p => p.seq === 21);
  assert.ok(row21.rowJson && row21.rowJson['구매일자'] === '8/4(화)', 'row_json 에 구매일자가 없다');
  assert.strictEqual(row21.rowJson['리뷰옵션'], '포토');
  assert.strictEqual(row21.optionText, '포토');
  assert.ok(!Object.prototype.hasOwnProperty.call(row21.rowJson, ''), '빈 헤더가 키로 들어갔다');
});
await ta('미러 없음/헤더 인식 실패/날짜 열 없음 = 각각 사유와 함께 실패(추측 금지)', async () => {
  const noMirror = await svc.readPreparedRows(mkDb({ custom: (s) => /row_index <= 60/.test(s) ? { rows: [] } : null }), { sheetId: 'S', tabGid: '1' });
  assert.strictEqual(noMirror.reason, 'no_mirror');
  const badHdr = await svc.readPreparedRows(mkDb({ custom: (s) => /row_index <= 60/.test(s) ? { rows: [{ row_index: 1, cells: ['가', '나'] }] } : null }), { sheetId: 'S', tabGid: '1' });
  assert.strictEqual(badHdr.reason, 'header_unrecognizable');
  const noDate = await svc.readPreparedRows(mkDb({ custom: (s) => /row_index <= 60/.test(s)
    ? { rows: [{ row_index: 2, cells: ['번호', '수취인', '연락처', '주소'] }] } : null }), { sheetId: 'S', tabGid: '1' });
  assert.strictEqual(noDate.reason, 'no_date_column');
  assert.strictEqual(noDate.ok, false);
});
await ta('탭/시트 미지정은 즉시 no_tab(빈 결과로 꾸미지 않는다)', async () => {
  const out = await svc.readPreparedRows(mkDb(), { sheetId: 'S', tabGid: '' });
  assert.strictEqual(out.reason, 'no_tab');
});

/* ══ 3) 정원 판정(순수함수) ═════════════════════════════════ */
console.log('\n3) evaluateQuota — 더 여는 쪽만');

t('단일 옵션 + 총모집이 표보다 작으면 둘 다 교정 대상', () => {
  const q = svc.evaluateQuota({ recruitTotal: 20, options: [{ optKey: 'A', recruitTotal: 20, status: 'active' }] }, 100);
  assert.strictEqual(q.needsFix, true);
  assert.deepStrictEqual(q.fixes.map(f => f.kind).sort(), ['campaign', 'option']);
  assert.strictEqual(q.fixes.find(f => f.kind === 'option').to, 100);
});
t('★ 0(무제한)은 손대지 않는다 — 올리면 무제한이던 공고를 조이는 회귀', () => {
  const q = svc.evaluateQuota({ recruitTotal: 0, options: [{ optKey: 'A', recruitTotal: 0, status: 'active' }] }, 100);
  assert.strictEqual(q.needsFix, false);
  assert.ok(q.skips.some(s => s.kind === 'campaign' && s.reason === 'unlimited'));
  assert.ok(q.skips.some(s => s.kind === 'option' && s.reason === 'unlimited'));
});
t('★ 이미 충분하면 미접촉(정원을 줄이지 않는다)', () => {
  const q = svc.evaluateQuota({ recruitTotal: 200, options: [{ optKey: 'A', recruitTotal: 150, status: 'active' }] }, 100);
  assert.strictEqual(q.needsFix, false);
  assert.ok(q.skips.every(s => s.reason === 'already_enough'));
});
t('★★ 옵션 2개 이상은 자동 배분 금지 — multi_option_manual 로 사람에게 넘긴다', () => {
  const q = svc.evaluateQuota({ recruitTotal: 20, options: [
    { optKey: 'A', recruitTotal: 10, status: 'active' }, { optKey: 'B', recruitTotal: 10, status: 'active' }] }, 100);
  assert.ok(!q.fixes.some(f => f.kind === 'option'), '옵션을 자동으로 배분했다');
  assert.ok(q.skips.some(s => s.reason === 'multi_option_manual' && s.count === 2));
});
t('마감(closed) 옵션은 활성 옵션 판정에서 제외 — 되살리지 않는다', () => {
  const q = svc.evaluateQuota({ recruitTotal: 0, options: [
    { optKey: 'A', recruitTotal: 20, status: 'active' }, { optKey: 'B', recruitTotal: 5, status: 'closed' }] }, 100);
  assert.deepStrictEqual(q.fixes.map(f => f.optKey), ['A']);
});
t('target 0 이면 아무것도 하지 않는다', () => {
  assert.strictEqual(svc.evaluateQuota({ recruitTotal: 20, options: [] }, 0).needsFix, false);
});

/* ══ 4) 백필 — 스텁 pool 실제 실행 ══════════════════════════ */
console.log('\n4) backfillSlots — 추가만 · 멱등 · gid 서버 확정');

// ★ 슬롯 INSERT 는 participants 모듈에 위임되므로 **양쪽 풀을 다 스텁**해야 실제 경로가 돈다
//   (한쪽만 스텁하면 진짜 DB 연결을 시도한다 — 이 테스트가 개발 중 실제로 잡았다).
function backfillPool(existingSeqs, sink) {
  const base = mkDb();
  participants.__setPoolForTest({
    query: async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO campaign_participants/.test(s)) {
        sink.insert = { sql: s, params };
        sink.created = (params.length - 4) / 4;
        return { rowCount: sink.created };
      }
      throw new Error('participants 스텁이 예상 못 한 쿼리: ' + s.slice(0, 60));
    },
  });
  return {
    calls: base.calls,
    query: async (sql, params) => {
      const s = String(sql);
      base.calls.push({ sql: s, params });
      if (/FROM tab_configs tc WHERE tc\.sheet_id/.test(s)) return { rows: [{ tabGid: '278673543', campaignName: '우레온' }] };
      if (/SELECT seq FROM campaign_participants/.test(s)) return { rows: existingSeqs.map(n => ({ seq: n })) };
      if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(s)) return { rows: [{ n: existingSeqs.length + (sink.created || 0) }] };
      return base.query(sql, params);
    },
  };
}
function clearPools() { svc.__setPoolForTest(null); participants.__setPoolForTest(null); }

await ta('★ dryRun 기본 true — 미리보기에서는 INSERT 가 없다', async () => {
  const sink = {}; svc.__setPoolForTest(backfillPool([19, 20], sink));
  const out = await svc.backfillSlots({ sheetId: 'S', tabName: 'T' });
  assert.strictEqual(out.dryRun, true);
  assert.strictEqual(out.missing, 2, '부족 자리 계산이 틀렸다(21,22)');
  assert.strictEqual(out.created, 0);
  assert.ok(!sink.insert, '미리보기가 INSERT 를 실행했다');
  clearPools();
});
await ta('실행(dryRun:false): 빠진 자리만 생성 · seq = 시트 행 번호 · source=worktable', async () => {
  const sink = {}; svc.__setPoolForTest(backfillPool([19, 20], sink));
  const out = await svc.backfillSlots({ sheetId: 'S', tabName: 'T', dryRun: false });
  assert.strictEqual(out.created, 2);
  assert.ok(sink.insert, 'INSERT 가 실행되지 않았다');
  assert.ok(/,21,/.test(sink.insert.sql) && /,22,/.test(sink.insert.sql), 'seq 가 시트 행 번호(21,22)가 아니다');
  assert.ok(!/,1,NULL/.test(sink.insert.sql), 'seq 를 1부터 다시 셌다');
  assert.ok(sink.insert.sql.includes("'worktable'"), "source 가 'worktable' 이 아니다 — 리뷰제출·입금 표시가 안 켜진다");
  assert.ok(/ON CONFLICT \(sheet_id, tab_name, seq\) DO NOTHING/.test(sink.insert.sql), '기존 자리를 덮을 수 있다');
  clearPools();
});
await ta('이미 다 있으면 0건(멱등) — 두 번 눌러도 안전', async () => {
  const sink = {}; svc.__setPoolForTest(backfillPool([19, 20, 21, 22], sink));
  const out = await svc.backfillSlots({ sheetId: 'S', tabName: 'T', dryRun: false });
  assert.strictEqual(out.missing, 0);
  assert.strictEqual(out.created, 0);
  assert.ok(!sink.insert, '빈 목록으로 INSERT 를 날렸다');
  clearPools();
});
await ta('미등록 탭·gid 없음은 사유와 함께 거부(추측해서 진행하지 않는다)', async () => {
  svc.__setPoolForTest({ query: async (s) => /FROM tab_configs tc WHERE/.test(String(s)) ? { rows: [] } : { rows: [] } });
  assert.strictEqual((await svc.backfillSlots({ sheetId: 'S', tabName: 'T' })).error, 'tab_not_registered');
  svc.__setPoolForTest({ query: async (s) => /FROM tab_configs tc WHERE/.test(String(s)) ? { rows: [{ tabGid: null }] } : { rows: [] } });
  assert.strictEqual((await svc.backfillSlots({ sheetId: 'S', tabName: 'T' })).error, 'no_tab_gid');
  clearPools();
});
t('★★ tabGid 는 서버가 tab_configs 에서 구한다 — 호출부 인자로 받지 않는다', () => {
  const i = SRC.indexOf('async function backfillSlots(');
  const sig = SRC.slice(i, SRC.indexOf(')', i));
  assert.ok(!/tabGid/.test(sig), '백필이 클라이언트 gid 를 받는다 — 엉뚱한 탭 행이 이 표로 들어온다');
  const body = SRC.slice(i, SRC.indexOf('\n}', i));
  assert.ok(/FROM tab_configs tc WHERE/.test(body), '서버가 gid 를 다시 구하지 않는다');
});
t('★ 슬롯 INSERT 는 participants 모듈에 위임(campaign_participants 쓰기 소유자 한 곳)', () => {
  assert.ok(SRC.includes('participants.createSlotsFromSheetRows'), '위임하지 않는다');
  assert.ok(!/INSERT INTO campaign_participants/.test(SRC), '서비스가 직접 INSERT 한다 — 쓰기 표면이 늘었다');
});

/* ══ 5) 정원 교정 — 스텁 pool 실제 실행 ═════════════════════ */
console.log('\n5) applyQuotaFix — 서버 재계산 · 연결 검증 · 조건부 UPDATE');

function quotaPool(boardCount, camp, updates) {
  return {
    query: async (sql, params) => {
      const s = String(sql);
      if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(s)) return { rows: [{ n: boardCount }] };
      if (/FROM recruit_campaigns c/.test(s)) return { rows: camp ? [camp] : [] };
      if (/FROM tab_configs WHERE sheet_id/.test(s)) return { rows: [{ gid: null }] };
      if (/UPDATE recruit_campaigns SET recruit_total/.test(s)) { updates.push({ t: 'campaign', params }); return { rowCount: 1 }; }
      if (/UPDATE campaign_options SET recruit_total/.test(s)) { updates.push({ t: 'option', params }); return { rowCount: 1 }; }
      return { rows: [] };
    },
  };
}
const CAMP = {
  id: 'c1', title: '우레온', status: 'active', participationMode: true,
  recruitTotal: 20, dailyLimit: 5, sheetId: 'S', tabGid: '278673543', tabName: 'T',
  options: [{ optKey: 'A', recruitTotal: 20, dailyLimit: 0, status: 'active' }],
};

await ta('★ target 은 서버가 표에서 다시 센다(화면 숫자 불신) + 두 칸 교정', async () => {
  const ups = []; svc.__setPoolForTest(quotaPool(100, CAMP, ups));
  const out = await svc.applyQuotaFix({ sheetId: 'S', tabName: 'T', campaignId: 'c1' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.target, 100, '표 인원을 서버가 다시 세지 않았다');
  assert.strictEqual(ups.length, 2);
  assert.ok(ups.every(u => u.params.includes(100)));
  svc.__setPoolForTest(null);
});
await ta('★★ UPDATE 는 조건부(recruit_total > 0 AND < target) — 남이 올려둔 값·무제한 보호', async () => {
  const ups = []; svc.__setPoolForTest(quotaPool(100, CAMP, ups));
  await svc.applyQuotaFix({ sheetId: 'S', tabName: 'T', campaignId: 'c1' });
  ups.forEach(u => {
    const sqlSeen = u.t === 'campaign' ? /recruit_total > 0 AND recruit_total < \$2/ : /recruit_total > 0 AND recruit_total < \$3/;
    assert.ok(sqlSeen, 'UPDATE 에 보호 조건이 없다');
  });
  const src = SRC.slice(SRC.indexOf('async function applyQuotaFix('));
  assert.ok(/recruit_total > 0 AND recruit_total < \$2/.test(src), '캠페인 UPDATE 보호 조건 없음');
  assert.ok(/recruit_total > 0 AND recruit_total < \$3/.test(src), '옵션 UPDATE 보호 조건 없음');
  assert.ok(!/daily_limit\s*=/.test(src), 'daily_limit 을 건드린다 — 그날 정원은 구매일자 분배가 정한다');
  svc.__setPoolForTest(null);
});
await ta('★ 다른 공고 id 를 보내면 거부(엉뚱한 공고 정원 변경 차단)', async () => {
  const ups = []; svc.__setPoolForTest(quotaPool(100, CAMP, ups));
  const out = await svc.applyQuotaFix({ sheetId: 'S', tabName: 'T', campaignId: 'OTHER' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'campaign_mismatch');
  assert.strictEqual(ups.length, 0, '거부했는데 UPDATE 가 나갔다');
  svc.__setPoolForTest(null);
});
await ta('연결 공고 없음 / 표가 비어 있음 = 사유 반환(조용한 성공 금지)', async () => {
  svc.__setPoolForTest(quotaPool(100, null, []));
  assert.strictEqual((await svc.applyQuotaFix({ sheetId: 'S', tabName: 'T', campaignId: 'c1' })).error, 'campaign_not_linked');
  svc.__setPoolForTest(quotaPool(0, CAMP, []));
  assert.strictEqual((await svc.applyQuotaFix({ sheetId: 'S', tabName: 'T', campaignId: 'c1' })).error, 'empty_board');
  svc.__setPoolForTest(null);
});

/* ══ 6) 전수 점검 ═══════════════════════════════════════════ */
console.log('\n6) auditSheetSuperiority — 분모·1차 거르기·절단 고지');

await ta('시트가 더 많은 작업만 시트 우위로 분류 · 일치는 ok', async () => {
  const base = mkDb();
  svc.__setPoolForTest({
    query: async (sql, params) => {
      const s = String(sql);
      if (/FROM tab_configs tc/.test(s) && /rawRows/.test(s)) return { rows: [
        { sheetId: 'S', tabName: 'T1', tabGid: '1', displayName: '우레온', rawRows: 118, mirroredAt: 'x', boardRows: 2 },
        { sheetId: 'S', tabName: 'T2', tabGid: '2', displayName: '동기화됨', rawRows: 118, mirroredAt: 'x', boardRows: 4 },
        { sheetId: 'S', tabName: 'T3', tabGid: null, displayName: 'gid없음', rawRows: 50, mirroredAt: 'x', boardRows: 0 },
      ] };
      if (/array_agg\(seq\)/.test(s)) return { rows: [
        { sheetId: 'S', tabName: 'T1', seqs: [19, 20] },
        { sheetId: 'S', tabName: 'T2', seqs: [19, 20, 21, 22] },
      ] };
      if (/FROM recruit_campaigns c/.test(s)) return { rows: [] };
      return base.query(sql, params);
    },
  });
  const out = await svc.auditSheetSuperiority({});
  const t1 = out.items.find(i => i.tabName === 'T1'), t2 = out.items.find(i => i.tabName === 'T2');
  assert.strictEqual(t1.severity, 'sheet_ahead');
  assert.strictEqual(t1.missingSlots, 2);
  assert.strictEqual(t1.preparedRows, 4);
  assert.strictEqual(t2.severity, 'ok', '이미 자리가 다 있는 탭이 문제로 잡혔다');
  assert.ok(!out.items.some(i => i.tabName === 'T3'), 'gid 없는 탭을 정밀 스캔했다(대상 아님)');
  assert.strictEqual(out.flagged, 1);
  assert.strictEqual(out.total, 3, '분모가 등록 작업 전체가 아니다');
  svc.__setPoolForTest(null);
});
t('★ 분모는 tab_configs(등록 작업 전체) + 아카이브 제외', () => {
  const i = SRC.indexOf('async function auditSheetSuperiority(');
  const body = SRC.slice(i, SRC.indexOf('\n}', i));
  assert.ok(/FROM tab_configs tc/.test(body), '분모가 tab_configs 가 아니다');
  assert.ok(/is_closed/.test(body), '아카이브 탭 제외가 없다');
  assert.ok(/scanCapped/.test(body), '스캔 절단을 고지하지 않는다(조용한 절단 금지)');
});
t('★ 점검은 읽기 전용 — 쓰기 SQL 0', () => {
  const i = SRC.indexOf('async function auditSheetSuperiority(');
  const body = SRC.slice(i, SRC.indexOf('\nasync function _loadCampaignQuota', i));
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(body), '점검에 쓰기 SQL 이 들어왔다');
});

/* ══ 7) participants 슬롯 생성 ══════════════════════════════ */
console.log('\n7) createSlotsFromSheetRows');

await ta('자리표시자 개수 ≡ 파라미터 개수(컬럼 추가 때 가장 흔히 깨지는 자리)', async () => {
  let cap = null;
  participants.__setPoolForTest({ query: async (sql, params) => { cap = { sql: String(sql), params }; return { rowCount: 2 }; } });
  const out = await participants.createSlotsFromSheetRows({
    sheetId: 'S', tabName: 'T', tabGid: '1', campaignName: 'C',
    rows: [{ seq: 21, optionText: '포토', startDate: '8/4(화)', rowJson: { '구매일자': '8/4(화)' } },
           { seq: 22, optionText: '포토', startDate: '8/5(수)', rowJson: {} }],
  });
  assert.strictEqual(out.created, 2);
  const maxPh = Math.max(...(cap.sql.match(/\$(\d+)/g) || []).map(x => parseInt(x.slice(1), 10)));
  assert.strictEqual(maxPh, cap.params.length, '자리표시자 최대 번호 ≠ 파라미터 개수');
  assert.strictEqual(cap.params.length, 4 + 2 * 4, '행당 파라미터 개수가 4가 아니다');
  participants.__setPoolForTest(null);
});
t('★ source=worktable · ON CONFLICT DO NOTHING · row_json 저장', () => {
  const i = PSRC.indexOf('async function createSlotsFromSheetRows(');
  assert.ok(i > 0, 'createSlotsFromSheetRows 가 없다');
  const body = PSRC.slice(i, PSRC.indexOf('\n}', i));
  assert.ok(body.includes("'worktable'"), "source 가 'worktable' 이 아니다");
  assert.ok(!/'manual'/.test(body), "source='manual' 은 리뷰제출·입금 표시를 영영 막는다");
  assert.ok(/ON CONFLICT \(sheet_id, tab_name, seq\) DO NOTHING/.test(body), '기존 자리를 덮을 수 있다');
  assert.ok(/row_json/.test(body), 'row_json 을 안 넣으면 그리드에 구매일자·리뷰옵션이 안 뜬다');
  // ★ `updated_by`/`updated_at` 컬럼명에 걸리지 않게 SQL 문장 형태로 본다(약한 정규식은 잘못된 이유로 실패한다)
  assert.ok(!/\b(UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(body), '추가만 해야 한다');
});
t('★ 유효하지 않은 seq 는 버린다(0·음수·비정수)', () => {
  const i = PSRC.indexOf('async function createSlotsFromSheetRows(');
  const body = PSRC.slice(i, PSRC.indexOf('\n}', i));
  assert.ok(/Number\.isInteger\(parseInt\(r\.seq, 10\)\)/.test(body) && /> 0/.test(body), 'seq 검증이 없다');
});

/* ══ 8) 라우트 ═════════════════════════════════════════════ */
console.log('\n8) 라우트 권한·기본값');
const router = require('../src/routes/trackB.routes');
const layers = router.stack.filter(l => l.route).map(l => ({
  path: l.route.path, methods: Object.keys(l.route.methods), mw: l.route.stack.map(s => s.name) }));
const audit = layers.find(l => l.path === '/sheet-sync/slot-audit');
const back = layers.find(l => l.path === '/sheet-sync/slot-backfill');
const quota = layers.find(l => l.path === '/sheet-sync/quota-fix');

t('3개 라우트가 등록돼 있다', () => {
  assert.ok(audit && audit.methods.includes('get'), 'GET /sheet-sync/slot-audit 없음');
  assert.ok(back && back.methods.includes('post'), 'POST /sheet-sync/slot-backfill 없음');
  assert.ok(quota && quota.methods.includes('post'), 'POST /sheet-sync/quota-fix 없음');
});
t('★ 전부 authMiddleware + adminOrMasterMiddleware(AE·광고주 차단)', () => {
  [audit, back, quota].forEach(l => {
    assert.ok(l.mw.includes('authMiddleware'), l.path + ': authMiddleware 없음');
    assert.ok(l.mw.includes('adminOrMasterMiddleware'), l.path + ': adminOrMasterMiddleware 없음');
    assert.ok(!l.mw.includes('internalMiddleware'), l.path + ': staff 가 통과한다');
  });
});
t('★★ 백필 기본은 미리보기 — dryRun 이 빠지면 실행하지 않는다(파괴적 기본값 금지)', () => {
  const ROUTES = R('src/routes/trackB.routes.js');
  const i = ROUTES.indexOf("router.post('/sheet-sync/slot-backfill'");
  // ★ 핸들러 경계는 다음 router. 등록까지 — `});` 로 자르면 400 응답의 `});` 에서 잘려
  //   검사하려던 줄이 통째로 빠진다(약한 경계는 잘못된 이유로 통과/실패한다).
  const body = ROUTES.slice(i, ROUTES.indexOf('\nrouter.', i + 10));
  assert.ok(/dryRun:\s*dryRun\s*!==\s*false/.test(body),
    'dryRun 기본값이 미리보기가 아니다 — 값이 빠진 요청이 곧바로 실행된다');
});

/* ══ 9) 프론트 배선 ════════════════════════════════════════ */
console.log('\n9) 프론트(sheet-sync-audit.html)');

t('세 엔드포인트를 호출한다', () => {
  ['/api/trackb/sheet-sync/slot-audit', '/api/trackb/sheet-sync/slot-backfill', '/api/trackb/sheet-sync/quota-fix']
    .forEach(p => assert.ok(HTML.includes(p), p + ' 호출이 없다'));
});
t('★ onclick 은 인덱스만(시트발 탭명·공고명 보간 금지 — 실측 XSS 규율)', () => {
  assert.ok(/slotBackfill\(' \+ i \+ '\)/.test(HTML), '동기화 버튼이 인덱스 방식이 아니다');
  assert.ok(/quotaFix\(' \+ i \+ '\)/.test(HTML), '정원 교정 버튼이 인덱스 방식이 아니다');
  assert.ok(!/slotBackfill\('\s*\+\s*(esc\()?it\./.test(HTML), 'onclick 에 데이터가 보간됐다');
});
t('★ 실행 전 미리보기 → confirm 2단계(조용한 실행 금지)', () => {
  const i = HTML.indexOf('async function slotBackfill(');
  const body = HTML.slice(i, HTML.indexOf('async function quotaFix(', i));
  assert.ok(/dryRun: true/.test(body) && /confirm\(/.test(body) && /dryRun: false/.test(body),
    '미리보기 → 확인 → 실행 2단계가 아니다');
  assert.ok(body.indexOf('dryRun: true') < body.indexOf('confirm('), '확인창이 미리보기보다 먼저다');
});
t('★ 상태·사유를 문장으로 말한다(숫자만 두지 않는다)', () => {
  assert.ok(HTML.includes('SS_REASON') && HTML.includes('QUOTA_SKIP'), '사유 표기 표가 없다');
  assert.ok(HTML.includes('multi_option_manual'), '옵션 2개 이상 사유를 화면이 설명하지 않는다');
  assert.ok(HTML.includes('scanCapped'), '스캔 절단 고지가 없다');
});

console.log('\n✅ 전체 통과: ' + pass + '케이스');
process.exit(0);
})().catch(e => { console.error('\n❌ 실패:', e); process.exit(1); });
