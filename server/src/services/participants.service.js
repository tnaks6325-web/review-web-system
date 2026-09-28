/**
 * ═══════════════════════════════════════════════════════════
 * campaign_participants — 캠페인탭 로스터 DB 원장 (탈-시트 이관 Phase 1 · shadow)
 *
 * ★ 무영향 보장: 이 서비스/테이블은 아직 라이브 소비처가 없다(shadow). 검색·my-status·대시보드는
 *   여전히 review_index를 소스로 사용. 여기서 하는 임포트/토글은 신규 테이블에만 쓰며,
 *   시트·review_index·주문 흐름을 일절 건드리지 않는다. master 전용 테스트용.
 *
 * 백필은 review_index(이미 시트를 파싱해 둔 DB)에서 복사 → 시트 재읽기 0(쿼터 무소모).
 * ═══════════════════════════════════════════════════════════
 */
const { logger } = require('../utils/logger');

let _pool;
function getPool() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

function _mask(phone8) {
  const s = String(phone8 || '');
  return s.length >= 4 ? '••••' + s.slice(-4) : (s || '');
}

// review_index → campaign_participants 임포트(멱등 upsert).
//   dryRun=true면 쓰기 없이 임포트/갱신 예상치만 반환.
//   ★ 재임포트 시 is_submitted/is_paid/source/updated_by는 보존(master가 토글한 값 유지) — 로스터/메타만 갱신.
async function importTabFromIndex({ sheetId, tabName, dryRun = false, by = 'test' } = {}) {
  if (!sheetId || !tabName) throw new Error('importTabFromIndex: sheetId, tabName 필수');
  const db = getPool();

  /* ★★★ 무시트 탭은 이 복사의 **방향이 반대다** — 건너뛴다 (2026-08-23).
     시트 시절 흐름은 `시트 → review_index → 작업표` 였고 이 함수가 마지막 화살표다.
     탈시트 이후 무시트 탭의 진실원본은 **작업표**이고 `review_index` 는 거기서 만들어진다
     (`sheetlessLedger.rebuildLedgers`) → 그대로 두면 **결과물로 원본을 덮는다**.
     실측(프로덕션): 5분 스윕이 고친 번호를 이 복사가 10분마다 되돌렸다(35→23→35→23 반복).
     ★★ 게이트를 **이 함수 안**에 둔다 — 호출부가 넷(투영 크론·동기화 크론·수동 import·수동 sync)이라
       바깥에 두면 한 곳만 빠져도 그 경로로 되돌림이 되살아난다(판정 사본 0).
     ★★ 호출부는 **`skipped` 를 보고 `_reconcileSeen` 을 건너뛰어야 한다** — 임포트를 안 했는데
       그 정리를 돌리면 `imported_at < runStart` 조건에 걸려 그 탭의 `source='import'` 활성 줄이
       **전부 비활성화**된다(이관된 무시트 탭에 그런 줄이 남아 있다).
     ★ 판정은 `utils/sheetlessScope.isSheetless` 단일 출처(조회 실패 = false = 종전 경로).
     ★ 되돌리기: `TRACKB_PROJECT_SHEETLESS=1` 이면 종전처럼 무시트 탭도 임포트한다. */
  if (process.env.TRACKB_PROJECT_SHEETLESS !== '1') {
    const { isSheetless } = require('../utils/sheetlessScope');
    if (await isSheetless(db, sheetId, tabName)) {
      return { skipped: true, reason: 'sheetless', dryRun: !!dryRun, indexRows: 0, inserted: 0, updated: 0 };
    }
  }
  const { rows: idx } = await db.query(
    `SELECT reviewer_name, recipient_name, tab_gid, campaign_name, row_index, is_submitted, is_submitted2,
            submit_col, submit_col2, product_url, product_name, row_json, start_date, end_date, round, phone8
       FROM review_index
      WHERE sheet_id = $1 AND tab_name = $2 AND row_index IS NOT NULL
      ORDER BY row_index`,
    [sheetId, tabName]
  );
  // 실제 삭제한 작업표 행은 재임포트 대상에서 제외한다. 행은 campaign_participants에
  // 남기지 않고, 최소 삭제 식별자만 별도 보관한다.
  const { rows: deleted } = await db.query(
    `SELECT seq FROM workdesk_participant_deletions WHERE sheet_id=$1 AND tab_name=$2`,
    [sheetId, tabName]
  );
  const deletedSeqs = new Set(deleted.map(r => Number(r.seq)));
  const liveIdx = idx.filter(r => !deletedSeqs.has(Number(r.row_index)));

  if (dryRun) {
    const { rows: cur } = await db.query(
      `SELECT COUNT(*)::int AS n FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL`,
      [sheetId, tabName]);
    return {
      dryRun: true, indexRows: liveIdx.length, existingInDb: cur[0].n,
      sample: liveIdx.slice(0, 5).map(r => ({
        seq: r.row_index, reviewerName: r.reviewer_name, phone8: _mask(r.phone8),
        round: r.round, product: r.product_name, submitted: !!r.is_submitted, paid: r.is_submitted2 === 'PAID',
      })),
    };
  }

  let inserted = 0, updated = 0;
  for (const r of liveIdx) {
    const isPaid = r.is_submitted2 === 'PAID';
    const res = await db.query(
      `INSERT INTO campaign_participants
         (sheet_id, tab_gid, tab_name, campaign_name, seq, reviewer_name, recipient_name, phone8, round,
          product_name, product_url, start_date, end_date, is_submitted, is_paid, source,
          sheet_row, submit_col, submit_col2, row_json, imported_at, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'import',$5,$16,$17,$18,NOW(),NOW(),$19)
       ON CONFLICT (sheet_id, tab_name, seq) DO UPDATE SET
         tab_gid = EXCLUDED.tab_gid, campaign_name = EXCLUDED.campaign_name,
         reviewer_name = EXCLUDED.reviewer_name, recipient_name = EXCLUDED.recipient_name,
         phone8 = EXCLUDED.phone8, round = EXCLUDED.round,
         product_name = EXCLUDED.product_name, product_url = EXCLUDED.product_url,
         start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
         submit_col = EXCLUDED.submit_col, submit_col2 = EXCLUDED.submit_col2,
         row_json = EXCLUDED.row_json,
         sheet_row = EXCLUDED.sheet_row,
         -- ★ Phase 4: import 행은 리뷰제출/입금 상태도 review_index에서 최신화(DB를 살아있는 원본화).
         --   campaign_participants.* = 갱신 전(기존행) 값(EXCLUDED=새 행). 기존행 source='import'면 새 상태로,
         --   'manual'(직접 토글/추가)이면 보존. 한 번 손대면 그 행은 통째로 수동관리(컬럼별 provenance 없음).
         --   manual 추가행(seq 900000+)은 애초에 seq 충돌이 없어 여기 안 걸림.
         -- ★★ 'worktable'(작업표가 미리 만든 빈 줄)도 import 처럼 상태를 따라가야 한다 —
         --   'manual' 로 두면 리뷰어가 리뷰를 내도 **리뷰제출·입금 표시가 영영 안 켜진다**
         --   (담당자 눈엔 아무도 리뷰를 안 낸 것처럼 보인다). 사람이 만든 게 아니라
         --   시스템이 자리만 잡아둔 줄이므로 '보존' 대상이 아니다.
         is_submitted = CASE WHEN campaign_participants.source IN ('import','worktable') THEN EXCLUDED.is_submitted ELSE campaign_participants.is_submitted END,
         is_paid      = CASE WHEN campaign_participants.source IN ('import','worktable') THEN EXCLUDED.is_paid      ELSE campaign_participants.is_paid END,
         deleted_at = NULL,
         imported_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [sheetId, r.tab_gid, tabName, r.campaign_name, r.row_index, r.reviewer_name, r.recipient_name, r.phone8, r.round,
       r.product_name, r.product_url, r.start_date, r.end_date, !!r.is_submitted, isPaid,
       r.submit_col || null, r.submit_col2 || null,
       JSON.stringify(r.row_json || {}), String(by).slice(0, 100)]
    );
    if (res.rows[0] && res.rows[0].inserted) inserted++; else updated++;
  }
  return { imported: liveIdx.length, inserted, updated, skippedDeleted: deletedSeqs.size };
}

// shadow 검증: DB 로스터 vs review_index를 seq로 대조(임포트 충실도).
async function compareWithIndex({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) throw new Error('compareWithIndex: sheetId, tabName 필수');
  const db = getPool();
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM review_index ri WHERE ri.sheet_id=$1 AND ri.tab_name=$2 AND ri.row_index IS NOT NULL)::int AS index_rows,
       (SELECT COUNT(*) FROM campaign_participants p WHERE p.sheet_id=$1 AND p.tab_name=$2 AND p.deleted_at IS NULL)::int AS db_rows,
       (SELECT COUNT(*) FROM campaign_participants p JOIN review_index ri
          ON ri.sheet_id=p.sheet_id AND ri.tab_name=p.tab_name AND ri.row_index=p.seq
         WHERE p.sheet_id=$1 AND p.tab_name=$2 AND p.deleted_at IS NULL
           AND COALESCE(p.reviewer_name,'')=COALESCE(ri.reviewer_name,''))::int AS name_match,
       (SELECT COUNT(*) FROM campaign_participants p JOIN review_index ri
          ON ri.sheet_id=p.sheet_id AND ri.tab_name=p.tab_name AND ri.row_index=p.seq
         WHERE p.sheet_id=$1 AND p.tab_name=$2 AND p.deleted_at IS NULL
           AND p.source='manual')::int AS manual_edited`,
    [sheetId, tabName]
  );
  const r = rows[0] || {};
  return {
    indexRows: r.index_rows, dbRows: r.db_rows, nameMatch: r.name_match, manualEdited: r.manual_edited,
    inSync: r.index_rows === r.db_rows && r.name_match === r.db_rows,
  };
}

// ── Phase 4: DB를 "살아있는 원본"으로 — 이미 가져온 탭들을 review_index에서 주기 최신화(시트 재읽기 0). ──
//   라이브 소비처 아직 없음(shadow) → 리뷰어·관리자·시트 무영향. 수동편집 행은 importTabFromIndex가 보존.
//   ⚠️ 주의: PARTICIPANTS_SHEET_MIRROR=1(Phase 2b)과 "동시에" 켜면, 여기서 최신화한 is_submitted/is_paid가
//     이후 mirror-tab 트리거 시 시트 빈칸으로 흐를 수 있다(빈칸-only·비파괴이나 review_index→시트 round-trip).
//     단독(sync만)으로는 시트 무영향. 둘을 함께 쓸 땐 그 흐름을 이해하고 운영할 것.
async function syncImportedTabs({ limit = 200, by = 'auto-sync' } = {}) {
  const db = getPool();
  const { rows: tabs } = await db.query(
    `SELECT sheet_id AS "sheetId", tab_name AS "tabName"
       FROM campaign_participants WHERE deleted_at IS NULL AND source='import'
      GROUP BY sheet_id, tab_name ORDER BY sheet_id, tab_name LIMIT $1`,
    [Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000)]
  );
  let tabsSynced = 0, updated = 0, inserted = 0, errors = 0, skipped = 0;
  for (const t of tabs) {
    try {
      const r = await importTabFromIndex({ sheetId: t.sheetId, tabName: t.tabName, by });
      /* ★ 건너뛴 탭은 "동기화했다" 고 세지 않는다(로그가 사실과 달라진다). */
      if (r && r.skipped) { skipped++; continue; }
      tabsSynced++; updated += r.updated || 0; inserted += r.inserted || 0;
    } catch (e) { errors++; logger.warn(`[participantsSync] ${t.tabName} 실패: ${e.message}`); }
  }
  return { candidateTabs: tabs.length, tabsSynced, inserted, updated, errors, skipped };
}

