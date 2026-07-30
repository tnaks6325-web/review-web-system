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

/**
 * 한 줄 파싱.
 * @returns {{ok:boolean, fields:object, errors:string[], warnings:string[], raw:string, extraSlashInAddress:boolean}}
 */
function parseSlashLine(line) {
  const raw = String(line == null ? '' : line);
  const parts = raw.split('/').map(s => s.trim());
  const errors = [];
  const warnings = [];

  if (parts.length < FIELD_KEYS.length) {
    return {
      ok: false, raw, fields: {}, warnings, extraSlashInAddress: false,
      errors: [`칸이 ${parts.length}개뿐입니다 (${FIELD_KEYS.length}개 필요: ${FIELD_LABELS.join('/')})`],
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

  // 타계정 여부(리뷰어 ≠ 수취인)
  const norm = s => String(s || '').replace(/\s+/g, '');
  fields.isSubAccount = !!(fields.reviewerName && fields.recipient
    && norm(fields.reviewerName) !== norm(fields.recipient));

  return { ok: errors.length === 0, raw, fields, errors, warnings, extraSlashInAddress };
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
  FIELD_KEYS, FIELD_LABELS, HEAD_COUNT, TAIL_COUNT,
};
