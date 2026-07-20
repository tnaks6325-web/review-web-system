const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { appendSheet, readSheet } = require('../services/sheets.service');
const { logger } = require('../utils/logger');
const {
  computeCampaignState,
  fetchCampaignCounts,
  timeStrToMinutes,
  kstDayStartUtc,
  kstTodayAt,
} = require('../services/campaignState.service');
const { sanitizeWorkDetail, sanitizeGuideHtml } = require('../utils/sanitizeGuideHtml');
const { isActiveEditor } = require('../services/reviewerCampaignEditor.service');

/** work_detail 저장용 정규화(M2 변경②): 발행/수정 시점 sanitize(§03-E 이중 적용의 1차) + JSON 문자열화 */
function _prepWorkDetail(wd) {
  if (wd === undefined) return undefined;              // 미전달 = 변경 없음(COALESCE 유지)
  if (!wd || typeof wd !== 'object') return null;      // 명시적 비움
  return JSON.stringify({ ...wd, inflowGuideHtml: sanitizeGuideHtml(wd.inflowGuideHtml) });
}

// ID 생성 헬퍼
function _genCampaignId() {
  return 'camp_' + crypto.randomBytes(6).toString('hex');
}

// ═══════════════════════════════════════════════════════════
// 공개 응답 화이트리스트 (M1 선행 보안 — PRD §08)
//   레거시(participation_mode=false): 현행 /list 반환 필드 그대로 유지(카톡 신청 플로우 호환).
//   참여형(participation_mode=true): chat_url·notes·description·max/current_slots·linked_* 미반환
//     — 작업내용·카톡URL은 신청(홀드) 후 work-detail 게이트에서만, 총원 계열은 어디에도 노출 금지.
// ═══════════════════════════════════════════════════════════
const PUBLIC_FIELDS_LEGACY = [
  'id', 'title', 'channel', 'channel_custom', 'manager', 'time_range',
  'delivery_type', 'review_fee', 'badges', 'notes', 'chat_url',
  'status', 'sort_order', 'max_slots', 'current_slots', 'deadline',
  'description', 'linked_sheet_id', 'linked_tab_name', 'created_at',
];
const PUBLIC_FIELDS_PARTICIPATION = [
  'id', 'title', 'channel', 'channel_custom', 'manager', 'time_range',
  'delivery_type', 'review_fee', 'badges', 'status', 'sort_order',
  'thumbnail_url', 'created_at',
  'hold_ttl_min', 'close_buffer_min', // 민감정보 아님 — 프론트 안내문("N분 안에 제출")의 정확성용
];

function _pick(row, fields) {
  const out = {};
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

/** 공개 뷰: 레거시/참여형 분기 + 참여형은 상태엔진 페이로드 병합 */
function _publicView(row, counts, now) {
  if (!row.participation_mode) {
    return { ..._pick(row, PUBLIC_FIELDS_LEGACY), participation_mode: false };
  }
  const st = computeCampaignState(row, counts || {
    activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0,
  }, now);
  return {
    ..._pick(row, PUBLIC_FIELDS_PARTICIPATION),
    participation_mode: true,
    state: st.state,
    todayCount: st.todayCount,
    dailyQuota: st.dailyQuota,
    opensAt: st.opensAt,
    closesAt: st.closesAt,
    cutoffAt: st.cutoffAt,
  };
}

/** 요청의 JWT를 검증해 decoded 반환(없거나 무효면 null) */
function _decodeReq(req) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch (_) { return null; }
}

/** 유효한 admin/master JWT 요청인지 (무인증 라우트에서 관리자에게만 전체 필드 반환할 때) */
function _isAdminReq(req) {
  const d = _decodeReq(req);
  return !!(d && ['admin', 'master'].includes(d.role));
}

/** 리뷰어앱 공고수정 스코프 토큰이 프리필로 볼 수 있는 필드만 추린 뷰(레드팀 #4 — 전체 SELECT * 노출 차단).
 *  chat_url·notes·source_work_order_id·work_detail·linked_* 등 민감/구조필드 제외. */
function _scopedEditorView(row) {
  return {
    id: row.id, title: row.title, status: row.status, participation_mode: row.participation_mode,
    delivery_type: row.delivery_type, review_fee: row.review_fee, time_range: row.time_range,
    window_start: row.window_start, window_end: row.window_end,
    daily_limit: row.daily_limit, recruit_total: row.recruit_total,
    landing_url: row.landing_url, thumbnail_url: row.thumbnail_url,
    sort_order: row.sort_order, max_slots: row.max_slots,
  };
}

/** 리뷰어앱 공고수정(via:'reviewer_campaign') 전용 저장 핸들러.
 *  레드팀 #2/#6 방어: **안전 필드 화이트리스트만** UPDATE(linked_*·participation_mode·
 *  source_work_order_id·work_detail·chat_url·notes·deadline 등 절대 미변경 = 교차테넌트
 *  PII 오배정·participation 플립·deadline 소실 원천 차단). 참여형 공고만 대상.
 *  레드팀 #3 방어: 사용 시점 isActiveEditor(phone8) 재검증 → 명단 제외 즉시 차단. */
