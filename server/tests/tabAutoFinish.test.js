/**
 * tabAutoFinish.test.js — 작업 자동 마감 회귀가드 (2026-09-21 사용자 확정)
 * 실행: node tests/tabAutoFinish.test.js
 *
 * 무엇을 고정하나 — 이 기능이 깨지면 아픈 것 다섯.
 *  ① **판정 사본 0** — 자동 마감 대상은 화면의 `✓ 마감 후보` 배지와 **같은 함수**(finishCandidate).
 *     여기서 조건을 복사해 가면 "배지는 떴는데 안 넘어간다"(또는 그 반대)가 생긴다.
 *  ② **되돌린 작업은 다시 마감하지 않는다** — 사람이 [↩ 진행중으로 복귀]를 눌렀다는 것은
 *     "아직 아니다"라는 판단이다. 이 제외가 없으면 되돌려도 다음 주기에 또 마감돼
 *     **되돌릴 방법 자체가 사라진다**(막다른 길).
 *  ③ **모르면 마감하지 않는다(fail-closed)** — 통계·마감목록·탭메타 중 하나라도 조회에 실패하면
 *     한 건도 건드리지 않는다. 마감은 되돌릴 수 있지만 되돌리는 순간 자동 경로에서 영구 제외되므로
 *     (②의 귀결) 잘못된 마감의 값이 싸지 않다.
 *  ④ **검수 게이트가 자동 경로로 무력화되지 않는다** — `auto` 는 서버 코드만 세운다.
 *     라우트가 body 로 받는 순간 확인창을 우회한 요청이 그대로 통과한다(사람 경로는 여전히 거부).
 *     그리고 자동 마감은 `inspect_confirmed_at` 을 **NULL 로 남긴다**(사람이 확인하지 않았는데
 *     확인 시각을 박으면 책임추적 원장이 거짓을 말한다).
 *  ⑤ **조용히 옮기지 않는다** — 보관함이 "왜 여기 있는지"와 되돌리는 길을 화면이 말한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 작업 자동 마감 회귀가드\n');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const WD = F('workdesk.html');
const ROUTES = S('src/routes/trackB.routes.js');
const SVC_SRC = S('src/services/trackB.service.js');
const CRON = S('src/jobs/cron.js');

const pool = require('../src/db/pool');
const svc = require('../src/services/trackB.service');
const origQuery = pool.query.bind(pool);

/* ── 자동 마감 함수 본문만 잘라서 본다 ────────────────────────────────────────
   ★ 파일 전체 검사는 "다른 함수에 그 문자열이 있으면" 통과시킨다(레포 실측 함정 — 같은 3줄을
     가진 fetch 헬퍼가 둘이라 변경이 엉뚱한 곳에 붙었다). 함수 경계로 자른다. */
const AF_START = SVC_SRC.indexOf('async function autoFinishEligibleTabs(');
assert(AF_START > 0, 'autoFinishEligibleTabs 정의를 찾지 못했습니다');
const AF_END = SVC_SRC.indexOf('\n}', SVC_SRC.indexOf('\n  return out;\n}', AF_START));
const AF = SVC_SRC.slice(AF_START, AF_END > AF_START ? AF_END : AF_START + 6000);

