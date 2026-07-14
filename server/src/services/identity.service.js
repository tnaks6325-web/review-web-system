/**
 * ═══════════════════════════════════════════════════════════
 * identity.service.js — 구매양식 제출자 신원/유사도 검증
 *
 * 목적: 구매양식 제출값(캡처 AI 추출값 우선, 없으면 폼 입력값)을
 *       리뷰어 내정보(사용자명/전화/주소/계좌) 및 타계정(sub_accounts)과
 *       대조하여 "누구의 참여건인지" 판별한다.
 *
 * 판정 결과(status):
 *  - SELF          : 본인 정보와 일치 (이름+전화 일치, 주소/계좌 통과)
 *  - SUB           : 등록된 타계정과 일치
 *  - NEED_CONFIRM  : 이름+전화는 본인/타계정과 일치하지만 주소·계좌
 *                    유사도가 낮음 → 리뷰어 확인 후 제출(identityConfirmed)
 *  - NEED_SUB_REGISTER : 본인·타계정 어느 쪽과도 불일치(다른 사람 정보)
 *                    → "타계정으로 등록할까요?" 유도
 *
 * 주소 유사도: 휴리스틱(호수·동 숫자 + 문자 바이그램) 1차 →
 *              애매(uncertain)하면 Gemini 텍스트 판정(verifyAddressMatch) 보완.
 *              Gemini 실패 시 uncertain은 NEED_CONFIRM(소프트)로 처리 — 하드차단 없음.
 *
 * ★ fail-open 원칙: 이 모듈의 내부 오류가 주문 접수를 막아선 안 된다.
 *   호출부(submit.routes)는 try/catch로 감싸고 오류 시 통과시킨다.
 * ═══════════════════════════════════════════════════════════
 */
const { logger } = require('../utils/logger');

/* ── 정규화 헬퍼 ─────────────────────────────────────────── */

/** 이름 정규화: 공백 제거 + trim (한글 이름 비교용) */
function normName(s) {
  return String(s || '').replace(/\s+/g, '').trim();
}

/** 전화 정규화: 숫자만 남기고 뒤 8자리 */
function normPhone8(s) {
  return String(s || '').replace(/[^0-9]/g, '').slice(-8);
}

/** 계좌 정규화: 숫자만 */
function normAccount(s) {
  return String(s || '').replace(/[^0-9]/g, '');
}

