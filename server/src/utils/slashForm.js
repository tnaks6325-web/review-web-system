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

/* ══════════════════════════════════════════════════════════════
   금액 — **숫자 한 덩어리**만 읽는다 (결정 143 보강 2026-11-06)
   종전 parsePrice 는 "숫자만 남기기"였다 → `15,800.00`→1580000 · `1만5천8백원`→158 ·
   `15800(배송비 3000 포함)`→158003000 · `이시현15800`→15800 처럼 **조용히 틀린 금액**이 나왔다.
   지금은 아래만 읽고, 나머지는 null(= 오류로 돌려보냄)이다.
     ① `15800` `15,800원` `15,800 원` `₩15,800`           — 그대로(경고 없음 · 종전과 동일)
     ② `15,800.00`                                        — 소수점 .0… 만 떼고 경고
     ③ `1만5천8백원` `2만원` `1만 5800원`                  — 한글 단위 해석 + 경고
     ④ `15800(배송비 3000 포함)`                          — 괄호 앞 숫자만 + 경고
   ══════════════════════════════════════════════════════════════ */
const PRICE_WARN_OVER = 1000000;     // 100만원 초과 = 경고(사람 확인)
const PRICE_ERROR_OVER = 10000000;   // 1천만원 초과 = 오류(주문번호 등 다른 값이 들어간 것)

function _plainPrice(s) {
  const t = String(s || '').trim().replace(/^₩\s*/, '');
  let m = /^([0-9][0-9,]*)(\.0+)?\s*원?$/.exec(t);
  if (m && !/,$/.test(m[1])) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    return Number.isFinite(n) ? { value: n, note: m[2] ? `결제금액의 소수점(${m[2]})을 떼고 ${n}원으로 읽었습니다` : '' } : null;
  }
  m = /^(?:([0-9]+)\s*만)?\s*(?:([0-9])\s*천)?\s*(?:([0-9])\s*백)?\s*([0-9]+)?\s*원?$/.exec(t);
  if (m && (m[1] || m[2] || m[3])) {
    const man = +(m[1] || 0), cheon = +(m[2] || 0), baek = +(m[3] || 0), rest = +(m[4] || 0);
    const restMax = m[3] ? 100 : m[2] ? 1000 : 10000;
    if (rest >= restMax) return null;
    const n = man * 10000 + cheon * 1000 + baek * 100 + rest;
    return { value: n, note: `한글 단위 금액 '${t}'을(를) ${n}원으로 읽었습니다` };
  }
  return null;
}

/** 금액 상세: { value:number|null, note:string } — note 가 있으면 반드시 경고로 드러낸다 */
function parsePriceDetail(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { value: null, note: '' };
  const p = _plainPrice(s);
  if (p) return p;
  const m = /^(.+?)\s*[(（\[]([^)）\]]*)[)）\]]\s*$/.exec(s);
  if (m) {
    const q = _plainPrice(m[1]);
    if (q) return { value: q.value, note: [q.note, `결제금액 칸의 괄호 메모 '(${m[2].trim()})'는 빼고 ${q.value}원으로 읽었습니다`].filter(Boolean).join(' · ') };
  }
  return { value: null, note: '' };
}

/** 금액: "15,800원" / "15800" → 15800 (못 읽으면 null) */
function parsePrice(raw) { return parsePriceDetail(raw).value; }

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
   ★★ **자른 조각은 그 규칙의 자리에 떨어져야 한다**(보강 2026-11-06) — "예금주와 결제금액"
     규칙이 `kirei223`(아이디)를 `kirei`/`223` 으로 잘라 수취인=kirei 로 접수되던 구멍
     (수취인 칸이 빠진 8칸 줄)을 막는다. 규칙마다 앞 조각이 놓여야 할 자리가 정해져 있다.
   ══════════════════════════════════════════════════════════════ */

