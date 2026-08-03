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
  fetchOptionCounts,
  computeOptionView,
  timeStrToMinutes,
  kstDayStartUtc,
  kstTodayAt,
} = require('../services/campaignState.service');
const { deriveSchedules, tabsOfCampaigns, scheduleFor, describeTabDates } = require('../services/campaignSchedule.service');
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

/** 공고에 연결된 작업오더의 유입방식(inflow_type)을 라이브 역조회.
 *  우선순위: work_orders.linked_campaign_id = campId(발행 시 기록) → source_work_order_id 보조.
 *  Track A 무접촉(읽기만) · 실패/미연결은 '' 폴백(fail-soft — 홀드/제출 경로에 영향 없음). */
async function _lookupInflowType(campId, sourceWoId) {
  try {
    const { rows } = await pool.query(
      `SELECT inflow_type
         FROM work_orders
        WHERE (linked_campaign_id = $1 AND $1 <> '')
           OR (id = $2 AND $2 <> '')
        ORDER BY (linked_campaign_id = $1) DESC, updated_at DESC
        LIMIT 1`,
      [campId || '', sourceWoId || '']
    );
    return (rows[0] && rows[0].inflow_type) || '';
  } catch (_) {
    return '';   // 컬럼/테이블 이슈 등은 조용히 폴백(라이브 핫패스 보호)
  }
}

/**
 * 현금영수증 안내(1단계) — 연결 탭의 진행방식(income_type)에 '현영'이 포함된 공고만.
 *   리뷰어가 결제 단계에서 지출증빙 발행을 놓치지 않도록 work-detail에 사업자번호 +
 *   채널별(네이버/쿠팡) 발행방법 이미지를 동봉한다. 발행 여부의 진실원본은 탭 설정
 *   (tab_configs.income_type) 하나 — 공고 폼은 읽기 전용 표시만 한다(이중 관리 방지).
 *   실패는 null(fail-soft) — 안내 조회 장애가 작업내용 응답을 막지 않는다.
 */