// 수동(비시트) 줄의 격리 seq 대역 — 실제 행 번호(1~수백)와 겹치지 않게. 새 배정은 하지 않고 **제외** 판정에만 쓴다.
const _MANUAL_SEQ_BASE = 900000;

/**
 * 작업표 스켈레톤 행 — 시트에 만든 빈 줄을 작업대 표에도 미리 보이게 한다. (M2b-2)
 *
 * ★★ **seq = 시트의 실제 행 번호**여야 한다. 이게 어긋나면 주문이 들어올 때
 *   `importTabFromIndex` 의 `ON CONFLICT (sheet_id, tab_name, seq)` 가 제자리 갱신을 못 하고
 *   **새 행을 만들어** 빈 100줄 + 채워진 30줄 = 130줄로 표가 두 겹이 된다.
 *   그래서 `prepareRosterSlots` 의 900000+ 대역을 쓰지 않는다(그건 시트 행을 모를 때용).
 * ★ `source='worktable'` — 투영 업서트가 이 값을 import 처럼 다뤄 리뷰제출·입금 상태를 따라간다.
 *   `_reconcileSeen` 은 'import' 만 비활성화하므로 이 빈 줄들은 투영에도 살아남는다.
 * ★ **ON CONFLICT DO NOTHING** — 같은 작업표를 두 번 만들거나 이미 주문이 들어온 줄이 있으면
 *   기존 행을 절대 건드리지 않는다(멱등·비파괴).
 */
