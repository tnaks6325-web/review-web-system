/**
 * rowNumbering.js — 작업표 표시 번호(`번호` 칸) 재부여의 **판정 단일 출처**(순수함수).
 *
 * ★★ 여기서 정하는 것은 **표에 보이는 번호**뿐이다. DB `seq` 는 절대 바꾸지 않는다 —
 *   `seq` 는 그 줄의 주소(앵커)라서 재배열하면 다음이 한꺼번에 어긋난다:
 *     · `order_submissions.sheet_row`(주문↔줄 링크)  · `review_index.row_index`(검색·리뷰)
 *     · `review_submissions.row_index`(캡처)         · `participation_links.rowIndex`(리뷰어 내 참여)
 *     · `payment_batch_items(sheet_id,tab_name,row_index)`(이중입금 방지 부분유니크)
 *     · `ON CONFLICT (sheet_id, tab_name, seq)`(투영 제자리 갱신)  · 셀 색·편집 오버레이 앵커
 *   그래서 "8/5 건이 위로 올라가고 145번이 146번이 된다"는 **번호 칸 + 화면 정렬**로 구현한다.
 *
 * ★★ 정렬 규칙(사용자 확정 2026-08-19):
 *     ① 구매일자 오름차순
 *     ② 같은 날짜 안에서는 **주문 제출 시각** 오름차순(주문이 없는 빈 슬롯은 그 날짜의 뒤)
 *     ③ 그래도 같으면 `seq`(안정 정렬 — 다시 돌려도 순서가 흔들리지 않는다)
 *     ④ **구매일자를 읽을 수 없는 줄은 맨 아래**(순서는 `seq`)
 *   ★ ④ 를 "맨 위"로 바꾸지 말 것 — 날짜를 모르는 줄이 1번을 차지하면 그 뒤 번호가 전부 밀린다.
 *
 * ★ 이 파일은 DB·시간(`Date.now()`)에 접근하지 않는다(결정적) — 날짜 파싱은 호출부가
 *   `utils/koreanDate.parseDateColumn` 으로 미리 해서 넘긴다(파서 사본 금지).
 */

/* ★★ 칸 이름 후보는 **목록이 원본**이고 정규식은 거기서 만든다 —
     전체 작업 스캔(SQL)이 같은 목록을 파라미터로 받아 쓰기 때문이다.
     정규식을 따로 적어 두면 "화면 목록엔 뜨는데 정리는 안 되는" 칸이 생긴다. */
/** `번호` 계열 칸 — `trackB.service._displayNumber` 가 쓰던 규칙을 여기로 승격(사본 금지). */
const NUMBER_KEYS = ['번호', 'no', 'no.', '#', '순번'];
/**
 * `담당자` 계열 칸.
 * ★ `담당AE` 는 제외한다 — 그건 영업 담당자(실명)라 작업 담당자 닉네임(만두/망고)과 다른 칸이다.
 */
const MANAGER_KEYS = ['담당', '담당자', '작업담당', '작업담당자'];

const _esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUMBER_KEY_RE = new RegExp('^(' + NUMBER_KEYS.map(_esc).join('|') + ')$', 'i');
const MANAGER_KEY_RE = new RegExp('^(' + MANAGER_KEYS.map(_esc).join('|') + ')$', 'i');

function _keys(src) {
  if (Array.isArray(src)) return src;
  if (src && typeof src === 'object') return Object.keys(src);
  return [];
}
function _findKey(src, re) {
  const k = _keys(src).find(x => re.test(String(x == null ? '' : x).trim()));
  return k == null ? null : k;
}

/** 표의 `번호` 칸 이름(없으면 null). 헤더 배열·row_json 어느 쪽이든 받는다. */
function numberColumnKey(src) { return _findKey(src, NUMBER_KEY_RE); }
/** 표의 `담당자` 칸 이름(없으면 null). */
function managerColumnKey(src) { return _findKey(src, MANAGER_KEY_RE); }

/** 문자열 정리 — 빈 값 판정을 한 곳에서(공백만 있는 칸 = 빈 칸). */
function _txt(v) { return v == null ? '' : String(v).trim(); }

/**
 * 번호 부여 순서대로 줄을 정렬한다(원본 배열 불변).
 * @param {Array<{seq:number, iso?:string|null, submittedAt?:(Date|string|null)}>} rows
 * @returns {Array} 같은 원소들을 정렬한 새 배열
 */
