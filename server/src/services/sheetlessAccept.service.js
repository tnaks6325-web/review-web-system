/**
 * sheetlessAccept.service.js — 시트 없는 접수 (탈 구글시트 W2 · F1)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★ 하는 일 = **접수 시점에 구글시트 대신 작업표를 만든다**
 *
 *   종전:  사람이 시트에 100줄 준비 → 시트탭URL 붙여 접수 → 그 탭이 tab_configs 에 등록
 *   이번:  접수 버튼 하나 → 가상 탭 + 작업표 100줄 + 장부 3권 (구글 호출 0)
 *
 * ★★ **등록 단일 관문은 그대로 접수(accept)** 다 — 이 서비스는 접수 라우트가 "탭을 해석하는"
 *   단계만 대신한다. campaigns·tab_configs 업서트, 상태 전이, 계약 자동 연결은
 *   시트 경로와 **완전히 같은 코드**를 탄다(사본 0 — 갈라지면 무시트 작업만 메타가 비는 사고).
 *
 * ★★ 계획은 **서버가 다시 계산**한다(`buildWorktablePlan`) — 미리보기와 같은 함수.
 *   화면이 보낸 행 목록을 믿지 않는다(worktableCreate 와 같은 규율).
 *
 * ★★ 값 생성도 **`planToSheetValues` 한 벌** — 시트에 쓸 때와 작업표에 넣을 때가 갈리면
 *   "미리보기 ≠ 실제 표"가 된다. 여기서는 그 2차원 배열을 `row_json`(헤더명→값)으로 옮길 뿐이다.
 *
 * ★ 구글 API 호출 0 · 시트 쓰기 0. 회귀가드가 이 파일에 sheets/drive 호출이 없음을 고정한다.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const crypto = require('crypto');
const { logger } = require('../utils/logger');

/**
 * ★★ 가상 시트 ID 접두 — "이건 구글시트가 아니다"를 한눈에 알리는 표식.
 *   ① 길이·문자 구성을 구글 ID 모양(`[A-Za-z0-9_-]{20,}`)에 맞춰 둔다 — 곳곳의 형식 검증에
 *      걸려 조용히 튕기지 않게. ② 그렇다고 구글 URL 로 조립하면 죽은 링크가 되므로
 *      `tab_configs.sheet_url` 은 **빈 값**으로 둔다(화면이 링크를 안 만든다).
 *   ⚠ 이 접두를 "구글에 물어보지 않는다"의 판정 근거로 쓰지 말 것 — 그 판정의 단일 출처는
 *     `utils/sheetlessScope`(= `tab_configs.sheetless` 플래그)다. 접두는 사람이 읽는 표식일 뿐이다.
 */
const VIRTUAL_SHEET_PREFIX = 'wt_';

/**
 * ★★ 가상 시트 ID·gid 는 **작업오더 id 에서 파생한다(결정적)** — 랜덤 발급 폐지.
 *
 *   실사고(2026-08-19 「8/19)유일기획_쿠팡_암막커튼 20건」 작업바 11줄 중복):
 *   종전엔 호출마다 `crypto.randomBytes` 로 **새 시트ID를 발급**했다. 그런데 중복 방지 장치는
 *   `work_orders.linked_tab_sheet_id`(접수 처리의 **마지막 단계**에서 기록) 하나뿐이라,
 *   그 전에 실패해 빠져나가는 경로(광고주 연결 409 · 쿼리 예외 500)에서는
 *   `campaigns`·`tab_configs` 줄만 남고 링크는 안 걸렸다 → 사람이 [접수하기]를 다시 누를 때마다
 *   **매번 다른 시트ID** 라 `ON CONFLICT (sheet_id, tab_name)` 이 영영 걸리지 않아 탭이 하나씩 늘었다.
 *
 *   ★ 지금은 같은 오더면 언제 몇 번을 눌러도 **같은 ID** 라 그 업서트가 스스로 dedupe 한다
 *     (링크 기록 시점·성공 여부와 무관 = 재시도 안전). 랜덤 발급 함수는 되살리지 말 것.
 *   ★ 길이·문자 구성은 종전과 동일(접두 3 + hex 20 = 23자 · gid 는 숫자 문자열) — 곳곳의
 *     형식 검증(`[A-Za-z0-9_-]{20,}` / `/^\d+$/`)을 그대로 통과한다.
 *   ★ 오더 id 가 없으면 **던진다** — 여기서 랜덤으로 접으면 막으려던 중복이 조용히 되살아난다.
 */