/* ═══ 1) 판정 단일 출처 ═══════════════════════════════════════════════════ */
console.log('1) 판정 사본 0');
t('★★ 대상 판정은 finishCandidate 를 **호출**한다(조건을 복사해 오지 않는다)',
  /finishCandidate\(/.test(AF));
t('★★ 자동 마감 본문에 조건식 사본이 없다(submitted>=total && paid>=total 을 다시 쓰지 않는다)',
  !/submitted[^\n]{0,40}>=[^\n]{0,40}total/.test(AF) && !/paid[^\n]{0,40}>=[^\n]{0,40}total/.test(AF), AF.slice(0, 0));
t('재료도 홈·업체관리와 같은 tabStatsMap 하나', /tabStatsMap\(/.test(AF));
t('★ 통계는 force 로 다시 읽는다(30초 캐시의 낡은 값으로 마감하지 않는다)',
  /tabStatsMap\(\{\s*force:\s*true\s*\}\)/.test(AF));

/* ═══ 2) 서버 판정 ≡ 화면 판정 — 실제 실행으로 등가 확인 ════════════════════ */
console.log('\n2) 서버 finishCandidate ≡ 화면 isFinishCandidate (실행 대조)');
const m = WD.match(/function isFinishCandidate\(t\)\{([\s\S]*?)\n\}/);
assert(m, '화면 isFinishCandidate 를 찾지 못했습니다');
// eslint-disable-next-line no-new-func
const clientCand = new Function('t', m[1]);
const CASES = [
  { total: 10, submitted: 10, paid: 10 },   // 정확히 충족
  { total: 10, submitted: 10, paid: 9 },    // 입금 한 건 모자람
  { total: 10, submitted: 9, paid: 10 },    // 제출 한 건 모자람
  { total: 10, submitted: 12, paid: 11 },   // 초과(총건수 넘겨 들어온 작업)
  { total: 0, submitted: 0, paid: 0 },      // 준비된 줄 0
  { total: null, submitted: 3, paid: 3 },   // 총건수 미상
  { total: 5, submitted: null, paid: 5 },   // 제출 미상
];
for (const st of CASES) {
  t(`등가: total=${st.total} submitted=${st.submitted} paid=${st.paid}`,
    clientCand({ stats: st }) === svc.finishCandidate(st),
    `client=${clientCand({ stats: st })} server=${svc.finishCandidate(st)}`);
}
t('★ 통계 자체가 없으면 양쪽 다 false(모르면 마감하지 않는다)',
  clientCand({}) === false && svc.finishCandidate(null) === false);

/* ═══ 3) setTabFinished 의 auto 계약 ═══════════════════════════════════════ */
console.log('\n3) auto 계약 (서비스 실행)');
let SQL = [];
const stub = (impl) => { SQL = []; pool.query = async (q, p) => { SQL.push({ q: String(q), p }); return impl ? impl(String(q), p) : { rows: [], rowCount: 0 }; }; };

(async () => {
  // ①-a 사람 경로는 **여전히** 검수 확인 없이는 거부(무회귀 — 자동 도입이 사람 게이트를 풀면 안 된다)
  stub();
  const denied = await svc.setTabFinished({ sheetId: 'S1', tabName: 'T1', finish: true, inspected: false, by: '만두' });
  t('★★ 사람 경로는 검수 확인 없으면 여전히 거부(자동 도입이 그 게이트를 풀지 않는다)',
    denied.ok === false && denied.code === 'inspect_required');
  t('★ 거부 시 DB 쿼리 0건', SQL.length === 0);

  // ①-b auto 경로는 통과하되 inspect_confirmed_at 을 NULL 로 남긴다
  stub(() => ({ rows: [{ id: 7, finishedAt: '2026-09-21T00:00:00Z' }], rowCount: 1 }));
  const auto = await svc.setTabFinished({ sheetId: 'S1', tabName: 'T1', tabGid: '9', finish: true, auto: true, by: '자동 마감' });
  t('자동 경로는 검수 확인 없이 마감된다(사용자 확정)', auto.ok === true && auto.finished === true);
  t('★★ 검수 확인 시각은 NULL — 사람이 확인하지 않았는데 확인 시각을 박지 않는다',
    /CASE WHEN \$5::bool THEN NULL ELSE NOW\(\) END/.test(SQL[0].q) && SQL[0].p[4] === true,
    JSON.stringify(SQL[0].p));
  t('마감자를 기록한다(보관함 "마감자" 칸·작업 로그가 그대로 읽는다)', SQL[0].p.includes('자동 마감'));
  t('★ gid 를 함께 박는다(운영 중 리네임 대비 — 088 규율)', SQL[0].p.includes('9'));

  // ①-c auto:true 가 아닌 truthy 값으로는 통과하지 않는다(문자열 'true' 등)
  stub();
  const sneaky = await svc.setTabFinished({ sheetId: 'S1', tabName: 'T1', finish: true, auto: 'true', by: 'x' });
  t('★ auto 는 엄격히 true 일 때만(문자열 \'true\' 로는 게이트를 못 연다)',
    sneaky.ok === false && sneaky.code === 'inspect_required' && SQL.length === 0);

  /* ═══ 4) 대상 선별 — 서비스 실제 실행 ═══════════════════════════════════ */
  console.log('\n4) 대상 선별 (서비스 실행)');
  // 스텁 분기 — ★ 더 좁은 조건을 먼저(레포 실측 함정: 넓은 패턴이 앞 순서면 다른 쿼리를 가로챈다)
  const mkStub = ({ stats, finished, meta, failStats, failFinished, failMeta }) => {
    SQL = [];
    pool.query = async (q, p) => {
      const s = String(q); SQL.push({ q: s, p });
      if (/everReopened/.test(s)) { if (failMeta) throw new Error('meta boom'); return { rows: meta || [], rowCount: (meta || []).length }; }
      if (/FROM trackb_tab_finished WHERE deleted_at IS NULL/.test(s)) { if (failFinished) throw new Error('fin boom'); return { rows: finished || [], rowCount: (finished || []).length }; }
      if (/FROM tab_configs tc/.test(s)) { if (failStats) throw new Error('stats boom'); return { rows: stats || [], rowCount: (stats || []).length }; }
      return { rows: [], rowCount: 0 };
    };
  };
  const statRow = (sheetId, tabName, total, submitted, paid) => ({
    sheetId, tabName, manager: '만두', campaignName: '', displayName: tabName,
    folderUrl: null, captureFolderUrl: null, incomeType: '', captureSlots: null,
    cashReceiptRequired: false, orderWorkManager: null,
    rowCount: total, filledCount: total, submittedCount: submitted, paidCount: paid,
    closeoutDate: null, closeoutRows: null,
  });
  const metaRow = (sheetId, tabName, tabGid, everReopened) => ({ sheetId, tabName, tabGid, everReopened });

  // 4-a 정상: 후보 1건만 마감 (미달 1건·이미 마감 1건·복귀 이력 1건은 제외)
  mkStub({
    stats: [statRow('S', 'A', 10, 10, 10), statRow('S', 'B', 10, 10, 9), statRow('S', 'C', 5, 5, 5), statRow('S', 'D', 3, 3, 3)],
    finished: [{ sheetId: 'S', tabName: 'C', tabGid: '3', finishedAt: 'x', finishedBy: 'y' }],
    meta: [metaRow('S', 'A', '1', false), metaRow('S', 'B', '2', false), metaRow('S', 'C', '3', false), metaRow('S', 'D', '4', true)],
  });
  const r1 = await svc.autoFinishEligibleTabs({ dryRun: true });
  t('후보 = 인원·제출·입금 모두 충족한 것만', r1.ok === true && r1.candidates.length === 1 && r1.candidates[0].tabName === 'A',
    JSON.stringify(r1.candidates.map(c => c.tabName)));
  t('★ 입금이 한 건이라도 모자라면 대상 아님', !r1.candidates.some(c => c.tabName === 'B'));
  t('★ 이미 마감된 작업은 다시 마감하지 않는다', !r1.candidates.some(c => c.tabName === 'C'));
  t('★★ 사람이 되돌린 작업은 영구 제외(되돌릴 길을 지킨다)',
    !r1.candidates.some(c => c.tabName === 'D') && r1.skippedReopened === 1);
  t('★ 미리보기는 쓰기 0건(INSERT/UPDATE 없음)',
    !SQL.some(x => /INSERT INTO|UPDATE /i.test(x.q)), SQL.map(x => x.q.slice(0, 40)).join(' | '));

  // 4-b 이름이 바뀐 탭 — gid 로도 마감 여부를 본다
  mkStub({
    stats: [statRow('S', 'NEW', 4, 4, 4)],
    finished: [{ sheetId: 'S', tabName: 'OLD', tabGid: '77', finishedAt: 'x', finishedBy: 'y' }],
    meta: [metaRow('S', 'NEW', '77', false)],
  });
  const r2 = await svc.autoFinishEligibleTabs({ dryRun: true });
  t('★ 리네임된 탭도 gid 로 마감을 알아본다(같은 작업을 두 번 마감하지 않는다)', r2.candidates.length === 0);

  // 4-c 실행 — 후보만큼 INSERT
  mkStub({
    stats: [statRow('S', 'A', 2, 2, 2), statRow('S', 'B', 2, 2, 2)],
    finished: [], meta: [metaRow('S', 'A', '1', false), metaRow('S', 'B', '2', false)],
  });
  const prevQ = pool.query;
  let inserts = 0;
  pool.query = async (q, p) => { if (/INSERT INTO trackb_tab_finished/.test(String(q))) { inserts++; return { rows: [{ id: inserts, finishedAt: 'z' }], rowCount: 1 }; } return prevQ(q, p); };
  const r3 = await svc.autoFinishEligibleTabs({ dryRun: false });
  t('실행하면 후보 수만큼 마감된다', r3.ok === true && r3.finished === 2 && inserts === 2, `finished=${r3.finished} inserts=${inserts}`);

  // 4-d 상한
  mkStub({
    stats: [statRow('S', 'A', 1, 1, 1), statRow('S', 'B', 1, 1, 1), statRow('S', 'C', 1, 1, 1)],
    finished: [], meta: [metaRow('S', 'A', '1', false), metaRow('S', 'B', '2', false), metaRow('S', 'C', '3', false)],
  });
  const r4 = await svc.autoFinishEligibleTabs({ dryRun: true, cap: 2 });
  t('★ 한 회차 상한 — 넘치면 잘라 내고 그 사실을 말한다(다음 주기에 이어서)',
    r4.candidates.length === 2 && r4.capped === true);

  /* ═══ 5) fail-closed 3종 — 모르면 한 건도 건드리지 않는다 ═══════════════ */
  console.log('\n5) fail-closed (모르면 마감하지 않는다)');
  const noWrite = () => !SQL.some(x => /INSERT INTO|UPDATE /i.test(x.q));
  mkStub({ failStats: true, meta: [metaRow('S', 'A', '1', false)] });
  const f1 = await svc.autoFinishEligibleTabs({ dryRun: false });
  t('★ 통계 조회 실패 → 중단 + 쓰기 0건', f1.ok === false && f1.code === 'stats_unavailable' && noWrite());

  mkStub({ stats: [statRow('S', 'A', 1, 1, 1)], failFinished: true, meta: [metaRow('S', 'A', '1', false)] });
  const f2 = await svc.autoFinishEligibleTabs({ dryRun: false });
  t('★ 마감 목록 조회 실패 → 중단 + 쓰기 0건', f2.ok === false && f2.code === 'finished_unavailable' && noWrite());

  mkStub({ stats: [statRow('S', 'A', 1, 1, 1)], finished: [], failMeta: true });
  const f3 = await svc.autoFinishEligibleTabs({ dryRun: false });
  t('★★ 복귀 이력(탭 메타) 조회 실패 → 중단 + 쓰기 0건 — 모르는 채로 돌면 되돌린 작업을 다시 마감한다',
    f3.ok === false && f3.code === 'meta_unavailable' && noWrite());

  // 5-d 건별 독립 — 한 건이 실패해도 나머지는 계속
  mkStub({
    stats: [statRow('S', 'A', 1, 1, 1), statRow('S', 'B', 1, 1, 1)],
    finished: [], meta: [metaRow('S', 'A', '1', false), metaRow('S', 'B', '2', false)],
  });
  const prevQ2 = pool.query;
  pool.query = async (q, p) => {
    const s = String(q);
    if (/INSERT INTO trackb_tab_finished/.test(s)) {
      if (Array.isArray(p) && p[1] === 'A') throw new Error('boom');
      return { rows: [{ id: 1, finishedAt: 'z' }], rowCount: 1 };
    }
    return prevQ2(q, p);
  };
  const f4 = await svc.autoFinishEligibleTabs({ dryRun: false });
  t('★ 한 건이 실패해도 나머지는 마감된다(건별 독립) + 실패를 보고한다',
    f4.ok === true && f4.finished === 1 && f4.failed.length === 1, JSON.stringify(f4.failed));

  pool.query = origQuery;

  /* ═══ 6) 라우트 ═══════════════════════════════════════════════════════ */
  console.log('\n6) 라우트');
  const L = {};
  for (const l of require('../src/routes/trackB.routes').stack || []) {
    if (l.route) L[`${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`] = l.route.stack.map(h => h.name);
  }
  const AFR = L['POST /workdesk/auto-finish'];
  t('수동 실행·미리보기 라우트가 있다', Array.isArray(AFR), Object.keys(L).filter(k => /finish/.test(k)).join(','));
  t('★ authMiddleware 가 맨 앞(빠지면 마스터 포함 전원 403 — 레포 실측 사고)', AFR[0] === 'authMiddleware', AFR.join(','));
  t('★ adminOrMaster — 전사 상태라 스코프가 없다(그래서 좁힌다)', AFR.includes('adminOrMasterMiddleware'), AFR.join(','));
  const AFROUTE = ROUTES.slice(ROUTES.indexOf("router.post('/workdesk/auto-finish'"), ROUTES.indexOf("router.post('/workdesk/auto-finish'") + 900);
  t('★ 기본이 미리보기 — confirm:true 가 없으면 쓰기 0건', /dryRun:\s*b\.confirm\s*!==\s*true/.test(AFROUTE));
  t('★★ auto 를 body 에서 받지 않는다(검수 게이트 우회 차단)',
    !/\bauto\b/.test(AFROUTE.replace(/auto-finish|autoFinishEligibleTabs|자동 마감/g, '')), AFROUTE);
  // 사람 경로 라우트는 무변경 — auto 키를 넘기지 않는다
  const FINROUTE = ROUTES.slice(ROUTES.indexOf("router.post('/workdesk/tab-finish'"), ROUTES.indexOf("router.post('/workdesk/tab-finish'") + 900);
  t('★★ 사람 마감 라우트는 auto 를 body 에서도 서비스로도 넘기지 않는다',
    !/\bauto\b/.test(FINROUTE), FINROUTE);

  /* ═══ 7) 크론 ═══════════════════════════════════════════════════════ */
  console.log('\n7) 크론 배선');
  const CB_START = CRON.indexOf("process.env.TAB_AUTO_FINISH !== '0'");
  t('기본 ON · 킬스위치 TAB_AUTO_FINISH=0', CB_START > 0);
  const CB = CRON.slice(CB_START, CB_START + 1600);
  t('자동 마감 서비스를 부른다', /autoFinishEligibleTabs\(/.test(CB));
  t('★ dryRun:false 로 실제 실행', /dryRun:\s*false/.test(CB));
  t('★ 멀티 인스턴스 직렬화(withJobLock) — 기존 락 이름과 비충돌',
    /withJobLock\('tab_auto_finish'/.test(CB) && !/withJobLock\('tab_auto_finish'/.test(CRON.replace(CB, '')));
  t('★ 자동 마감이 크론을 죽이지 않는다(try/catch)', /catch \(err\)[\s\S]{0,200}logger\.error/.test(CB));
  t('★ 중복 실행 방지(afRunning)', /afRunning/.test(CB));
  t('KST 기준 스케줄', /timezone: 'Asia\/Seoul'/.test(CB));

  /* ═══ 8) 화면 — 조용히 옮기지 않는다 ══════════════════════════════════ */
  console.log('\n8) 화면 배선');
  t('★ 마감 보관함이 "왜 여기 있는지"를 말한다',
    /자동으로 이곳으로 옮겨집니다/.test(WD));
  t('★ 되돌리는 길과 "되돌리면 다시 안 넘어온다"를 함께 말한다',
    /진행중으로 복귀\]<\/b>[\s\S]{0,120}되돌린 작업은 다시 자동으로 넘어오지 않습니다/.test(WD));
  t('★ 보관함이 비어 있을 때도 같은 안내가 보인다(표가 없으면 위 안내가 안 그려진다)',
    /\$\{autoNote\}<div class="wbl-empty">/.test(WD));
  t('마감 후보 배지가 "곧 자동 이동"임을 말한다',
    /마감 보관함으로 자동 이동합니다[\s\S]{0,40}✓ 마감 후보/.test(WD));
  t('★ 화면은 여전히 서버 판정을 그대로 소비한다(마감 여부를 화면에서 다시 세지 않는다)',
    /function isFinished\(t\)\{ return !!\(t && t\.finished\); \}/.test(WD));

  console.log(`\n✅ ${pass} 케이스 통과\n`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
