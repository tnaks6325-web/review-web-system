const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const pool    = require('../db/pool');

// ═══════════════════════════════════════════════════════════
// 관리자 로그인 (GAS: handleAdminLoginV2)
// ═══════════════════════════════════════════════════════════
async function loginAdmin(name, pw) {
  if (!name || !pw) {
    return { success: false, error: '이름과 비밀번호를 입력하세요.' };
  }

  // MASTER 계정 처리 (환경변수 기반)
  if (name === process.env.MASTER_ADMIN_NAME) {
    const masterPw = process.env.MASTER_ADMIN_PW;
    if (pw !== masterPw) {
      return { success: false, error: '비밀번호가 틀렸습니다.' };
    }
    const token = jwt.sign(
      { name, role: 'master' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
    return { success: true, name, role: 'master', token };
  }

  // 일반 관리자 계정 — PostgreSQL 조회
  const { rows } = await pool.query(
    'SELECT * FROM admin_users WHERE username = $1 AND active = TRUE LIMIT 1', [name]
  );
  if (rows.length === 0) {
    return { success: false, error: '존재하지 않는 계정입니다.' };
  }

  const user = rows[0];
  const isMatch = await bcrypt.compare(pw, user.pw_hash);
  if (!isMatch) {
    return { success: false, error: '비밀번호가 틀렸습니다.' };
  }

  const token = jwt.sign(
    { name: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
  return { success: true, name: user.username, role: user.role, token };
}

// ═══════════════════════════════════════════════════════════
// 영업담당자(Staff) 로그인 (GAS: handleStaffLogin)
// ═══════════════════════════════════════════════════════════
async function loginStaff(name, pw) {
  if (!name || !pw) {
    return { success: false, error: '이름과 비밀번호를 입력하세요.' };
  }

  const { rows } = await pool.query(
    'SELECT * FROM staff_users WHERE username = $1 AND active = TRUE LIMIT 1', [name]
  );
  if (rows.length === 0) {
    return { success: false, error: '이름 또는 비밀번호가 올바르지 않습니다.' };
  }

  const user = rows[0];
  const isMatch = await bcrypt.compare(pw, user.pw_hash);
  if (!isMatch) {
    return { success: false, error: '이름 또는 비밀번호가 올바르지 않습니다.' };
  }

  const token = jwt.sign(
    { name: user.username, role: 'staff' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
  return { success: true, name: user.username, role: 'staff', token };
}

// ═══════════════════════════════════════════════════════════
// 인트라넷(inadd-webapp) 계정 로그인 — Track B 통합작업대 SSO(세션 이어받기).
//   자격 검증은 인트라넷 서버(POST /api/auth/login, Cloudflare D1 서버측 대조)에 프록시 —
//   공유키 불필요(사용자 비밀번호가 결속 비밀). 성공 시 review JWT 발급.
//   ★ 권한(사용자 확정 정책 1a): 기본 'staff'(담당 업체 스코프). INTRANET_SSO_ADMIN_USERS(csv,
//     인트라넷 username)에 명시된 지정 계정만 'admin' 승격 — 인트라넷 role 필드는 신뢰하지 않음
//     (자기신고 필드·계정 탈취 대비). 승격이어도 via:'intranet' 격리(/api/trackb/* 전용)는 유지되어
//     Track A 파괴 라우트(탭설정·주문정정·드라이브 등)에는 도달 불가.
//   ★ 진입 조건(2b): INTRANET_SSO_ALLOWED_ROLES(csv) 설정 시 그 인트라넷 role만 진입 허용.
//     미설정(빈) = 전 직원 허용(현행 유지 — env 설정 시점부터 게이트 활성).
//   JWT name = 인트라넷 display_name(한글 실명) → advertisers.inad_pm(TRIM) 스코프 매칭과 정합.
// ═══════════════════════════════════════════════════════════
async function loginIntranet(name, pw, _fetch = fetch) {
  if (!name || !pw) {
    return { success: false, error: '이름과 비밀번호를 입력하세요.' };
  }
  const base = (process.env.INTRANET_API_BASE || 'https://inadd-system.pages.dev').trim().replace(/\/$/, '');
  // 서버간 인증 헤더(X-Api-Key = INTRANET_API_KEY): 인트라넷 API 가드가 활성화되면(INADD_SESSION_SECRET/
  //   INADD_API_KEY 설정) 키 없는 서버간 호출은 "Unauthorized"로 차단된다. /api/auth/login 은 인트라넷 가드의
  //   AUTH_BYPASS(내부)지만 외부 공유키 가드는 통과해야 하므로 이 키를 실어 보낸다(trackB 프록시 #282와 동일 채널).
  //   미설정이면 헤더 미전송(가드 비활성 환경/구버전 인트라넷과의 호환 — 단계적 롤아웃).
  const svcKey = (process.env.INTRANET_API_KEY || '').trim();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  let resp, body;
  try {
    resp = await _fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(svcKey ? { 'X-Api-Key': svcKey } : {}),
      },
      body: JSON.stringify({ username: String(name).trim(), password: String(pw) }),
      signal: ctrl.signal,
    });
    body = await resp.json().catch(() => null);
  } catch (_) {
    return { success: false, error: '인트라넷 인증 서버에 연결할 수 없습니다.' };
  } finally { clearTimeout(timer); }
  if (!resp.ok || !body || !body.username) {
    return { success: false, error: (body && body.error) || '이름 또는 비밀번호가 올바르지 않습니다.' };
  }
  const display = String(body.display_name || body.username).trim();
  if (!display) {
    return { success: false, error: '인트라넷 계정에 표시 이름이 없습니다. 관리자에게 문의하세요.' };
  }
  const _csv = v => String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const iRole = String(body.role || 'user').trim().toLowerCase();
  const iUser = String(body.username).trim().toLowerCase();
  // 승격(1a): 지정 username 만 admin — 인트라넷 role 필드 불신뢰. 그 외 전원 staff(기존 안전장치 유지).
  const isAdminUser = _csv(process.env.INTRANET_SSO_ADMIN_USERS).includes(iUser);
  // 진입 게이트 — 우선순위: 지정 admin 은 항상 통과 → ① 그룹(부서|파트) 규칙(설정 시) → ② role 규칙(① 미설정 시) → 둘 다 미설정 = 전 직원.
  //   ① INTRANET_SSO_ALLOWED_GROUPS: csv 의 각 항목 = '부서' 또는 '부서|파트' (예: "AE,콘텐츠운영팀|체험단파트").
  //     로그인 시점에 인트라넷 직원DB의 department/part 값으로 판정 — 개인별 수동 등록 불필요, 인사이동 자동 반영.
  //     매칭 = TRIM + 대소문 무시 정확 일치(부분일치 없음 — '체험단' ≠ '체험단파트').
  //   ※ part 는 인트라넷 로그인 응답에 포함돼야 판정 가능(inadd-webapp #164 이후) — 부서 단독 규칙은 구버전 응답에서도 동작.
  if (!isAdminUser) {
    const groups = String(process.env.INTRANET_SSO_ALLOWED_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (groups.length) {
      const iDept = String(body.department || '').trim().toLowerCase();
      const iPart = String(body.part || '').trim().toLowerCase();
      const okGroup = groups.some(g => {
        const [d, p] = g.split('|').map(x => String(x || '').trim().toLowerCase());
        return !!d && d === iDept && (!p || p === iPart);
      });
      if (!okGroup) {
        return { success: false, error: '통합 작업대 사용 대상 부서/파트가 아닙니다. 관리자에게 문의하세요.' };
      }
    } else {
      const allowedRoles = _csv(process.env.INTRANET_SSO_ALLOWED_ROLES);
      if (allowedRoles.length && !allowedRoles.includes(iRole)) {
        return { success: false, error: '통합 작업대 사용 권한이 없는 인트라넷 계정입니다. 관리자에게 문의하세요.' };
      }
    }
  }
  const role = isAdminUser ? 'admin' : 'staff';
  // iu = 인트라넷 username(감사 추적용 원천 식별자), ir = 인트라넷 원천 role(감사).
  //   스코프 키는 display_name(=inad_pm 매칭) — 인트라넷 직원DB의 실명은 관리자 관할(HR 데이터) 가정(부품4/CLAUDE.md).
  const token = jwt.sign(
    { name: display, role, via: 'intranet', iu: String(body.username), ir: iRole },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
  return { success: true, name: display, role, via: 'intranet', token };
}

// ═══════════════════════════════════════════════════════════
// 광고주(Advertiser) 로그인 — 업무포털 거래처 계정
// staff 로그인 패턴과 동일하되, JWT 에 advertiser_id 를 포함해
// API 가 "본인 거래처만" 으로 강제 스코핑할 수 있게 한다.
// ═══════════════════════════════════════════════════════════
async function loginAdvertiser(name, pw) {
  if (!name || !pw) {
    return { success: false, error: '이름과 비밀번호를 입력하세요.' };
  }

  const { rows } = await pool.query(
    `SELECT au.*, a.name AS advertiser_name, a.status AS advertiser_status
       FROM advertiser_users au
       JOIN advertisers a ON a.id = au.advertiser_id
      WHERE au.username = $1 AND au.active = TRUE
      LIMIT 1`,
    [name]
  );
  if (rows.length === 0) {
    return { success: false, error: '이름 또는 비밀번호가 올바르지 않습니다.' };
  }

  const user = rows[0];
  const isMatch = await bcrypt.compare(pw, user.pw_hash);
  if (!isMatch) {
    return { success: false, error: '이름 또는 비밀번호가 올바르지 않습니다.' };
  }

  const token = jwt.sign(
    { name: user.username, role: 'advertiser', advertiser_id: user.advertiser_id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
  return {
    success: true,
    name: user.username,
    role: 'advertiser',
    advertiserId: user.advertiser_id,
    advertiserName: user.advertiser_name,
    token,
  };
}

// ═══════════════════════════════════════════════════════════
// 광고주 접속 링크(매직 링크) 교환 — 로그인 없이 유효 토큰이면 advertiser JWT 발급.
//   권한은 loginAdvertiser 와 동일(role='advertiser'+advertiser_id) — 소유 탭만·마스킹·읽기전용 스코프.
//   토큰 = trackb_advertiser_links(active=TRUE) 매칭 + 업체 status<>'ended'. via:'link' 감사 클레임.
//   ★ 유출 대비: 이 토큰은 관리자가 즉시 폐기/회전 가능(trackb_advertiser_links.active). 무인증 경로라 라우트에서 레이트리밋.
// ═══════════════════════════════════════════════════════════
async function loginByLinkToken(linkToken, _pool = pool) {
  const tok = String(linkToken || '').trim();
  if (!tok) return { success: false, error: '유효하지 않은 링크입니다.' };
  const { rows } = await _pool.query(
    `SELECT l.advertiser_id, a.name AS advertiser_name, a.status AS advertiser_status
       FROM trackb_advertiser_links l JOIN advertisers a ON a.id = l.advertiser_id
      WHERE l.token = $1 AND l.active = TRUE LIMIT 1`, [tok]);
  if (rows.length === 0) return { success: false, error: '유효하지 않거나 폐기된 링크입니다.' };
  if (rows[0].advertiser_status === 'ended') return { success: false, error: '종료된 거래처입니다.' };
  _pool.query('UPDATE trackb_advertiser_links SET last_used_at = NOW() WHERE token = $1', [tok]).catch(() => {});
  const token = jwt.sign(
    { name: rows[0].advertiser_name, role: 'advertiser', advertiser_id: rows[0].advertiser_id, via: 'link' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
  return { success: true, name: rows[0].advertiser_name, role: 'advertiser', advertiserId: rows[0].advertiser_id, advertiserName: rows[0].advertiser_name, token };
}

// ═══════════════════════════════════════════════════════════
// 광고주(Advertiser) 계정 CRUD — staff CRUD 패턴 미러 + 거래처 연결
// ═══════════════════════════════════════════════════════════
async function addAdvertiserUser(name, pw, advertiserId) {
  if (!name || !pw) throw new Error('이름과 비밀번호를 입력하세요.');
  if (!advertiserId) throw new Error('거래처(광고주)를 선택하세요.');

  const adv = await pool.query('SELECT 1 FROM advertisers WHERE id = $1', [advertiserId]);
  if (adv.rows.length === 0) throw new Error('존재하지 않는 거래처입니다.');

  const existing = await pool.query('SELECT 1 FROM advertiser_users WHERE username = $1', [name]);
  if (existing.rows.length > 0) throw new Error('이미 존재하는 이름입니다.');

  const pw_hash = await bcrypt.hash(pw, 10);
  await pool.query(
    'INSERT INTO advertiser_users (advertiser_id, username, pw_hash) VALUES ($1, $2, $3)',
    [advertiserId, name, pw_hash]
  );
  const users = await listAdvertiserUsers();
  return { success: true, users };
}

async function editAdvertiserUser(name, newPw, active) {
  const updates = [];
  const values = [];
  let idx = 1;

  if (newPw !== undefined && newPw.length >= 4) {
    const pw_hash = await bcrypt.hash(newPw, 10);
    updates.push(`pw_hash = $${idx++}`);
    values.push(pw_hash);
  }
  if (active !== undefined) {
    updates.push(`active = $${idx++}`);
    values.push(active);
  }

  if (updates.length === 0) throw new Error('변경할 항목이 없습니다.');

  values.push(name);
  const result = await pool.query(
    `UPDATE advertiser_users SET ${updates.join(', ')} WHERE username = $${idx}`,
    values
  );
  if (result.rowCount === 0) throw new Error('존재하지 않는 광고주 계정입니다.');

  const users = await listAdvertiserUsers();
  return { success: true, users };
}

async function deleteAdvertiserUser(name) {
  const result = await pool.query('DELETE FROM advertiser_users WHERE username = $1', [name]);
  if (result.rowCount === 0) throw new Error('존재하지 않는 광고주 계정입니다.');
  const users = await listAdvertiserUsers();
  return { success: true, users };
}

async function listAdvertiserUsers() {
  const { rows } = await pool.query(
    `SELECT au.username AS name, au.active, au.advertiser_id,
            a.name AS advertiser_name, au.created_at AS "createdAt"
       FROM advertiser_users au
       LEFT JOIN advertisers a ON a.id = au.advertiser_id
      ORDER BY au.created_at`
  );
  return rows.map(r => ({
    name: r.name,
    active: r.active !== false,
    advertiserId: r.advertiser_id,
    advertiserName: r.advertiser_name,
  }));
}

// ═══════════════════════════════════════════════════════════
// 관리자 계정 CRUD
// ═══════════════════════════════════════════════════════════
async function addAdminUser(name, pw) {
  if (name === process.env.MASTER_ADMIN_NAME) {
    throw new Error('사용할 수 없는 이름입니다.');
  }
  // 중복 확인
  const existing = await pool.query('SELECT 1 FROM admin_users WHERE username = $1', [name]);
  if (existing.rows.length > 0) throw new Error('이미 존재하는 이름입니다.');

  const pw_hash = await bcrypt.hash(pw, 10);
  await pool.query(
    'INSERT INTO admin_users (username, pw_hash, role) VALUES ($1, $2, $3)',
    [name, pw_hash, 'admin']
  );
  // GAS 호환: users 목록 반환
  const users = await listAdminUsers();
  return { success: true, users };
}

async function editAdminUser(name, newPw, active) {
  const updates = [];
  const values = [];
  let idx = 1;

  if (newPw !== undefined && newPw.length >= 4) {
    const pw_hash = await bcrypt.hash(newPw, 10);
    updates.push(`pw_hash = $${idx++}`);
    values.push(pw_hash);
  }
  if (active !== undefined) {
    updates.push(`active = $${idx++}`);
    values.push(active);
  }

  if (updates.length === 0) throw new Error('변경할 항목이 없습니다.');

  values.push(name);
  const result = await pool.query(
    `UPDATE admin_users SET ${updates.join(', ')} WHERE username = $${idx}`,
    values
  );
  if (result.rowCount === 0) throw new Error('존재하지 않는 관리자입니다.');

  const users = await listAdminUsers();
  return { success: true, users };
}

async function deleteAdminUser(name) {
  const result = await pool.query(
    'DELETE FROM admin_users WHERE username = $1', [name]
  );
  if (result.rowCount === 0) throw new Error('존재하지 않는 관리자입니다.');
  const users = await listAdminUsers();
  return { success: true, users };
}

async function listAdminUsers() {
  const { rows } = await pool.query(
    'SELECT username AS name, role, active, created_at AS "createdAt" FROM admin_users ORDER BY created_at'
  );
  // GAS 호환: pw 필드는 반환하지 않지만, active 필드 포함
  return rows.map(r => ({ name: r.name, active: r.active !== false, role: r.role }));
}

// ═══════════════════════════════════════════════════════════
// 영업담당자(Staff) 계정 CRUD (GAS: handleAddStaffUser 등)
// ═══════════════════════════════════════════════════════════
async function addStaffUser(name, pw) {
  const existing = await pool.query('SELECT 1 FROM staff_users WHERE username = $1', [name]);
  if (existing.rows.length > 0) throw new Error('이미 존재하는 이름입니다.');

  const pw_hash = await bcrypt.hash(pw, 10);
  await pool.query(
    'INSERT INTO staff_users (username, pw_hash) VALUES ($1, $2)',
    [name, pw_hash]
  );
  const users = await listStaffUsers();
  return { success: true, users };
}

async function editStaffUser(name, newPw, active) {
  const updates = [];
  const values = [];
  let idx = 1;

  if (newPw !== undefined && newPw.length >= 4) {
    const pw_hash = await bcrypt.hash(newPw, 10);
    updates.push(`pw_hash = $${idx++}`);
    values.push(pw_hash);
  }
  if (active !== undefined) {
    updates.push(`active = $${idx++}`);
    values.push(active);
  }

  if (updates.length === 0) throw new Error('변경할 항목이 없습니다.');

  values.push(name);
  const result = await pool.query(
    `UPDATE staff_users SET ${updates.join(', ')} WHERE username = $${idx}`,
    values
  );
  if (result.rowCount === 0) throw new Error('존재하지 않는 영업담당자입니다.');

  const users = await listStaffUsers();
  return { success: true, users };
}

async function deleteStaffUser(name) {
  const result = await pool.query(
    'DELETE FROM staff_users WHERE username = $1', [name]
  );
  if (result.rowCount === 0) throw new Error('존재하지 않는 영업담당자입니다.');
  const users = await listStaffUsers();
  return { success: true, users };
}

async function listStaffUsers() {
  const { rows } = await pool.query(
    'SELECT username AS name, active, created_at AS "createdAt" FROM staff_users ORDER BY created_at'
  );
  return rows.map(r => ({ name: r.name, active: r.active !== false }));
}

// ═══════════════════════════════════════════════════════════
// 비밀번호 변경
// ═══════════════════════════════════════════════════════════
async function changePw(username, currentPw, newPw) {
  if (!newPw || newPw.length < 4) {
    return { ok: false, error: '새 비밀번호는 4자 이상이어야 합니다.' };
  }

  // MASTER 계정
  if (username === process.env.MASTER_ADMIN_NAME) {
    if (currentPw !== process.env.MASTER_ADMIN_PW) {
      return { ok: false, error: '현재 비밀번호가 틀렸습니다.' };
    }
    return { ok: false, error: '마스터 비밀번호는 서버 환경변수에서 변경해야 합니다.' };
  }

  // 일반 계정
  const { rows } = await pool.query(
    'SELECT * FROM admin_users WHERE username = $1 LIMIT 1', [username]
  );
  if (rows.length === 0) return { ok: false, error: '계정을 찾을 수 없습니다.' };

  const isMatch = await bcrypt.compare(currentPw, rows[0].pw_hash);
  if (!isMatch) return { ok: false, error: '현재 비밀번호가 틀렸습니다.' };

  const newHash = await bcrypt.hash(newPw, 10);
  await pool.query('UPDATE admin_users SET pw_hash = $1 WHERE username = $2', [newHash, username]);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════
// 마스터 비밀번호 변경 (GAS: handleChangeMasterPw)
// ═══════════════════════════════════════════════════════════
async function changeMasterPw(currentMasterPw, newPw) {
  if (currentMasterPw !== process.env.MASTER_ADMIN_PW) {
    return { error: '현재 마스터 비밀번호가 틀렸습니다.' };
  }
  if (!newPw || newPw.length < 4) {
    return { error: '새 비밀번호는 4자 이상이어야 합니다.' };
  }
  // DB에 마스터 비밀번호 저장 (환경변수 대체)
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('MASTER_PW_OVERRIDE', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [newPw]
  );
  return { success: true };
}

module.exports = {
  loginAdmin,
  loginStaff,
  loginIntranet,
  loginAdvertiser,
  loginByLinkToken,
  addAdvertiserUser,
  editAdvertiserUser,
  deleteAdvertiserUser,
  listAdvertiserUsers,
  addAdminUser,
  editAdminUser,
  deleteAdminUser,
  listAdminUsers,
  addStaffUser,
  editStaffUser,
  deleteStaffUser,
  listStaffUsers,
  changePw,
  changeMasterPw,
};
