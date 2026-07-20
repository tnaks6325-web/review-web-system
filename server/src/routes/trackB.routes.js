/**
 * Track B — 백그라운드 평행 트랙(통합 작업대의 그림자) 라우트.
 *
 * ★ 무영향·격리: 투영/대조/소유/작업대는 master 전용. 작업대 읽기는 advertiser(광고주)에게도
 *   "본인 소유 탭만" 열되(스코프 강제 + PII 마스킹), 라이브 검색·주문·시트 흐름을 일절 안 건드린다.
 *   되돌리기 = app.js 마운트 제거.
 */
const express = require('express');
const router = express.Router();
const { authMiddleware, masterOnlyMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const svc = require('../services/trackB.service');
const participants = require('../services/participants.service');
const authSvc = require('../services/auth.service');

function _by(req) { return String((req.admin && (req.admin.name || req.admin.role)) || 'admin').slice(0, 100); }
function _role(req) { return (req.admin && req.admin.role) || ''; }

// 편집 스코프 가드: master/admin=전체 허용, staff=담당 탭만(canAccessTab), advertiser/그외=차단.
//   ★ 라우트레벨 adminOrMaster 를 대체 — staff 를 "자기 담당 탭"에 한해 편집 허용하되 교차 접근 차단.
async function _ensureEditScope(req, sheetId, tabName) {
  const role = _role(req);
  if (role === 'master' || role === 'admin') return { ok: true };
  if (role === 'staff') {
    const okc = await svc.canAccessTab({ role: 'staff', staffName: req.admin && req.admin.name, sheetId, tabName });
    return okc ? { ok: true } : { ok: false, code: 403, error: '담당하지 않은 작업(스코프 밖)' };
  }
  return { ok: false, code: 403, error: '편집 권한이 없습니다.' };
}

// 스레드 스코프 가드: master/admin=전체 · staff=담당 탭 · advertiser=소유 탭(양방향 협업이라 read/write 동일) · reviewer 차단.
//   ★ (sheetId, tabName) 기준 canAccessTab(gid 신뢰 금지). 광고주 내부글 제외는 서비스(internal_only 필터)가 담당.
async function _ensureThreadScope(req, sheetId, tabName) {
  const role = _role(req);
  if (role === 'master' || role === 'admin') return { ok: true };
  if (role === 'staff' || role === 'advertiser') {
    const okc = await svc.canAccessTab({ role, staffName: (req.admin && req.admin.name) || null, advertiserId: (req.admin && req.admin.advertiser_id) || null, sheetId, tabName });
    return okc ? { ok: true } : { ok: false, code: 403, error: '스코프 밖 탭(담당/소유 아님)' };
  }
  return { ok: false, code: 403, error: '권한이 없습니다.' };
}

// ── 그림자 투영(라이브 읽어 B 최신화) — master 전용 ──
router.post('/project', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (sheetId && tabName) return res.json({ ok: true, ...(await svc.projectTab({ sheetId, tabName, by: _by(req) })) });
    // bulk 투영은 cron(trackb_project 락)과 상호배제 — 멀티인스턴스 이중투영·seen-set 플래핑 차단.
    const { withJobLock } = require('../utils/jobLock');
    const r = await withJobLock('trackb_project', () => svc.projectActive({ by: _by(req) }));
    res.json({ ok: true, ...r });
  } catch (err) { next(err); }
});

// ── parity 리포트(B ↔ A, 6차원×3버킷) — adminOrMaster ──
//   관측 뷰(adminOrMaster)의 [정밀] 버튼이 호출하는데 master 전용이면 admin이 dead-end.
//   PII 등가: real/benign 샘플 phone8은 _mask 처리 + 동일 수치가 parity-all(adminOrMaster)로 기노출 → 신규 노출 0.
router.get('/parity', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    res.json({ ok: true, ...(await svc.parityReport({ sheetId, tabName })) });
  } catch (err) { next(err); }
});

