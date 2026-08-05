const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const drive = require('../services/drive.service');
const { getSpreadsheetMeta } = require('../services/sheets.service');
const { buildOneSheet } = require('../services/indexBuilder.service');
const { mirrorOneSheet } = require('../services/rawMirror.service');
const sse = require('../utils/sse');
const { logger } = require('../utils/logger');
const { fetchThumbFromUrl } = require('../utils/thumbFetch');
const { mapWorkManager, pickWorkManager } = require('../utils/workManager');

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
  'title', 'start_date', 'product_option', 'product_options_json', 'pay_amount', 'daily_count', 'daily_count_text',
  'purchase_time', 'inflow_type', 'inflow_guide', 'delivery_type', 'courier_proxy',
  'review_type', 'recruit_count', 'review_guide', 'special_notes',
  'product_url', 'work_sheet_url', 'goods_cost_type', 'work_manager',
];

// 인트라넷 intake 수정 가능 필드 (status/created_by/processed_by/admin_memo 등 내부 상태는 제외)
// updated_by / updated_by_name 은 감사용으로 별도 처리(컨텐츠 수정으로 카운트하지 않음).
const INTAKE_EDITABLE_FIELDS = [
  'title', 'start_date', 'manager_name', 'product_option', 'product_options_json',
  'pay_amount', 'daily_count', 'daily_count_text', 'purchase_time',
  'inflow_keyword', 'inflow_type', 'inflow_guide',
  'delivery_type', 'courier_proxy', 'review_type', 'recruit_count',
  'review_guide', 'special_notes', 'product_url', 'work_sheet_url', 'goods_cost_type',
  'work_manager',   // 작업담당(박세희/박은비/랜덤) — 065
  'sales_id', 'contract_number', 'quote_id',   // 인트라넷 계약건 — 088
  'guide_images',   // 첨부 이미지 URL 배열(JSON) — 090 · 칸=칸 매핑 2단계
];
const INTAKE_INT_FIELDS = new Set(['pay_amount', 'daily_count', 'recruit_count']);

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
        inflow_type     TEXT DEFAULT '',
        inflow_guide    TEXT DEFAULT '',
        daily_count_text     TEXT DEFAULT '',
        product_options_json TEXT DEFAULT '',
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
        memo_log        TEXT DEFAULT '',
        processed_by    TEXT DEFAULT '',
        linked_campaign_id TEXT DEFAULT '',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // 기존 테이블에 신규 컬럼 보강 (유입방식/유입가이드/일일건수 범위/옵션 JSON)
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS inflow_type          TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS inflow_guide         TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS daily_count_text     TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS product_options_json TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS memo_log             TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS deleted_at           TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS deleted_by           TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS deleted_by_name      TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS manager_name         TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_by           TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_by_name      TEXT DEFAULT ''`);
    // 033: 접수 시 등록된 캠페인 탭 연결(역추적·멱등)
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS linked_tab_sheet_id  TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS linked_tab_name      TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS linked_tab_gid       TEXT DEFAULT ''`);
    // 065: 작업담당(박세희/박은비/랜덤) — 리뷰웹 담당자(만두/망고) 자동 선택의 원천
    await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_manager         TEXT DEFAULT ''`);
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

// INTEGER 컬럼용: 숫자/숫자문자열 → 정수, 파싱 실패 시 0 ("20" → 20, "3~7" → 3, "" → 0)
function _intOrZero(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// guide_images(090 · 칸=칸 매핑 2단계): 첨부 이미지 URL 배열 → 정규화된 JSON 문자열.
// 배열/JSON 문자열 어느 쪽이 와도 받아주되, http(s) URL 만 · 최대 8장 · 항목 600자 컷 —
// <img src>로 그대로 나가는 값이라 자유 문자열을 저장하지 않는다. 실패·빈 값은 ''(종전 동작).
function _guideImagesJson(v) {
  try {
    const arr = Array.isArray(v) ? v : ((typeof v === 'string' && v.trim()) ? JSON.parse(v) : []);
    if (!Array.isArray(arr)) return '';
    const clean = arr
      .filter(u => typeof u === 'string' && /^https?:\/\//i.test(u.trim()))
      .map(u => u.trim().slice(0, 600))
      .slice(0, 8);
    return clean.length ? JSON.stringify(clean) : '';
  } catch (_) { return ''; }
}

// 작업 오더 INSERT 공통 (intake/submit 공유, created_by 만 호출부에서 주입)
async function _insertWorkOrder(b, createdBy) {
  const optionsJson = (typeof b.product_options_json === 'string')
    ? b.product_options_json
    : (b.product_options_json ? JSON.stringify(b.product_options_json) : '');
  const { rows } = await pool.query(
    `INSERT INTO work_orders
      (id, title, start_date, product_option, product_options_json, pay_amount, daily_count, daily_count_text,
       purchase_time, inflow_keyword, inflow_type, inflow_guide, guide_images, delivery_type, courier_proxy,
       review_type, recruit_count, review_guide, special_notes,
       product_url, work_sheet_url, goods_cost_type, manager_name, work_manager,
       sales_id, contract_number, quote_id, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,'submitted',$28)
     RETURNING *`,
    [
      _genOrderId(),
      String(b.title).trim(),
      _dateOrNull(b.start_date),
      b.product_option || '',
      optionsJson,
      b.pay_amount || 0,
      b.daily_count || 0,
      b.daily_count_text || '',
      b.purchase_time || '',
      b.inflow_keyword || '',
      b.inflow_type || '',
      b.inflow_guide || '',
      _guideImagesJson(b.guide_images),   // 첨부 이미지 URL 배열(090) — 미전송·구버전 인트라넷은 ''
      b.delivery_type || '',
      b.courier_proxy === true || b.courier_proxy === 'true',
      b.review_type || '',
      b.recruit_count || 0,
      b.review_guide || '',
      b.special_notes || '',
      b.product_url || '',
      // ★ 선택 항목이라 **생략될 수 있다** — `|| ''` 폴백이 없으면 String(undefined)='undefined' 가
      //   그대로 저장되어 ① 목록에 시트가 붙은 것처럼 보이고 ② 접수는 "유효한 URL이 아닙니다"로
      //   막혀 시트 미첨부 안내 흐름을 타지 못한다(필수 해제와 함께 반드시 필요).
      String(b.work_sheet_url || '').trim(),
      b.goods_cost_type || '',
      b.manager_name || '',
      pickWorkManager(b),   // 작업담당(박세희/박은비/랜덤) — 표준키 work_manager + 별칭·본문 폴백
      // 인트라넷 계약건(088) — 접수 시 정산 계약을 자동 연결하는 재료. 빈 값이면 종전 동작(사람이 매칭).
      String(b.sales_id || '').trim(),
      String(b.contract_number || '').trim(),
      String(b.quote_id || '').trim(),
      createdBy,
    ]
  );
  return rows[0];
}

// 신규/재제출 작업오더 SSE 알림 (관리자 대시보드 실시간) — best-effort.
// 페이로드는 최소 필드만(리뷰가이드/유입가이드 등 본문 미포함 — 상세는 프론트가 admin API로 조회).
function _emitWorkOrderNew(row, extra) {
  try {
    sse.emitWorkOrderNew({
      id: row.id,
      title: row.title,
      created_by: row.created_by,
      recruit_count: row.recruit_count,
      start_date: row.start_date,
      created_at: row.created_at,
      ...(extra || {}),
    });
  } catch (e) {
    logger.warn(`[order] work_order_new SSE 알림 실패: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// 외부(인트라넷) 작업오더 제출 — 공유 시크릿 인증 (JWT 불필요)
