#!/usr/bin/env node
/**
 * 회귀가드 — 블로그체험단 승인제 (migration 127 · 사용자 확정 2026-08-19)
 *
 * 고정하는 계약
 *  §1 migration 127 = 상태 어휘(blog_pending/blog_rejected) + 부분유니크(반려 제외 = 즉시 재신청)
 *     + 드롭 루프가 지운 chk_campaign_apps_submitted_ts 재생성 + REQUIRED_SCHEMA 3종
 *  §2 apply: 블로그 공고 = blog_pending(TTL 없음 · 정원 미점유) — 킬스위치 BLOG_APPROVAL_FLOW
 *  §3 승인 = 'applied' + 구매기한(기존 홀드 파이프라인 재사용 — 스윕·확정·work-detail 무수정)
 *     스텁 pool 로 **실제 핸들러 실행**: 승인/정원가득/멱등/반려사유필수/반려/옵션정원
 *  §4 work-detail: 대기/반려는 '만료'가 아니다(전용 reason — 구버전 화면은 토큰 보존 재시도)
 *  §5 스윕 무접촉 — 만료 스윕은 여전히 status='applied' 만(blog_pending 은 TTL 이 없다)
 *  §6 작업표 필수 3열(블로그URL·포스팅결과URL·포스팅제출일) — 중복 미생성 · blog 날짜 공란
 *  §7 memoColumn: 포스팅결과URL(값) ↔ 포스팅제출일(날짜) 열 상호 오염 차단
 *  §8 관제·카드·홈 탭·모달 배선 + trackb 위임 라우트
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FRONT = path.join(ROOT, '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(FRONT, p), 'utf8');
const readNoNul = (p) => read(p).split(String.fromCharCode(0)).join('');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

const MIG = read('migrations/127_blog_approval.sql');
const INDEX = read('index.js');
const CAMP = readNoNul('src/routes/campaign.routes.js');
const HOLD = read('src/services/campaignHold.service.js');
const TRACKB = readNoNul('src/routes/trackB.routes.js');
const SUBMIT = read('src/routes/submit.routes.js');
const QUEUE = read('src/services/syncQueue.service.js');

console.log('\n§1 migration 127 · 프리플라이트');
{
  const live = MIG.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  ok('CHECK 에 blog_pending·blog_rejected 합류(기존 5종 보존)',
    /CHECK \(status IN \('confirmed','cancelled','applied','submitted','expired',\s*'blog_pending','blog_rejected'\)\) NOT VALID/.test(live));
  ok('드롭 루프가 지운 chk_campaign_apps_submitted_ts 재생성(045 순서 계약)',
    /ADD CONSTRAINT chk_campaign_apps_submitted_ts\s+CHECK \(status <> 'submitted' OR submitted_at IS NOT NULL\)/.test(live));
  ok('부분유니크 = (applied, blog_pending) — 이중 신청 차단',
    /uq_campaign_apps_active_hold\s+ON campaign_applications \(campaign_id, phone8\)\s+WHERE status IN \('applied', 'blog_pending'\)/.test(live));
  ok('★ blog_rejected 는 유니크에서 제외 = 반려 즉시 재신청(사용자 확정 ③)',
    !/WHERE status IN \([^)]*blog_rejected/.test(live));
  ok('컬럼 3종 추가만(백필 UPDATE 0)', /decided_at\s+TIMESTAMPTZ/.test(live) && /reject_reason TEXT/.test(live) && !/\bUPDATE\b/i.test(live.replace(/COMMENT ON[^;]+;/g, '')));
  for (const c of ['decided_at', 'decided_by', 'reject_reason']) {
    ok(`REQUIRED_SCHEMA: campaign_applications.${c}`, new RegExp(`\\['campaign_applications',\\s*'${c}'\\]`).test(INDEX));
  }
}

console.log('\n§2 apply — blog_pending 분기');
{
  const i = CAMP.indexOf('async function _applyParticipation');
  const body = CAMP.slice(i, i + 60000);
  ok('킬스위치 BLOG_APPROVAL_FLOW(기본 ON — 0 이면 신규 신청만 종전 즉시-홀드)',
    /blogApply && String\(process\.env\.BLOG_APPROVAL_FLOW \|\| '1'\) !== '0'/.test(body));
  ok('pending 은 expires_at NULL(TTL 없음 — 승인은 사람 일)',
    /const insExpires = blogApproval \? null : expiresAt\.toISOString\(\)/.test(body));
  ok('INSERT status 가 파라미터($12) — 리터럴 applied 하드코딩이 아니다',
    /VALUES \(\$1,\$2,\$3,\$4,\$5,\$12,\$6,\$7,\$8,\$9,\$10,\$11\)/.test(body));
  ok('응답에 pending 신호(프론트 "승인 대기 중" 분기 재료)',
    /pending: ins\.rows\[0\]\.status === 'blog_pending'/.test(body));
}

console.log('\n§4 work-detail · cancel — 대기/반려는 만료가 아니다');
{
  const i = CAMP.indexOf("router.get('/:id/work-detail'");
  const body = CAMP.slice(i, i + 8000);
  const iPend = body.indexOf("reason: 'pending_approval'");
  const iRej = body.indexOf("reason: 'apply_rejected'");
  const iValid = body.indexOf("app.status === 'applied' && app.expires_at");
  ok('pending_approval 분기가 validHold(만료) 판정보다 앞', iPend > 0 && iValid > 0 && iPend < iValid);
  ok('apply_rejected 분기 + rejectReason 동봉', iRej > 0 && /rejectReason: app\.reject_reason \|\| ''/.test(body));
  ok('SELECT 에 reject_reason·decided_at 동봉', /reject_reason, decided_at\s+FROM campaign_applications/.test(body));
  ok('cancel 이 blog_pending 도 받는다(신청 취소 — 자리 미점유라 무해)',
    /AND status IN \('applied', 'blog_pending'\)\s+RETURNING id/.test(CAMP));
}

console.log('\n§5 스윕 무접촉 — 만료 스윕은 applied 만');
ok('campaignHold.service 에 blog_pending 참조 0(TTL 없는 상태를 스윕이 만료시키지 않는다)',
  !HOLD.includes('blog_pending'));

console.log('\n§8a trackb 위임 + ops.blogPending');
ok('trackb: /campaigns/:id/blog-approve 위임(confirm 과 같은 2단 게이트)',
  /router\.post\('\/campaigns\/:id\/blog-approve', authMiddleware, internalMiddleware, editorOnlyMiddleware/.test(TRACKB));
ok('trackb: /campaigns/:id/blog-reject 위임',
  /router\.post\('\/campaigns\/:id\/blog-reject', authMiddleware, internalMiddleware, editorOnlyMiddleware/.test(TRACKB));
ok('admin/list ops.blogPending(카드 관제 배지 재료)', /blogPending: blogPendingMap\.get\(r\.id\) \|\| 0/.test(CAMP));
ok('_fetchBlogPendingCounts = status=blog_pending 집계', /WHERE campaign_id = ANY\(\$1\) AND status = 'blog_pending'/.test(CAMP));

console.log('\n§6 작업표 필수 3열 (worktablePlan — 실행)');
{
  const wp = require('../src/utils/worktablePlan');
  const tpl = { core: ['번호', '구매일자', '수취인', '연락처', '주소', '결제금액', '리뷰제출', '입금', '비고'], channels: {}, workTypes: [] };
  const blog = wp.buildWorktablePlan({ workOrder: { work_kind: 'blog', recruit_count: 5, product_url: 'https://coupang.com/x' }, template: tpl });
  const names = blog.columns.map(c => c.name);
  ok('blog 표에 3열 자동 포함', names.includes('블로그URL') && names.includes('포스팅결과URL') && names.includes('포스팅제출일'));
  ok('blog 는 구매일자 공란(모집·승인된 블로거가 구매할 때 채운다)', blog.rows.every(r => !r.date));
  ok('blog 경고 = blog_no_dates 한 줄(리뷰 날짜 경고 4종은 오탐이라 미발동)',
    blog.warnings.some(w => w.code === 'blog_no_dates') && !blog.warnings.some(w => ['no_start_date', 'no_daily', 'date_short'].includes(w.code)));
  // 같은 성격의 열이 이미 있으면 중복 생성하지 않는다(존재 판정 = 실제 기입 규칙과 동일)
  const tpl2 = { core: ['번호', '블로그주소', '포스팅 결과 URL', '포스팅제출일', '수취인', '연락처'], channels: {}, workTypes: [] };
  const blog2 = wp.buildWorktablePlan({ workOrder: { work_kind: 'blog', recruit_count: 3 }, template: tpl2 });
  const n2 = blog2.columns.map(c => c.name);
  ok('이미 있는 열(블로그주소·포스팅 결과 URL 등)은 중복 생성 0',
    !n2.includes('블로그URL') && !n2.includes('포스팅결과URL') && n2.filter(x => /포스팅/.test(x)).length === 2);
  const rev = wp.buildWorktablePlan({ workOrder: { work_kind: '', recruit_count: 5, daily_count: 5, start_date: '2026-08-20' }, template: tpl });
  ok('리뷰 작업표는 무회귀(3열 미추가 + 날짜 분배 유지)',
    !rev.columns.some(c => c.name === '블로그URL') && rev.rows.filter(r => r.date).length === 5);
}

console.log('\n§7 memoColumn — URL 칸 ↔ 날짜 칸 상호 오염 차단(실행)');
{
  const m = require('../src/utils/memoColumn');
  const H = ['번호', '포스팅제출일', '포스팅결과URL', '비고'];
  ok('blog memo(포스팅URL)는 날짜 칸을 건너뛴다', m.pickMemoColumnIndex(H, { blog: true }) === 2);
  ok('날짜 칸 = 포스팅제출일', m.pickPostDateColumnIndex(H) === 1);
  ok('리뷰 memo = 비고 우선(무회귀)', m.pickMemoColumnIndex(H) === 3);
  ok('URL/링크 헤더는 날짜 칸이 아니다', m.isPostDateHeader('포스팅결과URL') === false && m.isPostDateHeader('포스팅제출일') === true);
  const { mapOrderToSheetRow } = require('../src/services/orderLedger.service');
  const out = mapOrderToSheetRow(['블로그URL', '포스팅결과URL', '포스팅제출일'], { blogUrl: 'https://b.com/x', address: '서울', dateStr: '8/20', memo: 'x' });
  ok('매퍼: 구매 제출이 포스팅결과URL·포스팅제출일 칸을 건드리지 않는다(null=안 씀)',
    out[0] === 'https://b.com/x' && out[1] === null && out[2] === null);
}

console.log('\n§8b 제출 — 캡처+URL + 포스팅제출일 자동 기록 배선');
ok('submit: capture_required(캡처 없는 blog 제출 거부 — 서버 최종 방어)', /code: 'capture_required'/.test(SUBMIT));
ok('submit: 포스팅제출일 = kstTodayStr(사본 금지)', /_postDate = _isBlog \? require\('\.\.\/services\/campaignState\.service'\)\.kstTodayStr/.test(SUBMIT));
ok('submit: 무시트 포스팅제출일 기록(markSheetlessPostDate)', /markSheetlessPostDate\(\{ sheetId, tabName, rowIndex, date: _postDate/.test(SUBMIT));
ok('submit: 큐 payload 에 postDate(재시도 시각 아님)', /postDate: \(_isBlog && complete\) \? _postDate : ''/.test(SUBMIT));
ok('queue: 재시도도 같은 열 고르기(pickPostDateColumnIndex)', /pickPostDateColumnIndex\(headers\)/.test(QUEUE) && /pickPostDateColumnIndex/.test(QUEUE.split('\n').find(l => l.includes("require('../utils/memoColumn')")) || ''));
{
  const SS = read('src/services/sheetlessStatus.service.js');
  ok('sheetlessStatus: markSheetlessPostDate — 시트 기반 탭은 handled:false(무회귀)',
    /async function markSheetlessPostDate/.test(SS) && /markSheetlessPostDate,/.test(SS));
}

console.log('\n§8c 프론트 배선');
{
  const CH = readF('campaign.html');
  ok('campaign.html: 대기/반려 화면 + show() 합류', /vBlogPending/.test(CH) && /vBlogRejected/.test(CH) && /'vBlogPending','vBlogRejected'/.test(CH));
  ok('campaign.html: work-detail reason 분기(pending_approval → 폴링 · apply_rejected → 재신청)',
    /reason === 'pending_approval'/.test(CH) && /reason === 'apply_rejected'/.test(CH) && /function retryBlogApply/.test(CH));
  ok('campaign.html: 대기 화면 30초 폴링', /_bpTimer = setInterval\(enterJoined, 30000\)/.test(CH));
  const IH = readF('index.html'); const RH = readF('recruit.html');
  ok('index.html: 종류 탭(setRecruitKind) + work_kind 정확 일치 판정', /setRecruitKind/.test(IH) && /c\.work_kind === "blog"/.test(IH));
  ok('recruit.html: 종류 탭 + 필터', /setRecruitKind/.test(RH) && /_rcKindOf\(c\) === _rcKind/.test(RH));
  const CC = readF('js/campaign-cards.js');
  ok('campaign-cards: 블로그 카드 = 신청하기 CTA + 📝 배지 + 관제 승인대기 배지',
    /신청하기/.test(CC) && /work_kind === 'blog'/.test(CC) && /ops\.blogPending/.test(CC));
  const IR = readF('js/index-recruit.js');
  ok('index-recruit: 관제 승인 큐(_campBlogQueue) + 승인/반려 호출(onclick 은 인덱스만)',
    /_campBlogQueue/.test(IR) && /campBlogApprove\(\$\{i\}\)/.test(IR) && /blog-approve/.test(IR) && /blog-reject/.test(IR));
  ok('index-recruit: 반려 사유 = 인라인 입력(브라우저 prompt 금지)', !/prompt\(/.test(IR.slice(IR.indexOf('_campBlogQueue'), IR.indexOf('_campOptionTable'))));
  ok('index-recruit: rf_work_kind payload + blog 리뷰타입 미전송 + 일건수 정규화',
    /payload\.work_kind = _wkEl\.value/.test(IR) && /_rfApplyWorkKindUi/.test(IR));
  const RM = readF('js/recruit-modal.js');
  ok('recruit-modal: rf_work_kind hidden 존재', /id="rf_work_kind"/.test(RM));
  ok('공개 목록 화이트리스트: 레거시에도 work_kind(탭 필터 재료)',
    /PUBLIC_FIELDS_LEGACY = \[[\s\S]*?'work_kind'/.test(CAMP));
}

// ══ §3 런타임: 승인/반려 핸들러 실행(스텁 pool) ══
console.log('\n§3 승인/반려 — 실제 핸들러 실행');
const pool = require('../src/db/pool');
let connectCalls = 0;
function makeClient(scn) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const S = String(sql);
      queries.push({ sql: S, params });
      if (/FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/.test(S)) {
        return { rows: [{ id: 'camp1', recruit_total: scn.total, participation_mode: true, linked_tab_sheet_id: '', linked_tab_name: '' }] };
      }
      if (/FROM campaign_applications WHERE id = \$1 AND campaign_id = \$2 FOR UPDATE/.test(S)) {
        return { rows: [{ id: 9, status: scn.appStatus, phone8: '11112222', applicant_name: '블로거', option_key: scn.optionKey || null, expires_at: scn.appExpires || null }] };
      }
      if (/COUNT\(\*\) FILTER \(WHERE status='submitted'\) AS sub/.test(S)) {
        return { rows: [{ sub: scn.used || 0, holds: 0 }] };
      }
      if (/FROM campaign_options WHERE campaign_id = \$1 AND opt_key = \$2/.test(S)) {
        return { rows: scn.optTotal != null ? [{ recruit_total: scn.optTotal }] : [] };
      }
      if (/UPDATE campaign_applications[\s\S]*RETURNING expires_at/.test(S)) {
        return { rows: [{ expires_at: '2026-08-20T09:00:00Z' }] };
      }
      return { rows: [] };
    },
    release() {},
  };
}
pool.query = async () => ({ rows: [] });   // 알림(postAdminNotice) 등 — 빈 결과로 무해 흡수

const campaignRouter = require('../src/routes/campaign.routes');
function handlerFor(method, routePath) {
  const layer = campaignRouter.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert(layer, `라우트 없음: ${method} ${routePath}`);
  const st = layer.route.stack;
  return st[st.length - 1].handle;
}
async function call(routePath, body, scn) {
  const client = makeClient(scn);
  pool.connect = async () => { connectCalls++; return client; };
  const handler = handlerFor('post', routePath);
  const out = await new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ statusCode: this.statusCode, body: b, client }); return this; } };
    Promise.resolve(handler({ params: { id: 'camp1' }, body, admin: { role: 'admin', name: '관리자A' } }, res, (err) => resolve({ err, client })))
      .catch((err) => resolve({ err, client }));
  });
  await new Promise(r => setImmediate(r));
  return out;
}

(async () => {
  // A. 승인 성공 — pending → applied + 구매기한 + decided_by
  let r = await call('/admin/:id/blog-approve', { applicationId: 9 }, { appStatus: 'blog_pending', total: 10, used: 0 });
  ok('A 승인: 200 ok + expiresAt 반환', r.body && r.body.ok === true && !!r.body.expiresAt);
  const upQ = r.client.queries.find(q => /SET status = 'applied'/.test(q.sql));
  ok('A 승인: UPDATE → applied + make_interval(구매기한) + blog_pending 조건부(경합 안전)',
    upQ && /make_interval\(mins => \$2\)/.test(upQ.sql) && /WHERE id = \$1 AND status = 'blog_pending'/.test(upQ.sql));
  ok('A 승인: decided_by = 관리자 이름', upQ.params[2] === '관리자A');
  ok('A 승인: COMMIT 존재', r.client.queries.some(q => q.sql === 'COMMIT'));

  // B. 정원 가득 — 승인 시점 재검사(사용자 확정 ① "승인한 사람만 센다" = 승인이 소비 시점)
  r = await call('/admin/:id/blog-approve', { applicationId: 9 }, { appStatus: 'blog_pending', total: 2, used: 2 });
  ok('B 정원 가득: 409 capacity_full + 쓰기 0', r.statusCode === 409 && r.body.reason === 'capacity_full'
    && !r.client.queries.some(q => /SET status = 'applied'/.test(q.sql)));

  // C. 멱등 — 이미 승인(applied)이면 already
  r = await call('/admin/:id/blog-approve', { applicationId: 9 }, { appStatus: 'applied', total: 10, appExpires: '2026-08-20T01:00:00Z' });
  ok('C 멱등: 이미 applied → ok+already(더블클릭 안전)', r.body && r.body.ok === true && r.body.already === true);

  // D. 승인 불가 상태
  r = await call('/admin/:id/blog-approve', { applicationId: 9 }, { appStatus: 'expired', total: 10 });
  ok('D expired 는 승인 대상 아님(not_pending)', r.statusCode === 409 && r.body.reason === 'not_pending');

  // E. 반려 — 사유 필수(커넥션도 안 연다)
  const beforeConn = connectCalls;
  r = await call('/admin/:id/blog-reject', { applicationId: 9, reason: '' }, { appStatus: 'blog_pending', total: 10 });
  ok('E 반려 사유 필수: 400(리뷰어가 고칠 방법을 알아야 한다)', r.statusCode === 400);
  // reason 검사는 pool.connect 앞 — 사유 없는 요청은 잠금 왕복 자체가 없다
  ok('E 반려 사유 필수: pool.connect 미호출', connectCalls === beforeConn);

  // F. 반려 성공 — 사유가 그대로 기록된다
  r = await call('/admin/:id/blog-reject', { applicationId: 9, reason: '블로그 이웃수가 조건 미달이에요' }, { appStatus: 'blog_pending', total: 10 });
  ok('F 반려: 200 ok + blog_rejected + 사유 파라미터', r.body && r.body.ok === true
    && r.client.queries.some(q => /SET status = 'blog_rejected', reject_reason = \$2/.test(q.sql) && q.params[1] === '블로그 이웃수가 조건 미달이에요'));

  // G. 옵션 정원 — 신청 옵션이 소진이면 승인 불가
  r = await call('/admin/:id/blog-approve', { applicationId: 9 }, { appStatus: 'blog_pending', total: 10, used: 1, optionKey: 'A안', optTotal: 1 });
  ok('G 옵션 소진: 409 option_full', r.statusCode === 409 && r.body.reason === 'option_full');

  console.log(`\n✅ blogApprovalFlow: ${passed}개 통과`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
