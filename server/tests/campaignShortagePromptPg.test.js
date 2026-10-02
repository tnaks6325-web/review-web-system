/**
 * campaignShortagePromptPg.test.js — 어제 모집 부족 인원 팝업 (진짜 PostgreSQL 실행 · 2026-10-02)
 * 실행: PGTEST_URL=postgres://… node tests/campaignShortagePromptPg.test.js  (없으면 건너뜀)
 *
 * 확인하는 것(사용자 요청 "모든 화면에 정상 반영되는지 꼼꼼히"):
 *  ① 대상 판정 — 종료일 뒤에 붙이기 공고만 · 받는 사람(담당자 닉네임/작업오더 보낸 AE)만 · 어제 처음 열린 공고 제외
 *  ② 부족 인원 = 어제 하루(계획 − 확정), 남은 총인원으로 자름
 *  ③ [오늘 더하기] 반영 뒤 → 같은 정원 깔때기(fetchCampaignCounts → computeCampaignState)가 새 오늘 정원을 본다
 *     = 모집공고 카드 · 리뷰어 캠페인 목록 · 참여 판정이 같은 값을 쓴다. 리뷰어 공개 목록 라우트도 실제 실행해 대조.
 *  ④ [기간 늘려 뒤에 붙이기] 반영 뒤 → 정원 무변경 + 그 공고는 다시 묻지 않음
 *  ⑤ 같은 날 두 번 묻지 않음(처리 기록) · 작업 로그에 남음
 */
const URL_ = process.env.PGTEST_URL;
if (!URL_) { console.log('campaignShortagePromptPg: PGTEST_URL 없음 — 건너뜀'); process.exit(0); }
process.env.DATABASE_URL = URL_;
const assert = require('assert');
const pool = require('../src/db/pool');
const svc = require('../src/services/campaignShortage.service');
const st = require('../src/services/campaignState.service');

let passed = 0;
function ok(name, cond, extra) { if (!cond) { console.error('  ✗ ' + name, extra !== undefined ? JSON.stringify(extra) : ''); process.exitCode = 1; throw new Error(name); } passed++; console.log('  ✓ ' + name); }

const P = 'shtest_';
const YNOON = `((date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') - interval '1 day' + interval '12 hour') AT TIME ZONE 'Asia/Seoul')`;
const D2NOON = `((date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') - interval '2 day' + interval '12 hour') AT TIME ZONE 'Asia/Seoul')`;

async function camp(id, o) {
  await pool.query(
    `INSERT INTO recruit_campaigns (id, title, status, participation_mode, carry_mode, carry_strategy, manager,
       daily_limit, recruit_total, start_date, thumbnail_url, created_at)
     VALUES ($1,$2,'active',TRUE,$3,$4,$5,$6,$7,(now() AT TIME ZONE 'Asia/Seoul')::date - 3,$8, now() - interval '5 day')`,
    [id, o.title || id, o.mode || 'auto', o.strategy || 'extend', o.manager ?? '만두', o.dl ?? 3, o.rt ?? 10, o.thumb || '']);
}
async function app(cid, phone, when, status = 'submitted') {
  await pool.query(
    `INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, applied_at, submitted_at)
     VALUES ($1,'테스트',$2,$3,${when},${status === 'submitted' ? when : 'NULL'})`, [cid, phone, status]);
}