/** 흔한 은행 표기(‘은행’으로 안 끝나는 것들 포함) */
const BANK_WORDS = ['은행', '뱅크', 'bank', '농협', '수협', '신협', '새마을금고', '우체국', '축협', '산림조합'];
const BANK_RE = new RegExp('(' + BANK_WORDS.join('|') + ')', 'i');
const BANK_TAIL_RE = new RegExp('(' + BANK_WORDS.join('|') + ')$', 'i');
/** 휴대폰(하이픈/공백 유무 무관) — 가장 강한 앵커 */
const PHONE_RE = /01[0-9][-\s]?\d{3,4}[-\s]?\d{4}/;
/** 글 속의 휴대폰(앞뒤가 숫자가 아님) — 두 사람이 한 줄에 붙었는지 볼 때 */
const PHONE_IN_TEXT_RE = /(^|[^0-9])01[0-9][-\s.]?\d{3,4}[-\s.]?\d{4}($|[^0-9])/;
/** 계좌번호: 숫자·하이픈 6자리 이상 (전화번호와 겹치므로 전화 판정 뒤에 쓴다) */
const ACCT_RE = /^[0-9][0-9-]{5,}$/;

/** 은행 표기 판정 — 별칭은 **이체 서식 단일 출처**(utils/bankCodes.resolveBank, 정확일치)를 그대로 쓴다 */
let _resolveBank = null;
function _bankByAlias(s) {
  if (!_resolveBank) { try { _resolveBank = require('./bankCodes').resolveBank; } catch (_) { _resolveBank = () => null; } }
  try { return !!_resolveBank(s); } catch (_) { return false; }
}
function numericOnly(s) { return /^[0-9][0-9\s.-]*$/.test(String(s == null ? '' : s).trim()); }

function looksPhone(s) { const d = digits(s); return (d.length === 10 || d.length === 11) && /^0/.test(d); }
function looksPrice(s) { return parsePriceDetail(s).value != null; }
function looksAccount(s) { return ACCT_RE.test(String(s || '').trim()) && !looksPhone(s); }
function looksBank(s) {
  const t = String(s || '').trim();
  if (!t || numericOnly(t)) return false;
  return BANK_RE.test(t) || _bankByAlias(t);
}
/** 자르기 가드용(엄격) — 짧고, 숫자가 없고, 은행 낱말로 끝나거나 별칭 정확일치 */
function looksBankName(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 12 || /[0-9]/.test(t)) return false;
  return BANK_TAIL_RE.test(t) || _bankByAlias(t);
}
function looksAddress(s) { return /(시|도|군|구|읍|면|동|리|로|길|번지|호|아파트|빌라|타워)/.test(String(s || '')) && String(s || '').length >= 6; }

/**
 * 붙어 있는 한 칸을 둘로 가르는 규칙들. 확신이 높은 순서.
 * 각 규칙은 [정규식, 설명, 앞조각 가드?] — 캡처 2개(앞칸, 뒷칸)를 반환해야 한다.
 */
const SPLITTERS = [
  // 예금주 + 결제금액 — 이름 뒤에 숫자가 바로 붙음 (사용자가 든 예시)
  [/^(\D{2,20}?)\s*([0-9][0-9,]{2,}\s*원?)$/, '예금주와 결제금액'],
  // 은행 + 계좌번호 — 은행명(별칭 포함: 토스·KB국민·카뱅…) 뒤에 숫자
  [/^(.+?)\s*([0-9][0-9-]{5,})$/, '은행과 계좌번호', looksBankName],
  // 계좌번호 + 예금주 — 숫자 뒤에 한글 이름
  [/^([0-9][0-9-]{5,})\s*([가-힣]{2,6})$/, '계좌번호와 예금주'],
  // 아이디 + 전화번호 — 전화 앞에서 자름
  [/^(.{2,30}?)\s*(01[0-9][-\s]?\d{3,4}[-\s]?\d{4})$/, '아이디와 전화번호'],
  // 전화번호 + 주소 — 전화 뒤에서 자름
  [/^(01[0-9][-\s]?\d{3,4}[-\s]?\d{4})\s*(\D.{3,})$/, '전화번호와 주소'],
  // 주소 + 은행 — 주소 끝에 은행명이 붙음
  [new RegExp('^(.{4,}?)\\s*((?:[가-힣]{0,6})(?:' + BANK_WORDS.join('|') + '))$', 'i'), '주소와 은행'],
];
/** 규칙별로 **앞 조각이 놓여야 할 자리**(최종 칸 수 n 기준) — 다른 자리에 떨어진 자르기는 버린다 */
const SPLIT_POS = {
  '예금주와 결제금액': n => n - 2,
  '은행과 계좌번호': n => n - 4,
  '계좌번호와 예금주': n => n - 3,
  '아이디와 전화번호': () => 2,
  '전화번호와 주소': () => 3,
  '주소와 은행': n => n - 5,
};

