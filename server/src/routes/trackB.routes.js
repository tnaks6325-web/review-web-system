/**
 * Track B — 백그라운드 평행 트랙(리뷰웹시스템[3버전]의 그림자) 라우트.
 *
 * ★ 무영향·격리: 투영/대조/소유/작업보드는 master 전용. 작업보드 읽기는 advertiser(광고주)에게도
 *   "본인 소유 탭만" 열되(스코프 강제 + PII 마스킹), 라이브 검색·주문·시트 흐름을 일절 안 건드린다.
 *   되돌리기 = app.js 마운트 제거.
 */
const express = require('express');
const router = express.Router();
const { authMiddleware, masterOnlyMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');
const svc = require('../services/trackB.service');
const participants = require('../services/participants.service');
const authSvc = require('../services/auth.service');
const { advertiserLinkLimiter } = require('../middleware/rateLimit.middleware');
const sheetlessStatus = require('../services/sheetlessStatus.service');
// ★ 이 파일은 예전부터 `logger` 를 최상위 import 없이 써 왔다(review-inspect 목록 실패 경로) —
//   그 자리는 평소 안 타서 드러나지 않았을 뿐 ReferenceError 였다. 여기서 함께 바로잡는다.
const { logger } = require('../utils/logger');

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

// 작업표 셀 값 편집/붙여넣기는 내부 직원 모두에게 허용한다.
// 마감·정산처럼 작업의 상태나 금액을 바꾸는 기능은 위의 담당 작업 스코프를 계속 사용한다.
async function _ensureWorkdeskCellEditScope(req) {
  const role = _role(req);
  if (role === 'master' || role === 'admin' || role === 'staff') return { ok: true };
  return { ok: false, code: 403, error: '편집 권한이 없습니다.' };
}

// 스레드 스코프 가드: master/admin=전체 · staff=담당 탭 · advertiser=소유 탭(양방향 협업이라 read/write 동일) · reviewer 차단.
//   ★ (sheetId, tabName) 기준 canAccessTab(gid 신뢰 금지). 광고주 내부글 제외는 서비스(internal_only 필터)가 담당.
async function _ensureThreadScope(req, sheetId, tabName) {
  const role = _role(req);
  if (role === 'master' || role === 'admin') return { ok: true };
  if (role === 'staff' || role === 'advertiser') {
    const okc = await svc.canAccessTab({ role, staffName: (req.admin && req.admin.name) || null, advertiserId: (req.admin && req.admin.advertiser_id) || null, sheetId, tabName });
    if (!okc) return { ok: false, code: 403, error: '스코프 밖 탭(담당/소유 아님)' };
    // 094: 브랜드 링크 세션은 소유 탭 중에서도 **그 브랜드에 배정된 탭만**(타 브랜드 작업 도달 불가).
    if (role === 'advertiser' && req.admin && req.admin.brand_id) {
      const okb = await svc.brandTabAllowed({ brandId: req.admin.brand_id, advertiserId: req.admin.advertiser_id, sheetId, tabName });
      if (!okb) return { ok: false, code: 403, error: '스코프 밖 탭(브랜드 미배정)' };
    }
    return { ok: true };
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
    // 작업보드에서는 내부 직원이 모든 작업표를 보고 편집한다. 광고주는 소유 탭만 유지한다.
    const tabs = await svc.scopedActiveTabs({ role, staffName: req.admin && req.admin.name, advertiserId: (req.admin && req.admin.advertiser_id) || null, limit: req.query.limit, forMapping: req.query.forMapping === '1', allStaff: role === 'staff' });
    // ── 마감(전사 공통) 주석 + 작업목록 통계(?stats=1) ── migration 088 · PRD prd-workboard-worktabs.html
    //   ★ 스코프 단일 출처는 위 scopedActiveTabs 하나 — 여기서는 그 결과에 **주석만** 얹는다.
    //     서버가 마감 탭을 거르지 않는 이유 = 홈 "마감 보관함"이 같은 응답에서 마감분을 골라 그린다.
    //   ★ 광고주(외부)에게는 주석을 붙이지 않는다 — 마감자(직원 이름)·담당자·캠페인명은 내부 정보다.
    // ★ 목록이 상한에 닿았는지 알린다 — 마감 탭도 이 상한을 차지하므로(서버가 거르지 않는다) 마감이
    //   쌓이면 **진행 중 작업이 조용히 잘려 나간다**. 잘림을 숨기면 "목록이 짧은 게 작업이 적어서인지
    //   잘려서인지" 구분되지 않는다(투영 커버리지 truncated 선례).
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 2000);
    const out = { ok: true, count: tabs.length, tabs, truncated: tabs.length >= lim };
    if (role !== 'advertiser') {
      const fin = await svc.finishedTabsMap();
      // stats=1 은 홈 작업 목록 전용(담당자·인원/제출/입금). 실패해도 목록 자체는 그대로 뜬다(fail-soft).
      const stats = req.query.stats === '1' ? await svc.tabStatsMap() : null;
      // ★★ 조회 실패를 **응답에 실어** 프론트가 기존 주석을 덮지 않게 한다 — 빈 맵만 주면 프론트가
      //   "아무것도 마감 안 됨"으로 읽어 **마감 작업 전부가 작업보드로 되살아나고 보관함이 빈다**(무신호).
      // 오늘 완료(전사 공통, migration 089) — 마감과 **다른 상태**다. 마감은 보드에서 빼고,
      //   오늘 완료는 뒤로 밀고 회색으로만 표시한다(다음날 자동 해제).
      const daily = await svc.dailyDoneMap();
      // 연결된 모집공고 주석([공고] 버튼 재료) — 홈 작업 목록 전용(stats=1). 실패해도 목록은 뜬다.
      //   ★ 조회 실패를 빈 맵으로 접으면 화면이 "공고 없음"으로 읽어 **이미 있는 공고를 또 발행**한다.
      //   ★ fresh=1 = 공고를 방금 저장한 직후의 재조회(30초 캐시를 건너뛴다). 없으면 발행하고도
      //     한동안 [＋공고발행]이 그대로 남아 "저장이 안 된 것"으로 보인다.
      const camps = req.query.stats === '1' ? await svc.tabCampaignsMap({ force: req.query.fresh === '1' }) : null;
      if (!fin.ok) out.finishedUnavailable = true;
      if (stats && !stats.ok) out.statsUnavailable = true;
      if (camps && !camps.ok) out.campaignsUnavailable = true;
      if (!daily.ok) out.dailyUnavailable = true;
      out.kstDate = daily.date;          // 화면이 "오늘"의 기준을 서버 시각으로 잡게(클라 시계 불신)
      for (const t of tabs) {
        // 이름 우선 → gid 폴백(운영 중 탭 리네임으로 마감이 조용히 풀리는 것 방지)
        const g = String(t.tabGid == null ? '' : t.tabGid).trim();
        const f = fin.map[`${t.sheetId}\t${t.tabName}`] || (g ? fin.map[`${t.sheetId}\tgid:${g}`] : null);
        if (f) { t.finished = true; t.finishedAt = f.finishedAt; t.finishedBy = f.finishedBy; }
        // ★ 오늘 완료는 **이름으로만** 찾는다(마감과 달리 gid 폴백이 없다) — 의도된 비대칭:
        //   `trackb_tab_daily_done` 에는 tab_gid 컬럼이 없고, 이 상태는 **하루짜리**라 리네임으로 풀려도
        //   다음날 어차피 초기화된다. 마감은 영구라 리네임 한 번에 보관함에서 사라지면 피해가 크다.
        const d = daily.map[`${t.sheetId}\t${t.tabName}`];
        if (d) { t.todayDone = true; t.todayDoneBy = d.doneBy; }
        // ★ stats 맵은 전 탭 무스코프다 — 응답엔 **이 루프로 걸러진 탭의 값만** 실린다(맵 자체 전달 금지).
        if (stats && stats.map[`${t.sheetId}\t${t.tabName}`]) t.stats = stats.map[`${t.sheetId}\t${t.tabName}`];
        // ★ 공고 주석도 **이 루프로 걸러진 탭의 값만** 실린다(맵 자체 전달 금지 — stats 와 같은 규율).
        //   이름 우선 → gid 폴백(마감 주석과 같은 키 규칙). 한 탭에 여럿이면 그대로 배열로 내려보내
        //   화면이 생성일과 함께 보여주고 고르게 한다(사용자 확정).
        if (camps) {
          const c = camps.map[`${t.sheetId}\t${t.tabName}`] || (g ? camps.map[`${t.sheetId}\tgid:${g}`] : null);
          if (c && c.length) t.campaigns = c;
        }
      }
    }
    res.json(out);
  } catch (err) { next(err); }
});

// ── 홈 [저장폴더] 현영 버튼 — [리뷰]/{현금영수증} 서브폴더 해석 ──────────────────────
//   현영 서브폴더는 업로드 시 즉석 생성되고 URL 이 어디에도 저장돼 있지 않다(리뷰·구매캡처와 다른 점).
//   ★ find-only — 여기서 폴더를 만들지 않는다(사용자 확정 Q2). 폴더 생성 경로는 업로드(review-upload)·
//     스마트빌드(reviewFolders) 단일 경로 유지 — 사본 경로를 두면 라벨·소유권 규칙이 갈라진다.
//   ★ fail-soft — 어떤 실패도 200 + 사유로 돌려준다(클릭 한 번에 500 을 보여줄 이유가 없다).
//   찾은 URL 은 불변이라 길게(10분), 미발견은 짧게(60초 — 그 사이 첫 현영 캡처가 올 수 있다) 캐시.
const _tabFolderCache = new Map();
const _tabFolderInfoCache = new Map();
router.get('/tab-folders', authMiddleware, internalMiddleware, async (req, res) => {
  const sheetId = String(req.query.sheetId || '').trim();
  const tabName = String(req.query.tabName || '').trim();
  if (!sheetId || !tabName) return res.json({ ok: false, error: 'sheetId·tabName이 필요합니다.' });
  // kind=info = 작업보드 상단 폴더 버튼용 **가산 분기** — 그 탭의 세 폴더 재료를 한 번에 알려준다.
  //   ★ 신규 엔드포인트 0(같은 라우트·같은 스코프 게이트) + Drive 무접촉(tab_configs 한 줄 조회).
  //   ★ 홈처럼 stats=1(review_index 전체 GROUP BY)을 붙이지 않는다 — 작업 탭을 열 때마다 무거운
  //     집계를 돌리는 것은 CLAUDE.md 가 못박은 금지선이다. 여기선 그 탭 한 줄만 읽는다.
  const wantInfo = String(req.query.kind || '') === 'info';
  const key = `${sheetId}\t${tabName}`;
  try {
    // ★★ 스코프 게이트가 **캐시보다 먼저**다(코드리뷰가 잡은 실측 구멍): 캐시 히트를 위에서 반환하면
    //   누군가 그 탭을 최근에 열어 둔 동안 **담당 밖 AE 가 Drive 링크를 그대로 받는다**(60초/10분 창).
    //   "폴더 URL 도 담당 스코프 밖으로 새지 않는다"는 이 라우트의 불변식이 캐시 한 줄로 무력화됐다.
    //   순서 고정 = 파싱 → **스코프** → 캐시 → 작업.
    if (_role(req) === 'staff') {
      const okc = await svc.canAccessTab({ role: 'staff', staffName: req.admin && req.admin.name, sheetId, tabName });
      if (!okc) return res.status(403).json({ ok: false, error: '담당하지 않은 작업(스코프 밖)' });
    }
    if (wantInfo) {
      const ih = _tabFolderInfoCache.get(key);
      if (ih && Date.now() - ih.at < 60000) return res.json({ ok: true, kind: 'info', ...ih.val });
    } else {
      const hit = _tabFolderCache.get(key);
      if (hit && Date.now() - hit.at < (hit.url ? 600000 : 60000)) {
        return res.json({ ok: !!hit.url, url: hit.url || null, error: hit.url ? undefined : hit.msg });
      }
    }
    const { cashReceiptSlotInfo, CR_MISCONFIG_NOTE } = require('../utils/captureSlots');
    if (wantInfo) {
      const r = await pool.query(
        `SELECT folder_url, capture_folder_url, capture_slots, income_type
           FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
      const t = r.rows[0];
      if (!t) return res.json({ ok: false, kind: 'info', error: '등록되지 않은 탭입니다.' });
      const cri = cashReceiptSlotInfo(t.capture_slots, t.income_type);
      const val = {
        folderUrl: t.folder_url || null,
        captureFolderUrl: t.capture_folder_url || null,
        cashReceipt: !!cri.slot,
        // 오설정(현영인데 슬롯 없음)일 때만 실린다 — 버튼 툴팁이 '대상 아님'으로 뭉개지 않게.
        ...(!cri.slot && cri.incomeSaysCashReceipt ? { cashReceiptNote: CR_MISCONFIG_NOTE } : {}),
      };
      _tabFolderInfoCache.set(key, { at: Date.now(), val });
      // ★ kind 를 되돌려준다 — 프론트가 **이 응답이 info 응답인지** 확인할 유일한 표식이다.
      //   구버전 백엔드는 kind 를 모르고 현영(receipt) 분기로 답하는데, 표식이 없으면 프론트가 그
      //   `{ok:true,url}` 을 info 로 오독해 "폴더 미생성"으로 위장한다(배포 스큐 실측 시나리오).
      return res.json({ ok: true, kind: 'info', ...val });
    }
    const { rows } = await pool.query(
      `SELECT folder_url, capture_slots, income_type FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`,
      [sheetId, tabName]);
    const tc = rows[0];
    if (!tc) return res.json({ ok: false, error: '등록되지 않은 탭입니다.' });
    // ★ 현영 대상 판정은 captureSlots.cashReceiptSlotInfo 단일 규칙 — 버튼 활성(홈·업체관리·작업보드)과
    //   이 허용 판정이 **같은 함수**여야 "눌리는데 거부"/"대상인데 안 눌림"이 생기지 않는다.
    const cr = cashReceiptSlotInfo(tc.capture_slots, tc.income_type);
    if (!cr.slot) {
      // ★ 사유를 구분한다 — 진행방식이 현영인데 슬롯에서 못 찾은 것과, 애초에 대상이 아닌 것은 다른 일이다
      //   ("대상 아님"으로 뭉개면 관리자가 무엇을 고쳐야 할지 알 수 없다).
      return res.json({ ok: false, error: cr.incomeSaysCashReceipt ? CR_MISCONFIG_NOTE : '현금영수증 발행 대상 작업이 아닙니다.' });
    }
    const driveService = require('../services/drive.service');   // 지연 require — 테스트가 이 라우터를 스텁 pool 로 실행할 때 Drive 스택 무부하
    const reviewFolderId = tc.folder_url ? driveService.extractFolderIdFromUrl(tc.folder_url) : null;
    if (!reviewFolderId) {
      return res.json({ ok: false, error: '리뷰 폴더가 아직 없습니다 — 첫 캡처 제출(또는 스마트빌드 주기) 시 자동 생성됩니다.' });
    }
    // ★ 폴더 이름 = 그 슬롯의 **실제 라벨**(업로드가 그 라벨로 서브폴더를 만든다).
    //   종전 `slotLabel(...,'receipt')` 은 수동 슬롯 탭(key=slot2)에서 문자열 'receipt' 를 뒤졌다.
    const label = (cr.slot && cr.slot.label) || '현금영수증';
    const found = await driveService.findFolderByName(label, reviewFolderId);   // ★ find-only
    if (!found) {
      const msg = '현영 캡처가 아직 없어 폴더가 만들어지지 않았습니다.';
      _tabFolderCache.set(key, { at: Date.now(), url: null, msg });
      return res.json({ ok: false, error: msg });
    }
    const url = found.webViewLink || `https://drive.google.com/drive/folders/${found.id}`;
    _tabFolderCache.set(key, { at: Date.now(), url });
    res.json({ ok: true, url });
  } catch (err) {
    logger.warn(`[trackB] tab-folders 해석 실패(${tabName}): ${err.message}`);
    res.json({ ok: false, error: '폴더 정보를 불러오지 못했습니다 — 잠시 후 다시 시도해 주세요.' });
  }
});

// ── 열린 작업 줄(개인별·순서 보존) — 작업보드 로그인 사용자 누구나(자기 것만) ──
//   ★ 즐겨찾기와 같은 골격이되 **별도 원장**: 즐겨찾기는 Set 으로 접혀 순서가 사라진다(migration 089 주석).
router.get('/workdesk/worktabs', authMiddleware, async (req, res, next) => {
  try {
    const r = await svc.getWorkdeskWorktabs(_by(req));
    // ★ 조회 실패를 고지한다 — 없으면 프론트가 빈 배열을 "저장된 줄 없음"으로 신뢰해 로컬을 덮고,
    //   다음 저장에서 서버 행이 통째로 대체된다(사용자 데이터 영구 삭제).
    res.json({ ok: true, tabs: r.tabs, ...(r.ok ? {} : { worktabsUnavailable: true }) });
  } catch (err) { next(err); }
});
router.post('/workdesk/worktabs', authMiddleware, async (req, res, next) => {
  try {
    const out = await svc.setWorkdeskWorktabs(_by(req), (req.body && req.body.tabs));
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { next(err); }
});

// ── 오늘 완료 토글(전사 공통) — 마감과 같은 스코프 게이트, 검수 확인은 없다(가벼운 토글) ──
router.post('/workdesk/tab-daily-done', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, done } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const scope = await _ensureEditScope(req, sheetId, tabName);
    if (!scope.ok) return res.status(scope.code || 403).json({ ok: false, error: scope.error });
    // 해제는 명시적으로만(마감 라우트와 같은 규율 — 'false'·0 을 완료로 오해하지 않는다)
    const wantDone = !(done === false || done === 'false' || done === 0 || done === '0');
    const out = await svc.setTabDailyDone({ sheetId, tabName, done: wantDone, by: _by(req) });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { next(err); }
});

// ── 작업 마감/복귀(전사 공통) — master/admin 전체 · staff 담당 탭만 · advertiser 차단 ──
//   ★ finish=true 는 body.inspected(리뷰폴더 마감자료 검수 확인) 없이는 서비스가 거부한다 —
//     확인창 체크를 우회한 요청을 서버가 막는다(프론트만 믿지 않는다).
router.post('/workdesk/tab-finish', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, tabGid, finish, inspected } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const scope = await _ensureEditScope(req, sheetId, tabName);
    if (!scope.ok) return res.status(scope.code || 403).json({ ok: false, error: scope.error });
    // ★ 복귀는 명시적으로만 — `finish !== false` 로 두면 문자열 'false'·0 이 **마감으로** 해석된다.
    const wantFinish = !(finish === false || finish === 'false' || finish === 0 || finish === '0');
    const out = await svc.setTabFinished({
      sheetId, tabName, tabGid,
      finish: wantFinish, inspected: inspected === true, by: _by(req),
    });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { next(err); }
});

