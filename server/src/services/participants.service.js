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
  /* ★★ 무시트 탭의 `row_json` 은 **작업표가 진실원본**이고 `review_index` 는 그 파생물이다(130).
     되임포트하면 A→B→A 순환이라 정보 이득이 0인데, 장부 재생성이 늦은 순간에는
     **작업보드 편집을 옛 값으로 덮는다**(10분 뒤 조용한 롤백).
     ★ 동결 대상은 `row_json` **한 칸뿐** — 신원 컬럼은 row_json 파생이라 동결하면 오히려 스테일이 된다.
     ★ 판정 실패는 종전 경로(fail-open). */
  let sheetless = false;
  try { sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName); } catch (_) {}
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
         row_json = CASE WHEN $20 THEN campaign_participants.row_json ELSE EXCLUDED.row_json END,
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
       JSON.stringify(r.row_json || {}), String(by).slice(0, 100), sheetless]
    );
    if (res.rows[0] && res.rows[0].inserted) inserted++; else updated++;
  }
  return { imported: liveIdx.length, inserted, updated, skippedDeleted: deletedSeqs.size };
}

// 탭 로스터 조회(DB). phone8은 마스킹.
async function listParticipants({ sheetId, tabName, limit = 1000 } = {}) {
  if (!sheetId || !tabName) throw new Error('listParticipants: sheetId, tabName 필수');
  const db = getPool();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 5000);
  const { rows } = await db.query(
    `SELECT id, seq, reviewer_name AS "reviewerName", recipient_name AS "recipientName",
            phone8, round, option_text AS "optionText", product_name AS "productName",
            is_submitted AS "isSubmitted", is_paid AS "isPaid", source,
            updated_at AS "updatedAt", updated_by AS "updatedBy"
       FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
      ORDER BY seq LIMIT $3`,
    [sheetId, tabName, lim]
  );
  return rows.map(r => ({ ...r, phone8: _mask(r.phone8) }));
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

// 테스트용 상태 토글(신규 테이블에만 — 시트/review_index 미변경). source='manual'로 표시.
async function setParticipantStatus({ id, isSubmitted, isPaid, by = 'test' } = {}) {
  if (!id) throw new Error('setParticipantStatus: id 필수');
  const db = getPool();
  const sets = ['updated_at = NOW()', 'updated_by = $2', "source = 'manual'"];
  const vals = [id, String(by).slice(0, 100)];
  if (typeof isSubmitted === 'boolean') { vals.push(isSubmitted); sets.push(`is_submitted = $${vals.length}`); sets.push(`submitted_at = ${isSubmitted ? 'NOW()' : 'NULL'}`); }
  if (typeof isPaid === 'boolean') { vals.push(isPaid); sets.push(`is_paid = $${vals.length}`); sets.push(`paid_at = ${isPaid ? 'NOW()' : 'NULL'}`); }
  const { rows } = await db.query(
    `UPDATE campaign_participants SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL
     RETURNING id, is_submitted AS "isSubmitted", is_paid AS "isPaid"`, vals);
  if (!rows.length) return { updated: 0 };
  return { updated: 1, ...rows[0] };
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
  let tabsSynced = 0, updated = 0, inserted = 0, errors = 0;
  for (const t of tabs) {
    try {
      const r = await importTabFromIndex({ sheetId: t.sheetId, tabName: t.tabName, by });
      tabsSynced++; updated += r.updated || 0; inserted += r.inserted || 0;
    } catch (e) { errors++; logger.warn(`[participantsSync] ${t.tabName} 실패: ${e.message}`); }
  }
  return { candidateTabs: tabs.length, tabsSynced, inserted, updated, errors };
}

// ── Phase 2a: 참여자 직접 추가/수정/삭제 (여전히 신규 테이블만 — 라이브·시트 무영향) ──
function _toPhone8(v) { const d = String(v == null ? '' : v).replace(/[^0-9]/g, ''); return d.length >= 8 ? d.slice(-8) : (d || null); }