/**
 * 칸 배열(≥9)의 **모양 문제** — 값이 제자리에 있지 않은 신호를 사람 말로 돌려준다. [] = 문제 없음.
 * 앞 4칸·뒤 4칸 고정, 가운데는 주소(결정 143 불변식). 빈 칸은 여기서 보지 않는다(필수칸 검사가 본다).
 */
function shapeProblems(p) {
  const n = p.length;
  if (n < FIELD_KEYS.length) return ['칸이 모자랍니다'];
  const out = [];
  const middle = p.slice(HEAD_COUNT, n - TAIL_COUNT);
  const [bank, account, depositor] = p.slice(n - TAIL_COUNT);
  if (middle.length > 1 && middle.some(m => PHONE_IN_TEXT_RE.test(m))) {
    out.push('한 줄에 두 사람이 붙어 있는 것 같습니다 (주소 자리에 전화번호가 또 있습니다) — 한 사람은 한 줄로 나눠 주세요');
  }
  if (looksPhone(p[2]) && !looksPhone(p[3])) out.push('아이디와 전화번호 자리가 바뀐 것 같습니다 — 전화번호는 4번째 칸입니다');
  const bankBad = !!bank && numericOnly(bank);
  const acctBad = !!account && !numericOnly(account);
  const depBad = !!depositor && numericOnly(depositor);
  if (bankBad && acctBad && looksBank(account)) {
    out.push(`은행과 계좌번호 자리가 바뀐 것 같습니다 (은행 자리 '${bank}' · 계좌번호 자리 '${account}')`);
  } else if (acctBad && depBad) {
    out.push(`계좌번호와 예금주 자리가 바뀐 것 같습니다 (계좌번호 자리 '${account}' · 예금주 자리 '${depositor}')`);
  } else {
    if (bankBad) out.push(`은행 자리에 은행 이름이 아닌 값('${bank}')이 있습니다 — 칸 순서를 확인하세요`);
    if (acctBad) out.push(`계좌번호 자리에 숫자가 아닌 값('${account}')이 있습니다 — 칸 순서를 확인하세요`);
    if (depBad) out.push(`예금주 자리에 숫자('${depositor}')가 있습니다 — 칸 순서를 확인하세요`);
  }
  return out;
}

/** 모양 문제 + 금액 판독까지 — 줄이 "제자리에 제 값"인지 */
function _assemblyOk(p) {
  return p.length >= FIELD_KEYS.length && !shapeProblems(p).length && looksPrice(p[p.length - 1]);
}

/**
 * 칸 배열이 "제자리에 제 값이 있는지" 점수화한다(−1 = 채택 불가).
 *
 * ★ 왼쪽부터 먼저 걸리는 자리를 자르면 안 된다 — `kirei223` 같은 아이디도
 *   "이름+숫자"로 보여서 `kirei`/`223`으로 갈리고, 정작 붙어 있던 `이시현15800`은
 *   그대로 남는다(실측). 그래서 **모든 자르기 조합을 만들어 보고 점수가 가장 높은 것**을 고른다.
 */