// ── 작업목록 즐겨찾기(로그인 계정별 개인화·영속) — 작업보드 로그인 사용자 누구나(자기 것만) ──
router.get('/workdesk/favorites', authMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, favorites: await svc.getWorkdeskFavorites(_by(req)) }); }
  catch (err) { next(err); }
});
router.post('/workdesk/favorites', authMiddleware, async (req, res, next) => {
  try {
    const out = await svc.setWorkdeskFavorites(_by(req), (req.body && req.body.favorites));
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { next(err); }
});

// ── 관측 대시보드: 투영된 전 탭 롤업(카운트 대조 + 준비도) — adminOrMaster ──
//   coverage = 투영완료/총작업 · 미투영 요약(읽기 전용). items 는 **투영된 탭만** 담으므로 미투영 탭은
//   목록에 아예 없다 → 분모를 따로 실어 보내야 화면이 "총 몇 개 중 몇 개"를 말할 수 있다.
//   ★ 부가 신호라 **fail-soft**: 커버리지 조회가 실패해도 관측 목록 자체는 그대로 뜬다(null = 화면 '?').
//     필드 부재(구버전 백엔드)와 null(조회 실패)을 프론트가 구분한다 — 배포 스큐 허위 정상 차단.
router.get('/overview', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const items = await svc.overview();
    // items 를 재료로 넘겨 "투영완료 = 이 목록에 뜨는 탭"을 구조적으로 보장(+ 중복 조회 제거).
    const coverage = await svc.projectionCoverage({ projectedTabs: items }).catch(e => {
      logger.warn(`[trackB] projectionCoverage 실패: ${e.message}`);
      return null;
    });
    res.json({ ok: true, items, coverage });
  } catch (err) { next(err); }
});
// ── 시트 데이터 반영 점검(sheet-sync audit) — adminOrMaster ──
//   등록된 작업(tab_configs) 전수를 분모로 "시트 → 검색인덱스 → 작업보드" 반영 사슬의 끊긴 곳을
//   진단(읽기 전용·시트 API 무접촉). ?before=YYYY-MM-DD 면 그 날짜 이전 등록(+ 등록일 미상)만.
//   수리는 기존 반영 경로 3개(mirrorOneSheet → buildOneSheet → projectTab)만 재사용 — 신규 쓰기 경로 0.
const sheetSync = require('../services/sheetSyncAudit.service');
router.get('/sheet-sync/audit', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { before, limit, includeArchived, since, includeUnknown, includeIgnored } = req.query;
    res.json({ ok: true, ...(await sheetSync.auditSheetSync({
      before, limit, since,
      includeArchived: includeArchived === '1' || includeArchived === 'true',
      includeUnknown: includeUnknown === '1' || includeUnknown === 'true',
      includeIgnored: includeIgnored === '1' || includeIgnored === 'true',
    })) });
  } catch (err) { next(err); }
});
// 목록에서 제외/복원 — ★ **데이터는 지우지 않는다**(이 점검 화면 목록에서만 감춘다, 되돌리기 가능).
router.post('/sheet-sync/ignore', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, ignored } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    res.json(await sheetSync.setIgnored({ sheetId, tabName, ignored: ignored !== false, by: _by(req) }));
  } catch (err) { next(err); }
});
// 연도 확인 — 시트의 **실제 날짜값**(일련번호)을 읽어 미러가 잃어버린 연도를 되찾는다.
//   ★ 이 도구에서 **시트 API 를 쓰는 유일한 경로** — 사람이 버튼을 누를 때만 돌고, 연도 미상 탭만,
//     탭당 1콜(날짜 컬럼 한 열), throttle 을 탄다. 결과는 캐시되어 재조회 0.
router.post('/sheet-sync/year-probe', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { limit, force } = req.body || {};
    res.json(await sheetSync.probeUnknownYears({ limit, force: force === true, by: _by(req) }));
  } catch (err) { next(err); }
});
// tab_configs.tab_gid 백필 — 시트만 열리던 링크를 "그 탭이 열리는 링크"로. 기본은 미리보기.
router.post('/sheet-sync/gid-backfill', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { dryRun } = req.body || {};
    res.json(await sheetSync.backfillTabGids({ dryRun: dryRun !== false, by: _by(req) }));
  } catch (err) { next(err); }
});
// 아카이브 복구 — ★ 복구 로직은 **기존 `/api/archive/restore` 핸들러에 위임**한다(사본 금지).
//   그쪽이 index_master_archive → index_master · review_index_archive → review_index ·
//   tab_configs 재생성(is_closed=FALSE) · 이력 기록까지 한 트랜잭션으로 이미 하고 있다.
//   여기 두는 이유는 C/S·설정과 같다: 인트라넷 SSO 토큰(via:'intranet')은 /api/archive/* 에 도달 불가.
//   ★ 게이트는 원본(authMiddleware)보다 좁힌다(adminOrMaster) — 프록시가 원본보다 넓어지면 안 된다.
const _archiveRoutes = require('./archive.routes');
const _archiveRestore = _delegate(_archiveRoutes, 'post', '/restore');
router.post('/sheet-sync/unarchive', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _archiveRestore(req, res, next));

router.post('/sheet-sync/repair', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    res.json(await sheetSync.repairSheetSync({ sheetId, tabName, by: _by(req) }));
  } catch (err) { next(err); }
});

// ── 시트 우위 동기화(탈 구글시트 1차) — adminOrMaster ──
//   slot-audit  : "시트에 준비된 인원 > 시스템 표 인원"인 작업 전수 점검(읽기 전용·시트 API 무접촉)
//   slot-backfill: 시트 준비 행을 표의 빈 자리로 백필(추가만·멱등, dryRun 기본 true)
//   quota-fix   : 공고 정원을 표 인원에 맞춤(쓰기 표면 = recruit_total 두 칸, 단일 옵션만 자동)
const slotSync = require('../services/sheetSlotSync.service');
router.get('/sheet-sync/slot-audit', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { limit, scanCap, since, includeUnknown } = req.query;
    res.json({ ok: true, ...(await slotSync.auditSheetSuperiority({
      limit, scanCap, since,
      includeUnknown: includeUnknown === '1' || includeUnknown === 'true',
    })) });
  } catch (err) { next(err); }
});
router.post('/sheet-sync/slot-backfill', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, dryRun } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    // ★ 명시적으로 false 를 보낼 때만 실행 — 값이 빠지면 미리보기(파괴적 기본값 금지).
    const out = await slotSync.backfillSlots({ sheetId, tabName, dryRun: dryRun !== false, by: _by(req) });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { next(err); }
});
router.post('/sheet-sync/quota-fix', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, campaignId } = req.body || {};
    if (!sheetId || !tabName || !campaignId) return res.status(400).json({ ok: false, error: 'sheetId, tabName, campaignId 필수' });
    const out = await slotSync.applyQuotaFix({ sheetId, tabName, campaignId, by: _by(req) });
    res.status(out.ok ? 200 : 409).json(out);
  } catch (err) { next(err); }
});

/* ══════════════ 탈 구글시트 전환 관리 (W4 · C) ══════════════
   무시트 표식을 켜는 **유일한 창구**. 권한 = adminOrMaster(사용자 확정) — 실무 담당자가
   직접 이관하고, 실수 방어는 **점검표 fail-closed + 작업명 타이핑 확정**이 맡는다.
   ★ 42P01(096 미적용)은 not_ready 로 말한다 — /api/trackb/* 는 마스킹 대상이라 원인이 안 보인다. */
const cutover = require('../services/sheetlessCutover.service');
function _cutoverErr(err, res, next) {
  if (err && err.code === '42P01') {
    return res.json({ ok: false, code: 'not_ready',
      error: '탈시트 전환 준비 전입니다(migration 096 미적용) — 배포 완료 후 다시 시도해주세요.' });
  }
  return next(err);
}
router.get('/sheetless/list', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { since, includeUnknown, limit } = req.query;
    res.json(await cutover.listCutoverTabs({
      since, limit, includeUnknown: includeUnknown === '1' || includeUnknown === 'true',
    }));
  } catch (err) { _cutoverErr(err, res, next); }
});
/* 준비 자리 일괄 점검 — "우레온 같은(시트 100줄 · 표 20줄) 작업이 남아 있나"를 한 번에.
   ★ 읽기 전용 · RAW 미러만(시트 API 0) — 점검표 ①과 같은 함수로 판정한다(사본 0). */
router.get('/sheetless/slot-sweep', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { since, includeUnknown, limit } = req.query;
    res.json(await cutover.sweepPreparedRows({
      since, limit, includeUnknown: includeUnknown === '1' || includeUnknown === 'true',
    }));
  } catch (err) { _cutoverErr(err, res, next); }
});
router.get('/sheetless/checklist', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    res.json(await cutover.cutoverChecklist({ sheetId, tabName }));
  } catch (err) { _cutoverErr(err, res, next); }
});
router.post('/sheetless/cutover', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, force } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    // ★ force 는 **명시적으로 true 일 때만** — 값이 빠지거나 문자열이면 점검표를 그대로 건다.
    const out = await cutover.enableSheetless({
      sheetId, tabName, by: _by(req), force: force === true,
    });
    res.status(out.ok ? 200 : 409).json(out);
  } catch (err) { _cutoverErr(err, res, next); }
});
router.post('/sheetless/reconnect', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    res.json(await cutover.disableSheetless({ sheetId, tabName, by: _by(req) }));
  } catch (err) { _cutoverErr(err, res, next); }
});

/* ── 구글시트 주소로 작업 가져오기 (탈 구글시트 잔재 처리) — adminOrMaster ──
   preview : 시트를 1회 읽어 "무엇을 가져올지"만 돌려준다(**DB 쓰기 0**)
   run     : 등록 + 업체 소유 + 작업표 + 장부 + 무시트 표식 + 시트 안내문
   revert  : 가져오기 직후 되돌리기(주문이 들어왔으면 거부)

   ★★ **adminOrMaster 전용** — 이 경로는 접수에 이은 두 번째 등록 창구다(복원 성격 예외).
     AE 담당자에게 열면 담당 범위 밖의 시트를 시스템 작업으로 만들 수 있게 된다.
   ★ 이 경로는 재기준하지 않는다 — `/api/trackb/*` 라 관리자 토큰·인트라넷 SSO 양쪽이 그대로 닿는다. */
// 최근 5일간 리뷰 파일 원장이 있고, 현재 작업표에 과거 표기('O')가 남은 무시트 행만
// 업로드 시각으로 바꾼다. 기본은 dry-run이며 master가 확인 문구를 명시해야만 실제 변경한다.
router.post('/sheetless/review-submit-time-backfill', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const dryRun = req.body?.dryRun !== false;
    if (!dryRun && req.body?.confirm !== 'replace-o-with-submission-time') {
      return res.status(400).json({ ok: false, error: '실제 반영에는 confirm: replace-o-with-submission-time 이 필요합니다.' });
    }
    const out = await sheetlessStatus.backfillReviewSubmitTimes({ dryRun, by: _by(req) });
    res.json(out);
  } catch (err) { _cutoverErr(err, res, next); }
});

const sheetImport = require('../services/sheetImport.service');
function _importErr(err, res, next) {
  if (err instanceof sheetImport.ImportError) {
    // ★ 화면이 사유별로 다르게 안내해야 하므로 코드를 그대로 넘긴다(errorHandler 500 마스킹 방지).
    return res.status(400).json({
      ok: false, code: err.code, error: err.message,
      ...(err.availableTabs ? { availableTabs: err.availableTabs } : {}),
    });
  }
  if (err && err.code === '42P01') {
    return res.json({ ok: false, code: 'not_ready', error: '준비 전입니다 — 배포 완료 후 다시 시도해주세요.' });
  }
  return next(err);
}
router.post('/sheet-import/preview', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { url, sheetId, gid } = req.body || {};
    res.json(await sheetImport.previewSheetImport({ url, sheetId, gid }));
  } catch (err) { _importErr(err, res, next); }
});
router.post('/sheet-import/run', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { url, sheetId, gid, advertiserId, displayName, skipSeqs, notice } = req.body || {};
    res.json(await sheetImport.importSheet({
      url, sheetId, gid, advertiserId, displayName, skipSeqs,
      // ★ 안내문은 **명시적으로 false 일 때만** 끈다(값이 빠진 요청은 기본 동작 = 갱신).
      notice: notice !== false,
      by: _by(req),
    }));
  } catch (err) { _importErr(err, res, next); }
});
/* 수리 — "등록은 됐는데 어디에도 안 보이는" 작업을 되살린다(가져오기=덮어쓰기가 **아니다**).
   ★ 주문이 붙어 있어 가져오기가 막힌 작업의 **유일한 복구 경로**라 같은 권한(adminOrMaster)으로 연다. */
router.post('/sheet-import/repair', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, action, advertiserId } = req.body || {};
    res.json(await sheetImport.repairRegistered({ sheetId, tabName, action, advertiserId, by: _by(req) }));
  } catch (err) { _importErr(err, res, next); }
});
router.post('/sheet-import/revert', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const out = await sheetImport.revertImport({ sheetId, tabName, by: _by(req) });
    res.status(out.ok ? 200 : 409).json(out);
  } catch (err) { _importErr(err, res, next); }
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
// ── 일괄 cutover: "전환 가능(candidate)" 탭 전부를 단건 게이트 그대로 순차 플립 — master 전용 ──
//   ★ force 를 받지도 넘기지도 않는다(일괄 우회 금지). 게이트에 걸린 탭은 사유와 함께 보고만.
router.post('/source-of-truth/all', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, ...(await svc.cutoverAll({ by: _by(req) })) }); }
  catch (err) { next(err); }
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
  try {
    const items = await svc.listAdvertisersWithOwnership();
    // ?overview=1 — 업체관리 첫 화면(업체 미선택) 개요 표 재료를 같은 응답에 얹는다(신규 엔드포인트 0).
    //   ★ 로컬 DB만 집계(인트라넷 무접촉) · 실패 소스는 *Unavailable 플래그로 고지(0 으로 꾸미지 않는다).
    if (req.query.overview === '1') {
      const isAdmin = _role(req) === 'master' || _role(req) === 'admin';
      const ov = await svc.advertiserOverview();
      if (ov && ov.ok) {
        for (const it of items) {
          const a = ov.byAdvertiser[it.id];
          if (a) { it.works = a.works; it.noMatch = a.noMatch; it.finishCand = a.finishCand; }
          else { it.works = 0; it.noMatch = 0; it.finishCand = 0; }   // 소유 탭이 0건인 업체(집계 대상 없음)
          // ★ 접속링크 상태(공개/로그인/폐기·마지막 접속)는 **admin/master 에만** 싣는다 —
          //   링크를 다루는 다른 모든 라우트가 adminOrMaster 이고 프론트도 staff 에겐 안 그린다.
          //   서버가 프론트보다 넓어지면 그게 곧 노출이다. null = 링크 미생성(여기서 만들지 않는다).
          if (isAdmin) it.link = ov.link[it.id] || null;
        }
      }
      return res.json({ ok: true, items, overview: ov ? {
        ok: !!ov.ok, statsUnavailable: !!ov.statsUnavailable, finishedUnavailable: !!ov.finishedUnavailable,
        contractsUnavailable: !!ov.contractsUnavailable, linksUnavailable: !!ov.linksUnavailable,
      } : { ok: false } });
    }
    res.json({ ok: true, items });
  } catch (err) { next(err); }
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