(async () => {
  await pool.query(`DELETE FROM campaign_options WHERE campaign_id LIKE '${P}%'`);
  await pool.query(`DELETE FROM campaign_plan_events WHERE campaign_id LIKE '${P}%'`);
  await pool.query(`DELETE FROM campaign_daily_plans WHERE campaign_id LIKE '${P}%'`);
  await pool.query(`DELETE FROM campaign_applications WHERE campaign_id LIKE '${P}%'`);
  await pool.query(`DELETE FROM work_orders WHERE id LIKE '${P}%'`);
  await pool.query(`DELETE FROM order_submissions WHERE sheet_id LIKE '${P}%'`);
  await pool.query(`DELETE FROM recruit_campaigns WHERE id LIKE '${P}%'`);

  // A: 담당 만두 · 종료일 뒤에 붙이기 · 어제 3명 계획 중 2명 → 1명 부족
  await camp(P + 'A', { title: '테스트A', thumb: 'https://example.com/a.jpg' });
  await app(P + 'A', '00000001', D2NOON); await app(P + 'A', '00000002', YNOON); await app(P + 'A', '00000003', YNOON);
  // B: 다음날에 더하기 — 시스템이 이미 자동으로 얹으므로 묻지 않는다
  await camp(P + 'B', { strategy: 'next' }); await app(P + 'B', '00000011', D2NOON);
  // C: 담당 망고 — 만두(박세희)에게는 안 뜬다
  await camp(P + 'C', { manager: '망고' }); await app(P + 'C', '00000021', D2NOON);
  // D: 오늘 처음 게시(게시 시각 = 지금) — 어제는 열려 있지 않았으니 묻지 않는다
  await camp(P + 'D', {});
  await pool.query(`UPDATE recruit_campaigns SET published_at = now() WHERE id=$1`, [P + 'D']);
  // E: 담당 만두 · 어제 0명 → 3명 부족(나중에 "기간 늘리기")
  await camp(P + 'E', { title: '테스트E' }); await app(P + 'E', '00000041', D2NOON);
  // F: 담당 없음 · 작업오더를 김AE 가 보냄 → 김AE 에게만
  await camp(P + 'F', { manager: '' }); await app(P + 'F', '00000051', D2NOON);
  await pool.query(`INSERT INTO work_orders (id, title, created_by, linked_campaign_id) VALUES ($1,'발주F','김AE',$2)`, [P + 'WF', P + 'F']);
  // G: 총 10명 중 9명 확정 → 남은 1명뿐(부족 3명이어도 1명까지만)
  await camp(P + 'G', { title: '테스트G' });
  for (let k = 0; k < 9; k++) await app(P + 'G', '0000007' + k, D2NOON);

  const mine = (r) => r.items.filter(i => String(i.campaignId).startsWith(P));
  let r = await svc.listShortages({ name: '박세희' });
  let ids = mine(r).map(i => i.campaignId).sort();
  ok('① 박세희(만두): A·E·G 만 — B(자동 이월)·C(망고)·D(어제 미게시)·F(AE 담당) 제외', JSON.stringify(ids) === JSON.stringify([P + 'A', P + 'E', P + 'G']), ids);
  const A = mine(r).find(i => i.campaignId === P + 'A');
  ok('② A 부족 = 어제 계획 3 − 확정 2 = 1 · 오늘 정원 3 · 더할 수 있음 1', A.shortage === 1 && A.yesterdayQuota === 3 && A.yesterdayConfirmed === 2 && A.todayQuota === 3 && A.addable === 1 && A.canAddToday, A);
  ok('② A 썸네일·제목 전달', A.thumbnailUrl === 'https://example.com/a.jpg' && A.title === '테스트A');
  const G = mine(r).find(i => i.campaignId === P + 'G');
  ok('② G 부족은 남은 총인원(1명)으로 잘린다', G.shortage === 1 && G.addable <= 1, G);
  r = await svc.listShortages({ name: '김AE' });
  ok('① 작업오더를 보낸 AE(김AE)에게는 F 가 뜬다', mine(r).map(i => i.campaignId).join() === P + 'F', mine(r));

  // ③ 오늘 더하기 — 반영 전 오늘 정원
  const countsBefore = (await st.fetchCampaignCounts(pool, [P + 'A'])).get(P + 'A');
  const cA = (await pool.query('SELECT * FROM recruit_campaigns WHERE id=$1', [P + 'A'])).rows[0];
  ok('③ 반영 전 오늘 정원 3', st.computeCampaignState(cA, countsBefore, new Date()).dailyQuota === 3);
  const res = await svc.applyDecisions({ name: '박세희' }, [{ campaignId: P + 'A', choice: 'today' }, { campaignId: P + 'E', choice: 'extend' }]);
  const ra = res.results.find(x => x.campaignId === P + 'A'), re = res.results.find(x => x.campaignId === P + 'E');
  ok('③ 반영 결과: A 오늘 3 → 4 · E 기간 늘림', ra.ok && ra.todayFrom === 3 && ra.todayTo === 4 && re.ok && re.choice === 'extend', res);
  const plan = (await pool.query(`SELECT planned_count FROM campaign_daily_plans WHERE campaign_id=$1 AND plan_date=(now() AT TIME ZONE 'Asia/Seoul')::date`, [P + 'A'])).rows[0];
  ok('③ [📅 인원]과 같은 날짜별 계획으로 저장됨(오늘 4명)', plan && Number(plan.planned_count) === 4, plan);
  st.__resetPlanCacheForTest && st.__resetPlanCacheForTest();
  const countsAfter = (await st.fetchCampaignCounts(pool, [P + 'A'])).get(P + 'A');
  const after = st.computeCampaignState(cA, countsAfter, new Date());
  ok('③ 정원 깔때기(카드·참여 판정 공용)가 오늘 4명으로 본다', after.dailyQuota === 4, after);

  // 리뷰어 공개 목록 라우트를 실제로 실행해 같은 숫자를 보는지
  const router = require('../src/routes/campaign.routes');
  const layer = router.stack.find(l => l.route && l.route.path === '/list' && l.route.methods.get);
  const listBody = await new Promise((resolve, reject) => {
    const req = { query: {}, headers: {}, params: {}, get() { return ''; } };
    const resp = { statusCode: 200, status(c) { this.statusCode = c; return this; }, set() { return this; }, setHeader() {}, json(b) { resolve(b); } };
    const stack = layer.route.stack; let k = 0;
    const next = (e) => { if (e) return reject(e); const h = stack[k++]; if (!h) return reject(new Error('no handler')); try { const p = h.handle(req, resp, next); if (p && p.catch) p.catch(reject); } catch (er) { reject(er); } };
    next();
  });
  const pubA = (listBody.data || []).find(c => c.id === P + 'A');
  const pubQuota = pubA && (pubA.dailyQuota ?? (pubA.state && pubA.state.dailyQuota));
  ok('③ 리뷰어 캠페인 목록에도 오늘 정원 4명', Number(pubQuota) === 4, pubA && { dailyQuota: pubA.dailyQuota, state: pubA.state });

  // ④ 기간 늘리기 — 정원 무변경 + 다시 묻지 않음
  const cE = (await pool.query('SELECT * FROM recruit_campaigns WHERE id=$1', [P + 'E'])).rows[0];
  const stE = st.computeCampaignState(cE, (await st.fetchCampaignCounts(pool, [P + 'E'])).get(P + 'E'), new Date());
  ok('④ E 오늘 정원은 그대로 3(종료일 뒤에 붙이기 그대로)', stE.dailyQuota === 3 && !!cE.shortage_prompt_off_at && cE.shortage_prompt_off_by === '박세희', { q: stE.dailyQuota, off: cE.shortage_prompt_off_at });

  // ⑤ 다시 묻지 않음
  r = await svc.listShortages({ name: '박세희' });
  ok('⑤ 반영 뒤 박세희 목록 = G 만 남음(A 오늘 처리 · E 앞으로 안 물음)', mine(r).map(i => i.campaignId).join() === P + 'G', mine(r));
  r = await svc.listShortages({ name: '박은비' });
  ok('⑤ 다른 담당자(망고)는 C 만', mine(r).map(i => i.campaignId).join() === P + 'C', mine(r));
  const ev = (await pool.query(`SELECT action, detail FROM campaign_plan_events WHERE campaign_id=$1 AND action='shortage_decision'`, [P + 'A'])).rows;
  ok('⑤ 처리 기록(누가·무엇) 남음', ev.length === 1 && ev[0].detail.choice === 'today' && Number(ev[0].detail.amount) === 1);
  const again = await svc.applyDecisions({ name: '박세희' }, [{ campaignId: P + 'A', choice: 'today' }]);
  ok('⑤ 같은 공고를 다시 반영하면 거절(두 번 더하지 않음)', again.results[0].ok === false);
  const plan2 = (await pool.query(`SELECT planned_count FROM campaign_daily_plans WHERE campaign_id=$1 AND plan_date=(now() AT TIME ZONE 'Asia/Seoul')::date`, [P + 'A'])).rows[0];
  ok('⑤ 오늘 계획은 여전히 4명', Number(plan2.planned_count) === 4);
  const notMine = await svc.applyDecisions({ name: '박세희' }, [{ campaignId: P + 'C', choice: 'today' }]);
  ok('① 받는 사람이 아닌 공고는 반영 거절', notMine.results[0].ok === false);

  // ⑥ 작업보드 작업표 — 무시트 작업표가 연결된 공고는 같은 저장이 표의 빈 줄 날짜까지 옮긴다
  const SH = P + 'sheet', TB = P + 'tab';
  await pool.query(`DELETE FROM campaign_participants WHERE sheet_id=$1`, [SH]);
  await pool.query(`DELETE FROM tab_configs WHERE sheet_id=$1`, [SH]);
  await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, sheetless) VALUES ($1,$2,TRUE)`, [SH, TB]);
  await camp(P + 'H', { title: '테스트H', dl: 3, rt: 12 });
  await pool.query(`UPDATE recruit_campaigns SET linked_sheet_id=$2, linked_tab_name=$3 WHERE id=$1`, [P + 'H', SH, TB]);
  await app(P + 'H', '00000081', D2NOON); await app(P + 'H', '00000082', YNOON);   // 어제 3명 중 1명 → 2명 부족
  const { sheetDateStr } = require('../src/utils/worktablePlan');
  const today = st.kstTodayStr();
  const lab = (iso) => { const [y, m, d] = iso.split('-').map(Number); return sheetDateStr({ y, m, d }); };
  // 12줄: 그제 1(채움) · 어제 3(1 채움 + 2 빈) · 오늘 3(빈) · 이후 5(빈)
  const plan0 = [
    [st.addIsoDays(today, -2), true], [st.addIsoDays(today, -1), true], [st.addIsoDays(today, -1), false], [st.addIsoDays(today, -1), false],
    [today, false], [today, false], [today, false],
    [st.addIsoDays(today, 1), false], [st.addIsoDays(today, 1), false], [st.addIsoDays(today, 1), false], [st.addIsoDays(today, 2), false], [st.addIsoDays(today, 2), false],
  ];
  for (let k = 0; k < plan0.length; k++) {
    const [d, filled] = plan0[k];
    await pool.query(
      `INSERT INTO campaign_participants (sheet_id, tab_name, seq, source, active, reviewer_name, row_json, start_date)
       VALUES ($1,$2,$3,'worktable',TRUE,$4,$5,$6)`,
      [SH, TB, k + 2, filled ? '참여자' + k : null, JSON.stringify({ 번호: String(k + 1), 구매일자: lab(d), 이름: filled ? '참여자' + k : '' }), lab(d)]);
  }
  const todayRows = async () => Number((await pool.query(
    `SELECT COUNT(*) n FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active AND row_json->>'구매일자'=$3`,
    [SH, TB, lab(today)])).rows[0].n);
  ok('⑥ 반영 전 작업표 오늘 줄 3', (await todayRows()) === 3);
  r = await svc.listShortages({ name: '박세희' });
  const H = mine(r).find(i => i.campaignId === P + 'H');
  ok('⑥ H 어제 부족 2명 · 오늘 3 → 5 가능', H && H.shortage === 2 && H.todayQuota === 3 && H.addable === 2, H);
  const rh = await svc.applyDecisions({ name: '박세희' }, [{ campaignId: P + 'H', choice: 'today' }]);
  ok('⑥ 반영 성공 + 작업표 맞추기 성공 보고', rh.results[0].ok && rh.results[0].todayTo === 5 && rh.results[0].worktable && rh.results[0].worktable.ok === true, rh.results[0]);
  ok('⑥ 작업보드 작업표의 오늘 줄이 5줄로 늘었다(빈 줄을 오늘로 옮김)', (await todayRows()) === 5, await todayRows());
  const totalRows = Number((await pool.query(`SELECT COUNT(*) n FROM campaign_participants WHERE sheet_id=$1 AND deleted_at IS NULL AND active`, [SH])).rows[0].n);
  ok('⑥ 작업표 전체 줄 수는 총인원 그대로(12)', totalRows === 12, totalRows);
  const filledKept = Number((await pool.query(`SELECT COUNT(*) n FROM campaign_participants WHERE sheet_id=$1 AND reviewer_name IS NOT NULL AND deleted_at IS NULL`, [SH])).rows[0].n);
  ok('⑥ 이미 채워진 줄(참여자)은 건드리지 않음', filledKept === 2);

  // ⑦ 신청 기록 없이 들어온 구매(외부모집 수동제출 등)도 확정으로 센다 — 채워진 날을 부족으로 오인하지 않는다
  const SI = P + 'sheetI', TI = P + 'tabI';
  await pool.query(`DELETE FROM order_submissions WHERE sheet_id=$1`, [SI]);
  await camp(P + 'I', { title: '테스트I' });
  await pool.query(`UPDATE recruit_campaigns SET linked_sheet_id=$2, linked_tab_name=$3 WHERE id=$1`, [P + 'I', SI, TI]);
  await app(P + 'I', '00000091', D2NOON);
  for (let k = 0; k < 3; k++) {
    await pool.query(`INSERT INTO order_submissions (sheet_id, tab_name, phone, submitted_at) VALUES ($1,$2,$3,${YNOON})`, [SI, TI, '0101234567' + k]);
  }
  r = await svc.listShortages({ name: '박세희' });
  ok('⑦ 어제 외부 주문 3건(신청 기록 없음)으로 다 채운 공고는 묻지 않음', !mine(r).some(i => i.campaignId === P + 'I'), mine(r).find(i => i.campaignId === P + 'I'));

  // ⑧ 담당자와 AE가 동시에 반영해도 한 번만 더해진다
  await camp(P + 'J', { title: '테스트J', manager: '만두' });
  await app(P + 'J', '00000101', D2NOON);
  await pool.query(`INSERT INTO work_orders (id, title, created_by, linked_campaign_id) VALUES ($1,'발주J','김AE',$2)`, [P + 'WJ', P + 'J']);
  const [r1, r2] = await Promise.all([
    svc.applyDecisions({ name: '박세희' }, [{ campaignId: P + 'J', choice: 'today' }]),
    svc.applyDecisions({ name: '김AE' }, [{ campaignId: P + 'J', choice: 'extend' }]),
  ]);
  const okCnt = [r1, r2].filter(x => x.results[0].ok).length;
  ok('⑧ 동시 반영 중 하나만 성공', okCnt === 1, [r1.results[0], r2.results[0]]);
  const evJ = (await pool.query(`SELECT detail FROM campaign_plan_events WHERE campaign_id=$1 AND action='shortage_decision'`, [P + 'J'])).rows;
  ok('⑧ 결정 기록도 하나뿐', evJ.length === 1, evJ);
  const planJ = (await pool.query(`SELECT planned_count FROM campaign_daily_plans WHERE campaign_id=$1`, [P + 'J'])).rows;
  const offJ = (await pool.query(`SELECT shortage_prompt_off_at FROM recruit_campaigns WHERE id=$1`, [P + 'J'])).rows[0].shortage_prompt_off_at;
  ok('⑧ 이긴 쪽의 변경만 남음(오늘 더하기와 기간 늘리기가 둘 다 적용되지 않음)',
    (evJ[0].detail.choice === 'today' && planJ.length === 1 && !offJ) || (evJ[0].detail.choice === 'extend' && planJ.length === 0 && !!offJ), { evJ, planJ, offJ });

  // ⑨ 그 사이 다른 사람이 [📅 인원]에서 오늘 인원을 바꿨으면 거절(낡은 값으로 덮지 않음)
  await camp(P + 'K', { title: '테스트K' }); await app(P + 'K', '00000111', D2NOON);
  const listedK = await svc.listShortages({ name: '박세희' });
  ok('⑨ K 부족 3명 · 오늘 3', mine(listedK).some(i => i.campaignId === P + 'K' && i.todayQuota === 3));
  // 목록을 받은 뒤 · 저장이 잠금을 잡기 직전에 다른 사람이 오늘을 8명으로 바꾼 상황을 만든다
  const realSave = require('../src/services/campaignPlan.service').savePlans;
  const rk = await svc.applyDecisions({ name: '박세희' }, [{ campaignId: P + 'K', choice: 'today' }], {
    savePlans: async (id, body, actor, o) => {
      await pool.query(`INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count) VALUES ($1,(now() AT TIME ZONE 'Asia/Seoul')::date,8)`, [id]);
      st.__resetPlanCacheForTest && st.__resetPlanCacheForTest();
      return realSave(id, body, actor, o);
    },
  });
  ok('⑨ 잠근 뒤 다시 계산해 "그 사이 바뀜"으로 거절', rk.results[0].ok === false && rk.results[0].code === 'stale_today', rk.results[0]);
  const kPlan = (await pool.query(`SELECT planned_count FROM campaign_daily_plans WHERE campaign_id=$1`, [P + 'K'])).rows[0];
  ok('⑨ 사람이 정한 오늘 8명은 그대로(낡은 3+3 으로 덮지 않음)', Number(kPlan.planned_count) === 8, kPlan);
  const kEv = (await pool.query(`SELECT 1 FROM campaign_plan_events WHERE campaign_id=$1 AND action='shortage_decision'`, [P + 'K'])).rows;
  ok('⑨ 결정 기록도 남지 않음(한 트랜잭션) → 다시 물을 수 있다', kEv.length === 0);

  // ⑨-2 어제 아무도 참여하지 않은 공고(신청 기록 0건)도 묻는다 — 가장 큰 부족
  await camp(P + 'N', { title: '테스트N' });
  const N = mine(await svc.listShortages({ name: '박세희' })).find(i => i.campaignId === P + 'N');
  ok('⑨-2 어제 0명 → 3명 부족으로 묻는다', N && N.shortage === 3 && N.yesterdayConfirmed === 0, N);
  // ⑨-3 게시 토글을 실제로 실행하면 게시 시각이 남는다
  await camp(P + 'O', { title: '테스트O' });
  await pool.query(`UPDATE recruit_campaigns SET status='draft', published_at=NULL WHERE id=$1`, [P + 'O']);
  await pool.query(`UPDATE recruit_campaigns SET status = $2,
         published_at = CASE WHEN $2 = 'active' AND status IS DISTINCT FROM 'active' THEN NOW() ELSE published_at END,
         updated_at = NOW() WHERE id = $1`, [P + 'O', 'active']);
  const pubO = (await pool.query(`SELECT published_at FROM recruit_campaigns WHERE id=$1`, [P + 'O'])).rows[0].published_at;
  ok('⑨-3 게시 전 → 게시 전환 시 게시 시각 기록 · 오늘 게시라 묻지 않음', !!pubO && !mine(await svc.listShortages({ name: '박세희' })).some(i => i.campaignId === P + 'O'));

  // ⑩ 블로그 공고는 묻지 않음
  await camp(P + 'L', { title: '테스트L' }); await app(P + 'L', '00000121', D2NOON);
  await pool.query(`UPDATE recruit_campaigns SET work_kind='blog' WHERE id=$1`, [P + 'L']);
  ok('⑩ 블로그 공고 제외', !mine(await svc.listShortages({ name: '박세희' })).some(i => i.campaignId === P + 'L'));

  // ⑪ 앞날에 정해 둔 인원이 남은 총원을 다 차지하면 [오늘 더하기]를 막는다(누르면 거절되는 버튼 금지)
  await camp(P + 'M', { title: '테스트M', rt: 10 });
  for (let k = 0; k < 3; k++) await app(P + 'M', '0000013' + k, D2NOON);
  await pool.query(`INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count) VALUES ($1,(now() AT TIME ZONE 'Asia/Seoul')::date + 1,4)`, [P + 'M']);
  st.__resetPlanCacheForTest && st.__resetPlanCacheForTest();
  const M = mine(await svc.listShortages({ name: '박세희' })).find(i => i.campaignId === P + 'M');
  ok('⑪ 총 10 · 확정 3 · 오늘 3 · 내일 4 → 오늘에 더할 자리 0 → 버튼 막힘', M && M.addable === 0 && M.canAddToday === false, M);

  // ⑫ 상품별 하루 한도가 걸린 공고는 오늘 더하기 막음(늘려도 고를 수 없는 자리 — 코덱스 리뷰)
  await camp(P + 'Q', { title: '테스트Q' }); await app(P + 'Q', '00000141', D2NOON);
  await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, daily_limit) VALUES ($1,'a',1),($1,'b',1)`, [P + 'Q']);
  const Q = mine(await svc.listShortages({ name: '박세희' })).find(i => i.campaignId === P + 'Q');
  ok('⑫ 상품별 하루 한도 공고 → 오늘 더하기 막힘 · 사유 문장', Q && Q.canAddToday === false && /상품별 하루 한도/.test(Q.todayBlockedReason), Q);
  const rQ = await svc.applyDecisions({ name: '박세희' }, [{ campaignId: P + 'Q', choice: 'today' }]);
  ok('⑫-2 강제로 보내도 서버가 거절 · 기록 0', rQ.results[0].ok === false && (await pool.query(`SELECT 1 FROM campaign_plan_events WHERE campaign_id=$1`, [P + 'Q'])).rowCount === 0, rQ);

  // ⑬ 목록 뒤에 보관되면 기간 늘리기도 거절(잠근 행 재확인)
  await camp(P + 'R', { title: '테스트R' }); await app(P + 'R', '00000151', D2NOON);
  const hasR = mine(await svc.listShortages({ name: '박세희' })).some(i => i.campaignId === P + 'R');
  await pool.query(`UPDATE recruit_campaigns SET archived_at = NOW() WHERE id=$1`, [P + 'R']);
  const rR = await svc.applyDecisions({ name: '박세희' }, [{ campaignId: P + 'R', choice: 'extend' }]);
  ok('⑬ 보관된 공고는 반영 거절 · 기록 0', hasR && rR.results[0].ok === false && (await pool.query(`SELECT 1 FROM campaign_plan_events WHERE campaign_id=$1`, [P + 'R'])).rowCount === 0, rR);

  // ⑭ 트리거(175)를 진짜 UPDATE 로 돌려 본다 — 상관없는 칸은 안 남기고, 인원 규칙이 바뀌면 남긴다 → 그 공고는 묻지 않음
  await camp(P + 'S', { title: '테스트S' }); await app(P + 'S', '00000161', D2NOON);
  ok('⑭-0 처음엔 물음', mine(await svc.listShortages({ name: '박세희' })).some(i => i.campaignId === P + 'S'));
  await pool.query(`UPDATE recruit_campaigns SET title = '테스트S2' WHERE id=$1`, [P + 'S']);
  const s1 = (await pool.query(`SELECT quota_rules_changed_at FROM recruit_campaigns WHERE id=$1`, [P + 'S'])).rows[0].quota_rules_changed_at;
  ok('⑭-1 제목만 바꾸면 기록 없음 · 계속 물음', s1 === null && mine(await svc.listShortages({ name: '박세희' })).some(i => i.campaignId === P + 'S'));
  await pool.query(`UPDATE recruit_campaigns SET daily_limit = 10 WHERE id=$1`, [P + 'S']);
  const s2 = (await pool.query(`SELECT quota_rules_changed_at FROM recruit_campaigns WHERE id=$1`, [P + 'S'])).rows[0].quota_rules_changed_at;
  ok('⑭-2 일건수를 바꾸면 기록 · 어제 정원을 알 수 없어 묻지 않음', !!s2 && !mine(await svc.listShortages({ name: '박세희' })).some(i => i.campaignId === P + 'S'));

  // ⑭-3 이월 방식이 바뀌어도(다음 날에 더하기 → 종료일 뒤에 붙이기) 어제 정원을 알 수 없다 → 묻지 않음(176)
  await camp(P + 'V', { title: '테스트V', strategy: 'next' }); await app(P + 'V', '00000171', D2NOON);
  await pool.query(`UPDATE recruit_campaigns SET carry_strategy = 'extend' WHERE id=$1`, [P + 'V']);
  ok('⑭-3 이월 방식 변경도 기록 · 묻지 않음', !!(await pool.query(`SELECT quota_rules_changed_at FROM recruit_campaigns WHERE id=$1`, [P + 'V'])).rows[0].quota_rules_changed_at && !mine(await svc.listShortages({ name: '박세희' })).some(i => i.campaignId === P + 'V'));

  // ⑭-4 일건수 0 = 작업오더 일건수를 빌려 쓰는 공고 → 어제 값을 알 수 없어 묻지 않음
  await camp(P + 'W', { title: '테스트W', dl: 0 }); await app(P + 'W', '00000181', D2NOON);
  await pool.query(`UPDATE recruit_campaigns SET quota_rules_changed_at = NULL WHERE id=$1`, [P + 'W']);
  await pool.query(`INSERT INTO work_orders (id, status, recruit_count, daily_count, linked_campaign_id, created_by) VALUES ($1,'reviewing',10,3,$2,'김AE')`, [P + 'wo_W', P + 'W']).catch(() => {});
  const hasW = mine(await svc.listShortages({ name: '박세희' })).some(i => i.campaignId === P + 'W');
  ok('⑭-4 작업오더 일건수 기준 공고는 묻지 않음', hasW === false);

  // ⑮ 어제 신청 마감(18:00) 뒤에 처음 게시 → 어제는 아무도 신청할 수 없었다 → 묻지 않음 / 마감 전 게시는 물음
  for (const [k, hh, want] of [['T', '20:00', false], ['U', '09:00', true]]) {
    await camp(P + k, { title: '테스트' + k });
    await pool.query(`UPDATE recruit_campaigns SET window_start='08:00', window_end='18:00', close_buffer_min=0,
        quota_rules_changed_at = NULL,
        published_at = ((date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') - interval '1 day' + $2::time) AT TIME ZONE 'Asia/Seoul') WHERE id=$1`, [P + k, hh]);
    await pool.query(`UPDATE recruit_campaigns SET quota_rules_changed_at = NULL WHERE id=$1`, [P + k]);
    const has = mine(await svc.listShortages({ name: '박세희' })).some(i => i.campaignId === P + k);
    ok(`⑮ 어제 ${hh} 게시 → ${want ? '물음' : '묻지 않음'}`, has === want);
  }

  console.log(`\ncampaignShortagePromptPg: ${passed} passed`);
  await pool.end().catch(() => {});
  process.exit(process.exitCode || 0);
})().catch(async e => { console.error(e); try { await pool.end(); } catch (_) {} process.exit(1); });