async function createWorktableSlots({ sheetId, tabName, tabGid = null, headerRow, rows = [], productName = null, by = 'system' } = {}) {
  if (!sheetId || !tabName) throw new Error('createWorktableSlots: sheetId, tabName 필수');
  const hr = parseInt(headerRow, 10);
  if (!Number.isInteger(hr) || hr < 1) throw new Error('createWorktableSlots: headerRow 필수(시트 행 번호)');
  const list = (Array.isArray(rows) ? rows : []).slice(0, 2000);
  if (!list.length) return { created: 0 };

  const db = getPool();
  const ph = [], vals = [];
  list.forEach((r, i) => {
    const seq = hr + i + 1;                       // 헤더 바로 아래부터 = 시트 실제 행 번호
    const b = i * 3;
    ph.push(`($1,$2,$3,${seq},NULL,NULL,NULL,NULL,$${b + 4},$${b + 5},'worktable',$${b + 6},NOW())`);
    vals.push(r && r.optionKey ? String(r.optionKey).slice(0, 200) : null, productName || null, String(by).slice(0, 100));
  });
  const { rowCount } = await db.query(
    `INSERT INTO campaign_participants
       (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8, round, option_text, product_name, source, updated_by, updated_at)
     VALUES ${ph.join(',')}
     ON CONFLICT (sheet_id, tab_name, seq) DO NOTHING`,
    [sheetId, tabGid, tabName, ...vals]);
  return { created: rowCount, firstSeq: hr + 1, lastSeq: hr + list.length };
}