// ── 광고주 접속 링크(매직 링크) 관리 — master/admin. 업체당 1토큰 발급/회전/폐기. ──
router.post('/advertiser-link', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { action, advertiserId } = req.body || {};
    if (action === 'get') return res.json({ ok: true, link: await svc.getAdvertiserLink(advertiserId) });
    if (action === 'ensure') return res.json({ ok: true, link: await svc.ensureAdvertiserLink({ advertiserId, by: _by(req) }) });
    if (action === 'generate') { const o = await svc.generateAdvertiserLink({ advertiserId, by: _by(req) }); return res.status(o.ok ? 200 : (o.code || 400)).json(o); }
    if (action === 'revoke') { const o = await svc.setAdvertiserLinkActive({ advertiserId, active: false, by: _by(req) }); return res.status(o.ok ? 200 : (o.code || 400)).json(o); }
    if (action === 'enable') { const o = await svc.setAdvertiserLinkActive({ advertiserId, active: true, by: _by(req) }); return res.status(o.ok ? 200 : (o.code || 400)).json(o); }
    // 광고주 계정 사용/미사용(=이 링크가 로그인을 요구하는지, 083). 켤 때 활성 계정 0개면 서비스가 거부.
    if (action === 'login-required') {
      const o = await svc.setAdvertiserLinkLoginRequired({ advertiserId, required: (req.body || {}).required, by: _by(req) });
      return res.status(o.ok ? 200 : (o.code || 400)).json(o);
    }
    return res.status(400).json({ ok: false, error: '알 수 없는 action: ' + action });
  } catch (err) { next(err); }
});

// ── 광고주 접속 링크 교환(공개·무인증) — 유효 토큰 → advertiser JWT(로그인 없이 진입). 레이트리밋. ──
router.post('/advertiser-link-login', advertiserLinkLimiter, async (req, res, next) => {
  try { res.json(await authSvc.loginByLinkToken((req.body || {}).token)); }
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
    // ★ 마감/통계 조회 실패는 **플래그로 고지**한다 — 조용히 빈 판정을 내려보내면 화면이 그것을
    //   "마감자료 검수 대기 0건"으로 읽어 실제 대기 건이 통째로 사라진다(088 무신호 규율).
    const own = await svc.ownedTabsForAdvertiser({ advertiserId: req.query.advertiserId, annotate: true });
    // ★★ staff(AE)는 담당 업체가 아니면 **폴더 URL 을 받지 않는다**(코드리뷰가 잡은 경계):
    //   이 목록은 업체를 골라 보는 화면이라 AE 가 남의 업체도 열 수 있는데, 응답에 Drive 링크가
    //   실려 있으면 [자료] 버튼이 곧 담당 밖 폴더 접근 수단이 된다(/tab-folders 는 서버가 막는데
    //   여기는 열려 있어 같은 불변식이 한쪽만 지켜지던 상태). 담당 여부는 한 쿼리(inad_pm).
    //   ★ 지우고 조용히 넘기지 않는다 — folderScoped:false 로 **사유를 화면이 말한다**.
    let rows = own.rows;
    let folderScoped = true;
    if (_role(req) === 'staff') {
      const mine = await svc.staffOwnsAdvertiser({ advertiserId: req.query.advertiserId, staffName: req.admin && req.admin.name });
      if (!mine) {
        folderScoped = false;
        rows = rows.map(r => ({ ...r, folderUrl: null, captureFolderUrl: null, cashReceipt: false, cashReceiptNote: undefined }));
      }
    }
    res.json({ ok: true, items: rows, statsUnavailable: own.statsUnavailable,
      finishedUnavailable: own.finishedUnavailable, ...(folderScoped ? {} : { folderScoped: false }) });
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

// ── 업체용 뷰어 "내 작업 목록"(화면 A) — 광고주 본인 소유 탭 요약 배치. ──
//   ★ advertiserId 는 쿼리가 아니라 토큰(req.admin.advertiser_id)에서만 — 남의 업체 요약 도달 불가(IDOR 차단).
//   ★ 광고주 렌즈는 서비스(advertiserWorkSummary)가 강제 — 내부 필드(비고·담당·salesId)는 응답에 아예 없음.
//   내부인은 기존 /ownership/settlement(소유지정 뷰)를 쓰므로 이 경로는 advertiser 전용으로 좁힌다.
router.get('/my-work-summary', authMiddleware, async (req, res, next) => {
  try {
    if (_role(req) !== 'advertiser') return res.status(403).json({ ok: false, error: '광고주 전용 경로입니다.' });
    const advertiserId = (req.admin && req.admin.advertiser_id) || null;
    if (!advertiserId) return res.status(403).json({ ok: false, error: '업체 연결이 없는 계정입니다.' });
    // 094: 브랜드 링크 세션(brand_id 클레임)은 배정 탭만 + 브랜드 토글 렌즈. brandId 는 토큰에서만(IDOR 차단).
    res.json({ ok: true, ...(await svc.advertiserWorkSummary({ advertiserId, brandId: (req.admin && req.admin.brand_id) || null })) });
  } catch (err) { next(err); }
});

// ── 브랜드 분류·공유(094) — 광고주(대행사) 셀프서비스. 관리자 개입 0(사용자 확정). ──
//   게이트: role=advertiser + advertiser_id + **브랜드 세션 아님**(브랜드 링크는 열람 전용 — CRUD 도달 불가).
function _advSelf(req) {
  const a = req.admin || {};
  if (a.role !== 'advertiser' || !a.advertiser_id || a.brand_id) return null;
  return a.advertiser_id;
}
router.get('/brands', authMiddleware, async (req, res, next) => {
  try {
    const advertiserId = _advSelf(req);
    if (!advertiserId) return res.status(403).json({ ok: false, error: '업체(대행사) 전용 경로입니다.' });
    const o = await svc.brandsForAdvertiser({ advertiserId });
    res.status(o.ok ? 200 : (o.code || 400)).json(o);
  } catch (err) { next(err); }
});
router.post('/brands/create', authMiddleware, async (req, res, next) => {
  try {
    const advertiserId = _advSelf(req);
    if (!advertiserId) return res.status(403).json({ ok: false, error: '업체(대행사) 전용 경로입니다.' });
    const { name, color } = req.body || {};
    const o = await svc.createBrand({ advertiserId, name, color });
    res.status(o.ok ? 200 : (o.code || 400)).json(o);
  } catch (err) { next(err); }
});
router.post('/brands/update', authMiddleware, async (req, res, next) => {
  try {
    const advertiserId = _advSelf(req);
    if (!advertiserId) return res.status(403).json({ ok: false, error: '업체(대행사) 전용 경로입니다.' });
    const { brandId, action, name, color, on } = req.body || {};
    const o = await svc.updateBrand({ advertiserId, brandId, action, name, color, on });
    res.status(o.ok ? 200 : (o.code || 400)).json(o);
  } catch (err) { next(err); }
});
router.post('/brands/assign', authMiddleware, async (req, res, next) => {
  try {
    const advertiserId = _advSelf(req);
    if (!advertiserId) return res.status(403).json({ ok: false, error: '업체(대행사) 전용 경로입니다.' });
    const { brandId, tabs } = req.body || {};
    const o = await svc.assignBrandTabs({ advertiserId, brandId, tabs });
    res.status(o.ok ? 200 : (o.code || 400)).json(o);
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
// ── 작업(소유) 이관 — 시트 전체/특정 탭의 소유를 다른 거래처로. ★ adminOrMaster 전용:
//    업체 간 재배치는 staff 초기매핑 게이트("재배치는 관리자에게 요청")와 같은 규율로 admin 소관이다. ──
router.post('/ownership/transfer', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabGid, toAdvertiserId } = req.body || {};
    const o = await svc.transferOwnership({ sheetId, tabGid: tabGid || null, toAdvertiserId, by: _by(req) });
    res.status(o.ok ? 200 : (o.code || 400)).json(o);
  } catch (err) { next(err); }
});

// ── 리뷰웹시스템[3버전] 데이터(읽기): 세부+명단+상태. 역할 렌즈(광고주는 소유 스코프+PII 마스킹) ──
router.get('/workdesk', authMiddleware, async (req, res, next) => {
  try {
    // 역할 렌즈: 내부 직원 전체 작업표 · advertiser(소유 탭+마스킹). reviewer 차단.
    const role = _role(req);
    if (!['master', 'admin', 'staff', 'advertiser'].includes(role)) return res.status(403).json({ ok: false, error: '작업보드 열람 권한이 없습니다.' });
    const { sheetId, tabName, tabGid } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const advertiserId = (req.admin && req.admin.advertiser_id) || null;
    const out = await svc.workdeskTab({ sheetId, tabName, tabGid: tabGid || null, role, advertiserId, staffName: (req.admin && req.admin.name) || null, allowAllStaff: role === 'staff' });
    if (out.denied) return res.status(403).json({ ok: false, error: '스코프 밖 작업(담당/소유 아님)' });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// Workboard label only: keep tab_name as the relational identity key.
router.post('/workdesk/title', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, displayName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const title = String(displayName == null ? '' : displayName).trim();
    if (!title || title.length > 120) return res.status(400).json({ ok: false, error: '작업명은 1~120자로 입력해 주세요.' });
    const g = await _ensureWorkdeskCellEditScope(req); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const out = await svc.setWorkdeskTitle({ sheetId, tabName, displayName: title });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { next(err); }
});

// ══ P2 정산 파이프라인 — 탭 ↔ 인트라넷 계약/견적 링크 + 프록시 스텝퍼 + 광고주 노출 토글. ══
//   ★ 인트라넷 D1 무접촉(HTTP GET 프록시만). 링크는 trackb_settlement_links 만 write.
router.get('/settlement/sales-search', authMiddleware, internalMiddleware, async (req, res, next) => {
  try { res.json(await svc.intranetSalesSearch({ q: req.query.q, limit: req.query.limit })); }
  catch (err) { next(err); }
});
// 계약 매칭 후보 — 그 작업을 소유한 업체(광고주DB)의 계약만 + 작업명 유사도 추천.
//   ★ 게이트는 링크(POST /settlement/link)와 **같은 `_ensureEditScope`** — 후보를 보는 사람 = 매칭할 사람.
//     (계약 목록엔 업체명·계약금액이 실리므로 열람 범위를 링크 권한보다 넓히지 않는다.)
router.get('/settlement/contract-candidates', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, scope, q } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const out = await svc.contractCandidatesForTab({ sheetId, tabName, scope, q });
    res.status(out.ok ? 200 : (out.code || 502)).json(out);
  } catch (err) { next(err); }
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
    const out = await svc.settlementForTab({ sheetId, tabName, role: _role(req), advertiserId: (req.admin && req.admin.advertiser_id) || null, brandId: (req.admin && req.admin.brand_id) || null });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});
// 견적서 문서(버전 이력) — /workdesk/settlement 와 동일 게이트(_ensureThreadScope + 서비스 광고주 렌즈).
router.get('/workdesk/quote-doc', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureThreadScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const out = await svc.quoteDocForTab({ sheetId, tabName, role: _role(req), advertiserId: (req.admin && req.admin.advertiser_id) || null, brandId: (req.admin && req.admin.brand_id) || null });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});
// 계산서(전자세금계산서) 발행 요약 — 게이트 동일.
router.get('/workdesk/invoice-doc', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureThreadScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const out = await svc.invoiceDocForTab({ sheetId, tabName, role: _role(req), advertiserId: (req.admin && req.admin.advertiser_id) || null, brandId: (req.admin && req.admin.brand_id) || null });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});
// ── 행별 리뷰 이미지(파일ID) — 업체 뷰어 미리보기 패널. 내부인 + 소유 광고주(_ensureThreadScope). ──
//   ★ 파일ID만 반환하고 이미지는 기존 무인증 프록시 /api/drive/image/<id> 가 스트리밍(신규 저장소·신규 프록시 0).
router.get('/workdesk/review-images', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureThreadScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    res.json({ ok: true, rows: await svc.reviewImagesForTab({ sheetId, tabName }) });
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

// ── 리뷰웹시스템[3버전] 셀 편집(오버레이) — 내부 직원 전체 · advertiser 차단. ──
//   rowId ∈ (sheetId,tabName) 재검증·앵커 산출·거부조건은 서비스가 수행.
router.post('/workdesk/edit', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, rowId, field, value } = req.body || {};
    if (!sheetId || !tabName || !rowId || !field) return res.status(400).json({ ok: false, error: 'sheetId, tabName, rowId, field 필수' });
    const g = await _ensureWorkdeskCellEditScope(req); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const out = await svc.editWorkdeskRow({ sheetId, tabName, rowId, field, value, by: _by(req) });
    res.status(out.ok ? 200 : (out.error === 'concurrent_edit_conflict' ? 409 : 400)).json(out);
  } catch (err) { next(err); }
});
router.post('/workdesk/revert', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, rowId, field } = req.body || {};
    if (!sheetId || !tabName || !rowId || !field) return res.status(400).json({ ok: false, error: 'sheetId, tabName, rowId, field 필수' });
    const g = await _ensureWorkdeskCellEditScope(req); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
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

// ── 커스텀 열(행별 자유메모) + 셀 배경색(migration 080) — master/admin 전체 · staff 담당 탭만 · advertiser 차단. ──
//   시트/write-back 무접촉(Track B 전용 오버레이) — _ensureEditScope 로 편집 스코프와 동일하게 가드.
router.post('/workdesk/custom-column', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, colName } = req.body || {};
    if (!sheetId || !tabName || !colName) return res.status(400).json({ ok: false, error: 'sheetId, tabName, colName 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    res.json(await svc.addCustomColumn({ sheetId, tabName, colName, by: _by(req) }));
  } catch (err) { next(err); }
});
router.delete('/workdesk/custom-column', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, columnId } = req.body || {};
    if (!sheetId || !tabName || !columnId) return res.status(400).json({ ok: false, error: 'sheetId, tabName, columnId 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    res.json(await svc.deleteCustomColumn({ sheetId, tabName, columnId }));
  } catch (err) { next(err); }
});
router.post('/workdesk/custom-value', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, rowId, columnId, value } = req.body || {};
    if (!sheetId || !tabName || !rowId || !columnId) return res.status(400).json({ ok: false, error: 'sheetId, tabName, rowId, columnId 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    res.json(await svc.setCustomColumnValue({ sheetId, tabName, rowId, columnId, value, by: _by(req) }));
  } catch (err) { next(err); }
});
router.post('/workdesk/cell-color', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, cells, color } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const g = await _ensureEditScope(req, sheetId, tabName); if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    res.json(await svc.setCellColors({ sheetId, tabName, cells, color, by: _by(req) }));
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// 리뷰어 비정상 로그(한글 자연어, migration 062) — 리뷰웹시스템[3버전] "리뷰어 로그" 창 + 관리자 중요알림 소스
//   내부인(master/admin/staff) 전용 — advertiser(외부) 차단. via:'intranet' 토큰도 /api/trackb/*
//   격리 범위 안이라 인트라넷 SSO 사용자가 리뷰웹시스템[3버전]에서 바로 열람 가능.
//   확인(resolve)은 서버 상태가 진실원본 — 어느 화면에서 확인해도 전 관리자 화면에서 사라진다.
// ═══════════════════════════════════════════════════════════
// ★ staff(AE) 스코프: 담당 업체(inad_pm) 탭의 로그만 열람 — 전 캠페인 리뷰어 PII 전역 열람 차단
//   (기존 선례와 동일: unseenCounts B2 봉합·advertiser 컬럼 최소화). master/admin은 전체.
async function _logScopeTabs(req) {
  if (_role(req) !== 'staff') return null;             // null = 전체
  const tabs = await svc.scopedActiveTabs({ role: 'staff', staffName: (req.admin && req.admin.name) || '' });
  return (tabs || []).map(t => ({ sheetId: t.sheetId, tabName: t.tabName }));
}

/* ══════════════════════════════════════════════════════════════
   작업오더 · 모집공고 — 리뷰웹시스템[3버전] 상단탭

   ★ **열람은 내부인 전원**(master/admin/staff — 광고주 차단), **편집은 이름 명단**
     (`utils/workdeskEditors.js`, env `WORKDESK_EDITORS`)만. 사용자 확정 정책이다.
     작업오더 접수는 시트/탭을 tab_configs·campaigns 에 등록하는 단일 관문이고
     공고 발행·수정은 정원·금액을 바꾸므로, 보는 사람 전부에게 열 수 없다.
   ★ 라우트는 **기존 서비스·핸들러를 그대로 호출**한다(로직 복제 금지) — 여기서는
     Track B 경로로 노출하면서 권한만 다시 씌운다. 리뷰웹시스템[3버전]은 /api/trackb/* 하고만
     통신하고 인트라넷 SSO 토큰도 그 경로로만 격리되기 때문이다.
   ══════════════════════════════════════════════════════════════ */
const wdEditors = require('../utils/workdeskEditors');
const { canEdit, editorOnlyMiddleware } = wdEditors;