// ── 작업/소유 UI 공용: 활성 탭 목록 — adminOrMaster(그림자 콘솔 스코프) ──
//   participants/tabs 는 master 전용이라 admin이 소유 지정 화면의 시트 피커를 못 채운다.
//   Track B 콘솔은 adminOrMaster 이므로 같은 읽기전용 목록을 네임스페이스 내에서 재노출한다.
router.get('/tabs', authMiddleware, async (req, res, next) => {
  try {
    const role = _role(req);
    if (!['master', 'admin', 'staff', 'advertiser'].includes(role)) return res.status(403).json({ ok: false, error: '권한 없음' });
    // 역할 스코프: master/admin=전체 · staff=담당(inad_pm) · advertiser=소유 탭만.
    //   forMapping=1(소유지정 초기매핑): staff에 한해 전체 탭명 목록(서비스에서 advertiser는 무시 — 스코프 유지).
    const tabs = await svc.scopedActiveTabs({ role, staffName: req.admin && req.admin.name, advertiserId: (req.admin && req.admin.advertiser_id) || null, limit: req.query.limit, forMapping: req.query.forMapping === '1' });
    res.json({ ok: true, count: tabs.length, tabs });
  } catch (err) { next(err); }
});

// ── 관측 대시보드: 투영된 전 탭 롤업(카운트 대조 + 준비도) — adminOrMaster ──
router.get('/overview', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, items: await svc.overview() }); }
  catch (err) { next(err); }
});
// ── 전체 정밀 계산(진짜 불일치 일괄) + 스냅샷 저장 — adminOrMaster ──
router.post('/parity-all', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, ...(await svc.parityAll({ store: true, source: 'manual' })) }); }
  catch (err) { next(err); }
});
// ── parity 추이(한 탭 스냅샷 이력) — adminOrMaster ──
router.get('/parity-trend', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, limit } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    res.json({ ok: true, items: await svc.parityTrend({ sheetId, tabName, limit }) });
  } catch (err) { next(err); }
});

// ── 진실원천(source_of_truth) 컨트롤 — 옵션 A cutover 스위치 ──
//   ★ 격리: 이 플래그를 읽는 소비처는 Track B write-back 엔진(P2, 미착수)뿐 — 값을 바꿔도 Track A 라이브 불변.
//   읽기는 adminOrMaster(관측), 플립(설정)은 master 전용(되돌리기 어려운 방향 전환이라 보수적).
router.get('/source-of-truth', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    res.json({ ok: true, sourceOfTruth: await svc.getSourceOfTruth({ sheetId, tabName }) });
  } catch (err) { next(err); }
});
router.post('/source-of-truth', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, value, force } = req.body || {};
    if (!sheetId || !tabName || !value) return res.status(400).json({ ok: false, error: 'sheetId, tabName, value 필수' });
    const out = await svc.setSourceOfTruth({ sheetId, tabName, value, by: _by(req), force: !!force });
    res.status(out.ok ? 200 : (out.error === 'parity_not_clean' ? 409 : 400)).json(out);
  } catch (err) { next(err); }
});

// ── P2 상태 토글 write-back 관측/수동 트리거 — master 전용 ──
//   status = held/blocked/written 카운트(관측). run = 즉시 스윕(탭 지정 시 그 탭만). 락으로 cron과 상호배제.
router.get('/writeback/status', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, ...(await svc.writebackStatus()) }); }
  catch (err) { next(err); }
});
router.post('/writeback/run', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    const { withJobLock } = require('../utils/jobLock');
    const r = await withJobLock('trackb_writeback',
      () => (sheetId && tabName) ? svc.executeWriteback({ sheetId, tabName }) : svc.writebackSweep({}));
    res.json({ ok: true, ...r });
  } catch (err) { next(err); }
});

// ── P2-2 확장 write-back — 시뮬레이션(시트 무접촉) + 실제 적용 트리거(TRACK_B_WRITEBACK_FULL 게이트) — master ──
//   simulate = 무엇이 시트에 반영될지 플랜만(안전). apply-full = 트리거 ON+cutover 에서만 안전군 적용(수동).
router.get('/writeback/simulate', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    res.json({ ok: true, ...(await svc.simulateWriteback({ sheetId, tabName })) });
  } catch (err) { next(err); }
});
router.post('/writeback/apply-full', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const { withJobLock } = require('../utils/jobLock');
    const r = await withJobLock('trackb_writeback', () => svc.applyWritebackFull({ sheetId, tabName }));
    res.json({ ok: true, ...r });
  } catch (err) { next(err); }
});

