/**
 * 과거 리뷰 캡처 파일명 소급 정정 — 주문자 → **그 건의 수취인**.
 *
 * 왜(2026-09-22 신고 · 결정 009 후속): 타계정 참여 캡처가 Drive 에 전부 주문자(로그인 본계정)
 * 이름으로 쌓여 어떤 타계정의 리뷰인지 구분할 수 없다. 앞으로의 저장은 서버 판정으로 고쳤고
 * (`captureOwnerName`), **이미 올라간 파일**은 이 도구가 이름만 바꾼다.
 *
 * ★★ 완화 금지 6종 — 되돌리기 어려운 **외부 저장(Drive) 쓰기**라 전부 fail-closed:
 *   ① **미리보기 기본** — `dryRun !== false` 면 Drive·DB 에 한 글자도 쓰지 않는다.
 *      실행은 `dryRun:false` **와** `confirm:true` 가 **둘 다** 있어야 한다.
 *   ② **그 줄이 확정된 파일만** — 원장에 행 링크(`review_index_id`/`row_index`)가 있어야 한다.
 *      어느 줄 것인지 모르는 파일의 이름을 지어내지 않는다.
 *   ③ **표준 파일명만** — `{이름}_{순번}_{yyyyMMdd_HHmmss}.{확장자}` 가 아니면 건너뛴다.
 *      ★ **꼬리(순번·시각·확장자)는 그대로 둔다** — 새로 만들면 원래 제출 시각이 사라지고,
 *        파일명 ↔ 행 소급 매칭(`reviewFileLink`)의 모양도 깨진다.
 *   ④ **바꾸기 전 이름을 먼저 남긴다**(`review_submissions.renamed_from`, migration 164) —
 *      이 칸이 없으면 되돌릴 수 없다. 되돌리기(`revert`)가 그 값을 쓴다.
 *   ⑤ **Drive 가 성공한 건만 DB 를 고친다** — 순서를 뒤집으면 DB 는 새 이름인데 Drive 는 옛
 *      이름인 상태가 남는다(화면·정리 도구가 서로 다른 이름을 본다).
 *   ⑥ **건별 격리** — 한 건이 실패해도 나머지는 계속한다. 실패는 사유와 함께 **보고**한다.
 *
 * ★ 이름 해석은 `captureOwnerName` 의 **공유 SQL 조각**(사본 0) · 파일명 조립은
 *   `drive.generateReviewFileName` 과 **같은 위생 규칙**(금지문자 → `_`).
 * ★ Drive 호출은 drive lane throttle 경유 — 1,782건을 한꺼번에 쏘면 쿼터에 부딪힌다.
 */

const { logger } = require('../utils/logger');
const driveService = require('./drive.service');
const { driveThrottledCall } = require('../utils/sheetsThrottle');
const { RECIPIENT_PICK_SQL, recipientJoinSql } = require('./captureOwnerName.service');

/** 표준 리뷰 캡처 파일명의 꼬리 — `_{순번}_{yyyyMMdd}_{HHmmss}.{확장자}` */
const TAIL_RE = /_(\d+)_(\d{8})_(\d{6})\.([A-Za-z0-9]+)$/;
/* ★★ 같은 규칙의 POSIX 표현 — **목록을 SQL 에서 걸러내기 위해** 필요하다.
   JS 에서만 거르고 SQL 은 앞에서부터 잘라 읽으면, 대상이 뒤쪽에 있는 파일에는
   **영원히 도달하지 못한다**(실측: 전체 1,782건인데 한 번에 41건만 잡혔다).
   ★ 두 표현이 갈리면 "SQL 은 대상이라는데 JS 는 건너뛰는" 헛돌기가 되므로
     회귀가드가 **같은 문자열에 같은 판정을 하는지 실행으로 대조**한다. */