// 이 계정이 편집 가능한지 — 프론트가 버튼 노출을 정하는 데 쓴다(서버 게이트가 최종 방어)
router.get('/perm', authMiddleware, internalMiddleware, async (req, res, next) => {
  try {
    res.json({ ok: true, canEdit: await canEdit(req.admin), role: _role(req), name: (req.admin && req.admin.name) || '' });
  } catch (err) { next(err); }
});

// ── 편집 허용명단 관리 — master/admin 전용(후보는 인트라넷 직원DB에서 고른다) ──
router.get('/workdesk-editors', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, items: await wdEditors.listEditors() }); } catch (err) { next(err); }
});
router.post('/workdesk-editors', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await wdEditors.addEditor({ name: b.name, username: b.username, dept: b.dept, by: _by(req) });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { next(err); }
});
router.delete('/workdesk-editors/:id', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const out = await wdEditors.removeEditor(req.params.id);
    res.status(out.ok ? 200 : 404).json(out);
  } catch (err) { next(err); }
});

// ── 작업오더 ────────────────────────────────────────────────
router.get('/work-orders/list', authMiddleware, internalMiddleware, async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim();
    const q = String(req.query.q || '').trim();
    const where = ['deleted_at IS NULL'];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (q) {
      params.push('%' + q + '%');
      where.push(`(title ILIKE $${params.length} OR created_by ILIKE $${params.length}`
        + ` OR COALESCE(manager_name,'') ILIKE $${params.length})`);
    }
    const { rows } = await pool.query(
      `SELECT * FROM work_orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 300`, params);
    // 상태별 건수(배지) — 필터와 무관하게 전체 기준
    const { rows: c } = await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM work_orders WHERE deleted_at IS NULL GROUP BY status`);
    const counts = {};
    for (const r of c) counts[r.status] = r.n;
    res.json({ ok: true, data: rows, counts, canEdit: await canEdit(req.admin) });
  } catch (err) { next(err); }
});

/** 편집 계열은 기존 order 라우트 핸들러를 그대로 태운다(로직 복제 금지) */
function _delegate(routerRef, method, path) {
  const layer = routerRef.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`[trackB] 위임 대상 라우트를 찾지 못함: ${method.toUpperCase()} ${path}`);
  // 마지막 스택 = 실제 핸들러(앞은 authMiddleware 등 — 여기선 우리 게이트를 이미 통과했다)
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const _orderRoutes = require('./order.routes');
const _acceptHandler = _delegate(_orderRoutes, 'post', '/admin/accept');
const _statusHandler = _delegate(_orderRoutes, 'put', '/admin/status');
const _adminEditHandler = _delegate(_orderRoutes, 'put', '/admin/edit');

router.post('/work-orders/accept', authMiddleware, internalMiddleware, editorOnlyMiddleware, (req, res, next) =>
  _acceptHandler(req, res, next));
router.put('/work-orders/status', authMiddleware, internalMiddleware, editorOnlyMiddleware, (req, res, next) =>
  _statusHandler(req, res, next));
// 관리자 수동 수정 — 인트라넷 SSO 토큰(via:'intranet')은 /api/order/* 에 도달 불가라 여기로 위임.
// 편집은 접수·상태변경과 같은 2단 권한(내부인 열람 · 편집 허용명단만 수정).
router.put('/work-orders/edit', authMiddleware, internalMiddleware, editorOnlyMiddleware, (req, res, next) =>
  _adminEditHandler(req, res, next));

// ── 모집공고 ────────────────────────────────────────────────
//   목록·상세·발행·수정·플래그·삭제·관제 — 전부 기존 campaign 라우트 핸들러에 위임한다.
//   ★ 카드는 프론트에서 **공용 렌더러(campaign-cards.js)** 로 그린다 — 관리자 대시보드와
//     같은 함수라 두 화면이 어긋날 수 없다(사본 금지 규율).
const _campRoutes = require('./campaign.routes');
const _campHandlers = {
  list: _delegate(_campRoutes, 'get', '/admin/list'),
  create: _delegate(_campRoutes, 'post', '/admin/create'),
  update: _delegate(_campRoutes, 'put', '/admin/:id'),
  flags: _delegate(_campRoutes, 'post', '/admin/:id/flags'),
  del: _delegate(_campRoutes, 'delete', '/admin/:id'),
  apps: _delegate(_campRoutes, 'get', '/admin/:id/applications'),
  confirm: _delegate(_campRoutes, 'post', '/admin/:id/confirm'),
  status: _delegate(_campRoutes, 'put', '/admin/:id/status'),     // 게시/마감 토글
  preview: _delegate(_campRoutes, 'get', '/admin/:id/preview'),   // 리뷰어 화면 미리보기
  detail: _delegate(_campRoutes, 'get', '/:id'),                  // 수정 모달 프리필(관리자 = 전체 행)
  dismiss: _delegate(_campRoutes, 'post', '/admin/:id/dismiss'),
};
router.get('/campaigns/list', authMiddleware, internalMiddleware, async (req, res, next) => {
  // 편집 가능 여부를 함께 실어 준다 — 프론트가 버튼 노출을 정한다(서버 게이트가 최종 방어)
  const _json = res.json.bind(res);
  try {
    const ce = await canEdit(req.admin);
    res.json = (body) => _json(body && typeof body === 'object' ? { ...body, canEdit: ce } : body);
  } catch (_) { /* 판정 실패는 canEdit 미표기 → 프론트는 읽기 전용으로 취급 */ }
  return _campHandlers.list(req, res, next);
});
router.get('/campaigns/:id/applications', authMiddleware, internalMiddleware, (req, res, next) =>
  _campHandlers.apps(req, res, next));
/* 공고 상세(수정 모달 프리필) — 원본은 **무인증 공개** `GET /api/campaign/:id` 라 인트라넷 SSO 토큰으로
   불러도 401 이 아니라 **공개 화이트리스트 뷰**가 온다(토큰이 무시되므로). 그러면 수정 모달이 조용히
   빈 칸으로 열려 "저장했더니 값이 날아간" 것처럼 보인다. 여기서는 authMiddleware 를 태워 `req.admin` 을
   세운 뒤 같은 핸들러에 위임하므로 내부인은 **전체 행**을 받는다. */
/* ★★ 편집 권한자에게는 **전체 편집 페이로드**(전체 행 + 원본 옵션 + 리뷰비 구간)를 준다.
   원본 핸들러는 JWT role 이 admin/master 일 때만 전체 행을 주는데, 편집 허용명단에는
   `staff`(AE)도 들어갈 수 있다 — 그 사람은 **수정은 되면서** 공개 화이트리스트 뷰를 받아
   폼이 work_detail·연결탭·정원·옵션을 빈 기본값으로 채우고, 저장하면 기존 설정이 조용히
   지워진다(0·빈값·options:[]). 그래서 canEdit 이면 신뢰 플래그를 세워 위임한다.
   ★ 판정 실패는 공개 뷰(fail-closed) — 모르면 더 주지 않는다. 편집은 서버 게이트가 막는다. */
router.get('/campaigns/:id', authMiddleware, internalMiddleware, async (req, res, next) => {
  try { if (await canEdit(req.admin)) req._trustedAdminView = true; } catch (_) { /* 공개 뷰로 수렴 */ }
  return _campHandlers.detail(req, res, next);
});
router.post('/campaigns/create', authMiddleware, internalMiddleware, editorOnlyMiddleware, (req, res, next) =>
  _campHandlers.create(req, res, next));
router.put('/campaigns/:id', authMiddleware, internalMiddleware, editorOnlyMiddleware, (req, res, next) =>
  _campHandlers.update(req, res, next));
router.post('/campaigns/:id/flags', authMiddleware, internalMiddleware, editorOnlyMiddleware, (req, res, next) =>
  _campHandlers.flags(req, res, next));
router.delete('/campaigns/:id', authMiddleware, internalMiddleware, editorOnlyMiddleware, (req, res, next) =>
  _campHandlers.del(req, res, next));
router.post('/campaigns/:id/confirm', authMiddleware, internalMiddleware, editorOnlyMiddleware, (req, res, next) =>
  _campHandlers.confirm(req, res, next));
router.put('/campaigns/:id/status', authMiddleware, internalMiddleware, editorOnlyMiddleware, (req, res, next) =>
  _campHandlers.status(req, res, next));
router.get('/campaigns/:id/preview', authMiddleware, internalMiddleware, (req, res, next) =>
  _campHandlers.preview(req, res, next));
router.post('/campaigns/:id/dismiss', authMiddleware, internalMiddleware, editorOnlyMiddleware, (req, res, next) =>
  _campHandlers.dismiss(req, res, next));

// ── 날짜별 모집인원 조절 + 차수(095) ─────────────────────────
//   경로는 재기준 없이 양쪽 호스트 공용(리뷰어 게이트와 같은 판단): admin_token(관리자 대시보드)도
//   인트라넷 SSO admin 토큰(리뷰웹시스템[3버전])도 /api/trackb/* 에 그대로 닿는다.
//   전부 adminOrMaster — 정원·총량 변경은 공고 관제 수동확정과 같은 급(AE 편집명단에 열지 않는다).
//   스코프 토큰(via:'reviewer_campaign')은 authMiddleware 격리로 도달 자체가 불가.
function _cdpNotReady(res, err) {
  if (err && err.code === '42P01') {
    res.json({ ok: false, code: 'not_ready', error: '모집인원 조절 준비 전입니다(migration 095 미적용) — 배포 완료 후 다시 시도해주세요.' });
    return true;
  }
  return false;
}
function _cdpFail(res, err) {
  // 서비스가 code 를 실은 검증/게이트 오류는 400대로 — errorHandler 마스킹(500 위장) 방지.
  const codes = {
    // schedule_driven·schedule_unknown 은 시트 일정 공고 조절 허용(2026-08-07) 이후 savePlans 에서
    // 던지지 않는다 — 매핑만 남겨 둔다(다른 경로가 되살릴 때 500 위장되지 않게).
    not_found: 404, not_participation: 400, schedule_driven: 409, schedule_unknown: 503,
    empty: 400, too_many: 400, bad_date: 400, past_date: 400, bad_count: 400, dup_date: 400,
    below_used: 422, no_round: 400, below_confirmed: 422,
    bad_carry: 400, carry_not_hold: 400,   // 098: 이월 반영 검증
    carry_stale: 409, carry_unknown: 503,  // 098: 잔량 경합·조회 실패(fail-closed — 코드리뷰 M2)
  };
  if (err && err.code && codes[err.code]) {
    res.status(codes[err.code]).json({ ok: false, code: err.code, error: err.message, ...(err.floor != null ? { floor: err.floor } : {}) });
    return true;
  }
  return false;
}
router.get('/campaigns/:id/daily-plan', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { getPlanOverview } = require('../services/campaignPlan.service');
    res.json({ ok: true, ...(await getPlanOverview(String(req.params.id))) });
  } catch (err) { if (!_cdpNotReady(res, err) && !_cdpFail(res, err)) next(err); }
});
router.post('/campaigns/:id/daily-plan', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { savePlans, getPlanOverview } = require('../services/campaignPlan.service');
    const campaignId = String(req.params.id);
    const out = await savePlans(campaignId, req.body, _by(req));
    res.json({ ok: true, ...out, ...(await getPlanOverview(campaignId)) });
  } catch (err) { if (!_cdpNotReady(res, err) && !_cdpFail(res, err)) next(err); }
});
router.post('/campaigns/:id/rounds', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { addRound, getPlanOverview } = require('../services/campaignPlan.service');
    const campaignId = String(req.params.id);
    const out = await addRound(campaignId, req.body, _by(req));
    res.json({ ok: true, ...out, ...(await getPlanOverview(campaignId)) });
  } catch (err) { if (!_cdpNotReady(res, err) && !_cdpFail(res, err)) next(err); }
});
router.delete('/campaigns/:id/rounds', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { removeLastRound, getPlanOverview } = require('../services/campaignPlan.service');
    const campaignId = String(req.params.id);
    const out = await removeLastRound(campaignId, _by(req));
    res.json({ ok: true, ...out, ...(await getPlanOverview(campaignId)) });
  } catch (err) { if (!_cdpNotReady(res, err) && !_cdpFail(res, err)) next(err); }
});

/* ══════════════════════════════════════════════════════════════
   리뷰이미지 교체요청 — 리뷰웹시스템[3버전] 전용 탭 + C/S 대화창 카드

   ★ **AE(staff)도 담당 탭만** 처리할 수 있다(사용자 확정) — C/S 문의 탭은 여전히
     master/admin 전용이므로, AE 는 문의 본문을 보지 못한 채 이 경로로만 교체요청을 처리한다.
   ★ 로직 복제 0: 목록·승인·반려는 기존 reviewEdit 핸들러에 위임한다.
     승인은 Drive 파일 이동·review_index 갱신·C/S 자동통지까지 하는 무거운 흐름이라
     사본을 만들면 두 화면의 결과가 갈라진다.
   ★ 스코프는 두 겹: 목록은 결과 필터(staff), 승인/반려는 **위임 전에** 대상 행의
     (sheet, tab) 로 canAccessTab — 클라가 보낸 값을 신뢰하지 않는 기존 규율과 같다.
   ══════════════════════════════════════════════════════════════ */
const _reRoutes = require('./reviewEdit.routes');
const _reHandlers = {
  list: _delegate(_reRoutes, 'get', '/list'),
  approve: _delegate(_reRoutes, 'post', '/approve'),
  reject: _delegate(_reRoutes, 'post', '/reject'),
};

/** 내부인(master/admin/staff)만 — 광고주·리뷰어 차단 */
function _reInternal(req, res, next) {
  const role = _role(req);
  if (role === 'master' || role === 'admin' || role === 'staff') return next();
  return res.status(403).json({ ok: false, error: '권한이 없습니다.' });
}

/** 이 요청 건이 내 스코프인가 — master/admin=전체, staff=담당 탭만.
 *  ★★ 절대 throw 하지 않는다 — Express 4 는 async 핸들러의 rejection 을 잡지 않아
 *    **응답이 영영 나가지 않는다**(클라이언트가 서버 타임아웃까지 대기). 실제 유발 경로:
 *    id 가 UUID 형식이 아니면 `WHERE id = $1` 이 22P02 로 실패한다(review_edit_requests.id 는 UUID).
 *    판정 불가는 전부 **거절**(fail-closed) — 모르면 열지 않는다. */
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function _reCanTouch(req, id) {
  const rid = String(id || '');
  if (!_UUID_RE.test(rid)) return { ok: false, code: 400, error: '요청 id 형식이 올바르지 않습니다.' };
  try {
    const role = _role(req);
    const { rows } = await pool.query(
      'SELECT sheet_id, tab_name FROM review_edit_requests WHERE id = $1', [rid]
    );
    if (!rows.length) return { ok: false, code: 404, error: '요청을 찾을 수 없습니다.' };
    if (role === 'master' || role === 'admin') return { ok: true };
    const okc = await svc.canAccessTab({
      role: 'staff', staffName: req.admin && req.admin.name,
      sheetId: rows[0].sheet_id, tabName: rows[0].tab_name,
    });
    return okc ? { ok: true } : { ok: false, code: 403, error: '담당하지 않은 작업(스코프 밖)' };
  } catch (err) {
    return { ok: false, code: 503, error: '담당 범위를 확인하지 못했습니다. 잠시 후 다시 시도하세요.' };
  }
}

router.get('/review-edit/list', authMiddleware, _reInternal, async (req, res, next) => {
  const role = _role(req);
  if (role === 'master' || role === 'admin') return _reHandlers.list(req, res, next);
  // staff — 기존 핸들러의 결과를 담당 탭으로 거른다(쿼리 복제 없이 스코프만 적용)
  const _json = res.json.bind(res);
  res.json = (body) => {
    if (!body || !Array.isArray(body.requests)) return _json(body);
    // ★ 행마다 canAccessTab 을 부르면 최대 200행 × 2쿼리다 — **서로 다른 (시트,탭)당 1회**로 접는다.
    //   ★ 키를 문자열로 이어 붙였다가 쪼개지 않는다 — 탭명에 구분자가 들어가면 잘못 갈린다
    //     (슬래시양식 주소 병합과 같은 함정). 쌍을 그대로 들고 다닌다.
    const memo = new Map();
    const keyOf = (it) => JSON.stringify([it.sheet_id || it.sheetId, it.tab_name || it.tabName]);
    const uniq = new Map();
    body.requests.forEach((it) => {
      const k = keyOf(it);
      if (!uniq.has(k)) uniq.set(k, { sheetId: it.sheet_id || it.sheetId, tabName: it.tab_name || it.tabName });
    });
    Promise.all([...uniq.entries()].map(async ([k, p]) => {
      memo.set(k, await svc.canAccessTab({
        role: 'staff', staffName: req.admin && req.admin.name, sheetId: p.sheetId, tabName: p.tabName,
      }));
    })).then(() => {
      const keep = body.requests.filter(it => memo.get(keyOf(it)));
      // pendingCount 는 **대기 건수**라는 이름값을 지킨다 — status 필터가 approved 여도
      //   승인 건수를 대기 자리에 넣지 않는다(필드 의미가 어긋나면 나중 소비처가 오해한다).
      const pend = keep.filter(x => (x.status || 'pending') === 'pending').length;
      _json({ ...body, requests: keep, pendingCount: pend, scoped: true });
    }).catch(() => {
      // 스코프 판정 실패 = 넓게 보여주지 않는다(fail-closed)
      _json({ ok: false, error: '담당 범위를 확인하지 못했습니다.' });
    });
    return res;   // 원본 res.json 은 this 를 돌려준다 — 체이닝이 조용히 깨지지 않게
  };
  return _reHandlers.list(req, res, next);
});
router.post('/review-edit/approve', authMiddleware, _reInternal, async (req, res, next) => {
  const g = await _reCanTouch(req, (req.body || {}).id);
  if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
  return _reHandlers.approve(req, res, next);
});
router.post('/review-edit/reject', authMiddleware, _reInternal, async (req, res, next) => {
  const g = await _reCanTouch(req, (req.body || {}).id);
  if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
  return _reHandlers.reject(req, res, next);
});

/* ══════════════════════════════════════════════════════════════
   리뷰검수 — 리뷰웹시스템[3버전] 상단탭 (M3)

   ★ 권한은 **이미지 교체요청 탭과 같다**(`_reInternal`): master/admin 전체,
     staff(AE)는 담당 탭만, 광고주 차단. 검수 근거에 리뷰어 실명과 **리뷰 본문 OCR**이
     실려 광고주에게 열 수 있는 데이터가 아니다(등록리뷰어DB와 같은 판단).
   ★ Track B 경로에 두는 이유 = 인트라넷 SSO 토큰(via:'intranet')은 `/api/trackb/*` 로만
     격리돼 있어, 다른 마운트에 두면 SSO 관리자가 아예 못 쓴다.
   ══════════════════════════════════════════════════════════════ */
const _inspectSvc = require('../services/reviewInspect.service');

/** 이 파일이 내 스코프인가 — `_reCanTouch` 와 같은 규율(fail-closed, 절대 throw 안 함). */
async function _riCanTouch(req, fileId) {
  const fid = String(fileId || '');
  if (!fid || fid.length > 200) return { ok: false, code: 400, error: 'fileId 가 올바르지 않습니다.' };
  try {
    const role = _role(req);
    const sc = await _inspectSvc.inspectionScope(fid);
    if (!sc) return { ok: false, code: 404, error: '검수 기록을 찾을 수 없습니다.' };
    if (role === 'master' || role === 'admin') return { ok: true };
    const okc = await svc.canAccessTab({
      role: 'staff', staffName: req.admin && req.admin.name,
      sheetId: sc.sheet_id, tabName: sc.tab_name,
    });
    return okc ? { ok: true } : { ok: false, code: 403, error: '담당하지 않은 작업(스코프 밖)' };
  } catch (_) {
    return { ok: false, code: 503, error: '담당 범위를 확인하지 못했습니다. 잠시 후 다시 시도하세요.' };
  }
}

/** staff 는 (시트,탭)이 지정됐을 때 그 탭 접근권을 먼저 본다. 미지정이면 서비스가 스코프로 거른다. */
async function _riScopeQuery(req) {
  const role = _role(req);
  const sheetId = req.query.sheetId ? String(req.query.sheetId) : null;
  const tabName = req.query.tabName ? String(req.query.tabName) : null;
  if (role === 'master' || role === 'admin') return { ok: true, sheetId, tabName, scoped: false };
  if (sheetId && tabName) {
    const okc = await svc.canAccessTab({
      role: 'staff', staffName: req.admin && req.admin.name, sheetId, tabName,
    });
    return okc ? { ok: true, sheetId, tabName, scoped: true }
               : { ok: false, code: 403, error: '담당하지 않은 작업(스코프 밖)' };
  }
  // 탭 미지정 staff — 담당 탭 전체를 대상으로 한다(빈 목록이면 담당이 없다는 뜻)
  const tabs = await svc.scopedActiveTabs({ role: 'staff', staffName: (req.admin && req.admin.name) || '' });
  return { ok: true, sheetId: null, tabName: null, scoped: true, allow: tabs || [] };
}

router.get('/review-inspect/list', authMiddleware, _reInternal, async (req, res) => {
  try {
    const sc = await _riScopeQuery(req);
    if (!sc.ok) return res.status(sc.code).json({ ok: false, error: sc.error });
    let items = await _inspectSvc.listInspections({
      sheetId: sc.sheetId, tabName: sc.tabName, status: String(req.query.status || 'open'),
    });
    let summary = await _inspectSvc.inspectionSummary({ sheetId: sc.sheetId, tabName: sc.tabName });
    // staff + 탭 미지정 → 담당 탭만 남긴다(집계도 같은 기준으로 다시 센다)
    if (sc.scoped && !sc.tabName) {
      const allow = new Set((sc.allow || []).map(t => JSON.stringify([t.sheetId, t.tabName])));
      items = items.filter(it => allow.has(JSON.stringify([it.sheet_id, it.tab_name])));
      summary = { pass: 0, suspect: 0, fail: 0, pending: 0, unverifiable: 0, resolved: 0, open: 0 };
      for (const it of items) if (summary[it.status] !== undefined) summary[it.status] += 1;
      summary.open = summary.suspect + summary.fail;
    }
    // ★ 이 작업의 리뷰타입을 **판정 근거값과 함께** 실어 보낸다 — 구매확정 작업인데
    //   "리뷰 화면이 아님" 불량이 나오는 이유가 화면 어디에도 안 보이던 실사고(2026-08-06) 대응.
    //   읽기 전용·fail-soft(실패 = 빈 배열 = 표시만 생략, 목록은 그대로 뜬다).
    let reviewTypes = [];
    try {
      reviewTypes = await require('../services/reviewTypeContext.service')
        .reviewTypeDetailsForTabs(items.map(it => ({ sheetId: it.sheet_id, tabName: it.tab_name })));
    } catch (_) { /* 표시 보조 — 목록을 죽이지 않는다 */ }
    res.json({ ok: true, items, summary, openCount: summary.open, scoped: !!sc.scoped, reviewTypes });
  } catch (err) {
    logger.warn(`[review-inspect] 목록 실패: ${err.message}`);
    res.status(500).json({ ok: false, error: '검수 목록을 불러오지 못했습니다.' });
  }
});

/* 반려 안내를 보낼 수 있는 건인지 미리 확인 — 팝업이 열릴 때 1회.
   ★ 연락처(phone8)는 응답에 담지 않는다(가능 여부·사유만 — 화면에 PII 를 늘리지 않는다).
   ★ fail-soft: 확인 자체가 실패해도 팝업은 열려야 하므로 200 + canNotify:null(모름). */
router.get('/review-inspect/notify-check', authMiddleware, _reInternal, async (req, res) => {
  try {
    const fileId = String(req.query.fileId || '');
    const g = await _riCanTouch(req, fileId);
    if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const r = await _inspectSvc.resolveReviewerPhone8(fileId);
    res.json({ ok: true, canNotify: !!r.phone8, via: r.via || null, reason: r.phone8 ? null : (r.error || null) });
  } catch (err) {
    res.json({ ok: true, canNotify: null });
  }
});

router.post('/review-inspect/resolve', authMiddleware, _reInternal, async (req, res) => {
  try {
    const fileId = String((req.body || {}).fileId || '');
    const g = await _riCanTouch(req, fileId);
    if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    // resolution: 'ok'(정상 = AI 오탐 — 학습 신호) | 'bad'(불량 맞음) | 미지정(옛 화면 호환)
    const by = (req.admin && req.admin.name) || '';
    const resolution = String((req.body || {}).resolution || '');
    const r = await _inspectSvc.resolveInspection({ fileId, by, resolution });
    // 불량 확인 + 사유가 오면 리뷰어 1:1 문의 채팅에 반려 안내 자동 전송(실패해도 확인은 유지 —
    // 결과를 notify 로 실어 화면이 "전송 실패"를 말하게 한다. 조용한 미전송 금지).
    let notify = null;
    const rejectMessage = String((req.body || {}).rejectMessage || '').trim();
    if (resolution === 'bad' && rejectMessage) {
      notify = await _inspectSvc.notifyInspectionReject({
        fileId, message: rejectMessage, by,
        card: (req.body || {}).card || { kind: 'reject' },   // 반려된 사진을 함께 보여준다
      });
    }
    res.json({ ok: true, ...r, notify });
  } catch (err) {
    res.status(500).json({ ok: false, error: '확인 처리에 실패했습니다.' });
  }
});

/* 수동 분류(이동) — "리뷰가 아니다 → 현금영수증/구매캡처로". 실행은 fileRoute.service
   재사용(사본 0 — 자동 이동과 같은 상태·같은 되돌리기). 이동 성공 시 그 검수 건은
   정상(오제출 = resolution 'ok')으로 자동 종결하고, 학습 결합으로 그 실물을 대상 판별
   예시로 승격할 수 있는 슬롯이면 promote 제안을 동봉한다(등록은 사람이 확인 후). */
router.post('/review-inspect/route-manual', authMiddleware, _reInternal, async (req, res) => {
  try {
    const fileId = String((req.body || {}).fileId || '');
    const target = String((req.body || {}).target || '');
    const g = await _riCanTouch(req, fileId);
    if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const by = (req.admin && req.admin.name) || '';
    const out = await require('../services/fileRoute.service').manualRoute({ fileId, target, by });
    if (!out.ok) return res.status(400).json(out);
    try { await _inspectSvc.resolveInspection({ fileId, by, resolution: 'ok' }); } catch (_) {}
    // 이동 안내 — "옮겼다 + 리뷰 캡처가 아직 비어 있다"를 리뷰어가 알아야 다음 행동을 한다.
    let notify = null;
    const moveMessage = String((req.body || {}).rejectMessage || '').trim();
    if (moveMessage) {
      notify = await _inspectSvc.notifyInspectionReject({
        fileId, message: moveMessage, by,
        card: { kind: 'moved', to: target, ...(req.body || {}).card },
      });
    }
    let promote = null;
    try { promote = await _routePromoteSuggestion(out); } catch (_) {}
    res.json({ ...out, promote, notify });
  } catch (err) {
    res.status(500).json({ ok: false, error: '이동에 실패했습니다.' });
  }
});

/** 수동 분류한 실물의 예시 승격 제안 — 대상 슬롯이 판별 예시로 쓰이고 자리가 남을 때만.
 *  ★ 제안까지만(자동 등록 없음) — 등록은 프론트 confirm 을 거쳐 기존 samples POST(mode:'add')로. */
async function _routePromoteSuggestion({ to, sheetId, tabName } = {}) {
  const cap = _inspectSvc.SAMPLE_SLOT_CAP;
  if (to === 'order_capture') {
    const s = (await _inspectSvc.routeSampleSettings()).find(x => x.key === 'order_capture');
    if (s && (s.imageUrls || []).length < cap) return { kind: 'route', key: 'order_capture', label: s.label || '구매캡처(주문내역) 화면' };
    return null;
  }
  if (to === 'receipt') {
    const ch = (await _inspectSvc.loadTabExpectations({ sheetId, tabName })).expectedChannel;
    if (!ch) return null;
    const s = (await _inspectSvc.receiptSampleSettings()).find(x => x.key === ch);
    if (s && (s.imageUrls || []).length < cap) return { kind: 'receipt', key: ch, label: '현금영수증 · ' + (s.label || ch) };
    return null;
  }
  return null;   // review 대상은 PC/모바일 구분을 모른다 — 잘못된 슬롯 제안보다 무제안
}

/* 중복파일 수동 제거 — duplicate fail 근거가 있는 파일만(서버가 재검증), 나중 제출본을
   휴지통으로 보내고 검수 건은 불량 맞음(중복 제출)으로 종결(#562 확정 기본값).
   게이트 = 건별 확인과 동일(_riCanTouch — 내부인 + staff 담당 탭). */
router.post('/review-inspect/dedup-manual', authMiddleware, _reInternal, async (req, res) => {
  try {
    const fileId = String((req.body || {}).fileId || '');
    const g = await _riCanTouch(req, fileId);
    if (!g.ok) return res.status(g.code).json({ ok: false, error: g.error });
    const by = (req.admin && req.admin.name) || '';
    const out = await require('../services/fileRoute.service').dedupManual({ fileId, by });
    if (!out.ok) return res.status(400).json(out);
    try { await _inspectSvc.resolveInspection({ fileId, by, resolution: 'bad' }); } catch (_) {}
    // 리뷰어 안내 — 문구는 설정(설정 › 리뷰어 안내문구)에서 관리하고 화면이 보내기 전 수정할 수 있다.
    // ★ 제거는 이미 끝났다 — 전송 실패해도 되돌리지 않고 결과만 알린다(조용한 미전송 금지).
    let notify = null;
    const rejectMessage = String((req.body || {}).rejectMessage || '').trim();
    if (rejectMessage) {
      notify = await _inspectSvc.notifyInspectionReject({
        fileId, message: rejectMessage, by,
        card: { kind: 'duplicate', matchFileId: out.matchFileId || '', ...(req.body || {}).card },
      });
    }
    res.json({ ...out, notify });
  } catch (err) {
    res.status(500).json({ ok: false, error: '중복파일 제거에 실패했습니다.' });
  }
});

/* ── 리뷰어 안내문구(유형별) — 설정 화면에서 직접 편집 ─────────────────
   ★ 문구·유형 목록의 단일 출처는 utils/inspectMessages.js — 화면은 서버가 준 표를 그대로 그린다
     (프론트에 문구 사본을 두면 "설정에서 고쳤는데 나가는 문장은 그대로"가 된다).
   ★ 조회는 내부인(팝업 프리필에 필요), 저장은 adminOrMaster(전사 설정). */
router.get('/settings/inspect-messages', authMiddleware, internalMiddleware, async (req, res) => {
  try {
    const IM = require('../utils/inspectMessages');
    let saved = {};
    try {
      const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1 LIMIT 1', [IM.SETTING_KEY]);
      if (rows[0] && rows[0].value) saved = JSON.parse(rows[0].value) || {};
    } catch (_) { /* 미설정·파싱 실패 = 기본 문구 */ }
    res.json({
      ok: true,
      kinds: IM.INSPECT_MSG_KINDS.map(k => ({ key: k.key, label: k.label, desc: k.desc, def: k.def })),
      messages: IM.merge(saved),
      maxLen: IM.MAX_LEN,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: '안내문구를 불러오지 못했습니다.' });
  }
});

router.post('/settings/inspect-messages', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  try {
    const IM = require('../utils/inspectMessages');
    // ★ 빈 값 = 그 유형만 기본 문구로 되돌리기(빈 메시지가 리뷰어에게 나가지 않는다).
    const clean = IM.normalize((req.body || {}).messages || {});
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [IM.SETTING_KEY, JSON.stringify(clean)]
    );
    res.json({ ok: true, messages: IM.merge(clean) });
  } catch (err) {
    res.status(500).json({ ok: false, error: '저장에 실패했습니다.' });
  }
});