// ── 작업오더(발주) 연동 — 수동 링크 + 작업세부 + 명단 골격 준비 — admin/master ──
//   ★ Track A 무접촉: 링크는 Track B 전용 테이블 trackb_work_order_links(051)에만 저장(work_orders는 읽기만).
//     work_orders.linked_tab_* 는 order.routes 승인 흐름이 읽어 분기하므로 절대 안 씀. 명단 골격은 manual 슬롯.
router.get('/work-orders', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, items: await svc.listWorkOrders({ sheetId: req.query.sheetId, tabName: req.query.tabName, limit: req.query.limit }) }); }
  catch (err) { next(err); }
});
router.post('/work-order/link', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { workOrderId, sheetId, tabName, tabGid } = req.body || {};
    if (!workOrderId || !sheetId || !tabName) return res.status(400).json({ ok: false, error: 'workOrderId, sheetId, tabName 필수' });
    const out = await svc.linkWorkOrder({ workOrderId, sheetId, tabName, tabGid: tabGid || null, by: _by(req) });
    res.status(out.ok ? 200 : 404).json(out);
  } catch (err) { next(err); }
});
router.post('/work-order/unlink', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    res.json(await svc.unlinkWorkOrder({ sheetId, tabName }));
  } catch (err) { next(err); }
});
router.post('/work-order/prepare-roster', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, tabGid } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const out = await svc.prepareRosterFromWorkOrder({ sheetId, tabName, tabGid: tabGid || null, by: _by(req) });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { next(err); }
});

// ── 소유 지정 UI 좌측: 업체 목록 + 소유수 — admin/master ──
// 내부인(master/admin/staff) 미들웨어 — 소유지정 초기매핑을 AE(staff)에게 개방하되 advertiser(외부)는 차단.
//   staff 쓰기(생성·소유 지정/해제)는 아래 라우트별 inad_pm 게이트로 "자기 담당 업체"에 한정.
function internalMiddleware(req, res, next) {
  const r = _role(req);
  if (r === 'master' || r === 'admin' || r === 'staff') return next();
  return res.status(403).json({ ok: false, error: '권한 없음' });
}

router.get('/advertisers', authMiddleware, internalMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, items: await svc.listAdvertisersWithOwnership() }); }
  catch (err) { next(err); }
});

// ── Track B 업체(거래처) 생성 — 내부인. staff는 inad_pm=자기 로그인명 강제(서버 강제, 타 AE 명의 차단). ──
router.post('/advertisers', authMiddleware, internalMiddleware, async (req, res, next) => {
  try {
    const { name, inad_pm } = req.body || {};
    const out = await svc.createAdvertiserScoped({ name, inadPm: inad_pm, role: _role(req), byName: (req.admin && req.admin.name) || '' });
    res.status(out.ok ? 200 : (out.code || 400)).json(out);
  } catch (err) { next(err); }
});

// ── 이미 소유 지정된 시트 ID 목록 — 업체추가 폼 시트 드롭다운에서 제외용(내부인). ──
router.get('/owned-sheets', authMiddleware, internalMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, sheetIds: await svc.ownedSheetIds() }); }
  catch (err) { next(err); }
});

// ── 광고주(거래처) 로그인 계정 관리 — master/admin. /api/admin/advertiser-users 와 동일 로직을
//   Track B 표면(/api/trackb/*)으로도 노출: 인트라넷 SSO 관리자 토큰(via:intranet)은 /api/admin/* 격리라
//   소유지정 UI에서 계정을 발급하려면 이 경로가 필요하다. 실제 CRUD는 auth.service 재사용(로직 단일). ──
router.post('/advertiser-account', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { action, name, pw, newPw, active, advertiserId } = req.body || {};
    if (action === 'add') return res.json(await authSvc.addAdvertiserUser(name, pw, advertiserId));
    if (action === 'edit') return res.json(await authSvc.editAdvertiserUser(name, newPw || pw, active));
    if (action === 'delete') return res.json(await authSvc.deleteAdvertiserUser(name));
    if (action === 'list') return res.json({ success: true, users: await authSvc.listAdvertiserUsers() });
    return res.status(400).json({ error: '알 수 없는 action: ' + action });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── 업체(거래처) 삭제(soft) — master/admin 전용. 포털 공유 원장이라 status='ended'로 숨김(가역)+소유 매핑 해제. ──
router.delete('/advertisers/:id', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const out = await svc.deleteAdvertiser({ advertiserId: req.params.id, by: _by(req) });
    res.status(out.ok ? 200 : (out.code || 400)).json(out);
  } catch (err) { next(err); }
});

// ── 인트라넷 광고주DB 자동완성 프록시(거래처명) — 내부인. 이름·담당자·대표자명·사업자등록번호 반환
//   (대표자·사업자번호는 사업자등록 공개정보 — 급여·근태 등 인트라넷 민감필드는 미노출). ──
router.get('/intranet/advertisers', authMiddleware, internalMiddleware, async (req, res, next) => {
  try { res.json(await svc.intranetAdvertisers({ q: req.query.q, limit: req.query.limit })); }
  catch (err) { next(err); }
});