async function _scopedCampaignEdit(req, res) {
  const { id } = req.params;
  const p8 = req.admin && req.admin.phone8;
  if (!p8 || !(await isActiveEditor(p8))) {
    return res.status(403).json({ ok: false, error: '공고수정 권한이 없습니다. (허용 명단에서 제외되었을 수 있습니다)' });
  }
  const { rows: cur } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
  if (!cur.length) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
  const c = cur[0];
  // 리뷰어 홈에는 참여형 카드만 노출 → 스코프 편집도 참여형 공고만(레거시 캠페인 미접촉)
  if (!c.participation_mode) {
    return res.status(403).json({ ok: false, error: '이 공고는 리뷰어 앱에서 수정할 수 없습니다.' });
  }

  const b = req.body || {};
  const keep = (v, curV) => (v === undefined || v === null || v === '') ? curV : v;
  const numOr = (v, curV) => (v === undefined || v === null || v === '') ? curV : (Number(v) || 0);
  const title = (b.title !== undefined && String(b.title).trim() !== '') ? String(b.title).trim() : c.title;
  const status = ['draft', 'active', 'closed'].includes(b.status) ? b.status : c.status;
  const delivery_type = b.delivery_type !== undefined ? b.delivery_type : c.delivery_type;
  const time_range = b.time_range !== undefined ? b.time_range : c.time_range;
  const thumbnail_url = b.thumbnail_url !== undefined ? b.thumbnail_url : c.thumbnail_url;
  const landing_url = b.landing_url !== undefined ? b.landing_url : c.landing_url;
  // auto_order=true(시간 표기에 자유/자율) → 구매시간 명시적 비움(자율주문). 아니면 빈값=현재값 유지.
  const autoOrder = b.auto_order === true;
  const window_start = autoOrder ? null : keep(b.window_start, c.window_start);
  const window_end = autoOrder ? null : keep(b.window_end, c.window_end);
  const review_fee = numOr(b.review_fee, c.review_fee);
  const daily_limit = numOr(b.daily_limit, c.daily_limit);
  const recruit_total = numOr(b.recruit_total, c.recruit_total);
  const sort_order = numOr(b.sort_order, c.sort_order);
  const max_slots = numOr(b.max_slots, c.max_slots);

  // 참여형 활성화 게이트 재적용(linked_*는 현재값 — 편집 불가라 우회 불가)
  if (status === 'active') {
    const errs = _participationActivationErrors({ ...c, window_start, window_end, daily_limit });
    if (errs.length) return res.status(400).json({ ok: false, error: '참여형 활성화 불가: ' + errs.join(', ') });
  }

  const { rows } = await pool.query(
    `UPDATE recruit_campaigns SET
       title=$2, status=$3, delivery_type=$4, review_fee=$5, time_range=$6,
       thumbnail_url=$7, landing_url=$8, window_start=$9, window_end=$10,
       daily_limit=$11, recruit_total=$12, sort_order=$13, max_slots=$14, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id, title, status, delivery_type, review_fee, time_range,
     thumbnail_url, landing_url, window_start || null, window_end || null,
     daily_limit, recruit_total, sort_order, max_slots]
  );
  return res.json({ ok: true, data: rows[0] });
}

// 오픈 러시 방어: 무인증 참여 엔드포인트 rate limit (신청 가부의 SoT는 서버 재검사)
//   키 = phone8(있으면) — 공유 NAT/프록시에서도 개인별 버킷. 없으면 req.ip(app.js trust proxy 1홉 전제).
//   ※ express-rate-limit 7.5.1엔 ipKeyGenerator export가 없다(심판 실측) — req.ip 직접 사용.
function _p8Key(req) {
  const src = (req.body && (req.body.phone8 || req.body.phone)) || (req.query && req.query.phone8) || '';
  const p8 = String(src).replace(/\D/g, '').slice(-8);
  return p8.length === 8 ? 'p8:' + p8 : 'ip:' + (req.ip || 'unknown');
}
const applyLimiter = rateLimit({
  windowMs: 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, keyGenerator: _p8Key,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', reason: 'rate_limited' },
});
const detailLimiter = rateLimit({
  windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, keyGenerator: _p8Key,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', reason: 'rate_limited' },
});

/** 참여형 활성화 게이트(레드 #6·#10): gid·일일건수 필수. 시간창은
 *  "양쪽 설정(start<end)" 또는 "양쪽 미설정(자율주문=종일 오픈)"만 허용 — 한쪽만/역전은 차단. */
function _participationActivationErrors(c) {
  const errs = [];
  if (!c.linked_sheet_id || !c.linked_tab_gid) errs.push('연결 시트/탭 gid 필수(탭 리네임 내성)');
  const allDay = !c.window_start && !c.window_end; // 자율주문(종일 오픈)
  if (!allDay) {
    const s = timeStrToMinutes(c.window_start);
    const e = timeStrToMinutes(c.window_end);
    if (s === null || e === null || e <= s) errs.push('구매시간창은 시작<종료로 설정하거나, 자율주문이면 양쪽 모두 비워두세요');
  }
  if (!(Number(c.daily_limit) >= 1)) errs.push('일일진행건수(daily_limit ≥ 1) 필수');
  return errs;
}

// GET /api/campaign/list 5초 서버 캐시(rows+counts만 캐시, 상태는 매 요청 신선한 시각으로 재계산)
let _listCache = { at: 0, rows: null, countsMap: null };
const LIST_CACHE_MS = 5000;

// ═══════════════════════════════════════════════════════════
// 테이블 자동 생성 (마이그레이션 실패 시 안전장치)
// ═══════════════════════════════════════════════════════════
let _tableChecked = false;
async function _ensureTables() {
  if (_tableChecked) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recruit_campaigns (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        channel TEXT DEFAULT '',
        channel_custom TEXT DEFAULT '',
        manager TEXT DEFAULT '',
        time_range TEXT DEFAULT '',
        delivery_type TEXT DEFAULT '',
        review_fee INTEGER DEFAULT 0,
        badges JSONB DEFAULT '[]'::jsonb,
        notes TEXT DEFAULT '',
        chat_url TEXT DEFAULT '',
        status TEXT DEFAULT 'draft',
        sort_order INTEGER DEFAULT 0,
        max_slots INTEGER DEFAULT 0,
        current_slots INTEGER DEFAULT 0,
        deadline TIMESTAMPTZ,
        description TEXT DEFAULT '',
        linked_sheet_id TEXT DEFAULT '',
        linked_tab_name TEXT DEFAULT '',
        linked_tab_gid TEXT DEFAULT '',
        created_by TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_applications (
        id SERIAL PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
        applicant_name TEXT NOT NULL,
        applicant_phone TEXT DEFAULT '',
        applicant_inad TEXT DEFAULT '',
        status TEXT DEFAULT 'confirmed',
        sheet_row_added BOOLEAN DEFAULT FALSE,
        applied_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(campaign_id, applicant_name, applicant_phone)
      )
    `);
    _tableChecked = true;
  } catch (e) {
    // 이미 존재하는 경우 무시
    if (e.message.includes('already exists')) {
      _tableChecked = true;
    } else {
      logger.error('[campaign] 테이블 생성 실패:', e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 공개 API (로그인 불필요)
// ═══════════════════════════════════════════════════════════

// GET /api/campaign/list — 공개 캠페인 목록 (active 우선, closed 하단)
//   ★ M1 보안: 공개 화이트리스트만 반환(SELECT * 금지). 참여형은 상태엔진 페이로드 포함.
//   오픈 러시 방어: rows/counts 5초 캐시 — 상태·serverNow는 매 요청 신선하게 재계산.
router.get('/list', async (req, res, next) => {
  try {
    await _ensureTables();
    const now = new Date();
    let { rows, countsMap } = _listCache;
    if (!rows || now.getTime() - _listCache.at > LIST_CACHE_MS) {
      const q = await pool.query(`
        SELECT id, title, channel, channel_custom, manager, time_range,
               delivery_type, review_fee, badges, notes, chat_url,
               status, sort_order, max_slots, current_slots, deadline,
               description, linked_sheet_id, linked_tab_name, created_at,
               participation_mode, thumbnail_url, daily_limit, recruit_total,
               window_start, window_end, close_buffer_min, hold_ttl_min
        FROM recruit_campaigns
        WHERE status IN ('active', 'closed')
        ORDER BY
          CASE WHEN status = 'active' THEN 0 ELSE 1 END,
          sort_order ASC,
          created_at DESC
      `);
      rows = q.rows;
      const partIds = rows.filter(r => r.participation_mode).map(r => r.id);
      countsMap = await fetchCampaignCounts(pool, partIds, now);
      _listCache = { at: now.getTime(), rows, countsMap };
    }
    const data = rows.map(r => _publicView(r, countsMap.get(r.id), now));
    res.json({ ok: true, data, serverNow: now.toISOString() });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/:id — 캠페인 상세
//   ★ M1 보안: SELECT * 무인증 반환 제거. admin/master JWT면 전체(관리자 수정 모달 호환),
//     그 외에는 공개 화이트리스트(레거시/참여형 분기)만.
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    const _d = _decodeReq(req);
    if (_d && _d.via === 'reviewer_campaign') {
      // 리뷰어앱 공고수정 스코프 토큰 = 프리필 필요 필드만(민감/구조필드 미노출, 레드팀 #4)
      return res.json({ ok: true, data: _scopedEditorView(rows[0]) });
    }
    if (_isAdminReq(req)) {
      return res.json({ ok: true, data: rows[0] });
    }
    const now = new Date();
    const row = rows[0];
    const countsMap = row.participation_mode ? await fetchCampaignCounts(pool, [id], now) : null;
    res.json({ ok: true, data: _publicView(row, countsMap && countsMap.get(id), now), serverNow: now.toISOString() });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/:id/applications — 참여 카운트 (공개)
//   ★ M1 보안: 신청자 실명 명단 무인증 반환 제거 — count만 반환(프론트 소비처 없음 확인).
//     전체 명단은 관리자 전용 GET /admin/:id/applications 사용.
router.get('/:id/applications', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'confirmed') AS legacy_count,
              COUNT(*) FILTER (WHERE status = 'submitted'
                               OR (status = 'applied' AND expires_at > NOW())) AS participation_count
         FROM campaign_applications
        WHERE campaign_id = $1`,
      [id]
    );
    const r = rows[0] || {};
    const count = (Number(r.legacy_count) || 0) + (Number(r.participation_count) || 0);
    res.json({ ok: true, data: [], count });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/:id/work-detail — 작업내용 (신청 게이트 뒤, PRD §03-E)
//   유효 홀드(시각 기준) 또는 제출확정 이력 + holdToken 일치 시에만 반환.
//   만료 403 — 유예 없음(당일 재신청 불가 정책과 함께 만료 화면에서 운영자 문의 안내).
router.get('/:id/work-detail', detailLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const p8 = String(req.query.phone8 || '').replace(/\D/g, '').slice(-8);
    const token = String(req.query.holdToken || '').trim();
    if (p8.length !== 8 || !token) {
      return res.status(400).json({ ok: false, error: 'phone8(8자리)과 holdToken이 필요합니다.' });
    }

    const { rows: camps } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
    if (camps.length === 0) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    const camp = camps[0];
    if (!camp.participation_mode) return res.status(404).json({ ok: false, error: '작업내용이 없는 공고입니다.' });

    // holdToken은 신청 시 발급된 1회성 열쇠 — phone8만 아는 제3자의 열람 차단(정확 일치)
    const { rows: apps } = await pool.query(
      `SELECT id, status, expires_at, applied_at, submitted_at
         FROM campaign_applications
        WHERE campaign_id = $1 AND phone8 = $2 AND hold_token = $3 AND hold_token <> ''
        ORDER BY applied_at DESC
        LIMIT 1`,
      [id, p8, token]
    );
    if (apps.length === 0) {
      return res.status(403).json({ ok: false, error: '참여 내역이 없습니다.', reason: 'no_hold' });
    }
    const app = apps[0];
    const now = new Date();
    const validHold = app.status === 'applied' && app.expires_at && new Date(app.expires_at) > now;
    const isSubmitted = app.status === 'submitted';
    if (!validHold && !isSubmitted) {
      return res.status(403).json({
        ok: false, reason: 'expired',
        error: '참여가 만료되었어요. 오늘은 이 캠페인에 다시 참여할 수 없어요(내일 가능). 이미 구매하셨다면 운영자에게 문의해주세요.',
      });
    }

    res.json({
      ok: true,
      serverNow: now.toISOString(),
      application: {
        id: app.id,
        status: app.status,
        appliedAt: app.applied_at,
        expiresAt: app.expires_at,
        submittedAt: app.submitted_at,
      },
      workDetail: sanitizeWorkDetail(camp.work_detail),          // HTML은 응답 직전 방어적 재정화
      chatUrl: camp.chat_url || '',
      landingUrl: camp.landing_url || '',
      form: {                                                     // 인라인 구매양식(iframe) 진입 파라미터
        sheetId: camp.linked_sheet_id || '',
        gid: camp.linked_tab_gid || '',
        tabName: camp.linked_tab_name || '',
        displayName: camp.title || '',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/:id/cancel — 본인 홀드 취소 (phone8+holdToken 이중 열쇠)
//   취소해도 당일 이력이 남아 같은 캠페인 당일 재신청은 불가(§03-C — 프론트 확인 다이얼로그에서 고지).
router.post('/:id/cancel', applyLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const p8 = String(req.body.phone8 || '').replace(/\D/g, '').slice(-8);
    const token = String(req.body.holdToken || '').trim();
    if (p8.length !== 8 || !token) {
      return res.status(400).json({ ok: false, error: 'phone8(8자리)과 holdToken이 필요합니다.' });
    }
    // status='applied' 조건부 UPDATE — 제출확정·스윕과의 경합에서도 원자적(이미 submitted면 0행)
    const { rows } = await pool.query(
      `UPDATE campaign_applications
          SET status = 'cancelled'
        WHERE campaign_id = $1 AND phone8 = $2 AND hold_token = $3 AND hold_token <> ''
          AND status = 'applied'
        RETURNING id`,
      [id, p8, token]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '취소할 수 있는 참여가 없습니다.' });
    }
    logger.info(`[campaign/cancel] camp=${id} app=${rows[0].id} phone8=***${p8.slice(-4)}`);
    res.json({ ok: true, message: '참여가 취소되었습니다. 오늘은 이 캠페인에 다시 참여할 수 없어요.' });
  } catch (err) {
    next(err);
  }
});

// 참여형(홀드) 신청 — 원자 검사+홀드 생성 (레드-블루-심판 최종 구조)
//   잠금 계층(고정): ① recruit_campaigns 행 FOR UPDATE → ② phone8 advisory(xact) → ③ INSERT.
//   주문확정(confirmHoldInTx)·수동확정도 ①을 먼저 잡으므로 write-skew(레드 #3)와 교착이 동시에 제거된다.
async function _applyParticipation(req, res, next, campPre) {
  const id = campPre.id;
  const name = String(req.body.name || '').trim().slice(0, 100);
  const rawPhone = String(req.body.phone || '').trim().slice(0, 40);
  const p8 = rawPhone.replace(/\D/g, '').slice(-8);
  if (!name) return res.status(400).json({ ok: false, error: '이름을 입력해주세요.' });
  if (p8.length !== 8) return res.status(400).json({ ok: false, error: '연락처를 정확히 입력해주세요.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ① 캠페인 행 잠금 — 이 캠페인의 모든 신청/확정 쓰기 직렬화(READ COMMITTED write-skew 원천 차단)
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }
    const camp = cRows[0];
    const now = new Date();

    // ② phone8 advisory(xact) — 교차 캠페인 홀드 상한의 동시성(항상 캠페인 락 뒤 = 교착 불가)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('camp_hold_phone:' || $1::text))`, [p8]);

    // 잠금 후 신선 재집계 → 상태 게이트(open만 통과; READ COMMITTED 문장별 새 스냅샷이 선행 커밋 반영)
    const countsMap = await fetchCampaignCounts(client, [id], now);
    const st = computeCampaignState(camp, countsMap.get(id), now);
    if (st.state !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: st.state, state: st, error: '지금은 신청할 수 없습니다.' });
    }

    // 등록 리뷰어만(레드 #12 — 스크래핑 비용 상승, 완전 차단은 아님)
    const reg = await client.query(
      `SELECT name, phone, phone8, address, bank_name, bank_account, account_holder
         FROM reviewers WHERE phone8 = $1 LIMIT 1`, [p8]);
    if (!reg.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ ok: false, reason: 'not_registered', error: '리뷰어 등록 후 참여할 수 있어요.' });
    }

    // ★ M2 변경①: 내정보 완비 게이트를 "참여 시점"으로 전진 — 구매양식 신원게이트(#272)가 제출 순간
    //   차단하면 리뷰어는 이미 결제 후 15분 홀드 안에서 막힌다(돈 쓴 뒤 좌절 + 당일 재참여 불가).
    //   여기서 미리 막으면 홀드 미생성 = 자리 미점유 = 당일 참여권 무손실. 제출 단계 검사는 안전망으로 유지.
    {
      const { profileMissing } = require('../services/identity.service');
      const missing = profileMissing(reg.rows[0]);
      if (missing.length) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          ok: false, reason: 'profile_missing', missing,
          error: `내 정보를 먼저 등록해주세요: ${missing.join(', ')} — 참여 후 15분 안에 제출까지 끝나야 해서, 미리 등록이 필요해요.`,
        });
      }
    }

    const dayStartIso = kstDayStartUtc(now).toISOString();

    // 제출확정 이력 선검사(영구 1인 1참여 — uq_campaign_apps_active_hold 의미론): 23505 대신 명확한 사유(심판 J8)
    const done = await client.query(
      `SELECT 1 FROM campaign_applications WHERE campaign_id = $1 AND phone8 = $2 AND status = 'submitted' LIMIT 1`,
      [id, p8]);
    if (done.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: 'already_submitted', error: '이미 참여 완료한 캠페인이에요.' });
    }

    // 당일(KST) 동일 캠페인 이력 — expired/cancelled 포함 전 상태 차단(재신청 0회, §03-C)
    const hist = await client.query(
      `SELECT 1 FROM campaign_applications WHERE campaign_id = $1 AND phone8 = $2 AND applied_at >= $3 LIMIT 1`,
      [id, p8, dayStartIso]);
    if (hist.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: 'already_today', error: '오늘은 이 캠페인에 이미 참여 이력이 있어요(내일 가능).' });
    }

    // 전역 상한: 활성홀드 2건 + 당일 신청 총량(DB COUNT = 멀티인스턴스 안전, 레드 #12)
    const caps = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'applied' AND expires_at > NOW()) AS active_holds,
              COUNT(*) FILTER (WHERE applied_at >= $2) AS today_applies
         FROM campaign_applications WHERE phone8 = $1`,
      [p8, dayStartIso]);
    if (Number(caps.rows[0].active_holds) >= (parseInt(process.env.CAMPAIGN_HOLD_CAP || '2', 10) || 2)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: 'hold_cap', error: '동시에 참여 가능한 캠페인은 2개까지예요.' });
    }
    if (Number(caps.rows[0].today_applies) >= (parseInt(process.env.CAMPAIGN_DAILY_APPLY_CAP || '10', 10) || 10)) {
      await client.query('ROLLBACK');
      return res.status(429).json({ ok: false, reason: 'daily_apply_cap', error: '오늘 신청 가능한 횟수를 넘었어요.' });
    }

    // 홀드 생성: expires_at = min(now+TTL, 오늘 window_end) — state=open이므로 closesAt는 유효·미래.
    // ★ 자율주문(시간창 미설정)은 closesAt이 null → TTL만 적용(종일 오픈이라 창 마감 상한 없음)
    const ttlMs = (Number(camp.hold_ttl_min) || 15) * 60000;
    const closesAt = kstTodayAt(camp.window_end, now);
    const expiresAt = new Date(closesAt ? Math.min(now.getTime() + ttlMs, closesAt.getTime()) : now.getTime() + ttlMs);
    const holdToken = crypto.randomBytes(24).toString('base64url');
    const ins = await client.query(
      `INSERT INTO campaign_applications
         (campaign_id, applicant_name, applicant_phone, phone8, status, expires_at, hold_token)
       VALUES ($1,$2,$3,$4,'applied',$5,$6)
       RETURNING id, expires_at`,
      [id, name, rawPhone, p8, expiresAt.toISOString(), holdToken]);
    await client.query('COMMIT');
    logger.info(`[campaign/apply] 홀드 생성 camp=${id} app=${ins.rows[0].id} phone8=***${p8.slice(-4)}`);
    return res.json({
      ok: true, applicationId: ins.rows[0].id, holdToken, phone8: p8,
      expiresAt: ins.rows[0].expires_at, serverNow: now.toISOString(),
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (err.code === '23505') return res.status(409).json({ ok: false, reason: 'duplicate_hold', error: '이미 참여 중인 캠페인입니다.' }); // uq_campaign_apps_active_hold 백스톱
    return next(err);
  } finally {
    client.release();
  }
}

// POST /api/campaign/:id/apply — 참여 신청
router.post('/:id/apply', applyLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, inad } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, error: '이름을 입력해주세요.' });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ ok: false, error: '연락처를 입력해주세요.' });
    }

    const trimName = name.trim();
    const trimPhone = phone.trim();
    const trimInad = (inad || '').trim();

    // 1. 캠페인 존재 + 상태 확인
    const { rows: campRows } = await pool.query(
      'SELECT * FROM recruit_campaigns WHERE id = $1',
      [id]
    );
    if (campRows.length === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    const camp = campRows[0];

    // ★ 참여형 공고는 레거시 경로(슬롯 증가·시트 행 추가) 진입 금지 — 홀드 기반 신규 경로로 처리
    if (camp.participation_mode) {
      return _applyParticipation(req, res, next, camp);
    }

    if (camp.status !== 'active') {
      return res.status(400).json({ ok: false, error: '모집이 마감된 캠페인입니다.' });
    }

    // 2. 정원 초과 확인
    if (camp.max_slots > 0 && camp.current_slots >= camp.max_slots) {
      // 자동 마감 처리
      await pool.query("UPDATE recruit_campaigns SET status = 'closed', updated_at = NOW() WHERE id = $1", [id]);
      return res.status(400).json({ ok: false, error: '정원이 초과되어 모집이 마감되었습니다.' });
    }

    // 3. 중복 신청 확인
    const { rows: dupRows } = await pool.query(
      `SELECT id FROM campaign_applications 
       WHERE campaign_id = $1 AND applicant_name = $2 AND applicant_phone = $3 AND status = 'confirmed'`,
      [id, trimName, trimPhone]
    );
    if (dupRows.length > 0) {
      return res.status(400).json({ ok: false, error: '이미 참여 신청한 캠페인입니다.' });
    }

    // 4. 참여 기록 저장
    await pool.query(
      `INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, applicant_inad, status)
       VALUES ($1, $2, $3, $4, 'confirmed')`,
      [id, trimName, trimPhone, trimInad]
    );

    // 5. current_slots 증가
    const { rows: updatedRows } = await pool.query(
      `UPDATE recruit_campaigns SET current_slots = current_slots + 1, updated_at = NOW() WHERE id = $1 RETURNING current_slots, max_slots`,
      [id]
    );
    const updatedCamp = updatedRows[0];

    // 6. 정원 꽉 찬 경우 자동 마감
    if (updatedCamp.max_slots > 0 && updatedCamp.current_slots >= updatedCamp.max_slots) {
      await pool.query("UPDATE recruit_campaigns SET status = 'closed', updated_at = NOW() WHERE id = $1", [id]);
    }

    // 7. 스프레드시트에 행 자동 추가 (비동기 — 실패해도 참여 확정됨)
    if (camp.linked_sheet_id && camp.linked_tab_name) {
      setImmediate(async () => {
        try {
          await _addApplicationToSheet(camp, { name: trimName, phone: trimPhone, inad: trimInad });
          // 시트 추가 성공 기록
          await pool.query(
            `UPDATE campaign_applications SET sheet_row_added = TRUE 
             WHERE campaign_id = $1 AND applicant_name = $2 AND applicant_phone = $3`,
            [id, trimName, trimPhone]
          );
          logger.info(`[campaign/apply] 시트 행 추가 성공: ${camp.title} - ${trimName}`);
        } catch (sheetErr) {
          logger.error(`[campaign/apply] 시트 행 추가 실패: ${sheetErr.message}`);
        }
      });
    }

    res.json({
      ok: true,
      message: '참여 신청이 완료되었습니다!',
      currentSlots: updatedCamp.current_slots,
      maxSlots: updatedCamp.max_slots,
    });
  } catch (err) {
    // 유니크 제약 위반 (동시 요청 방어)
    if (err.code === '23505') {
      return res.status(400).json({ ok: false, error: '이미 참여 신청한 캠페인입니다.' });
    }
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 관리자 API (인증 필요)
// ═══════════════════════════════════════════════════════════

// GET /api/campaign/admin/list — 관리자 전체 목록 (draft 포함)
router.get('/admin/list', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const { rows } = await pool.query(`
      SELECT * FROM recruit_campaigns
      ORDER BY 
        CASE WHEN status = 'active' THEN 0 WHEN status = 'draft' THEN 1 ELSE 2 END,
        sort_order ASC,
        created_at DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/admin/create — 캠페인 생성