/* 자동분류 정확도 — 수동 분류(정답) vs AI 관측 계획 대조. 읽기 전용(설정탭 카드). */
router.get('/review-inspect/route-stats', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  try {
    const out = await require('../services/fileRoute.service').routeAccuracyStats({ days: req.query.days });
    res.json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: '통계를 불러오지 못했습니다.' });
  }
});

/* 일괄 확인 처리 — 그 탭의 미확인 의심·불량 전부를 한 번에 종결(대량 백로그용).
   ★ adminOrMaster — 대량 종결은 되돌리기 어렵다(건별 확인은 종전대로 staff 담당 탭 허용).
   ★ resolution 'ok' 면 상품명 의심 건의 캡처 표기를 그 탭 인정 별칭으로 함께 학습한다. */
router.post('/review-inspect/resolve-bulk', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const out = await _inspectSvc.resolveInspectionsBulk({
      sheetId: String(b.sheetId || ''), tabName: String(b.tabName || ''),
      resolution: String(b.resolution || 'ok'), by: (req.admin && req.admin.name) || '',
    });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: '일괄 확인 처리에 실패했습니다.' });
  }
});

/* 기대 상품명 — 이게 비어 있으면 상품명 대조가 통째로 건너뛴다(조건 ②가 죽는다) */
router.get('/review-inspect/product-names', authMiddleware, _reInternal, async (req, res) => {
  try {
    const sc = await _riScopeQuery(req);
    if (!sc.ok) return res.status(sc.code).json({ ok: false, error: sc.error });
    if (!sc.sheetId || !sc.tabName) return res.status(400).json({ ok: false, error: 'sheetId·tabName 이 필요합니다.' });
    res.json({ ok: true, ...(await _inspectSvc.productNameSettings({ sheetId: sc.sheetId, tabName: sc.tabName })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: '기대 상품명을 불러오지 못했습니다.' });
  }
});

router.post('/review-inspect/product-names', authMiddleware, _reInternal, async (req, res) => {
  try {
    const b = req.body || {};
    const sheetId = String(b.sheetId || ''), tabName = String(b.tabName || '');
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId·tabName 이 필요합니다.' });
    const role = _role(req);
    if (role !== 'master' && role !== 'admin') {
      const okc = await svc.canAccessTab({ role: 'staff', staffName: req.admin && req.admin.name, sheetId, tabName });
      if (!okc) return res.status(403).json({ ok: false, error: '담당하지 않은 작업(스코프 밖)' });
    }
    // text = 기대 상품명(수동) / aliases = 학습된 인정 별칭 — 각각 온 필드만 저장(미전송 = 유지)
    const out = { ok: true };
    if (b.text !== undefined) out.saved = await _inspectSvc.saveProductNames({ sheetId, tabName, text: b.text });
    if (b.aliases !== undefined) out.aliases = await _inspectSvc.saveProductAliases({ sheetId, tabName, text: b.aliases });
    res.json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: '저장에 실패했습니다.' });
  }
});

