const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const {
  authMiddleware,
  adminOrMasterMiddleware,
  internalOnlyMiddleware,
} = require('../middleware/auth.middleware');
const { logger } = require('../utils/logger');

// ═══════════════════════════════════════════════════════════
// 업무포털(범용 광고주 작업 관리)
//   - 거래처(advertisers) → 작업(portal_works) 2단 구조
//   - 내부(master/admin/staff): 전체현황 + 모든 거래처 + 전권 편집
//   - 광고주(advertiser): 본인 거래처만(읽기 + 코멘트 + note_client 만 수정)
// ═══════════════════════════════════════════════════════════

function _genAdvId()  { return 'adv_' + crypto.randomBytes(6).toString('hex'); }
function _genWorkId() { return 'pw_'  + crypto.randomBytes(6).toString('hex'); }

function _isInternal(req) {
  return req.admin && ['master', 'admin', 'staff'].includes(req.admin.role);
}
// 광고주는 토큰의 advertiser_id 로 강제 스코핑. 내부는 쿼리/바디 값 사용.
function _scopedAdvId(req, requested) {
  if (req.admin && req.admin.role === 'advertiser') return req.admin.advertiser_id;
  return requested;
}

// 빈문자/undefined → null (DATE 캐스팅 에러 방지)
function _dateOrNull(v) { return (v && String(v).trim()) ? String(v).trim() : null; }
// "13,853,994" 같은 콤마 표기 허용 → 정수(원). 빈값은 null.
function _intOrNull(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = parseInt(String(v).replace(/[,\s]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

// 작업 필드 정의 (UPDATE 동적 빌드용). type: text | int | date
const WORK_FIELDS = {
  brand:           'text', inad_manager: 'text', work_type: 'text', product: 'text',
  channel:         'text', round:        'text', qty:       'int',  progress_date: 'date',
  work_sheet_url:  'text', progress_status: 'text',
  closing_date:    'date', quote_date:   'date', invoice_date: 'date', payment_date: 'date',
  total_cost:      'int',  deposit:      'int',  deposit_date: 'date', balance: 'int', balance_date: 'date',
  group_ref:       'text', note_inad:    'text', note_client: 'text',
};
// 광고주가 수정 가능한 필드 (본인 측 비고만)
const ADVERTISER_EDITABLE = new Set(['note_client']);

function _coerce(type, v) {
  if (type === 'date') return _dateOrNull(v);
  if (type === 'int')  return _intOrNull(v);
  return (v === undefined || v === null) ? null : String(v);
}

// ── 테이블 자동 생성 (마이그레이션 실패 시 안전장치) ──
let _tableChecked = false;
async function _ensureTables() {
  if (_tableChecked) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS advertisers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','pending')),
        inad_pm TEXT DEFAULT '',
        contact TEXT DEFAULT '',
        memo TEXT DEFAULT '',
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS advertiser_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        advertiser_id TEXT NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
        username TEXT NOT NULL UNIQUE,
        pw_hash TEXT NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_works (
        id TEXT PRIMARY KEY,
        seq SERIAL,
        advertiser_id TEXT NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
        brand TEXT DEFAULT '',
        inad_manager TEXT DEFAULT '',
        work_type TEXT DEFAULT '',
        product TEXT DEFAULT '',
        channel TEXT DEFAULT '',
        round TEXT DEFAULT '',
        qty INTEGER DEFAULT 0,
        progress_date DATE,
        work_sheet_url TEXT DEFAULT '',
        progress_status TEXT NOT NULL DEFAULT 'in_progress'
          CHECK (progress_status IN ('planned','in_progress','done','hold','canceled')),
        closing_date DATE, quote_date DATE, invoice_date DATE, payment_date DATE,
        total_cost BIGINT DEFAULT 0, deposit BIGINT DEFAULT 0, deposit_date DATE,
        balance BIGINT DEFAULT 0, balance_date DATE,
        group_ref TEXT DEFAULT '', note_inad TEXT DEFAULT '', note_client TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_by TEXT DEFAULT '',
        deleted_at TIMESTAMPTZ, deleted_by TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        work_id TEXT REFERENCES portal_works(id) ON DELETE CASCADE,
        advertiser_id TEXT REFERENCES advertisers(id) ON DELETE CASCADE,
        side TEXT NOT NULL DEFAULT 'inad' CHECK (side IN ('inad','client')),
        author TEXT DEFAULT '',
        content TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','confirm_request')),
        resolved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    _tableChecked = true;
  } catch (e) {
    if (e.message.includes('already exists')) {
      _tableChecked = true;
    } else {
      logger.error('[portal] 테이블 생성 실패:', e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 거래처(광고주)
// ═══════════════════════════════════════════════════════════

// GET /api/portal/advertisers — 목록 (내부: 전체 / 광고주: 본인 거래처만)
router.get('/advertisers', authMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    if (req.admin.role === 'advertiser') {
      const { rows } = await pool.query(
        'SELECT * FROM advertisers WHERE id = $1', [req.admin.advertiser_id]
      );
      return res.json({ ok: true, data: rows });
    }
    const { rows } = await pool.query(
      'SELECT * FROM advertisers ORDER BY sort_order ASC, name ASC'
    );
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/portal/advertisers/overview — 전체현황 집계 (내부 전용)
//   거래처별 작업수 / 미마감 / 미견적 / 미계산 / 미입금 건수 + 미입금 합계
router.get('/advertisers/overview', authMiddleware, internalOnlyMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const { rows } = await pool.query(`
      SELECT a.id, a.name, a.status, a.inad_pm, a.sort_order,
             COUNT(w.id)                                              AS work_count,
             COUNT(w.id) FILTER (WHERE w.closing_date IS NULL)        AS pending_closing,
             COUNT(w.id) FILTER (WHERE w.quote_date   IS NULL)        AS pending_quote,
             COUNT(w.id) FILTER (WHERE w.invoice_date IS NULL)        AS pending_invoice,
             COUNT(w.id) FILTER (WHERE w.payment_date IS NULL)        AS unpaid_count,
             COALESCE(SUM(w.total_cost) FILTER (WHERE w.payment_date IS NULL), 0) AS unpaid_amount
        FROM advertisers a
        LEFT JOIN portal_works w
          ON w.advertiser_id = a.id AND w.deleted_at IS NULL AND w.status = 'active'
       GROUP BY a.id
       ORDER BY a.sort_order ASC, a.name ASC
    `);
    const grand = rows.reduce((g, r) => {
      g.work_count     += Number(r.work_count);
      g.unpaid_count   += Number(r.unpaid_count);
      g.unpaid_amount  += Number(r.unpaid_amount);
      return g;
    }, { work_count: 0, unpaid_count: 0, unpaid_amount: 0 });
    res.json({ ok: true, data: rows, grand });
  } catch (err) { next(err); }
});

// POST /api/portal/advertisers — 거래처 생성 (master/admin)
router.post('/advertisers', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const { name, status, inad_pm, contact, memo, sort_order } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ ok: false, error: '거래처명을 입력하세요.' });
    }
    const dup = await pool.query('SELECT 1 FROM advertisers WHERE name = $1', [String(name).trim()]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ ok: false, error: '이미 존재하는 거래처명입니다.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO advertisers (id, name, status, inad_pm, contact, memo, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [_genAdvId(), String(name).trim(), status || 'active',
       inad_pm || '', contact || '', memo || '', _intOrNull(sort_order) || 0]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/portal/advertisers/:id — 거래처 수정 (master/admin)
router.patch('/advertisers/:id', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const allowed = { name: 'text', status: 'text', inad_pm: 'text', contact: 'text', memo: 'text', sort_order: 'int' };
    const sets = [], vals = [];
    let i = 1;
    for (const [k, t] of Object.entries(allowed)) {
      if (k in req.body) { sets.push(`${k} = $${i++}`); vals.push(_coerce(t, req.body[k])); }
    }
    if (sets.length === 0) return res.status(400).json({ ok: false, error: '변경할 항목이 없습니다.' });
    sets.push('updated_at = NOW()');
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE advertisers SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: '거래처를 찾을 수 없습니다.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// 작업(캠페인)
// ═══════════════════════════════════════════════════════════

// GET /api/portal/works?advertiser_id=&status=&q= — 거래처별 작업 목록
//   광고주는 advertiser_id 가 토큰값으로 강제됨
router.get('/works', authMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const advId = _scopedAdvId(req, req.query.advertiser_id);
    if (req.admin.role === 'advertiser' && !advId) {
      return res.status(403).json({ ok: false, error: '연결된 거래처가 없습니다.' });
    }

    const where = ['w.deleted_at IS NULL', "w.status = 'active'"];
    const vals = [];
    let i = 1;
    if (advId)             { where.push(`w.advertiser_id = $${i++}`); vals.push(advId); }
    if (req.query.status)  { where.push(`w.progress_status = $${i++}`); vals.push(req.query.status); }
    if (req.query.q) {
      where.push(`(w.product ILIKE $${i} OR w.brand ILIKE $${i} OR w.channel ILIKE $${i})`);
      vals.push('%' + req.query.q + '%'); i++;
    }

    const { rows } = await pool.query(
      `SELECT w.*, a.name AS advertiser_name
         FROM portal_works w
         JOIN advertisers a ON a.id = w.advertiser_id
        WHERE ${where.join(' AND ')}
        ORDER BY w.progress_date DESC NULLS LAST, w.seq DESC`,
      vals
    );
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/portal/works/:id — 작업 상세
router.get('/works/:id', authMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const { rows } = await pool.query(
      `SELECT w.*, a.name AS advertiser_name
         FROM portal_works w JOIN advertisers a ON a.id = w.advertiser_id
        WHERE w.id = $1 AND w.deleted_at IS NULL`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: '작업을 찾을 수 없습니다.' });
    const work = rows[0];
    if (req.admin.role === 'advertiser' && work.advertiser_id !== req.admin.advertiser_id) {
      return res.status(403).json({ ok: false, error: '권한이 없습니다.' });
    }
    res.json({ ok: true, data: work });
  } catch (err) { next(err); }
});

// POST /api/portal/works — 작업 생성 (내부 전용)
router.post('/works', authMiddleware, internalOnlyMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const advId = req.body.advertiser_id;
    if (!advId) return res.status(400).json({ ok: false, error: '거래처(광고주)를 선택하세요.' });
    const adv = await pool.query('SELECT 1 FROM advertisers WHERE id = $1', [advId]);
    if (adv.rows.length === 0) return res.status(404).json({ ok: false, error: '존재하지 않는 거래처입니다.' });

    const cols = ['id', 'advertiser_id', 'created_by'];
    const ph   = ['$1', '$2', '$3'];
    const vals = [_genWorkId(), advId, req.admin.name || ''];
    let i = 4;
    for (const [k, t] of Object.entries(WORK_FIELDS)) {
      if (k in req.body) { cols.push(k); ph.push(`$${i++}`); vals.push(_coerce(t, req.body[k])); }
    }
    const { rows } = await pool.query(
      `INSERT INTO portal_works (${cols.join(', ')}) VALUES (${ph.join(', ')}) RETURNING *`, vals
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/portal/works/:id — 작업 수정 (내부: 전권 / 광고주: note_client 만)
router.patch('/works/:id', authMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const cur = await pool.query(
      'SELECT advertiser_id FROM portal_works WHERE id = $1 AND deleted_at IS NULL', [req.params.id]
    );
    if (cur.rows.length === 0) return res.status(404).json({ ok: false, error: '작업을 찾을 수 없습니다.' });

    const isAdvertiser = req.admin.role === 'advertiser';
    if (isAdvertiser && cur.rows[0].advertiser_id !== req.admin.advertiser_id) {
      return res.status(403).json({ ok: false, error: '권한이 없습니다.' });
    }
    if (!isAdvertiser && !_isInternal(req)) {
      return res.status(403).json({ ok: false, error: '권한이 없습니다.' });
    }

    const sets = [], vals = [];
    let i = 1;
    for (const [k, t] of Object.entries(WORK_FIELDS)) {
      if (!(k in req.body)) continue;
      if (isAdvertiser && !ADVERTISER_EDITABLE.has(k)) continue; // 광고주는 제한 필드만
      sets.push(`${k} = $${i++}`); vals.push(_coerce(t, req.body[k]));
    }
    if (sets.length === 0) return res.status(400).json({ ok: false, error: '변경할 항목이 없습니다.' });
    sets.push('updated_at = NOW()');
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE portal_works SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/portal/works/:id — 작업 소프트삭제 (내부 전용)
router.delete('/works/:id', authMiddleware, internalOnlyMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const { rowCount } = await pool.query(
      `UPDATE portal_works SET deleted_at = NOW(), deleted_by = $1, updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL`,
      [req.admin.name || '', req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ ok: false, error: '작업을 찾을 수 없습니다.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// 코멘트 (양방향: 인애드 ↔ 광고주)
// ═══════════════════════════════════════════════════════════

// GET /api/portal/works/:id/comments
router.get('/works/:id/comments', authMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const cur = await pool.query('SELECT advertiser_id FROM portal_works WHERE id = $1', [req.params.id]);
    if (cur.rows.length === 0) return res.status(404).json({ ok: false, error: '작업을 찾을 수 없습니다.' });
    if (req.admin.role === 'advertiser' && cur.rows[0].advertiser_id !== req.admin.advertiser_id) {
      return res.status(403).json({ ok: false, error: '권한이 없습니다.' });
    }
    const { rows } = await pool.query(
      'SELECT * FROM portal_comments WHERE work_id = $1 ORDER BY created_at ASC', [req.params.id]
    );
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/portal/works/:id/comments — 코멘트 작성 (side 는 역할로 자동 결정)
router.post('/works/:id/comments', authMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const { content, kind } = req.body;
    if (!content || !String(content).trim()) {
      return res.status(400).json({ ok: false, error: '내용을 입력하세요.' });
    }
    const cur = await pool.query('SELECT advertiser_id FROM portal_works WHERE id = $1', [req.params.id]);
    if (cur.rows.length === 0) return res.status(404).json({ ok: false, error: '작업을 찾을 수 없습니다.' });
    const advertiserId = cur.rows[0].advertiser_id;
    if (req.admin.role === 'advertiser' && advertiserId !== req.admin.advertiser_id) {
      return res.status(403).json({ ok: false, error: '권한이 없습니다.' });
    }
    const side = req.admin.role === 'advertiser' ? 'client' : 'inad';
    const { rows } = await pool.query(
      `INSERT INTO portal_comments (work_id, advertiser_id, side, author, content, kind)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, advertiserId, side, req.admin.name || '', String(content).trim(),
       (kind === 'confirm_request' ? 'confirm_request' : 'comment')]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