function scoreParts(p) {
  if (p.length < FIELD_KEYS.length) return -1;
  const n = p.length;
  let s = 0;
  if (looksPhone(p[3])) s += 3; else return -1;             // 전화·금액은 필수 앵커
  if (looksPrice(p[n - 1])) s += 3; else return -1;
  if (shapeProblems(p).length) return -1;                   // 은행·계좌·예금주 모양이 틀리면 채택 안 함
  if (looksBank(p[n - 4])) s += 2;
  if (looksAccount(p[n - 3])) s += 2;
  if (looksAddress(p.slice(HEAD_COUNT, n - TAIL_COUNT).join('/'))) s += 1;
  if (p[n - 2] && !/[0-9]/.test(p[n - 2])) s += 1;          // 예금주에 숫자가 없어야 자연스럽다
  if (p[0] && !/[0-9]/.test(p[0])) s += 1;                  // 리뷰어도 이름
  return s;
}

/**
 * 슬래시가 빠진 줄을 규칙으로 복원한다.
 * 자르기 횟수를 **적은 것부터** 늘려 가며(최대 3회) 완전 탐색하고, 처음 채택 가능한 횟수에서
 * `scoreParts` 가 가장 높은 배열을 고른다. 결과는 9칸 이상(가운데 여러 조각 = 주소 슬래시)일 수 있다
 * — 주소 슬래시와 슬래시 누락이 한 줄에 같이 있으면 칸 수만으로는 9칸이 되어 칸이 밀린다(실측).
 * 필수 앵커(전화·금액)·모양·자리를 못 맞추면 보정을 버린다 — 틀린 값으로 접수하느니 오류가 낫다.
 *
 * @returns {{parts:string[], repairs:string[]}} repairs 가 비면 무보정
 */
function repairSlashParts(parts) {
  const base = parts.length;
  const lack = FIELD_KEYS.length - base;
  if (lack > 3 || base < 2) return { parts: parts.slice(), repairs: [] };
  const minD = Math.max(1, lack);
  const maxD = Math.min(3, minD + 1);

  for (let D = minD; D <= maxD; D++) {
    let best = null;   // { parts, repairs, score }
    const seen = new Set();
    const walk = (cur, repairs, depth) => {
      if (depth === D) {
        const n = cur.length;
        if (n < FIELD_KEYS.length) return;
        for (let i = 0; i < n; i++) {
          for (const label of cur[i].marks) if (SPLIT_POS[label](n) !== i) return;   // 제자리에 안 떨어진 자르기
        }
        const vals = cur.map(c => c.v);
        const sc = scoreParts(vals);
        if (sc >= 0 && (!best || sc > best.score)) best = { parts: vals, repairs, score: sc };
        return;
      }
      for (let i = 0; i < cur.length; i++) {
        for (const [re, label, guard] of SPLITTERS) {
          const m = re.exec(cur[i].v);
          if (!m) continue;
          const a = m[1].trim(), b = m[2].trim();
          if (!a || !b) continue;
          if (guard && !guard(a)) continue;
          const next = cur.slice(0, i).concat([{ v: a, marks: cur[i].marks.concat([label]) }, { v: b, marks: [] }], cur.slice(i + 1));
          const key = next.map(c => c.v + '\u0002' + c.marks.join(',')).join('\u0001');
          if (seen.has(key)) continue;
          seen.add(key);
          walk(next, repairs.concat(`${label} 사이 슬래시(/) 누락을 보정했습니다`), depth + 1);
        }
      }
    };
    walk(parts.map(v => ({ v, marks: [] })), [], 0);
    if (best) return { parts: best.parts, repairs: best.repairs };
  }
  return { parts: parts.slice(), repairs: [] };
}

/**
 * 보정 결과가 말이 되는지 확인 — 앵커 자리(전화·금액)·모양이 맞아야 채택한다.
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

/* ══════════════════════════════════════════════════════════════
   줄 다듬기 (보강 2026-11-06) — 전부 repairs 로 드러낸다(조용한 자동수정 금지)
   ① 전각 슬래시 ／ → /    ② 탭 9칸 이상(엑셀 복사) → /, 그 밖의 탭은 공백
   ③ +82 국가번호 → 0       ④ 줄 앞머리(번호 '1.'·'✅'·'- '·카톡 PC '[이름] [오후 3:12]') 제거
   ⑤ 숫자 칸의 특수 하이픈(–·－) → -   ⑥ 9칸을 넘는 줄 끝의 빈 칸(끝 슬래시) 무시
   ⑦ 칸 라벨('리뷰어:' '전화:' …) 제거 — **라벨이 다른 칸 자리에 있으면 오류**(순서 뒤섞임)
   ⑧ 이름 뒤 괄호 표시 '(리뷰어)' '(수취인)' 제거
   ⚠ 콤마·공백 구분은 받지 않는다 — 주소에 콤마·공백이 흔해 칸 경계를 알 수 없다.
   ══════════════════════════════════════════════════════════════ */
