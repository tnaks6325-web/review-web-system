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
 *     ⑤ **지나간 날짜의 빈 줄은 표 맨 아래로 민다**(사용자 확정 2026-08-19 — 든든푸드 쭈꾸미 건):
 *        구매일자가 오늘보다 이전인데 주문·이름·수취인·연락처가 **전부 비어 있는 줄**은
 *        그 날짜 자리를 지키지 않고 아래로 내려간다. **줄은 지우지 않는다**(밀기만).
 *   ★ ④ 를 "맨 위"로 바꾸지 말 것 — 날짜를 모르는 줄이 1번을 차지하면 그 뒤 번호가 전부 밀린다.
 *   ★★ ⑤ 는 **`today` 를 받았을 때만** 켜진다 — 이 파일은 시계를 보지 않으므로(결정적),
 *      호출부가 KST 오늘(`YYYY-MM-DD`)을 넘긴다. 못 받으면 종전 동작 그대로(무회귀).
 *   ★ 순서는 `일반 → 지난 빈 줄 → 날짜 없는 줄` — 날짜 없는 줄이 계속 맨 끝이다(④ 불변).
 *
 * ★ 이 파일은 DB·시간(`Date.now()`)에 접근하지 않는다(결정적) — 날짜 파싱은 호출부가
 *   `utils/koreanDate.parseDateColumn` 으로 미리 해서 넘긴다(파서 사본 금지).
 */

/* ★★ 칸 이름 후보는 **목록이 원본**이고 정규식은 거기서 만든다 —
     전체 작업 스캔(SQL)이 같은 목록을 파라미터로 받아 쓰기 때문이다.
     정규식을 따로 적어 두면 "화면 목록엔 뜨는데 정리는 안 되는" 칸이 생긴다. */
/** `번호` 계열 칸 — `trackB.service._displayNumber` 가 쓰던 규칙을 여기로 승격(사본 금지). */
const NUMBER_KEYS = ['번호', 'no', 'no.', '#', '순번'];

const _esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUMBER_KEY_RE = new RegExp('^(' + NUMBER_KEYS.map(_esc).join('|') + ')$', 'i');

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

/** 문자열 정리 — 빈 값 판정을 한 곳에서(공백만 있는 칸 = 빈 칸). */
function _txt(v) { return v == null ? '' : String(v).trim(); }

/**
 * 번호 부여 순서대로 줄을 정렬한다(원본 배열 불변).
 * @param {Array<{seq:number, iso?:string|null, submittedAt?:(Date|string|null)}>} rows
 * @returns {Array} 같은 원소들을 정렬한 새 배열
 */