function _orderKey(workOrderId) {
  const key = String(workOrderId == null ? '' : workOrderId).trim();
  if (!key) throw new Error('virtualSheetIdForOrder: workOrderId 필수(랜덤 폴백 금지)');
  return key;
}

/** 가상 시트 ID = 접두 3 + sha256 앞 20hex = 23자 (작업오더 1개당 1개, 항상 같은 값) */
function virtualSheetIdForOrder(workOrderId) {
  const h = crypto.createHash('sha256').update('sheet:' + _orderKey(workOrderId)).digest('hex');
  return VIRTUAL_SHEET_PREFIX + h.slice(0, 20);
}

/**
 * 가상 gid — 여러 곳이 `/^\d+$/` 를 요구한다(접수 검증·프리필 gid 우선 재매칭 등).
 * ★ 가상 시트 1개당 탭 1개라 시트 안에서의 충돌은 구조적으로 불가능하다.
 */
function virtualGidForOrder(workOrderId) {
  const h = crypto.createHash('sha256').update('gid:' + _orderKey(workOrderId)).digest();
  return String(100000000 + (h.readUInt32BE(0) % 899999999));
}

/** 이 sheetId 가 우리가 만든 가상 시트인가(표시·로그용 — 게이트 판정용 아님) */
function isVirtualSheetId(sheetId) {
  return String(sheetId || '').startsWith(VIRTUAL_SHEET_PREFIX);
}

/**
 * ★★ 리뷰웹시스템 3버전은 **무시트 전용**이다 (사용자 확정 2026-08-15).
 *   작업오더에 남아 있는 work_sheet_url 은 과거 이력일 뿐 접수 모드를 바꾸지 않는다.
 *   새 접수는 항상 가상 작업표·DB 원장을 만들며, 구글시트를 원본으로 되돌리는
 *   킬스위치·요청 파라미터는 제공하지 않는다.
 */
/**
 * 이 접수를 무시트로 할 것인가 — **판정 단일 출처**(라우트·화면에 사본 금지).
 * 3버전에서는 항상 true다. 기존 URL·body.sheetless=false 를 존중하면 새 작업이
 * 시트 원본으로 되돌아가므로, 그 값들은 표시용 과거 데이터로만 남긴다.
 *
 * @returns {{sheetless:boolean, reason:string}}
 */
function resolveAcceptMode({ workOrder, body } = {}) {
  const o = workOrder || {};
  if (isVirtualSheetId(o.linked_tab_sheet_id)) return { sheetless: true, reason: 'already_sheetless' };
  return { sheetless: true, reason: 'v3_sheetless_only' };
}

/**
 * 작업오더 → 무시트 작업표(+장부).
 *
 * @param {object} o
 * @param {object} o.workOrder            work_orders 한 행(접수 라우트가 이미 로드한 그 객체)
 * @param {string} [o.tabName]            작업 이름(미지정 = 작업오더 제목)
 * @param {object} [o.planOptions]        미리보기에서 조정한 값(total·daily·startDate·skipWeekends·holidays·options)
 * @param {string} [o.by]
 * @returns {Promise<{ok:boolean, sheetId?, gid?, tabName?, columns?, rows?, blockers?, error?}>}
 */