// 수동 추가: import 행(seq=row_index, 보통 1~수백)과 절대 충돌 안 하게 seq를 900000+ 범위로 배정.
const _MANUAL_SEQ_BASE = 900000;
async function addParticipant({ sheetId, tabName, reviewerName, recipientName, phone, round, optionText, productName, by = 'test' } = {}) {
  if (!sheetId || !tabName) throw new Error('addParticipant: sheetId, tabName 필수');
  const db = getPool();
  // 동시 add가 같은 nextSeq를 계산해도 uq_participants_seq(sheet_id,tab_name,seq)가 중복행을 차단한다.
  //   23505(유니크 위반) 시 seq를 재계산해 재시도(advisory 락 불필요 — 예방 대신 회복, 동일 정확성).
  for (let attempt = 0; ; attempt++) {
    const { rows: meta } = await db.query(
      `SELECT COALESCE(MAX(seq) FILTER (WHERE seq >= ${_MANUAL_SEQ_BASE}), ${_MANUAL_SEQ_BASE - 1}) + 1 AS nextseq,
              (SELECT tab_gid FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND tab_gid IS NOT NULL LIMIT 1) AS tab_gid
         FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2`,
      [sheetId, tabName]
    );
    const nextSeq = meta[0].nextseq;
    const tabGid = meta[0].tab_gid || null;
    try {
      const { rows } = await db.query(
        `INSERT INTO campaign_participants
           (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8, round, option_text, product_name, source, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual',$11,NOW())
         RETURNING id, seq`,
        [sheetId, tabGid, tabName, nextSeq, reviewerName || null, recipientName || null, _toPhone8(phone),
         round || null, optionText || null, productName || null, String(by).slice(0, 100)]
      );
      return { added: 1, id: rows[0].id, seq: rows[0].seq };
    } catch (e) {
      if (e && e.code === '23505' && attempt < 4) continue;   // seq 레이스 → 재계산 재시도
      throw e;
    }
  }
}

// 발주 기준 명단 골격(빈 슬롯) 벌크 생성 — 부족분(target − 현재 활성)만큼 manual 슬롯을 원자 배정.
//   ★ B 내부 전용(구글시트·주문 무접촉), gap-fill·멱등(이미 target 충족이면 0개). seq 레이스는 23505 재시도.
//   슬롯 = reviewer 공란 + option_text(옵션 라운드로빈)·product_name(발주 상품) 프리필. 재투영에 면역(source='manual').
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
 * ★ `client` 를 받는다 — 호출부(주문 기록)의 트랜잭션·탭 advisory 락 안에서 실행되어야
 *   동시 주문 두 건이 같은 번호를 집지 않는다.
 * ★ `source='worktable'` — 'manual' 로 넣으면 투영의 상태 CASE 가 인정하지 않아
 *   리뷰제출·입금 표시가 영영 안 켜진다.
 */
async function appendSlot(client, { sheetId, tabName, tabGid = null, campaignName = null, rowJson = {}, by = 'sheetless-append' } = {}) {
  if (!client || !sheetId || !tabName) throw new Error('appendSlot: client, sheetId, tabName 필수');
  const { rows } = await client.query(
    `INSERT INTO campaign_participants
       (sheet_id, tab_gid, tab_name, campaign_name, seq, row_json, source, updated_by, updated_at)
     SELECT $1, $2, $3, $4, COALESCE(MAX(seq), 0) + 1, $5::jsonb, 'worktable', $6, NOW()
       FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $3
     ON CONFLICT (sheet_id, tab_name, seq) DO NOTHING
     RETURNING id, seq, row_json`,
    [sheetId, tabGid, tabName, campaignName,
     JSON.stringify(rowJson && typeof rowJson === 'object' ? rowJson : {}), String(by).slice(0, 100)]);
  return rows[0] || null;
}