/* 검수 결과 CSV — 업체 전달 전 사람이 훑어보는 용도(PII 포함 → 내부인만) */
router.get('/review-inspect/export.csv', authMiddleware, _reInternal, async (req, res) => {
  try {
    const sc = await _riScopeQuery(req);
    if (!sc.ok) return res.status(sc.code).json({ ok: false, error: sc.error });
    let items = await _inspectSvc.listInspections({
      sheetId: sc.sheetId, tabName: sc.tabName, status: String(req.query.status || 'all'), limit: 500,
    });
    if (sc.scoped && !sc.tabName) {
      const allow = new Set((sc.allow || []).map(t => JSON.stringify([t.sheetId, t.tabName])));
      items = items.filter(it => allow.has(JSON.stringify([it.sheet_id, it.tab_name])));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="review-inspect.csv"');
    res.send(_inspectSvc.inspectionsCsv(items));
  } catch (err) {
    res.status(500).json({ ok: false, error: 'CSV 생성에 실패했습니다.' });
  }
});

/* 판별 예시이미지 — 조회는 내부인, **저장은 adminOrMaster**(전사 설정이라 AE가 못 바꾼다)
   ★ 리뷰 예시(`kind:'review'`, 기본)와 현금영수증 예시(`kind:'receipt'`)가 **한 창구**를 쓴다 —
     둘 다 "AI 판정의 기준이 되는 예시"라 화면·권한·검증이 같아야 한다.
   ★ 기존 호출부(리뷰웹시스템[3버전] 리뷰검수 탭의 [🖼 판별 예시] 모달)는 kind 를 안 보내므로
     기본값이 review = **동작 불변**. */
router.get('/review-inspect/samples', authMiddleware, _reInternal, async (req, res) => {
  try {
    const [samples, receiptSamples, routeSamples] = await Promise.all([
      _inspectSvc.sampleSettings(),
      _inspectSvc.receiptSampleSettings(),
      _inspectSvc.routeSampleSettings(),   // 자동 분류(구매캡처·구매확정) 예시 — 구버전 프론트는 무시
    ]);
    res.json({ ok: true, samples, receiptSamples, routeSamples });
  } catch (err) {
    res.status(500).json({ ok: false, error: '예시이미지를 불러오지 못했습니다.' });
  }
});
router.post('/review-inspect/samples', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    // mode: 'add'(누적) | 'remove'+index(개별 삭제) | 미지정(종전 = 교체/전체 제거)
    const op = { imageUrl: b.imageUrl, mode: b.mode, index: b.index };
    if (String(b.kind || '') === 'receipt') {
      const channel = String(b.channel || b.key || '');
      const urls = await _inspectSvc.saveReceiptSample({ channel, ...op });
      return res.json({ ok: true, kind: 'receipt', channel, imageUrls: urls, imageUrl: urls[0] || '' });
    }
    if (String(b.kind || '') === 'route') {
      // 자동 분류 예시(구매캡처·구매확정) — 슬롯 화이트리스트는 utils/routeSampleKinds 단일 출처
      const urls = await _inspectSvc.saveRouteSample({ key: String(b.key || ''), ...op });
      return res.json({ ok: true, kind: 'route', key: b.key, imageUrls: urls, imageUrl: urls[0] || '' });
    }
    const urls = await _inspectSvc.saveSample({ key: String(b.key || ''), ...op });
    res.json({ ok: true, key: b.key, imageUrls: urls, imageUrl: urls[0] || '' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || '저장에 실패했습니다.' });
  }
});

/* ── 제출 이미지 자동 분류(파일 라우팅) — 소급 정리 스윕 ─────────────────────
   과거 오제출(리뷰 칸의 영수증 등)을 탭 단위로 찾아 [미리보기 → 실행] 2단계로 정리한다
   (사용자 확정 2026-08-05 "소급정리 필요"). dryRun 기본 true — 실행은 명시할 때만.
   ★ adminOrMaster — 파일 이동·휴지통이 걸린 파괴적 작업이라 AE 스코프로 열지 않는다.
   ★ 건당 Drive 다운로드 1회 + AI 1콜이라 limit 상한(서비스에서 60 캡). */
router.post('/file-route/sweep', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const { sweepTab } = require('../services/fileRoute.service');
    const out = await sweepTab({
      sheetId: String(b.sheetId || ''), tabName: String(b.tabName || ''),
      dryRun: b.dryRun !== false,          // 기본 미리보기 — 명시적 false 만 실행
      limit: b.limit, by: _by(req),
    });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '소급 정리에 실패했습니다.' });
  }
});

/* 자동 이동 되돌리기 — capture_routed 알림 1건에서 파일을 원래 슬롯 폴더로 원복(adminOrMaster). */
router.post('/reviewer-logs/route-revert', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  try {
    const { revertRouteFromEvent } = require('../services/fileRoute.service');
    const out = await revertRouteFromEvent({ id: (req.body || {}).id, by: _by(req) });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '되돌리기에 실패했습니다.' });
  }
});

/* 소급 재검수 — 공고 리뷰타입을 뒤늦게 바꾼 탭(예: 구매확정 전환)의 옛 의심·불량 판정을
   초기화하고 새 기준으로 다시 매긴다(master/admin). resolved·pass 는 보존. */
router.post('/review-inspect/reinspect', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const out = await _inspectSvc.reinspectTab({
      sheetId: String(b.sheetId || ''), tabName: String(b.tabName || ''),
      // 유형별 일괄 재검수 — 화면이 고른 건들만(유형 판정은 화면 단일 출처)
      fileIds: Array.isArray(b.fileIds) ? b.fileIds : null,
      limit: b.limit,
    });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '재검수에 실패했습니다.' });
  }
});

/* 배치 스윕 수동 실행 — 과거분 따라잡기를 관리자가 당길 수 있게(master/admin) */
router.post('/review-inspect/sweep', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  try {
    const { withJobLock } = require('../utils/jobLock');
    const limit = Math.min(Number((req.body || {}).limit) || 20, 100);
    const r = await withJobLock('review_inspect_sweep', () => _inspectSvc.runInspectSweep({ limit }),
      { onBusy: () => ({ busy: true }) });
    res.json({ ok: true, ...(r || {}) });
  } catch (err) {
    res.status(500).json({ ok: false, error: '스윕 실행에 실패했습니다.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   C/S 문의창구 — 리뷰웹시스템[3버전] 상단탭

   ★ **master/admin 전용**(`adminOrMasterMiddleware`) — 기존 `/api/cs/*` 정책을 그대로 옮겼다
     (cs.routes.js 머리말: "staff(영업담당자)·리뷰어는 접근 불가"). 문의 본문에는
     리뷰어 실명·연락처·주소·주문정보가 그대로 실려 담당 스코프로 나눌 수 있는 데이터가 아니다.
   ★ Track B 경로에 두는 이유: 인트라넷 SSO 토큰(`via:'intranet'`)은 authMiddleware가
     `/api/trackb/*` 로만 격리해 `/api/cs/*` 에 **도달 자체가 불가능**하다.
     로직은 한 줄도 베끼지 않고 기존 cs 라우트 핸들러에 그대로 위임한다.
   ══════════════════════════════════════════════════════════════ */
const _csRoutes = require('./cs.routes');
const _csHandlers = {
  threads:      _delegate(_csRoutes, 'get',  '/threads'),
  unread:       _delegate(_csRoutes, 'get',  '/unread-count'),
  messages:     _delegate(_csRoutes, 'get',  '/messages'),
  orderContext: _delegate(_csRoutes, 'get',  '/order-context'),
  reply:        _delegate(_csRoutes, 'post', '/reply'),
  upload:       _delegate(_csRoutes, 'post', '/upload'),
  status:       _delegate(_csRoutes, 'post', '/status'),
  memo:         _delegate(_csRoutes, 'post', '/memo'),
};
// 경로 모양은 `/api/cs/*` 와 1:1 — 프론트가 베이스 문자열만 갈아끼워 같은 모듈을 쓴다.
router.get('/cs/threads', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _csHandlers.threads(req, res, next));
router.get('/cs/unread-count', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _csHandlers.unread(req, res, next));
router.get('/cs/messages', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _csHandlers.messages(req, res, next));
router.get('/cs/order-context', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _csHandlers.orderContext(req, res, next));
router.post('/cs/reply', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _csHandlers.reply(req, res, next));
router.post('/cs/upload', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _csHandlers.upload(req, res, next));
router.post('/cs/status', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _csHandlers.status(req, res, next));
router.post('/cs/memo', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _csHandlers.memo(req, res, next));

/* ══════════════════════════════════════════════════════════════
   설정 — 리뷰웹시스템[3버전] 상단탭 (내 닉네임 · 회사 사업자번호(제공정보) · 리뷰어 소식·공지)

   ★ Track B 경로에 두는 이유 = C/S 문의와 같다: 인트라넷 SSO 토큰(`via:'intranet'`)은
     authMiddleware 가 `/api/trackb/*` 로만 격리하므로 `/api/admin/*`·`/api/tab/*`·
     `/api/reviewer/*` 에는 **도달 자체가 불가능**하다. 화면은 공유 모듈
     (js/admin-settings.js) 한 벌이고 프론트는 베이스 문자열만 갈아끼운다(사본 0).
   ★ 로직은 한 줄도 베끼지 않고 기존 핸들러에 위임한다.
   ★ 권한은 **원본 라우트와 1:1**로 다시 씌운다(느슨해지지 않게):
       · 내 닉네임      = 본인 것만 다루므로 내부인 전원(master/admin/staff). 광고주는 차단.
         (원본은 authMiddleware 만이지만 광고주 토큰까지 열 이유가 없어 internal 로 좁혔다)
       · 사업자번호·현영 이미지·리뷰어 공지 = adminOrMaster (원본과 동일).
   ★ `/guide-image` 원본은 무인증이지만 여기서는 adminOrMaster 로 좁힌다 —
     이 경로의 용도가 현영 발행방법 이미지 업로드 하나뿐이라 넓게 열 이유가 없다.
   ══════════════════════════════════════════════════════════════ */
const _adminRoutes = require('./admin.routes');
const _tabRoutes = require('./tabconfig.routes');
const _reviewerRoutes = require('./reviewer.routes');
const _setHandlers = {
  nicknameGet:  _delegate(_adminRoutes, 'get', '/my-nickname'),
  nicknameSet:  _delegate(_adminRoutes, 'post', '/my-nickname'),
  providerInfo: _delegate(_tabRoutes, 'get', '/provider-info'),
  businessNo:   _delegate(_tabRoutes, 'post', '/company-business-no'),
  cashGuide:    _delegate(_tabRoutes, 'post', '/cash-receipt-guide'),
  guideImage:   _delegate(_orderRoutes, 'post', '/guide-image'),
  notices:      _delegate(_reviewerRoutes, 'get', '/notices/all'),
  noticeSave:   _delegate(_reviewerRoutes, 'post', '/notices/save'),
  noticeDelete: _delegate(_reviewerRoutes, 'post', '/notices/delete'),
  // ★ 087: 리뷰타입 옛 값 정리 — 원본은 `/api/diag/review-type-cleanup`.
  //   인트라넷 SSO 토큰(via:'intranet')은 `/api/diag/*` 에 **도달 자체가 불가**라
  //   리뷰웹시스템[3버전]에서 이 정리를 부르려면 Track B 경로가 필요하다(로직 복제 0).
  reviewTypeCleanup: _delegate(require('./diag.routes'), 'post', '/review-type-cleanup'),
};
router.get('/settings/my-nickname', authMiddleware, internalMiddleware, (req, res, next) =>
  _setHandlers.nicknameGet(req, res, next));
router.post('/settings/my-nickname', authMiddleware, internalMiddleware, (req, res, next) =>
  _setHandlers.nicknameSet(req, res, next));
router.get('/settings/provider-info', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _setHandlers.providerInfo(req, res, next));
router.post('/settings/company-business-no', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _setHandlers.businessNo(req, res, next));
router.post('/settings/cash-receipt-guide', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _setHandlers.cashGuide(req, res, next));
router.post('/settings/guide-image', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _setHandlers.guideImage(req, res, next));
router.get('/settings/notices', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _setHandlers.notices(req, res, next));
router.post('/settings/notices/save', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _setHandlers.noticeSave(req, res, next));
router.post('/settings/notices/delete', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _setHandlers.noticeDelete(req, res, next));
// ★ 087: 원본과 같은 권한(admin/master). dryRun 기본은 원본 핸들러가 판정한다.
router.post('/settings/review-type-cleanup', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _setHandlers.reviewTypeCleanup(req, res, next));

/* ══════════════════════════════════════════════════════════════
   시스템 오류로그 — 리뷰웹시스템[3버전] 「로그」 탭의 두 번째 서브탭

   ★ 데이터는 이미 쌓이고 있는 `error_logs`(마이그레이션 026/028) 그대로다.
     신규 테이블·신규 수집 경로 0 — 화면만 관리자 대시보드에서 작업보드로 옮긴다
     (사용자 확정 2026-08: 리뷰웹시스템[3버전]이 메인, 관리자 대시보드 폐기).
   ★ 로직은 한 줄도 베끼지 않고 기존 `/api/admin/error-logs*` 핸들러에 위임한다.
   ★ Track B 경로에 두는 이유 = C/S·설정과 같다: 인트라넷 SSO 토큰(`via:'intranet'`)은
     `/api/admin/*` 에 **도달 자체가 불가능**하다(authMiddleware 격리).
   ★ 권한은 원본과 1:1 로 **adminOrMaster** — 경로·스택·요청 컨텍스트가 실려
     AE 의 "담당 탭" 스코프로 나눌 수 있는 데이터가 아니다(등록리뷰어DB와 같은 판단).
   ★ 목록은 기본으로 **관리자 대시보드에서 난 오류를 제외**한다(utils/adminUiErrorFilter).
     프론트가 `includeAdminUi=1` 을 주면 그때만 포함 — 제외 건수는 응답이 함께 준다.
   ══════════════════════════════════════════════════════════════ */
const _errHandlers = {
  list:    _delegate(_adminRoutes, 'get',  '/error-logs'),
  detail:  _delegate(_adminRoutes, 'get',  '/error-logs/detail'),
  analyze: _delegate(_adminRoutes, 'post', '/error-logs/analyze'),
  status:  _delegate(_adminRoutes, 'post', '/error-logs/status'),
  resolve: _delegate(_adminRoutes, 'post', '/error-logs/resolve'),
};
router.get('/error-logs', authMiddleware, adminOrMasterMiddleware, (req, res, next) => {
  // ★ 기본 제외 = 이 화면의 정책. 원본 라우트는 opt-in(기본 미적용)이라 다른 소비처는 무영향.
  //   `includeAdminUi=1` 이면 원래대로 전부 보여준다(화면의 '제외분 포함해 보기').
  req.query = { ...req.query, excludeAdminUi: req.query.includeAdminUi ? '' : '1' };
  return _errHandlers.list(req, res, next);
});
router.get('/error-logs/detail', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _errHandlers.detail(req, res, next));
router.post('/error-logs/analyze', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _errHandlers.analyze(req, res, next));
router.post('/error-logs/status', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _errHandlers.status(req, res, next));
router.post('/error-logs/resolve', authMiddleware, adminOrMasterMiddleware, (req, res, next) =>
  _errHandlers.resolve(req, res, next));

/* ══════════════════════════════════════════════════════════════
   등록리뷰어DB — 리뷰웹시스템[3버전] 상단탭

   ★ **master/admin 전용**(`adminOrMasterMiddleware`). AE(staff)·광고주는 못 본다.
     AE는 "담당 업체 탭"으로만 스코프되는데 리뷰어DB는 담당과 무관한 전사 개인정보라,
     여기만 전체 공개하면 그 스코프 원칙이 깨진다(사용자 확정).
   ★ Track B 라우트에 두는 이유: 리뷰웹시스템[3버전]은 `/api/trackb/*` 하고만 통신하고,
     인트라넷 SSO 토큰(`via:'intranet'`)도 authMiddleware가 그 경로로만 격리한다.
     기존 `/api/reviewer/list`는 전 행을 한 번에 반환(검색·페이지 없음)이라 그대로 쓸 수 없다.
   ══════════════════════════════════════════════════════════════ */
router.get('/reviewers', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const status = String(req.query.status || '').trim();

    const where = [];
    const params = [];
    if (q) {
      // 이름 부분일치 또는 연락처 숫자 부분일치(하이픈 유무 무관).
      // ★ 자리표시자를 안 쓸 파라미터는 push 하지 않는다 — 숫자 없는 이름 검색에서
      //   "bind message supplies N parameters" 로 통째로 500 난다.
      const d = q.replace(/[^0-9]/g, '');
      const ors = [];
      params.push('%' + q + '%');
      ors.push(`name ILIKE $${params.length}`);
      if (d) {
        params.push('%' + d + '%');
        ors.push(`REGEXP_REPLACE(phone,'[^0-9]','','g') LIKE $${params.length}`);
        // 등록 계좌번호 부분일치(블랙리뷰어 추적 — 이름·번호를 바꿔 재가입해도 계좌로 찾는다)
        params.push('%' + d + '%');
        ors.push(`REGEXP_REPLACE(COALESCE(bank_account,''),'[^0-9]','','g') LIKE $${params.length}`);
      }
      where.push('(' + ors.join(' OR ') + ')');
    }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    // ── 자동 블랙리뷰어 필터(091-2) ──
    //   blacklist/available = blacklist 테이블 EXISTS(가벼움).
    //   candidate(미작성 1건↑)/overdue(기한경과 1건↑)는 review_index 파생 서브쿼리 —
    //   ★ 판정은 본인 명의 phone8 기준(타계정 미작성건은 표의 건수 표시에만 합산 · 문서화된 한계).
    const flag = String(req.query.flag || '').trim();
    if (flag === 'blacklist' || flag === 'available') {
      const ex = `EXISTS (SELECT 1 FROM blacklist b WHERE RIGHT(REGEXP_REPLACE(b.phone,'[^0-9]','','g'), 8) = reviewers.phone8)`;
      where.push(flag === 'blacklist' ? ex : `NOT ${ex}`);
    } else if (flag === 'candidate' || flag === 'overdue') {
      const { getCriteria } = require('../services/reviewerGate.service');
      const c = await getCriteria();
      const unsub = `NOT (ri.is_submitted = TRUE OR ri.review_file_id IS NOT NULL) AND os.submitted_at IS NOT NULL`;
      let cond;
      if (flag === 'candidate') {          // 미작성(30일↑) 1건 이상
        params.push(String(c.nowriteDays));
        cond = `${unsub} AND os.submitted_at < NOW() - ($${params.length} || ' days')::interval`;
      } else {                             // "기한경과만"(14일↑ ~ 30일 미만 — 미작성 승격분 제외)
        params.push(String(c.overdueDays));
        const pOver = params.length;
        params.push(String(c.nowriteDays));
        cond = `${unsub} AND os.submitted_at < NOW() - ($${pOver} || ' days')::interval
                        AND os.submitted_at >= NOW() - ($${params.length} || ' days')::interval`;
      }
      where.push(`reviewers.phone8 IN (
        SELECT ri.phone8 FROM review_index ri
        LEFT JOIN order_submissions os ON os.sheet_id = ri.sheet_id AND os.tab_name = ri.tab_name
              AND os.sheet_row = ri.row_index AND os.deleted_at IS NULL
        WHERE ${cond}
        GROUP BY ri.phone8)`);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM reviewers ${w}`, params);
    params.push(limit); params.push(offset);
    const { rows } = await pool.query(
      `SELECT id, name, phone, phone8, status, consent,
              income_type AS "incomeType", resident_num AS "residentNum",
              address, bank_name AS "bankName", bank_account AS "bankAccount",
              account_holder AS "accountHolder",
              COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(sub_accounts)='array'
                       THEN sub_accounts ELSE '[]'::jsonb END), 0) AS "subCount",
              sub_accounts AS "subAccounts",
              admin_memo AS "memo", registered_at AS "registeredAt"
         FROM reviewers ${w}
        ORDER BY registered_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    // ── 자동 블랙리뷰어 주석(091-2): 누적참여(타계정 포함)·미작성/기한경과·블랙리스트 상태 ──
    //   페이지 행(≤200)만 배치 집계 — 저장 없음(컬럼 박제 금지, 조회 시 파생).
    //   ★ 실패는 fail-soft + statsUnavailable — 프론트가 '?' 표기(0·정상으로 꾸미지 않는다, 088 규율).
    let statsUnavailable = false;
    try {
      const { annotateReviewerRows } = require('../services/reviewerGate.service');
      const anns = await annotateReviewerRows(rows.map(r => ({
        phone8: r.phone8,
        subPhone8s: (Array.isArray(r.subAccounts) ? r.subAccounts : [])
          .map(s => String((s && s.phone) || '').replace(/[^0-9]/g, '').slice(-8))
          .filter(p => p.length === 8),
      })));
      rows.forEach((r, i) => {
        r.reviewStats = anns[i].stats;
        r.blCandidate = anns[i].candidate;
        r.blacklisted = anns[i].blacklisted;
      });
    } catch (e) {
      statsUnavailable = true;
      logger.warn('[reviewers] 블랙리뷰어 주석 집계 실패(fail-soft): ' + e.message);
    }
    res.json({ ok: true, items: rows, total: cnt[0].n, limit, offset, ...(statsUnavailable ? { statsUnavailable: true } : {}) });
  } catch (err) { next(err); }
});

/* 전역 블랙리스트 토글(등록리뷰어DB 참여설정 스위치) — 즉시 적용(사용자 확정: 확인창 없음).
   기존 blacklist 테이블 재사용 · 효력 = 공고별 [🚫 리뷰어] 팝업 상단 자동 표시(Q1=B —
   전 공고 자동 차단은 여전히 CAMPAIGN_REVIEWER_GATE_GLOBAL=1 옵트인 뒤에만). */
router.post('/reviewers/blacklist', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { setGlobalBlacklist } = require('../services/reviewerGate.service');
    const b = req.body || {};
    const out = await setGlobalBlacklist({ phone: b.phone, on: b.on === true, reason: b.reason, by: _by(req) });
    logger.info(`[reviewers/blacklist] ${_by(req)} — ${String(b.phone || '').slice(-4)} ${out.on ? '등록' : '해제'}`);
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// 관리자 메모만 수정(사용자 확정: 다른 필드는 조회 전용 — 정산·신원 필드를 여기서 고치지 않는다)
router.post('/reviewers/memo', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const id = String((req.body && req.body.id) || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ ok: false, error: 'id(UUID)가 필요합니다.' });
    }
    const memo = String((req.body && req.body.memo) || '').slice(0, 2000);
    const { rowCount } = await pool.query('UPDATE reviewers SET admin_memo = $2 WHERE id = $1', [id, memo]);
    if (!rowCount) return res.status(404).json({ ok: false, error: '해당 리뷰어를 찾을 수 없습니다.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* 리뷰어 삭제(완전삭제) — master/admin(사용자 확정).
   ★★ **이력은 함께 지워지지 않는다.** 주문·참여·문의는 전부 `phone8`(연락처 뒤 8자리)로 매달려
     있고 `reviewers(id)` 를 FK 로 참조하는 테이블이 하나도 없다(001 스키마 확인). 그래서 이 행만
     사라지고 그 사람의 기록은 그대로 남는다 — 지운 결과가 "흔적 없이 사라짐"이 아니라
     **"등록만 취소됨"**(로그인·참여 게이트가 미등록으로 판정)이다. 관리자가 이걸 모르고 누르면
     "지웠는데 왜 로그에 남아 있냐"가 되므로 **건수를 먼저 보여준다**.
   ★ 2단 확인: force 없이 부르면 이력 건수만 세어 `needConfirm` 으로 돌려주고 **아무것도 지우지 않는다**
     (프론트가 그 숫자를 보여주고 다시 묻는다). 이력이 0이면 그 자리에서 바로 지운다.
   ★ 집계는 **fail-soft** — 옛 배포·테이블 부재로 카운트 쿼리가 실패해도 삭제 기능 자체가 죽지 않게
     하되, 세지 못한 사실을 `countsPartial` 로 알린다(0건으로 조용히 속이지 않는다). */
router.post('/reviewers/delete', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const id = String((req.body && req.body.id) || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ ok: false, error: 'id(UUID)가 필요합니다.' });
    }
    const force = (req.body && req.body.force) === true;

    const { rows: who } = await pool.query('SELECT id, name, phone, phone8 FROM reviewers WHERE id = $1', [id]);
    if (!who.length) return res.status(404).json({ ok: false, error: '해당 리뷰어를 찾을 수 없습니다.' });
    const r = who[0];
    const p8 = String(r.phone8 || '');

    // 이력 집계(삭제 대상이 아니라 **경고 재료**). 쿼리 하나가 실패해도 나머지는 센다.
    const counts = { orders: 0, applications: 0, inquiries: 0 };
    let countsPartial = false;
    if (p8) {
      const probes = [
        ['orders', 'SELECT COUNT(*)::int AS n FROM order_submissions WHERE phone8 = $1'],
        ['applications', 'SELECT COUNT(*)::int AS n FROM campaign_applications WHERE phone8 = $1 OR owner_phone8 = $1'],
        ['inquiries', 'SELECT COUNT(*)::int AS n FROM cs_threads WHERE reviewer_phone8 = $1'],
      ];
      for (const [key, sql] of probes) {
        try { const { rows } = await pool.query(sql, [p8]); counts[key] = rows[0].n | 0; }
        catch (e) { countsPartial = true; logger.warn(`[reviewers/delete] ${key} 집계 실패: ${e.message}`); }
      }
    }
    const historyTotal = counts.orders + counts.applications + counts.inquiries;

    if (!force && (historyTotal > 0 || countsPartial)) {
      return res.json({
        ok: false, needConfirm: true, counts, countsPartial, historyTotal,
        reviewer: { id: r.id, name: r.name, phone: r.phone },
      });
    }

    const { rowCount } = await pool.query('DELETE FROM reviewers WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: '해당 리뷰어를 찾을 수 없습니다.' });
    logger.warn(`[reviewers/delete] ${req.admin && req.admin.name} 가 리뷰어 삭제 — ${r.name}/${r.phone} (이력 ${historyTotal}건 잔존)`);
    res.json({ ok: true, deleted: 1, counts, historyTotal });
  } catch (err) { next(err); }
});

