const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { logger } = require('../utils/logger');

// ═══════════════════════════════════════════════════════════
// 작업 오더(work_orders) — AE 제출 → 관리자 인박스 → 상태머신
// ═══════════════════════════════════════════════════════════

function _genOrderId() {
  return 'wo_' + crypto.randomBytes(6).toString('hex');
}

// 상태 전이 단일 소스 (서버에서만 검증)
const ORDER_TRANSITIONS = {
  submitted:      ['reviewing', 'rejected', 'revision'],
  reviewing:      ['await_chatroom', 'rejected', 'revision'],
  await_chatroom: ['published', 'reviewing', 'rejected'],
  published:      ['done'],            // MVP: done 으로만 진행 (역행 없음)
  done:           [],                   // 종착
  rejected:       ['reviewing'],        // 반려 후 재검토
  revision:       ['submitted', 'reviewing'], // AE 보완 후 재제출
};

// AE 가 입력/수정 가능한 필드 (status/created_by/processed_by/admin_memo 등은 제외)
const AE_FIELDS = [
  'title', 'start_date', 'product_option', 'pay_amount', 'daily_count',
  'purchase_time', 'inflow_keyword', 'delivery_type', 'courier_proxy',
  'review_type', 'recruit_count', 'review_guide', 'special_notes',
  'product_url', 'work_sheet_url', 'goods_cost_type',
];

