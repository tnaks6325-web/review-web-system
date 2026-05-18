const pool = require('../db/pool');

/**
 * 리뷰어 등록 (GAS: registerReviewer)
 */
async function registerReviewer({ name, phone, consent, sheetId }) {
  if (!name || !name.trim()) return { ok: false, error: '이름을 입력하세요.' };

  const cleanPhone = (phone || '').replace(/[^0-9]/g, '');
  if (cleanPhone.length !== 11) {
    return { ok: false, error: '전화번호는 11자리 숫자여야 합니다.' };
  }

  if (consent !== true && consent !== 'true') {
    return { ok: false, error: '개인정보 수집에 동의해야 합니다.' };
  }

  try {
    // UNIQUE(phone) 제약을 활용한 중복 처리
    const result = await pool.query(`
      INSERT INTO reviewers (name, phone, consent)
      VALUES ($1, $2, $3)
      ON CONFLICT (phone) DO NOTHING
      RETURNING *
    `, [name.trim(), cleanPhone, true]);

    if (result.rowCount === 0) {
      // 중복 전화번호
      const { rows } = await pool.query(
        'SELECT name FROM reviewers WHERE phone = $1', [cleanPhone]
      );
      const existingName = rows[0]?.name || '';
      return {
        ok: false,
        isDuplicate: true,
        existingName,
        error: `이미 등록된 전화번호입니다. 기존 이름: ${existingName}`,
      };
    }

    return { ok: true, name: name.trim(), phone: cleanPhone };
  } catch (err) {
    throw new Error('리뷰어 등록 오류: ' + err.message);
  }
}

/**
 * 리뷰어 인증 (GAS: verifyReviewer)
 */
async function verifyReviewer(name, phone8) {
  const p8 = (phone8 || '').replace(/[^0-9]/g, '');
  if (p8.length !== 8) return { ok: false, error: '전화번호 뒤 8자리를 입력하세요.' };

  const { rows } = await pool.query(
    'SELECT name, phone FROM reviewers WHERE phone8 = $1 LIMIT 1', [p8]
  );

  if (rows.length === 0) {
    return { ok: false, error: '등록된 회원 정보가 없습니다.' };
  }

  const reviewer = rows[0];
  if (name && name.trim() !== reviewer.name) {
    return { ok: false, error: '이름이 일치하지 않습니다.' };
  }

  return { ok: true, name: reviewer.name, phone: reviewer.phone };
}

/**
 * 전화번호로 이름 조회 (GAS: lookupPhone)
 */
async function lookupPhone(phone8) {
  const p8 = (phone8 || '').replace(/[^0-9]/g, '');
  if (p8.length !== 8) return { ok: false, error: '전화번호 뒤 8자리를 입력하세요.' };

  const { rows } = await pool.query(
    'SELECT name, phone FROM reviewers WHERE phone8 = $1 LIMIT 1', [p8]
  );

  if (rows.length === 0) return { ok: false, name: '' };
  return { ok: true, name: rows[0].name, phone: rows[0].phone };
}

/**
 * 리뷰어 목록 조회 (GAS: getReviewerList)
 */
async function getReviewerList() {
  const { rows } = await pool.query(`
    SELECT name, phone, registered_at AS "registeredAt", consent, status,
           income_type AS "incomeType", sub_accounts AS "subAccounts"
    FROM reviewers
    ORDER BY registered_at DESC
  `);
  return { ok: true, reviewers: rows, total: rows.length };
}

/**
 * 리뷰어 삭제 (GAS: deleteReviewer)
 */
async function deleteReviewer(name, phone) {
  const cleanPhone = (phone || '').replace(/[^0-9]/g, '');
  const result = await pool.query(
    'DELETE FROM reviewers WHERE name = $1 AND phone = $2',
    [name, cleanPhone]
  );
  if (result.rowCount === 0) return { ok: false, error: '해당 리뷰어를 찾을 수 없습니다.' };
  return { ok: true };
}

/**
 * 리뷰어 프로필 조회/저장 (GAS: getReviewerProfile / saveSubAccounts / saveIncomeInfo)
 */
async function handleReviewerProfile({ action, phone8, name, subAccounts, incomeInfo }) {
  const p8 = (phone8 || '').replace(/[^0-9]/g, '');
  if (p8.length !== 8) return { ok: false, error: '전화번호 뒤 8자리 필요' };

  if (action === 'get') {
    const { rows } = await pool.query(
      `SELECT name, phone, income_type AS "incomeType", resident_num AS "residentNum",
              sub_accounts AS "subAccounts", status
       FROM reviewers WHERE phone8 = $1 LIMIT 1`, [p8]
    );
    if (rows.length === 0) return { ok: false, error: '등록된 회원 정보가 없습니다.' };
    // sub_accounts는 TEXT로 저장된 JSON — 배열로 파싱하여 반환
    const profile = rows[0];
    if (typeof profile.subAccounts === 'string') {
      try { profile.subAccounts = JSON.parse(profile.subAccounts); } catch(_) { profile.subAccounts = []; }
    }
    if (!Array.isArray(profile.subAccounts)) profile.subAccounts = [];
    return { ok: true, profile };
  }

  if (action === 'saveSubAccounts') {
    await pool.query(
      'UPDATE reviewers SET sub_accounts = $1 WHERE phone8 = $2',
      [JSON.stringify(subAccounts || []), p8]
    );
    return { ok: true };
  }

  if (action === 'saveIncomeInfo') {
    const info = incomeInfo || {};
    await pool.query(
      'UPDATE reviewers SET income_type = $1, resident_num = $2 WHERE phone8 = $3',
      [info.incomeType || '', info.residentNum || '', p8]
    );
    return { ok: true };
  }

  return { ok: false, error: '알 수 없는 action' };
}

module.exports = {
  registerReviewer,
  verifyReviewer,
  lookupPhone,
  getReviewerList,
  deleteReviewer,
  handleReviewerProfile,
};