router.post('/admin/create', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const {
      title, channel, channel_custom, manager, time_range,
      delivery_type, review_fee, badges, notes, chat_url,
      status, sort_order, max_slots, deadline, description,
      linked_sheet_id, linked_tab_name, linked_tab_gid,
      // ★ M2 변경②: 참여형 발행 필드
      participation_mode, thumbnail_url, landing_url, daily_limit, recruit_total,
      window_start, window_end, close_buffer_min, hold_ttl_min, work_detail, source_work_order_id,
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ ok: false, error: '공고 제목을 입력해주세요.' });
    }

    // 참여형을 active로 "생성"하는 것도 활성화 게이트 통과 필요(status 라우트 우회 방지)
    if (participation_mode && (status === 'active')) {
      const errs = _participationActivationErrors({
        linked_sheet_id, linked_tab_gid, window_start, window_end, daily_limit,
      });
      if (errs.length) return res.status(400).json({ ok: false, error: '참여형 활성화 불가: ' + errs.join(', ') });
    }

    const { rows } = await pool.query(
      `INSERT INTO recruit_campaigns
       (id, title, channel, channel_custom, manager, time_range, delivery_type,
        review_fee, badges, notes, chat_url, status, sort_order,
        max_slots, deadline, description, linked_sheet_id, linked_tab_name, linked_tab_gid,
        created_by,
        participation_mode, thumbnail_url, landing_url, daily_limit, recruit_total,
        window_start, window_end, close_buffer_min, hold_ttl_min, work_detail, source_work_order_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
       RETURNING *`,
      [
        _genCampaignId(),
        title.trim(),
        channel || '',
        channel_custom || '',
        manager || '',
        time_range || '',
        delivery_type || '',
        review_fee || 0,
        JSON.stringify(badges || []),
        notes || '',
        chat_url || '',
        status || 'draft',
        sort_order || 0,
        max_slots || 0,
        deadline || null,
        description || '',
        linked_sheet_id || '',
        linked_tab_name || '',
        linked_tab_gid || '',
        req.admin?.name || '',
        participation_mode === true,
        thumbnail_url || '',
        landing_url || '',
        Number(daily_limit) || 0,
        Number(recruit_total) || 0,
        window_start || null,
        window_end || null,
        Number.isFinite(Number(close_buffer_min)) && close_buffer_min !== null && close_buffer_min !== undefined && close_buffer_min !== '' ? Number(close_buffer_min) : 10,
        Number.isFinite(Number(hold_ttl_min)) && hold_ttl_min !== null && hold_ttl_min !== undefined && hold_ttl_min !== '' ? Number(hold_ttl_min) : 15,
        _prepWorkDetail(work_detail) ?? null,
        source_work_order_id || '',
      ]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/campaign/admin/:id — 캠페인 수정
router.put('/admin/:id', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    // ★ 리뷰어앱 공고수정 스코프 토큰은 전용 화이트리스트 핸들러로 격리(레드팀 #2/#3/#6)
    if (req.admin && req.admin.via === 'reviewer_campaign') {
      return await _scopedCampaignEdit(req, res);
    }
    const { id } = req.params;
    const {
      title, channel, channel_custom, manager, time_range,
      delivery_type, review_fee, badges, notes, chat_url,
      status, sort_order, max_slots, deadline, description,
      linked_sheet_id, linked_tab_name, linked_tab_gid,
      // ★ M2 변경②: 참여형 발행 필드(전부 optional — 미전달 시 기존값 유지)
      participation_mode, thumbnail_url, landing_url, daily_limit, recruit_total,
      window_start, window_end, close_buffer_min, hold_ttl_min, work_detail, source_work_order_id,
    } = req.body;

    // ★ 참여형 활성화 게이트(심판 J7): COALESCE 편집으로 status='active' 우회 방지.
    //   이 라우트가 바꿀 수 있는 게이트 입력(연결탭·시간창·일일건수)을 본문값으로 병합해 판정.
    if (status === 'active') {
      const { rows: cur } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
      if (cur.length && (cur[0].participation_mode || participation_mode === true)) {
        const pick = (v, curV) => (v === undefined || v === null) ? curV : v;
        const eff = {
          ...cur[0],
          linked_sheet_id: pick(linked_sheet_id, cur[0].linked_sheet_id),
          linked_tab_gid: pick(linked_tab_gid, cur[0].linked_tab_gid),
          window_start: pick(window_start, cur[0].window_start),
          window_end: pick(window_end, cur[0].window_end),
          daily_limit: pick(daily_limit, cur[0].daily_limit),
        };
        const errs = _participationActivationErrors(eff);
        if (errs.length) return res.status(400).json({ ok: false, error: '참여형 활성화 불가: ' + errs.join(', ') });
      }
    }

    const wdPrepared = _prepWorkDetail(work_detail); // undefined=유지, null=비움, 문자열=교체

    const { rows } = await pool.query(
      `UPDATE recruit_campaigns SET
        title = COALESCE($2, title),
        channel = COALESCE($3, channel),
        channel_custom = COALESCE($4, channel_custom),
        manager = COALESCE($5, manager),
        time_range = COALESCE($6, time_range),
        delivery_type = COALESCE($7, delivery_type),
        review_fee = COALESCE($8, review_fee),
        badges = COALESCE($9, badges),
        notes = COALESCE($10, notes),
        chat_url = COALESCE($11, chat_url),
        status = COALESCE($12, status),
        sort_order = COALESCE($13, sort_order),
        max_slots = COALESCE($14, max_slots),
        deadline = $15,
        description = COALESCE($16, description),
        linked_sheet_id = COALESCE($17, linked_sheet_id),
        linked_tab_name = COALESCE($18, linked_tab_name),
        linked_tab_gid = COALESCE($19, linked_tab_gid),
        participation_mode = COALESCE($20, participation_mode),
        thumbnail_url = COALESCE($21, thumbnail_url),
        landing_url = COALESCE($22, landing_url),
        daily_limit = COALESCE($23, daily_limit),
        recruit_total = COALESCE($24, recruit_total),
        window_start = COALESCE($25, window_start),
        window_end = COALESCE($26, window_end),
        close_buffer_min = COALESCE($27, close_buffer_min),
        hold_ttl_min = COALESCE($28, hold_ttl_min),
        work_detail = CASE WHEN $29::boolean THEN $30::jsonb ELSE work_detail END,
        source_work_order_id = COALESCE($31, source_work_order_id),
        updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        title, channel, channel_custom, manager, time_range,
        delivery_type, review_fee || 0,
        badges ? JSON.stringify(badges) : null,
        notes, chat_url, status, sort_order || 0,
        max_slots || 0, deadline || null, description,
        linked_sheet_id, linked_tab_name, linked_tab_gid,
        (participation_mode === undefined || participation_mode === null) ? null : participation_mode === true,
        thumbnail_url ?? null,
        landing_url ?? null,
        (daily_limit === undefined || daily_limit === null || daily_limit === '') ? null : Number(daily_limit) || 0,
        (recruit_total === undefined || recruit_total === null || recruit_total === '') ? null : Number(recruit_total) || 0,
        window_start || null,
        window_end || null,
        (close_buffer_min === undefined || close_buffer_min === null || close_buffer_min === '') ? null : Number(close_buffer_min),
        (hold_ttl_min === undefined || hold_ttl_min === null || hold_ttl_min === '') ? null : Number(hold_ttl_min),
        wdPrepared !== undefined,          // $29: work_detail 교체 여부(undefined=유지)
        wdPrepared === undefined ? null : wdPrepared, // $30: 새 값(null=비움)
        source_work_order_id ?? null,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/campaign/admin/:id — 캠페인 삭제
router.delete('/admin/:id', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM recruit_campaigns WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    res.json({ ok: true, message: '삭제되었습니다.' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/campaign/admin/:id/status — 상태 변경 (active/closed/draft)
router.put('/admin/:id/status', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['draft', 'active', 'closed'].includes(status)) {
      return res.status(400).json({ ok: false, error: '유효하지 않은 상태입니다.' });
    }
    // ★ 참여형 활성화 게이트(레드 #6·#10): gid·시간창·일일건수 없이 발행되면
    //   상태엔진이 closed(window_invalid)로만 보여 "발행했는데 안 보임" 무신호 장애가 된다 → 선차단.
    if (status === 'active') {
      const { rows: cur } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
      if (!cur.length) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
      if (cur[0].participation_mode) {
        const errs = _participationActivationErrors(cur[0]);
        if (errs.length) return res.status(400).json({ ok: false, error: '참여형 활성화 불가: ' + errs.join(', ') });
      }
    }
    const { rows } = await pool.query(
      `UPDATE recruit_campaigns SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, status]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/admin/:id/applications — 관리자: 참여자 전체 목록
router.get('/admin/:id/applications', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    // ★ M3 리뷰 #11: hold_token(열람·취소 열쇠)은 관제에 불필요 — 브라우저로 내리지 않음(컬럼 화이트리스트)
    const { rows } = await pool.query(
      `SELECT id, campaign_id, applicant_name, applicant_phone, applicant_inad,
              status, sheet_row_added, applied_at, phone8, expires_at, submitted_at,
              order_submission_id, late_order_id
       FROM campaign_applications
       WHERE campaign_id = $1
       ORDER BY applied_at ASC`,
      [id]
    );
    res.json({ ok: true, data: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/admin/:id/confirm {applicationId} — 만료+기구매(late) 구제의 유일 경로 (admin/master)
//   유예 정책 제거에 따라, 만료 후 도착한 제출(late_order_id)은 이 수동확정으로만 자리 확정된다.
//   잠금 계층 apply·주문확정과 동일: 캠페인 행 FOR UPDATE → 신청 행 FOR UPDATE. 동일 phone8 applied 선-취소(레드 #7).
router.post('/admin/:id/confirm', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  const { id } = req.params;
  const appId = parseInt(req.body.applicationId, 10);
  if (!appId) return res.status(400).json({ ok: false, error: 'applicationId 필수' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }
    if (!cRows[0].participation_mode) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, error: '참여형 공고가 아닙니다.' }); }
    const { rows: t } = await client.query(
      `SELECT * FROM campaign_applications WHERE id = $1 AND campaign_id = $2 FOR UPDATE`, [appId, id]);
    if (!t.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '신청을 찾을 수 없습니다.' }); }
    const a = t[0];
    if (a.status === 'submitted') { await client.query('ROLLBACK'); return res.json({ ok: true, already: true }); } // 멱등
    if (!['applied', 'expired', 'cancelled'].includes(a.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: `'${a.status}' 상태는 확정 대상이 아닙니다(레거시 오확정 방지).` });
    }
    // 레드 #7: 같은 (campaign, phone8)의 다른 활성행 정리 — submitted 존재 시 이중확정 거부, applied는 선-취소
    const { rows: dup } = await client.query(
      `SELECT id FROM campaign_applications WHERE campaign_id = $1 AND phone8 = $2 AND id <> $3 AND status = 'submitted' LIMIT 1`,
      [id, a.phone8, appId]);
    if (dup.length) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, error: `이미 확정된 참여(#${dup[0].id})가 있습니다.` }); }
    await client.query(
      `UPDATE campaign_applications SET status = 'cancelled'
        WHERE campaign_id = $1 AND phone8 = $2 AND id <> $3 AND status = 'applied'`, [id, a.phone8, appId]);
    // 레드 #8②: submitted_at 소급 — late 주문의 제출시각(order_submissions.submitted_at = 생성시각; created_at 컬럼 없음, 심판 J5)
    //   → 없으면 applied_at → NOW(). 과거시각 소급 = 오늘 쿼터 미소비("일 시작 고정" 약속 보존).
    await client.query(
      `UPDATE campaign_applications ca
          SET status = 'submitted',
              submitted_at = COALESCE(
                (SELECT os.submitted_at FROM order_submissions os WHERE os.id = ca.late_order_id),
                ca.applied_at, NOW()),
              order_submission_id = COALESCE(ca.order_submission_id, ca.late_order_id)
        WHERE ca.id = $1`, [appId]);
    const { maybePersistClosed } = require('../services/campaignHold.service');
    await maybePersistClosed(client, id); // 레드 #8③: 수동 경로도 closed 영속 복제
    await client.query('COMMIT');
    logger.info(`[campaign/confirm] 수동확정 camp=${id} app=${appId} by=${req.admin && req.admin.name}`);
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (err.code === '23505') return res.status(409).json({ ok: false, error: '동일 리뷰어의 활성 참여와 충돌 — 새로고침 후 재시도하세요.' });
    next(err);
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════
// 내부: 시트 행 자동 추가
// ═══════════════════════════════════════════════════════════