/**
 * 시트 준비 행 → 표 슬롯 백필 (시트 우위 동기화 · STEP B)
 *
 * createWorktableSlots 의 형제. 다른 점은 **자리 번호가 연속이 아니라는 것** — 저쪽은 우리가 방금
 * 만든 작업표라 헤더 바로 아래부터 1,2,3… 이지만, 여기는 이미 운영 중인 시트의 준비 행이라
 * 중간이 이미 채워져 있고 빈 자리만 띄엄띄엄이다. 그래서 호출부가 `seq`(시트 실제 행 번호)를 직접 준다.
 *
 * ★★ **seq = 시트 실제 행 번호**(완화 금지) — 어긋나면 그 자리에 주문이 들어올 때
 *   `importTabFromIndex` 의 `ON CONFLICT (sheet_id, tab_name, seq)` 가 제자리 갱신을 못 하고
 *   **새 행을 만들어** 빈 줄과 채워진 줄이 겹쳐 표가 두 겹이 된다.
 * ★ `source='worktable'` — createWorktableSlots 와 같은 값을 쓴다(신규 값 금지).
 *   ① `importTabFromIndex` 의 상태 CASE 가 `source IN ('import','worktable')` 라 리뷰어가 리뷰를
 *   내면 리뷰제출·입금 표시가 정상적으로 켜지고 ② `_reconcileSeen` 은 `source='import'` 만
 *   비활성화하므로 재투영에도 이 빈 줄이 살아남는다. 'manual' 로 두면 ①이 영영 안 켜진다.
 * ★ `row_json` = 시트 헤더명→값 맵 — `importTabFromIndex` 가 review_index 에서 넣는 것과 **같은 모양**.
 *   그래서 작업보드 그리드가 구매일자·리뷰옵션 같은 시트 칸을 채워진 행과 똑같이 그린다.
 * ★ **ON CONFLICT DO NOTHING** — 이미 있는 자리는 절대 덮지 않는다(비파괴·멱등, 두 번 눌러도 안전).
 */
