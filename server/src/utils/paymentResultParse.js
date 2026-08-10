'use strict';
/**
 * 은행 이체결과 파일 해석 + 회차 대조 — **순수함수 단일 출처** (M2)
 *
 * 설계 문서: frontend/docs/prd-payment-transfer.html (v1.4) · 실측 픽스처: tests/fixtures/paymentResultFixtures.js
 *
 * ══════════════════════════════════════════════════════════════
 * 이 파일에 DB·네트워크·`Date.now()` 가 없다(결정적). 화면·라우트·회귀가드가
 * **같은 함수**를 태우므로 "미리보기와 실제 반영이 다른" 상태가 구조적으로 불가능하다.
 *
 * ★★ 실측으로 확정한 규칙(추측 금지 — 2026-06-09 이체분 하나 195건·케이뱅크 207건)
 *  ① **헤더 행 번호를 하드코딩하지 않는다** — 하나은행은 위에 메타 2줄(그룹이체명·출금계좌)이
 *     있어 헤더가 3행째이고, 케이뱅크는 1행째인데 **맨 앞에 빈 열**이 하나 있다. 은행이 양식을
 *     조금만 바꿔도 고정 좌표는 그날로 죽는다 → **열 이름으로 찾는다**.
 *  ② **성공은 화이트리스트로만 판정한다**(하나 `처리완료` / 케이뱅크 `이체완료`).
 *     실물에 실패 행이 한 건도 없어 **실패 표기 문자열을 우리는 모른다** — 그래서
 *     "성공이라고 적힌 것만 성공"이 유일하게 안전한 방향이다(모르는 값 = 실패 = 미입금 유지).
 *  ③ **계좌는 숫자만 비교한다** — 결과 파일의 계좌 칸은 `우리은행 1002839010303`,
 *     `국민 202-6020-428-6813` 처럼 **은행명 + 계좌**가 한 칸이고 은행 표기가 우리 표준명과
 *     다르다(`KEB하나`·`IM뱅크(대구)`·`국민`). 은행명으로 맞추려 들면 그날 바로 깨진다.
 *  ④ ★★ **계좌·금액·예금주·통장표시가 전부 같은 행이 여러 줄 존재한다**(같은 사람이 같은
 *     작업에 여러 건 — 케이뱅크 실측 207건 중 16그룹, 최대 3중복). 결과 파일만으로는 어느
 *     우리 행인지 **원리적으로 구분할 수 없다** → 사용자 확정대로 **순서대로 배정**하고
 *     화면이 그 사실을 고지한다. 같은 사람·같은 금액·같은 작업이라 기록 위치만 임의가 될 뿐
 *     리뷰어 피해는 없다.
 * ══════════════════════════════════════════════════════════════
 */

/** 은행별 열 규칙 — 헤더 이름으로 찾는다(위치 고정 금지). */
const BANK_SPECS = {
  hana: {
    label: '하나은행',
    /* 하나은행 결과 파일임을 알아보는 지문. 두 조건을 **모두** 만족해야 한다 —
       한쪽만 보면 케이뱅크 파일을 하나로 오인해 엉뚱한 회차에 반영된다. */
    detect: h => _has(h, /처리상태/) && _has(h, /입금계좌/),
    success: '처리완료',
    cols: {
      transferredAt: /이체처리|이체일/,     // '이체처리(예정)일'
      account: /입금계좌/,
      amount: /이체금액/,
      holder: /^받는분$/,                   // '내통장 표시'(보내는분)와 헷갈리지 않게 앵커 고정
      memo: /받는.*통장.*표시/,
      status: /처리상태/,
    },
    required: ['transferredAt', 'account', 'amount', 'status'],
  },
  kbank: {
    label: '케이뱅크',
    detect: h => _has(h, /처리결과/) && _has(h, /이체일시/),
    success: '이체완료',
    cols: {
      transferredAt: /이체일시/,
      account: /입금계좌/,
      amount: /이체금액/,
      holder: /예금주/,
      memo: /통장\s*표시/,
      status: /처리결과/,
    },
    required: ['transferredAt', 'account', 'amount', 'status'],
  },
};

function _has(headerRow, re) {
  return headerRow.some(c => re.test(String(c == null ? '' : c).replace(/\s+/g, ' ').trim()));
}
function _cell(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

/** 숫자만 남긴다(계좌·금액 공용). */
function digitsOnly(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, ''); }

/**
 * 결과 파일의 계좌 칸("우리은행 1002839010303")에서 계좌 숫자만 뽑는다.
 * ★ 은행명을 먼저 떼고 숫자를 뽑는다 — 은행 표기에 숫자가 섞여도(예: 'iM뱅크(대구)')
 *   계좌번호에 그 숫자가 딸려 들어가지 않게 한다. 떼어낼 게 없으면 전체에서 숫자만.
 */