// ── 인트라넷 사용자(AE) 자동완성 프록시 — 담당AE 매칭 전용. 이름·아이디·부서만(민감필드 미노출).
//   dept=AE 등 부서 필터 지원(담당AE 후보를 AE 부서로 제한). ──
router.get('/intranet/users', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try { res.json(await svc.intranetStaffUsers({ q: req.query.q, limit: req.query.limit, dept: req.query.dept })); }
  catch (err) { next(err); }
});

// ── 담당 AE(inad_pm) 매칭/변경 — master/admin 전용(스코프 재배치는 관리자 소관, staff 자기지정은 생성 시 강제). ──
router.post('/advertisers/inad-pm', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { advertiserId, inadPm } = req.body || {};
    const out = await svc.setAdvertiserInadPm({ advertiserId, inadPm, by: _by(req) });
    res.status(out.ok ? 200 : (out.code || 400)).json(out);
  } catch (err) { next(err); }
});

// ── 업체 소유 시트의 전체 탭 나열(최신 관측순) — 내부인 ──
router.get('/ownership/tabs', authMiddleware, internalMiddleware, async (req, res, next) => {
  try {
    if (!req.query.advertiserId) return res.status(400).json({ ok: false, error: 'advertiserId 필수' });
    res.json({ ok: true, items: await svc.ownedTabsForAdvertiser({ advertiserId: req.query.advertiserId }) });
  } catch (err) { next(err); }
});

// ── 연결탭 정산 요약(견적서일·계산서일·입금액/총비용·입금일) — 내부인(광고주 미도달, 금액 포함). ──
//   링크된 탭만 인트라넷 프록시. 소유지정 패널이 탭 목록 렌더 후 비동기로 채움.
router.get('/ownership/settlement', authMiddleware, internalMiddleware, async (req, res, next) => {
  try {
    if (!req.query.advertiserId) return res.status(400).json({ ok: false, error: 'advertiserId 필수' });
    res.json({ ok: true, items: await svc.settlementSummaryForAdvertiser({ advertiserId: req.query.advertiserId }) });
  } catch (err) { next(err); }
});

// ── 연결탭 비고(자유 텍스트) 저장 — master/admin 전체 · staff 담당 탭만(_ensureEditScope). ──
router.post('/tab-memo', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, memo } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    res.json(await svc.saveTabMemo({ sheetId, tabName, memo, by: _by(req) }));
  } catch (err) { next(err); }
});

// ── 업체 소유 매핑(1:N) — 읽기=내부인 · 쓰기=admin/master 전체, staff는 자기 담당(inad_pm) 업체만 ──
router.get('/ownership', authMiddleware, internalMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, items: await svc.listOwnership({ advertiserId: req.query.advertiserId, sheetId: req.query.sheetId }) }); }
  catch (err) { next(err); }
});
async function _ownershipWriteAllowed(req, advertiserId) {
  if (_role(req) !== 'staff') return true;   // master/admin — 전체 허용(기존 시맨틱)
  return svc.staffOwnsAdvertiser({ advertiserId, staffName: (req.admin && req.admin.name) || '' });
}
router.post('/ownership', authMiddleware, internalMiddleware, async (req, res, next) => {
  try {
    const { advertiserId, sheetId, tabGid } = req.body || {};
    if (!advertiserId || !sheetId) return res.status(400).json({ ok: false, error: 'advertiserId, sheetId 필수' });
    if (!(await _ownershipWriteAllowed(req, advertiserId))) return res.status(403).json({ ok: false, error: '담당(inad_pm)이 아닌 업체의 소유는 지정할 수 없습니다.' });
    // staff 자가 스코프 확장 차단: 타 AE/업체가 이미 소유한 시트는 초기매핑 대상 아님(admin 소관).
    if (_role(req) === 'staff' && !(await svc.sheetAssignableByStaff({ sheetId, staffName: (req.admin && req.admin.name) || '' }))) {
      return res.status(403).json({ ok: false, error: '이미 다른 업체/담당이 소유한 시트입니다. 재배치는 관리자에게 요청하세요.' });
    }
    res.json({ ok: true, ...(await svc.setOwnership({ advertiserId, sheetId, tabGid: tabGid || null, by: _by(req) })) });
  } catch (err) { next(err); }
});
router.delete('/ownership', authMiddleware, internalMiddleware, async (req, res, next) => {
  try {
    const { advertiserId, sheetId, tabGid } = req.body || {};
    if (!advertiserId || !sheetId) return res.status(400).json({ ok: false, error: 'advertiserId, sheetId 필수' });
    if (!(await _ownershipWriteAllowed(req, advertiserId))) return res.status(403).json({ ok: false, error: '담당(inad_pm)이 아닌 업체의 소유는 해제할 수 없습니다.' });
    res.json({ ok: true, ...(await svc.removeOwnership({ advertiserId, sheetId, tabGid: tabGid || null })) });
  } catch (err) { next(err); }
});

