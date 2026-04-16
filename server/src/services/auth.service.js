const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const pool    = require('../db/pool');

/**
 * 관리자 로그인 (GAS: handleAdminLoginV2)
 */
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
    'SELECT * FROM admin_users WHERE username = $1 LIMIT 1', [name]
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

/**
 * 관리자 계정 추가 (마스터 전용)
 */
async function addAdminUser(name, pw) {
  const pw_hash = await bcrypt.hash(pw, 10);
  await pool.query(
    'INSERT INTO admin_users (username, pw_hash, role) VALUES ($1, $2, $3)',
    [name, pw_hash, 'admin']
  );
  return { ok: true };
}

/**
 * 관리자 계정 수정
 */
async function editAdminUser(name, newPw) {
  const pw_hash = await bcrypt.hash(newPw, 10);
  const result = await pool.query(
    'UPDATE admin_users SET pw_hash = $1 WHERE username = $2 RETURNING *',
    [pw_hash, name]
  );
  if (result.rowCount === 0) throw new Error('계정을 찾을 수 없습니다.');
  return { ok: true };
}

/**
 * 관리자 계정 삭제
 */
async function deleteAdminUser(name) {
  const result = await pool.query(
    'DELETE FROM admin_users WHERE username = $1', [name]
  );
  if (result.rowCount === 0) throw new Error('계정을 찾을 수 없습니다.');
  return { ok: true };
}

/**
 * 관리자 목록 조회
 */
async function listAdminUsers() {
  const { rows } = await pool.query(
    'SELECT username, role, created_at FROM admin_users ORDER BY created_at'
  );
  return rows;
}

/**
 * 비밀번호 변경
 */
async function changePw(username, currentPw, newPw) {
  if (!newPw || newPw.length < 4) {
    return { ok: false, error: '새 비밀번호는 4자 이상이어야 합니다.' };
  }

  // MASTER 계정
  if (username === process.env.MASTER_ADMIN_NAME) {
    if (currentPw !== process.env.MASTER_ADMIN_PW) {
      return { ok: false, error: '현재 비밀번호가 틀렸습니다.' };
    }
    // 환경변수 기반 마스터 비밀번호는 런타임에 변경 불가 (Railway 환경변수 수정 필요)
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

module.exports = { loginAdmin, addAdminUser, editAdminUser, deleteAdminUser, listAdminUsers, changePw };