function accountDigits(raw) {
  const s = _cell(raw);
  if (!s) return '';
  const sp = s.indexOf(' ');
  if (sp > 0) {
    const head = s.slice(0, sp);          // 은행명 후보
    const tail = s.slice(sp + 1);
    // 뒷부분에 숫자가 4자리 이상 있으면 그것이 계좌다(앞은 은행명).
    if (digitsOnly(tail).length >= 4) return digitsOnly(tail);
    void head;
  }
  return digitsOnly(s);
}

/**
 * 이체시점 문자열 → { iso, stamp }.
 *  실측 표기 2종: `2026-06-09 12:26:09`(하나) · `2026.06.09 11:46:52`(케이뱅크)
 *  ★ 은행이 적은 시각은 **KST**다. 서버 TZ 가 무엇이든 같은 값이 나오도록
 *    Date 산술 대신 문자열 → `+09:00` 고정 ISO 로 만든다.
 *  ★ stamp = 시트/작업표 입금칸에 적을 표기 — 기존 수기 입금 기록과 **같은 모양**
 *    (`YYYY.M.D HH:mm`)이라야 담당자가 섞어 봐도 어색하지 않다.
 */
function parseTransferAt(raw) {
  const s = _cell(raw);
  const m = s.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  const p2 = n => String(n).padStart(2, '0');
  const iso = `${y}-${p2(mo)}-${p2(d)}T${p2(hh || 0)}:${p2(mi || 0)}:${p2(ss || 0)}+09:00`;
  const stamp = `${y}.${Number(mo)}.${Number(d)} ${p2(hh || 0)}:${p2(mi || 0)}`;
  return { iso, stamp };
}

/**
 * 2차원 배열(AOA) → 해석 결과.
 * @param {Array<Array>} aoa  시트 전체(헤더 위 메타 줄 포함)
 * @param {object} [opt] { expectBank } 회차 은행 — 다르면 거부(fail-closed)
 * @returns {{ok:boolean, error?:string, bank?:string, bankLabel?:string, headerRow?:number,
 *            rows?:Array, totals?:object, warnings?:Array}}
 */
function parseResultAoa(aoa, opt = {}) {
  const grid = Array.isArray(aoa) ? aoa : [];
  if (!grid.length) return { ok: false, error: '파일이 비어 있습니다.' };

  // ① 헤더 행 찾기 — 위에서부터 훑어 은행 지문에 걸리는 첫 줄(하드코딩 금지)
  let headerRow = -1, bank = null;
  const scan = Math.min(grid.length, 30);
  for (let i = 0; i < scan && headerRow < 0; i++) {
    const row = (grid[i] || []).map(_cell);
    for (const [key, spec] of Object.entries(BANK_SPECS)) {
      if (spec.detect(row)) { headerRow = i; bank = key; break; }
    }
  }
  if (headerRow < 0) {
    return { ok: false, error: '은행 이체결과 파일이 아닌 것 같습니다 — 입금계좌·처리상태(처리결과) 열을 찾지 못했습니다.' };
  }

  // ② 회차 은행과 다르면 **거부**. 엉뚱한 회차에 올리면 남의 건이 입금완료로 찍힌다.
  if (opt.expectBank && opt.expectBank !== bank) {
    return {
      ok: false, bank,
      error: `이 회차는 ${BANK_SPECS[opt.expectBank] ? BANK_SPECS[opt.expectBank].label : opt.expectBank} 회차인데 올린 파일은 ${BANK_SPECS[bank].label} 결과 파일입니다.`,
    };
  }

  const spec = BANK_SPECS[bank];
  const header = (grid[headerRow] || []).map(_cell);
  const idx = {};
  for (const [field, re] of Object.entries(spec.cols)) {
    idx[field] = header.findIndex(h => re.test(h));
  }
  const missing = spec.required.filter(f => idx[f] < 0);
  if (missing.length) {
    const ko = { transferredAt: '이체시점', account: '입금계좌', amount: '이체금액', status: '처리결과' };
    return { ok: false, bank, error: `필요한 열을 찾지 못했습니다: ${missing.map(f => ko[f] || f).join(', ')}` };
  }

  const rows = [];
  const warnings = [];
  let noDate = 0;
  for (let i = headerRow + 1; i < grid.length; i++) {
    const r = grid[i] || [];
    const acct = accountDigits(r[idx.account]);
    const amount = parseInt(digitsOnly(r[idx.amount]) || '0', 10) || 0;
    // 계좌·금액이 모두 없는 줄은 데이터가 아니다(빈 줄·합계 줄). 조용히 건너뛴다.
    if (!acct && !amount) continue;
    const statusRaw = _cell(r[idx.status]);
    const at = parseTransferAt(r[idx.transferredAt]);
    if (!at) noDate++;
    rows.push({
      seq: rows.length + 1,           // 결과 파일에서 몇 번째 데이터 줄인가(화면 표기·순서 배정 기준)
      sheetRow: i + 1,                // 엑셀에서 몇 번째 줄인가(사람이 파일을 열어 대조할 때)
      accountDigits: acct,
      accountRaw: _cell(r[idx.account]),
      amount,
      holder: idx.holder >= 0 ? _cell(r[idx.holder]) : '',
      memo: idx.memo >= 0 ? _cell(r[idx.memo]) : '',
      statusRaw,
      success: statusRaw === spec.success,
      transferredAtIso: at ? at.iso : null,
      transferredStamp: at ? at.stamp : null,
    });
  }
  if (!rows.length) return { ok: false, bank, error: '결과 행이 하나도 없습니다.' };
  /* ★ 성공인데 이체시점을 못 읽은 건은 **경고로 드러낸다** — 시점을 모르면 입금칸에 적을 값이
     없어 그 건만 조용히 빠지는데, 그게 화면에 안 보이면 "왜 이 사람만 미입금이지"가 된다. */
  if (noDate) warnings.push({ code: 'no_date', count: noDate, message: `이체시점을 읽지 못한 행 ${noDate}건` });

  const success = rows.filter(r => r.success).length;
  return {
    ok: true, bank, bankLabel: spec.label, headerRow,
    rows, warnings,
    totals: { total: rows.length, success, fail: rows.length - success },
  };
}

