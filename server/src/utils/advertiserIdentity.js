/**
 * 업체(광고주) 동일성 판정 — 단일 출처.
 *
 * 2026-09-28 실사고(주식회사 올곧은무역 ↔ (주)올곧은무역 · 어니스트캄 ↔ 주식회사 어니스트캄):
 *   인트라넷에서 사업자등록증 정정으로 사업자명의 법인격 표기만 바뀌었는데, 리뷰웹 업체가 원본 ID
 *   (`intranet_advertiser_id`) 없이 이름으로만 등록돼 있어 **같은 업체가 둘**이 됐다.
 *
 * 여기서 정하는 것은 "같은 업체로 **보이는가**"(= 사람에게 물어볼 후보인가) 하나다.
 *   ★★ 자동 병합의 근거가 아니다(결정 004) — 자동으로 붙이는 근거는 여전히 원본 ID 하나다.
 *   ★ 이름 정규화는 계약 매칭과 **같은 함수**(contractMatch.normalizeKey — 주식회사·(주)·㈜·유한회사 등
 *     법인격 표기와 공백·기호 제거). 사본을 두면 "계약은 같은 업체로 보는데 업체관리는 다른 업체로 본다".
 */
const { normalizeKey } = require('./contractMatch');

/** 법인격 표기·공백·기호를 뺀 비교용 이름. 두 글자 미만이면 판정 재료로 쓰지 않는다(빈 키끼리 일치 금지). */
function advertiserNameKey(name) {
  const k = normalizeKey(name);
  return k.length >= 2 ? k : '';
}

/** 사업자번호 숫자만. 10자리가 아니면 판정 재료로 쓰지 않는다(`365-87-02833` ↔ `3658702833` 동일). */
function bizDigits(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length === 10 ? d : '';
}

/**
 * 두 업체가 같은 업체로 보이는가 — 표기만 다른 이름 또는 같은 사업자번호.
 * @param {{name?:string, businessNumber?:string}} a
 * @param {{name?:string, businessNumber?:string}} b
 */
function sameAdvertiser(a, b) {
  const ka = advertiserNameKey(a && a.name), kb = advertiserNameKey(b && b.name);
  if (ka && kb && ka === kb) return true;
  const ba = bizDigits(a && a.businessNumber), bb = bizDigits(b && b.businessNumber);
  return !!(ba && bb && ba === bb);
}

module.exports = { advertiserNameKey, bizDigits, sameAdvertiser };
