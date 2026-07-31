/**
 * 슬래시양식 파서 — 외부모집 구매양식 관리자 수동제출용.
 *
 * 관리자들이 카톡으로 받아 시트에 수기 입력하던 포맷:
 *   리뷰어/수취인/아이디/전화번호/주소/은행/계좌번호/예금주/결제금액
 *   예) 이시현/이시현/kirei223/010-7701-1701/부산시 수영구 광안동 119-3번지, 109호/신한은행/496-04-007701/이시현/15800
 *
 * ★★ 주소 슬래시 병합(핵심 불변식)
 *   주소에는 `/`가 자연스럽게 들어간다("월드컵로 12/3, 302호"). 단순 split('/')로 자르면
 *   칸이 통째로 밀려 은행 자리에 주소 조각이, 금액 자리에 예금주가 들어간다
 *   (index-app.js의 `opt.split("/")[0]` 전례가 같은 함정을 이미 밟았다).
 *   → **앞 4칸(리뷰어·수취인·아이디·전화)과 뒤 4칸(은행·계좌·예금주·금액)은 위치가 고정**이므로
 *     그 사이 남는 조각을 전부 `/`로 다시 이어 붙여 주소로 만든다. 이러면 주소에 슬래시가
 *     몇 개 있든 다른 칸이 밀리지 않는다.
 *   ⚠ 은행·계좌·예금주·금액에 `/`가 들어가는 경우는 가정하지 않는다(형식이 강해 실무상 없음).
 *     그런 값이 오면 주소로 흡수되므로 미리보기 표에서 사람이 확인·수정한다.
 *
 * 순수함수 — DB·네트워크 접근 없음. 서버/테스트 공용.
 */

const FIELD_KEYS = ['reviewerName', 'recipient', 'userId', 'phone', 'address', 'bank', 'account', 'depositor', 'price'];
const FIELD_LABELS = ['리뷰어', '수취인', '아이디', '전화번호', '주소', '은행', '계좌번호', '예금주', '결제금액'];
const HEAD_COUNT = 4;   // 리뷰어·수취인·아이디·전화 (주소 앞)
const TAIL_COUNT = 4;   // 은행·계좌·예금주·금액 (주소 뒤)

/** 숫자만 남긴 전화 */
function digits(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, ''); }

/** 전화 표기 통일: 11자리 → 010-1234-5678 / 10자리 → 010-123-4567·02-… (형식 불명은 원본) */
function formatPhone(raw) {
  const d = digits(raw);
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return d.startsWith('02')
    ? `02-${d.slice(2, 6)}-${d.slice(6)}`
    : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return String(raw == null ? '' : raw).trim();
}

/** 금액: "15,800원" / "15800" → 15800 (숫자 없으면 null) */
function parsePrice(raw) {
  const d = digits(raw);
  if (!d) return null;
  const n = parseInt(d, 10);
  return Number.isFinite(n) ? n : null;
}

/* ══════════════════════════════════════════════════════════════
   슬래시 누락 자동 보정

   실무에서 가장 흔한 오타는 **칸 사이 슬래시 하나가 빠지는 것**이다
   (예: `…/신한은행/496-04-007701/이시현15800` — 예금주와 결제금액이 붙음).
   그대로 두면 "칸이 8개뿐입니다"로 통째로 거절돼 관리자가 카톡에서 다시 찾아야 한다.

   ★ 붙은 자리는 **값의 생김새**로 거의 확정할 수 있다 — 전화번호·계좌번호·금액은
     형태가 강하고, 은행은 이름이 정해져 있다. 그래서 AI 없이 규칙으로 먼저 붙인다
     (즉시·무료·오프라인). 규칙이 못 푸는 줄만 AI에게 넘긴다.

   ⚠ **리뷰어+수취인이 붙은 경우는 시도하지 않는다** — 한글 이름 둘이 붙으면
     (`김하나이서연`) 경계를 알 방법이 없고, 잘못 자르면 남의 명의로 접수된다.
   ══════════════════════════════════════════════════════════════ */