const HEAD_MARK_RES = [
  /^\s*\[[^\]\/]{1,20}\]\s*\[(?:오전|오후|AM|PM)\s*\d{1,2}:\d{2}\]\s*/i,     // 카톡 PC 복사 머리말
  /^\s*\d{1,3}\s*[.)]\s*(?=\D)/,                                              // 1. / 2)
  /^\s*(?:[-–—•·▶►▷☞→✓✔☑✅❤⭐️]|\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/u,  // 머리표·이모지
];

const LABELS = [
  [/^(?:리뷰어(?:\s*(?:이름|명))?)$/, ['reviewerName']],
  [/^(?:이름|성함|성명)$/, ['reviewerName', 'recipient']],
  [/^(?:수취인|수령인|받는\s*(?:분|사람))(?:\s*(?:이름|명))?$/, ['recipient']],
  [/^(?:아이디|id|계정)$/i, ['userId']],
  [/^(?:전화|전화번호|연락처|휴대폰|핸드폰|휴대폰\s*번호|폰)$/, ['phone']],
  [/^(?:주소|배송지|배송\s*주소|받는\s*주소)$/, ['address']],
  [/^(?:은행|은행명)$/, ['bank']],
  [/^(?:계좌|계좌번호)$/, ['account']],
  [/^(?:예금주|예금주명)$/, ['depositor']],
  [/^(?:금액|결제금액|결제\s*금액|구매금액|결제액|가격)$/, ['price']],
];
function splitLabel(part) {
  const m = /^\s*([가-힣A-Za-z ]{1,10}?)\s*[:：]\s*([\s\S]*)$/.exec(String(part || ''));
  if (!m) return null;
  const name = m[1].trim();
  for (const [re, keys] of LABELS) if (re.test(name)) return { label: name, keys, value: m[2].trim() };
  return null;
}
const NAME_TAG_RE = /\s*[(\[（]\s*(리뷰어|수취인|본인|타계정|예금주|구매자|받는\s*분)\s*[)\]）]\s*$/;

function normalizeLine(raw) {
  let s = String(raw == null ? '' : raw);
  const notes = [];
  if (s.includes('／')) { s = s.replace(/／/g, '/'); notes.push('전각 슬래시(／)를 /로 바꿨습니다'); }
  if (s.includes('\t')) {
    const cells = s.split('\t');
    if (cells.length >= FIELD_KEYS.length) { s = cells.map(c => c.trim()).join('/'); notes.push('탭으로 나뉜 칸(엑셀 복사)을 /로 바꿨습니다'); }
    else s = s.replace(/\t+/g, ' ');
  }
  const s82 = s.replace(/\(?\+\s?82\)?[\s.-]?\(?0?\)?\s?(?=1[0-9])/g, '0');
  if (s82 !== s) { s = s82; notes.push('전화번호의 국가번호(+82)를 0으로 바꿨습니다'); }
  let removed = '';
  for (let guard = 0; guard < 5; guard++) {
    let hit = false;
    for (const re of HEAD_MARK_RES) {
      const m = re.exec(s);
      if (m && m[0].length && m[0].length < s.length) { removed += m[0]; s = s.slice(m[0].length); hit = true; }
    }
    if (!hit) break;
  }
  if (removed.trim()) notes.push(`줄 앞머리 '${removed.trim()}'를 지웠습니다`);
  return { line: s, notes };
}

/**
 * 한 줄 파싱.
 * @returns {{ok:boolean, fields:object, errors:string[], warnings:string[], raw:string, extraSlashInAddress:boolean, repairs:string[], missing:string[]}}
 */