/* ══════════════════════════════════════════════════════════════
   모집공고별 참여가능 리뷰어 게이트 (블랙리스트 건별 관리, migration 091)
   ★ 전부 adminOrMaster — 검색이 **계좌번호**까지 받는 화면이라 등록리뷰어DB와 같은 판단
     (AE·광고주 차단, 응답의 연락처·계좌는 뒤4자리만).
   ★ Track B 경로 하나로 관리자 대시보드(admin_token)·리뷰웹시스템[3버전](인트라넷 SSO)
     양쪽이 그대로 닿는다(리뷰타입 정리 RTC_EP와 같은 판단 — 호스트별 재기준 불필요).
   ★ 42P01(마이그레이션 미적용)은 not_ready 로 말한다 — /api/trackb/* 는 isAdminApi 밖이라
     그대로 올리면 마스킹된 200 "서버 오류"가 되어 원인을 알 길이 없다(088 규율).
   ══════════════════════════════════════════════════════════════ */
function _rgNotReady(res, err) {
  if (err && err.code === '42P01') {
    res.json({ ok: false, code: 'not_ready', error: '참여 리뷰어 게이트 준비 전입니다(migration 091 미적용) — 배포 완료 후 다시 시도해주세요.' });
    return true;
  }
  return false;
}

router.get('/campaigns/:id/reviewer-gate', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { listGates, getCriteria, listGlobalBlacklist } = require('../services/reviewerGate.service');
    const data = await listGates(String(req.params.id));
    // 전역 블랙리스트를 팝업 상단에 자동 표시(후속조치, Q1=B — 표시일 뿐 자동 차단 아님).
    // 조회 실패는 fail-soft(필드 미동봉 → 프론트가 구역을 안 그림 — 빈 배열로 "블랙 0명" 꾸미지 않는다).
    let globalBlacklist;
    try { globalBlacklist = await listGlobalBlacklist(String(req.params.id)); }
    catch (e) { logger.warn('[reviewer-gate] 블랙리스트 목록 실패(fail-soft): ' + e.message); }
    res.json({ ok: true, ...data, criteria: await getCriteria(), ...(globalBlacklist ? { globalBlacklist } : {}) });
  } catch (err) { if (!_rgNotReady(res, err)) next(err); }
});

router.get('/campaigns/:id/reviewer-gate/search', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { searchReviewers } = require('../services/reviewerGate.service');
    res.json({ ok: true, ...(await searchReviewers(String(req.params.id), req.query.q)) });
  } catch (err) { if (!_rgNotReady(res, err)) next(err); }
});

router.post('/campaigns/:id/reviewer-gate', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { applyGateChanges, listGates } = require('../services/reviewerGate.service');
    const campaignId = String(req.params.id);
    const out = await applyGateChanges(campaignId, (req.body || {}).changes, _by(req));
    logger.info(`[reviewerGate] ${_by(req)} 가 공고 ${campaignId} 예외 ${out.applied.length}건 적용`);
    res.json({ ok: true, ...out, ...(await listGates(campaignId)) });
  } catch (err) { if (!_rgNotReady(res, err)) next(err); }
});

// 블랙리스트 관리기준(사용자 확정 Q4 — 판정 일수 별도 설정) : 설정탭 "블랙리스트 관리기준" 패널이 사용
router.get('/settings/reviewer-gate-criteria', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { getCriteria } = require('../services/reviewerGate.service');
    res.json({ ok: true, criteria: await getCriteria() });
  } catch (err) { next(err); }
});

router.post('/settings/reviewer-gate-criteria', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { saveCriteria } = require('../services/reviewerGate.service');
    res.json({ ok: true, criteria: await saveCriteria(req.body || {}) });
  } catch (err) { next(err); }
});

router.get('/reviewer-logs', authMiddleware, internalMiddleware, async (req, res, next) => {
  try {
    const { listReviewerEvents, unresolvedCounts } = require('../services/reviewerEventLog.service');
    const { sheetId, tabName, severity, eventType, unresolved, limit, offset } = req.query || {};
    const scopeTabs = await _logScopeTabs(req);
    if (scopeTabs && !scopeTabs.length) return res.json({ ok: true, items: [], counts: { total: 0, critical: 0 } });
    const opts = {
      sheetId: sheetId || '', tabName: tabName || '', severity: severity || '', eventType: eventType || '',
      unresolvedOnly: unresolved === '1',
      limit: parseInt(limit, 10) || 100, offset: parseInt(offset, 10) || 0,
      scopeTabs,
    };
    res.json({ ok: true, items: await listReviewerEvents(opts), counts: await unresolvedCounts(scopeTabs) });
  } catch (err) { next(err); }
});

// 「이 알림은 사실 내가 취소한 건입니다」 1클릭 처리 — 주문을 취소로 확정해 재기록을 멈춘다.
//   (시트에서 행을 지우거나 값을 비운 것이 '의도된 취소'였을 때의 정식 경로.
//    시스템은 시트만 봐서는 의도를 알 수 없어 기본이 '재기록'이므로, 사람이 알려주는 이 신호가 필요하다.)
router.post('/reviewer-logs/cancel-order', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { cancelOrderFromEvent } = require('../services/reviewerEventLog.service');
    const out = await cancelOrderFromEvent({ id: (req.body || {}).id, by: _by(req) });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { next(err); }
});