/** 주소 정규화: 소문자, 특수문자→공백, 공백 압축 */
function normAddress(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[()\[\],./·]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── 주소 유사도 (휴리스틱) ──────────────────────────────── */

/** 호수 추출: "728호" → "728" (없으면 '') */
function extractHo(addr) {
  const m = normAddress(addr).match(/(\d{1,5})\s*호(?![가-힣0-9])/);
  return m ? m[1] : '';
}

/** 동(건물동) 추출: "101동" → "101" — 숫자+동 형태만 (법정동 이름은 제외됨) */
function extractDong(addr) {
  const m = normAddress(addr).match(/(\d{1,4})\s*동(?![가-힣0-9])/);
  return m ? m[1] : '';
}

/** 문자열 바이그램 집합 (공백 제거 후) */
function _bigrams(s) {
  const t = String(s || '').replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** 바이그램 자카드 유사도 0~1 */
function bigramJaccard(a, b) {
  const A = _bigrams(a);
  const B = _bigrams(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 주소 유사도 휴리스틱 판정.
 * @returns {{ verdict: 'match'|'uncertain'|'mismatch', score: number, reason: string }}
 *
 * 규칙:
 *  - 양쪽 다 호수가 있는데 다르면 → mismatch (다른 유닛)
 *  - 호수 일치 + 바이그램 유사도 ≥ 0.25 → match
 *    (예: "서면다인로얄팰리스 728호" ≈ "서면팰리스 728호" — 축약 표기 허용)
 *  - 호수 없이 바이그램 유사도 ≥ 0.6 → match
 *  - 바이그램 유사도 ≤ 0.12 (공통 특징 거의 없음) → mismatch
 *  - 그 외 → uncertain (Gemini 보완 대상: 도로명↔지번 완전 상이 표기 등)
 */
function addressHeuristic(a, b) {
  const na = normAddress(a);
  const nb = normAddress(b);
  if (!na || !nb) return { verdict: 'uncertain', score: 0, reason: '주소 없음' };
  if (na === nb) return { verdict: 'match', score: 1, reason: '완전 일치' };

  const hoA = extractHo(na), hoB = extractHo(nb);
  const dongA = extractDong(na), dongB = extractDong(nb);
  const sim = bigramJaccard(na, nb);

  // 호수 둘 다 존재 + 불일치 = 다른 유닛
  if (hoA && hoB && hoA !== hoB) {
    return { verdict: 'mismatch', score: sim, reason: `호수 불일치 (${hoA}호 ≠ ${hoB}호)` };
  }
  // 동 둘 다 존재 + 불일치 → 유닛 다름 (호수 일치여도 동이 다르면 다른 집)
  if (dongA && dongB && dongA !== dongB) {
    return { verdict: 'mismatch', score: sim, reason: `동 불일치 (${dongA}동 ≠ ${dongB}동)` };
  }
  // 호수 일치 → 건물명 축약 표기 허용 (낮은 임계값)
  if (hoA && hoB && hoA === hoB) {
    if (sim >= 0.25) return { verdict: 'match', score: sim, reason: `호수 일치 + 유사도 ${sim.toFixed(2)}` };
    return { verdict: 'uncertain', score: sim, reason: `호수 일치, 유사도 낮음 ${sim.toFixed(2)} (도로명↔지번 가능)` };
  }
  // 호수 정보 없는 일반 비교
  if (sim >= 0.6) return { verdict: 'match', score: sim, reason: `유사도 ${sim.toFixed(2)}` };
  if (sim <= 0.12) return { verdict: 'mismatch', score: sim, reason: `유사도 매우 낮음 ${sim.toFixed(2)}` };
  return { verdict: 'uncertain', score: sim, reason: `유사도 애매 ${sim.toFixed(2)}` };
}

/**
 * 주소 동일성 최종 판정 — 휴리스틱 1차, uncertain이면 Gemini 보완.
 * Gemini 실패/미설정 시 휴리스틱 verdict 그대로 반환(폴백).
 * @returns {{ verdict: 'match'|'uncertain'|'mismatch', score, reason, geminiUsed: boolean }}
 */
async function addressSame(a, b, { name = '', phone = '' } = {}) {
  const h = addressHeuristic(a, b);
  if (h.verdict !== 'uncertain') return { ...h, geminiUsed: false };

  // 애매 → Gemini 판정 (기존 nc모드 동일인 검증 프롬프트 재사용)
  try {
    const { verifyAddressMatch } = require('./gemini.service');
    const r = await verifyAddressMatch(
      { recipient: name, phone, address: a },
      { recipient: name, phone, address: b }
    );
    if (r && r.ok) {
      return {
        verdict: r.isSamePerson ? 'match' : 'mismatch',
        score: h.score,
        reason: `AI 판정: ${r.reason || (r.isSamePerson ? '동일 주소' : '다른 주소')}`,
        geminiUsed: true,
      };
    }
  } catch (err) {
    logger.warn(`[identity] Gemini 주소판정 실패(휴리스틱 폴백): ${err.message}`);
  }
  return { ...h, geminiUsed: false }; // uncertain 유지 → 호출부에서 NEED_CONFIRM 처리
}

/* ── 프로필 완비 체크 ────────────────────────────────────── */

/**
 * 내정보(사용자명/전화번호/주소/계좌) 완비 여부.
 * @param {object} reviewer — reviewers 행 (name, phone, phone8, address, bank_name, bank_account, account_holder)
 * @returns {string[]} 미등록 항목 라벨 배열 (빈 배열 = 완비)
 */
function profileMissing(reviewer) {
  const missing = [];
  if (!normName(reviewer?.name)) missing.push('사용자명');
  if (!normPhone8(reviewer?.phone || reviewer?.phone8)) missing.push('전화번호');
  if (!String(reviewer?.address || '').trim()) missing.push('주소');
  const hasBank = String(reviewer?.bank_name || '').trim()
    && String(reviewer?.bank_account || '').trim()
    && String(reviewer?.account_holder || '').trim();
  if (!hasBank) missing.push('계좌');
  return missing;
}

/* ── 신원 판별 엔진 ─────────────────────────────────────── */

/**
 * 주문 1건의 신원 판별.
 * @param {object} reviewer — reviewers 행 (+ sub_accounts 배열 파싱 완료)
 * @param {object} order — { recipient, phone, address, bank, account, depositor,
 *                           extractedRecipient?, extractedPhone?, extractedAddress? }
 * @returns {Promise<{status, subIndex, reasons: string[], identity: object}>}
 *   status: 'SELF' | 'SUB' | 'NEED_CONFIRM' | 'NEED_SUB_REGISTER'
 *   identity: 타계정 등록 유도용 파싱된 신원 { name, phone, address, bankName, bankAccount, accountHolder }
 */
async function resolveOrderIdentity(reviewer, order) {
  // ★ 캡처 AI 추출값 우선, 없으면 폼 입력값 (사용자 확정 정책)
  const idName  = normName(order.extractedRecipient || order.recipient);
  const idPhone = normPhone8(order.extractedPhone || order.phone);
  const idAddr  = String(order.extractedAddress || order.address || '').trim();
  const idAcct  = normAccount(order.account);
  const idHolder = normName(order.depositor);

  const identity = {
    name: order.extractedRecipient || order.recipient || '',
    phone: order.extractedPhone || order.phone || '',
    address: idAddr,
    bankName: order.bank || '',
    bankAccount: order.account || '',
    accountHolder: order.depositor || '',
  };

  const reasons = [];
  const selfName = normName(reviewer.name);
  const selfPhone = normPhone8(reviewer.phone || reviewer.phone8);

  // ── 1) 본인 매칭 (이름+전화) ──
  if (idName && idName === selfName && idPhone && idPhone === selfPhone) {
    // 주소 대조
    const addrCheck = await addressSame(reviewer.address, idAddr, { name: identity.name, phone: identity.phone });
    // 계좌 대조: 계좌번호 일치 또는 예금주=등록 예금주
    const acctOk = (idAcct && normAccount(reviewer.bank_account) === idAcct)
      || (idHolder && idHolder === normName(reviewer.account_holder));

    if (addrCheck.verdict === 'match' && acctOk) {
      return { status: 'SELF', subIndex: -1, reasons: [], identity };
    }
    if (addrCheck.verdict !== 'match') reasons.push(`등록 주소와 상이: ${addrCheck.reason}`);
    if (!acctOk) reasons.push('등록 계좌(계좌번호/예금주)와 상이');
    return { status: 'NEED_CONFIRM', subIndex: -1, reasons, identity };
  }

  // ── 2) 타계정 매칭 (이름+전화) ──
  const subs = Array.isArray(reviewer.sub_accounts) ? reviewer.sub_accounts : [];
  const mainAcct = normAccount(reviewer.bank_account);
  const mainHolder = normName(reviewer.account_holder);
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i] || {};
    if (idName && idName === normName(sub.name) && idPhone && idPhone === normPhone8(sub.phone)) {
      // 타계정에 주소/계좌가 등록돼 있으면 대조, 없으면 통과(자동 보강 대상)
      const subReasons = [];
      if (String(sub.address || '').trim() && idAddr) {
        const addrCheck = await addressSame(sub.address, idAddr, { name: identity.name, phone: identity.phone });
        if (addrCheck.verdict !== 'match') subReasons.push(`타계정 등록 주소와 상이: ${addrCheck.reason}`);
      }
      // 계좌: 타계정 전용계좌 또는 본인 공통계좌 어느 쪽이든 일치하면 통과
      //   (타계정 참여건의 리뷰비를 본인 계좌로 받는 흐름은 정상)
      const subAcct = normAccount(sub.bankAccount);
      const acctOkSub =
        (subAcct && idAcct && subAcct === idAcct)
        || (idHolder && idHolder === normName(sub.accountHolder))
        || (mainAcct && idAcct && mainAcct === idAcct)
        || (idHolder && mainHolder && idHolder === mainHolder);
      if (subAcct && idAcct && !acctOkSub) {
        subReasons.push('타계정 등록 계좌·본인 계좌 어느 쪽과도 상이');
      }
      if (subReasons.length > 0) {
        return { status: 'NEED_CONFIRM', subIndex: i, reasons: subReasons, identity };
      }
      return { status: 'SUB', subIndex: i, reasons: [], identity };
    }
  }

  // ── 3) 어느 쪽과도 불일치 → 타계정 등록 유도 ──
  if (idName === selfName && idPhone !== selfPhone) {
    reasons.push('이름은 본인과 같으나 연락처가 다름 (별도 계정으로 판단)');
  } else {
    reasons.push('본인/타계정 정보와 일치하지 않음');
  }
  return { status: 'NEED_SUB_REGISTER', subIndex: -1, reasons, identity };
}

module.exports = {
  normName, normPhone8, normAccount, normAddress,
  extractHo, extractDong, bigramJaccard,
  addressHeuristic, addressSame,
  profileMissing, resolveOrderIdentity,
};