/** 흔한 은행 표기(‘은행’으로 안 끝나는 것들 포함) */
const BANK_WORDS = ['은행', '뱅크', 'bank', '농협', '수협', '신협', '새마을금고', '우체국', '축협', '산림조합'];
const BANK_RE = new RegExp('(' + BANK_WORDS.join('|') + ')', 'i');
/** 휴대폰(하이픈/공백 유무 무관) — 가장 강한 앵커 */
const PHONE_RE = /01[0-9][-\s]?\d{3,4}[-\s]?\d{4}/;
/** 계좌번호: 숫자·하이픈 6자리 이상 (전화번호와 겹치므로 전화 판정 뒤에 쓴다) */
const ACCT_RE = /^[0-9][0-9-]{5,}$/;

function looksPhone(s) { const d = digits(s); return (d.length === 10 || d.length === 11) && /^0/.test(d); }
function looksPrice(s) { return /^[0-9][0-9,]*\s*원?$/.test(String(s || '').trim()); }
function looksAccount(s) { return ACCT_RE.test(String(s || '').trim()) && !looksPhone(s); }
function looksBank(s) { return BANK_RE.test(String(s || '')); }
function looksAddress(s) { return /(시|도|군|구|읍|면|동|리|로|길|번지|호|아파트|빌라|타워)/.test(String(s || '')) && String(s || '').length >= 6; }

/**
 * 붙어 있는 한 칸을 둘로 가르는 규칙들. 확신이 높은 순서.
 * 각 규칙은 [정규식, 설명] — 캡처 2개(앞칸, 뒷칸)를 반환해야 한다.
 */
const SPLITTERS = [
  // 예금주 + 결제금액 — 이름 뒤에 숫자가 바로 붙음 (사용자가 든 예시)
  [/^(\D{2,20}?)\s*([0-9][0-9,]{2,}\s*원?)$/, '예금주와 결제금액'],
  // 은행 + 계좌번호 — 은행명 뒤에 숫자
  [new RegExp('^(.{2,12}?(?:' + BANK_WORDS.join('|') + '))\\s*([0-9][0-9-]{5,})$', 'i'), '은행과 계좌번호'],
  // 계좌번호 + 예금주 — 숫자 뒤에 한글 이름
  [/^([0-9][0-9-]{5,})\s*([가-힣]{2,6})$/, '계좌번호와 예금주'],
  // 아이디 + 전화번호 — 전화 앞에서 자름
  [/^(.{2,30}?)\s*(01[0-9][-\s]?\d{3,4}[-\s]?\d{4})$/, '아이디와 전화번호'],
  // 전화번호 + 주소 — 전화 뒤에서 자름
  [/^(01[0-9][-\s]?\d{3,4}[-\s]?\d{4})\s*(\D.{3,})$/, '전화번호와 주소'],
  // 주소 + 은행 — 주소 끝에 은행명이 붙음
  [new RegExp('^(.{4,}?)\\s*((?:[가-힣]{0,6})(?:' + BANK_WORDS.join('|') + '))$', 'i'), '주소와 은행'],
];

/**
 * 9칸으로 맞춰진 배열이 "제자리에 제 값이 있는지" 점수화한다.
 *
 * ★ 왼쪽부터 먼저 걸리는 자리를 자르면 안 된다 — `kirei223` 같은 아이디도
 *   "이름+숫자"로 보여서 `kirei`/`223`으로 갈리고, 정작 붙어 있던 `이시현15800`은
 *   그대로 남는다(실측). 그래서 **모든 자르기 조합을 만들어 보고 점수가 가장 높은 것**을 고른다.
 */