const TAIL_SQL = '_[0-9]+_[0-9]{8}_[0-9]{6}\\.[A-Za-z0-9]+$';
/** Drive 파일명에 넣을 수 없는 글자 — `generateReviewFileName` 과 같은 규칙(사본 아님: 같은 표를 쓴다) */
const UNSAFE_RE = /[\/\\:*?"<>|]/g;

const MAX_BATCH = 500;

/** 파일명을 {이름} + {꼬리} 로 가른다. 표준형이 아니면 null(= 건드리지 않는다). */
function splitFileName(fileName) {
  const s = String(fileName || '');
  const m = s.match(TAIL_RE);
  if (!m) return null;
  const head = s.slice(0, s.length - m[0].length);
  if (!head) return null;
  return { head, tail: m[0] };
}

/** 그 파일의 최종 이름 — 꼬리는 보존하고 이름만 바꾼다. */
function renamedTo(fileName, recipient) {
  const parts = splitFileName(fileName);
  const safe = String(recipient || '').replace(UNSAFE_RE, '_').trim();
  if (!parts || !safe) return null;
  if (safe === parts.head) return null;        // 이미 수취인 이름이다 — 부를 일이 없다
  return safe + parts.tail;
}

/**
 * 정정 대상 목록(읽기 전용).
 * @returns {Promise<Array<{fileId,fileName,newName,sheetId,tabName,rowIndex,isPrimary}>>}
 */
async function planRecipientRenames({ db, sheetId = null, tabName = null, limit = MAX_BATCH } = {}) {
  const cap = Math.max(1, Math.min(MAX_BATCH, Number(limit) || MAX_BATCH));
  /* ★★ 거르기는 **SQL 에서** 한다 — 표준형이 아니거나 수취인을 모르거나 이미 같은 이름인 건을
     DB 가 빼고 주므로, `LIMIT` 이 **실제 대상 기준**이 된다. 그래서 반복 실행이 앞으로 나아간다
     (바꾼 건은 다음 조회에서 "이미 같은 이름"이 되어 자동으로 빠진다).
     ★ JS `renamedTo` 가 최종 판정이다 — SQL 은 그보다 **넓게** 거를 뿐이라 둘이 어긋나도
       "SQL 이 준 것을 JS 가 건너뛰는" 안전한 방향으로만 갈린다. */
  const { rows } = await db.query(
    `WITH f AS (
       SELECT rs.file_id, rs.file_name, rs.sheet_id, rs.tab_name,
              COALESCE(rs.row_index, ri2.row_index) AS row_index,
              regexp_replace(rs.file_name, '${TAIL_SQL}', '') AS cur_name
         FROM review_submissions rs
         LEFT JOIN review_index ri2 ON ri2.id = rs.review_index_id
        WHERE COALESCE(rs.slot_key, 'review') = 'review'
          AND rs.file_name ~ '^.+${TAIL_SQL}'
          AND ($1::text IS NULL OR rs.sheet_id = $1)
          AND ($2::text IS NULL OR rs.tab_name = $2)
     )
     SELECT f.file_id AS "fileId", f.file_name AS "fileName", f.sheet_id AS "sheetId",
            f.tab_name AS "tabName", f.row_index AS "rowIndex",
            ${RECIPIENT_PICK_SQL} AS recipient,
            (ri.review_file_id = f.file_id) AS "isPrimary"
       FROM f
       ${recipientJoinSql('f')}
      WHERE f.row_index IS NOT NULL
        AND ${RECIPIENT_PICK_SQL} IS NOT NULL
        AND ${RECIPIENT_PICK_SQL} <> f.cur_name
      ORDER BY f.tab_name, f.row_index, f.file_name
      LIMIT $3`,
    [sheetId || null, tabName || null, cap]
  );

  const out = [];
  for (const r of rows) {
    if (out.length >= cap) break;
    const newName = renamedTo(r.fileName, r.recipient);
    if (!newName) continue;                    // 표준형 아님 · 수취인 모름 · 이미 같은 이름
    out.push({ ...r, newName, isPrimary: !!r.isPrimary });
  }
  return out;
}

/** Drive 이름 변경 + DB 반영. dryRun 이면 쓰기 0건. */
async function applyRecipientRenames({ db, sheetId = null, tabName = null, limit = MAX_BATCH,
                                       dryRun = true, confirm = false, by = 'system' } = {}) {
  const items = await planRecipientRenames({ db, sheetId, tabName, limit });
  const res = { planned: items.length, renamed: 0, failed: 0, dryRun: dryRun !== false,
                items: items.map(i => ({ fileId: i.fileId, from: i.fileName, to: i.newName,
                                         tabName: i.tabName, rowIndex: i.rowIndex })), failures: [] };
  // ★★ 실행은 두 값이 **모두** 명시일 때만 — 하나만으로는 절대 쓰지 않는다.
  if (dryRun !== false || confirm !== true) return res;

  for (const it of items) {
    try {
      await driveThrottledCall(() => driveService.renameFile(it.fileId, it.newName), 2, { label: '캡처이름정정' });
      // ★ Drive 가 성공한 뒤에만 DB — 되돌리기 재료(renamed_from)는 **덮지 않는다**(최초 이름 보존).
      await db.query(
        `UPDATE review_submissions
            SET file_name = $2, renamed_from = COALESCE(renamed_from, $3)
          WHERE file_id = $1`,
        [it.fileId, it.newName, it.fileName]);
      if (it.isPrimary) {
        await db.query(
          `UPDATE review_index SET review_file_name = $2
            WHERE sheet_id = $3 AND tab_name = $4 AND row_index = $5 AND review_file_id = $1`,
          [it.fileId, it.newName, it.sheetId, it.tabName, it.rowIndex]);
      }
      res.renamed++;
    } catch (e) {
      // ★ 한 건 실패가 나머지를 막지 않는다 — 사유를 실어 화면이 말하게 한다.
      res.failed++;
      if (res.failures.length < 50) res.failures.push({ fileId: it.fileId, reason: e.message });
      logger.warn(`[captureRename] 실패 ${it.fileId}: ${e.message}`);
    }
  }
  logger.info(`[captureRename] 정정 ${res.renamed}/${res.planned} (실패 ${res.failed}) by=${by}`);
  return res;
}

/** 되돌리기 — `renamed_from` 이 있는 파일만, 그 이름으로. */
async function revertRecipientRenames({ db, sheetId = null, tabName = null, limit = MAX_BATCH,
                                        dryRun = true, confirm = false, by = 'system' } = {}) {
  const cap = Math.max(1, Math.min(MAX_BATCH, Number(limit) || MAX_BATCH));
  const { rows: items } = await db.query(
    `SELECT rs.file_id AS "fileId", rs.file_name AS "fileName", rs.renamed_from AS "newName",
            rs.sheet_id AS "sheetId", rs.tab_name AS "tabName", rs.row_index AS "rowIndex"
       FROM review_submissions rs
      WHERE rs.renamed_from IS NOT NULL
        AND ($1::text IS NULL OR rs.sheet_id = $1)
        AND ($2::text IS NULL OR rs.tab_name = $2)
      ORDER BY rs.tab_name, rs.row_index
      LIMIT $3`,
    [sheetId || null, tabName || null, cap]);

  const res = { planned: items.length, renamed: 0, failed: 0, dryRun: dryRun !== false,
                items: items.map(i => ({ fileId: i.fileId, from: i.fileName, to: i.newName })), failures: [] };
  if (dryRun !== false || confirm !== true) return res;

  for (const it of items) {
    try {
      await driveThrottledCall(() => driveService.renameFile(it.fileId, it.newName), 2, { label: '캡처이름되돌리기' });
      await db.query(
        `UPDATE review_submissions SET file_name = $2, renamed_from = NULL WHERE file_id = $1`,
        [it.fileId, it.newName]);
      await db.query(
        `UPDATE review_index SET review_file_name = $2
          WHERE review_file_id = $1`, [it.fileId, it.newName]);
      res.renamed++;
    } catch (e) {
      res.failed++;
      if (res.failures.length < 50) res.failures.push({ fileId: it.fileId, reason: e.message });
      logger.warn(`[captureRename] 되돌리기 실패 ${it.fileId}: ${e.message}`);
    }
  }
  logger.info(`[captureRename] 되돌리기 ${res.renamed}/${res.planned} by=${by}`);
  return res;
}

module.exports = {
  splitFileName, renamedTo, planRecipientRenames, TAIL_RE, TAIL_SQL,
  applyRecipientRenames, revertRecipientRenames, MAX_BATCH,
};
