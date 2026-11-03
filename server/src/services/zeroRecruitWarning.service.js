'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// 결정 325 — 총모집(recruit_count) 0 으로 들어온 리뷰오더를 **막지 않고** 이상로그에 경고로 남긴다.
//
// 왜 막지 않나: 인트라넷 정식 접수가 거절되면 원본 번호(source_revision)가 어긋나 그 오더는 다시 고칠 수
//   없게 된다(완화 금지 — `PUT /api/order/intake/source` 규율). 작업 접수에서도 작업표 미리보기는 사람이
//   총 건수를 따로 넣을 수 있어 표는 만들어지지만, 오더 정원은 0 으로 남아 업체 화면 총건수가 빈다
//   (운영 2026-06~08 각 1건). 그래서 직원이 알 수 있게 **기존 이상로그(error_logs)** 에 한 줄을 남긴다.
// ★ 오더마다 한 줄(fingerprintKey = 오더 id) — 접수·작업 접수 두 단계는 같은 줄의 횟수만 올린다.
// ★ 절대 throw 하지 않는다(logAbnormal 도 fail-safe) — 경고 기록이 접수를 깨면 안 된다.
// ═══════════════════════════════════════════════════════════════════════════

/** 총모집이 비었나 — 0·빈 값·숫자 아님 = 비었음(양수만 정상). */
function isZeroRecruit(row) {
  const n = parseInt(row && row.recruit_count, 10);
  return !(n > 0);
}

/**
 * @param {object} row  저장된 work_orders 행(id·title·recruit_count …)
 * @param {object} [o]  { stage: 'intake'|'accept', by }
 * @returns {Promise<boolean>} 경고 대상이었으면 true(기록 성공 여부와 무관)
 */
async function warnZeroRecruit(row, { stage = '', by = '' } = {}) {
  try {
    if (!row || !row.id || !isZeroRecruit(row)) return false;
    const title = String(row.title || '').slice(0, 120);
    const { logAbnormal } = require('./errorLog.service');
    await logAbnormal({
      flow: 'admin',
      step: 'zero_recruit_count',
      category: 'validation',
      source: 'server',
      severity: 'warn',
      error: new Error(`리뷰오더 총모집 0 — 「${title}」(접수는 진행 · 업체 화면 총건수가 빌 수 있음 · 리뷰오더 총모집을 고쳐 주세요)`),
      fingerprintKey: String(row.id),
      context: {
        workOrderId: String(row.id),
        title,
        stage: String(stage || ''),
        by: String(by || ''),
        sourceReviewOrderId: String(row.source_review_order_id || ''),
        tabName: String(row.linked_tab_name || ''),
      },
    });
    return true;
  } catch (_) {
    return !!(row && row.id && isZeroRecruit(row));
  }
}

module.exports = { isZeroRecruit, warnZeroRecruit };