function scoreParts(p) {
  if (p.length !== FIELD_KEYS.length) return -1;
  let s = 0;
  if (looksPhone(p[3])) s += 3; else return -1;             // 전화·금액은 필수 앵커
  if (looksPrice(p[8])) s += 3; else return -1;
  if (looksBank(p[5])) s += 2;
  if (looksAccount(p[6])) s += 2;
  if (looksAddress(p[4])) s += 1;
  if (p[7] && !/[0-9]/.test(p[7])) s += 1;                  // 예금주에 숫자가 없어야 자연스럽다
  if (p[0] && !/[0-9]/.test(p[0])) s += 1;                  // 리뷰어도 이름
  return s;
}

/**
 * 슬래시가 빠진 줄을 규칙으로 복원한다.
 * 필요한 자르기 횟수만큼 **완전 탐색**(칸 ≤ 9 · 규칙 6개라 조합이 수십 개 수준)하고
 * `scoreParts` 가 가장 높은 배열을 채택한다. 필수 앵커(전화·금액)를 못 채우면 보정을 버린다
 * — 틀린 값으로 접수하느니 오류로 돌려보내는 편이 낫다.
 *
 * @returns {{parts:string[], repairs:string[]}} repairs 가 비면 무보정
 */
function repairSlashParts(parts) {
  const need = FIELD_KEYS.length - parts.length;
  if (need <= 0 || need > 3) return { parts: parts.slice(), repairs: [] };

  let best = null;   // { parts, repairs, score }
  const seen = new Set();

  const walk = (cur, repairs, depth) => {
    if (cur.length === FIELD_KEYS.length) {
      const sc = scoreParts(cur);
      if (sc >= 0 && (!best || sc > best.score)) best = { parts: cur, repairs, score: sc };
      return;
    }
    if (depth >= need) return;
    for (let i = 0; i < cur.length; i++) {
      for (const [re, label] of SPLITTERS) {
        const m = re.exec(cur[i]);
        if (!m) continue;
        const a = m[1].trim(), b = m[2].trim();
        if (!a || !b) continue;
        const next = cur.slice(0, i).concat([a, b], cur.slice(i + 1));
        const key = next.join('');
        if (seen.has(key)) continue;
        seen.add(key);
        walk(next, repairs.concat(`${label} 사이 슬래시(/) 누락을 보정했습니다`), depth + 1);
      }
    }
  };
  walk(parts.slice(), [], 0);

  return best ? { parts: best.parts, repairs: best.repairs } : { parts: parts.slice(), repairs: [] };
}

/**
 * 보정 결과가 말이 되는지 확인 — 앵커 자리(전화·금액)가 형태에 맞아야 채택한다.
 * 어긋나면 잘못 자른 것이므로 **보정을 버린다**.
 */
function repairLooksSane(parts) {
  return scoreParts(parts) >= 0;
}

/** 칸이 모자랄 때 "무엇이 안 보이는지" 를 값의 생김새로 짚어 준다 */
function diagnoseMissing(parts) {
  const has = fn => parts.some(fn);
  const out = [];
  if (!has(looksPhone)) out.push('전화번호');
  if (!has(looksAddress)) out.push('주소');
  if (!has(looksBank)) out.push('은행');
  if (!has(looksAccount)) out.push('계좌번호');
  if (!looksPrice(parts[parts.length - 1])) out.push('결제금액');
  return out;
}

/**
 * 한 줄 파싱.
 * @returns {{ok:boolean, fields:object, errors:string[], warnings:string[], raw:string, extraSlashInAddress:boolean, repairs:string[], missing:string[]}}
 */
