/**
 * campaignPublicListFields.test.js — 결정 431 회귀가드(모집안내 점검 M6)
 * 실행: node tests/campaignPublicListFields.test.js
 *
 * 로그인 없이 누구나 받는 공고 목록(GET /api/campaign/list)과 공고 상세(GET /api/campaign/:id)는
 * 같은 공개 뷰(_publicView · PUBLIC_FIELDS_LEGACY / PUBLIC_FIELDS_PARTICIPATION)를 쓴다.
 * 그 응답에 내부 칸이 실리면 안 된다:
 *   - 참여형: manager(담당 칸) — 참여형 카드·공고 화면은 이 칸을 그리지 않는다(소비처 0).
 *   - 옛 방식(참여형 아님): description(내부 설명) · linked_sheet_id(구글 시트 고유번호) ·
 *     linked_tab_name(작업 탭 이름) — 리뷰어 화면 소비처 0.
 * 직원(관리자 JWT) 상세·관리자 목록은 종전 그대로 전체 행을 받아야 한다.
 *
 * → 실제 라우터를 HTTP 로 두드린다(DB 는 스텁). 공개 응답의 칸 목록이 **정확히** 허용 목록과
 *   같은지 본다 — 새 칸을 공개 응답에 더하려면 이 목록을 함께 고쳐야 한다(의식적 결정).
 */
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:***@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'campaign-public-list-fields-secret';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

/* 응답 어디에도 나오면 안 되는 내부 값 */
const SECRET = {
  partManager: '박은비실명',
  sheetId: '1LegacySheetIdSECRET',
  tabName: '[레거시] 업체A 내부탭',
  description: '내부설명-직원만',
  partSheetId: '1PartSheetIdSECRET',
  partTabName: '참여형 내부탭',
  workDetail: '작업내용비밀',
};

const BASE = {
  status: 'active', archived_at: null, reviewer_hidden: false, created_at: '2026-11-01T00:00:00Z',
  channel: '네이버', channel_custom: '', time_range: '10:00~18:00', delivery_type: '실배송',
  review_fee: 3000, badges: '[]', sort_order: 0, deadline: null, is_popular: false,
  work_kind: 'review', carry_strategy: null, linked_tab_gid: '',
};
const LEGACY = {
  ...BASE, id: 'c-legacy', title: '옛 방식 공고', participation_mode: false,
  manager: '망고', notes: '공개 유의사항', chat_url: 'https://open.kakao.com/o/legacyRoom',
  max_slots: 10, current_slots: 2,
  description: SECRET.description, linked_sheet_id: SECRET.sheetId, linked_tab_name: SECRET.tabName,
  work_detail: { reviewGuide: SECRET.workDetail },
};
const PART = {
  ...BASE, id: 'c-part', title: '참여형 공고', participation_mode: true,
  manager: SECRET.partManager, notes: '', chat_url: '', max_slots: 0, current_slots: 0,
  description: '', linked_sheet_id: SECRET.partSheetId, linked_tab_name: SECRET.partTabName,
  daily_limit: 5, recruit_total: 50, window_start: '10:00:00', window_end: '18:00:00',
  close_buffer_min: 0, hold_ttl_min: 20, start_date: null, multi_account_mode: 'off', sub_hold_ttl_min: 10,
  carry_mode: 'auto', skip_weekends: false, cash_receipt_required: false, soldout_paused_at: null,
  thumbnail_url: '', delivery_review_fee_mix: null,
  work_detail: { reviewGuide: SECRET.workDetail },
};
const CAMPS = [LEGACY, PART];

/* 공개 응답에 허용되는 칸(결정 431) — 행에서 고른 칸 + 서버가 계산해 붙이는 칸 */
const LEGACY_ROW_ALLOW = ['id', 'title', 'channel', 'channel_custom', 'manager', 'time_range',
  'delivery_type', 'review_fee', 'badges', 'notes', 'chat_url', 'status', 'sort_order',
  'max_slots', 'current_slots', 'deadline', 'created_at', 'carry_strategy', 'is_popular', 'work_kind'];
const LEGACY_COMPUTED = ['participation_mode', 'state', 'stateReason', 'stateMessage', 'closedKind', 'resumesOn', 'resumesAt'];
const PART_ROW_ALLOW = ['id', 'title', 'channel', 'channel_custom', 'time_range', 'delivery_type',
  'review_fee', 'delivery_review_fee_mix', 'badges', 'status', 'sort_order', 'thumbnail_url', 'created_at',
  'hold_ttl_min', 'close_buffer_min', 'multi_account_mode', 'sub_hold_ttl_min', 'carry_strategy',
  'is_popular', 'work_kind'];
const PART_COMPUTED = ['participation_mode', 'state', 'todayCount', 'dailyQuota', 'opensAt', 'closesAt',
  'cutoffAt', 'allDay', 'startDate', 'endDate', 'scheduleSource', 'stateReason', 'stateMessage', 'closedKind',
  'resumesOn', 'resumesAt', 'nextWorkDate', 'reopensAt', 'soldoutPaused'];