/**
 * 가져오기 되돌리기 전용 — 그 탭의 표 줄을 **하드 삭제**한다.
 *
 * ★★ 왜 하드인가: "시트에서 가져오기"의 되돌리기는 **가져오기 전 상태로 복귀**하는 것이고,
 *   그때 `tab_configs` 등록까지 지우므로 소프트로 남기면 등록 없는 유령 줄만 떠돈다.
 *   (평상시 정리는 소프트인 `deleteWorktableRows`/`retireRows` 가 맡는다 — 그쪽을 바꾸지 말 것.)
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

/**
 * 작업표 되돌리기 — 작업대 표에서 그 탭의 줄을 내린다. (시트는 건드리지 않는다)
 *
 * ★ 주문이 들어온 줄이 있으면 **바로 지우지 않고 목록을 돌려준다**(사용자 확정):
 *   담당자가 "내부에서 진행한 테스트건"임을 확인한 뒤 `confirmed:true` 로 다시 부르면 최종 삭제.
 * ★ 삭제는 **소프트**(`deleted_at`) — 이력이 남는다. 그리고 **주문 원장은 건드리지 않는다**
 *   (여기서 지우는 것은 작업대 표의 줄일 뿐, 실제 주문 기록·시트는 그대로다).
 */
async function deleteWorktableRows({ sheetId, tabName, confirmed = false, by = 'admin' } = {}) {
  if (!sheetId || !tabName) throw new Error('deleteWorktableRows: sheetId, tabName 필수');
  const db = getPool();
  const { rows: withOrder } = await db.query(
    `SELECT seq, recipient_name AS "recipient", phone8, order_submission_id IS NOT NULL AS "hasOrder"
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL
        AND (order_submission_id IS NOT NULL OR phone8 IS NOT NULL)
      ORDER BY seq LIMIT 200`, [sheetId, tabName]);
  if (withOrder.length && !confirmed) {
    return { ok: false, needsConfirm: true, filledCount: withOrder.length, filled: withOrder };
  }
  const { rowCount } = await db.query(
    `UPDATE campaign_participants
        SET deleted_at = NOW(), active = FALSE, updated_by = $3, updated_at = NOW()
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL`, [sheetId, tabName, String(by).slice(0, 100)]);
  return { ok: true, deleted: rowCount, hadFilled: withOrder.length };
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

/**
 * 시트에서 이미 사라진 줄 은퇴 — 이관(cutover) 직후 1회.
 *
 * 왜: 마지막 반영의 투영이 `_reconcileSeen` 으로 **시트에 더는 없는 import 줄**을 `active = FALSE` 로
 * 내려놓는데, 뒤이은 장부 재생성은 `deleted_at` 만 보므로 그 줄들을 검색 명단으로 되살렸다
 * (실측 2026-08-07 쿠팡(26년): 50명 → 216명). 이관은 "시트 실물을 그대로 승계"하는 것이므로
 * 여기서 소프트 삭제로 승격시킨다.
 * ★ `source='import'` 만 — 준비 자리(`worktable`)·수기 추가(`manual`)는 seen-set 대상이 아니라
 *   비활성이 될 수 없고, 건드리면 빈 슬롯이 통째로 사라진다.
 */
async function retireInactiveImportRows({ sheetId, tabName, by = 'cutover' } = {}) {
  if (!sheetId || !tabName) throw new Error('retireInactiveImportRows: sheetId, tabName 필수');
  const { rowCount } = await getPool().query(
    `UPDATE campaign_participants
        SET deleted_at = NOW(), updated_by = $3, updated_at = NOW()
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
        AND source = 'import' AND active = FALSE`,
    [sheetId, tabName, String(by).slice(0, 100)]);
  return { ok: true, rows: rowCount };
}

async function prepareRosterSlots({ sheetId, tabName, target, options = [], productName = null, by = 'system' } = {}) {
  if (!sheetId || !tabName) throw new Error('prepareRosterSlots: sheetId, tabName 필수');
  const tgt = Math.max(0, Math.min(parseInt(target, 10) || 0, 2000));   // 상한(폭주 방지)
  const db = getPool();
  for (let attempt = 0; ; attempt++) {
    const { rows: meta } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL AND active = TRUE)::int AS cur,
              COALESCE(MAX(seq) FILTER (WHERE seq >= ${_MANUAL_SEQ_BASE}), ${_MANUAL_SEQ_BASE - 1}) + 1 AS nextseq,
              (SELECT tab_gid FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND tab_gid IS NOT NULL LIMIT 1) AS tab_gid
         FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2`,
      [sheetId, tabName]);
    const cur = meta[0].cur, startSeq = meta[0].nextseq, tabGid = meta[0].tab_gid || null;
    const need = Math.max(0, tgt - cur);
    if (!need) return { target: tgt, current: cur, created: 0 };
    // (seq, reviewer=NULL, recipient=NULL, phone8=NULL, round=NULL, option, product, 'manual', by)
    const vals = [], ph = [];
    const opts = Array.isArray(options) ? options.filter(o => o != null && String(o).trim()) : [];
    for (let i = 0; i < need; i++) {
      const opt = opts.length ? String(opts[i % opts.length]).slice(0, 200) : null;
      const b = i * 3;   // 슬롯당 파라미터 3개(option, product, by) — 고정 $1~$3(sheet/gid/tab) 뒤에 이어붙음
      ph.push(`($1,$2,$3,${startSeq + i},NULL,NULL,NULL,NULL,$${b + 4},$${b + 5},'manual',$${b + 6},NOW())`);
      vals.push(opt, productName || null, String(by).slice(0, 100));
    }
    try {
      await db.query(
        `INSERT INTO campaign_participants
           (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8, round, option_text, product_name, source, updated_by, updated_at)
         VALUES ${ph.join(',')}`,
        [sheetId, tabGid, tabName, ...vals]);
      return { target: tgt, current: cur, created: need };
    } catch (e) {
      if (e && e.code === '23505' && attempt < 4) continue;   // seq 레이스 → 재계산 재시도
      throw e;
    }
  }
}

const _EDITABLE_FIELDS = ['reviewer_name', 'recipient_name', 'phone8', 'round', 'option_text', 'product_name'];
async function updateParticipant({ id, fields, by = 'test' } = {}) {
  if (!id) throw new Error('updateParticipant: id 필수');
  const db = getPool();
  const clean = {};
  for (const k of Object.keys(fields || {})) {
    if (!_EDITABLE_FIELDS.includes(k)) continue;               // 화이트리스트(인젝션 방어)
    clean[k] = k === 'phone8' ? _toPhone8(fields[k]) : (fields[k] == null ? null : String(fields[k]));
  }
  const cols = Object.keys(clean);
  if (!cols.length) return { updated: 0, reason: 'no_editable_fields' };
  const vals = [id, ...cols.map(c => clean[c])];
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);           // c는 화이트리스트라 인젝션 불가
  const { rows } = await db.query(
    `UPDATE campaign_participants SET ${sets.join(', ')}, source='manual', updated_at=NOW(), updated_by=$${vals.length + 1}
       WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
    [...vals, String(by).slice(0, 100)]
  );
  return { updated: rows.length };
}

async function softDeleteParticipant({ id, by = 'test' } = {}) {
  if (!id) throw new Error('softDeleteParticipant: id 필수');
  const db = getPool();
  const { rows } = await db.query(
    `UPDATE campaign_participants SET deleted_at=NOW(), updated_at=NOW(), updated_by=$2
       WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
    [id, String(by).slice(0, 100)]
  );
  return { deleted: rows.length };
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
            COALESCE(tc.work_kind, '') AS "workKind"
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
              TRUE AS "sheetless", COALESCE(tc.work_kind, '') AS "workKind"
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
  createWorktableSlots, createSlotsFromSheetRows, appendSlot, deleteWorktableRows, retireRows, retireInactiveImportRows,
  purgeImportedRows,
  importTabFromIndex,
  syncImportedTabs,
  listParticipants,
  compareWithIndex,
  setParticipantStatus,
  addParticipant,
  prepareRosterSlots,
  updateParticipant,
  softDeleteParticipant,
  listActiveTabs,
  __setPoolForTest,
};
