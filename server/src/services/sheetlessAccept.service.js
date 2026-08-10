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

/** 가상 시트 ID (접두 3 + hex 20 = 23자 — 구글 ID 최소 길이 20자 이상) */
function newVirtualSheetId() {
  return VIRTUAL_SHEET_PREFIX + crypto.randomBytes(10).toString('hex');
}

/**
 * 가상 gid — 여러 곳이 `/^\d+$/` 를 요구한다(접수 검증·프리필 gid 우선 재매칭 등).
 * ★ 가상 시트 1개당 탭 1개라 시트 안에서의 충돌은 구조적으로 불가능하다.
 */
function newVirtualGid() {
  return String(100000000 + crypto.randomBytes(4).readUInt32BE(0) % 899999999);
}

/** 이 sheetId 가 우리가 만든 가상 시트인가(표시·로그용 — 게이트 판정용 아님) */
function isVirtualSheetId(sheetId) {
  return String(sheetId || '').startsWith(VIRTUAL_SHEET_PREFIX);
}

/**
 * ★★ 지금부터 들어오는 작업은 **무시트가 기본**이다 (사용자 확정 2026-08-10).
 *   인트라넷 리뷰오더에는 구글시트탭URL 칸이 없으므로(D4-b) 접수가 "URL 없음" 400 으로
 *   막다른 길이 되던 것을 없앤다 — URL 이 **비어 있으면 무시트로 접수**한다.
 *
 * ★ 킬스위치 `SHEETLESS_ACCEPT_DEFAULT=0` → 종전 동작(시트 필수 400)으로 즉시 복귀.
 */
function sheetlessAcceptDefaultOn() {
  return String(process.env.SHEETLESS_ACCEPT_DEFAULT || '1') !== '0';
}

/**
 * 이 접수를 무시트로 할 것인가 — **판정 단일 출처**(라우트·화면에 사본 금지).
 *
 * 우선순위(완화 금지):
 *  ① `body.sheetless === true`            → 명시 요청(작업 단위 예외)
 *  ② 이미 무시트 작업표가 만들어진 오더    → **되돌리지 않는다**(tab_configs 의 `OR` 병합과 같은 규율 —
 *     시트 URL 이 뒤늦게 채워졌다고 시트 기반으로 되돌리면 크론이 옛 시트 값으로 장부를 덮는다)
 *  ③ `body.sheetless === false`           → 명시적으로 시트 경로 요청
 *  ④ work_sheet_url 이 있음                → 시트 경로(종전 그대로)
 *  ⑤ 킬스위치 OFF                          → 시트 경로(= 종전 400 안내로 떨어진다)
 *  ⑥ 그 외(URL 없음)                       → **무시트**
 *
 * ★ URL 이 "있는데 형식이 틀린" 경우는 여기서 추측하지 않는다 — 사람이 붙일 의도로 넣은 값이므로
 *   라우트가 종전대로 사유를 말하고 멈춘다(조용히 다른 길로 가지 않는다).
 *
 * @returns {{sheetless:boolean, reason:string}}
 */
function resolveAcceptMode({ workOrder, body } = {}) {
  const o = workOrder || {};
  const b = body || {};
  if (b.sheetless === true || b.sheetless === 'true') return { sheetless: true, reason: 'requested' };
  if (isVirtualSheetId(o.linked_tab_sheet_id)) return { sheetless: true, reason: 'already_sheetless' };
  if (b.sheetless === false || b.sheetless === 'false') return { sheetless: false, reason: 'sheet_requested' };
  if (String(o.work_sheet_url || '').trim()) return { sheetless: false, reason: 'sheet_url' };
  if (!sheetlessAcceptDefaultOn()) return { sheetless: false, reason: 'killswitch' };
  return { sheetless: true, reason: 'no_sheet_url' };
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

  const sheetId = newVirtualSheetId();
  const gid = newVirtualGid();
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
    persist: () => persistSheetlessWorktable({ sheetId, gid, tabName: title, campaignName, headerRow, columns: header, rows, by }),
  };
}

/**
 * 작업표 행 + 장부 3권 기록. (campaigns·tab_configs 등록은 **접수 라우트가** 한다 — 등록 단일 관문)
 *
 * ★ 호출 순서 계약: tab_configs 에 `sheetless=TRUE` 로 등록된 **뒤에** 불러야 한다.
 *   `rebuildLedgers` 가 fail-closed 로 그 플래그를 확인하기 때문(시트 기반 탭 덮어쓰기 차단).
 */
async function persistSheetlessWorktable({ sheetId, gid, tabName, campaignName, headerRow, columns, rows, by = 'admin' } = {}) {
  const participants = require('./participants.service');
  const { rebuildLedgers } = require('./sheetlessLedger.service');

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
  sheetlessAcceptDefaultOn,
  newVirtualSheetId,
  newVirtualGid,
  isVirtualSheetId,
  VIRTUAL_SHEET_PREFIX,
};