/* ══════════════════════════════════════════════════════════
   짝 맞추기 — 회차 항목 ↔ 결과 행
   ══════════════════════════════════════════════════════════ */

/** 대조 키 = 계좌 숫자 + 금액 (PRD 확정). 예금주·통장표시는 **표시·검증용**으로만 쓴다. */
function matchKey(accountDigitsValue, amount) {
  return String(accountDigitsValue || '') + '|' + String(parseInt(amount, 10) || 0);
}

/**
 * @param {Array} items  회차 항목(payment_batch_items 뷰) — { id, bankAccount, amount, reviewerName, accountHolder, transferMemo, tabLabel, rowIndex, status }
 * @param {Array} results parseResultAoa().rows
 * @returns {{ pairs:Array, unmatchedResults:Array, orderAssigned:Array, summary:object }}
 *
 *  pairs[i] = { item, result|null, success, reason }
 *   · result=null → '결과에 없음' = 실패(미입금 유지). PRD 확정.
 *  ★ 같은 키가 여러 건이면 **파일 순서대로** 배정한다(사용자 확정). 그 그룹은
 *    `orderAssigned` 로 따로 보고해 화면이 "순서대로 짝지었다"를 말하게 한다.
 */
function matchResults(items, results) {
  const buckets = new Map();          // key → 결과 행 큐(파일 순서 유지)
  for (const r of results || []) {
    const k = matchKey(r.accountDigits, r.amount);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const used = new Set();
  const pairs = [];
  const groupCount = new Map();       // key → 이 회차에서 그 키로 짝지은 건 수

  for (const it of items || []) {
    const k = matchKey(digitsOnly(it.bankAccount), it.amount);
    const q = buckets.get(k);
    const r = (q && q.length) ? q.shift() : null;
    if (r) {
      used.add(r.seq);
      groupCount.set(k, (groupCount.get(k) || 0) + 1);
    }
    pairs.push({
      item: it,
      result: r,
      matchKey: k,
      success: !!(r && r.success),
      reason: !r ? 'not_in_file' : (r.success ? '' : 'bank_failed'),
    });
  }

  // 회차에 없는데 결과 파일에만 있는 행(= 다른 회차 파일이거나 은행에서 추가된 건)
  const unmatchedResults = (results || []).filter(r => !used.has(r.seq));

  /* 순서대로 배정된 그룹 = 같은 키로 2건 이상 짝지은 경우.
     ★ 화면이 이걸 반드시 말해야 한다 — 시스템이 임의로 정한 것이라 사람이 알아야 한다. */
  const orderAssigned = [];
  for (const [k, n] of groupCount) {
    if (n > 1) {
      const sample = pairs.filter(p => p.matchKey === k);
      orderAssigned.push({
        matchKey: k, count: n,
        reviewerName: (sample[0] && sample[0].item && sample[0].item.reviewerName) || '',
        amount: (sample[0] && sample[0].item && sample[0].item.amount) || 0,
      });
    }
  }

  const summary = {
    items: pairs.length,
    matched: pairs.filter(p => p.result).length,
    success: pairs.filter(p => p.success).length,
    failed: pairs.filter(p => p.result && !p.success).length,
    notInFile: pairs.filter(p => !p.result).length,
    unmatchedResults: unmatchedResults.length,
    orderAssignedGroups: orderAssigned.length,
  };
  return { pairs, unmatchedResults, orderAssigned, summary };
}

module.exports = {
  BANK_SPECS,
  digitsOnly, accountDigits, parseTransferAt,
  parseResultAoa, matchKey, matchResults,
};