// 확인(해결)은 전역 진실원본이라 admin/master 전용 — staff가 타 담당자의 미확인 중요알림을 지우지 못하게.
router.post('/reviewer-logs/resolve', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { resolveReviewerEvent } = require('../services/reviewerEventLog.service');
    const { id } = req.body || {};
    res.json(await resolveReviewerEvent(id, _by(req)));
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════
// 작업표(worktable) — M1: 헤더 학습 리포트 (읽기 전용)
//   "작업표에 어떤 열이 고정으로 들어가고 어떤 열이 변칙인가"를 운영 중인 실제 탭 통계로 답한다.
//   ★ adminOrMaster — **전사 통계**라 AE의 "담당 탭" 스코프로 나눌 성격이 아니다
//     (등록리뷰어DB·C/S 문의와 같은 판단). 시트 재읽기 0, 상태 변경 0.
// ══════════════════════════════════════════════════════════════════
router.get('/worktable/header-stats', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { headerStats } = require('../services/worktable.service');
    const data = await headerStats({ limit: parseInt((req.query || {}).limit, 10) || 500 });
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// 표준 열 템플릿 — 관리자가 확정하는 "우리 작업표의 기본 열"(M2 생성 미리보기의 기본값).
//   ★ 리포트는 통계를 보여줄 뿐이고 **무엇을 쓸지 정하는 건 사람**이라, 그 결정을 여기 못박는다.
//   ★ 전사 설정이라 adminOrMaster(AE 는 열람·수정 모두 불가 — 리포트와 같은 판단).
router.get('/worktable/template', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { getTemplate } = require('../services/worktable.service');
    res.json({ ok: true, data: await getTemplate() });
  } catch (err) { next(err); }
});
// 작업표 생성 미리보기 — ★ 읽기 전용(DB·시트 쓰기 0). 실제 생성은 사람이 확인 후 누를 때만(M2b).
//   권한 = 작업오더 편집 명단(editorOnly) — 표를 만들 사람이 미리보기를 본다.
router.get('/worktable/plan', authMiddleware, internalMiddleware, editorOnlyMiddleware, async (req, res, next) => {
  try {
    const { getTemplate } = require('../services/worktable.service');
    const { buildWorktablePlan } = require('../utils/worktablePlan');
    const q = req.query || {};
    const id = String(q.workOrderId || '').trim();
    if (!id) return res.json({ ok: false, error: 'workOrderId 가 필요합니다.' });

    const { rows } = await pool.query(
      `SELECT id, title, start_date, recruit_count, daily_count, product_url,
              product_option, product_options_json, work_sheet_url, status
         FROM work_orders WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [id]);
    const wo = rows[0];
    if (!wo) return res.json({ ok: false, error: '작업오더를 찾을 수 없습니다.' });

    // 미리보기에서 사람이 조정한 값만 덮어쓴다(미전송 = 작업오더 값 유지).
    const opt = {};
    if (q.total != null && q.total !== '') opt.total = q.total;
    if (q.daily != null && q.daily !== '') opt.daily = q.daily;
    if (q.startDate != null && q.startDate !== '') opt.startDate = q.startDate;
    if (q.skipWeekends != null && q.skipWeekends !== '') opt.skipWeekends = q.skipWeekends !== '0' && q.skipWeekends !== 'false';
    if (q.channel) opt.channel = String(q.channel);
    if (q.options) { try { opt.options = JSON.parse(q.options); } catch (_) { /* 깨진 값은 작업오더 파생으로 */ } }
    /* 켠 작업유형 — 쉼표 구분 키. ★ 미전송 = 없음(제안을 서버가 조용히 적용하지 않는다). */
    if (q.workTypes != null) opt.workTypes = String(q.workTypes).split(',').map(v => v.trim()).filter(Boolean);
    // 제외 날짜(공휴일·업체 휴무) — 쉼표 구분 YYYY-MM-DD. 형식 검증은 plan 이 최종 판정한다.
    if (q.holidays) opt.holidays = String(q.holidays).split(',').map(v => v.trim()).filter(Boolean);

    const template = await getTemplate();
    const plan = buildWorktablePlan({ workOrder: wo, template, options: opt });
    res.json({ ok: true, data: { plan, workOrder: { id: wo.id, title: wo.title, status: wo.status, workSheetUrl: wo.work_sheet_url || '' }, templateConfigured: !!template.configured } });
  } catch (err) { next(err); }
});

// 작업표 생성 — 시트 탭을 만들고 열 이름 줄 + N행을 쓴다.
//   ★ 계획은 서버가 **다시 계산**한다(화면이 보낸 행 목록 미신뢰). 잠긴 계획은 생성하지 않는다.
//   ★ 탭 등록(tab_configs)은 여전히 접수(accept)가 유일한 관문 — 여기서는 등록하지 않는다.
router.post('/worktable/create', authMiddleware, internalMiddleware, editorOnlyMiddleware, async (req, res, next) => {
  try {
    const { createWorktable } = require('../services/worktableCreate.service');
    const b = req.body || {};
    if (!b.workOrderId) return res.json({ ok: false, error: 'workOrderId 가 필요합니다.' });
    const r = await createWorktable({
      workOrderId: String(b.workOrderId),
      mode: b.mode === 'new' ? 'new' : 'existing',
      sheetId: b.sheetId || '',
      fileTitle: b.fileTitle || '',
      tabName: b.tabName || '',
      templateSheetId: b.templateSheetId || '',
      planOptions: b.planOptions || {},
      by: _by(req),
    });
    res.json(r);
  } catch (err) { next(err); }
});

// 작업표 되돌리기 — 작업대 표의 줄만 내린다(시트·주문 원장 무접촉).
//   ★ 주문이 들어온 줄이 있으면 목록을 돌려주고, 담당자가 "내부 테스트건" 확인 후
//     confirmed:true 로 다시 부를 때만 최종 삭제(사용자 확정).
router.post('/worktable/delete', authMiddleware, internalMiddleware, editorOnlyMiddleware, async (req, res, next) => {
  try {
    const { deleteWorktableRows } = require('../services/participants.service');
    const b = req.body || {};
    if (!b.sheetId || !b.tabName) return res.json({ ok: false, error: 'sheetId, tabName 이 필요합니다.' });
    const r2 = await deleteWorktableRows({
      sheetId: String(b.sheetId), tabName: String(b.tabName),
      confirmed: b.confirmed === true, by: _by(req),
    });
    res.json(r2);
  } catch (err) { next(err); }
});

// 작업표 **시트 탭** 삭제 — 아무도 안 쓴 탭만(주문·참여자 0건). gid 는 서버가 이름으로 재조회.
router.post('/worktable/delete-tab', authMiddleware, internalMiddleware, editorOnlyMiddleware, async (req, res, next) => {
  try {
    const { deleteWorktableTab } = require('../services/worktableCreate.service');
    const b = req.body || {};
    res.json(await deleteWorktableTab({ sheetId: b.sheetId, tabName: b.tabName, by: _by(req) }));
  } catch (err) { next(err); }
});

/* 무시트 탭 줄 정리(은퇴) — 작업표에서 고른 줄을 내리고 장부를 다시 만든다.
   ★ adminOrMaster — 검색 명단에서 사람을 빼는 조작이라 정원 변경(날짜별 인원)과 같은 급.
   ★ dryRun 기본(`dryRun !== false`) — 값이 빠진 요청이 곧바로 실행되지 않는다. */
router.post('/worktable/retire-rows', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { retireRows, LedgerError } = require('../services/sheetlessLedger.service');
    const b = req.body || {};
    try {
      res.json(await retireRows({
        sheetId: b.sheetId, tabName: b.tabName, rounds: b.rounds, seqs: b.seqs,
        dryRun: b.dryRun !== false, by: _by(req),
      }));
    } catch (e) {
      if (e instanceof LedgerError) return res.status(400).json({ ok: false, code: e.code, error: e.message });
      throw e;
    }
  } catch (err) { next(err); }
});

/* 블로거 사전등록(M5-2) — 공고 밖에서 섭외한 블로거를 그 작업의 표에 한 줄로 넣는다.
   ★ 게이트 = `_ensureEditScope`(master/admin 전체 · staff 담당 탭 · 광고주 차단) — 그리드 셀 편집과 같은 범위.
     명단 한 줄 추가는 정원·총량을 바꾸지 않는다(정원 조작은 adminOrMaster 유지).
   ★ 검증 실패는 400대로 매핑 — errorHandler 500 마스킹이면 담당자가 무엇을 고칠지 모른다. */
router.post('/worktable/add-blogger', authMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const sheetId = String(b.sheetId || ''), tabName = String(b.tabName || '');
    const scope = await _ensureEditScope(req, sheetId, tabName);
    if (!scope.ok) return res.status(scope.code).json({ ok: false, error: scope.error });
    const { registerBlogger, BlogRegisterError } = require('../services/blogRegister.service');
    try {
      res.json(await registerBlogger({
        sheetId, tabName, name: b.name, phone: b.phone, blogUrl: b.blogUrl,
        dryRun: b.dryRun === true, by: _by(req),
      }));
    } catch (e) {
      if (e instanceof BlogRegisterError) return res.status(400).json({ ok: false, code: e.code, error: e.message });
      if (e && (e.code === '42P01' || e.code === '42703')) {
        return res.status(503).json({ ok: false, code: 'not_ready', error: '마이그레이션 적용 대기 중입니다(101).' });
      }
      throw e;
    }
  } catch (err) { next(err); }
});

router.post('/worktable/template', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { saveTemplate } = require('../services/worktable.service');
    const b = req.body || {};
    const data = await saveTemplate({
      core: b.core, channels: b.channels,
      customChannels: b.customChannels, workTypes: b.workTypes,
      templateSheetId: b.templateSheetId, by: _by(req),
    });
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

/* ══════════════════════════════════════════════════════════════
   입금관리 — 리뷰비 입금 자동화 M1
     · 입금대상 추출 → 은행별 자동분류 → 다건이체 서식 다운로드 → 회차(잠금) 기록

   ★ 권한 = **master/admin 전용**(adminOrMaster). 계좌번호 전체가 화면·파일에 실리므로
     등록리뷰어DB 와 같은 규율로 AE(staff)·광고주에게 열지 않는다.
   ★ 이 블록의 쓰기 표면은 payment_batches / payment_batch_items 두 테이블뿐이다.
     시트·주문원장·review_index 는 읽기만 한다(시트 입금칸 기록은 M2).
   설계 문서: frontend/docs/prd-payment-transfer.html
   ══════════════════════════════════════════════════════════════ */
const paymentSvc = require('../services/payment.service');
const _bankNames = require('../services/bankNameOverride.service');

// 오늘 입금해야 할 건 + 은행별 집계
router.get('/payment/targets', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const out = await paymentSvc.listPaymentTargets({
      sheetId: String(req.query.sheetId || '').trim() || undefined,
      tabName: String(req.query.tabName || '').trim() || undefined,
    });
    res.json({ ok: true, items: out.items, summary: out.summary });
  } catch (err) { next(err); }
});

// 회차 생성(= 다운로드 잠금). 파일은 아래 /file 로 따로 받는다 —
// 한 응답에 파일과 경고(skipped)를 같이 실을 수 없기 때문이다.
router.post('/payment/batch', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await paymentSvc.createBatch({
      bank: String(b.bank || '').trim(),
      rows: Array.isArray(b.rows) ? b.rows : [],
      by: _by(req),
    });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { next(err); }
});

// 회차 목록 / 상세
router.get('/payment/batches', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, items: await paymentSvc.listBatches(parseInt(req.query.limit, 10) || 50) }); }
  catch (err) { next(err); }
});
router.get('/payment/batch/:id', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const out = await paymentSvc.getBatch(req.params.id);
    if (!out) return res.status(404).json({ ok: false, error: '회차를 찾을 수 없습니다.' });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// 은행 서식 파일 — 재다운로드도 이력에 남는다(사용자 확정 규칙)
router.get('/payment/batch/:id/file', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const out = await paymentSvc.getBatch(req.params.id);
    if (!out) return res.status(404).json({ ok: false, error: '회차를 찾을 수 없습니다.' });
    if (out.batch.status === 'cancelled') {
      return res.status(400).json({ ok: false, error: '취소된 회차는 내려받을 수 없습니다.' });
    }
    const live = out.items.filter(i => i.status !== 'cancelled');
    const buf = await paymentSvc.buildWorkbook(out.batch.bank, live);
    await paymentSvc.markDownloaded(out.batch.id, _by(req));
    const name = paymentSvc.batchFileName(out.batch);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // 한글 파일명 — RFC 5987(filename*)로 보내고 ASCII 폴백을 함께 준다
    res.setHeader('Content-Disposition',
      `attachment; filename="payment_${out.batch.seq}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buf);
  } catch (err) { next(err); }
});

// 회차 취소 — 잠금 해제(항목이 다시 입금대상으로 돌아온다)
router.post('/payment/batch/:id/cancel', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const out = await paymentSvc.cancelBatch(req.params.id, _by(req));
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { next(err); }
});

/* ── 보류 사유 보완 ─────────────────────────────────────────
   ★ 권한은 입금관리 화면과 같은 adminOrMaster — 계좌번호가 그대로 보이는 화면이고,
     이체은행은 "어느 통장에서 나가는가"라 되돌리기 쉬운 값이 아니다.
   ★ 검증 실패(PaymentFixError)는 **400대**로 내린다 — errorHandler 가 500 으로 마스킹하면
     화면이 사유를 못 보여주고 담당자가 무엇을 고쳐야 할지 알 수 없다. */
const _PAY_FIX_STATUS = {
  bad_target: 400, empty: 400, bad_bank: 400, bad_bank_name: 400, bad_reviewer: 400,
  campaign_mismatch: 409, tab_not_found: 404, reviewer_not_found: 404, sub_not_found: 404,
};
function _payFix(res, err, next) {
  if (err && err.code && _PAY_FIX_STATUS[err.code]) {
    return res.status(_PAY_FIX_STATUS[err.code]).json({ ok: false, code: err.code, error: err.message });
  }
  // 42P01/42703 = 스키마 미적용 — /api/trackb/* 는 마스킹 대상이라 사유를 직접 실어 준다
  if (err && (err.code === '42P01' || err.code === '42703')) {
    return res.status(503).json({ ok: false, code: 'not_ready', error: '입금 설정 컬럼이 아직 준비되지 않았습니다(배포 직후일 수 있습니다).' });
  }
  return next(err);
}

/* ── 🏦 은행 이름 설정 — 정식 명칭 · 자동인식 표기 인라인 관리 ────────────────
   ★ 판정 단일 출처는 `utils/bankCodes.resolveBank` 그대로 — 여기서 바꾸는 것은
     그 표의 **내용**뿐이다(정확일치·모르면 null 규칙 불변).
   ★ adminOrMaster — 잘못 넣으면 **남의 계좌로 돈이 간다**(입금관리 화면과 같은 게이트).
   ★ 겹침(같은 표기가 두 은행)은 서버가 저장 자체를 막는다(유일한 하드블록). */
router.get('/payment/bank-names', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try { res.json(await _bankNames.bankNamesView()); }
  catch (err) { _payFix(res, err, next); }
});

router.post('/payment/bank-names', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await _bankNames.saveBankOverrides({
      payload: { banks: b.banks, extra: b.extra }, by: _by(req), rev: b.rev,
    });
    if (!out.ok) return res.status(out.code === 'stale' ? 409 : 400).json(out);
    logger.info(`[payment] 은행 표기 저장 by ${_by(req)} — 변경 ${out.changed}건`);
    res.json(out);
  } catch (err) { _payFix(res, err, next); }
});

// 작업 단위 — 이체은행 · 통장표시(저장하면 그 작업의 모든 행이 함께 풀린다)
router.post('/payment/transfer-setting', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await paymentSvc.saveTransferSetting({
      sheetId: b.sheetId, tabName: b.tabName, campaignId: b.campaignId || null,
      bank: b.bank, memo: b.memo,
    });
    logger.info(`[payment] 이체설정 저장 by ${_by(req)} — ${b.tabName} → ${out.target}/${out.bank || '자동'}`);
    res.json(out);
  } catch (err) { _payFix(res, err, next); }
});

// 리뷰어 단위 — 은행명 · 계좌번호 · 예금주(그 리뷰어의 모든 행이 함께 풀린다)
router.post('/payment/reviewer-account', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await paymentSvc.saveReviewerAccount({
      reviewerId: b.reviewerId, subPhone8: b.subPhone8,
      bankName: b.bankName, bankAccount: b.bankAccount, accountHolder: b.accountHolder,
    });
    logger.info(`[payment] 리뷰어 계좌 보완 by ${_by(req)} — ${out.target}`);
    res.json(out);
  } catch (err) { _payFix(res, err, next); }
});

/* ── M2: 이체결과 파일 반영 ─────────────────────────────────
   ★ 미리보기(result-preview)는 **쓰기 0** — 사람이 확인 화면을 본 뒤에만 반영한다.
   ★ 반영(result-apply)은 서버가 **파일을 다시 해석·재매칭**한다(화면이 보낸 목록 불신).
   ★ 42P01(migration 100 미적용) = `not_ready` 로 사유를 말한다(마스킹된 200 방지 — 088 규율). */
const paymentResultSvc = require('../services/paymentResult.service');

function _resultErr(err, res, next) {
  if (err && err.code === '42P01') {
    return res.status(503).json({ ok: false, code: 'not_ready',
      error: '이체결과 반영 저장소가 아직 준비되지 않았습니다(마이그레이션 100 적용 후 다시 시도하세요).' });
  }
  if (err instanceof paymentResultSvc.ResultError) {
    const code = err.code === 'not_found' ? 404 : err.code === 'too_large' ? 413 : 400;
    return res.status(code).json({ ok: false, code: err.code, error: err.message });
  }
  return next(err);
}

router.post('/payment/batch/:id/result-preview', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await paymentResultSvc.previewResultFile({
      batchId: req.params.id, fileName: b.fileName, base64: b.base64 || b.file,
    }));
  } catch (err) { _resultErr(err, res, next); }
});

router.post('/payment/batch/:id/result-apply', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    // ★ 사람이 확인 화면에서 누른 것만 반영한다(빠뜨리면 업로드 즉시 입금 기록이 되어 되돌릴 수 없다).
    if (b.confirm !== true) {
      return res.status(400).json({ ok: false, code: 'need_confirm', error: '확인 화면에서 [이대로 반영]을 눌러 주세요.' });
    }
    res.json(await paymentResultSvc.applyResultFile({
      batchId: req.params.id, fileName: b.fileName, base64: b.base64 || b.file, by: _by(req),
      // ★ 기본은 보냄 — 화면에서 명시적으로 끈 경우(`false`)만 안 보낸다(검수 반려 팝업과 같은 규율).
      notifyFailed: b.notifyFailed !== false,
    }));
  } catch (err) { _resultErr(err, res, next); }
});

module.exports = router;