async function createSlotsFromSheetRows({ sheetId, tabName, tabGid = null, campaignName = null, rows = [], by = 'sheet-slot-sync' } = {}) {
  if (!sheetId || !tabName) throw new Error('createSlotsFromSheetRows: sheetId, tabName 필수');
  const list = (Array.isArray(rows) ? rows : [])
    .filter(r => r && Number.isInteger(parseInt(r.seq, 10)) && parseInt(r.seq, 10) > 0)
    .slice(0, 2000);
  if (!list.length) return { created: 0, requested: 0 };

  const db = getPool();
  const ph = [], vals = [];
  list.forEach((r, i) => {
    const seq = parseInt(r.seq, 10);
    const b = i * 4;
    // 고정 4개($1~$4) 뒤로 행마다 4개(option_text, start_date, row_json, updated_by)
    ph.push(`($1,$2,$3,$4,${seq},NULL,NULL,NULL,NULL,$${b + 5},$${b + 6},$${b + 7}::jsonb,'worktable',$${b + 8},NOW())`);
    vals.push(
      r.optionText ? String(r.optionText).slice(0, 200) : null,
      r.startDate ? String(r.startDate).slice(0, 100) : null,
      JSON.stringify(r.rowJson && typeof r.rowJson === 'object' ? r.rowJson : {}),
      String(by).slice(0, 100)
    );
  });
  const { rowCount } = await db.query(
    `INSERT INTO campaign_participants
       (sheet_id, tab_gid, tab_name, campaign_name, seq, reviewer_name, recipient_name, phone8, round,
        option_text, start_date, row_json, source, updated_by, updated_at)
     VALUES ${ph.join(',')}
     ON CONFLICT (sheet_id, tab_name, seq) DO NOTHING`,
    [sheetId, tabGid, tabName, campaignName, ...vals]);
  return { created: rowCount, requested: list.length };
}

/**
 * 빈 자리가 없을 때 작업표에 **줄을 하나 이어붙인다**(무시트 전용).
 *
 * ★★ 왜 필요한가: 무시트 공고는 준비된 빈 슬롯이 동나면 `no_open_slot` 으로 주문이 미반영이
 *   되어 "결제는 했는데 작업보드 어디에도 없는" 주문이 남고, 복구 잡이 같은 실패를 반복했다.
 *   작업표가 진실원본인 지금은 **확정된 주문에는 줄이 있어야 한다** — 그래서 이어붙인다.
 * ★★ `seq` 는 **`MAX(seq)+1`(삭제된 줄도 세어 재사용하지 않는다)** — 번호를 재사용하면
 *   `(sheet_id, tab_name, seq)` 키가 충돌해 표가 두 겹이 된다.
 *   ★ 단 **실제 행 번호 대역(< 900000)만** 센다 — 과거에 잘못 들어간 900000 대역(수동 격리
 *   대역) 줄이 하나라도 있으면 그 뒤(900001+)로 이어붙어 모든 새 주문이 90만 대역으로 밀린다.
 * ★ `client` 를 받는다 — 호출부(주문 기록)의 트랜잭션·탭 advisory 락 안에서 실행되어야
 *   동시 주문 두 건이 같은 번호를 집지 않는다.
 * ★ `source='worktable'` — 'manual' 로 넣으면 투영의 상태 CASE 가 인정하지 않아
 *   리뷰제출·입금 표시가 영영 안 켜진다.
 */
async function appendSlot(client, { sheetId, tabName, tabGid = null, campaignName = null, rowJson = {}, workboardId = null, by = 'sheetless-append' } = {}) {
  if (!client || !sheetId || !tabName) throw new Error('appendSlot: client, sheetId, tabName 필수');
  const { rows } = await client.query(
    `INSERT INTO campaign_participants
       (sheet_id, tab_gid, tab_name, campaign_name, seq, row_json, workboard_id, source, updated_by, updated_at)
     SELECT $1, $2, $3, $4, COALESCE(MAX(seq) FILTER (WHERE seq < ${_MANUAL_SEQ_BASE}), 0) + 1, $5::jsonb, $6::uuid, 'worktable', $7, NOW()
       FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $3
     ON CONFLICT (sheet_id, tab_name, seq) DO NOTHING
     RETURNING id, seq, row_json`,
    [sheetId, tabGid, tabName, campaignName,
     JSON.stringify(rowJson && typeof rowJson === 'object' ? rowJson : {}), workboardId, String(by).slice(0, 100)]);
  return rows[0] || null;
}

/**
 * 가져오기 되돌리기 전용 — 그 탭의 표 줄을 **하드 삭제**한다.
 *
 * ★★ 왜 하드인가: "시트에서 가져오기"의 되돌리기는 **가져오기 전 상태로 복귀**하는 것이고,
 *   그때 `tab_configs` 등록까지 지우므로 소프트로 남기면 등록 없는 유령 줄만 떠돈다.
 *   (평상시 정리는 소프트인 `retireRows` 가 맡는다 — 그쪽을 바꾸지 말 것. `deleteWorktableRows` 는 2026-09-28 제거 — 결정 186 10번.)
 * ★★ **주문이 붙은 줄이 있으면 호출부가 이미 거부**한 뒤다(sheetImport.revertImport 의 fail-closed 게이트).
 *   여기서도 마지막 방어로 `order_submission_id IS NULL` 을 걸어 **주문이 붙은 줄은 절대 지우지 않는다**.
 * ★ `client` 를 받는다 — 등록·장부 삭제와 **같은 트랜잭션**이어야 반쯤 지워진 상태가 남지 않는다.
 */
