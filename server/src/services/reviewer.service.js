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
      // 번호 중복 — 기존 레코드 조회
      const { rows } = await pool.query(
        'SELECT name, sub_accounts FROM reviewers WHERE phone = $1', [cleanPhone]
      );
      const existing = rows[0] || {};
      const existingName = (existing.name || '').trim();
      const newName = name.trim();

      // 같은 이름으로 재등록 → 진짜 중복 (이미 등록된 본인)
      if (existingName === newName) {
        return { ok: true, name: newName, phone: cleanPhone, alreadyRegistered: true };
      }

      // ★ A안: 같은 번호 + 다른 이름 → 타계정(sub_account)으로 추가하고 등록 허용
      //   (각 이름이 자기 이름으로 로그인 + 같은 번호 참여 조회 가능)
      let subs = existing.sub_accounts;
      if (typeof subs === 'string') { try { subs = JSON.parse(subs); } catch (_) { subs = []; } }
      if (!Array.isArray(subs)) subs = [];
      const p8 = cleanPhone.slice(-8);
      const already = subs.some(s =>
        (s.name || '').trim() === newName &&
        (s.phone || '').replace(/[^0-9]/g, '').slice(-8) === p8
      );
      if (!already) {
        subs.push({ name: newName, phone: cleanPhone });
        await pool.query('UPDATE reviewers SET sub_accounts = $1 WHERE phone = $2', [JSON.stringify(subs), cleanPhone]);
      }
      return { ok: true, name: newName, phone: cleanPhone, addedAsSubAccount: true, mainName: existingName };
    }

    return { ok: true, name: name.trim(), phone: cleanPhone };
  } catch (err) {
    throw new Error('리뷰어 등록 오류: ' + err.message);
  }
}

/**
 * 리뷰어 인증 (GAS: verifyReviewer)
 * 1) 직접 매칭: phone8 + name
 * 2) 타계정 매칭: sub_accounts JSON 내에서 name + phone 뒤8자리가 일치하면 메인 계정으로 로그인
 * 3) 실패 시 원인별 세부 에러 메시지 반환
 */
async function verifyReviewer(name, phone8) {
  const n = (name || '').trim();
  const p8 = (phone8 || '').replace(/[^0-9]/g, '');
  if (!n) return { ok: false, error: '이름을 입력하세요.', field: 'name' };
  if (p8.length !== 8) return { ok: false, error: '전화번호 뒤 8자리를 정확히 입력하세요.', field: 'phone' };

  // 1) 직접 매칭
  const { rows } = await pool.query(
    'SELECT name, phone FROM reviewers WHERE phone8 = $1 AND name = $2 LIMIT 1', [p8, n]
  );

  if (rows.length > 0) {
    return { ok: true, name: rows[0].name, phone: rows[0].phone };
  }

  // 2) 타계정(sub_accounts) 매칭 — 메인 계정으로 자동 로그인
  // ★ sub_accounts 가 배열이 아닌 스칼라(잘못 저장된 데이터)인 경우
  //   jsonb_array_length 가 "cannot get array length of a scalar" 에러를 던지므로
  //   jsonb_typeof 로 배열일 때만 길이를 평가 (CASE 는 평가 순서 보장)
  const { rows: subRows } = await pool.query(
    `SELECT name, phone, sub_accounts FROM reviewers
     WHERE sub_accounts IS NOT NULL
       AND CASE WHEN jsonb_typeof(sub_accounts) = 'array'
                THEN jsonb_array_length(sub_accounts)
                ELSE 0 END > 0`
  );

  for (const row of subRows) {
    try {
      // JSONB: pg 드라이버가 자동 파싱하므로 이미 배열일 수 있음
      const subs = typeof row.sub_accounts === 'string' ? JSON.parse(row.sub_accounts) : row.sub_accounts;
      if (!Array.isArray(subs)) continue;
      for (const sub of subs) {
        const subName = (sub.name || '').trim();
        const subPhone = (sub.phone || '').replace(/[^0-9]/g, '');
        const subPhone8 = subPhone.length >= 8 ? subPhone.slice(-8) : subPhone;
        if (subName === n && subPhone8 === p8) {
          // ★ A안: 같은 번호·다른 이름 — 입력한 이름(타계정)을 그대로 신원으로 유지
          //   (기존: 주계정 이름으로 접혀 "정영민"→"김정곤"이 되던 문제 해결)
          return { ok: true, name: subName, phone: sub.phone || row.phone, mainName: row.name, subAccountLogin: true };
        }
      }
    } catch (_) {
      // sub_accounts 파싱 실패 시 무시
      continue;
    }
  }

  // 3) 매칭 실패 — 원인별 세부 에러 메시지
  // 입력한 번호가 이미 다른 사람의 타계정으로 등록되어 있는지 확인
  for (const row of subRows) {
    try {
      const subs = typeof row.sub_accounts === 'string' ? JSON.parse(row.sub_accounts) : row.sub_accounts;
      if (!Array.isArray(subs)) continue;
      for (const sub of subs) {
        const subPhone = (sub.phone || '').replace(/[^0-9]/g, '');
        const subPhone8 = subPhone.length >= 8 ? subPhone.slice(-8) : subPhone;
        if (subPhone8 === p8) {
          // ★ A안: 같은 번호 자체는 허용. 다만 입력 이름이 등록된 이름이 아니면 가입/타계정추가 유도
          return { ok: false, error: '이 번호로 등록된 이름이 아닙니다. 이름을 확인하시거나, 등록 탭에서 같은 번호로 추가 등록해주세요.', field: 'name' };
        }
      }
    } catch (_) { continue; }
  }

  // 번호가 DB에 존재하는지 확인 (번호는 맞으나 이름이 다른 경우)
  const { rows: phoneRows } = await pool.query(
    'SELECT name FROM reviewers WHERE phone8 = $1 LIMIT 1', [p8]
  );
  if (phoneRows.length > 0) {
    // 전화번호로 등록된 계정은 있으나 이름이 일치하지 않음 → 이름 확인 유도
    return { ok: false, error: '입력하신 전화번호로 등록된 계정이 있으나 이름이 일치하지 않습니다. 이름을 다시 확인해주세요.', field: 'name' };
  }

  // 이름이 DB에 존재하는지 확인 (이름은 맞으나 번호가 다른 경우)
  const { rows: nameRows } = await pool.query(
    'SELECT phone FROM reviewers WHERE name = $1 LIMIT 1', [n]
  );
  if (nameRows.length > 0) {
    // 이름으로 등록된 계정은 있으나 전화번호가 일치하지 않음 → 번호 확인 유도
    return { ok: false, error: '입력하신 이름으로 등록된 계정이 있으나 전화번호 뒤 8자리가 일치하지 않습니다. 번호를 다시 확인해주세요.', field: 'phone' };
  }

  // 이름도 번호도 DB에 없음 → 미가입
  return { ok: false, error: '가입되지 않은 정보입니다. 이름과 전화번호를 확인하시거나, 먼저 회원가입을 해주세요.', field: 'name' };
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
