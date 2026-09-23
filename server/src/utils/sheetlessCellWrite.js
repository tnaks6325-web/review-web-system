'use strict';
/**
 * sheetlessCellWrite.js — "이 셀 편집을 무시트 작업표의 원본(row_json)에 새길 것인가"의 단일 출처.
 *
 * ★★ 거부는 언제나 안전하다 — 거부하면 오늘 동작(오버레이-only) 그대로다.
 *    그래서 **거부는 넓게, 허용은 좁게**. 판정 실패·모호·gid 없음은 전부 거부(fail-safe).
 * ★★ 거부 규칙은 전부 판정 원본에서 가져온다(사본 금지) — 여기 문자열 표를 새로 만들면
 *    입금대상 추출·상품비 폴백과 갈려 리뷰비 미지급으로 이어진다.
 * ★★ db 인자는 **편집 트랜잭션의 client** 여야 한다. pool 을 쓰면 tx 를 쥔 채 커넥션을
 *    다시 잡아 붙여넣기(최대 500 동시 요청)에서 풀 고갈 교착이 난다.
 *
 * 모드(`SHEETLESS_CELL_WRITE`): off = 종전 동작(오버레이만) / dry = 판정만 하고 쓰지 않음 / allow = 허용목록만 기록.
 *   ★ 기본값은 **테섭에서만 allow**(`TEST_AUTO_LOGIN=1` 표식) — 본섭에는 그 표식이 없어 자동 off 다.
 *     본섭에서 켤 때는 `SHEETLESS_CELL_WRITE=allow` 를 명시로 준다(실수로 켜질 수 없다).
 */
const { PAYMENT_COL_KEYWORDS } = require('../services/search.service');   // 미입금 판정 원본
const { isAmountCandidateHeader } = require('./paymentAmount');           // 상품비 폴백 원본

function MODE() {
  const explicit = String(process.env.SHEETLESS_CELL_WRITE || '').trim().toLowerCase();
  if (explicit) return explicit;
  return process.env.TEST_AUTO_LOGIN === '1' ? 'allow' : 'off';
}

/* 1차 허용 — 정보 열만. 확장은 env `SHEETLESS_CELL_WRITE_ALLOW`(csv, 정확일치). */
const DEFAULT_ALLOW = /^(택배\s*송장(번호)?(\s*\([^()]{1,60}\))?|비고|메모|특이사항|옵션|리뷰옵션|작업옵션|차수|진행차수|포스팅결과URL|포스팅제출일|배송메모)$/;

/**
 * 거부 사유(없으면 null). deps 는 호출부가 판정 원본에서 주입한다.
 * @param {string} header  시트/작업표 열 이름
 * @param {{linkedToggle:Function, nameKeywords:string[]}} deps
 */
function denyReason(header, deps) {
  const h = String(header || '').trim();
  if (!h) return 'empty_header';
  const hs = h.replace(/\s+/g, '');
  const hl = h.toLowerCase();
  // ㉮ 상태 토글(리뷰제출·입금) — 이미 status_column_locked 지만 2중 방어
  if (deps.linkedToggle && deps.linkedToggle(h)) return 'status_column';
  // ㉯ 미입금 판정 열 — payment.service 의 `kv.key ILIKE '%kw%'` 과 같은 규칙.
  //    ★ `입금확인`·`페이백` 은 _PAID_HEADERS 에 없어 status lock 을 통과한다(실제 구멍).
  if (PAYMENT_COL_KEYWORDS.some(k => hl.includes(String(k).toLowerCase()))) return 'payment_column';
  // ㉰ 금액 열 — listPaymentTargets 의 amountCells 후보와 같은 규칙
  if (hs.includes('금액') || isAmountCandidateHeader(h)) return 'amount_column';
  // ㉱ 주문번호 — 링크·dedupeRows 판정 키(2026-08-19 규율)
  if (hs.includes('주문번호') || hl.includes('ordernum')) return 'order_number_column';
  // ㉲ 이름 열 — 비면 파서가 그 행을 버려 줄이 명단에서 사라진다(키워드는 indexBuilder 라이브 값)
  if ((deps.nameKeywords || []).some(k => h.includes(k))) return 'name_column';
  // ㉳ 연락처 — 소유권 키(stale-pl 규율). 파서 규칙보다 **넓게** 막는다(거부는 안전).
  if (/연락처|전화|휴대|폰번호|hp/i.test(h)) return 'identity_column';
  return null;
}