async function purgeImportedRows(client, { sheetId, tabName } = {}) {
  if (!client || !sheetId || !tabName) throw new Error('purgeImportedRows: client, sheetId, tabName 필수');
  const { rowCount } = await client.query(
    `DELETE FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND order_submission_id IS NULL`,
    [sheetId, tabName]);
  return rowCount;
}

/* 정리(은퇴) 대상 선정 조건 — 조회·삭제가 **같은 조건**을 써야 미리보기와 결과가 갈리지 않는다.
   ★ 차수는 빈 값('(빈값)')도 고를 수 있어야 하므로 정규화해서 비교한다. */
const _RETIRE_WHERE = `sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
   AND (COALESCE(NULLIF(btrim(round), ''), '') = ANY($3::text[]) OR seq = ANY($4::int[]))`;

/**
 * 표에서 고른 줄 내리기(소프트) — 차수 또는 seq 로 지정.
 *
 * ★ `campaign_participants` 쓰기는 이 모듈이 소유한다(쓰기 소유자 규율) — 호출부(무시트 장부)는
 *   게이트·장부 재생성만 맡고 여기를 부른다.
 * ★ 하드삭제 아님(`deleted_at`) — 되돌릴 수 있고 주문 원장·시트는 건드리지 않는다.
 * ★ dryRun 은 **쓰기 0** — 같은 조건으로 세어 보기만 한다.
 */
async function retireRows({ sheetId, tabName, rounds = [], seqs = [], dryRun = true, by = 'admin' } = {}) {
  if (!sheetId || !tabName) throw new Error('retireRows: sheetId, tabName 필수');
  const db = getPool();
  const rndList = (Array.isArray(rounds) ? rounds : []).map(r => String(r == null ? '' : r).trim()).slice(0, 200);
  const seqList = (Array.isArray(seqs) ? seqs : [])
    .map(n => parseInt(n, 10)).filter(n => Number.isFinite(n)).slice(0, 5000);
  if (!rndList.length && !seqList.length) return { ok: false, reason: 'empty' };

  const { rows: hit } = await db.query(
    `SELECT seq, reviewer_name AS name, round, is_submitted AS submitted, is_paid AS paid,
            order_submission_id IS NOT NULL AS "hasOrder"
       FROM campaign_participants WHERE ${_RETIRE_WHERE} ORDER BY seq`,
    [sheetId, tabName, rndList, seqList]);
  const { rows: cur } = await db.query(
    `SELECT COUNT(*)::int AS n FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL`, [sheetId, tabName]);

  const stat = {
    ok: true, matched: hit.length,
    named: hit.filter(r => String(r.name || '').trim()).length,
    submitted: hit.filter(r => r.submitted).length,
    paid: hit.filter(r => r.paid).length,
    withOrder: hit.filter(r => r.hasOrder).length,
    boardRows: cur[0].n, boardAfter: cur[0].n - hit.length,
    sample: hit.slice(0, 20).map(r => ({ seq: r.seq, name: r.name || '', round: r.round || '' })),
  };
  if (dryRun) return { ...stat, dryRun: true };
  if (!hit.length) return { ...stat, retired: 0 };

  const { rowCount } = await db.query(
    `UPDATE campaign_participants
        SET deleted_at = NOW(), active = FALSE, updated_by = $5, updated_at = NOW()
      WHERE ${_RETIRE_WHERE}`, [sheetId, tabName, rndList, seqList, String(by).slice(0, 100)]);
  return { ...stat, retired: rowCount };
}

