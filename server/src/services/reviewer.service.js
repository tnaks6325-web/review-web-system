const pool = require('../db/pool');
const { mutateSubAccounts } = require('./reviewerIdentityCards.service');
const { normalizeKakaoId, KAKAO_ID_HINT } = require('../utils/kakaoId');

/** 결정 226 C — 같은 번호·다른 이름 가입 처리. 기본 'block'(막고 가입된 이름 안내) · 비상 시 SAME_PHONE_REGISTER_MODE=allow(종전 타계정 자동 추가). */
function samePhoneRegisterMode() {
  return String(process.env.SAME_PHONE_REGISTER_MODE || '').trim().toLowerCase() === 'allow' ? 'allow' : 'block';
}

/**
 * 리뷰어 등록 (GAS: registerReviewer)
 */
async function registerReviewer({ name, phone, consent, sheetId, kakaoId, requireKakaoId }) {
  if (!name || !name.trim()) return { ok: false, error: '이름을 입력하세요.' };
  // ★ 카카오톡 아이디 — 리뷰어 본인 가입(/api/reviewer/register)에서만 필수(requireKakaoId).
  //   관리자 경유 등록(외부모집 수동제출)은 값이 없어도 된다(그 경로는 카톡 아이디를 모른다).
  const kakao = normalizeKakaoId(kakaoId);
  if (kakao === null) return { ok: false, field: 'kakaoId', error: KAKAO_ID_HINT };
  if (requireKakaoId && !kakao) return { ok: false, field: 'kakaoId', error: '카카오톡 아이디를 입력하세요.' };

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
    // ★ 결정 226 C — 그 번호의 **주인 본계정**이 있으면(본인 번호를 쓰는 같은 번호 타계정 = 정리 대상) 이 검사가 아니라
    //   아래 본계정 경로(ON CONFLICT)가 판정한다(가입된 이름 = 본계정 이름). 그래서 그 **전체 번호**의 본계정이 어디든 있으면
    //   타계정 검사를 건너뛴다(Codex P1 — 남의 타계정 칸에 같은 번호가 있어도 그 이름을 안내하면 남의 계정으로 로그인하게 된다).
    //   뒤 8자리만 같고 앞자리가 다른 본계정이면 아래 INSERT 가 성공해 phone8 이 둘로 갈리므로 그때는 종전대로 여기서 막는다.
    const { rows: subOwnerRows } = await pool.query(
      `SELECT 1
         FROM reviewers r
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.sub_accounts)='array'
                                           THEN r.sub_accounts ELSE '[]'::jsonb END) AS sub(value)
        WHERE RIGHT(regexp_replace(COALESCE(sub.value->>'phone',''), '[^0-9]', '', 'g'), 8) = $1
          AND NOT EXISTS (SELECT 1 FROM reviewers m
                           WHERE regexp_replace(COALESCE(m.phone,''), '[^0-9]', '', 'g') = $2)
        LIMIT 1`, [phone8, cleanPhone]);
    if (subOwnerRows.length > 0) {
      // 결정 226 C (가)(사용자 확정 2026-10-12) — 타계정 번호는 **이름을 알려주지 않는다**. 로그인이 이름+번호 뒤 8자리라
      //   이름을 알려주면 번호만 아는 사람이 본계정 주인의 계좌·주소까지 보게 된다(Codex 보안 P1). 본계정 이름은 공개 조회가
      //   이미 알려주므로 아래 본계정 경로만 이름을 안내한다. 가족 본인은 자기 이름을 안다.
      const error = '이 번호는 다른 리뷰어의 타계정으로 등록돼 있어요. 로그인 화면에서 등록할 때 쓴 이름으로 로그인해 주세요.';
      return { ok: false, reason: 'phone_registered_as_sub_account', field: 'name', error, message: error };
    }

    // UNIQUE(phone) 제약을 활용한 중복 처리
    const result = await pool.query(`
      INSERT INTO reviewers (name, phone, consent, kakao_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (phone) DO NOTHING
      RETURNING *
    `, [name.trim(), cleanPhone, true, kakao || '']);
    if (result.rowCount > 0) _syncCardsSoon(result.rows, 'register');   // 결정 223 — 새 가입자 본인 카드를 바로 만든다

    if (result.rowCount === 0) {
      // 번호 중복 — 기존 레코드 조회
      const { rows } = await pool.query(
        'SELECT id, name, sub_accounts FROM reviewers WHERE phone = $1', [cleanPhone]
      );
      const existing = rows[0] || {};
      const existingName = (existing.name || '').trim();
      const newName = name.trim();

      // 같은 이름으로 재등록 → 진짜 중복 (이미 등록된 본인)
      if (existingName === newName) {
        // 이미 등록된 본인 — 카톡 아이디는 빈 칸일 때만 채운다(내정보에서 정한 값을 덮지 않는다).
        if (kakao) {
          await pool.query(
            `UPDATE reviewers SET kakao_id = $1 WHERE phone = $2 AND COALESCE(kakao_id,'') = ''`,
            [kakao, cleanPhone]);
        }
        return { ok: true, name: newName, phone: cleanPhone, alreadyRegistered: true };
      }

      // ★ 결정 226 C(사용자 확정 2026-10-12) — 같은 번호 + 다른 이름은 가입을 막고 **이미 가입된 이름**을 알려준다.
      //   종전 A안(타계정 자동 추가)이 "같은 번호 타계정"을 만들어 신원확인 오류의 원인이 됐다. 번호를 아는 것만으로
      //   남의 계정에 이름을 붙일 수 있던 길(reviewerCampaignEditor 레드팀 #1)도 함께 닫힌다.
      //   비상 스위치: 환경변수 SAME_PHONE_REGISTER_MODE=allow → 종전 A안.
      if (samePhoneRegisterMode() === 'block') {
        const error = `이 번호는 이미 '${existingName}' 이름으로 가입돼 있어요. 로그인 화면에서 이름을 '${existingName}' 그대로 넣고 로그인해 주세요.`;
        return { ok: false, reason: 'phone_registered_other_name', field: 'name', registeredName: existingName, error, message: error };
      }
      // (allow) 종전 A안: 같은 번호 + 다른 이름 → 타계정(sub_account)으로 추가하고 등록 허용
      // ★ 조각 2-2(결정 177): 잠금 → 다시 읽기 → 없을 때만 추가(동시 저장 유실 방지 · 카드 즉시 맞춤).
      const p8 = cleanPhone.slice(-8);
      await mutateSubAccounts(existing.id, (subs) => {
        const already = subs.some(s =>
          (s && s.name || '').trim() === newName &&
          (s && s.phone || '').replace(/[^0-9]/g, '').slice(-8) === p8
        );
        if (already) return null;
        subs.push({ name: newName, phone: cleanPhone });
        return subs;
      }, { source: 'register' });
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
    'SELECT id, name, phone FROM reviewers WHERE phone8 = $1 AND name = $2 LIMIT 2', [p8, n]
  );

  if (rows.length === 1) {
    return {
      ok: true, name: rows[0].name, phone: rows[0].phone,
      _ownerReviewerId: rows[0].id, _loginKind: 'self', _loginPhone8: p8,
    };
  }
  if (rows.length > 1) {
    return { ok: false, code: 'AMBIGUOUS_REVIEWER', error: '같은 로그인 정보가 여러 계정에 등록되어 있어 안전하게 로그인할 수 없습니다. 관리자에게 문의해주세요.' };
  }

  // 2) 타계정(sub_accounts) 매칭 — 메인 계정으로 자동 로그인
  // ★ sub_accounts 가 배열이 아닌 문자열 스칼라(이중 인코딩으로 잘못 저장된 데이터)인
  //   행도 매칭 대상에 포함한다 — 아래 JS 루프가 문자열이면 JSON.parse로 복구한다.
  //   (jsonb_array_length 는 스칼라에서 에러를 던지므로 jsonb_typeof 로 분기)
  const { rows: subRows } = await pool.query(
    `SELECT id, name, phone, sub_accounts FROM reviewers
     WHERE sub_accounts IS NOT NULL
       AND ( (jsonb_typeof(sub_accounts) = 'array' AND jsonb_array_length(sub_accounts) > 0)
             OR jsonb_typeof(sub_accounts) = 'string' )`
  );

  const subMatches = [];
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
          subMatches.push({
            ok: true, name: subName, phone: sub.phone || row.phone,
            mainName: row.name, subAccountLogin: true,
            _ownerReviewerId: row.id, _loginKind: 'sub', _loginPhone8: p8,
          });
        }
      }
    } catch (_) {
      // sub_accounts 파싱 실패 시 무시
      continue;
    }
  }

  if (subMatches.length === 1) return subMatches[0];
  if (subMatches.length > 1) {
    return { ok: false, code: 'AMBIGUOUS_REVIEWER', error: '같은 타계정 로그인 정보가 여러 소유자에게 등록되어 있어 안전하게 로그인할 수 없습니다. 관리자에게 문의해주세요.' };
  }

  // 3) 매칭 실패 — 원인별 세부 에러 메시지
  // ★ 결정 226 B(사용자 확정 2026-10-12 · (가)) — 번호는 맞고 이름이 다르면 **그 번호의 본계정 이름**만 알려준다.
  //   본계정 이름은 공개 조회(/api/reviewer/lookup, 사용자 확정으로 유지)가 이미 알려준다. **타계정 이름은 알려주지 않는다** —
  //   이름 + 번호 뒤 8자리가 로그인 열쇠라, 알려주면 번호만 아는 사람이 본계정 주인의 계좌·주소까지 본다(Codex 보안 P1).
  //   그 이름으로 로그인되는 본계정이 **딱 하나**일 때만 이름을 안내한다(둘이면 위 AMBIGUOUS 로 막혀 막다른 안내가 된다 — Codex P2).
  //   "등록 탭에서 같은 번호로 추가 등록" 유도는 없앴다(같은 번호·다른 이름 가입은 막힌다 — 2단계 ①).
  const { rows: phoneRows } = await pool.query(
    'SELECT name FROM reviewers WHERE phone8 = $1 LIMIT 2', [p8]
  );
  const registered = phoneRows.length === 1 ? String(phoneRows[0].name || '').trim() : '';
  if (registered) {
    return { ok: false, error: `이 번호는 '${registered}' 이름으로 가입돼 있어요. 이름을 '${registered}' 그대로 넣고 로그인해 주세요.`, field: 'name' };
  }
  if (phoneRows.length > 0) {
    return { ok: false, error: '입력하신 전화번호로 등록된 계정이 있으나 이름이 일치하지 않습니다. 가입할 때 쓴 이름으로 다시 입력해주세요.', field: 'name' };
  }

  // 입력한 번호가 다른 사람의 타계정으로 등록되어 있는지 확인 — 이름은 알려주지 않는다
  for (const row of subRows) {
    try {
      const subs = typeof row.sub_accounts === 'string' ? JSON.parse(row.sub_accounts) : row.sub_accounts;
      if (!Array.isArray(subs)) continue;
      for (const sub of subs) {
        const subPhone = (sub.phone || '').replace(/[^0-9]/g, '');
        const subPhone8 = subPhone.length >= 8 ? subPhone.slice(-8) : subPhone;
        if (subPhone8 === p8) {
          return { ok: false, error: '이 번호는 다른 리뷰어의 타계정으로 등록돼 있어요. 등록할 때 쓴 이름으로 다시 입력해주세요.', field: 'name' };
        }
      }
    } catch (_) { continue; }
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
    kakaoId,                                   // saveKakaoId
    ownerReviewerId,                           // 서명 리뷰어 세션 사용 시 UUID 스코프
    origin,                                    // 결정 224 — 'order_form' = 구매양식이 보낸 저장(관찰용 표시)
  } = body;
  const _fromOrderForm = String(origin || '') === 'order_form';
  const _event = (code, rows) => {
    try { for (const r of (rows || [])) if (r && r.id) require('./identityRules.service').recordEvent({ source: 'order_form', ownerId: r.id, code }); } catch (_) { /* noop */ }
  };
  const p8 = (phone8 || '').replace(/[^0-9]/g, '');
  if (p8.length !== 8) return { ok: false, error: '전화번호 뒤 8자리 필요' };
  const scopedById = /^[0-9a-f-]{36}$/i.test(String(ownerReviewerId || ''));
  const scopeColumn = scopedById ? 'id' : 'phone8';
  const scopeValue = scopedById ? String(ownerReviewerId) : p8;

  if (action === 'get') {
    const { rows } = await pool.query(
      `SELECT name, phone, income_type AS "incomeType", resident_num AS "residentNum",
              bank_name AS "bankName", bank_account AS "bankAccount",
              account_holder AS "accountHolder", address,
              sub_accounts AS "subAccounts", status, kakao_id AS "kakaoId"
       FROM reviewers WHERE ${scopeColumn} = $1 LIMIT 1`, [scopeValue]
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
    // 코드가 부여된 소유자는 배열을 통째로 바꾸면 member_no와 실제 참여자 UUID의 대응이
    // 깨질 수 있다. 코드 관리 화면에 "타계정 추가/분리" 절차가 생기기 전까지는 fail-closed.
    // 기존(코드 미부여) 리뷰어의 종전 프로필 저장은 그대로 허용한다.
    // ★ 조각 2-2(결정 177): 대상은 id 하나로 확정한 뒤(phone8 은 비유니크 — 여러 행을 한 번에 덮을 수 있다)
    //   잠금 안에서 다시 읽고 shoppingId 를 보존해 저장한다. 종전에는 읽기와 저장 사이가 열려 있어
    //   그 사이 저장된 아이디·자동보강 값이 사라졌다.
    let owner;
    try {
      const { rows: found } = await pool.query(
        `SELECT id, reviewer_no FROM reviewers WHERE ${scopeColumn} = $1 LIMIT 2`, [scopeValue]);
      if (!found.length) return { ok: false, error: '등록된 회원 정보가 없습니다.' };
      if (found.length > 1) return { ok: false, code: 'ambiguous_reviewer', error: '같은 번호의 리뷰어가 여럿이라 저장할 수 없습니다. 관리자에게 문의해주세요.' };
      owner = found[0];
    } catch (identityErr) {
      if (!identityErr || identityErr.code !== '42703') throw identityErr;
      const { rows: found } = await pool.query(`SELECT id FROM reviewers WHERE ${scopeColumn} = $1 LIMIT 2`, [scopeValue]);
      if (!found.length) return { ok: false, error: '등록된 회원 정보가 없습니다.' };
      if (found.length > 1) return { ok: false, code: 'ambiguous_reviewer', error: '같은 번호의 리뷰어가 여럿이라 저장할 수 없습니다. 관리자에게 문의해주세요.' };
      owner = found[0];
    }
    // 코드가 부여된 소유자는 배열을 통째로 바꾸면 member_no와 실제 참여자 UUID의 대응이
    // 깨질 수 있다. 코드 관리 화면에 "타계정 추가/분리" 절차가 생기기 전까지는 fail-closed.
    if (owner.reviewer_no != null) {
      return { ok: false, code: 'identity_accounts_locked',
        error: '코드가 부여된 타계정은 여기서 변경할 수 없습니다. 관리자 코드 관리 절차를 이용해주세요.' };
    }
    const sig = (sub) => `${String(sub && sub.name || '').replace(/\s+/g, '')}|${String(sub && sub.phone || '').replace(/\D/g, '').slice(-8)}`;
    // ★ 결정 226 3·4단계 — 같은 번호 정리로 지운 칸을 옛 화면(정리 전에 열어 둔 내정보)이 통째 저장으로 되살리지 않게 뺀다.
    //   지금 목록에 이미 있는 칸(담당자가 되돌렸거나 다시 넣은 칸)은 건드리지 않는다. 조회 실패는 종전대로 저장(막지 않음).
    let foldedSigs = new Set();
    try {
      const { rows: folded } = await pool.query(
        `SELECT snapshot->'sub'->>'name' AS name, snapshot->'sub'->>'phone' AS phone FROM reviewer_identity_decisions
          WHERE kind = 'fold_self' AND owner_reviewer_id = $1 AND undone_at IS NULL`, [owner.id]);
      foldedSigs = new Set(folded.map((f) => sig(f)));
    } catch (_) { foldedSigs = new Set(); }
    let droppedBefore = 0;
    if (foldedSigs.size) {
      // 검사(같은 연락처 한 번만 등)보다 먼저 뺀다 — 되살아날 칸 때문에 정상 저장이 거부되지 않게.
      let curSigs = new Set();
      try {
        const { rows: [cur] } = await pool.query('SELECT sub_accounts FROM reviewers WHERE id = $1', [owner.id]);
        const list = cur && cur.sub_accounts;
        curSigs = new Set((Array.isArray(list) ? list : []).map((x) => sig(x)));
      } catch (_) { curSigs = new Set(); }
      const keep = subs.filter((sub) => !foldedSigs.has(sig(sub)) || curSigs.has(sig(sub)));
      droppedBefore = subs.length - keep.length;
      subs.length = 0; subs.push(...keep);
    }
    const phone8s = new Set();
    for (const sub of subs) {
      const subPhone8 = String(sub && sub.phone || '').replace(/[^0-9]/g, '').slice(-8);
      if (!subPhone8) return { ok: false, error: '타계정 연락처를 입력해 주세요.' };
      if (phone8s.has(subPhone8)) return { ok: false, error: '같은 연락처의 타계정은 한 번만 등록할 수 있습니다.' };
      phone8s.add(subPhone8);
    }
    // 명의의 공통 아이디는 전용 PATCH 경로에서만 변경한다. 구버전/캐시된 프로필 화면이
    // shoppingId 필드를 싣지 않은 채 타계정의 다른 항목을 수정해도 기존 아이디를 잃지 않게
    // 정확한 이름+전화 매칭을 우선하고, 이름/전화 자체를 편집한 1개 행은 같은 인덱스로 보존한다.
    let droppedFolded = 0;
    await mutateSubAccounts(owner.id, async (currentSubs, _rv, txClient) => {
      const usedOld = new Set();
      // 잠금을 잡은 뒤 한 번 더 — 위에서 읽은 뒤 잠금을 기다리는 사이에 정리가 끝났을 수 있다(레드팀 2).
      //   ★ 같은 트랜잭션 커넥션으로 읽는다 — 풀에서 또 빌리면 동시 저장이 풀을 다 잡았을 때 서로 기다린다(Codex P2).
      //   실패하면 트랜잭션이 깨지므로 SAVEPOINT 로 감싼다.
      try {
        await txClient.query('SAVEPOINT fold_sig_read');
        const { rows: folded } = await txClient.query(
          `SELECT snapshot->'sub'->>'name' AS name, snapshot->'sub'->>'phone' AS phone FROM reviewer_identity_decisions
            WHERE kind = 'fold_self' AND owner_reviewer_id = $1 AND undone_at IS NULL`, [owner.id]);
        for (const f of folded) foldedSigs.add(sig(f));
        await txClient.query('RELEASE SAVEPOINT fold_sig_read');
      } catch (_) {
        try { await txClient.query('ROLLBACK TO SAVEPOINT fold_sig_read'); } catch (__) { /* noop */ }
        /* 조회 실패는 앞서 읽은 목록으로 */
      }
      if (foldedSigs.size) {
        const keep = subs.filter((sub) => !foldedSigs.has(sig(sub)) || currentSubs.some((old) => sig(old) === sig(sub)));
        droppedFolded += subs.length - keep.length;
        subs.length = 0; subs.push(...keep);
      }
      subs.forEach((sub, idx) => {
        let oldIdx = currentSubs.findIndex((old, i) => !usedOld.has(i) && sig(old) === sig(sub));
        if (oldIdx < 0 && currentSubs[idx] && !usedOld.has(idx)) oldIdx = idx;
        if (oldIdx < 0) return;
        usedOld.add(oldIdx);
        const old = currentSubs[oldIdx] || {};
        const savedId = old.shoppingId != null ? old.shoppingId : old.shopping_id;
        if (savedId != null) {
          sub.shoppingId = String(savedId);
          delete sub.shopping_id;
        }
      });
      return subs;
    }, { source: _fromOrderForm ? 'order_form_register' : 'profile' });
    if (_fromOrderForm) _event('order_form_register', [{ id: owner.id }]);   // 결정 224 — 관찰
    // 본계정으로 합친 칸을 다시 넣으려 했으면 알린다(조용히 빠지지 않게 · 화면은 ok 로 처리 — 막지 않는다).
    if (droppedBefore + droppedFolded > 0) {
      return { ok: true, foldedSkipped: droppedBefore + droppedFolded,
        message: '본계정과 같은 번호의 타계정은 본계정으로 합쳐져 있어 다시 저장하지 않았어요.' };
    }
    return { ok: true };
  }

  if (action === 'saveIncomeInfo') {
    // ★ 프론트는 incomeName / (residentNum|jumin) 을 top-level로 전송한다.
    //   (구버전 incomeInfo 객체도 호환). 빈 값은 기존 값을 보존(COALESCE).
    const info = incomeInfo || {};
    const incType = (incomeName || info.incomeType || info.incomeName || '').trim();
    const resNum  = (residentNum || jumin || info.residentNum || info.jumin || '').replace(/[^0-9]/g, '');
    // 결정 224 — 관찰: 구매양식이 소득 정보를 **실제로 바꾸는** 경우만 센다(같은 값 재저장은 세지 않음 · Codex P2)
    let _incChanged = [];
    if (_fromOrderForm && (incType || resNum)) {
      try {
        _incChanged = (await pool.query(
          `SELECT id FROM reviewers WHERE ${scopeColumn} = $3
             AND ((NULLIF($1, '') IS NOT NULL AND income_type IS DISTINCT FROM $1)
               OR (NULLIF($2, '') IS NOT NULL AND resident_num IS DISTINCT FROM $2))`,
          [incType, resNum, scopeValue])).rows;
      } catch (_) { _incChanged = []; }
    }
    const _incRes = await pool.query(
      `UPDATE reviewers SET
         income_type  = COALESCE(NULLIF($1, ''), income_type),
         resident_num = COALESCE(NULLIF($2, ''), resident_num)
       WHERE ${scopeColumn} = $3
       RETURNING id`,
      [incType, resNum, scopeValue]
    );
    _syncCardsSoon(_incRes && _incRes.rows, 'income');
    if (_incChanged.length) _event('order_income_save', _incChanged);   // 결정 224 — 관찰(실제로 바뀐 경우만)
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
    // 결정 224 — 관찰: 구매양식의 "빈 칸만 채우기"가 실제로 빈 칸을 채우는지(기다리지 않음·실패 무시)
    let _bankWasEmpty = [];
    if (fillOnly && (bn || ba || ah)) {
      try {
        _bankWasEmpty = (await pool.query(
          `SELECT id FROM reviewers WHERE ${scopeColumn} = $1
             AND (COALESCE(bank_name,'') = '' OR COALESCE(bank_account,'') = '' OR COALESCE(account_holder,'') = '')`,
          [scopeValue])).rows;
      } catch (_) { _bankWasEmpty = []; }
    }
    const _bankRes = await pool.query(
      `UPDATE reviewers SET
         bank_name      = CASE WHEN $4::bool AND COALESCE(bank_name, '')      <> '' THEN bank_name
                               ELSE COALESCE(NULLIF($1, ''), bank_name) END,
         bank_account   = CASE WHEN $4::bool AND COALESCE(bank_account, '')   <> '' THEN bank_account
                               ELSE COALESCE(NULLIF($2, ''), bank_account) END,
         account_holder = CASE WHEN $4::bool AND COALESCE(account_holder, '') <> '' THEN account_holder
                               ELSE COALESCE(NULLIF($3, ''), account_holder) END
       WHERE ${scopeColumn} = $5
       RETURNING id`,
      [bn, ba, ah, fillOnly, scopeValue]
    );
    _syncCardsSoon(_bankRes && _bankRes.rows, 'bank');
    if (_bankWasEmpty.length) _event('order_bank_fill', _bankWasEmpty);   // 결정 224 — 관찰
    return { ok: true, fillOnly };
  }

  if (action === 'saveAddress') {
    // 본인 주소 저장(빈 문자열이면 초기화 허용)
    const addr = (address == null ? '' : address).toString().trim();
    const _addrRes = await pool.query(`UPDATE reviewers SET address = $1 WHERE ${scopeColumn} = $2 RETURNING id`, [addr, scopeValue]);
    _syncCardsSoon(_addrRes && _addrRes.rows, 'address');
    return { ok: true };
  }

  if (action === 'saveKakaoId') {
    // 본계정 카카오톡 아이디 저장. 빈 값 저장 = 지우기 허용(주소 저장과 같은 규칙).
    const kakao = normalizeKakaoId(kakaoId);
    if (kakao === null) return { ok: false, error: KAKAO_ID_HINT };
    const r = await pool.query(`UPDATE reviewers SET kakao_id = $1 WHERE ${scopeColumn} = $2`, [kakao, scopeValue]);
    if (!r.rowCount) return { ok: false, error: '등록된 회원 정보가 없습니다.' };
    return { ok: true, kakaoId: kakao };
  }

  return { ok: false, error: '알 수 없는 action' };
}

/** 결정 223 — 본인 정보 저장 뒤 그 리뷰어 카드를 바로 맞춘다(기다리지 않음 · 실패는 저장 무영향). */
function _syncCardsSoon(rows, source) {
  try {
    const cards = require('./reviewerIdentityCards.service');
    for (const r of (rows || [])) if (r && r.id) cards.syncOwnerCardsSoon(r.id, { source });
  } catch (_) { /* 카드 맞추기는 저장에 영향 0 — 10분 거울이 따라잡는다 */ }
}

module.exports = {
  registerReviewer,
  verifyReviewer,
  lookupPhone,
  getReviewerList,
  deleteReviewer,
  handleReviewerProfile,
};