function orderRowsForNumbering(rows, opts = {}) {
  const today = _txt(opts && opts.today);
  const t = v => {
    if (!v) return null;
    const n = (v instanceof Date) ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(n) ? n : null;
  };
  const rank = r => {
    const iso = _txt(r && r.iso);
    if (!iso) return 2;                                  // ④ 날짜 없는 줄이 계속 맨 끝
    if (today && iso < today && r && r.filled === false) return 1;  // ⑤ 지나간 날짜의 빈 줄
    return 0;
  };
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ai = _txt(a && a.iso), bi = _txt(b && b.iso);
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
 * ★★ **담당자 칸은 건드리지 않는다**(사용자 확정 2026-08-19) — 담당자는 작업보드 좌측 상단
 *   [작업 조건]에 이미 표기되므로 줄마다 반복할 이유가 없다. 이미 적혀 있는 값도 그대로 둔다.
 *
 * @param {Array<{id:*, seq:number, iso?:string|null, submittedAt?:*, number?:*, filled?:boolean}>} rows
 * @param {object} [opts]
 * @param {boolean} [opts.hasNumberCol]  표에 번호 칸이 있는가(없으면 변경 없음)
 * @param {string}  [opts.today]        KST 오늘 `YYYY-MM-DD`(⑤ 규칙 — 없으면 종전 동작)
 * @returns {{ordered:Array, changes:Array<{id:*, seq:number, numberFrom:string, numberTo:string}>}}
 */
function computeRenumberPlan(rows, opts = {}) {
  const hasNum = opts.hasNumberCol !== false;
  const ordered = orderRowsForNumbering(rows, { today: opts.today });
  const changes = [];
  ordered.forEach((r, i) => {
    if (!hasNum) return;
    const numberTo = String(i + 1);
    const numberFrom = _txt(r && r.number);
    if (numberFrom === numberTo) return;              // 같은 값 재기록 금지(쓸데없는 UPDATE 0)
    changes.push({ id: r.id, seq: Number(r.seq), numberFrom, numberTo });
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

/* ══ "채워진 줄" 판정 — 표에 사람이 들어온 줄인가 ═══════════════════════════════
   ★★ **단일 출처**다. 소비처가 둘이라 갈리면 곧바로 사고가 된다:
     ① SQL(`filledSql`) — 번호 재부여·짝 빈 줄 정리·전체 스캔(`rowNumbering.service`)
     ② JS(`isFilledRow`) — 작업보드 상단 [진행 현황] 참여자 게이지(`trackB.workdeskTab`)
     기준이 다르면 "게이지는 134명인데 정리는 다른 줄을 빈 줄로 본다" 가 된다.
   ★ 판정 = 주문이 붙었거나(order_submission_id) 사람 정보(이름·수취인·연락처) 중
     하나라도 값이 있는 줄. 공백만 있는 칸은 빈 칸으로 본다.
   ★ 작업표 생성 때 미리 깔아 둔 **빈 슬롯**은 여기서 false 다 — 그게 이 판정의 존재 이유다
     (종전에는 게이지가 줄 수를 세어 6명만 들어온 200줄 작업이 `200/200 · 100%` 로 보였다). */

/** 판정에 쓰는 칸 — SQL·JS 가 같은 목록을 본다(사본 금지). `js` = 그 칸의 JS 별칭들. */
const FILLED_FIELDS = [
  { col: 'order_submission_id', text: false, js: ['order_submission_id', 'orderSubmissionId', 'hasOrder'] },
  { col: 'reviewer_name', text: true, js: ['reviewer_name', 'name'] },
  { col: 'recipient_name', text: true, js: ['recipient_name', 'recipient'] },
  { col: 'phone8', text: true, js: ['phone8'] },
];

/**
 * "채워진 줄" SQL 조각. `alias` 는 `campaign_participants` 별칭(예 `'p'`).
 * ★ 별칭은 정규식으로 검증한다(문자열 보간 주입 차단 — `utils/tableOrderNum` 과 같은 규율).
 */
function filledSql(alias = 'p') {
  const a = String(alias);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) throw new Error('filledSql: alias 형식 오류');
  const parts = FILLED_FIELDS.map(f => (f.text
    ? `NULLIF(btrim(COALESCE(${a}.${f.col}, '')), '') IS NOT NULL`
    : `${a}.${f.col} IS NOT NULL`));
  return `(${parts.join('\n   OR ')})`;
}

/**
 * "채워진 줄" JS 판정 — DB 행(`reviewer_name`…)과 합성 행(`name`·`hasOrder`…) 양쪽을 받는다.
 * ★ **마스킹 전 원본으로 부를 것** — 광고주 렌즈를 거친 뒤 세면 빈 칸도 마스킹 문자열이 되어
 *   전 줄이 "채워짐" 으로 뒤집힌다(참여횟수 배지가 마스킹 전에 세는 것과 같은 이유).
 */
function isFilledRow(row) {
  if (!row || typeof row !== 'object') return false;
  return FILLED_FIELDS.some(f => f.js.some(k => {
    if (!Object.prototype.hasOwnProperty.call(row, k)) return false;
    const v = row[k];
    if (v == null || v === false) return false;
    return f.text ? _txt(v) !== '' : true;
  }));
}

module.exports = {
  NUMBER_KEYS, NUMBER_KEY_RE, FILLED_FIELDS,
  numberColumnKey, filledSql, isFilledRow,
  orderRowsForNumbering, computeRenumberPlan, displaySortKey,
};
