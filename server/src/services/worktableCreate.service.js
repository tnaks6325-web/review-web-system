/**
 * worktableCreate.service.js — 작업표 생성 (M2b-1: 시트 만들기)
 *
 * 미리보기에서 확인한 계획(`worktablePlan.buildWorktablePlan`)을 **그대로** 시트에 만든다.
 * 100건이면 100줄, 170건이면 170줄 — 건수는 작업오더가 요구하는 값 그대로다(사용자 확정).
 *
 * ★★ 설계 원칙(되돌리지 말 것)
 *  ① **계획은 미리보기와 같은 함수**로 다시 계산한다 — 클라이언트가 보낸 행 목록을 믿지 않는다.
 *     화면 값을 그대로 쓰면 낡은 화면·조작된 요청이 그대로 시트에 박힌다.
 *  ② **막힌 계획(blockers)은 생성하지 않는다** — 미리보기 잠금과 서버 게이트가 같은 판정을 쓴다.
 *  ③ **열 이름 줄은 설정 구성으로 다시 쓴다**(사용자 확정) — 템플릿 탭을 복사해 서식·공지문은
 *     가져오되, 헤더 행과 그 아래 데이터는 우리가 정한 열로 덮는다.
 *  ④ **라이브 경로 무접촉**: 주문 원장·행 배정·투영·큐를 건드리지 않는다. 이 서비스가 하는 쓰기는
 *     ㉮ 시트(새 탭) ㉯ `work_orders.work_sheet_url` 뿐이다. 탭 등록(`tab_configs`)은 여전히
 *     **접수(accept)** 가 유일한 관문이다(등록 게이트 불변식 유지).
 *  ⑤ **되돌리기**: 잘못 만들었으면 시트 탭을 사람이 지운다. 시스템이 시트를 지우지 않는다
 *     (되돌리기 어려운 파괴적 동작은 사람 손에 남긴다).
 */
'use strict';

const { logger } = require('../utils/logger');
const pool = require('../db/pool');
const sheetsSvc = require('./sheets.service');
const { buildWorktablePlan } = require('../utils/worktablePlan');
const { getTemplate } = require('./worktable.service');
const { WorkboardSchemaError, assertSupportedWorkboardSchemaVersion } = require('./workboardSchema.service');

/** 헤더 줄 위치를 찾는다(템플릿의 메타 영역·공지문 줄을 건너뛰기 위해). */
const { detectSheetHeader } = require('../utils/sheetHeader');

const MAX_SCAN_ROWS = 60;   // 헤더 탐지용 상단 스캔(공지문·메타 영역이 아무리 길어도 이 안)