async function createSheetlessWorktable({ workOrder: wo, tabName = '', planOptions = {}, by = 'admin' } = {}) {
  if (!wo || !wo.id) return { ok: false, error: '작업오더가 없습니다.' };

  const { buildWorktablePlan } = require('../utils/worktablePlan');
  const { getTemplate } = require('./worktable.service');
  const { planToSheetValues } = require('./worktableCreate.service');
  const { WorkboardSchemaError, assertSupportedWorkboardSchemaVersion } = require('./workboardSchema.service');

  try {
    assertSupportedWorkboardSchemaVersion(wo.workboard_schema_version);
  } catch (error) {
    if (error instanceof WorkboardSchemaError) return { ok: false, code: error.code, error: error.message };
    throw error;
  }

  const template = await getTemplate();
  const plan = buildWorktablePlan({ workOrder: wo, template, options: planOptions || {} });
  if (!plan.canCreate) {
    return { ok: false, error: '지금 구성으로는 작업표를 만들 수 없습니다.', blockers: plan.blockers };
  }

  const title = String(tabName || wo.title || '').trim().slice(0, 90);
  if (!title) return { ok: false, error: '작업 이름이 비어 있습니다.' };

  const { header, body, filled } = planToSheetValues(plan);
  if (!header.length) return { ok: false, error: '열 구성이 비어 있습니다.' };

  /* ★ 헤더 행 = 1 — 가상 탭에는 덮을 템플릿 메타·공지문이 없다(worktableCreate 의 빈 탭 분기와 동일).
     데이터는 2행부터 = `seq`(작업표 행 번호). 이 번호가 곧 주문 배정·투영·claim 의 키다. */
  const headerRow = 1;

  // ★ 결정적 파생 — 같은 오더를 몇 번 접수해도 같은 시트/탭이라 업서트가 dedupe 한다.
  const sheetId = virtualSheetIdForOrder(wo.id);
  const gid = virtualGidForOrder(wo.id);
  /* campaigns/tab_configs 의 `campaign_name` 은 시트 경로에서 **스프레드시트 파일 제목**이 들어가던 자리.
     무시트에는 파일이 없으므로 작업오더 제목을 쓴다. (Drive 폴더 이름은 여기가 아니라
     `folderTitle.service` 가 업체명 우선으로 따로 정한다 — D2-a) */
  const campaignName = String(wo.title || title).slice(0, 200);

  const rows = body.map((cells, i) => {
    const rowJson = {};
    header.forEach((h, c) => { rowJson[h] = cells[c] == null ? '' : String(cells[c]); });
    const pr = plan.rows[i] || {};
    return {
      seq: headerRow + 1 + i,
      optionText: pr.optionKey || null,
      startDate: pr.dateLabel || null,
      rowJson,
    };
  });

  return {
    ok: true, sheetId, gid, tabName: title, campaignName,
    headerRow, columns: header, rows, filled,
    warnings: plan.warnings,
    // 실제 쓰기는 호출부(접수 라우트)가 등록과 같은 흐름에서 수행한다 — 아래 `persist` 참조.
    persist: () => persistSheetlessWorktable({ sheetId, gid, tabName: title, campaignName, headerRow, columns: header, rows, by,
      workboardSchemaVersion: Number(wo.workboard_schema_version || 1) }),
  };
}

/**
 * 작업표 행 + 장부 3권 기록. (campaigns·tab_configs 등록은 **접수 라우트가** 한다 — 등록 단일 관문)
 *
 * ★ 호출 순서 계약: tab_configs 에 `sheetless=TRUE` 로 등록된 **뒤에** 불러야 한다.
 *   `rebuildLedgers` 가 fail-closed 로 그 플래그를 확인하기 때문(시트 기반 탭 덮어쓰기 차단).
 */
async function persistSheetlessWorktable({ sheetId, gid, tabName, campaignName, headerRow, columns, rows, by = 'admin', workboardSchemaVersion = 1 } = {}) {
  const participants = require('./participants.service');
  const { rebuildLedgers } = require('./sheetlessLedger.service');

  // 생성 전에 고정 상태열 계약을 남긴다. 실패하면 슬롯/장부를 만들지 않아
  // '표시는 됐지만 어느 상태열을 읽는지 모르는' v2 탭이 남지 않는다.
  if (Number(workboardSchemaVersion) === 2) {
    await require('./statusColumnBinding.service').seedV2StatusBindings(require('../db/pool'), {
      sheetId, tabGid: gid, tabName, headers: columns, by,
    });
  }

  // ① 작업표 행 — **기존 함수 재사용**(사본 금지). seq = 작업표 행 번호, source='worktable',
  //    ON CONFLICT DO NOTHING(멱등·비파괴 — 재접수해도 이미 있는 줄은 안 건드린다).
  const slots = await participants.createSlotsFromSheetRows({
    sheetId, tabName, tabGid: gid, campaignName, rows, by: `sheetless:${by}`,
  });

  // ② 장부 3권 — 열 구성을 함께 넘긴다(첫 생성이라 저장된 헤더가 없다).
  const ledger = await rebuildLedgers({ sheetId, tabName, columns, by: `sheetless-accept:${by}` });

  logger.info(`[sheetlessAccept] 작업표 ${slots.created}행 · 장부 미러 ${ledger.mirrorRows}행/명단 ${ledger.indexRows}행 tab=${tabName} sheet=${sheetId}`);
  return { slots, ledger, headerRow };
}

module.exports = {
  createSheetlessWorktable,
  persistSheetlessWorktable,
  resolveAcceptMode,
  virtualSheetIdForOrder,
  virtualGidForOrder,
  isVirtualSheetId,
  VIRTUAL_SHEET_PREFIX,
};
