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