async function _cashReceiptInfo(camp) {
  try {
    if (!camp || !camp.linked_sheet_id || !camp.linked_tab_name) return null;
    const { rows } = await pool.query(
      'SELECT income_type FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
      [camp.linked_sheet_id, camp.linked_tab_name]
    );
    const incomeType = rows[0]?.income_type || '';
    if (!incomeType.includes('현영')) return null;
    // 채널 목록·판정은 utils/cashReceiptChannels 단일 출처 — 저장 라우트·설정 화면과 같은 표를 본다.
    const { CASH_RECEIPT_SETTING_KEYS, cashReceiptSettingKey, cashReceiptChannelKey } =
      require('../utils/cashReceiptChannels');
    const { rows: s } = await pool.query(
      `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
      [['company_business_no', ...CASH_RECEIPT_SETTING_KEYS]]
    );
    const map = {};
    for (const r of s) map[r.key] = r.value || '';
    const ch = String(camp.channel === '직접입력' ? (camp.channel_custom || '') : (camp.channel || ''));
    const chKey = cashReceiptChannelKey(ch);
    // 판정 안 되는 채널 = 이미지 없이 문구 안내만(틀린 발행방법을 보여주는 것보다 낫다)
    const guideImageUrl = chKey ? (map[cashReceiptSettingKey(chKey)] || '') : '';
    return { required: true, incomeType, businessNo: map.company_business_no || '', guideImageUrl };
  } catch (_) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// 상품옵션(campaign_options) 헬퍼 (061, PRD v1.1)
//   opt_key는 시트 옵션열 기입값(selected_opt_key)과 동일 문자열 → 파이프 '|'(다중옵션 구분자) 제거.
// ═══════════════════════════════════════════════════════════
function _normOptKey(s) {
  return String(s == null ? '' : s).replace(/\|/g, '').trim().slice(0, 200);
}
function _optNum(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; }

/** 입력 옵션 배열 → 정규화·중복제거 행 배열. 배열 아님=null(미전달=변경없음). 빈 optKey 제거. */
function _normalizeOptionsInput(arr) {
  if (!Array.isArray(arr)) return null;
  const seen = new Set();
  const out = [];
  for (const o of arr) {
    if (o == null) continue;
    const raw = (typeof o === 'string') ? o : (o.optKey ?? o.opt_key ?? o.name ?? o.label);
    const optKey = _normOptKey(raw);
    if (!optKey || seen.has(optKey)) continue;
    seen.add(optKey);
    const obj = (typeof o === 'object' && o) || {};
    out.push({
      optKey,
      payAmount: _optNum(obj.payAmount ?? obj.pay_amount),
      recruitTotal: _optNum(obj.recruitTotal ?? obj.recruit_total),
      dailyLimit: _optNum(obj.dailyLimit ?? obj.daily_limit),
      sortOrder: out.length,
      // ★ 063 심층방어(레드 #6): 'closed'|'active'(명시)|null(미지정=기존 상태 유지) 3상태 —
      //   status를 안 싣는 호출자가 closed 옵션을 조용히 재오픈하지 못하게(자사 UI는 항상 명시 전송이라 동작 불변)
      status: (obj.status === 'closed') ? 'closed' : (obj.status === 'active' ? 'active' : null),
    });
  }
  return out;
}

/** 옵션 저장(replace-set): 제공 옵션 upsert + 목록에서 빠진 기존 옵션은 참여자 있으면 closed, 없으면 삭제.
 *  ★ 참여자 있는 옵션은 절대 삭제하지 않음(기록·정원 보호).
 *  ★★ 원자성·상호배제(레드/블루 #2·#7): 자체 트랜잭션 + recruit_campaigns 행 FOR UPDATE로
 *     apply/change-option과 동일 락 계층 확보 → "사용여부 SELECT→DELETE" 사이 동시 apply가
 *     끼어들어 방금 참여한 옵션을 삭제하는 TOCTOU를 봉합. 실패 시 전체 롤백(부분 저장 없음). */
async function _saveCampaignOptions(campaignId, options) {
  if (!Array.isArray(options)) return; // 미전달=변경 없음
  const keep = new Set(options.map(o => o.optKey));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lock } = await client.query('SELECT id FROM recruit_campaigns WHERE id=$1 FOR UPDATE', [campaignId]);
    if (!lock.length) { await client.query('ROLLBACK'); return; }
    for (const o of options) {
      await client.query(
        `INSERT INTO campaign_options (campaign_id, opt_key, pay_amount, recruit_total, daily_limit, sort_order, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'active'),NOW())
         ON CONFLICT (campaign_id, opt_key) DO UPDATE SET
           pay_amount=EXCLUDED.pay_amount, recruit_total=EXCLUDED.recruit_total,
           daily_limit=EXCLUDED.daily_limit, sort_order=EXCLUDED.sort_order,
           status=COALESCE($7, campaign_options.status), updated_at=NOW()`,
        [campaignId, o.optKey, o.payAmount, o.recruitTotal, o.dailyLimit, o.sortOrder, o.status]);
    }
    const { rows: existing } = await client.query('SELECT opt_key FROM campaign_options WHERE campaign_id=$1', [campaignId]);
    for (const e of existing) {
      if (keep.has(e.opt_key)) continue;
      const { rows: used } = await client.query(
        `SELECT 1 FROM campaign_applications
          WHERE campaign_id=$1 AND option_key=$2 AND status IN ('applied','submitted') LIMIT 1`,
        [campaignId, e.opt_key]);
      if (used.length) {
        await client.query("UPDATE campaign_options SET status='closed', updated_at=NOW() WHERE campaign_id=$1 AND opt_key=$2", [campaignId, e.opt_key]);
      } else {
        await client.query('DELETE FROM campaign_options WHERE campaign_id=$1 AND opt_key=$2', [campaignId, e.opt_key]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

/** 캠페인 옵션 뷰 목록(정렬: 활성 먼저, 마감 하단). campState 반영해 selectable 계산. 옵션 없으면 []. */
async function _loadOptionViews(db, campaignId, campState, now = new Date()) {
  const { rows } = await db.query(
    `SELECT opt_key, pay_amount, recruit_total, daily_limit, status
       FROM campaign_options WHERE campaign_id=$1 ORDER BY (status='closed'), sort_order, id`,
    [campaignId]);
  if (!rows.length) return [];
  const counts = await fetchOptionCounts(db, campaignId, now);
  return rows.map(r => computeOptionView(r, counts.get(r.opt_key), campState));
}

/** 참여 전 공개용 옵션 뷰: 옵션명+잔여만(금액은 참여 후 공개 원칙 — payAmount·상세카운트 제외). */
function _publicOptionView(v) {
  return {
    optKey: v.optKey,
    remaining: v.remaining,           // null=무제한
    todayRemaining: v.todayRemaining, // null=옵션 일일제한 없음
    status: v.status,                 // open|soldout|today_done|closed
    selectable: v.selectable,
  };
}

/** 목록용 배치 옵션 조회(캠페인 N개 → 옵션행+카운트 2쿼리). 5초 리스트 캐시로 비용 상각.
 *  @returns Map campaignId → [{ row, cnt }]  (정렬 유지) */
async function _fetchOptionsForCampaigns(db, ids, now = new Date()) {
  const out = new Map();
  const list = (ids || []).filter(Boolean);
  if (!list.length) return out;
  const dayStart = kstDayStartUtc(now).toISOString();
  const { rows: optRows } = await db.query(
    `SELECT campaign_id, opt_key, pay_amount, recruit_total, daily_limit, status
       FROM campaign_options WHERE campaign_id = ANY($1) ORDER BY campaign_id, (status='closed'), sort_order, id`, [list]);
  if (!optRows.length) return out;
  const { rows: cntRows } = await db.query(
    `SELECT campaign_id, option_key,
            COUNT(*) FILTER (WHERE status='applied'   AND expires_at > NOW())                      AS active_holds,
            COUNT(*) FILTER (WHERE status='applied'   AND expires_at > NOW() AND applied_at >= $2)  AS today_active_holds,
            COUNT(*) FILTER (WHERE status='submitted')                                              AS submitted,
            COUNT(*) FILTER (WHERE status='submitted' AND submitted_at >= $2)                       AS today_submitted
       FROM campaign_applications
      WHERE campaign_id = ANY($1) AND option_key IS NOT NULL
      GROUP BY campaign_id, option_key`, [list, dayStart]);
  const cntMap = new Map(); // `${camp} ${optKey}` → cnt
  for (const r of cntRows) {
    cntMap.set(r.campaign_id + ' ' + r.option_key, {
      activeHolds: Number(r.active_holds) || 0, todayActiveHolds: Number(r.today_active_holds) || 0,
      submitted: Number(r.submitted) || 0, todaySubmitted: Number(r.today_submitted) || 0,
    });
  }
  for (const row of optRows) {
    if (!out.has(row.campaign_id)) out.set(row.campaign_id, []);
    out.get(row.campaign_id).push({ row, cnt: cntMap.get(row.campaign_id + ' ' + row.opt_key) });
  }
  return out;
}

/** 관리 편집용 원본 옵션 목록(카운트 없이 설정값 그대로 — 프리필용). */
async function _loadOptionsRaw(db, campaignId) {
  const { rows } = await db.query(
    `SELECT opt_key AS "optKey", pay_amount AS "payAmount", recruit_total AS "recruitTotal",
            daily_limit AS "dailyLimit", sort_order AS "sortOrder", status
       FROM campaign_options WHERE campaign_id=$1 ORDER BY (status='closed'), sort_order, id`,
    [campaignId]);
  return rows;
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
  'is_popular', // ★ 064: [인기!] 배지(표시용 — 선행참여 게이트는 참여형 apply에서만 판정)
  'pinned_at',  // ★ 064: 관리자 별표 토글의 현재 상태 표시용(정렬 메타 — 민감정보 아님)
];
const PUBLIC_FIELDS_PARTICIPATION = [
  'id', 'title', 'channel', 'channel_custom', 'manager', 'time_range',
  'delivery_type', 'review_fee', 'badges', 'status', 'sort_order',
  'thumbnail_url', 'created_at',
  'hold_ttl_min', 'close_buffer_min', // 민감정보 아님 — 프론트 안내문("N분 안에 제출")의 정확성용
  'multi_account_mode', 'sub_hold_ttl_min', // ★ 063: 카드 "타계정 가능" 배지(§09-4)+타계정 10분 안내. multi_daily_limit는 비공개(409 사유로만 전달)
  'is_popular', // ★ 064: [인기!] 배지 + 선행참여 안내
  'pinned_at',  // ★ 064: 관리자 별표 토글의 현재 상태 표시용(정렬 메타 — 민감정보 아님)
];

function _pick(row, fields) {
  const out = {};
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

/** 공개 뷰: 레거시/참여형 분기 + 참여형은 상태엔진 페이로드 병합 */
function _publicView(row, counts, now, schedule) {
  if (!row.participation_mode) {
    return { ..._pick(row, PUBLIC_FIELDS_LEGACY), participation_mode: false };
  }
  const st = computeCampaignState(row, counts || {
    activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0,
  }, now, schedule);
  return {
    ..._pick(row, PUBLIC_FIELDS_PARTICIPATION),
    participation_mode: true,
    state: st.state,
    todayCount: st.todayCount,
    dailyQuota: st.dailyQuota,
    opensAt: st.opensAt,
    closesAt: st.closesAt,
    cutoffAt: st.cutoffAt,
    allDay: st.allDay === true,       // 자율주문(종일 오픈) 신호
    startDate: st.startDate || null,  // 시작일(062) — 시작일 전엔 state=preopen + opensAt=시작일 오픈시각
    // ★ 시트 일정 파생(063): 마감일·오늘 물량·다음 진행일. 미파생이면 전부 없음(기존 동작).
    endDate: st.endDate || null,
    scheduleSource: st.scheduleSource || null,
    stateReason: st.stateReason || null,
    nextWorkDate: st.nextWorkDate || null,
    // daily_done 카드의 "다시 열릴 때까지" 카운트다운 기준(오늘의 opensAt은 이미 지난 시각)
    reopensAt: st.reopensAt || null,
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
    // 작업내용은 **읽기 전용 프리필**로만 포함 — 수정 모달에서 "지금 어떤 유입가이드가 걸려 있는지"를
    // 육안 확인하는 용도. 저장 경로(_scopedCampaignEdit)는 여전히 work_detail을 화이트리스트에서
    // 제외하므로 쓰기 표면은 넓어지지 않는다. 내용도 이미 홀드 보유 리뷰어에게 공개되는 값이고
    // 저장 시 sanitize된 본문이라 새로 노출되는 민감정보가 없다(구조/연결 필드는 계속 미노출).
    work_detail: row.work_detail,
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

/**
 * 작업오더의 작업시트탭 → 공고 연결 탭 자동 보정.
 *
 * 작업시트탭URL은 AE 제출 **필수**라 오더에는 항상 값이 있는데, 발행 폼에서 탭을 못 고르면
 * (접수 전 발행·드롭다운 미로딩 등) 공고가 "시트 탭 미연결"로 남아 **게시 자체가 막힌다.**
 * 그래서 저장 시점에 서버가 한 번 더 채운다 — 프론트 프리필이 놓쳐도 복구되는 안전망.
 *
 * ★ **비어 있을 때만** 채운다(관리자가 고른 탭을 절대 덮지 않는다).
 * ★ 해석 순서: 접수 때 확정된 `linked_tab_*` → 없으면 `work_sheet_url`의 sheetId·gid로
 *   `tab_configs`에서 탭명을 역조회(미접수 오더 구제). 어느 쪽도 못 찾으면 그대로 둔다.
 *
 * @returns {{sheetId, tabName, tabGid}|null}
 */
async function _linkedTabFromWorkOrder(workOrderId) {
  const id = String(workOrderId || '').trim();
  if (!id) return null;
  try {
    const { rows } = await pool.query(
      `SELECT linked_tab_sheet_id, linked_tab_name, linked_tab_gid, work_sheet_url
         FROM work_orders WHERE id = $1 LIMIT 1`, [id]
    );
    const o = rows[0];
    if (!o) return null;
    if (o.linked_tab_sheet_id && o.linked_tab_name) {
      return { sheetId: o.linked_tab_sheet_id, tabName: o.linked_tab_name, tabGid: String(o.linked_tab_gid || '') };
    }
    // 미접수 오더 폴백 — URL에서 시트ID·gid를 뽑아 등록된 탭에서 이름을 찾는다
    const url = String(o.work_sheet_url || '');
    const sm = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url);
    const gm = /[#?&]gid=(\d+)/.exec(url);
    if (!sm || !gm) return null;
    const { rows: tc } = await pool.query(
      `SELECT tab_name FROM tab_configs WHERE sheet_id = $1 AND tab_gid = $2 LIMIT 1`, [sm[1], gm[1]]
    );
    if (!tc.length) return null;   // 아직 등록 안 된 탭 — 접수하면 해결된다
    return { sheetId: sm[1], tabName: tc[0].tab_name, tabGid: gm[1] };
  } catch (e) {
    logger.warn(`[campaign] 작업오더 연결탭 조회 실패(무시): ${e.message}`);
    return null;   // fail-soft — 보정 실패가 공고 저장을 막지 않는다
  }
}

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
    let { rows, countsMap, optionsMap } = _listCache;
    if (!rows || now.getTime() - _listCache.at > LIST_CACHE_MS) {
      const q = await pool.query(`
        SELECT id, title, channel, channel_custom, manager, time_range,
               delivery_type, review_fee, badges, notes, chat_url,
               status, sort_order, max_slots, current_slots, deadline,
               description, linked_sheet_id, linked_tab_name, linked_tab_gid, created_at,
               participation_mode, thumbnail_url, daily_limit, recruit_total,
               window_start, window_end, close_buffer_min, hold_ttl_min, start_date,
               multi_account_mode, sub_hold_ttl_min, is_popular, pinned_at
        FROM recruit_campaigns
        WHERE status IN ('active', 'closed')
        ORDER BY
          CASE WHEN status = 'active' THEN 0 ELSE 1 END,
          (pinned_at IS NULL), pinned_at ASC,  -- ★ 064: 별표 고정 우선 — 먼저 별표한 순서대로(구 노출순서 정렬 대체)
          created_at DESC
      `);
      rows = q.rows;
      const partIds = rows.filter(r => r.participation_mode).map(r => r.id);
      countsMap = await fetchCampaignCounts(pool, partIds, now);
      optionsMap = await _fetchOptionsForCampaigns(pool, partIds, now);
      _listCache = { at: now.getTime(), rows, countsMap, optionsMap };
    }
    // ★ 시트 일정 파생(063) — 자체 1분 캐시라 목록 캐시 밖에서 호출해도 저비용. 실패=null(폴백).
    const schedMap = await deriveSchedules(pool, tabsOfCampaigns(rows), now);
    const data = rows.map(r => {
      const view = _publicView(r, countsMap.get(r.id), now, scheduleFor(schedMap, r));
      // 카드 옵션명+잔여(옵션 등록 참여형만). 상태는 매 요청 신선한 view 기준.
      const opts = optionsMap && optionsMap.get(r.id);
      if (r.participation_mode && opts && opts.length) {
        view.options = opts.map(o => _publicOptionView(computeOptionView(o.row, o.cnt, view)));
      }
      return view;
    });
    res.json({ ok: true, data, serverNow: now.toISOString() });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/popular-status?phone8= — 인기상품 참여 가능 여부(무인증 phone8 스코프, 064)
//   apply의 popular_locked 게이트와 **동일 계산**(명의 기준): 크레딧 = 일반(비인기) 참여형 제출완료 수
//   − 인기 소비(제출확정 + 유효홀드). 만료·취소된 인기 건은 자동 환불(미계수).
//   ★ 라우트 등록 순서: GET '/:id' 보다 앞이어야 함 — 뒤에 두면 '/:id'가 'popular-status'를 id로 삼킨다.
router.get('/popular-status', applyLimiter, async (req, res, next) => {
  try {
    const p8 = String(req.query.phone8 || '').replace(/\D/g, '').slice(-8);
    if (p8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8이 필요합니다.' });
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE rc.is_popular IS NOT TRUE AND ca.status = 'submitted') AS normal_done,
         COUNT(*) FILTER (WHERE rc.is_popular IS TRUE AND (ca.status = 'submitted' OR (ca.status = 'applied' AND ca.expires_at > NOW()))) AS popular_used
       FROM campaign_applications ca
       JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
      WHERE ca.phone8 = $1 AND rc.participation_mode`, [p8]);
    const normalDone = Number(rows[0].normal_done) || 0;
    const popularUsed = Number(rows[0].popular_used) || 0;
    res.json({ ok: true, normalDone, popularUsed, credits: Math.max(0, normalDone - popularUsed) });
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
      // 관리자: 전체 행 + 편집용 원본 옵션 목록(프리필)
      const options = rows[0].participation_mode ? await _loadOptionsRaw(pool, id) : [];
      return res.json({ ok: true, data: rows[0], options });
    }
    const now = new Date();
    const row = rows[0];
    const countsMap = row.participation_mode ? await fetchCampaignCounts(pool, [id], now) : null;
    const schedMap = row.participation_mode ? await deriveSchedules(pool, tabsOfCampaigns([row]), now) : null;
    const view = _publicView(row, countsMap && countsMap.get(id), now, schedMap && scheduleFor(schedMap, row));
    if (row.participation_mode) {
      // 옵션명+잔여만 공개(금액 등 상세는 참여 후 work-detail에서)
      const opts = await _loadOptionViews(pool, id, view, now);
      view.options = opts.map(_publicOptionView);
    }
    res.json({ ok: true, data: view, serverNow: now.toISOString() });
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
      `SELECT id, status, expires_at, applied_at, submitted_at, option_key
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

    // 유입방식(inflow_type): 연결 작업오더에서 라이브 역조회(스냅샷·마이그레이션 불필요, 기발행분도 즉시 정확).
    //   상품 페이지 열기 버튼을 '링크유입'일 때만 노출하기 위한 신호. 실패는 '' 폴백(fail-soft).
    const inflowType = await _lookupInflowType(camp.id, camp.source_work_order_id);

    // 상품옵션(참여 후 공개): 옵션 목록(금액 포함) + 내가 고른 옵션 + 변경 가능 여부
    let options = [], selectedOption = null;
    {
      const _sm = await deriveSchedules(pool, tabsOfCampaigns([camp]), now);
      const st = computeCampaignState(camp, (await fetchCampaignCounts(pool, [id], now)).get(id), now, scheduleFor(_sm, camp));
      options = await _loadOptionViews(pool, id, st, now);
      if (app.option_key) selectedOption = options.find(o => o.optKey === app.option_key) || { optKey: app.option_key, status: 'open' };
    }
    // 옵션 변경은 유효 홀드(미제출) + 옵션 2개 이상일 때만 허용
    const canChangeOption = validHold && options.length >= 2;

    res.json({
      ok: true,
      serverNow: now.toISOString(),
      application: {
        id: app.id,
        status: app.status,
        appliedAt: app.applied_at,
        expiresAt: app.expires_at,
        submittedAt: app.submitted_at,
        optionKey: app.option_key || null,
      },
      options,               // [{ optKey, payAmount, remaining, todayRemaining, status, selectable, ... }]
      selectedOption,        // 내가 참여한 옵션(잠금표시·구매양식 고정용)
      canChangeOption,
      workDetail: sanitizeWorkDetail(camp.work_detail),          // HTML은 응답 직전 방어적 재정화
      inflowType,                                                 // 'guide' | 'link' | '' — 랜딩 버튼 게이트
      cashReceipt: await _cashReceiptInfo(camp),                  // 현영 탭만 {required, businessNo, guideImageUrl} — 아니면 null
      // 카톡 팀채팅방 URL은 제출확정 후에만 반환(화면 숨김을 API에서도 강제 — DevTools 우회 차단)
      chatUrl: isSubmitted ? (camp.chat_url || '') : '',
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

// POST /api/campaign/:id/change-option — 구매(제출) 전 옵션 변경 (phone8+holdToken 이중 열쇠, 061)
//   ★ 잠금 계층 = apply와 동일(recruit_campaigns 행 FOR UPDATE → 신청 행) → 소진 경합/교착 없음.
//   ★ 만료시각(expires_at)은 연장하지 않음(자리 갈아타기 악용 방지, PRD §07). 새 옵션 자리 확보 실패 시 기존 유지.
router.post('/:id/change-option', applyLimiter, async (req, res, next) => {
  const { id } = req.params;
  const p8 = String(req.body.phone8 || '').replace(/\D/g, '').slice(-8);
  const token = String(req.body.holdToken || '').trim();
  const newKey = _normOptKey(req.body.optionKey);
  if (p8.length !== 8 || !token) return res.status(400).json({ ok: false, error: 'phone8(8자리)과 holdToken이 필요합니다.' });
  if (!newKey) return res.status(400).json({ ok: false, error: '변경할 옵션을 선택해주세요.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cRows.length || !cRows[0].participation_mode) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }
    const camp = cRows[0];
    const now = new Date();

    // 내 유효 홀드(applied·미만료) 확인 — 제출완료면 변경 불가(관리자 정정 대상)
    const { rows: apps } = await client.query(
      `SELECT id, status, expires_at, option_key FROM campaign_applications
        WHERE campaign_id=$1 AND phone8=$2 AND hold_token=$3 AND hold_token<>'' ORDER BY applied_at DESC LIMIT 1 FOR UPDATE`,
      [id, p8, token]);
    if (!apps.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '참여 내역이 없습니다.' }); }
    const app = apps[0];
    if (app.status !== 'applied' || !app.expires_at || new Date(app.expires_at) <= now) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: 'not_changeable', error: '지금은 옵션을 변경할 수 없어요(제출 완료 또는 만료).' });
    }
    if (app.option_key === newKey) { await client.query('COMMIT'); return res.json({ ok: true, optionKey: newKey, unchanged: true }); }

    // 새 옵션: 활성 + 잔여/오늘 확인 (전환 대상은 자기 홀드를 포함하지 않음 = 기존 옵션에 계수돼 있음 → 순증 판정 정확)
    const { rows: optRows } = await client.query(
      `SELECT opt_key, pay_amount, recruit_total, daily_limit, status FROM campaign_options WHERE campaign_id=$1 AND opt_key=$2 LIMIT 1`,
      [id, newKey]);
    if (!optRows.length || optRows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, reason: 'option_invalid', error: '선택한 옵션을 찾을 수 없어요.' });
    }
    const st = computeCampaignState(camp, (await fetchCampaignCounts(client, [id], now)).get(id), now);
    const optCounts = await fetchOptionCounts(client, id, now);
    const ov = computeOptionView(optRows[0], optCounts.get(newKey), { state: 'open' }); // 변경은 캠페인 open 무관(이미 참여중)
    if (ov.status !== 'open') {
      await client.query('ROLLBACK');
      const reason = ov.status === 'soldout' ? 'option_soldout' : (ov.status === 'today_done' ? 'option_today_done' : 'option_closed');
      return res.status(409).json({ ok: false, reason, option: _publicOptionView(ov), error: '선택한 옵션은 마감되었어요. 다른 옵션을 선택해주세요.' });
    }

    // 원자 전환: 여전히 내 유효 홀드일 때만(경합 시 0행 → 기존 유지)
    const upd = await client.query(
      `UPDATE campaign_applications SET option_key=$4
        WHERE id=$1 AND campaign_id=$2 AND hold_token=$3 AND status='applied' AND expires_at > NOW()
        RETURNING id`,
      [app.id, id, token, newKey]);
    if (!upd.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, reason: 'not_changeable', error: '옵션 변경에 실패했어요. 다시 시도해주세요.' }); }
    await client.query('COMMIT');
    logger.info(`[campaign/change-option] camp=${id} app=${app.id} ${app.option_key || '∅'}→${newKey} phone8=***${p8.slice(-4)}`);
    return res.json({ ok: true, optionKey: newKey, previousOptionKey: app.option_key || null, option: ov });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    return next(err);
  } finally {
    client.release();
  }
});

// 참여형(홀드) 신청 — 원자 검사+홀드 생성 (레드-블루-심판 최종 구조)
//   잠금 계층(고정): ① recruit_campaigns 행 FOR UPDATE → ② owner advisory(xact) → ③ 명의 phone8 advisory(xact) → ④ INSERT.
//   주문확정(confirmHoldInTx)·수동확정도 ①을 먼저 잡으므로 write-skew(레드 #3)와 교착이 동시에 제거된다.
//   클래스 순서(캠페인 행 < owner < 명의)가 전역 고정 + tx당 클래스별 1락 = 순환 대기 불가.
// ★ 타계정 추가참여(063, PRD §09): subName/subPhone 존재 = 타계정 명의 참여. 홀드는 계속 "명의 phone8"로
//   키잉(uq_campaign_apps_active_hold 무변경 = §02 명의당 1건), 소유자 귀속은 owner_phone8 신설 컬럼.
async function _applyParticipation(req, res, next, campPre) {
  const id = campPre.id;
  const name = String(req.body.name || '').trim().slice(0, 100);
  const rawPhone = String(req.body.phone || '').trim().slice(0, 40);
  const p8 = rawPhone.replace(/\D/g, '').slice(-8);          // = 로그인 소유자 p8 (기존 의미 유지)
  if (!name) return res.status(400).json({ ok: false, error: '이름을 입력해주세요.' });
  if (p8.length !== 8) return res.status(400).json({ ok: false, error: '연락처를 정확히 입력해주세요.' });

  // ★ 타계정 참여 요청 신호(063): 서버가 소유자의 sub_accounts로 명의를 재검증(임의 명의 위조 차단)
  const subName = String(req.body.subName || '').trim().slice(0, 100);
  const subPhoneRaw = String(req.body.subPhone || '').trim().slice(0, 40);
  const isSubApply = !!(subName || subPhoneRaw);
  const subP8 = subPhoneRaw.replace(/\D/g, '').slice(-8);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ① 캠페인 행 잠금 — 이 캠페인의 모든 신청/확정 쓰기 직렬화(READ COMMITTED write-skew 원천 차단)
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }
    const camp = cRows[0];
    const now = new Date();

    // ★ 타계정 게이트 1(063): 공고 토글(§09-1 기본 불가) + 명의 형식 + 같은번호 배제(phone8=시스템 신원키 보호)
    if (isSubApply) {
      if (camp.multi_account_mode !== true) {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, reason: 'multi_disabled', error: '이 공고는 타계정 참여를 지원하지 않아요.' });
      }
      if (subP8.length !== 8 || !subName) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, reason: 'sub_invalid', error: '타계정 이름과 전화번호를 확인해주세요.' });
      }
      if (subP8 === p8) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, reason: 'sub_shares_owner_phone', error: '본계정과 같은 번호의 타계정은 별도 참여할 수 없어요.' });
      }
    }

    // 명의 신원(홀드 키) = 타계정이면 서브 p8, 아니면 본인 p8 — 이후 모든 명의-키 게이트가 이 값 사용
    const holdP8 = isSubApply ? subP8 : p8;

    // ② owner advisory(xact) — 소유자 합산 상한(§09-2 동시 10건)의 write-skew 차단.
    //   교차 캠페인 동시 apply도 소유자 단위로 직렬화(캠페인 행 락은 캠페인별이라 이 락이 필요).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('camp_hold_owner:' || $1::text))`, [p8]);
    // ③ 명의 phone8 advisory(xact) — 교차 캠페인 명의 홀드 상한의 동시성(항상 owner 락 뒤 = 교착 불가)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('camp_hold_phone:' || $1::text))`, [holdP8]);

    // 잠금 후 신선 재집계 → 상태 게이트(open만 통과; READ COMMITTED 문장별 새 스냅샷이 선행 커밋 반영)
    const countsMap = await fetchCampaignCounts(client, [id], now);
    // ★ 카드 표시와 동일한 일정을 참여 게이트에도 적용(불일치 = 오픈처럼 보이는데 참여 거부 / 그 반대).
    //   1분 캐시라 보통 추가 쿼리 없음. 잠금 커넥션(client)으로 읽어 커넥션 고갈 교착을 피한다.
    const schedMap = await deriveSchedules(client, tabsOfCampaigns([camp]), now);
    const st = computeCampaignState(camp, countsMap.get(id), now, scheduleFor(schedMap, camp));
    if (st.state !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: st.state, state: st, error: '지금은 신청할 수 없습니다.' });
    }

    // ★ 상품옵션 게이트(061): 옵션이 "등록된" 캠페인이면 선택 필수(전부 마감이어도 option_key=NULL 우회 금지, 리뷰 #3).
    //   옵션 미등록 캠페인만 현행 경로(NULL). 캠페인 행 FOR UPDATE 안이라 옵션 카운트도 직렬화 — 소진 경합 없음.
    let chosenOpt = null;
    {
      const { rows: allOpts } = await client.query(
        `SELECT opt_key, pay_amount, recruit_total, daily_limit, status
           FROM campaign_options WHERE campaign_id = $1 ORDER BY (status='closed'), sort_order, id`, [id]);
      if (allOpts.length) {
        const activeOpts = allOpts.filter(o => o.status === 'active');
        if (!activeOpts.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({ ok: false, reason: 'option_unavailable', error: '지금은 선택 가능한 옵션이 없어요(모두 마감).' });
        }
        const wantKey = _normOptKey(req.body.optionKey);
        if (!wantKey) {
          await client.query('ROLLBACK');
          return res.status(400).json({ ok: false, reason: 'option_required', error: '참여할 옵션을 선택해주세요.', options: activeOpts.map(o => o.opt_key) });
        }
        chosenOpt = activeOpts.find(o => o.opt_key === wantKey) || null;
        if (!chosenOpt) {
          await client.query('ROLLBACK');
          return res.status(400).json({ ok: false, reason: 'option_invalid', error: '선택한 옵션을 찾을 수 없어요. 새로고침 후 다시 선택해주세요.' });
        }
        const optCounts = await fetchOptionCounts(client, id, now);
        const ov = computeOptionView(chosenOpt, optCounts.get(chosenOpt.opt_key), st);
        if (ov.status !== 'open') {
          await client.query('ROLLBACK');
          const reason = ov.status === 'soldout' ? 'option_soldout' : (ov.status === 'today_done' ? 'option_today_done' : 'option_closed');
          return res.status(409).json({ ok: false, reason, option: _publicOptionView(ov), error: '선택한 옵션은 마감되었어요. 다른 옵션을 선택해주세요.' });
        }
      }
    }

    // 등록 리뷰어만(레드 #12) — 조회 대상은 항상 "소유자"(로그인 p8). ★ 063: sub_accounts 동봉(명의 검증용)
    const reg = await client.query(
      `SELECT name, phone, phone8, address, bank_name, bank_account, account_holder, sub_accounts
         FROM reviewers WHERE phone8 = $1 LIMIT 1`, [p8]);
    if (!reg.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ ok: false, reason: 'not_registered', error: '리뷰어 등록 후 참여할 수 있어요.' });
    }

    // ★ M2 변경①: 내정보 완비 게이트를 "참여 시점"으로 전진 — 구매양식 신원게이트(#272)가 제출 순간
    //   차단하면 리뷰어는 이미 결제 후 15분 홀드 안에서 막힌다(돈 쓴 뒤 좌절 + 당일 재참여 불가).
    //   여기서 미리 막으면 홀드 미생성 = 자리 미점유 = 당일 참여권 무손실. 제출 단계 검사는 안전망으로 유지.
    //   ★ 063: 판정 기준은 항상 "소유자"(타계정 프로필은 제출측 SUB 자동보강이 담당, §02 신원확인 재사용)
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

    // ★ 타계정 게이트 2(063): 명의가 소유자의 sub_accounts에 정확일치(이름+phone8)해야 함 — 서버 검증
    let subEntry = null;
    if (isSubApply) {
      const { findSubAccount } = require('../services/identity.service');
      const hit = findSubAccount(reg.rows[0].sub_accounts, subName, subP8);
      if (!hit) {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, reason: 'sub_not_registered',
          error: '등록된 타계정이 아니에요. 내정보 > 타계정에서 먼저 등록해주세요.' });
      }
      subEntry = hit.sub;

      // ★★ 방어 D1(사칭 차단): sub_accounts 는 "소유 증명"이 아니다 — 무인증
      //   POST /api/reviewer/profile{action:'saveSubAccounts'} 가 phone8 만 알면 배열을 통째로 덮어쓴다
      //   (번호 소유 증명 없음). 그래서 "이미 리뷰어로 직접 등록된 번호"는 타인의 명의로 못 쓰게 한다.
      //   ─ 피해자 = 자기 계정으로 참여하는 실존 리뷰어이므로 이 한 줄이 강탈 대상 전체를 덮는다.
      //   ─ 정당 사용자 손실 0: 그 번호의 본인이 자기 계정으로 직접 참여하면 된다.
      //   ─ reviewers.phone8 은 phone 파생 GENERATED 컬럼이고 유니크는 UNIQUE(phone)(원문)뿐 →
      //     같은 phone8 행이 복수 존재 가능하므로 행 동일성이 아니라 EXISTS 로 판정(idx_reviewers_phone8).
      //   ─ 완화: CAMPAIGN_SUB_REGISTERED_POLICY = block(기본) | warn(로그만) | allow(검사 자체 생략)
      const _subPolicy = String(process.env.CAMPAIGN_SUB_REGISTERED_POLICY || 'block').toLowerCase();
      if (_subPolicy !== 'allow') {
        const { rows: regHit } = await client.query(
          'SELECT 1 FROM reviewers WHERE phone8 = $1 LIMIT 1', [subP8]);
        if (regHit.length) {
          logger.warn(`[campaign/apply] 등록번호 명의 시도 camp=${id} owner=***${p8.slice(-4)} ` +
            `명의=***${subP8.slice(-4)} policy=${_subPolicy}`);
          if (_subPolicy === 'block') {
            await client.query('ROLLBACK');
            return res.status(409).json({ ok: false, reason: 'sub_is_registered_reviewer',
              error: '이 번호는 이미 리뷰어로 직접 등록되어 있어요. 해당 번호의 본인 계정으로 로그인해서 참여해주세요.' });
          }
        }
      }
    }

    const dayStartIso = kstDayStartUtc(now).toISOString();

    // 이력 선검사(23505 대신 명확한 사유, 심판 J8) — ★ 방어 D1b/D5: 종전 done/hist 2쿼리를 1쿼리로 합치고
    //   "차단한 행의 귀속"까지 함께 읽는다(왕복 순증 0).
    //   ① status='submitted' = 영구 1명의 1참여(uq_campaign_apps_active_hold 의미론)
    //   ② applied_at >= 오늘시작 = 당일 재신청 0회(expired/cancelled 포함 전 상태, §03-C · 명의 단위)
    //   ORDER BY 로 submitted 를 당일 이력보다 우선 → 기존 검사 순서·사유 코드 그대로 보존.
    //   신규 사유: blocked_by_other_owner(=남이 이 번호를 명의로 선점 = 사칭/오등록 신호),
    //             same_phone_other_name(=같은번호 다른명의 A안이 phone8 키잉으로 접힌 경우의 원인 설명).
    const holdNameCandidate = isSubApply ? String((subEntry && subEntry.name) || subName).trim() : name;
    const blk = await client.query(
      `SELECT status, applicant_name, owner_phone8
         FROM campaign_applications
        WHERE campaign_id = $1 AND phone8 = $2
          AND (status = 'submitted' OR applied_at >= $3)
        ORDER BY (status = 'submitted') DESC, applied_at DESC
        LIMIT 1`,
      [id, holdP8, dayStartIso]);
    if (blk.rows.length) {
      const b0 = blk.rows[0];
      const blockedByOther = !!b0.owner_phone8 && String(b0.owner_phone8) !== p8;
      await client.query('ROLLBACK');
      if (blockedByOther) {
        logger.warn(`[campaign/apply] 타소유자 선점 차단 camp=${id} 명의=***${holdP8.slice(-4)} ` +
          `선점owner=***${String(b0.owner_phone8).slice(-4)} 요청owner=***${p8.slice(-4)} status=${b0.status}`);
        return res.status(409).json({ ok: false, reason: 'blocked_by_other_owner',
          error: '이 번호는 다른 계정에서 이미 참여 신청했어요. 본인 번호가 맞다면 고객센터로 알려주세요.' });
      }
      if (b0.status === 'submitted') {
        return res.status(409).json({ ok: false, reason: 'already_submitted', error: '이미 참여 완료한 캠페인이에요.' });
      }
      const { normName } = require('../services/identity.service');
      const usedBy = String(b0.applicant_name || '').trim();
      if (normName(usedBy) && normName(usedBy) !== normName(holdNameCandidate)) {
        // ★ 이름 공개는 "요청자가 그 번호에 대한 근거를 가진 경우"로 제한 —
        //   자기참여(그 번호로 로그인) 또는 내 소유로 귀속된 행. 레거시(owner NULL) 행을 타계정 명의로
        //   조회하는 경우엔 이름을 숨긴다(무인증 API로 남의 실명을 캐는 통로 차단).
        const nameSafe = !isSubApply || String(b0.owner_phone8 || '') === p8;
        return res.status(409).json({ ok: false, reason: 'same_phone_other_name',
          usedBy: nameSafe ? usedBy : undefined,
          error: nameSafe
            ? `같은 번호로 등록된 다른 명의(${usedBy})가 오늘 이미 참여했어요. 번호가 같은 명의는 하루 1건만 가능해요.`
            : '같은 번호로 등록된 다른 명의가 오늘 이미 참여했어요. 번호가 같은 명의는 하루 1건만 가능해요.' });
      }
      return res.status(409).json({ ok: false, reason: 'already_today', error: '오늘은 이 캠페인에 이미 참여 이력이 있어요(내일 가능).' });
    }

    // 명의별 전역 상한: 활성홀드 2건 + 당일 신청 총량 — ★ 기존 CAMPAIGN_HOLD_CAP=2 불변(레거시 완화 없음)
    const caps = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'applied' AND expires_at > NOW()) AS active_holds,
              COUNT(*) FILTER (WHERE applied_at >= $2) AS today_applies
         FROM campaign_applications WHERE phone8 = $1`,
      [holdP8, dayStartIso]);
    if (Number(caps.rows[0].active_holds) >= (parseInt(process.env.CAMPAIGN_HOLD_CAP || '2', 10) || 2)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: 'hold_cap', error: '동시에 참여 가능한 캠페인은 2개까지예요.' });
    }
    if (Number(caps.rows[0].today_applies) >= (parseInt(process.env.CAMPAIGN_DAILY_APPLY_CAP || '10', 10) || 10)) {
      await client.query('ROLLBACK');
      return res.status(429).json({ ok: false, reason: 'daily_apply_cap', error: '오늘 신청 가능한 횟수를 넘었어요.' });
    }

    // ★ 소유자 합산 동시홀드 상한(063, §09-2 동시 10건): COALESCE 귀속 — 레거시 NULL 행은 자기 phone8로 귀속
    const ownerCap = parseInt(process.env.CAMPAIGN_OWNER_HOLD_CAP || '10', 10) || 10;
    const own = await client.query(
      `SELECT COUNT(*) AS n FROM campaign_applications
        WHERE COALESCE(owner_phone8, phone8) = $1 AND status = 'applied' AND expires_at > NOW()`, [p8]);
    if (Number(own.rows[0].n) >= ownerCap) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: 'owner_hold_cap',
        error: `본인+타계정 합산 동시 ${ownerCap}건까지만 자리를 잡을 수 있어요.` });
    }

    // ★ 캠페인별 타계정 하루한도(063, §09-5): 상태 무관 집계(already_today 정책과 동일 — 취소 리트라이 파밍 차단)
    if (isSubApply && Number(camp.multi_daily_limit) > 0) {
      const md = await client.query(
        `SELECT COUNT(*) AS n FROM campaign_applications
          WHERE campaign_id = $1 AND owner_phone8 = $2 AND phone8 <> owner_phone8 AND applied_at >= $3`,
        [id, p8, dayStartIso]);
      if (Number(md.rows[0].n) >= Number(camp.multi_daily_limit)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, reason: 'sub_daily_limit',
          error: `타계정 참여는 이 공고에서 하루 ${camp.multi_daily_limit}건까지예요(내일 가능).` });
      }
    }

    // ★ 인기상품 선행참여 게이트(064, 1:1 교환): 명의별로 "일반(비인기) 참여형 제출완료 수 > 인기 소비 수"여야
    //   새 인기 참여 가능. 인기 소비 = 인기 공고의 제출확정 + 유효홀드(시각 기준) — 만료·취소는 자동 환불.
    //   타계정도 명의 단위 판정(타계정 5개 = 각 명의가 일반 1건씩 제출해야 인기 5건, 요구 예시와 동일).
    //   동시성: 같은 명의의 교차 캠페인 apply는 ③ 명의 advisory 락으로 직렬화 — 크레딧 이중소비 불가.
    if (camp.is_popular === true) {
      const cr = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE rc.is_popular IS NOT TRUE AND ca.status = 'submitted') AS normal_done,
           COUNT(*) FILTER (WHERE rc.is_popular IS TRUE AND (ca.status = 'submitted' OR (ca.status = 'applied' AND ca.expires_at > NOW()))) AS popular_used
         FROM campaign_applications ca
         JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
        WHERE ca.phone8 = $1 AND rc.participation_mode`, [holdP8]);
      const normalDone = Number(cr.rows[0].normal_done) || 0;
      const popularUsed = Number(cr.rows[0].popular_used) || 0;
      if (normalDone <= popularUsed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, reason: 'popular_locked', normalDone, popularUsed,
          error: '인기 상품은 일반 모집 1건을 먼저 제출완료해야 참여할 수 있어요. (일반 1건 = 인기 1건)' });
      }
    }

    // 홀드 생성: expires_at = min(now+TTL, 오늘 window_end) — state=open이므로 closesAt는 유효·미래.
    // ★ 자율주문(시간창 미설정)은 closesAt이 null → TTL만 적용. ★ 063 §09-2: 타계정 건 TTL = sub_hold_ttl_min(기본 10분)
    const ttlMin = isSubApply ? (Number(camp.sub_hold_ttl_min) || 10) : (Number(camp.hold_ttl_min) || 15);
    const ttlMs = ttlMin * 60000;
    const closesAt = kstTodayAt(camp.window_end, now);
    const expiresAt = new Date(closesAt ? Math.min(now.getTime() + ttlMs, closesAt.getTime()) : now.getTime() + ttlMs);
    const holdToken = crypto.randomBytes(24).toString('base64url');
    // 명의 표기값은 서버 권위(등록된 sub_accounts 값 우선 — 요청 오타로 홀드/신원판별 표기가 갈라지는 것 방지)
    const insName = isSubApply ? String((subEntry && subEntry.name) || subName).trim() : name;
    const insPhone = isSubApply ? String((subEntry && subEntry.phone) || subPhoneRaw) : rawPhone;
    const ins = await client.query(
      `INSERT INTO campaign_applications
         (campaign_id, applicant_name, applicant_phone, phone8, owner_phone8, status, expires_at, hold_token, option_key)
       VALUES ($1,$2,$3,$4,$5,'applied',$6,$7,$8)
       RETURNING id, expires_at, option_key`,
      [id, insName, insPhone, holdP8, p8, expiresAt.toISOString(), holdToken, chosenOpt ? chosenOpt.opt_key : null]);
    await client.query('COMMIT');
    logger.info(`[campaign/apply] 홀드 생성 camp=${id} app=${ins.rows[0].id} phone8=***${holdP8.slice(-4)}` +
      (isSubApply ? ` sub(owner=***${p8.slice(-4)})` : '') + (chosenOpt ? ' opt=' + chosenOpt.opt_key : ''));
    return res.json({
      ok: true, applicationId: ins.rows[0].id, holdToken,
      phone8: holdP8,   // ★ 계약(레드 #4): 응답 phone8 = "명의" p8 — 프론트 h.phone8 → work-detail/cancel/change-option/embed holdPhone8 전 경로 무수정 정합
      ownerPhone8: p8,  // 소유자(요청자 자신 — 유출 아님). 2단계 명의 배지·복원용
      participant: { type: isSubApply ? 'sub' : 'self', name: insName },
      expiresAt: ins.rows[0].expires_at, serverNow: now.toISOString(),
      optionKey: ins.rows[0].option_key || null,
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
/**
 * 관리자 카드에만 필요한 운영 집계 — **지각 접수(late) 건수**.
 *   late_order_id = 홀드 만료/취소 뒤에 주문이 도착한 건. 리뷰어는 이미 결제했는데 자리가 없는 상태라
 *   수동확정(POST /admin/:id/confirm)이 유일한 구제 경로다 → 카드의 빨간 원이 이 수를 가리킨다.
 *   수동확정되면 status가 'submitted'로 바뀌므로 아래 필터에서 자동으로 빠진다(처리 즉시 원 소멸).
 *   ※ 만료·취소 자체는 세지 않는다 — 신청만 하고 구매하지 않은 건이라 자리가 이미 반환돼 할 일이 없다.
 *     매일 숫자가 떠 있으면 정작 급한 지각 건이 묻히므로 의도적으로 제외한다.
 */
async function _fetchLateCounts(pool, campaignIds) {
  const out = new Map();
  const ids = (campaignIds || []).filter(Boolean);
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT campaign_id, COUNT(*) AS late
       FROM campaign_applications
      WHERE campaign_id = ANY($1)
        AND late_order_id IS NOT NULL
        AND status IN ('expired', 'cancelled')
        AND dismissed_at IS NULL
      GROUP BY campaign_id`,
    [ids]
  );
  for (const r of rows) out.set(r.campaign_id, Number(r.late) || 0);
  return out;
}

/**
 * 관리자 목록. 원본 행 전체 + **리뷰어 목록과 동일한 상태 계산**을 함께 내려준다.
 *   관리자 카드가 리뷰어 카드와 같은 컴포넌트로 그려지므로 같은 입력(state/dailyQuota/todayCount/
 *   opensAt/cutoffAt…)이 필요하다. 두 화면이 다른 계산을 쓰면 "카드는 모집중인데 참여는 거부" 같은
 *   불일치가 생기므로 계산 경로를 하나로 묶는다.
 *   ops = 관리자 전용 운영 수치(진행중 홀드·오늘 제출·누적 확정·지각) — 리뷰어 응답엔 없다.
 */
router.get('/admin/list', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const now = new Date();
    const { rows } = await pool.query(`
      SELECT * FROM recruit_campaigns
      ORDER BY
        CASE WHEN status = 'active' THEN 0 WHEN status = 'draft' THEN 1 ELSE 2 END,
        (pinned_at IS NULL), pinned_at ASC,  -- ★ 064: 별표 고정 우선(먼저 별표한 순서대로) — 리뷰어 목록과 동일 규칙
        created_at DESC
    `);
    const partIds = rows.filter(r => r.participation_mode).map(r => r.id);
    // 실패해도 목록 자체는 떠야 한다(관리 기능 마비 방지) — 집계만 비우고 진행.
    let countsMap = new Map(), schedMap = null, lateMap = new Map();
    try {
      [countsMap, schedMap, lateMap] = await Promise.all([
        fetchCampaignCounts(pool, partIds, now),
        deriveSchedules(pool, tabsOfCampaigns(rows), now),
        _fetchLateCounts(pool, partIds),
      ]);
    } catch (e) {
      logger.warn(`[campaign] admin/list 집계 실패 — 목록만 반환: ${e.message}`);
    }
    const data = rows.map(r => {
      if (!r.participation_mode) return { ...r };
      const cnt = countsMap.get(r.id) || {
        activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0,
      };
      const st = computeCampaignState(r, cnt, now, schedMap ? scheduleFor(schedMap, r) : null);
      return {
        ...r,
        state: st.state, stateReason: st.stateReason || null,
        todayCount: st.todayCount, dailyQuota: st.dailyQuota,
        carryAdded: st.carryAdded || 0,   // 066: 전일 미달분 이월로 오늘 더 열린 수(관리자 표시용)
        opensAt: st.opensAt, closesAt: st.closesAt, cutoffAt: st.cutoffAt,
        allDay: st.allDay === true,
        startDate: st.startDate || null,
        endDate: st.endDate || null,
        nextWorkDate: st.nextWorkDate || null,
        reopensAt: st.reopensAt || null,
        ops: {
          holdNow: cnt.activeHolds,
          todayHold: cnt.todayActiveHolds,
          todaySubmitted: cnt.todaySubmitted,
          totalConfirmed: cnt.submittedAll,
          late: lateMap.get(r.id) || 0,
        },
      };
    });
    res.json({ ok: true, data, serverNow: now.toISOString() });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/admin/:id/flags {pinned?, popular?} — 카드 우측상단 토글(별표 고정·인기, 064)
//   별표 순서: 먼저 별표한 공고가 위(pinned_at ASC) — 이미 별표된 공고에 pinned:true 재전송해도 원래 자리 유지.
//   ★ 스코프 토큰(via:'reviewer_campaign')은 authMiddleware가 PUT /api/campaign/admin/:id 끝앵커로만
//     허용하므로 이 POST에는 도달 불가(약한 신원의 노출순서·게이트 조작 차단).
router.post('/admin/:id/flags', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    if (b.pinned === undefined && b.popular === undefined) {
      return res.status(400).json({ ok: false, error: 'pinned 또는 popular 값이 필요합니다.' });
    }
    const { rows } = await pool.query(
      `UPDATE recruit_campaigns SET
         pinned_at = CASE WHEN $2::boolean IS NULL THEN pinned_at
                          WHEN $2::boolean THEN COALESCE(pinned_at, NOW())
                          ELSE NULL END,
         is_popular = COALESCE($3::boolean, is_popular),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, pinned_at, is_popular`,
      [id,
       b.pinned === undefined ? null : b.pinned === true,
       b.popular === undefined ? null : b.popular === true]);
    if (!rows.length) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    // ★ /list 5초 캐시 즉시 무효화 — 토글 직후 재조회가 옛 순서를 돌려주지 않게(리뷰어 홈 별표 UX)
    _listCache = { at: 0, rows: null, countsMap: null };
    res.json({ ok: true, pinnedAt: rows[0].pinned_at, isPopular: rows[0].is_popular });
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
      start_date, // ★ 062: 시작일(YYYY-MM-DD) — 시작일 전 게시 시 오픈예정 카운트다운
      multi_account_mode, multi_daily_limit, sub_hold_ttl_min, // ★ 063: 타계정 추가참여(§09-1·5·2)
      options, // ★ 061: 상품옵션 목록(참여형)
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ ok: false, error: '공고 제목을 입력해주세요.' });
    }
    if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(start_date))) {
      return res.status(400).json({ ok: false, error: '시작일 형식이 올바르지 않습니다. (YYYY-MM-DD)' });
    }

    // ★ 연결 탭 자동 보정 — 폼에서 못 골랐어도 작업오더의 작업시트탭으로 채운다(빈 값일 때만).
    //   게이트 판정 **전에** 채워야 "탭 미연결"로 게시가 막히는 것을 실제로 막을 수 있다.
    let lSheet = linked_sheet_id, lTab = linked_tab_name, lGid = linked_tab_gid;
    if (!lSheet || !lTab) {
      const wo = await _linkedTabFromWorkOrder(source_work_order_id);
      if (wo) {
        lSheet = lSheet || wo.sheetId; lTab = lTab || wo.tabName; lGid = lGid || wo.tabGid;
        logger.info(`[campaign] 연결탭 자동 보정(생성): wo=${source_work_order_id} → ${wo.tabName}`);
      }
    }

    // 참여형을 active로 "생성"하는 것도 활성화 게이트 통과 필요(status 라우트 우회 방지)
    if (participation_mode && (status === 'active')) {
      const errs = _participationActivationErrors({
        linked_sheet_id: lSheet, linked_tab_gid: lGid, window_start, window_end, daily_limit,
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
        window_start, window_end, close_buffer_min, hold_ttl_min, work_detail, source_work_order_id,
        start_date, multi_account_mode, multi_daily_limit, sub_hold_ttl_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
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
        lSheet || '',
        lTab || '',
        lGid || '',
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
        start_date || null,
        multi_account_mode === true,                            // ★ 063 §09-1: 기본 [불가]
        Math.max(0, Number(multi_daily_limit) || 0),            // ★ 063 §09-5: 0=무제한
        (sub_hold_ttl_min === undefined || sub_hold_ttl_min === null || sub_hold_ttl_min === '')
          ? 10 : Math.max(1, Number(sub_hold_ttl_min) || 10),   // ★ 063 §09-2: 타계정 10분(≥1 클램프 — 0=즉시만료 footgun 차단)
      ]
    );
    // ★ 061: 상품옵션 저장(제공 시). 원자 저장(캠페인 락) — 실패 시 응답에 경고 표면화(조용한 정원 오염 방지, 레드 #7).
    const normOpts = _normalizeOptionsInput(options);
    let optionsWarning = null;
    if (normOpts) { try { await _saveCampaignOptions(rows[0].id, normOpts); } catch (e) { optionsWarning = '옵션 저장 실패: ' + e.message; logger.warn('[campaign/create] ' + optionsWarning); } }
    res.json({ ok: true, data: rows[0], options: await _loadOptionsRaw(pool, rows[0].id), ...(optionsWarning ? { optionsWarning } : {}) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/campaign/admin/:id — 캠페인 수정
router.put('/admin/:id', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    // ★ 리뷰어앱 공고수정 스코프 토큰은 전용 화이트리스트 핸들러로 격리(레드팀 #2/#3/#6)
    //   ★ 옵션(정원·금액) 편집도 이 조기 반환으로 차단됨 — _scopedCampaignEdit는 options를 읽지 않는다
    //     (레드 #4 검토: 약한 신원 리뷰어앱 토큰이 옵션 정원/지급액을 변조하는 파괴표면 차단).
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
      start_date, // ★ 062: undefined/null=유지, ''=시작일 제거, 'YYYY-MM-DD'=설정
      // ★ 063: 타계정 추가참여(전부 optional — 미전달 시 COALESCE로 기존값 유지).
      //   ※ 아래 UPDATE의 $33~$35가 이 이름들을 참조하므로 구조분해 누락 = 수정 저장 전면 ReferenceError(500).
      multi_account_mode, multi_daily_limit, sub_hold_ttl_min,
      options, // ★ 061: 상품옵션 목록(배열 전달 시에만 교체, 미전달=변경 없음)
    } = req.body;

    if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(start_date))) {
      return res.status(400).json({ ok: false, error: '시작일 형식이 올바르지 않습니다. (YYYY-MM-DD)' });
    }

    // ★ 062: 시간창 유효값 — ''=비움(자율주문 전환), null/undefined=유지, 'HH:MM'=설정.
    //   auto_order=true(카드 인라인 편집기)는 강제 비움 — 종전엔 스코프 라우트만 해석해
    //   관리자 토큰의 인라인 자율주문 전환이 조용히 무시되던 갭 봉합.
    const _wsEff = (req.body.auto_order === true) ? '' : window_start;
    const _weEff = (req.body.auto_order === true) ? '' : window_end;

    // ★ 연결 탭 자동 보정(수정) — 이미 저장된 공고가 "시트 탭 미연결"이면 작업오더 값으로 채운다.
    //   공고를 열어 저장하기만 하면 복구되는 경로(관리자가 탭을 직접 고르면 그 값이 우선).
    //   ★ 비어 있을 때만 — 본문에 값이 있거나 DB에 이미 연결돼 있으면 건드리지 않는다.
    let lSheet = linked_sheet_id, lTab = linked_tab_name, lGid = linked_tab_gid;
    if (!lSheet || !lTab) {
      try {
        const { rows: cur0 } = await pool.query(
          'SELECT linked_sheet_id, linked_tab_name, linked_tab_gid, source_work_order_id FROM recruit_campaigns WHERE id = $1',
          [id]
        );
        const c0 = cur0[0];
        if (c0 && !c0.linked_sheet_id && !c0.linked_tab_name) {
          // 정방향 링크가 없으면 역방향(work_orders.linked_campaign_id)으로도 찾는다 —
          // 옛 경로로 만든 공고는 source_work_order_id 가 비어 있을 수 있다.
          let woId = source_work_order_id || c0.source_work_order_id || '';
          if (!woId) {
            const { rows: back } = await pool.query(
              `SELECT id FROM work_orders
                WHERE linked_campaign_id = $1 AND deleted_at IS NULL
                ORDER BY created_at ASC LIMIT 1`, [id]
            );
            woId = back[0]?.id || '';
          }
          const wo = await _linkedTabFromWorkOrder(woId);
          if (wo) {
            lSheet = lSheet || wo.sheetId; lTab = lTab || wo.tabName; lGid = lGid || wo.tabGid;
            logger.info(`[campaign] 연결탭 자동 보정(수정): camp=${id} → ${wo.tabName}`);
          }
        }
      } catch (e) {
        logger.warn(`[campaign] 연결탭 보정 조회 실패(무시): ${e.message}`);
      }
    }

    // ★ 참여형 활성화 게이트(심판 J7): COALESCE 편집으로 status='active' 우회 방지.
    //   이 라우트가 바꿀 수 있는 게이트 입력(연결탭·시간창·일일건수)을 본문값으로 병합해 판정.
    if (status === 'active') {
      const { rows: cur } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
      if (cur.length && (cur[0].participation_mode || participation_mode === true)) {
        const pick = (v, curV) => (v === undefined || v === null) ? curV : v;
        const eff = {
          ...cur[0],
          linked_sheet_id: pick(lSheet, cur[0].linked_sheet_id),   // ★ 자동 보정값 반영
          linked_tab_gid: pick(lGid, cur[0].linked_tab_gid),
          window_start: pick(_wsEff, cur[0].window_start),
          window_end: pick(_weEff, cur[0].window_end),
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
        window_start = CASE WHEN $25::text IS NULL THEN window_start
                            WHEN $25::text = '' THEN NULL
                            ELSE $25::time END,
        window_end = CASE WHEN $26::text IS NULL THEN window_end
                          WHEN $26::text = '' THEN NULL
                          ELSE $26::time END,
        close_buffer_min = COALESCE($27, close_buffer_min),
        hold_ttl_min = COALESCE($28, hold_ttl_min),
        work_detail = CASE WHEN $29::boolean THEN $30::jsonb ELSE work_detail END,
        source_work_order_id = COALESCE($31, source_work_order_id),
        start_date = CASE WHEN $32::text IS NULL THEN start_date
                          WHEN $32::text = '' THEN NULL
                          ELSE $32::date END,
        multi_account_mode = COALESCE($33, multi_account_mode),
        multi_daily_limit = COALESCE($34, multi_daily_limit),
        sub_hold_ttl_min = COALESCE($35, sub_hold_ttl_min),
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
        lSheet, lTab, lGid,   // ★ 자동 보정값(빈 값이면 COALESCE로 기존값 유지 — 종전과 동일)
        (participation_mode === undefined || participation_mode === null) ? null : participation_mode === true,
        thumbnail_url ?? null,
        landing_url ?? null,
        (daily_limit === undefined || daily_limit === null || daily_limit === '') ? null : Number(daily_limit) || 0,
        (recruit_total === undefined || recruit_total === null || recruit_total === '') ? null : Number(recruit_total) || 0,
        // ★ 062: ''=시간창 비움(자율주문 전환), null/undefined=유지 — 구 COALESCE는 비움 불가였음
        (_wsEff === undefined || _wsEff === null) ? null : String(_wsEff),
        (_weEff === undefined || _weEff === null) ? null : String(_weEff),
        (close_buffer_min === undefined || close_buffer_min === null || close_buffer_min === '') ? null : Number(close_buffer_min),
        (hold_ttl_min === undefined || hold_ttl_min === null || hold_ttl_min === '') ? null : Number(hold_ttl_min),
        wdPrepared !== undefined,          // $29: work_detail 교체 여부(undefined=유지)
        wdPrepared === undefined ? null : wdPrepared, // $30: 새 값(null=비움)
        source_work_order_id ?? null,
        (start_date === undefined || start_date === null) ? null : String(start_date), // $32: null=유지, ''=제거, 날짜=설정
        (multi_account_mode === undefined || multi_account_mode === null) ? null : multi_account_mode === true, // $33 ★ 063: null=유지
        (multi_daily_limit === undefined || multi_daily_limit === null || multi_daily_limit === '') ? null : Math.max(0, Number(multi_daily_limit) || 0), // $34
        (sub_hold_ttl_min === undefined || sub_hold_ttl_min === null || sub_hold_ttl_min === '') ? null : Math.max(1, Number(sub_hold_ttl_min) || 10), // $35
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    // ★ 061: 상품옵션 교체(배열 전달 시에만). 원자 저장(캠페인 락), 참여자 있는 옵션은 삭제 대신 closed(기록 보호).
    const normOpts = _normalizeOptionsInput(options);
    let optionsWarning = null;
    if (normOpts) { try { await _saveCampaignOptions(id, normOpts); } catch (e) { optionsWarning = '옵션 저장 실패: ' + e.message; logger.warn('[campaign/update] ' + optionsWarning); } }
    res.json({ ok: true, data: rows[0], options: await _loadOptionsRaw(pool, id), ...(optionsWarning ? { optionsWarning } : {}) });
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
              order_submission_id, late_order_id, option_key, owner_phone8, dismissed_at
       FROM campaign_applications
       WHERE campaign_id = $1
       ORDER BY applied_at ASC`,
      [id]
    );
    // 🧩 옵션별 현황(061 3단계 관제): 옵션 뷰(정원·잔여·상태) + 금액 포함(관리자 전용)
    let options = [];
    try {
      const { rows: camps } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
      if (camps.length && camps[0].participation_mode) {
        const now = new Date();
        const _sm = await deriveSchedules(pool, tabsOfCampaigns([camps[0]]), now);
        const st = computeCampaignState(camps[0], (await fetchCampaignCounts(pool, [id], now)).get(id), now, scheduleFor(_sm, camps[0]));
        options = await _loadOptionViews(pool, id, st, now);
      }
    } catch (optErr) { logger.warn('[campaign/admin/applications] 옵션 집계 실패: ' + optErr.message); }

    // 📋 시트 대조(관제 진단) — "시트엔 100행인데 확정은 99" 같은 누락을 그 자리에서 보이게.
    //   ★ 읽기 전용·fail-soft. 상태 계산·참여 흐름에 일절 영향 없음(관제 창에서만 호출).
    let sheetInfo = null;
    try {
      const { rows: cs } = await pool.query(
        `SELECT linked_sheet_id, linked_tab_name, linked_tab_gid FROM recruit_campaigns WHERE id = $1`, [id]
      );
      const c0 = cs[0];
      if (c0 && c0.linked_sheet_id && c0.linked_tab_name) {
        // 로스터 = 인덱스에 잡힌 행(이름이 있는 행). 시트의 실제 참여자 자리 수와 같다.
        const { rows: ri } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM review_index WHERE sheet_id = $1 AND tab_name = $2`,
          [c0.linked_sheet_id, c0.linked_tab_name]
        );
        const confirmed = rows.filter(r => r.status === 'submitted').length;
        const rosterRows = Number(ri[0]?.n) || 0;
        // ★ 차이가 있을 때만 "어느 행이 확정에 없는지"를 찾는다(평상시 쿼리 0).
        //   대조 키 = phone8(연락처 끝 8자리). 시스템의 신원키와 같아야 오탐이 없다.
        let unmatched = [];
        if (rosterRows > confirmed) {
          const { rows: um } = await pool.query(
            `SELECT ri.row_index AS row, ri.reviewer_name AS name, ri.phone8
               FROM review_index ri
              WHERE ri.sheet_id = $1 AND ri.tab_name = $2
                AND NOT EXISTS (
                  SELECT 1 FROM campaign_applications ca
                   WHERE ca.campaign_id = $3 AND ca.status = 'submitted'
                     AND ca.phone8 <> '' AND ca.phone8 = ri.phone8
                )
              ORDER BY ri.row_index
              LIMIT 30`,
            [c0.linked_sheet_id, c0.linked_tab_name, id]
          );
          unmatched = um.map(r => ({
            row: r.row, name: r.name || '',
            phone4: String(r.phone8 || '').replace(/\D/g, '').slice(-4),
            noPhone: !String(r.phone8 || '').trim(),
          }));
        }
        sheetInfo = {
          tabName: c0.linked_tab_name,
          rosterRows,
          confirmed,
          diff: rosterRows > 0 ? rosterRows - confirmed : null,
          unmatched,
          schedule: await describeTabDates(pool, c0.linked_sheet_id, c0.linked_tab_gid, new Date()),
        };
      }
    } catch (siErr) { logger.warn('[campaign/admin/applications] 시트 대조 실패: ' + siErr.message); }

    res.json({ ok: true, data: rows, count: rows.length, options, sheetInfo });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/admin/:id/preview — 관리자: 리뷰어 참여 화면 미리보기 (읽기 전용)
//   ★ 격리 원칙: 무인증 리뷰어 경로 `GET /:id/work-detail` 은 **일절 미변경**. 관리자 전용 별도 라우트로
//     같은 shape을 합성해 돌려준다(리뷰어 게이트에 관리자 분기를 심지 않음 = 폭발반경 0).
//   ★ 부작용 0: campaign_applications INSERT/UPDATE 없음 — 홀드·정원·일일한도 카운터 무오염.
//     application 은 화면 렌더용 **가짜 객체**(id:'preview')이며 DB에 존재하지 않는다.
//   ★ 마감(closed)·오픈전 공고도 열람 가능(관리자가 진행 화면을 확인하는 것이 목적).
//   ★ 접근 제어: authMiddleware + adminOrMaster. 리뷰어앱 스코프 토큰(via:'reviewer_campaign')은
//     PUT /api/campaign/admin/:id 끝앵커로만 허용되므로 이 경로(GET + /preview 하위)엔 도달 불가.
router.get('/admin/:id/preview', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: camps } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
    if (camps.length === 0) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    const camp = camps[0];
    if (!camp.participation_mode) {
      return res.status(400).json({ ok: false, error: '참여형 공고가 아닙니다. (리뷰어 참여 화면이 없는 공고)' });
    }

    const now = new Date();
    const st = computeCampaignState(camp, (await fetchCampaignCounts(pool, [id], now)).get(id), now);
    const options = await _loadOptionViews(pool, id, st, now);
    // 미리보기용 대표 옵션 — 선택 가능한 첫 옵션(없으면 첫 옵션). 실제 선택이 아니라 화면 예시.
    const sample = options.find(o => o.selectable) || options[0] || null;
    const inflowType = await _lookupInflowType(camp.id, camp.source_work_order_id);
    const ttlMin = Number(camp.hold_ttl_min) || 15;

    res.json({
      ok: true,
      preview: true,                        // 프론트 배너·가드의 단일 신호
      serverNow: now.toISOString(),
      state: st.state,                      // 실제 캠페인 상태(마감/오픈전 등 — 배너에 표기)
      application: {                        // ★ 가짜(미저장) — 화면 렌더 전용
        id: 'preview',
        status: 'applied',
        appliedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMin * 60000).toISOString(),
        submittedAt: null,
        optionKey: sample ? sample.optKey : null,
      },
      options,
      selectedOption: sample,
      canChangeOption: false,               // 미리보기에서는 옵션 변경 불가(서버 상태 무변경)
      workDetail: sanitizeWorkDetail(camp.work_detail),
      inflowType,
      cashReceipt: await _cashReceiptInfo(camp),   // 미리보기 = 실제 화면(현영 안내 카드 포함)
      chatUrl: camp.chat_url || '',         // 관리자는 원래 카톡 URL을 설정·조회하는 주체
      landingUrl: camp.landing_url || '',
      form: {
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
              dismissed_at = NULL,
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

// POST /api/campaign/admin/:id/dismiss {applicationId} — 취소확정(미참여) (admin/master)
//   만료·취소된 참여를 관리자가 "미참여로 취소 확정" → dismissed_at 기록.
//   이후 관제 수동확정 버튼·지각(late) 빨간 배지·만료 집계에서 제외돼 "다시 알림이 뜨지 않는다".
//   ★ 이미 자리를 반환한 종료 상태(expired/cancelled)에만 붙는 마커라 quota/유효홀드 불변.
//     order_submissions·시트는 건드리지 않는다(주문 취소는 별도 [주문취소] 경로).
//   잠금 계층은 confirm과 동일: 캠페인 행 FOR UPDATE → 신청 행 FOR UPDATE(동일행 confirm↔dismiss 직렬화).
router.post('/admin/:id/dismiss', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  const { id } = req.params;
  const appId = parseInt(req.body.applicationId, 10);
  if (!appId) return res.status(400).json({ ok: false, error: 'applicationId 필수' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cRows } = await client.query('SELECT id, participation_mode FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }
    if (!cRows[0].participation_mode) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, error: '참여형 공고가 아닙니다.' }); }
    const { rows: t } = await client.query(
      `SELECT id, status, dismissed_at FROM campaign_applications WHERE id = $1 AND campaign_id = $2 FOR UPDATE`, [appId, id]);
    if (!t.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '신청을 찾을 수 없습니다.' }); }
    const a = t[0];
    if (a.dismissed_at) { await client.query('ROLLBACK'); return res.json({ ok: true, already: true }); } // 멱등
    if (a.status === 'submitted') {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: '이미 제출확정된 참여입니다(취소는 [주문취소]로 처리하세요).' });
    }
    if (!['expired', 'cancelled'].includes(a.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: `'${a.status}' 상태는 취소확정 대상이 아닙니다(만료·취소 건만).` });
    }
    // status='cancelled'로 통일 + dismissed_at 기록. quota/유효홀드 불변(종료 상태 마커).
    await client.query(
      `UPDATE campaign_applications SET status = 'cancelled', dismissed_at = NOW() WHERE id = $1`, [appId]);
    await client.query('COMMIT');
    logger.info(`[campaign/dismiss] 취소확정 camp=${id} app=${appId} by=${req.admin && req.admin.name}`);
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
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