function parseSlashLine(line) {
  const raw = String(line == null ? '' : line);
  let parts = raw.split('/').map(s => s.trim());
  const errors = [];
  const warnings = [];
  let repairs = [];

  // ★ 슬래시가 모자라면 규칙으로 먼저 붙여 본다(그래도 안 되면 아래에서 사유를 짚어 준다)
  if (parts.length < FIELD_KEYS.length) {
    const fixed = repairSlashParts(parts);
    if (fixed.repairs.length && repairLooksSane(fixed.parts)) {
      parts = fixed.parts;
      repairs = fixed.repairs;
    }
  }

  if (parts.length < FIELD_KEYS.length) {
    const missing = diagnoseMissing(parts);
    return {
      ok: false, raw, fields: {}, warnings, extraSlashInAddress: false, repairs: [], missing,
      errors: [
        `칸이 ${parts.length}개뿐입니다 (${FIELD_KEYS.length}개 필요: ${FIELD_LABELS.join('/')})`
        + (missing.length ? ` — ${missing.join('·')}이(가) 안 보입니다` : ' — 슬래시(/) 위치를 확인하세요'),
      ],
    };
  }

  // ★ 앞 4 + 뒤 4 고정, 가운데 전부를 주소로 재결합
  const head = parts.slice(0, HEAD_COUNT);
  const tail = parts.slice(parts.length - TAIL_COUNT);
  const middle = parts.slice(HEAD_COUNT, parts.length - TAIL_COUNT);
  const extraSlashInAddress = middle.length > 1;
  const address = middle.join('/').trim();

  const fields = {
    reviewerName: head[0], recipient: head[1], userId: head[2], phone: formatPhone(head[3]),
    address,
    bank: tail[0], account: tail[1], depositor: tail[2], price: parsePrice(tail[3]),
  };

  // ── 검증 (빈칸·형식) ──
  const required = [
    ['reviewerName', '리뷰어'], ['recipient', '수취인'], ['phone', '전화번호'],
    ['address', '주소'], ['bank', '은행'], ['account', '계좌번호'], ['depositor', '예금주'],
  ];
  for (const [k, label] of required) {
    if (!String(fields[k] || '').trim()) errors.push(`${label}이(가) 비어 있습니다`);
  }
  if (fields.price == null || fields.price <= 0) errors.push('결제금액을 숫자로 읽을 수 없습니다');

  const pd = digits(fields.phone);
  if (pd.length !== 11 && pd.length !== 10) {
    errors.push(`전화번호 자릿수가 이상합니다 (${pd.length || 0}자리)`);
  } else if (pd.length === 10) {
    // 리뷰어 등록(registerReviewer)은 11자리만 허용 → 제출은 하되 자동등록은 생략
    warnings.push('전화번호가 10자리라 리뷰어 자동등록은 생략됩니다 (제출은 진행)');
  }
  if (extraSlashInAddress) warnings.push('주소에 슬래시(/)가 있어 주소로 합쳤습니다 — 값을 확인하세요');
  // 보정한 줄은 반드시 사람이 눈으로 확인하게 한다(조용한 자동수정 금지)
  repairs.forEach(r => warnings.push(r + ' — 값이 맞는지 확인하세요'));

  // 타계정 여부(리뷰어 ≠ 수취인)
  const norm = s => String(s || '').replace(/\s+/g, '');
  fields.isSubAccount = !!(fields.reviewerName && fields.recipient
    && norm(fields.reviewerName) !== norm(fields.recipient));

  return { ok: errors.length === 0, raw, fields, errors, warnings, extraSlashInAddress, repairs, missing: [] };
}

/**
 * 여러 줄 파싱. 빈 줄은 건너뛴다(줄 번호는 원문 기준 유지).
 * @returns {Array<{lineNo:number} & ReturnType<typeof parseSlashLine>>}
 */
function parseSlashForm(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const out = [];
  lines.forEach((ln, i) => {
    if (!ln.trim()) return;               // 빈 줄 무시
    out.push({ lineNo: i + 1, ...parseSlashLine(ln) });
  });
  return out;
}

module.exports = {
  parseSlashForm, parseSlashLine,
  formatPhone, parsePrice, digits,
  repairSlashParts, repairLooksSane, diagnoseMissing,
  looksPhone, looksPrice, looksAccount, looksBank, looksAddress,
  FIELD_KEYS, FIELD_LABELS, HEAD_COUNT, TAIL_COUNT,
};