// 프리뷰 탭 셀렉터용 활성 캠페인 탭 목록(master 전용 라우트에서 사용 — /api/raw/tabs 의존 제거).
async function listActiveTabs({ limit = 500 } = {}) {
  const db = getPool();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000);
  const { rows } = await db.query(
    /* ★ sheetless — 화면이 "이 작업은 구글시트를 안 쓴다"고 말하기 위한 재료(탈 구글시트 W3-b).
       없으면 담당자가 어느 작업이 이관됐는지 화면만 봐서는 알 수 없고, 시트를 찾으러 간다.
       ★ tab_configs 는 이미 등록 게이트라 LEFT JOIN 이 행을 늘리지 않는다(탭당 1행 PK). */
    /*
     * 시트 기반 작업은 마지막 RAW 미러 + 활성 index_master가 목록의 진실원본이다.
     * 그러나 탈시트 전환 후에는 그 두 장부가 일시적으로 비어 있거나 재생성에 실패해도
     * tab_configs.sheetless=true 자체가 "작업표로 전환된 진행 작업"이라는 확정 기록이다.
     * 이 전환 작업을 RAW 경로에만 의존시키면 홈·작업보드에서 통째로 사라진다.
     *
     * raw_tabs가 이미 보이는 경우에는 기존 시트 제목·행 수를 그대로 우선한다. 보충 경로는
     * 마감되지 않은 sheetless 탭만 대상으로 하고 raw_tabs와 키가 겹치면 제외하므로 중복·마감
     * 작업의 재노출 없이, 이관 직후에도 작업목록에 안정적으로 남는다.
     */
    `WITH raw_tabs AS (
       SELECT rst.sheet_id AS "sheetId", rst.spreadsheet_title AS "spreadsheetTitle",
            rst.tab_gid AS "tabGid", rst.tab_name AS "tabName", rst.row_count AS "rowCount",
            COALESCE(tc.sheetless, FALSE) AS "sheetless",
            /* ★ workKind — [＋ 블로거 추가] 버튼을 어느 작업에 보일지(M5-2). tab_configs 는 이미
               조인돼 있어 **쿼리 순증 0**. 판정 최종 권한은 서버(공고 > 탭)이고 이 값은 표시용 힌트다 —
               그래서 화면은 'review' 로 **명시된** 작업만 숨기고 빈 값(미지정)은 열어 둔다(모르는 것을 단정하지 않는다). */
            COALESCE(tc.work_kind, '') AS "workKind",
            /* ★ displayName — 화면이 그리는 **작업명**(헤더 옆 ✏️ 로 편집하는 그 값).
               종전에는 목록에 안 실려 작업바·검색·홈 목록·업체관리가 전부 **탭 이름**밖에 못 써서,
               같은 작업이 작업보드 제목과 목록에서 다른 이름으로 보였다(실측: 「맛고」↔「0720수진코리아고양이캔」).
               ★ 빈 값이면 화면이 종전대로 탭 이름으로 접는다(이름이 비는 일은 없다).
               ★ 두 CTE 는 UNION ALL(SELECT *) 이라 **칸 순서가 같아야 한다** — 한쪽만 넣으면 값이 밀린다. */
            COALESCE(tc.display_name, '') AS "displayName",
            /* 최신 작업 정렬은 동기화 시각이 아니라 최초 관측 시각을 쓴다.
               업체관리의 생성 최신순 근사와 같은 원천이며, 활성 탭 키 인덱스로만 좁힌다. */
            COALESCE((SELECT MIN(cp.first_seen_at)
                        FROM campaign_participants cp
                       WHERE cp.sheet_id = rst.sheet_id AND cp.tab_name = rst.tab_name
                         AND cp.deleted_at IS NULL), rst.mirrored_at) AS "firstSeenAt"
       FROM raw_sheet_tabs rst
       LEFT JOIN tab_configs tc ON tc.sheet_id = rst.sheet_id AND tc.tab_name = rst.tab_name
      WHERE rst.is_system_tab = FALSE
        AND EXISTS (SELECT 1 FROM index_master im
                     WHERE im.status='active' AND im.sheet_id=rst.sheet_id
                       AND (im.tab_gid=rst.tab_gid OR im.tab_name=rst.tab_name))
     ), sheetless_tabs AS (
       SELECT tc.sheet_id AS "sheetId",
              COALESCE(NULLIF(tc.campaign_name, ''), NULLIF(tc.display_name, ''), tc.tab_name) AS "spreadsheetTitle",
              tc.tab_gid AS "tabGid", tc.tab_name AS "tabName", COALESCE(im.row_count, 0) AS "rowCount",
              TRUE AS "sheetless", COALESCE(tc.work_kind, '') AS "workKind",
              COALESCE(tc.display_name, '') AS "displayName",
              COALESCE((SELECT MIN(cp.first_seen_at)
                        FROM campaign_participants cp
                       WHERE cp.sheet_id = tc.sheet_id AND cp.tab_name = tc.tab_name
                         AND cp.deleted_at IS NULL), tc.sheetless_at, tc.updated_at) AS "firstSeenAt"
         FROM tab_configs tc
         LEFT JOIN index_master im ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
        WHERE COALESCE(tc.sheetless, FALSE) = TRUE
          AND COALESCE(tc.is_closed, FALSE) = FALSE
     )
     SELECT * FROM raw_tabs
     UNION ALL
     SELECT sl.* FROM sheetless_tabs sl
      WHERE NOT EXISTS (
        SELECT 1 FROM raw_tabs r
         WHERE r."sheetId" = sl."sheetId" AND r."tabName" = sl."tabName"
      )
     ORDER BY "spreadsheetTitle", "tabName" LIMIT $1`,
    [lim]
  );
  return rows;
}