// ── 통합 작업대 데이터(읽기): 세부+명단+상태. 역할 렌즈(광고주는 소유 스코프+PII 마스킹) ──
router.get('/workdesk', authMiddleware, async (req, res, next) => {
  try {
    // 역할 렌즈: master/admin(전체) · staff(AE, 담당 탭+전체 PII) · advertiser(소유 탭+마스킹). reviewer 차단.
    const role = _role(req);
    if (!['master', 'admin', 'staff', 'advertiser'].includes(role)) return res.status(403).json({ ok: false, error: '작업대 열람 권한이 없습니다.' });
    const { sheetId, tabName, tabGid } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const advertiserId = (req.admin && req.admin.advertiser_id) || null;
    const out = await svc.workdeskTab({ sheetId, tabName, tabGid: tabGid || null, role, advertiserId, staffName: (req.admin && req.admin.name) || null });
    if (out.denied) return res.status(403).json({ ok: false, error: '스코프 밖 작업(담당/소유 아님)' });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// ══ P2 정산 파이프라인 — 탭 ↔ 인트라넷 계약/견적 링크 + 프록시 스텝퍼 + 광고주 노출 토글. ══
//   ★ 인트라넷 D1 무접촉(HTTP GET 프록시만). 링크는 trackb_settlement_links 만 write.
router.get('/settlement/sales-search', authMiddleware, internalMiddleware, async (req, res, next) => {
  try { res.json(await svc.intranetSalesSearch({ q: req.query.q, limit: req.query.limit })); }
  catch (err) { next(err); }
});
router.post('/settlement/link', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, salesId, quoteId } = req.body || {};
    if (!sheetId || !tabName || !salesId) return res.status(400).json({ ok: false, error: 'sheetId, tabName, salesId 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });   // 내부(master/admin/staff 담당)만 링크
    res.json(await svc.linkSettlement({ sheetId, tabName, salesId, quoteId, by: _by(req) }));
  } catch (err) { next(err); }
});
router.post('/settlement/unlink', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    res.json(await svc.unlinkSettlement({ sheetId, tabName }));
  } catch (err) { next(err); }
});
// 정산 스텝퍼 조회 — 역할 렌즈(광고주 소유 탭 + 노출토글 게이트는 서비스가 처리).
router.get('/workdesk/settlement', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureThreadScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });   // 내부+광고주 소유 탭
    const out = await svc.settlementForTab({ sheetId, tabName, role: _role(req), advertiserId: (req.admin && req.admin.advertiser_id) || null });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});
router.post('/settlement/visibility', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { advertiserId, visible } = req.body || {};
    res.json(await svc.setSettlementVisible({ advertiserId, visible, by: _by(req) }));
  } catch (err) { next(err); }
});

// ── P3 마감자료: 생성(내부만) + CSV 다운로드(내부·소유 광고주, PII) ──
router.post('/settlement/closeout', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });   // 내부(master/admin/staff 담당)만 생성
    const out = await svc.generateCloseout({ sheetId, tabName, by: _by(req) });
    res.status(out.ok ? 200 : (out.code || 400)).json(out);
  } catch (err) { next(err); }
});
router.get('/settlement/closeout.csv', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureThreadScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });   // 내부 + 소유 광고주(reviewer 차단)
    // 광고주는 정산 노출 토글 OFF 면 CSV(PII)도 차단(N-2: 경량 게이트 — 인트라넷 프록시 왕복 없음).
    if (_role(req) === 'advertiser') {
      const visible = await svc.settlementVisibleFor((req.admin && req.admin.advertiser_id) || null);
      if (!visible) return res.status(403).json({ ok: false, error: '정산 정보가 비공개로 설정되어 있습니다.' });
    }
    const csv = await svc.closeoutCsv({ sheetId, tabName, role: _role(req) });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="closeout_${encodeURIComponent(tabName)}.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

