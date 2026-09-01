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
    const phone8 = cleanPhone.slice(-8);
    // 본계정으로 이미 있는 번호의 재등록은 아래 ON CONFLICT 경로가 종전처럼 처리한다.
    // 반면 다른 본계정의 타계정으로 먼저 등록된 번호를 새 본계정으로 만들면, 로그인·검색·정산의
    // phone8 신원축이 둘로 갈라진다. 저장 형태가 구형 문자열/비정상 값이어도 조회가 죽지 않게
    // JSON 배열만 펼쳐 확인하고, 이름과 무관하게 번호 뒤 8자리 충돌을 차단한다.
    const { rows: subOwnerRows } = await pool.query(
      `SELECT 1
         FROM reviewers r
        WHERE EXISTS (
          SELECT 1
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.sub_accounts)='array'
                                           THEN r.sub_accounts ELSE '[]'::jsonb END) AS sub(value)
           WHERE RIGHT(regexp_replace(COALESCE(sub.value->>'phone',''), '[^0-9]', '', 'g'), 8) = $1
        )
        LIMIT 1`, [phone8]);
    if (subOwnerRows.length > 0) {
      return {
        ok: false,
        reason: 'phone_registered_as_sub_account',
        error: '이 번호는 이미 타계정으로 등록되어 있어 새 리뷰어로 등록할 수 없습니다. 타계정 정보를 삭제한 뒤 다시 시도해주세요.',
      };
    }

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
  // ★ sub_accounts 가 배열이 아닌 문자열 스칼라(이중 인코딩으로 잘못 저장된 데이터)인
  //   행도 매칭 대상에 포함한다 — 아래 JS 루프가 문자열이면 JSON.parse로 복구한다.
  //   (jsonb_array_length 는 스칼라에서 에러를 던지므로 jsonb_typeof 로 분기)
  const { rows: subRows } = await pool.query(
    `SELECT name, phone, sub_accounts FROM reviewers
     WHERE sub_accounts IS NOT NULL
       AND ( (jsonb_typeof(sub_accounts) = 'array' AND jsonb_array_length(sub_accounts) > 0)
             OR jsonb_typeof(sub_accounts) = 'string' )`
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
    SELECT name, phone, phone8, registered_at AS "registeredAt", consent, status,
           income_type AS "incomeType", sub_accounts AS "subAccounts",
           admin_memo AS "memo"
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
async function handleReviewerProfile(body = {}) {
  const {
    action, phone8, name, subAccounts, incomeInfo,
    incomeName, residentNum, jumin,            // saveIncomeInfo (프론트는 top-level로 전송)
    bankName, bankAccount, accountHolder,      // saveBankInfo
    onlyIfEmpty,                               // saveBankInfo — 빈 칸만 채움(구매양식 제출 후 자동 저장)
    address,                                   // saveAddress
  } = body;
  const p8 = (phone8 || '').replace(/[^0-9]/g, '');
  if (p8.length !== 8) return { ok: false, error: '전화번호 뒤 8자리 필요' };

  if (action === 'get') {
    const { rows } = await pool.query(
      `SELECT name, phone, income_type AS "incomeType", resident_num AS "residentNum",
              bank_name AS "bankName", bank_account AS "bankAccount",
              account_holder AS "accountHolder", address,
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
    // ★ 프론트는 subAccounts를 JSON.stringify한 "문자열"로 보낸다.
    //   문자열을 그대로 다시 stringify하면 JSONB에 배열이 아닌 문자열 스칼라로
    //   저장돼 verifyReviewer의 타계정 매칭(jsonb_typeof='array' 필터)이 깨진다.
    //   → 문자열이면 파싱하고, 배열만 허용해 정확히 한 번만 인코딩한다.
    let subs = subAccounts;
    if (typeof subs === 'string') {
      try { subs = JSON.parse(subs); }
      catch (_) { return { ok: false, error: '타계정 데이터 형식이 올바르지 않습니다.' }; }
    }
    if (!Array.isArray(subs)) subs = [];
    if (subs.length > 50) return { ok: false, error: '타계정은 최대 50명까지 등록할 수 있습니다.' };
    const phone8s = new Set();
    for (const sub of subs) {
      const subPhone8 = String(sub && sub.phone || '').replace(/[^0-9]/g, '').slice(-8);
      if (!subPhone8) return { ok: false, error: '타계정 연락처를 입력해 주세요.' };
      if (phone8s.has(subPhone8)) return { ok: false, error: '같은 연락처의 타계정은 한 번만 등록할 수 있습니다.' };
      phone8s.add(subPhone8);
    }
    await pool.query(
      'UPDATE reviewers SET sub_accounts = $1::jsonb WHERE phone8 = $2',
      [JSON.stringify(subs), p8]
    );
    return { ok: true };
  }

  if (action === 'saveIncomeInfo') {
    // ★ 프론트는 incomeName / (residentNum|jumin) 을 top-level로 전송한다.
    //   (구버전 incomeInfo 객체도 호환). 빈 값은 기존 값을 보존(COALESCE).
    const info = incomeInfo || {};
    const incType = (incomeName || info.incomeType || info.incomeName || '').trim();
    const resNum  = (residentNum || jumin || info.residentNum || info.jumin || '').replace(/[^0-9]/g, '');
    await pool.query(
      `UPDATE reviewers SET
         income_type  = COALESCE(NULLIF($1, ''), income_type),
         resident_num = COALESCE(NULLIF($2, ''), resident_num)
       WHERE phone8 = $3`,
      [incType, resNum, p8]
    );
    return { ok: true };
  }

  if (action === 'saveBankInfo') {
    // 입금받을 계좌정보 저장 (빈 값은 기존 값 보존)
    const bn = (bankName || '').trim();
    const ba = (bankAccount || '').trim();
    const ah = (accountHolder || '').trim();
    // ★★ onlyIfEmpty = "빈 칸만 채운다"(blank-only). 구매양식 제출 후 자동 저장(search-app.js)이 쓴다.
    //   그 호출은 1번 카드의 계좌를 로그인 리뷰어의 마스터 계좌에 저장하는데, 1번 카드가 타계정 명의면
    //   본인 대표계좌가 타계정 계좌로 덮여 **본인 리뷰비가 타계정 계좌로 송금**된다(payment.service._loadAccounts
    //   가 본인 건에 reviewers.bank_account 를 그대로 쓴다). submit.routes 의 타계정 자동보강이 "본인 공통계좌와
    //   다른 계좌일 때만" 타계정에 기록하는 것과 정면으로 어긋나던 경로 — manualOrder 의 blank-only 규율과 같다.
    // ★ 미전송(undefined) = 종전 덮어쓰기 = 내정보 화면의 계좌 "변경"은 동작 불변(완화가 아니라 범위 축소).
    const fillOnly = onlyIfEmpty === true || String(onlyIfEmpty) === 'true';
    await pool.query(
      `UPDATE reviewers SET
         bank_name      = CASE WHEN $4::bool AND COALESCE(bank_name, '')      <> '' THEN bank_name
                               ELSE COALESCE(NULLIF($1, ''), bank_name) END,
         bank_account   = CASE WHEN $4::bool AND COALESCE(bank_account, '')   <> '' THEN bank_account
                               ELSE COALESCE(NULLIF($2, ''), bank_account) END,
         account_holder = CASE WHEN $4::bool AND COALESCE(account_holder, '') <> '' THEN account_holder
                               ELSE COALESCE(NULLIF($3, ''), account_holder) END
       WHERE phone8 = $5`,
      [bn, ba, ah, fillOnly, p8]
    );
    return { ok: true, fillOnly };
  }

  if (action === 'saveAddress') {
    // 본인 주소 저장(빈 문자열이면 초기화 허용)
    const addr = (address == null ? '' : address).toString().trim();
    await pool.query(`UPDATE reviewers SET address = $1 WHERE phone8 = $2`, [addr, p8]);
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