/* ══════════════════════════════════════════════════════════════════
   표에서 분리(보관) — 2026-08-19 사용자 확정 "표에서만 빼기"
   ──────────────────────────────────────────────────────────────────
   왜: 중복 반영으로 생긴 줄 중 **이체 근거가 걸려 지울 수 없는 줄**(입금 회차에 담김)이
   작업표에 남아 매일 눈에 걸린다. 그렇다고 지우면(soft delete) 그 줄이 들고 있던 입금 표시가
   표에서 사라져 **남길 줄이 미입금으로 보이고 다음 회차에 다시 담겨 이중 송금**이 난다.
   ★★ 그래서 이건 **삭제가 아니라 화면 분리**다 — `deleted_at` 을 건드리지 않는다.
      장부 재생성·리뷰어 검색·입금대상 추출은 `deleted_at` 만 보므로 **한 글자도 안 바뀐다**.
   ★ 되돌리기가 기본(`hold:false`) · 누가 왜 분리했는지 남긴다.
   ★ 쓰기 소유자 규율 — `campaign_participants` 쓰기는 이 서비스가 한다.
   ══════════════════════════════════════════════════════════════════ */
async function holdRows({ sheetId, tabName, seqs, hold = true, reason = '', by = 'admin' } = {}) {
  if (!sheetId || !tabName) throw new Error('holdRows: sheetId, tabName 필수');
  const list = [...new Set((Array.isArray(seqs) ? seqs : []).map(v => parseInt(v, 10))
    .filter(n => Number.isInteger(n) && n > 0))];
  if (!list.length) return { ok: false, reason: 'empty', changed: 0 };
  const db = getPool();
  const { rowCount } = hold
    ? await db.query(
      `UPDATE campaign_participants
          SET held_at = NOW(), held_reason = LEFT($4, 300), held_by = LEFT($5, 100), updated_at = NOW()
        WHERE sheet_id = $1 AND tab_name = $2 AND seq = ANY($3::int[])
          AND deleted_at IS NULL AND held_at IS NULL`,
      [sheetId, tabName, list, String(reason || ''), String(by || 'admin')])
    : await db.query(
      `UPDATE campaign_participants
          SET held_at = NULL, held_reason = NULL, held_by = NULL, updated_at = NOW()
        WHERE sheet_id = $1 AND tab_name = $2 AND seq = ANY($3::int[])
          AND deleted_at IS NULL AND held_at IS NOT NULL`,
      [sheetId, tabName, list]);
  return { ok: true, changed: rowCount, hold: !!hold, seqs: list };
}

/** 분리된 줄 목록(보관함) — 읽기 전용. 되돌릴 때 사람이 무엇을 되돌리는지 보게 한다. */
async function listHeldRows({ sheetId, tabName, limit = 300 } = {}) {
  if (!sheetId || !tabName) throw new Error('listHeldRows: sheetId, tabName 필수');
  const { rows } = await getPool().query(
    `SELECT seq, reviewer_name AS name, recipient_name AS recipient, phone8,
            held_at AS "heldAt", held_reason AS "heldReason", held_by AS "heldBy",
            COALESCE(is_submitted, FALSE) AS submitted, COALESCE(is_paid, FALSE) AS paid,
            row_json AS "rowJson"
       FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND held_at IS NOT NULL
      ORDER BY seq
      LIMIT $3`, [sheetId, tabName, Math.min(Math.max(parseInt(limit, 10) || 300, 1), 1000)]);
  return rows;
}

module.exports = {
  holdRows, listHeldRows,
  createWorktableSlots, createSlotsFromSheetRows, appendSlot, retireRows,
  purgeImportedRows,
  importTabFromIndex,
  syncImportedTabs,
  compareWithIndex,
  listActiveTabs,
  MANUAL_SEQ_BASE: _MANUAL_SEQ_BASE,
  __setPoolForTest,
};