// ══ P1 탭 스레드(협업 코멘트 + 확인요청 + 내부 메모) — 역할 스코프(_ensureThreadScope). ══
//   광고주(외부)도 자기 소유 탭에 양방향 작성. 내부 전용 글(internal_only)은 서비스가 광고주 조회에서 제외.
router.get('/workdesk/thread', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureThreadScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const role = _role(req);
    const items = await svc.listThread({ sheetId, tabName, role });
    // 열람 마킹(미확인 배지 기준) — best-effort.
    await svc.markThreadSeen({ sheetId, tabName, role, name: (req.admin && req.admin.name) || '', advertiserId: (req.admin && req.admin.advertiser_id) || null }).catch(() => {});
    res.json({ ok: true, items, canInternal: role !== 'advertiser' });
  } catch (err) { next(err); }
});
router.post('/workdesk/thread', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, body, internalOnly, asRequest } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureThreadScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const out = await svc.addThread({ sheetId, tabName, body, internalOnly, asRequest, role: _role(req), name: (req.admin && req.admin.name) || '' });
    res.status(out.ok ? 200 : (out.code || 400)).json(out);
  } catch (err) { next(err); }
});
router.post('/workdesk/thread/:id/status', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, status } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureThreadScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const out = await svc.setRequestStatus({ id: req.params.id, sheetId, tabName, status, role: _role(req), name: (req.admin && req.admin.name) || '' });
    res.status(out.ok ? 200 : (out.code || 400)).json(out);
  } catch (err) { next(err); }
});
router.delete('/workdesk/thread/:id', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureThreadScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const out = await svc.deleteThread({ id: req.params.id, sheetId, tabName, role: _role(req), name: (req.admin && req.admin.name) || '' });
    res.status(out.ok ? 200 : (out.code || 400)).json(out);
  } catch (err) { next(err); }
});
// 미확인 배지(작업목록/헤더). body 없이 스코프 전체, 또는 tabs=[{sheetId,tabName}] 로 특정.
router.post('/workdesk/unseen', authMiddleware, async (req, res, next) => {
  try {
    const role = _role(req);
    if (!['master', 'admin', 'staff', 'advertiser'].includes(role)) return res.status(403).json({ ok: false, error: '권한 없음' });
    const tabs = Array.isArray(req.body && req.body.tabs) ? req.body.tabs.slice(0, 500) : null;
    const out = await svc.unseenCounts({ role, name: (req.admin && req.admin.name) || '', advertiserId: (req.admin && req.admin.advertiser_id) || null, tabs });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// ── 통합 작업대 편집(오버레이) — master/admin 전체 · staff(AE) 담당 탭만 · advertiser 차단(_ensureEditScope). ──
//   rowId ∈ (sheetId,tabName) 재검증·앵커 산출·거부조건은 서비스가 수행.
router.post('/workdesk/edit', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, rowId, field, value } = req.body || {};
    if (!sheetId || !tabName || !rowId || !field) return res.status(400).json({ ok: false, error: 'sheetId, tabName, rowId, field 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const out = await svc.editWorkdeskRow({ sheetId, tabName, rowId, field, value, by: _by(req) });
    res.status(out.ok ? 200 : (out.error === 'concurrent_edit_conflict' ? 409 : 400)).json(out);
  } catch (err) { next(err); }
});
router.post('/workdesk/revert', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, rowId, field } = req.body || {};
    if (!sheetId || !tabName || !rowId || !field) return res.status(400).json({ ok: false, error: 'sheetId, tabName, rowId, field 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    res.json(await svc.revertWorkdeskEdit({ sheetId, tabName, rowId, field, by: _by(req) }));
  } catch (err) { next(err); }
});
router.post('/workdesk/hide', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, rowId } = req.body || {};
    if (!sheetId || !tabName || !rowId) return res.status(400).json({ ok: false, error: 'sheetId, tabName, rowId 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    res.json(await svc.hideWorkdeskRow({ sheetId, tabName, rowId, by: _by(req) }));
  } catch (err) { next(err); }
});
// ── 편집 이력(감사) — master/admin 전체 · staff 담당 탭만 ──
router.get('/workdesk/edits', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, limit } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    res.json({ ok: true, items: await svc.listEdits({ sheetId, tabName, limit }) });
  } catch (err) { next(err); }
});
router.post('/workdesk/add', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, reviewerName, recipientName, phone, round, optionText, productName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    res.json({ ok: true, ...(await svc.addWorkdeskRow({ sheetId, tabName, reviewerName, recipientName, phone, round, optionText, productName, by: _by(req) })) });
  } catch (err) { next(err); }
});

module.exports = router;