/* 조건부로만 붙는 계산 칸(값이 있을 때만) — 정확 비교에서 제외하되 행 칸이 아니어야 한다 */
const OPTIONAL_COMPUTED = ['cashReceiptRequired', 'todayFilled', 'options', 'qtyTiers', 'holdChain', 'booking',
  'currentFee', 'feeScheduleActive', 'sequential', 'sequentialOpts'];
const FORBIDDEN_PUBLIC = ['description', 'linked_sheet_id', 'linked_tab_name', 'linked_tab_gid', 'work_detail',
  'archived_at', 'reviewer_hidden', 'recruit_total', 'daily_limit', 'window_start', 'window_end'];

function keysExact(obj, rowAllow, computed) {
  const got = Object.keys(obj || {}).filter(k => !OPTIONAL_COMPUTED.includes(k));
  const want = [...rowAllow, ...computed];
  const extra = got.filter(k => !want.includes(k));
  const missing = want.filter(k => !got.includes(k));
  return { ok: extra.length === 0 && missing.length === 0, extra, missing };
}

(async () => {
  console.log('\n▶ 결정 431 — 로그인 없는 공고 목록·상세는 허용 칸만 · 직원 응답은 그대로\n');

  const pool = require('../src/db/pool');
  pool.query = async (sql, params) => {
    const s = String(sql);
    if (/SELECT \* FROM recruit_campaigns WHERE id = \$1/.test(s)) {
      return { rows: CAMPS.filter(c => c.id === (params || [])[0]).map(c => ({ ...c })) };
    }
    if (/FROM recruit_campaigns/.test(s) && /archived_at IS NULL/.test(s) && /ORDER BY/.test(s)) return { rows: CAMPS.map(c => ({ ...c })) };
    return { rows: [] };
  };

  const express = require('express');
  const jwt = require('jsonwebtoken');
  const app = express(); app.use(express.json());
  app.use('/api/campaign', require('../src/routes/campaign.routes'));
  app.use((err, req, res, _next) => res.status(500).json({ ok: false, error: String(err && err.message) }));
  const srv = await new Promise(res => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const hit = async (p, tok) => {
    const headers = {};
    if (tok) headers.Authorization = 'Bearer ' + jwt.sign(tok, process.env.JWT_SECRET);
    const r = await fetch(base + p, { headers });
    const text = await r.text();
    let b = null; try { b = JSON.parse(text); } catch (_) { /* noop */ }
    return { status: r.status, body: b, text };
  };
  const ADMIN = { role: 'admin', name: '관리자' };
  const noSecret = (text, which) => which.filter(k => text.includes(SECRET[k]));

  try {
    console.log('A. 공개 목록 GET /api/campaign/list (로그인 없음)');
    const l = await hit('/api/campaign/list');
    const byId = new Map(((l.body && l.body.data) || []).map(c => [c.id, c]));
    ok('A0 200 · 공고 2개', l.status === 200 && byId.size === 2, l.status + ' ' + l.text.slice(0, 200));
    const lg = byId.get('c-legacy') || {}, pt = byId.get('c-part') || {};
    const leak = noSecret(l.text, ['partManager', 'sheetId', 'tabName', 'description', 'partSheetId', 'partTabName', 'workDetail']);
    ok('A1 응답 어디에도 내부 값(참여형 담당 칸·시트 고유번호·탭 이름·내부 설명·작업내용) 없음', leak.length === 0, 'leak=' + leak.join(','));
    ok('A2 참여형: manager 칸 없음', !('manager' in pt), JSON.stringify(pt.manager));
    ok('A3 옛 방식: description · linked_sheet_id · linked_tab_name 칸 없음',
      !('description' in lg) && !('linked_sheet_id' in lg) && !('linked_tab_name' in lg), Object.keys(lg).join(','));
    ok('A4 금지 칸이 어느 공고에도 없음', [lg, pt].every(c => FORBIDDEN_PUBLIC.every(k => !(k in c))),
      [lg, pt].map(c => FORBIDDEN_PUBLIC.filter(k => k in c).join('+')).join(' | '));
    const kl = keysExact(lg, LEGACY_ROW_ALLOW, LEGACY_COMPUTED);
    ok('A5 옛 방식 공개 칸 = 허용 목록(정확히)', kl.ok, 'extra=' + kl.extra + ' missing=' + kl.missing);
    const kp = keysExact(pt, PART_ROW_ALLOW, PART_COMPUTED);
    ok('A6 참여형 공개 칸 = 허용 목록(정확히)', kp.ok, 'extra=' + kp.extra + ' missing=' + kp.missing);
    ok('A7 옛 방식 카드가 그리는 칸은 그대로(담당 별명·카톡 신청 주소·유의사항·정원)',
      lg.manager === '망고' && lg.chat_url === LEGACY.chat_url && lg.notes === '공개 유의사항'
      && lg.max_slots === 10 && lg.current_slots === 2, JSON.stringify(lg).slice(0, 300));
    const la = await hit('/api/campaign/list', ADMIN);
    ok('A8 관리자 토큰으로 불러도 공개 목록은 같은 허용 칸(목록은 직원 갈래가 없다 — 직원은 /admin/list)',
      la.status === 200 && noSecret(la.text, ['partManager', 'sheetId', 'description']).length === 0);

    console.log('\nB. 공개 상세 GET /api/campaign/:id (로그인 없음) — 같은 공개 뷰');
    const dl = await hit('/api/campaign/c-legacy');
    ok('B1 옛 방식 상세: 내부 설명·시트 고유번호·탭 이름 없음',
      dl.status === 200 && noSecret(dl.text, ['sheetId', 'tabName', 'description', 'workDetail']).length === 0, dl.status + ' ' + dl.text.slice(0, 200));
    const dp = await hit('/api/campaign/c-part');
    ok('B2 참여형 상세: 담당 칸 없음', dp.status === 200 && dp.body && dp.body.data && !('manager' in dp.body.data)
      && noSecret(dp.text, ['partManager', 'partSheetId', 'partTabName', 'workDetail']).length === 0, dp.status + ' ' + dp.text.slice(0, 200));
    const kd = keysExact(dl.body && dl.body.data, LEGACY_ROW_ALLOW, LEGACY_COMPUTED);
    ok('B3 옛 방식 상세 칸 = 목록과 같은 허용 목록', kd.ok, 'extra=' + kd.extra + ' missing=' + kd.missing);

    console.log('\nC. 직원(관리자 JWT) 응답 — 종전 그대로 전체 행');
    for (const [label, p] of [['관리자 수정 창 /admin/:id', '/api/campaign/admin/'], ['같은 상세 + 관리자 토큰 /:id', '/api/campaign/']]) {
      const a = await hit(p + 'c-legacy', ADMIN);
      const d = (a.body && a.body.data) || {};
      ok(`C1 ${label} 옛 방식: manager·chat_url·description·linked_* 그대로`,
        a.status === 200 && d.manager === '망고' && d.chat_url === LEGACY.chat_url && d.description === SECRET.description
        && d.linked_sheet_id === SECRET.sheetId && d.linked_tab_name === SECRET.tabName, a.status + ' ' + a.text.slice(0, 200));
      const b = await hit(p + 'c-part', ADMIN);
      const e = (b.body && b.body.data) || {};
      ok(`C2 ${label} 참여형: manager·linked_* 그대로`,
        b.status === 200 && e.manager === SECRET.partManager && e.linked_sheet_id === SECRET.partSheetId, b.status + ' ' + b.text.slice(0, 200));
    }
    const al = await hit('/api/campaign/admin/list', ADMIN);
    const ab = new Map(((al.body && al.body.data) || []).map(c => [c.id, c]));
    ok('C3 관리자 목록 /admin/list: 담당 칸·연결 탭 그대로',
      al.status === 200 && (ab.get('c-part') || {}).manager === SECRET.partManager
      && (ab.get('c-legacy') || {}).linked_sheet_id === SECRET.sheetId, al.status + ' ' + al.text.slice(0, 200));
  } finally {
    srv.close();
  }

  console.log('\nD. 정적 — 허용 목록 단일 출처 · 옛 화면(캐시)이 뺀 칸을 읽지 않음');
  const routes = read('server/src/routes/campaign.routes.js');
  const legacyArr = (routes.match(/const PUBLIC_FIELDS_LEGACY = \[[\s\S]*?\];/) || [''])[0];
  const partArr = (routes.match(/const PUBLIC_FIELDS_PARTICIPATION = \[[\s\S]*?\];/) || [''])[0];
  const liveOnly = (s) => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  ok('D1 옛 방식 허용 목록에 description·linked_sheet_id·linked_tab_name 없음',
    legacyArr && !/'(description|linked_sheet_id|linked_tab_name)'/.test(liveOnly(legacyArr)));
  ok('D2 참여형 허용 목록에 manager 없음', partArr && !/'manager'/.test(liveOnly(partArr)));
  const pv = routes.slice(routes.indexOf('function _publicView('), routes.indexOf('\nfunction ', routes.indexOf('function _publicView(') + 10));
  ok('D3 공개 뷰는 행을 허용 목록으로만 고른다(...row 펼치기 없음)', pv && !/\.\.\.row\b/.test(pv) && /_pick\(row, PUBLIC_FIELDS_LEGACY\)/.test(pv) && /_pick\(row, PUBLIC_FIELDS_PARTICIPATION\)/.test(pv));
  for (const f of ['frontend/recruit.html', 'frontend/index.html', 'frontend/campaign.html']) {
    const src = read(f);
    ok(`D4 ${f}: 뺀 칸(description·linked_sheet_id·linked_tab_name)을 공개 응답에서 읽지 않음(옛 캐시 화면도 무해)`,
      !/\b(c|x|camp|_camp)\.(description|linked_sheet_id|linked_tab_name)\b/.test(src));
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
