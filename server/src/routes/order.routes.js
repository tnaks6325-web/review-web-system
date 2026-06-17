const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const drive = require('../services/drive.service');
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
  'title', 'start_date', 'product_option', 'product_options_json', 'pay_amount', 'daily_count', 'daily_count_text',
  'purchase_time', 'inflow_type', 'inflow_guide', 'delivery_type', 'courier_proxy',
  'review_type', 'recruit_count', 'review_guide', 'special_notes',
  'product_url', 'work_sheet_url', 'goods_cost_type',
];

// 인트라넷 intake 수정 가능 필드 (status/created_by/processed_by/admin_memo 등 내부 상태는 제외)
// updated_by / updated_by_name 은 감사용으로 별도 처리(컨텐츠 수정으로 카운트하지 않음).
const INTAKE_EDITABLE_FIELDS = [
  'title', 'start_date', 'manager_name', 'product_option', 'product_options_json',
  'pay_amount', 'daily_count', 'daily_count_text', 'purchase_time',
  'inflow_keyword', 'inflow_type', 'inflow_guide',
  'delivery_type', 'courier_proxy', 'review_type', 'recruit_count',
  'review_guide', 'special_notes', 'product_url', 'work_sheet_url', 'goods_cost_type',
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

// 작업 오더 INSERT 공통 (intake/submit 공유, created_by 만 호출부에서 주입)
async function _insertWorkOrder(b, createdBy) {
  const optionsJson = (typeof b.product_options_json === 'string')
    ? b.product_options_json
    : (b.product_options_json ? JSON.stringify(b.product_options_json) : '');
  const { rows } = await pool.query(
    `INSERT INTO work_orders
      (id, title, start_date, product_option, product_options_json, pay_amount, daily_count, daily_count_text,
       purchase_time, inflow_keyword, inflow_type, inflow_guide, delivery_type, courier_proxy,
       review_type, recruit_count, review_guide, special_notes,
       product_url, work_sheet_url, goods_cost_type, manager_name, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'submitted',$23)
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
      b.delivery_type || '',
      b.courier_proxy === true || b.courier_proxy === 'true',
      b.review_type || '',
      b.recruit_count || 0,
      b.review_guide || '',
      b.special_notes || '',
      b.product_url || '',
      String(b.work_sheet_url).trim(),
      b.goods_cost_type || '',
      b.manager_name || '',
      createdBy,
    ]
  );
  return rows[0];
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
    if (!b.work_sheet_url || !String(b.work_sheet_url).trim()) {
      return res.status(400).json({ ok: false, error: '작업시트탭URL은 필수입니다.' });
    }
    const requester = (b.requester_name || b.created_by || '').toString().trim() || '인트라넷';
    const data = await _insertWorkOrder(b, requester);
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
      if (f === 'work_sheet_url' && !String(b[f]).trim()) {
        return res.status(400).json({ ok: false, error: '작업시트탭URL은 비울 수 없습니다.' });
      }
      sets.push(`${f} = $${i++}`);
      if (f === 'start_date') vals.push(_dateOrNull(b[f]));
      else if (f === 'courier_proxy') vals.push(b[f] === true || b[f] === 'true');
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
    logger.info(`[order] 인트라넷 작업오더 수정: ${id} (by ${b.updated_by || '?'}, fields=${touched})`);
    res.json({ ok: true, id, data: rows[0] });
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
    // ★ 필수: 작업시트탭URL (AE 요청 시 필수사항)
    if (!b.work_sheet_url || !String(b.work_sheet_url).trim()) {
      return res.status(400).json({ ok: false, error: '작업시트탭URL은 필수입니다.' });
    }

    const data = await _insertWorkOrder(b, req.admin?.name || '');
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
    // 시트탭URL을 빈값으로 지우는 것은 금지 (필수 유지)
    if (b.work_sheet_url !== undefined && !String(b.work_sheet_url).trim()) {
      return res.status(400).json({ ok: false, error: '작업시트탭URL은 비울 수 없습니다.' });
    }
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

// PUT /api/order/admin/send-memo — 처리메모 저장 + 인트라넷으로 즉시 push(webhook)
// body: { id, memo }
// 필요 env: INTRANET_MEMO_WEBHOOK_URL (인트라넷 수신 URL), INTRANET_WEBHOOK_KEY (공유 시크릿)
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

    // 인트라넷 webhook push
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