// 인트라넷(inadd-system)에서 직접 POST. created_by 는 페이로드의 requester_name.
// 필요 env: ORDER_INTAKE_KEY
// ═══════════════════════════════════════════════════════════
router.post('/intake', async (req, res, next) => {
  try {
    await _ensureTables();
    const b = req.body || {};
    const expected = process.env.ORDER_INTAKE_KEY;
    if (!expected) {
      return res.status(503).json({ ok: false, error: 'intake 키가 서버에 설정되지 않았습니다. (ORDER_INTAKE_KEY)' });
    }
    const key = b.intakeKey || req.headers['x-intake-key'];
    if (!key || key !== expected) {
      return res.status(401).json({ ok: false, error: '인증에 실패했습니다.' });
    }
    if (!b.title || !String(b.title).trim()) {
      return res.status(400).json({ ok: false, error: '작업명을 입력해주세요.' });
    }
    // ★ work_sheet_url 은 선택 항목 (작업표 생성 도입에 따라 제출 필수 해제).
    //   시트 없이 제출된 오더는 접수 시점에 시트 URL을 채우거나 작업표를 생성해야 접수된다(accept 게이트 유지).
    const requester = (b.requester_name || b.created_by || '').toString().trim() || '인트라넷';
    const data = await _insertWorkOrder(b, requester);
    _emitWorkOrderNew(data);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 외부(인트라넷) 보낸 오더 조회 — 공유 시크릿 인증 (JWT 불필요)
// GET /api/order/intake/list?requester=이름  → 보낸 오더 + 현재 상태
// 키: X-Intake-Key 헤더 또는 ?intakeKey=  (requester 생략 시 전체)
// ═══════════════════════════════════════════════════════════
router.get('/intake/list', async (req, res, next) => {
  try {
    await _ensureTables();
    const expected = process.env.ORDER_INTAKE_KEY;
    if (!expected) {
      return res.status(503).json({ ok: false, error: 'intake 키가 서버에 설정되지 않았습니다. (ORDER_INTAKE_KEY)' });
    }
    const key = req.headers['x-intake-key'] || req.query.intakeKey;
    if (!key || key !== expected) {
      return res.status(401).json({ ok: false, error: '인증에 실패했습니다.' });
    }
    const requester = (req.query.requester || '').toString().trim();
    const params = [];
    let where = 'WHERE deleted_at IS NULL';
    if (requester) {
      params.push(requester);
      where += ' AND created_by = $1';
    }
    const { rows } = await pool.query(
      `SELECT id, title, status, created_by, recruit_count, start_date,
              inflow_type, work_sheet_url, linked_campaign_id, chat_room_url, admin_memo, created_at, updated_at
         FROM work_orders ${where}
        ORDER BY created_at DESC
        LIMIT 200`,
      params
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 외부(인트라넷) 보낸 오더 상세 조회 — 공유 시크릿 인증 (JWT 불필요)
// GET /api/order/intake/:id  → 단건 전체 필드 반환 (상세 복원용)
// 키: X-Intake-Key 헤더 또는 ?intakeKey=
// ※ list 는 일부 필드만 내려주므로, 상품/리뷰/유입가이드 등 전체 상세는 이 경로로 조회.
//   삭제된(soft delete) 오더도 복원 목적상 반환하며 deleted_at 으로 상태 식별 가능.
// ※ 라우트 순서: '/intake/list' 가 위에서 먼저 매칭되므로 'list' 와 충돌 없음 (id는 wo_*).
// ═══════════════════════════════════════════════════════════
router.get('/intake/:id', async (req, res, next) => {
  try {
    await _ensureTables();
    const expected = process.env.ORDER_INTAKE_KEY;
    if (!expected) {
      return res.status(503).json({ ok: false, error: 'intake 키가 서버에 설정되지 않았습니다. (ORDER_INTAKE_KEY)' });
    }
    const key = req.headers['x-intake-key'] || req.query.intakeKey;
    if (!key || key !== expected) {
      return res.status(401).json({ ok: false, error: '인증에 실패했습니다.' });
    }
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });

    const { rows } = await pool.query('SELECT * FROM work_orders WHERE id = $1 LIMIT 1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '오더를 찾을 수 없습니다.' });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 외부(인트라넷) 보낸 오더 삭제 — 공유 시크릿 인증 (JWT 불필요)
// DELETE /api/order/intake/:id
// 키: X-Intake-Key 헤더 또는 body.intakeKey / ?intakeKey=
// body(선택): { deleted_by, deleted_by_name }
// 권한(관리자/등록자 본인) 검증은 인트라넷 측에서 선행.
// soft delete: 행은 보존(처리 이력·memo_log 유지), deleted_at 으로 목록 제외.
// ═══════════════════════════════════════════════════════════
router.delete('/intake/:id', async (req, res, next) => {
  try {
    await _ensureTables();
    const expected = process.env.ORDER_INTAKE_KEY;
    if (!expected) {
      return res.status(503).json({ ok: false, error: 'intake 키가 서버에 설정되지 않았습니다. (ORDER_INTAKE_KEY)' });
    }
    const b = req.body || {};
    const key = req.headers['x-intake-key'] || b.intakeKey || req.query.intakeKey;
    if (!key || key !== expected) {
      return res.status(401).json({ ok: false, error: '인증에 실패했습니다.' });
    }
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });

    const { rows: cur } = await pool.query(
      `SELECT id, deleted_at FROM work_orders WHERE id = $1 LIMIT 1`, [id]
    );
    if (cur.length === 0) {
      return res.status(404).json({ ok: false, error: '오더를 찾을 수 없습니다.' });
    }
    // 이미 삭제됨 → 멱등 처리 (재시도 안전)
    if (cur[0].deleted_at) {
      return res.json({ ok: true, id, alreadyDeleted: true });
    }

    await pool.query(
      `UPDATE work_orders SET
         deleted_at = NOW(),
         deleted_by = $2,
         deleted_by_name = $3,
         updated_at = NOW()
       WHERE id = $1`,
      [id, (b.deleted_by || '').toString().trim(), (b.deleted_by_name || '').toString().trim()]
    );
    logger.info(`[order] 인트라넷 작업오더 삭제: ${id} (by ${b.deleted_by || '?'})`);
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 외부(인트라넷) 보낸 오더 수정 — 공유 시크릿 인증 (JWT 불필요)
// PATCH /api/order/intake/:id  (= PUT /api/order/intake/:id = POST /api/order/intake/:id/update)
// 인트라넷 "리뷰 오더"에서 기존 작업오더 수정 시 리뷰웹 인박스 원본도 함께 갱신.
// 키: X-Intake-Key 헤더 또는 body.intakeKey / ?intakeKey=  (생성 API와 동일)
// body: { ...INTAKE_EDITABLE_FIELDS, updated_by?, updated_by_name? }
//   - 전달된 필드만 부분 수정(PATCH 의미). title/work_sheet_url 은 빈값으로 지우기 금지.
//   - 응답: { ok: true, id, data: {...updatedOrder} }
//   - 없는 id → 404 / 삭제·완료 등 수정 불가 상태 → 409 / 인증 실패 → 401
// ═══════════════════════════════════════════════════════════
async function _intakeUpdateHandler(req, res, next) {
  try {
    await _ensureTables();
    const expected = process.env.ORDER_INTAKE_KEY;
    if (!expected) {
      return res.status(503).json({ ok: false, error: 'intake 키가 서버에 설정되지 않았습니다. (ORDER_INTAKE_KEY)' });
    }
    const b = req.body || {};
    const key = req.headers['x-intake-key'] || b.intakeKey || req.query.intakeKey;
    if (!key || key !== expected) {
      return res.status(401).json({ ok: false, error: '인증에 실패했습니다.' });
    }
    const id = String(req.params.id || '').trim();
    if (!id || id === 'list') return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });

    // 현재 상태 확인 (존재/삭제/완료 여부)
    const { rows: cur } = await pool.query(
      `SELECT id, status, deleted_at FROM work_orders WHERE id = $1 LIMIT 1`, [id]
    );
    if (cur.length === 0) {
      return res.status(404).json({ ok: false, error: '오더를 찾을 수 없습니다.' });
    }
    if (cur[0].deleted_at) {
      return res.status(409).json({ ok: false, error: '삭제된 작업오더는 수정할 수 없습니다.' });
    }
    if (cur[0].status === 'done') {
      return res.status(409).json({ ok: false, error: '완료된 작업오더는 수정할 수 없습니다.' });
    }

    // 동적 SET (전달된 수정 가능 필드만 — 부분 수정)
    const sets = [];
    const vals = [];
    let i = 1;
    let touched = 0;
    for (const f of INTAKE_EDITABLE_FIELDS) {
      if (b[f] === undefined) continue;
      // 필수 필드는 빈값으로 지우기 금지 (기존 값 보호)
      if (f === 'title' && !String(b[f]).trim()) {
        return res.status(400).json({ ok: false, error: '작업명은 비울 수 없습니다.' });
      }
      // ★ work_sheet_url 은 선택 항목이 되었으므로 빈값(=시트 미첨부로 되돌리기) 허용.
      //   접수 게이트가 URL+gid를 재검증하므로 빈값이 접수 흐름을 오염시키지 않는다.
      sets.push(`${f} = $${i++}`);
      if (f === 'start_date') vals.push(_dateOrNull(b[f]));
      else if (f === 'courier_proxy') vals.push(b[f] === true || b[f] === 'true');
      else if (f === 'guide_images') vals.push(_guideImagesJson(b[f]));   // 배열 → 정규화 JSON(090)
      else if (INTAKE_INT_FIELDS.has(f)) vals.push(_intOrZero(b[f]));
      else vals.push(b[f]);
      touched++;
    }
    if (touched === 0) {
      return res.status(400).json({ ok: false, error: '수정할 항목이 없습니다.' });
    }
    // 감사 필드(누가 수정했는지) — 전달된 경우에만 기록
    if (b.updated_by !== undefined) {
      sets.push(`updated_by = $${i++}`);
      vals.push((b.updated_by || '').toString().trim());
    }
    if (b.updated_by_name !== undefined) {
      sets.push(`updated_by_name = $${i++}`);
      vals.push((b.updated_by_name || '').toString().trim());
    }
    sets.push('updated_at = NOW()');
    vals.push(id);

    const { rows } = await pool.query(
      `UPDATE work_orders SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    const updated = rows[0];
    logger.info(`[order] 인트라넷 작업오더 수정: ${id} (by ${b.updated_by || '?'}, fields=${touched})`);

    // ★ 관리자 대시보드에 실시간 시스템알림 (SSE) — 인박스 원본이 인트라넷에서 수정됨
    const who = (b.updated_by_name || b.updated_by || '').toString().trim() || '인트라넷';
    try {
      sse.emitOrderUpdate({
        id: updated.id,
        title: updated.title,
        status: updated.status,
        updated_by: b.updated_by || '',
        updated_by_name: b.updated_by_name || '',
        message: `"${updated.title}" · 수정자 ${who} (인트라넷)`,
      });
    } catch (e) {
      logger.warn(`[order] order_update SSE 알림 실패: ${e.message}`);
    }

    res.json({ ok: true, id, data: updated });
  } catch (err) {
    next(err);
  }
}

// 인트라넷이 시도하는 후보 method/URL 을 모두 동일 핸들러로 처리 (PATCH/PUT/POST .../update)
router.route('/intake/:id').put(_intakeUpdateHandler).patch(_intakeUpdateHandler);
router.post('/intake/:id/update', _intakeUpdateHandler);

// ═══════════════════════════════════════════════════════════
// 유입가이드 이미지 — 인트라넷·리뷰웹 공용 전용 Drive 폴더에 "비공개" 저장
// 인증: X-Intake-Key(인트라넷) 또는 JWT(내부 staff/admin)
// body: { imageBase64, mimeType, fileName? }
//   → { ok, id, url, viewUrl }  (url/viewUrl = 리뷰웹 프록시 — Drive 파일은 비공개)
// 전용 폴더: env GUIDE_FOLDER_ID 우선, 없으면 AI_REVIEW_FOLDER 하위 [유입가이드] 자동
// ═══════════════════════════════════════════════════════════
function _guideImageAuthed(req) {
  const intakeKey = (req.body && req.body.intakeKey) || req.headers['x-intake-key'];
  if (process.env.ORDER_INTAKE_KEY && intakeKey === process.env.ORDER_INTAKE_KEY) return true;
  try {
    const tok = (req.headers.authorization || '').split(' ')[1];
    if (tok) { jwt.verify(tok, process.env.JWT_SECRET); return true; }
  } catch (_) { /* fallthrough */ }
  return false;
}
function _publicApiBase(req) {
  return (process.env.PUBLIC_API_URL || ('https://' + req.get('host'))).replace(/\/+$/, '');
}

router.post('/guide-image', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!_guideImageAuthed(req)) {
      return res.status(401).json({ ok: false, error: '인증에 실패했습니다.' });
    }
    // 썸네일 URL 수집: base64 없이 imageUrl만 오면 허용 CDN에서 서버가 직접 받아온다.
    // 쿠팡 상품 HTML은 봇차단(403)이지만 이미지 CDN(coupangcdn.com)은 미차단 —
    // 관리자가 브라우저에서 "이미지 주소 복사"한 URL을 붙여넣는 우회 경로(SSRF 가드는 thumbFetch).
    if ((!b.imageBase64 || !String(b.imageBase64).trim()) && b.imageUrl) {
      try {
        const got = await fetchThumbFromUrl(b.imageUrl);
        b.imageBase64 = got.base64;
        b.mimeType = got.mimeType;
        if (!b.fileName) b.fileName = 'campthumb_url_' + Date.now();
      } catch (e) {
        logger.warn(`[order] guide-image URL 수집 실패: ${e.message}`);
        return res.status(400).json({ ok: false, error: e.message });
      }
    }
    if (!b.imageBase64 || !String(b.imageBase64).trim()) {
      return res.status(400).json({ ok: false, error: '이미지 데이터가 없습니다.' });
    }

    // 전용 폴더 결정
    let folderId = process.env.GUIDE_FOLDER_ID;
    if (!folderId) {
      const root = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
      if (!root) {
        return res.status(503).json({ ok: false, error: 'Drive 폴더가 설정되지 않았습니다. (GUIDE_FOLDER_ID 또는 AI_REVIEW_FOLDER_ID)' });
      }
      const folder = await drive.ensureFolderPath(root, ['[유입가이드]']);
      folderId = folder.id;
    }

    const ext = ((b.mimeType || 'image/png').split('/')[1] || 'png').split('+')[0];
    let name = (b.fileName || ('guide_' + Date.now())).toString();
    if (!/\.[a-z0-9]+$/i.test(name)) name += '.' + ext;

    // 표시(프록시/썸네일)를 위해 링크 읽기 가능으로 저장. UI에는 프록시 URL만 노출.
    const up = await drive.uploadFileBase64(b.imageBase64, name, b.mimeType || 'image/png', folderId, { shareAnyone: true });

    // 리뷰웹 프록시 URL — Drive 파일은 비공개, 서버가 꺼내 스트리밍
    const proxy = `${_publicApiBase(req)}/api/order/guide-image/${up.id}`;
    res.json({ ok: true, id: up.id, url: proxy, viewUrl: proxy });
  } catch (err) {
    next(err);
  }
});

// GET /api/order/guide-image/:id — Drive 파일을 서버가 받아 스트리밍 (이미지 표시용)
// <img src>가 헤더 인증을 못 보내므로 토큰 없이 동작. id는 추측 불가한 Drive fileId.
// 스트리밍 실패 시(권한/네트워크) Drive thumbnail로 302 폴백.
router.get('/guide-image/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[-\w]{20,}$/.test(id)) return res.status(400).send('bad id');
  try {
    const f = await drive.downloadFile(id);
    res.set('Content-Type', f.mimeType || 'application/octet-stream');
    // 크로스도메인 <img> 임베드 허용 (helmet 기본 same-origin 이면 pages.dev에서 못 박힘)
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(f.buffer);
  } catch (err) {
    logger.warn(`[order] guide-image 스트리밍 실패(${id}): ${err.message} → thumbnail 폴백`);
    if (req.query.debug) {
      return res.status(500).json({
        ok: false, id,
        error: err.message,
        oauth: !!(process.env.DRIVE_OAUTH_CLIENT_ID && process.env.DRIVE_OAUTH_REFRESH_TOKEN),
        sa: !!(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_PRIVATE_KEY),
        stack: String(err.stack || '').split('\n').slice(0, 4),
      });
    }
    return res.redirect(302, `https://drive.google.com/thumbnail?id=${id}&sz=w2000`);
  }
});

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
    // ★ 작업시트탭URL은 **선택 항목**(작업표 생성 도입으로 제출 필수 해제 — PRD Q2 확정).
    //   시트를 미리 만들어 둔 경우엔 그대로 첨부하고, 리뷰웹시스템[3버전]에서 작업표를 생성할 경우 비워 둔다.
    //   접수(accept)는 여전히 URL+gid를 요구하므로 "접수된 오더 = linked_tab_* 보유" 불변식은 유지된다.

    const data = await _insertWorkOrder(b, req.admin?.name || '');
    _emitWorkOrderNew(data);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/order/my — 본인 오더 목록
router.get('/my', authMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const { rows } = await pool.query(
      `SELECT * FROM work_orders WHERE created_by = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
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
      `SELECT created_by, status FROM work_orders WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [b.id]
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
    // ★ 시트탭URL은 선택 항목 — 빈값으로 지우는 것도 허용(작업표 생성으로 진행 전환).
    //   접수 게이트가 URL+gid를 재검증하므로 빈값이 접수 흐름을 오염시키지 않는다.
    // ★ 보완요청(revision) 상태에서 AE가 수정하면 재제출(submitted)으로 자동 복귀
    if (cur[0].status === 'revision') {
      sets.push(`status = 'submitted'`);
    }
    sets.push(`updated_at = NOW()`);
    vals.push(b.id);

    const { rows } = await pool.query(
      `UPDATE work_orders SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    // 보완요청(revision) → 재제출(submitted) 복귀 = 관리자 인박스에 다시 알림
    if (cur[0].status === 'revision') {
      _emitWorkOrderNew(rows[0], { resubmitted: true });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 관리자(admin/master) — 인박스 / 상태변경 / 필드보정
// staff 차단: adminOrMasterMiddleware
// ═══════════════════════════════════════════════════════════

// GET /api/order/admin/new-count — 신규(제출됨) 오더 수 (배지/알림 폴링용)
router.get('/admin/new-count', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM work_orders WHERE status = 'submitted' AND deleted_at IS NULL`
    );
    res.json({ ok: true, count: rows[0] ? rows[0].count : 0 });
  } catch (err) {
    next(err);
  }
});

// GET /api/order/admin/list — 인박스 (status 필터 선택)
router.get('/admin/list', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const { status } = req.query;
    let q = `SELECT * FROM work_orders WHERE deleted_at IS NULL`;
    const vals = [];
    if (status) { q += ` AND status = $1`; vals.push(status); }
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
      `SELECT status, chat_room_url FROM work_orders WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [b.id]
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

    // ※ NULLIF($n,'') : 빈 문자열은 "변경 없음"으로 처리해 기존 값 유실 방지
    //    (프론트가 입력칸 값을 항상 전송하므로 COALESCE 만으로는 빈값이 기존값을 덮어씀)
    const { rows } = await pool.query(
      `UPDATE work_orders SET
         status = $2,
         admin_memo = COALESCE(NULLIF($3, ''), admin_memo),
         chat_room_url = COALESCE(NULLIF($4, ''), chat_room_url),
         linked_campaign_id = COALESCE(NULLIF($5, ''), linked_campaign_id),
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

// POST /api/order/admin/accept — 접수: work_sheet_url(gid)의 그 탭을 캠페인 탭 관리에 등록 +
//   작업오더 기본정보를 탭 메타에 자동 입력 + 상태 reviewing 전이 (단일 원자 처리)
// body: { id }
// ★ 동일 탭 재접수(2차 등)는 별도 탭을 만들지 않고 기존 한 줄을 유지한다.
//   차수(1차/2차) 구분은 시트의 '차수' 컬럼 → review_index.round 집계가 담당.
// ★ 중복 방지: tab_name 을 gid가 가리키는 "실제 탭 현재 제목"으로 등록 →
//   인덱스 자동갱신(smartBuild)의 (sheet_id, tab_name) 충돌과 정렬되어 중복 줄이 생기지 않는다.
//   (smartBuild 는 manager/time_range 등 메타 컬럼을 건드리지 않으므로 작업오더 메타는 보존됨)
router.post('/admin/accept', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const id = String((req.body || {}).id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });

    // 1) 작업오더 로드
    const { rows: cur } = await pool.query(
      `SELECT * FROM work_orders WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [id]
    );
    if (cur.length === 0) return res.status(404).json({ ok: false, error: '오더를 찾을 수 없습니다.' });
    const o = cur[0];

    // 접수 대상 상태(접수 버튼이 노출되는 상태)가 아니고 이미 탭에 연결돼 있으면 →
    // 부수효과(탭 보강·인덱스 빌드) 없이 멱등 반환 (진행중 오더의 중복 호출/재클릭 방어).
    const ACCEPT_ELIGIBLE = ['submitted', 'revision', 'rejected'];
    if (!ACCEPT_ELIGIBLE.includes(o.status) && o.linked_tab_gid) {
      return res.json({
        ok: true, data: o, tabName: o.linked_tab_name || '',
        alreadyRegistered: true, idempotent: true, indexBuilt: true, skipped: true,
      });
    }

    // 2) work_sheet_url 검증 (URL + gid 필수) — ★ 제출은 선택이지만 **접수는 여전히 탭이 있어야 성립**한다.
    //   접수는 그 탭을 tab_configs·campaigns 에 등록하는 단일 관문이라, 등록할 탭이 없으면 할 일이 없다.
    //   시트 미첨부 오더는 ① 시트탭URL을 채워 넣거나 ② 작업표를 생성(→ 시트 자동 생성)한 뒤 접수한다.
    const url = (o.work_sheet_url || '').trim();
    if (!url) {
      return res.status(400).json({
        ok: false,
        error: '작업시트탭URL이 없습니다. 시트탭 주소(…/edit#gid=숫자)를 입력하거나 작업표를 생성한 뒤 접수해주세요.',
        needsSheet: true,
      });
    }
    const sheetIdMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
    if (!sheetIdMatch) {
      return res.status(400).json({ ok: false, error: '유효한 구글 스프레드시트 URL이 아닙니다.' });
    }
    // ★ 탭 교정 재접수: URL의 gid가 시트에 없을 때(탭 삭제 후 재생성 = gid 변경 등) 프론트가
    //   아래 404 응답의 availableTabs 에서 사람이 고른 gid 를 body.gid 로 다시 보낸다.
    //   사람이 명시적으로 고른 값만 URL 보다 우선한다(자동 이름매칭 폴백은 두지 않는다 —
    //   "잘못된 탭 연결이 빈칸보다 나쁨" 규율).
    const pickGid = String((req.body || {}).gid || '').trim();
    const gidMatch = url.match(/[#?&]gid=(\d+)/);
    if (!gidMatch && !/^\d+$/.test(pickGid)) {
      return res.status(400).json({ ok: false, error: '작업시트탭URL에 gid가 없습니다. 특정 탭 주소(…/edit#gid=숫자)로 등록되어야 캠페인 탭 관리에 자동 반영됩니다.' });
    }
    const sheetId = sheetIdMatch[1];
    const gid = /^\d+$/.test(pickGid) ? pickGid : gidMatch[1];
    const gidCorrected = /^\d+$/.test(pickGid) && (!gidMatch || gidMatch[1] !== pickGid);

    // 멱등 표시: 같은 작업오더가 이미 같은 탭에 연결됨 (재클릭 안전 — 아래 업서트는 모두 idempotent)
    const idempotent = (String(o.linked_tab_gid || '') === gid && o.linked_tab_sheet_id === sheetId);

    // 3) gid → 실제 탭 현재 제목 해석
    let meta;
    try {
      meta = await getSpreadsheetMeta(sheetId);
    } catch (metaErr) {
      const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
      return res.status(502).json({ ok: false, error: '시트 접근 권한이 없습니다. 서비스 계정을 편집자로 추가해주세요.', serviceAccount: sa });
    }
    const spreadsheetTitle = meta._spreadsheetTitle || sheetId;
    const targetSheet = meta.find(s => String(s.properties.sheetId) === gid);
    if (!targetSheet) {
      // ★ 막다른 길 방지: 이 시트에 실제로 있는 탭 목록을 함께 돌려줘 프론트가
      //   "탭 골라서 접수" 교정 흐름을 열 수 있게 한다(사람이 고른 탭만 body.gid 재시도).
      const availableTabs = meta.slice(0, 200).map(s => ({
        gid: String(s.properties.sheetId),
        title: s.properties.title,
        hidden: !!s.properties.hidden,
      }));
      return res.status(404).json({
        ok: false,
        error: `gid=${gid} 에 해당하는 탭을 시트에서 찾을 수 없습니다. (탭이 삭제되었거나 URL이 잘못됨)`,
        gidNotFound: true,
        sheetId,
        urlGid: gid,
        availableTabs,
      });
    }
    const tabName = targetSheet.properties.title;
    const tabSheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${gid}`;

    // 4) 기등록 판정 — gid 우선 매칭, 매칭된 행의 "실제 tab_name"까지 받아 키 정합 유지.
    //    (같은 gid가 다른 탭명으로 등록돼 있으면 아래 rename 동기화로 현재 제목에 맞춘다)
    const { rows: existingRows } = await pool.query(
      `SELECT tab_name FROM tab_configs
         WHERE sheet_id = $1 AND (tab_gid = $2 OR tab_name = $3)
         ORDER BY (tab_gid = $2) DESC
         LIMIT 1`,
      [sheetId, gid, tabName]
    );
    const wasRegistered = existingRows.length > 0;
    const existingTabName = wasRegistered ? existingRows[0].tab_name : null;

    // 4-1) rename 동기화 — 같은 gid가 "다른 이름"으로 등록돼 있으면 현재 시트 제목으로 맞춘다.
    //   이렇게 해야 (sheet_id, tab_name) 키가 정렬되어 ① 아래 업서트가 기존 행을 갱신하고
    //   ② 인덱스 자동갱신(smartBuild)이 새 줄을 만들지 않아 "동일 탭 한 줄 수렴"이 유지된다.
    //   현재 제목으로 이미 다른 행이 있으면(희박) rename은 생략(유니크 충돌 방지)하고 그 행을 그대로 쓴다.
    if (wasRegistered && existingTabName !== tabName) {
      const { rows: clash } = await pool.query(
        `SELECT 1 FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`,
        [sheetId, tabName]
      );
      if (clash.length === 0) {
        await pool.query(
          `UPDATE tab_configs SET tab_name = $3, updated_at = NOW()
             WHERE sheet_id = $1 AND tab_name = $2`,
          [sheetId, existingTabName, tabName]
        );
      } else {
        logger.warn(`[order/accept] 탭명 동기화 충돌 — "${existingTabName}"→"${tabName}" 생략(현재 제목 행이 이미 존재)`);
      }
    }

    // 5) campaigns 등록(없으면 추가)
    await pool.query(
      `INSERT INTO campaigns (sheet_id, campaign_name, sheet_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (sheet_id, campaign_name) DO UPDATE SET
         sheet_url = EXCLUDED.sheet_url, updated_at = NOW()`,
      [sheetId, spreadsheetTitle, `https://docs.google.com/spreadsheets/d/${sheetId}/edit`]
    );

    // 6) tab_configs 등록/갱신 — (sheet_id, 현재 탭 제목) 키로 단일 업서트.
    //   메타(manager/time_range/review_type/delivery_type/display_name/campaign_name)는
    //   "비어 있을 때만" 작업오더 값으로 채운다(COALESCE-fill):
    //     · 신규 탭 / 빈 메타로 선등록된 탭 → 작업오더 기본정보로 채움
    //     · 기존 탭(차수 추가 접수, admin이 이미 설정한 메타) → 보존(2차의 다른 값으로 덮지 않음)
    //   taekhap(BOOLEAN)은 빈 값 구분이 불가하므로 신규 INSERT 때만 반영(기존 행은 보존).
    const courierProxy = (o.courier_proxy === true || o.courier_proxy === 'true');
    await pool.query(
      `INSERT INTO tab_configs
         (sheet_id, tab_name, tab_gid, sheet_url, campaign_name, display_name,
          manager, time_range, review_type, delivery_type, taekhap, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
       ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
         tab_gid       = COALESCE(NULLIF(tab_configs.tab_gid,''),       EXCLUDED.tab_gid),
         sheet_url     = COALESCE(NULLIF(tab_configs.sheet_url,''),     EXCLUDED.sheet_url),
         campaign_name = COALESCE(NULLIF(tab_configs.campaign_name,''), EXCLUDED.campaign_name),
         display_name  = COALESCE(NULLIF(tab_configs.display_name,''),  EXCLUDED.display_name),
         manager       = COALESCE(NULLIF(tab_configs.manager,''),       EXCLUDED.manager),
         time_range    = COALESCE(NULLIF(tab_configs.time_range,''),    EXCLUDED.time_range),
         review_type   = COALESCE(NULLIF(tab_configs.review_type,''),   EXCLUDED.review_type),
         delivery_type = COALESCE(NULLIF(tab_configs.delivery_type,''), EXCLUDED.delivery_type),
         updated_at    = NOW()`,
      [
        sheetId, tabName, gid, tabSheetUrl, spreadsheetTitle,
        // ★ 065: 탭 담당자는 리뷰웹 닉네임(만두/망고)이다 — 담당AE 실명(manager_name)을 넣으면
        //   탭 설정의 담당자 필터(만두/망고)와 어긋난다. 매핑 실패·랜덤은 빈 값으로 두어
        //   관리자가 직접 고르게 한다(틀린 값보다 빈 값이 낫다).
        (o.title || ''), mapWorkManager(o.work_manager), (o.purchase_time || ''),
        (o.review_type || ''), (o.delivery_type || ''), courierProxy,
      ]
    );

    // 7) 인덱스 빌드 (best-effort — 실패해도 등록·상태전이는 유지)
    let indexBuilt = true;
    try {
      await buildOneSheet(sheetId);
    } catch (buildErr) {
      indexBuilt = false;
      logger.warn(`[order/accept] 인덱스 빌드 실패 (등록은 완료): ${buildErr.message}`);
    }

    // 7b) RAW 미러 즉시 반영 (best-effort, 비차단 — 등록과 동시에 RAW 미러에 채워짐)
    //     단일 시트만 미러(전체 미러 대기 없음), throttle 경유라 쿼터 안전. 실패해도 등록은 유지.
    setImmediate(() => {
      mirrorOneSheet(sheetId).catch(mirrorErr =>
        logger.warn(`[order/accept] RAW 미러 즉시반영 실패 (등록은 완료): ${mirrorErr.message}`)
      );
    });

    // 8) 상태 전이 reviewing + 링크 기록
    //   접수하기 버튼이 노출되는 상태(submitted/revision/rejected)는 reviewing 으로 전이(모두 허용 전이),
    //   그 외(이미 reviewing 이후)는 상태 유지 — 동일 탭 재접수/재클릭 안전.
    //   processed_by 는 /admin/status 와 동일하게 항상 처리자(req.admin.name)로 기록.
    const nextStatus = ACCEPT_ELIGIBLE.includes(o.status) ? 'reviewing' : o.status;
    //   ★ 탭 교정 재접수(gidCorrected)면 work_sheet_url 도 고른 탭 주소로 함께 교정한다 —
    //     안 고치면 다음 재접수·프리필(gid 우선 재매칭)이 계속 죽은 gid 를 본다.
    //     사람이 명시적으로 고른 경우에만 덮는다($7 = null 이면 기존 값 유지).
    const { rows: upd } = await pool.query(
      `UPDATE work_orders SET
         status = $2,
         linked_tab_sheet_id = $3,
         linked_tab_name = $4,
         linked_tab_gid = $5,
         processed_by = $6,
         work_sheet_url = COALESCE($7, work_sheet_url),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, nextStatus, sheetId, tabName, gid, (req.admin?.name || ''), (gidCorrected ? tabSheetUrl : null)]
    );

    // 8b) 정산 계약 자동 연결 (088) — 인트라넷 리뷰오더 등록에서 고른 계약을 그대로 이 탭에 매칭한다.
    //   ★★ 이것이 "계약 매칭을 따로 하지 않아도 되는" 이유. 리뷰웹의 계약 매칭 화면은 이 규칙 이전에
    //      들어온 과거 작업건을 메우는 용도로만 남는다.
    //   ★ 이미 링크가 있으면 **덮지 않는다** — 사람이 고쳐 놓은 매칭을 재접수 한 번으로 되돌리면 안 된다.
    //   ★ fail-soft: 실패해도 접수는 성공(계약은 나중에 화면에서 매칭할 수 있다).
    let settlementLinked = null;
    if (o.sales_id) {
      try {
        const { rows: exist } = await pool.query(
          `SELECT sales_id FROM trackb_settlement_links
            WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL LIMIT 1`, [sheetId, tabName]);
        if (exist.length) {
          settlementLinked = (exist[0].sales_id === o.sales_id) ? 'already' : 'kept_existing';
        } else {
          await pool.query(
            `INSERT INTO trackb_settlement_links (sheet_id, tab_name, sales_id, quote_id, contract_number, linked_by)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [sheetId, tabName, o.sales_id, o.quote_id || null, o.contract_number || '', '자동(작업오더)']);
          settlementLinked = 'linked';
          logger.info(`[order/accept] 정산 계약 자동 연결: ${sheetId}/${tabName} → ${o.contract_number || o.sales_id}`);
        }
      } catch (linkErr) {
        settlementLinked = 'failed';
        logger.warn(`[order/accept] 정산 계약 자동 연결 실패 (접수는 완료): ${linkErr.message}`);
      }
    }

    logger.info(`[order/accept] ${id} → 탭 "${tabName}" (${wasRegistered ? '기존탭 연결' : '신규 등록'}), 캠페인=${spreadsheetTitle}, 빌드=${indexBuilt}`);

    res.json({
      ok: true,
      data: upd[0],
      tabName,
      campaignName: spreadsheetTitle,
      alreadyRegistered: wasRegistered,
      idempotent,
      indexBuilt,
      gidCorrected,       // true = 사람이 고른 탭으로 URL 의 죽은 gid 를 교정해 접수함
      settlementLinked,   // linked | already | kept_existing | failed | null(계약 미첨부 오더)
    });
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

    // ※ NULLIF($n,'') : 빈 문자열은 "변경 없음" (기존 값 유실 방지)
    const { rows } = await pool.query(
      `UPDATE work_orders SET
         chat_room_url = COALESCE(NULLIF($2, ''), chat_room_url),
         admin_memo = COALESCE(NULLIF($3, ''), admin_memo),
         linked_campaign_id = COALESCE(NULLIF($4, ''), linked_campaign_id),
         updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
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

// ═══════════════════════════════════════════════════════════
// PUT /api/order/admin/edit — 작업오더 관리자 수동 수정
//   (시안: frontend/docs/작업오더_관리자수정_와이어프레임.html · 2026-08-05 사용자 확정)
// body: { id, ...ADMIN_EDIT_FIELDS 중 바꿀 필드만 }
// · 전달된 필드만 부분 수정(PATCH). ★ 빈 값('')은 "지움"이 아니라 "변경 없음"(시안 확정 —
//   칸 비우기 사고 방지, 프론트도 바뀐 필드만 보낸다).
// · ★ 편집 불가 3종(완화 금지): 상태(status)=전용 [상태 변경] 흐름 / 계약건(sales_id·
//   contract_number·quote_id)=인트라넷 발주 확정값·정산 매칭 보호 / work_sheet_url=
//   접수·작업표 생성·gid 교정 재접수가 관리. guide_images 는 1차 제외(업로드 UI 필요).
// · 인트라넷 동기화: 값 자체는 인트라넷 "보낸 오더" 목록이 리뷰웹 원장을 실시간 조회하므로
//   자동 반영 — 여기서는 "무엇이 바뀌었나" 요약을 memo_log 에 남기고 기존 처리메모
//   webhook 으로 알림만 push 한다(수신부 무변경, fail-soft).
// ═══════════════════════════════════════════════════════════
const ADMIN_EDIT_FIELDS = [
  'title', 'start_date', 'manager_name', 'product_option', 'product_options_json',
  'pay_amount', 'daily_count', 'daily_count_text', 'purchase_time',
  'inflow_keyword', 'inflow_type', 'inflow_guide',
  'delivery_type', 'courier_proxy', 'review_type', 'recruit_count',
  'review_guide', 'special_notes', 'product_url', 'goods_cost_type', 'work_manager',
];
const ADMIN_EDIT_LABELS = {
  title: '작업명', start_date: '시작일', manager_name: '담당AE', product_option: '상품·옵션',
  product_options_json: '상품옵션표', pay_amount: '결제금액', daily_count: '일일건수',
  daily_count_text: '일일건수(텍스트)', purchase_time: '구매시간대', inflow_keyword: '유입키워드',
  inflow_type: '유입방식', inflow_guide: '유입가이드', delivery_type: '배송유형',
  courier_proxy: '택배대행', review_type: '리뷰타입', recruit_count: '총모집',
  review_guide: '리뷰가이드', special_notes: '특이사항', product_url: '상품URL',
  goods_cost_type: '물건비', work_manager: '작업담당',
};
// 긴 텍스트는 diff 원문 대신 "내용 수정"으로 요약(메모 도배 방지)
const ADMIN_EDIT_LONGTEXT = new Set(['product_option', 'product_options_json', 'inflow_guide', 'review_guide', 'special_notes']);

function _d10(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  return String(v).slice(0, 10);
}

router.put('/admin/edit', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const b = req.body || {};
    const id = String(b.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });

    const { rows: cur } = await pool.query(`SELECT * FROM work_orders WHERE id = $1 LIMIT 1`, [id]);
    if (cur.length === 0) return res.status(404).json({ ok: false, error: '오더를 찾을 수 없습니다.' });
    const o = cur[0];
    if (o.deleted_at) return res.status(409).json({ ok: false, error: '삭제된 작업오더는 수정할 수 없습니다.' });
    if (o.status === 'done') return res.status(409).json({ ok: false, error: '완료된 작업오더는 수정할 수 없습니다.' });

    // 동적 SET — 화이트리스트 밖 필드(status/sales_id/work_sheet_url 등)는 조용히 무시가 아니라
    // 도달 자체가 불가(목록을 순회하므로). 값이 실제로 달라진 필드만 SET + diff 기록.
    const sets = [], vals = [], changes = [];
    let i = 1;
    for (const f of ADMIN_EDIT_FIELDS) {
      if (b[f] === undefined) continue;
      let nv, curCmp, nvCmp;
      if (f === 'courier_proxy') {
        nv = (b[f] === true || b[f] === 'true');
        curCmp = (o.courier_proxy === true || o.courier_proxy === 'true') ? '예' : '아니오';
        nvCmp = nv ? '예' : '아니오';
      } else if (f === 'start_date') {
        if (!String(b[f]).trim()) continue;              // 빈 값 = 변경 없음
        nv = _dateOrNull(b[f]);
        if (nv === null) continue;                        // 형식 오류 = 무시(지우지 않는다)
        curCmp = _d10(o.start_date); nvCmp = _d10(nv);
      } else if (INTAKE_INT_FIELDS.has(f)) {
        if (String(b[f]).trim() === '') continue;
        nv = _intOrZero(b[f]);
        curCmp = String(_intOrZero(o[f])); nvCmp = String(nv);
      } else {
        nv = String(b[f]);
        if (!nv.trim()) continue;                         // 빈 값 = 변경 없음
        curCmp = String(o[f] == null ? '' : o[f]); nvCmp = nv;
      }
      if (String(curCmp) === String(nvCmp)) continue;     // 값 동일 = no-op(메모 도배 방지)
      sets.push(`${f} = $${i++}`);
      vals.push(nv);
      changes.push({ field: f, from: curCmp, to: nvCmp });
    }
    if (sets.length === 0) return res.json({ ok: true, data: o, unchanged: true, changed: [] });

    vals.push(id);
    const { rows: upd } = await pool.query(
      `UPDATE work_orders SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
      vals
    );

    // 수정 요약 → memo_log 누적 + 인트라넷 알림 push (admin_memo 는 덮지 않는다 — 처리메모 칸 보호)
    const by = req.admin?.name || '';
    const at = new Date().toISOString();
    const trunc = v => { v = String(v == null ? '' : v); return v === '' ? '(비어있음)' : (v.length > 40 ? v.slice(0, 40) + '…' : v); };
    const memoText = `📝 리뷰웹 관리자 수정 (${by || '관리자'})\n` + changes.map(c =>
      ADMIN_EDIT_LONGTEXT.has(c.field)
        ? `· ${ADMIN_EDIT_LABELS[c.field] || c.field}: 내용 수정`
        : `· ${ADMIN_EDIT_LABELS[c.field] || c.field}: ${trunc(c.from)} → ${trunc(c.to)}`
    ).join('\n');
    const { delivered, deliverError } = await _pushIntranetMemo(o, memoText, by, at);
    try {
      let log = [];
      try { const p = JSON.parse(upd[0].memo_log || '[]'); if (Array.isArray(p)) log = p; } catch (_) {}
      log.push({ memo: memoText, by, at, delivered, error: deliverError, kind: 'admin_edit' });
      if (log.length > 100) log = log.slice(-100);
      await pool.query(`UPDATE work_orders SET memo_log = $2 WHERE id = $1`, [id, JSON.stringify(log)]);
      upd[0].memo_log = JSON.stringify(log);
    } catch (logErr) {
      logger.warn(`[order/edit] memo_log 기록 실패 (수정은 완료): ${logErr.message}`);
    }

    logger.info(`[order/edit] ${id} 관리자 수정 by ${by}: ${changes.map(c => c.field).join(', ')}`);
    res.json({ ok: true, data: upd[0], changed: changes.map(c => c.field), delivered, deliverError });
  } catch (err) {
    next(err);
  }
});

// ── 인트라넷 처리메모 webhook push (공용 헬퍼) ─────────────────
//   send-memo(처리메모 전송)와 admin/edit(관리자 수정 알림)이 같은 채널을 쓴다 —
//   인트라넷은 이 payload 를 review_order_memos 로 받아 "보낸 오더" 카드의
//   주황 처리메모 블록에 표시한다(수신부 무변경). fail-soft(실패해도 호출측 저장은 성공).
// 필요 env: INTRANET_MEMO_WEBHOOK_URL (인트라넷 수신 URL), INTRANET_WEBHOOK_KEY (공유 시크릿)
async function _pushIntranetMemo(o, memo, sentBy, sentAt) {
  let delivered = false, deliverError = null;
  const hook = process.env.INTRANET_MEMO_WEBHOOK_URL;
  if (hook) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Review-Key': process.env.INTRANET_WEBHOOK_KEY || '' },
        body: JSON.stringify({
          order_id: o.id, title: o.title, requester_name: o.created_by, status: o.status,
          memo, sent_by: sentBy, sent_at: sentAt,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      delivered = resp.ok;
      if (!resp.ok) deliverError = 'HTTP ' + resp.status;
    } catch (e) {
      deliverError = e.message;
      logger.warn(`[order] 인트라넷 메모 webhook 실패: ${e.message}`);
    }
  } else {
    deliverError = 'webhook 미설정';
  }
  return { delivered, deliverError };
}

// PUT /api/order/admin/send-memo — 처리메모 저장 + 인트라넷으로 즉시 push(webhook)
// body: { id, memo }
router.put('/admin/send-memo', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });
    const memo = (b.memo || b.admin_memo || '').toString();
    if (!memo.trim()) return res.status(400).json({ ok: false, error: '메모 내용이 비어 있습니다.' });

    // 현재 오더 + 기존 로그 조회
    const { rows: cur } = await pool.query(
      `SELECT id, title, status, created_by, memo_log FROM work_orders WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [b.id]
    );
    if (cur.length === 0) return res.status(404).json({ ok: false, error: '오더를 찾을 수 없습니다.' });
    const o = cur[0];
    let log = [];
    try { const p = JSON.parse(o.memo_log || '[]'); if (Array.isArray(p)) log = p; } catch (_) {}

    const sentBy = req.admin?.name || '';
    const sentAt = new Date().toISOString();

    // 인트라넷 webhook push (공용 헬퍼)
    const { delivered, deliverError } = await _pushIntranetMemo(o, memo, sentBy, sentAt);

    // 로그 누적 (최근 100건 유지)
    log.push({ memo, by: sentBy, at: sentAt, delivered, error: deliverError });
    if (log.length > 100) log = log.slice(-100);

    const { rows } = await pool.query(
      `UPDATE work_orders SET admin_memo = $2, memo_log = $3, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [b.id, memo, JSON.stringify(log)]
    );
    res.json({ ok: true, data: rows[0], delivered, deliverError });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/order/admin/delete — 관리자 작업오더 삭제 (soft) + 인트라넷 동기 삭제 push
// body: { id }
// 리뷰웹 인박스에서 삭제 → soft delete(이력 보존) → 인트라넷으로 삭제 이벤트 전파(best-effort)
// 필요 env: INTRANET_ORDER_DELETE_WEBHOOK_URL (인트라넷 수신 URL), INTRANET_WEBHOOK_KEY (공유 시크릿)
router.delete('/admin/delete', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const b = req.body || {};
    const id = String(b.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });

    const { rows: cur } = await pool.query(
      `SELECT id, title, created_by, deleted_at FROM work_orders WHERE id = $1 LIMIT 1`, [id]
    );
    if (cur.length === 0) return res.status(404).json({ ok: false, error: '오더를 찾을 수 없습니다.' });
    const o = cur[0];
    const deletedBy = req.admin?.name || '';

    // soft delete (이미 삭제된 경우 멱등)
    if (!o.deleted_at) {
      await pool.query(
        `UPDATE work_orders SET deleted_at = NOW(), deleted_by = $2, deleted_by_name = $2, updated_at = NOW() WHERE id = $1`,
        [id, deletedBy]
      );
    }

    // 인트라넷으로 삭제 전파 (비차단: 실패해도 리뷰웹 삭제는 유지)
    let delivered = false, deliverError = null;
    const hook = process.env.INTRANET_ORDER_DELETE_WEBHOOK_URL;
    if (hook) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const resp = await fetch(hook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Review-Key': process.env.INTRANET_WEBHOOK_KEY || '' },
          body: JSON.stringify({
            event: 'order_deleted',
            order_id: o.id, title: o.title, requester_name: o.created_by,
            deleted_by: deletedBy, deleted_at: new Date().toISOString(),
          }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        delivered = resp.ok;
        if (!resp.ok) deliverError = 'HTTP ' + resp.status;
      } catch (e) {
        deliverError = e.message;
        logger.warn(`[order] 인트라넷 삭제 webhook 실패: ${e.message}`);
      }
    } else {
      deliverError = 'webhook 미설정';
    }

    logger.info(`[order] 관리자 작업오더 삭제: ${id} (by ${deletedBy}), 인트라넷 전파=${delivered}`);
    res.json({ ok: true, id, intranetDeleted: delivered, deliverError });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