function parseSlashLine(line) {
  const raw = String(line == null ? '' : line);
  const norm = normalizeLine(raw);
  let parts = norm.line.split('/').map(s => s.trim());
  const errors = [];
  const warnings = [];
  const notes = norm.notes.slice();
  let repairs = [];

  // ⑤ 숫자만 있는 칸(전화·계좌)의 특수 하이픈
  let dashFixed = false;
  parts = parts.map(v => {
    if (/[‐‑‒–—―−﹣－]/.test(v) && /^[0-9\s‐‑‒–—―−﹣－-]+$/.test(v)) { dashFixed = true; return v.replace(/[‐‑‒–—―−﹣－]/g, '-'); }
    return v;
  });
  if (dashFixed) notes.push('전화·계좌의 특수 하이픈(–)을 -로 바꿨습니다');
  // ⑥ 끝 슬래시 — 9칸을 넘는 빈 끝 칸만(9칸째 빈 금액은 그대로 오류)
  let trailPopped = false;
  while (parts.length > FIELD_KEYS.length && parts[parts.length - 1] === '') { parts.pop(); trailPopped = true; }
  if (trailPopped) notes.push('줄 끝의 빈 칸(끝 슬래시)을 무시했습니다');
  // ⑦ 칸 라벨
  const labels = parts.map(splitLabel);
  const hasLabels = labels.some(Boolean);
  if (hasLabels) {
    parts = parts.map((v, i) => (labels[i] ? labels[i].value : v));
    notes.push("칸 앞의 라벨('리뷰어:' 등)을 지웠습니다");
  }

  const fail = (errs, missing) => ({
    ok: false, raw, fields: {}, warnings, extraSlashInAddress: false, repairs: [], missing: missing || [], errors: errs,
  });

  // ★ 라벨식 여러 줄(한 사람이 여러 줄) — 범위 밖. 알아듣게 돌려보낸다(AI 폴백 대상 아님)
  if (hasLabels && parts.length <= 2) {
    return fail([`한 사람은 한 줄로 적어 주세요 — '항목: 값'을 줄마다 나눈 형식은 읽지 못합니다 (${FIELD_LABELS.join('/')} 순서로 슬래시(/)로 이어 주세요)`]);
  }

  // ★ 슬래시가 모자라거나 칸 모양이 안 맞으면 규칙으로 먼저 붙여 본다(그래도 안 되면 아래에서 사유를 짚어 준다)
  //   라벨이 붙은 줄은 자르지 않는다(라벨-자리 대조가 자르기와 섞이면 근거가 흐려진다)
  if (!hasLabels && (parts.length < FIELD_KEYS.length || !_assemblyOk(parts))) {
    const fixed = repairSlashParts(parts);
    if (fixed.repairs.length && repairLooksSane(fixed.parts)) {
      parts = fixed.parts;
      repairs = fixed.repairs;
    }
  }

  // ★ 결제금액만 빠진 양식(규칙 보정으로도 못 맞춘 8칸 · 끝 슬래시로 9번째가 빈 칸 · 주소에 슬래시가 있는 경우 포함) — 사용자 확정 2026-11-06
  //   나머지 8칸은 채워 보여 주고 금액만 비운다. 금액은 지어내지 않는다(ok:false + missing ['결제금액'] →
  //   화면에서 금액 칸에 직접 넣으면 그 줄이 정상으로 바뀐다). 판정은 "금액 자리에 아무 숫자를 넣으면
  //   정상 양식으로 조립되는가"로 한다 — 모양 검사(은행·계좌·예금주 자리·두 사람 붙음)는 그대로 거친다.
  //   ★ 오류 문구에 "칸이 N개뿐"을 쓰지 않는다 — 그 문구가 AI 보정 폴백의 대상이고, 금액은 원문에 없어 AI 가 지어낼 위험만 있다.
  if (!hasLabels) {
    const pp = (parts.length >= FIELD_KEYS.length && parts[parts.length - 1] === '') ? parts.slice(0, -1) : parts;
    // 은행 자리에 은행 이름이 있어야 한다(목록 밖 은행이면 종전 오류 — 보수적으로) · 금액처럼 보이는 값이 주소 뒤(계좌 자리 제외)에 있으면 금액이 빠진 게 아니라 칸이 밀린 것이다(끝에 옵션 한 칸 더 등)
    const priceElsewhere = pp.some((v, i) => i > HEAD_COUNT && i !== pp.length - 2 && looksPrice(v));
    if (pp.length >= FIELD_KEYS.length - 1 && !priceElsewhere && looksBank(pp[pp.length - 3]) && !looksPrice(pp[pp.length - 1]) && _assemblyOk(pp.concat(['1']))) {
      const probe = parseSlashLine(pp.concat(['1']).join('/'));
      if (probe.ok) {
        const pw = probe.warnings || [];
        return {
          ok: false, raw, fields: Object.assign({}, probe.fields, { price: null }),
          errors: ['결제금액이 없습니다 — 금액 칸에 직접 넣어 주세요'],
          warnings: notes.map(r => r + ' — 값이 맞는지 확인하세요').concat(pw),
          extraSlashInAddress: probe.extraSlashInAddress, repairs: notes.concat(probe.repairs || []), missing: ['결제금액'],
        };
      }
    }
  }

  if (parts.length < FIELD_KEYS.length) {
    const missing = diagnoseMissing(parts);
    const hints = [];
    if (parts.length === FIELD_KEYS.length - 1 && looksPhone(parts[2]) && !looksPhone(parts[3])) {
      hints.push(/[A-Za-z0-9]/.test(parts[1])
        ? '리뷰어·수취인 중 한 칸이 빠졌거나 붙어 있는 것 같습니다 (본인 건이면 이름을 두 번 적어 주세요)'
        : '아이디 칸이 빠진 것 같습니다 (아이디가 없으면 // 처럼 빈 칸으로 두세요)');
    }
    if (/\/\s*$/.test(raw)) hints.push('줄이 슬래시(/)로 끝납니다 — 한 사람은 한 줄로 이어 붙여 주세요');
    else if (!parts.some(looksPhone) && looksPrice(parts[parts.length - 1]) && parts.length <= TAIL_COUNT + 1) {
      hints.push('전화번호 없이 은행·계좌·금액만 있습니다 — 앞 줄에서 이어진 것이면 한 사람은 한 줄로 이어 붙여 주세요');
    }
    return fail([
      `칸이 ${parts.length}개뿐입니다 (${FIELD_KEYS.length}개 필요: ${FIELD_LABELS.join('/')})`
      + (missing.length ? ` — ${missing.join('·')}이(가) 안 보입니다` : (hints.length ? '' : ' — 슬래시(/) 위치를 확인하세요'))
      + (hints.length ? ' — ' + hints.join(' · ') : ''),
    ], missing);
  }

  // ★ 앞 4 + 뒤 4 고정, 가운데 전부를 주소로 재결합
  const n = parts.length;
  const head = parts.slice(0, HEAD_COUNT);
  const tail = parts.slice(n - TAIL_COUNT);
  const middle = parts.slice(HEAD_COUNT, n - TAIL_COUNT);
  const extraSlashInAddress = middle.length > 1;
  const address = middle.join('/').trim();
  const pd0 = parsePriceDetail(tail[3]);
  if (pd0.note) notes.push(pd0.note);

  const fields = {
    reviewerName: head[0], recipient: head[1], userId: head[2], phone: formatPhone(head[3]),
    address,
    bank: tail[0], account: tail[1], depositor: tail[2], price: pd0.value,
  };

  // ⑧ 이름 뒤 괄호 표시
  for (const k of ['reviewerName', 'recipient', 'depositor']) {
    const m = NAME_TAG_RE.exec(String(fields[k] || ''));
    if (m && m.index > 0) { fields[k] = String(fields[k]).slice(0, m.index).trim(); notes.push(`이름 뒤 괄호 표시 '${m[0].trim()}'를 지웠습니다`); }
  }

  // ⑦ 라벨이 붙은 칸은 그 라벨의 자리여야 한다(다르면 순서가 뒤섞인 것 — 조용히 받지 않는다)
  if (hasLabels) {
    labels.forEach((lb, i) => {
      if (!lb) return;
      const key = i < HEAD_COUNT ? FIELD_KEYS[i] : i >= n - TAIL_COUNT ? FIELD_KEYS[FIELD_KEYS.length - (n - i)] : 'address';
      if (key === 'address' && i !== HEAD_COUNT && lb.keys.includes('address')) return;
      if (!lb.keys.includes(key)) {
        errors.push(`칸 순서가 양식과 다릅니다 — ${FIELD_LABELS[FIELD_KEYS.indexOf(key)]} 자리에 '${lb.label}:' 라벨이 있습니다 (${FIELD_LABELS.join('/')} 순서로 적어 주세요)`);
      }
    });
  }

  // ── 모양 검사 (값이 제자리에 있는지) ──
  let shape = shapeProblems(parts);
  if (n > FIELD_KEYS.length && (shape.length || pd0.value == null || pd0.value > PRICE_ERROR_OVER)) {
    const shifted = parts.slice(0, n - 1);
    if (_assemblyOk(shifted)) {
      shape = [`끝에 칸이 더 있습니다 ('${parts[n - 1]}') — 결제금액이 맨 끝 칸이어야 합니다. 주문번호·옵션 같은 값은 빼 주세요`];
    }
  }
  errors.push(...shape);
  const shapeBad = shape.length > 0;

  // ── 검증 (빈칸·형식) ──
  const required = [
    ['reviewerName', '리뷰어'], ['recipient', '수취인'], ['phone', '전화번호'],
    ['address', '주소'], ['bank', '은행'], ['account', '계좌번호'], ['depositor', '예금주'],
  ];
  for (const [k, label] of required) {
    if (!String(fields[k] || '').trim()) errors.push(`${label}이(가) 비어 있습니다`);
  }
  if (fields.price == null || fields.price <= 0) errors.push('결제금액을 숫자로 읽을 수 없습니다');
  else if (!shapeBad && fields.price > PRICE_ERROR_OVER) errors.push(`결제금액이 너무 큽니다 (${fields.price}원) — 주문번호 같은 다른 값이 들어간 것 아닌지 확인하세요`);

  const pd = digits(fields.phone);
  if (pd.length !== 11 && pd.length !== 10) {
    errors.push(`전화번호 자릿수가 이상합니다 (${pd.length || 0}자리)`);
  } else if (pd.length === 10) {
    // 리뷰어 등록(registerReviewer)은 11자리만 허용 → 제출은 하되 자동등록은 생략
    warnings.push('전화번호가 10자리라 리뷰어 자동등록은 생략됩니다 (제출은 진행)');
  }
  if (extraSlashInAddress) warnings.push('주소에 슬래시(/)가 있어 주소로 합쳤습니다 — 값을 확인하세요');
  // 보정한 줄은 반드시 사람이 눈으로 확인하게 한다(조용한 자동수정 금지)
  repairs = notes.concat(repairs);
  repairs.forEach(r => warnings.push(r + ' — 값이 맞는지 확인하세요'));
  if (fields.price > PRICE_WARN_OVER && fields.price <= PRICE_ERROR_OVER) {
    warnings.push(`결제금액이 100만원을 넘습니다 (${fields.price.toLocaleString('ko-KR')}원) — 맞는지 확인하세요`);
  }

  // 타계정 여부(리뷰어 ≠ 수취인)
  const normName = s => String(s || '').replace(/\s+/g, '');
  fields.isSubAccount = !!(fields.reviewerName && fields.recipient
    && normName(fields.reviewerName) !== normName(fields.recipient));

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
  formatPhone, parsePrice, parsePriceDetail, digits,
  repairSlashParts, repairLooksSane, diagnoseMissing, shapeProblems, normalizeLine,
  looksPhone, looksPrice, looksAccount, looksBank, looksAddress,
  FIELD_KEYS, FIELD_LABELS, HEAD_COUNT, TAIL_COUNT,
};