/**
 * 캠페인 참여 시 연결된 시트 탭에 행 추가
 * 헤더를 읽어서 매핑 후 appendSheet 사용
 */
async function _addApplicationToSheet(campaign, applicant) {
  const { linked_sheet_id, linked_tab_name, linked_tab_gid } = campaign;
  if (!linked_sheet_id || !linked_tab_name) return;

  const opts = linked_tab_gid ? { gid: linked_tab_gid } : {};
  const escapedTab = linked_tab_name.replace(/'/g, "''");

  // 상위 50행 읽어서 헤더 탐색
  const allRows = await readSheet(linked_sheet_id, `'${escapedTab}'!A1:ZZ50`, opts);
  if (!allRows || allRows.length === 0) {
    throw new Error('시트 데이터를 읽을 수 없습니다.');
  }

  // 헤더 행 감지
  const HEADER_KEYWORDS = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호', '아이디', '주소'];
  let headerRow = null;
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(allRows.length, 50); i++) {
    const cells = (allRows[i] || []).map(c => String(c || '').trim());
    let matchCount = 0;
    for (const kw of HEADER_KEYWORDS) {
      if (cells.some(c => c.includes(kw))) {
        matchCount++;
        if (matchCount >= 2) { headerRow = cells; headerRowIdx = i; break; }
      }
    }
    if (headerRow) break;
  }

  if (!headerRow) {
    throw new Error('시트에서 헤더 행을 감지할 수 없습니다.');
  }

  // 헤더 매핑: 이름/연락처/인애드명 컬럼 찾기
  const NAME_ALIASES = ['수취인', '수취인명', '주문자', '성함', '이름', '성명', '신청자'];
  const PHONE_ALIASES = ['연락처', '전화번호', '전번뒷자리', '핸드폰', '휴대폰'];
  const INAD_ALIASES = ['인애드', '인애드명', '인애드제출', '카톡', '카카오', '닉네임'];
  const NUM_ALIASES = ['번호', 'No', 'NO', 'no'];

  const findCol = (aliases) => {
    for (const alias of aliases) {
      const idx = headerRow.findIndex(h => h.includes(alias));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const nameColIdx = findCol(NAME_ALIASES);
  const phoneColIdx = findCol(PHONE_ALIASES);
  const inadColIdx = findCol(INAD_ALIASES);
  const numColIdx = findCol(NUM_ALIASES);

  if (nameColIdx < 0) {
    throw new Error('시트에서 이름 컬럼을 찾을 수 없습니다.');
  }

  // 현재 데이터 행 수 파악 (번호 자동 부여용)
  const dataRows = allRows.slice(headerRowIdx + 1);
  const nextNum = dataRows.length + 1;

  // 새 행 구성 (헤더 길이만큼 빈 셀로 채운 후 매핑)
  const newRow = new Array(headerRow.length).fill('');
  
  if (numColIdx >= 0) newRow[numColIdx] = nextNum;
  newRow[nameColIdx] = applicant.name;
  if (phoneColIdx >= 0 && applicant.phone) newRow[phoneColIdx] = applicant.phone;
  if (inadColIdx >= 0 && applicant.inad) newRow[inadColIdx] = applicant.inad;

  // appendSheet로 행 추가
  await appendSheet(
    linked_sheet_id,
    `'${escapedTab}'!A1`,
    [newRow],
    opts
  );

  logger.info(`[campaign/sheet] 행 추가 완료: ${linked_tab_name} - ${applicant.name} (행 ${headerRowIdx + 1 + nextNum})`);
}

module.exports = router;