/** work_orders 한 건(계획에 필요한 필드만). */
async function _loadWorkOrder(id) {
  const { rows } = await pool.query(
    `SELECT id, title, start_date, recruit_count, daily_count, product_url,
            product_option, product_options_json, work_sheet_url, status,
            skip_weekends, holidays, workboard_schema_version
       FROM work_orders WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [id]);
  return rows[0] || null;
}

/**
 * 계획을 시트 행 배열로 변환.
 * ★ 열 이름이 곧 어느 칸에 쓸지를 정한다 — `plan.columns[i].role` 로 판정하므로
 *   여기서 키워드 규칙을 다시 만들지 않는다(분류는 매퍼 파생 단일 출처).
 * ★ 시스템이 값을 넣는 칸은 번호·구매일자와 v2 상품·1차옵션·2차옵션이다.
 *   나머지는 빈 칸으로 두고 리뷰어 구매양식 제출이 채운다(기존 경로 그대로).
 */
function planToSheetValues(plan) {
  const header = plan.columns.map(c => c.name);
  const idxSeq = plan.columns.findIndex(c => c.role === 'seq');
  const idxDate = plan.columns.findIndex(c => c.role === 'dateStr');
  const idxOpt = plan.columns.findIndex(c => c.role === 'option');
  const idxProduct = plan.columns.findIndex(c => c.role === 'product');
  const idxOption1 = plan.columns.findIndex(c => c.role === 'option_1');
  const idxOption2 = plan.columns.findIndex(c => c.role === 'option_2');
  const body = plan.rows.map(r => {
    const row = new Array(header.length).fill('');
    if (idxSeq >= 0) row[idxSeq] = String(r.seq);
    if (idxDate >= 0 && r.dateLabel) row[idxDate] = r.dateLabel;   // `M / D (요일)` — 063 시트 일정 인식이 읽는 형식
    if (idxOpt >= 0 && r.optionKey) row[idxOpt] = r.optionKey;
    if (idxProduct >= 0 && r.selection?.productName) row[idxProduct] = r.selection.productName;
    if (idxOption1 >= 0 && r.selection?.option1Value) row[idxOption1] = r.selection.option1Value;
    if (idxOption2 >= 0 && r.selection?.option2Value) row[idxOption2] = r.selection.option2Value;
    return row;
  });
  return { header, body, filled: { seq: idxSeq >= 0, date: idxDate >= 0, option: idxOpt >= 0, product: idxProduct >= 0, option1: idxOption1 >= 0, option2: idxOption2 >= 0 } };
}

/** A1 표기 열 문자(0-based index → 'A','B',…,'AA'). */
function colLetter(i) {
  let s = '', n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/**
 * 새 탭에서 헤더 행 번호를 정한다.
 * 템플릿을 복사한 탭은 상단에 메타 영역(A1 캠페인명 · C1:R1 공지문)이 있고 그 아래에 헤더가 온다.
 * ★ 위치를 가정하지 않고 **실제로 탐지**한다 — 템플릿이 바뀌어도 따라간다.
 * ★ 못 찾으면 `fallback`(기본 2행) — 헤더를 1행에 쓰면 공지문을 덮어쓴다.
 */
async function _resolveHeaderRow(sheetId, gid, fallback = 2) {
  try {
    const values = await sheetsSvc.readSheet(sheetId, `A1:BZ${MAX_SCAN_ROWS}`, { gid });
    const det = detectSheetHeader(values || [], { maxScanRows: MAX_SCAN_ROWS });
    // detectSheetHeader 는 **1-based** headerRowIndex 를 준다(그대로 시트 행 번호).
    if (det && Number.isInteger(det.headerRowIndex) && det.headerRowIndex > 0) {
      return { row: det.headerRowIndex, width: (det.headers || []).length };
    }
    // 헤더를 못 찾아도 템플릿의 가장 넓은 상단 행 폭은 알아 둔다(옛 헤더 지우기용).
    const width = (values || []).slice(0, 10).reduce((m, r) => Math.max(m, (r || []).length), 0);
    return { row: fallback, width };
  } catch (e) {
    logger.warn(`[worktable/create] 헤더 행 탐지 실패 — ${fallback}행으로 진행: ${e.message}`);
    return { row: fallback, width: 0 };
  }
}

/**
 * 작업표 생성 — 시트 탭을 만들고 열 이름 줄 + N행을 쓴다.
 *
 * @param {object} p
 *  p.workOrderId  작업오더 id
 *  p.mode         'existing'(기존 시트 파일에 탭 추가) | 'new'(새 시트 파일)
 *  p.sheetId      mode='existing' 일 때 대상 스프레드시트 id
 *  p.fileTitle    mode='new' 일 때 새 파일 제목(미지정 = 작업오더 제목)
 *  p.tabName      만들 탭 이름(미지정 = 작업오더 제목)
 *  p.planOptions  미리보기에서 조정한 값(total·daily·startDate·skipWeekends·holidays·options)
 *  p.by           수행자
 */
async function createWorktable({ workOrderId, mode = 'existing', sheetId = '', fileTitle = '', tabName = '', templateSheetId: tplSheetId = '', planOptions = {}, by = 'admin' } = {}) {
  const wo = await _loadWorkOrder(workOrderId);
  if (!wo) return { ok: false, error: '작업오더를 찾을 수 없습니다.' };
  try {
    assertSupportedWorkboardSchemaVersion(wo.workboard_schema_version);
  } catch (error) {
    if (error instanceof WorkboardSchemaError) return { ok: false, code: error.code, error: error.message };
    throw error;
  }

  // ★ 계획은 **서버가 다시 계산**한다 — 화면이 보낸 행 목록을 믿지 않는다.
  const template = await getTemplate();
  const plan = buildWorktablePlan({ workOrder: wo, template, options: planOptions || {} });
  if (!plan.canCreate) {
    return { ok: false, error: '지금 구성으로는 만들 수 없습니다.', blockers: plan.blockers };
  }

  /* 템플릿 시트 = 서식·공지문의 원본. 해석 순서 = 요청값 → **전사 설정**(app_settings) → env.
     ★ 없어도 만들 수 있다 — 빈 탭으로 만든다(서식·공지문만 없고 열·행은 정확히 같다).
       하드 의존으로 두면 설정이 안 된 조직에서 기능이 통째로 막힌다(프로덕션에서 실제로 밟았다). */
  const templateSheetId = require('./worktable.service').normalizeSheetId(
    tplSheetId || template.templateSheetId || process.env.TEMPLATE_SHEET_ID || '');

  const title = String(tabName || wo.title || '').trim().slice(0, 90);
  if (!title) return { ok: false, error: '탭 이름이 비어 있습니다.' };

  let targetSheetId = String(sheetId || '').trim();
  let newGid = null;
  let createdFile = false;
  let usedTemplate = !!templateSheetId;

  try {
    if (mode === 'new') {
      const newTitle = String(fileTitle || wo.title || title).slice(0, 90);
      if (templateSheetId) {
        // 템플릿 스프레드시트 통째 복사(기존 '새 시트생성' 과 같은 경로 — 서식·공지문 유지).
        const copied = await sheetsSvc.copySpreadsheet(templateSheetId, newTitle);
        targetSheetId = copied.id;
      } else {
        // 템플릿 미설정 = 빈 스프레드시트(열·행은 동일, 서식만 없다).
        const created = await sheetsSvc.sheets.spreadsheets.create({
          requestBody: { properties: { title: newTitle }, sheets: [{ properties: { title } }] },
        });
        targetSheetId = created.data.spreadsheetId;
        usedTemplate = false;
      }
      createdFile = true;
      try { await sheetsSvc.shareSheetWithServiceAccount(targetSheetId); } catch (e) { logger.warn(`[worktable/create] SA 공유 실패(계속): ${e.message}`); }
      const meta = await sheetsSvc.getSpreadsheetMeta(targetSheetId);
      const first = (meta.sheets || [])[0];
      if (!first) return { ok: false, error: '복사한 시트에 탭이 없습니다.' };
      newGid = first.properties.sheetId;
      await sheetsSvc.renameSheet(targetSheetId, newGid, title);
    } else {
      if (!targetSheetId) return { ok: false, error: '대상 시트를 선택하세요.' };
      if (templateSheetId) {
        // 기존 파일에 템플릿 탭을 복사해 붙인다(서식·공지문 유지).
        const tmplMeta = await sheetsSvc.getSpreadsheetMeta(templateSheetId);
        const src = (tmplMeta.sheets || [])[0];
        if (!src) return { ok: false, error: '템플릿 시트에 탭이 없습니다.' };
        const copiedTab = await sheetsSvc.copySheetToSpreadsheet(templateSheetId, src.properties.sheetId, targetSheetId);
        newGid = copiedTab.sheetId;
        await sheetsSvc.renameSheet(targetSheetId, newGid, title);
      } else {
        // 템플릿 미설정 = 빈 탭 추가.
        const added = await sheetsSvc.sheets.spreadsheets.batchUpdate({
          spreadsheetId: targetSheetId,
          requestBody: { requests: [{ addSheet: { properties: { title } } }] },
        });
        newGid = added.data.replies[0].addSheet.properties.sheetId;
        usedTemplate = false;
      }
    }

    // ── 열 이름 줄 + 데이터 쓰기 ─────────────────────────────────────────
    // ★ 빈 탭에는 덮을 메타·공지문이 없으므로 헤더는 1행. 템플릿 복사본만 탐지가 필요하다.
    const { row: headerRow, width: tmplWidth } = usedTemplate
      ? await _resolveHeaderRow(targetSheetId, newGid)
      : { row: 1, width: 0 };
    const { header, body, filled } = planToSheetValues(plan);

    /* ★★ `clearSheetValues` 를 쓰지 않는다 — 그 함수는 **gid 를 받지 않아**(범위 문자열만)
       방금 만든 탭이 아니라 **첫 번째 탭을 지울 수 있다**(개발 중 런타임 확인으로 잡은 위험).
       대신 gid 를 지원하는 `writeSheet` 로 **빈 값을 덮어써** 옛 내용을 지운다.
       ★ 폭은 우리 열 수와 템플릿 헤더 폭 중 넓은 쪽 — 템플릿의 옛 헤더가 오른쪽에 남지 않게. */
    const width = Math.max(header.length, tmplWidth || 0, 1);
    const pad = (row) => { const a = row.slice(); while (a.length < width) a.push(''); return a; };
    const lastCol = colLetter(width - 1);

    await sheetsSvc.writeSheet(targetSheetId, `A${headerRow}:${lastCol}${headerRow}`, [pad(header)], { gid: newGid });
    if (body.length) {
      await sheetsSvc.writeSheet(
        targetSheetId, `A${headerRow + 1}:${lastCol}${headerRow + body.length}`, body.map(pad), { gid: newGid });
    }
    /* 템플릿에 샘플 행이 남아 있을 수 있어 그 아래 몇 줄을 비운다(경계 있는 정리 — 무한정 지우지 않는다). */
    const TRAIL = 20;
    await sheetsSvc.writeSheet(
      targetSheetId,
      `A${headerRow + 1 + body.length}:${lastCol}${headerRow + body.length + TRAIL}`,
      Array.from({ length: TRAIL }, () => new Array(width).fill('')), { gid: newGid });

    // ── 작업오더에 시트 URL 연결(접수는 여전히 사람이 누른다 — 등록 게이트 불변식 유지) ──
    const tabUrl = `https://docs.google.com/spreadsheets/d/${targetSheetId}/edit#gid=${newGid}`;
    try {
      await pool.query(
        `UPDATE work_orders SET work_sheet_url = $2, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
        [wo.id, tabUrl]);
    } catch (e) {
      logger.warn(`[worktable/create] 작업오더 URL 연결 실패(시트는 생성됨): ${e.message}`);
    }

    /* ★★ 만든 직후 그 시트를 **즉시 미러**한다 — 프로덕션 실측으로 잡은 문제.
       행 배정(`claimRow`)은 RAW 미러 스냅샷에서 빈 줄을 찾는데, 방금 만든 탭은 아직 미러에
       없다(주기 5분). 그 사이에 주문이 들어오면 준비된 빈 줄을 **못 보고 표 아래에 새로 붙는다**
       — 작업표를 미리 만든 의미가 사라진다.
       ★ best-effort: 실패해도 시트·표는 이미 만들어졌으므로 되돌리지 않는다(다음 주기가 메운다). */
    let mirrored = null;
    try {
      const r = await require('./rawMirror.service').mirrorOneSheet(targetSheetId, { force: true });
      mirrored = { tabs: r && r.tabsMirrored, rows: r && r.rowsWritten };
    } catch (e) {
      logger.warn(`[worktable/create] 생성 직후 미러 실패(다음 주기가 메운다): ${e.message}`);
      mirrored = { error: e.message };
    }

    /* ── 작업대 표에도 같은 줄을 미리 보이게(M2b-2) ────────────────────────
       ★ **시트가 1순위 산출물**이다 — 여기서 실패해도 시트는 이미 만들어졌으므로
         전체를 실패로 되돌리지 않고 사유만 실어 보낸다(사람이 다시 만들면 중복 탭이 생긴다).
       ★ 끌 수 있게 둔다: WORKTABLE_DB_ROWS=0 이면 시트만 만든다(스켈레톤 없이 종전 동작). */
    let slots = null;
    if (process.env.WORKTABLE_DB_ROWS !== '0') {
      try {
        slots = await require('./participants.service').createWorktableSlots({
          sheetId: targetSheetId, tabName: title, tabGid: newGid,
          headerRow, rows: plan.rows, productName: wo.title || null, by,
        });
      } catch (e) {
        logger.warn(`[worktable/create] 작업대 표 행 생성 실패(시트는 만들어짐): ${e.message}`);
        slots = { error: e.message };
      }
    }

    logger.info(`[worktable/create] ${wo.id} → ${title} (${body.length}행, 헤더 ${headerRow}행) by ${by}`);
    return {
      ok: true, sheetId: targetSheetId, gid: newGid, tabName: title, tabUrl, createdFile,
      headerRow, columns: header, rowsWritten: body.length, filled, slots, usedTemplate, mirrored,
      warnings: plan.warnings,
    };
  } catch (err) {
    logger.error(`[worktable/create] 실패: ${err.message}`);
    return { ok: false, error: err.message, partial: newGid ? { sheetId: targetSheetId, gid: newGid } : null };
  }
}

/**
 * 작업표 시트 탭 삭제 — ★ **아무도 안 쓴 탭만** 지운다.
 *
 * 원래는 "시트는 사람이 지운다"로 뒀는데, 시스템이 만든 것을 시스템이 못 지우면 정리할
 * 방법이 없다는 지적을 받아 열었다(사용자 확정). 대신 조건을 좁힌다:
 *  ★★ **주문·참여자가 한 명이라도 있으면 거부**한다 — 시트 탭 삭제는 되돌리기가 어렵고
 *     그 안에 사람 데이터가 있으면 손실이 크다(휴지통이 아니라 사라진다).
 *  ★ gid 는 **서버가 이름으로 재조회**한다 — 클라이언트가 보낸 gid 를 믿고 지우면
 *     낡은 화면이 **엉뚱한 탭을 지운다**.
 */
async function deleteWorktableTab({ sheetId, tabName, by = 'admin' } = {}) {
  if (!sheetId || !tabName) return { ok: false, error: 'sheetId, tabName 이 필요합니다.' };

  // ① 사람 데이터가 있으면 거부(작업대 표 + 주문 원장 양쪽 확인)
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM campaign_participants
           WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL
             AND (phone8 IS NOT NULL OR order_submission_id IS NOT NULL))::int AS "inTable",
         (SELECT COUNT(*) FROM order_submissions
           WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL)::int AS "orders"`,
      [sheetId, tabName]);
    const n = (rows[0].inTable || 0) + (rows[0].orders || 0);
    if (n > 0) {
      return { ok: false, error: `이 탭에는 이미 주문·참여자 ${n}건이 있어 시트 탭을 지울 수 없습니다. 구글시트에서 직접 확인 후 지워 주세요.`, blocked: true, filled: n };
    }
  } catch (e) {
    // ★ 확인 실패 = 지우지 않는다(fail-closed) — 모르면 파괴하지 않는다.
    logger.warn(`[worktable/deleteTab] 사용 여부 확인 실패 — 삭제 중단: ${e.message}`);
    return { ok: false, error: '이 탭이 사용 중인지 확인하지 못해 중단했습니다. 잠시 후 다시 시도하세요.' };
  }

  // ② gid 는 이름으로 재조회(클라이언트 값 미신뢰)
  let gid = null, sheetCount = 0;
  try {
    const meta = await sheetsSvc.getSpreadsheetMeta(sheetId);
    const list = meta.sheets || [];
    sheetCount = list.length;
    const hit = list.find(x => String(x.properties.title) === String(tabName));
    if (!hit) return { ok: false, error: '그 이름의 탭을 시트에서 찾지 못했습니다(이미 지워졌을 수 있습니다).' };
    gid = hit.properties.sheetId;
  } catch (e) {
    return { ok: false, error: '시트를 열지 못했습니다: ' + e.message };
  }
  // ★ 마지막 남은 탭은 지울 수 없다(구글이 거부한다) — 미리 안내한다.
  if (sheetCount <= 1) return { ok: false, error: '이 시트의 마지막 탭이라 지울 수 없습니다.' };

  try {
    await sheetsSvc.sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId, requestBody: { requests: [{ deleteSheet: { sheetId: gid } }] },
    });
  } catch (e) {
    return { ok: false, error: '탭 삭제 실패: ' + e.message };
  }
  // 표의 줄도 함께 내린다(빈 줄뿐이므로 확인 절차 불필요).
  try {
    await require('./participants.service').deleteWorktableRows({ sheetId, tabName, confirmed: true, by });
  } catch (e) { logger.warn(`[worktable/deleteTab] 표 정리 실패(탭은 삭제됨): ${e.message}`); }
  logger.info(`[worktable/deleteTab] ${tabName} (gid ${gid}) 삭제 by ${by}`);
  return { ok: true, deletedTab: tabName, gid };
}

module.exports = { createWorktable, deleteWorktableTab, planToSheetValues, colLetter, _resolveHeaderRow };