function orderRowsForNumbering(rows) {
  const t = v => {
    if (!v) return null;
    const n = (v instanceof Date) ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(n) ? n : null;
  };
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const ai = _txt(a && a.iso), bi = _txt(b && b.iso);
    if (!!ai !== !!bi) return ai ? -1 : 1;              // ④ 날짜 없는 줄은 맨 아래
    if (ai && bi && ai !== bi) return ai < bi ? -1 : 1; // ① 구매일자 asc ('YYYY-MM-DD' 문자열 비교 = 날짜 비교)
    const at = t(a && a.submittedAt), bt = t(b && b.submittedAt);
    if ((at == null) !== (bt == null)) return at == null ? 1 : -1;  // ② 주문 없는 빈 슬롯은 그 날짜 뒤
    if (at != null && bt != null && at !== bt) return at - bt;      // ② 제출 시각 asc
    return (Number(a && a.seq) || 0) - (Number(b && b.seq) || 0);   // ③ 안정 정렬
  });
}

/**
 * 재부여 계획 산출 — **바뀌는 줄만** 돌려준다(같은 값 재기록 금지 = 쓸데없는 UPDATE 0).
 *
 * @param {Array<{id:*, seq:number, iso?:string|null, submittedAt?:*, number?:*, manager?:*}>} rows
 * @param {object} [opts]
 * @param {string} [opts.manager]        `담당자` 칸에 채울 값(빈 값이면 담당자는 건드리지 않는다)
 * @param {boolean} [opts.hasNumberCol]  표에 번호 칸이 있는가(없으면 번호 변경 없음)
 * @param {boolean} [opts.hasManagerCol] 표에 담당자 칸이 있는가
 * @returns {{ordered:Array, changes:Array<{id:*, seq:number, numberFrom:string, numberTo:string|null, managerTo:string|null}>}}
 */
function computeRenumberPlan(rows, opts = {}) {
  const manager = _txt(opts.manager);
  const hasNum = opts.hasNumberCol !== false;
  const hasMgr = !!opts.hasManagerCol;
  const ordered = orderRowsForNumbering(rows);
  const changes = [];
  ordered.forEach((r, i) => {
    const numberTo = hasNum ? String(i + 1) : null;
    const numberFrom = _txt(r && r.number);
    const numChanged = hasNum && numberFrom !== numberTo;
    /* ★ 담당자는 **blank-only** — 사람이 적어 둔 값(예 다른 담당자)을 시스템이 덮지 않는다.
       ★ 채울 값이 없으면(랜덤·미매핑 = `mapWorkManager` 가 빈 문자열) 아무것도 하지 않는다.
         자동으로 아무나 배정하지 않는다는 `utils/workManager` 규율 그대로. */
    const managerTo = (hasMgr && manager && !_txt(r && r.manager)) ? manager : null;
    if (!numChanged && !managerTo) return;
    changes.push({
      id: r.id, seq: Number(r.seq),
      numberFrom, numberTo: numChanged ? numberTo : null, managerTo,
    });
  });
  return { ordered, changes };
}

/**
 * 화면 정렬 키 — **번호 순**(빈 번호는 맨 아래, 그 안에서는 seq).
 * ★ 표에 보이는 순서와 번호가 갈리면 "8/5 건이 146번인데 여전히 맨 아래" 가 된다.
 *   그래서 정렬은 번호를 따르고, 번호는 위 규칙이 정한다(기준 하나).
 */
function displaySortKey(row, numberKey) {
  const rj = (row && row.row_json && typeof row.row_json === 'object') ? row.row_json
           : (row && row.rowJson && typeof row.rowJson === 'object') ? row.rowJson : {};
  const raw = numberKey ? _txt(rj[numberKey]) : '';
  const n = Number(raw.replace(/[,\s]/g, ''));
  const has = raw !== '' && Number.isFinite(n);
  return { has, n: has ? n : Number.MAX_SAFE_INTEGER, seq: Number(row && row.seq) || 0 };
}

module.exports = {
  NUMBER_KEYS, MANAGER_KEYS, NUMBER_KEY_RE, MANAGER_KEY_RE,
  numberColumnKey, managerColumnKey,
  orderRowsForNumbering, computeRenumberPlan, displaySortKey,
};