// ── 테이블 자동 생성 (마이그레이션 실패 시 안전장치) ──
let _tableChecked = false;
async function _ensureTables() {
  if (_tableChecked) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_orders (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        start_date      DATE,
        product_option  TEXT DEFAULT '',
        pay_amount      INTEGER DEFAULT 0,
        daily_count     INTEGER DEFAULT 0,
        purchase_time   TEXT DEFAULT '',
        inflow_keyword  TEXT DEFAULT '',
        delivery_type   TEXT DEFAULT '',
        courier_proxy   BOOLEAN DEFAULT FALSE,
        review_type     TEXT DEFAULT '',
        recruit_count   INTEGER DEFAULT 0,
        review_guide    TEXT DEFAULT '',
        special_notes   TEXT DEFAULT '',
        product_url     TEXT DEFAULT '',
        work_sheet_url  TEXT DEFAULT '',
        goods_cost_type TEXT DEFAULT '',
        chat_room_url   TEXT DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('submitted','reviewing','await_chatroom','published','done','rejected','revision')),
        created_by      TEXT NOT NULL DEFAULT '',
        admin_memo      TEXT DEFAULT '',
        processed_by    TEXT DEFAULT '',
        linked_campaign_id TEXT DEFAULT '',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_orders_status     ON work_orders(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_orders_created_by ON work_orders(created_by)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_orders_created_at ON work_orders(created_at DESC)`);
    _tableChecked = true;
  } catch (e) {
    if (e.message.includes('already exists')) {
      _tableChecked = true;
    } else {
      logger.error('[order] 테이블 생성 실패:', e.message);
    }
  }
}

// 빈 문자열/undefined → null (DATE 캐스팅 에러 방지)
function _dateOrNull(v) {
  return (v && String(v).trim()) ? v : null;
}

// ═══════════════════════════════════════════════════════════
// AE(영업담당자) — 제출 / 본인 조회 / 본인 수정
// created_by 는 항상 JWT name 으로 강제 (클라이언트 입력 무시)
// ═══════════════════════════════════════════════════════════

// POST /api/order/submit — 작업 오더 제출
router.post('/submit', authMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const b = req.body || {};

    if (!b.title || !String(b.title).trim()) {
      return res.status(400).json({ ok: false, error: '작업명을 입력해주세요.' });
    }
    // ★ 필수: 작업시트탭URL (AE 요청 시 필수사항)
    if (!b.work_sheet_url || !String(b.work_sheet_url).trim()) {
      return res.status(400).json({ ok: false, error: '작업시트탭URL은 필수입니다.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO work_orders
        (id, title, start_date, product_option, pay_amount, daily_count,
         purchase_time, inflow_keyword, delivery_type, courier_proxy,
         review_type, recruit_count, review_guide, special_notes,
         product_url, work_sheet_url, goods_cost_type, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'submitted',$18)
       RETURNING *`,
      [
        _genOrderId(),
        String(b.title).trim(),
        _dateOrNull(b.start_date),
        b.product_option || '',
        b.pay_amount || 0,
        b.daily_count || 0,
        b.purchase_time || '',
        b.inflow_keyword || '',
        b.delivery_type || '',
        b.courier_proxy === true || b.courier_proxy === 'true',
        b.review_type || '',
        b.recruit_count || 0,
        b.review_guide || '',
        b.special_notes || '',
        b.product_url || '',
        String(b.work_sheet_url).trim(),
        b.goods_cost_type || '',
        req.admin?.name || '',
      ]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/order/my — 본인 오더 목록
router.get('/my', authMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const { rows } = await pool.query(
      `SELECT * FROM work_orders WHERE created_by = $1 ORDER BY created_at DESC`,
      [req.admin?.name || '']
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/order/my/update — 본인 오더 수정 (제출됨/보완요청 상태에서만)
// body: { id, ...AE_FIELDS }
router.put('/my/update', authMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });

    const { rows: cur } = await pool.query(
      `SELECT created_by, status FROM work_orders WHERE id = $1 LIMIT 1`, [b.id]
    );
    if (cur.length === 0) {
      return res.status(404).json({ ok: false, error: '오더를 찾을 수 없습니다.' });
    }
    // 본인 것만
    if (cur[0].created_by !== (req.admin?.name || '')) {
      return res.status(403).json({ ok: false, error: '본인이 제출한 오더만 수정할 수 있습니다.' });
    }
    // 제출됨/보완요청 상태에서만 수정 허용
    if (!['submitted', 'revision'].includes(cur[0].status)) {
      return res.status(400).json({ ok: false, error: '검토가 시작된 오더는 수정할 수 없습니다.' });
    }

    // 동적 SET (전달된 AE 필드만)
    const sets = [];
    const vals = [];
    let i = 1;
    for (const f of AE_FIELDS) {
      if (b[f] === undefined) continue;
      sets.push(`${f} = $${i++}`);
      if (f === 'start_date') vals.push(_dateOrNull(b[f]));
      else if (f === 'courier_proxy') vals.push(b[f] === true || b[f] === 'true');
      else vals.push(b[f]);
    }
    if (sets.length === 0) {
      return res.status(400).json({ ok: false, error: '수정할 항목이 없습니다.' });
    }
    // 시트탭URL을 빈값으로 지우는 것은 금지 (필수 유지)
    if (b.work_sheet_url !== undefined && !String(b.work_sheet_url).trim()) {
      return res.status(400).json({ ok: false, error: '작업시트탭URL은 비울 수 없습니다.' });
    }
    sets.push(`updated_at = NOW()`);
    vals.push(b.id);

    const { rows } = await pool.query(
      `UPDATE work_orders SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 관리자(admin/master) — 인박스 / 상태변경 / 필드보정
// staff 차단: adminOrMasterMiddleware
// ═══════════════════════════════════════════════════════════

// GET /api/order/admin/list — 인박스 (status 필터 선택)
router.get('/admin/list', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const { status } = req.query;
    let q = `SELECT * FROM work_orders`;
    const vals = [];
    if (status) { q += ` WHERE status = $1`; vals.push(status); }
    q += ` ORDER BY created_at DESC`;
    const { rows } = await pool.query(q, vals);
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/order/admin/status — 상태 전이 (전이 규칙 서버 검증)
// body: { id, status, admin_memo?, chat_room_url?, linked_campaign_id? }
router.put('/admin/status', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const b = req.body || {};
    if (!b.id || !b.status) {
      return res.status(400).json({ ok: false, error: 'id와 status가 필요합니다.' });
    }

    const { rows: cur } = await pool.query(
      `SELECT status, chat_room_url FROM work_orders WHERE id = $1 LIMIT 1`, [b.id]
    );
    if (cur.length === 0) {
      return res.status(404).json({ ok: false, error: '오더를 찾을 수 없습니다.' });
    }

    const from = cur[0].status;
    const to = b.status;
    const allowed = ORDER_TRANSITIONS[from] || [];
    if (from !== to && !allowed.includes(to)) {
      return res.status(400).json({
        ok: false,
        error: `허용되지 않는 상태 전이입니다. (${from} → ${to})`,
      });
    }

    // ★ 모집공고발행(published) 전이 시 카톡 팀채팅방URL 필수
    if (to === 'published') {
      const nextChat = (b.chat_room_url !== undefined ? b.chat_room_url : cur[0].chat_room_url) || '';
      if (!String(nextChat).trim()) {
        return res.status(400).json({ ok: false, error: '카톡 팀채팅방URL이 있어야 모집공고발행이 가능합니다.' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE work_orders SET
         status = $2,
         admin_memo = COALESCE($3, admin_memo),
         chat_room_url = COALESCE($4, chat_room_url),
         linked_campaign_id = COALESCE($5, linked_campaign_id),
         processed_by = $6,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        b.id,
        to,
        b.admin_memo !== undefined ? b.admin_memo : null,
        b.chat_room_url !== undefined ? b.chat_room_url : null,
        b.linked_campaign_id !== undefined ? b.linked_campaign_id : null,
        req.admin?.name || '',
      ]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/order/admin/update — 관리자 필드 보정 (선택)
// body: { id, chat_room_url?, admin_memo?, linked_campaign_id? }
router.put('/admin/update', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });

    const { rows } = await pool.query(
      `UPDATE work_orders SET
         chat_room_url = COALESCE($2, chat_room_url),
         admin_memo = COALESCE($3, admin_memo),
         linked_campaign_id = COALESCE($4, linked_campaign_id),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        b.id,
        b.chat_room_url !== undefined ? b.chat_room_url : null,
        b.admin_memo !== undefined ? b.admin_memo : null,
        b.linked_campaign_id !== undefined ? b.linked_campaign_id : null,
      ]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '오더를 찾을 수 없습니다.' });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