/**
 * @param {object} client  편집 트랜잭션의 pg client (pool 금지)
 * @returns {Promise<{write:boolean, reason:string, header?:string}>}
 */
async function decide(client, { sheetId, tabName, field } = {}) {
  const mode = MODE();
  if (mode === 'off') return { write: false, reason: 'disabled' };
  if (typeof field !== 'string' || field.indexOf('col:') !== 0) return { write: false, reason: 'not_sheet_column' };
  const header = field.slice(4);

  // ★ 헤더는 rebuildLedgers 와 **같은 키**(sheet_id + tab_gid)로 읽는다 — 다르면 저장은 되는데
  //   장부는 영원히 안 바뀌는 상태가 된다(사유 없는 무반영).
  let sheetless = false, headers = [];
  try {
    const { rows } = await client.query(
      `SELECT COALESCE(tc.sheetless, FALSE) AS sheetless,
              COALESCE(tc.tab_gid, '')      AS gid,
              rst.detected_headers          AS dh
         FROM tab_configs tc
         LEFT JOIN raw_sheet_tabs rst
           ON rst.sheet_id = tc.sheet_id AND rst.tab_gid = COALESCE(tc.tab_gid, '')
        WHERE tc.sheet_id = $1 AND tc.tab_name = $2 LIMIT 1`,
      [sheetId, tabName]);
    if (!rows.length) return { write: false, reason: 'tab_not_registered' };
    sheetless = !!rows[0].sheetless;
    if (!sheetless) return { write: false, reason: 'sheet_backed' };      // 시트 기반 무회귀
    if (!rows[0].gid) return { write: false, reason: 'no_tab_gid' };
    headers = Array.isArray(rows[0].dh) ? rows[0].dh : [];
  } catch (_) { return { write: false, reason: 'lookup_failed' }; }

  // 🔴1 — detected_headers 에 **실재하는 열만**. row_json 키 폴백은 여기서 인정하지 않는다
  //   (그 값은 buildValues·parseTabRows 가 버려 다음 재생성에서 사라진다).
  if (!headers.some(x => String(x == null ? '' : x).trim() === header)) {
    return { write: false, reason: 'header_not_in_ledger', header };
  }

  let nameKeywords = null;
  try { nameKeywords = require('../services/indexBuilder.service').getKeywords().NAME_KEYWORDS; } catch (_) { nameKeywords = null; }
  if (!nameKeywords) return { write: false, reason: 'keywords_unavailable' };   // 모르면 안 쓴다
  let linkedToggle = null;
  try { linkedToggle = require('../services/trackB.service').linkedToggleHeader; } catch (_) { linkedToggle = null; }
  if (!linkedToggle) return { write: false, reason: 'keywords_unavailable' };

  const deny = denyReason(header, { linkedToggle, nameKeywords });
  if (deny) return { write: false, reason: deny, header };

  const extra = String(process.env.SHEETLESS_CELL_WRITE_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!DEFAULT_ALLOW.test(header) && extra.indexOf(header) < 0) {
    return { write: false, reason: 'not_in_allowlist', header };
  }
  // dry = 관측 모드: 여기까지 통과했지만 **쓰지 않는다**(무엇이 달라졌을지만 사유로 남는다).
  if (mode === 'dry') return { write: false, reason: 'dry_run', header };
  return { write: true, reason: 'ok', header };
}

module.exports = { decide, denyReason, DEFAULT_ALLOW, MODE };
