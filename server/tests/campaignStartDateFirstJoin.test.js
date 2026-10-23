/**
 * 결정 273 — 모집공고 실제 시작일 = 사람이 정한 날, 안 정했으면 첫 참여일 (사용자 확정 2026-10-23 「나 · 1.가 · 2.가」)
 *   A. 정적: 가산 마이그레이션 · 부팅 스키마 검사 · 생성/수정 판정 · 새벽 작업(끄는 스위치) · 화면 잠금 해제 · 본 값 전송
 *   B. 화면 한 줄(실행): 누가 정한 날인지
 *   C. PGTEST_URL 있으면 진짜 PG + 실제 라우트: 생성 판정 · 수정 판정(본 값·옛 화면) · 새벽 맞춤(앞으로만·사람 우선·옛 공고 무접촉)
 *   ★ C 는 표를 만들고 지운다 — 시험 서버가 쓰는 DB 말고 복사본에서 돌린다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

let passed = 0;
function ok(name, cond, extra) { assert(cond, name + (extra ? '  ← ' + extra : '')); passed++; console.log('  ✓ ' + name); }
const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');

/* ══════════════ A. 정적 ══════════════ */
console.log('\n[A] 정적 — 저장 칸 · 판정 · 새벽 작업 · 화면');
{
  const mig = read('../migrations/197_campaign_start_date_basis.sql');
  const body = mig.replace(/--[^\n]*/g, '');
  ok('197 = 칸 더하기만(값 변경·백필·삭제 없음)', /ADD COLUMN IF NOT EXISTS start_date_basis TEXT NULL/.test(body) && !/\bUPDATE\b|\bDROP\b|\bDELETE\b|DEFAULT/i.test(body));
  ok('부팅 스키마 검사에 들어 있다(없으면 공고 발행·수정이 통째 실패)', /\['recruit_campaigns', 'start_date_basis'\]/.test(read('../index.js')));
  const camp = read('../src/routes/campaign.routes.js');
  ok('생성: 비웠거나 오더 희망 시작일 그대로 = pending · 고른 날 = manual',
    /let _startDateBasis = start_date \? 'manual' : 'pending';[\s\S]{0,500}to_char\(start_date, 'YYYY-MM-DD'\) AS d FROM work_orders WHERE id = \$1`, \[_srcWoId\]\);\s+if \(_wsd\[0\] && _wsd\[0\]\.d === String\(start_date\)\.slice\(0, 10\)\) _startDateBasis = 'pending';/.test(camp)
    && /repurchase_days, start_date_basis\)/.test(camp) && /\$49,\$50,\$51\)/.test(camp) && /_startDateBasis,\s+\/\/ ★ 결정 273/.test(camp));
  ok('오더 날짜 조회는 잠금 tx 밖(실패해도 공고 저장을 죽이지 않는다)', /const \{ rows: _wsd \} = await pool\.query\(/.test(camp));
  ok('수정: 본 값과 같으면 = 안 고침(시작일 유지)', /String\(start_date \|\| ''\) === String\(req\.body\.start_date_seen \|\| ''\)\) \? undefined : start_date/.test(camp)
    && /\(_startDateEff === undefined \|\| _startDateEff === null\) \? null : String\(_startDateEff\)/.test(camp));
  ok('수정: 바꾸면 manual · 이 칸 이전 공고(NULL)를 지우기만 하면 그대로',
    /WHEN start_date IS DISTINCT FROM \$32::date THEN 'manual'/.test(camp) && /WHEN start_date IS NULL OR start_date_basis IS NULL THEN start_date_basis ELSE 'pending'/.test(camp));
  const cron = read('../src/jobs/cron.js');
  ok('새벽 4시 10분 · 끄는 스위치 · 작업 잠금', /CAMPAIGN_START_FIRST_JOIN_CRON !== '0'/.test(cron) && /'10 4 \* \* \*'/.test(cron) && /withJobLock\('campaign_start_first_join'/.test(cron));
  ok('작업표 날짜 맞추기(4시 20분)보다 먼저 등록', cron.indexOf('campaign_start_first_join') < cron.indexOf('campaign_worktable_relay'));
  const svc = read('../src/services/campaignStartDate.service.js');
  ok('센 주문 규칙은 단일 출처(campaignState.ORDER_COUNTED_SQL)', /require\('\.\/campaignState\.service'\)/.test(svc) && /\$\{ORDER_COUNTED_SQL\}/.test(svc) && !/cpx\.order_submission_id/.test(svc));
  ok('기록기는 { logger } 구조분해(통째로 받으면 맞춘 순간 오류로 새벽 작업이 멈춘다 — PG 실측)', /const \{ logger \} = require\('\.\.\/utils\/logger'\)/.test(svc));
  ok('pending 만 · 같은 문장에서 다시 확인 · 앞으로만', /WHERE rc\.start_date_basis = 'pending'/.test(svc) && /WHERE id = \$1 AND start_date_basis = 'pending'\s+AND \(start_date IS NULL OR start_date <= \$2::date\)/.test(svc));
  const fe = read('../../frontend/js/index-recruit.js');
  ok('연결 공고도 시작일 버튼을 잠그지 않는다(막다른 길 해소)', !/sBtn\.disabled = !!linked/.test(fe) && !/리뷰오더에서 고칩니다/.test(fe));
  ok('수정 저장은 창을 열 때 본 시작일을 함께 보낸다', /payload\.start_date_seen = window\._rfStartSeen/.test(fe) && /window\._rfStartSeen = \(c\.start_date \|\| ""\)\.slice\(0, 10\)/.test(fe));
  ok('새 창을 열면 지난 공고 값을 비운다', /window\._rfStartSeen = null; window\._rfStartBasis = ''; window\._rfPrefillStart = null;/.test(fe));
  ok('날짜를 고치면 한 줄을 다시 그린다', /_renderStartDateBasisNote\(\);\s+\/\/ 결정 273/.test(fe.slice(fe.indexOf('function onRecruitDatesChange'), fe.indexOf('function onRecruitDatesChange') + 900)));
  ok('비교 이름 = 희망 시작일', /key: 'start_date',[^\n]*label: '희망 시작일'/.test(read('../src/utils/sharedFields.js')));
}

/* ══════════════ B. 화면 한 줄(실행) ══════════════ */
console.log('\n[B] 시작일 옆 한 줄 — 누가 정한 날인가');
{
  const fe = read('../../frontend/js/index-recruit.js');
  const start = fe.indexOf('function _renderStartDateBasisNote');
  let depth = 0, i = fe.indexOf('{', start);
  for (; i < fe.length; i++) { if (fe[i] === '{') depth++; else if (fe[i] === '}' && --depth === 0) break; }
  const src = fe.slice(start, i + 1);
  const mk = () => {
    const nodes = {};
    const ctl = { kids: [], appendChild(n) { this.kids.push(n); n.parent = this; nodes[n.id] = n; } };
    const row = { querySelector: () => ctl };
    const input = { value: '' };
    const sb = { window: {}, _recruitEditId: null,
      document: { getElementById: id => id === 'rf_start_date_row' ? row : id === 'rf_start_date' ? input : (nodes[id] && nodes[id].parent ? nodes[id] : null),
        createElement: () => { const n = { remove() { n.parent.kids = n.parent.kids.filter(k => k !== n); n.parent = null; } }; return n; } } };
    vm.createContext(sb); vm.runInContext(src, sb);
    const text = () => (nodes.rf_start_date_basis_note && nodes.rf_start_date_basis_note.parent) ? nodes.rf_start_date_basis_note.textContent : '';
    return { sb, input, run: () => { vm.runInContext('_renderStartDateBasisNote()', sb); return text(); } };
  };
  let t = mk(); t.sb._recruitEditId = 'c1'; t.sb.window._rfStartSeen = '2026-11-01'; t.sb.window._rfStartBasis = 'pending'; t.input.value = '2026-11-01';
  ok('수정 · 안 정함 → 「첫 참여가 생긴 날로 자동으로 맞춥니다」', /첫 참여가 생긴 날로 자동으로 맞춥니다/.test(t.run()));
  t.input.value = '2026-11-03';
  ok('날짜를 고치면 → 「직접 정한 날로 저장합니다」', t.run() === '직접 정한 날로 저장합니다');
  t = mk(); t.sb._recruitEditId = 'c1'; t.sb.window._rfStartSeen = '2026-11-04'; t.sb.window._rfStartBasis = 'first_join'; t.input.value = '2026-11-04';
  ok('수정 · 첫 참여일로 맞춤 → 그 사실', /첫 참여가 생긴 날로 자동으로 맞춘 날/.test(t.run()));
  t = mk(); t.sb._recruitEditId = 'c1'; t.sb.window._rfStartSeen = '2026-11-04'; t.sb.window._rfStartBasis = ''; t.input.value = '2026-11-04';
  ok('수정 · 이 칸 이전 공고·사람이 정한 날 → 한 줄 없음', t.run() === '');
  t = mk(); t.sb.window._rfPrefillStart = '2026-11-01'; t.input.value = '2026-11-01';
  ok('새 공고 · 오더 희망 시작일 그대로 → 첫 참여일로 맞춤 안내', /그대로 두면 첫 참여가 생긴 날로/.test(t.run()));
  t.input.value = '2026-11-02';
  ok('새 공고 · 다른 날을 고르면 → 직접 정한 날', t.run() === '직접 정한 날로 저장합니다');
  t = mk(); t.input.value = '2026-11-02';
  ok('오더 없이 새로 만드는 공고 → 한 줄 없음(종전 화면)', t.run() === '');
}

async function pg() {
  console.log('\n[C] 진짜 PG — 생성·수정 판정 · 새벽 맞춤');
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const { correctStartDatesToFirstJoin } = require('../src/services/campaignStartDate.service');
  const srv = app.listen(0);
  const port = srv.address().port;
  const tok = jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET);
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const st = Date.now();
  const row = async id => (await pool.query(`SELECT to_char(start_date,'YYYY-MM-DD') AS sd, start_date_basis AS b, quota_rules_changed_at AS q FROM recruit_campaigns WHERE id=$1`, [id])).rows[0];
  const ids = [];
  try {
    // ── 생성 판정 ──
    const wo1 = 'wo_sd1_' + st, wo2 = 'wo_sd2_' + st;
    for (const w of [wo1, wo2]) await pool.query(`INSERT INTO work_orders (id, title, start_date) VALUES ($1, '시작일 시험', '2026-11-01')`, [w]);
    const mk = async (b) => { const r = await call('POST', '/api/campaign/admin/create', { title: '시작일 시험 ' + st, status: 'draft', ...b }); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); const id = (r.body.data || r.body.campaign || {}).id; ids.push(id); return id; };
    const cSame = await mk({ source_work_order_id: wo1, start_date: '2026-11-01' });
    ok('오더 희망 시작일 그대로 만든 공고 = pending', (await row(cSame)).b === 'pending');
    const cPick = await mk({ source_work_order_id: wo2, start_date: '2026-11-03' });
    ok('발행 창에서 다른 날을 고른 공고 = manual', (await row(cPick)).b === 'manual');
    const cBlank = await mk({});
    ok('오더 없이 시작일 비운 공고 = pending', (await row(cBlank)).b === 'pending');
    const cOwn = await mk({ start_date: '2026-11-02' });
    ok('오더 없이 날을 정한 공고 = manual', (await row(cOwn)).b === 'manual');

    // ── 수정 판정 ──
    const put = (id, b) => call('PUT', `/api/campaign/admin/${id}`, { title: '시작일 시험 ' + st, ...b });
    let r = await put(cSame, { start_date: '2026-11-01', start_date_seen: '2026-11-01' });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    ok('안 고치고 저장 → pending 유지', (await row(cSame)).b === 'pending' && (await row(cSame)).sd === '2026-11-01');
    await pool.query(`UPDATE recruit_campaigns SET start_date='2026-11-04', start_date_basis='first_join' WHERE id=$1`, [cSame]);
    await put(cSame, { start_date: '2026-11-01', start_date_seen: '2026-11-01' });
    let x = await row(cSame);
    ok('창을 열어 둔 사이 새벽 맞춤 → 옛 화면 저장이 되돌리지 않는다', x.sd === '2026-11-04' && x.b === 'first_join', JSON.stringify(x));
    await put(cSame, { start_date: '2026-11-05', start_date_seen: '2026-11-04' });
    x = await row(cSame);
    ok('사람이 고치면 → 그 날 · manual', x.sd === '2026-11-05' && x.b === 'manual', JSON.stringify(x));
    await put(cBlank, { start_date: '2026-11-06' });
    x = await row(cBlank);
    ok('본 값을 안 보내는 옛 화면도 고친 날 = manual(종전 저장 그대로)', x.sd === '2026-11-06' && x.b === 'manual', JSON.stringify(x));
    await pool.query(`UPDATE recruit_campaigns SET start_date_basis=NULL WHERE id=$1`, [cOwn]);
    await put(cOwn, { start_date: '' });
    x = await row(cOwn);
    ok('이 칸 이전 공고(NULL)를 지우기만 → 그대로 NULL(자동 맞춤 대상 아님)', x.sd === null && x.b === null, JSON.stringify(x));
    await put(cPick, { start_date: '', start_date_seen: '2026-11-03' });
    x = await row(cPick);
    ok('새 공고의 날을 지우면 → 다시 첫 참여일로 맞출 대상', x.sd === null && x.b === 'pending', JSON.stringify(x));

    // ── 새벽 맞춤 ──
    const C = n => 'camp_sd_' + n + '_' + st;
    const ins = (id, sd, basis, extra = '') => pool.query(`INSERT INTO recruit_campaigns (id, title, start_date, start_date_basis, participation_mode, status, linked_sheet_id, linked_tab_name${extra ? ', archived_at' : ''})
      VALUES ($1, '맞춤 시험', $2, $3, TRUE, 'active', 'sheet_sd_' || $1, 'tab_sd'${extra ? ', NOW()' : ''})`, [id, sd, basis]).then(() => ids.push(id));
    const app1 = (cid, status, at, decided) => pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, status, submitted_at, decided_at, expires_at)
      VALUES ($1, '가짜', $2, $3, $4, NOW() + interval '1 day')`, [cid, status, status === 'submitted' ? at : null, decided || null]);
    const ord = (cid, sheet, tab, at) => pool.query(`INSERT INTO order_submissions (sheet_id, tab_name, submitted_at) VALUES ($1, $2, $3)`, [sheet, tab, at]);
    await ins(C('a'), '2026-10-01', 'pending'); await app1(C('a'), 'submitted', '2026-10-05T10:00:00+09:00');
    await app1(C('a'), 'submitted', '2026-10-06T10:00:00+09:00');
    await ins(C('b'), null, 'pending'); await app1(C('b'), 'applied', null, '2026-10-07T09:00:00+09:00');
    await ins(C('c'), '2026-10-10', 'pending'); await ord(C('c'), 'campaign:' + C('c'), 'campaign:' + C('c'), '2026-10-08T12:00:00+09:00');
    await ins(C('d'), '2026-10-01', 'manual'); await app1(C('d'), 'submitted', '2026-10-05T10:00:00+09:00');
    await ins(C('e'), '2026-10-01', null); await app1(C('e'), 'submitted', '2026-10-05T10:00:00+09:00');
    await ins(C('f'), '2026-10-01', 'pending');
    await ins(C('g'), '2026-10-01', 'pending'); await app1(C('g'), 'submitted', '2026-10-06T10:00:00+09:00');
    await ord(C('g'), 'sheet_sd_' + C('g'), 'tab_sd', '2026-10-03T23:30:00+09:00');   // 지금 세는 탭 주문(시작일 뒤) — 이날로 옮겨야 빠지지 않는다
    await ord(C('g'), 'sheet_sd_' + C('g'), 'tab_sd', '2026-09-28T12:00:00+09:00');   // 시작일 전 탭 주문 — 지금도 안 센다(앵커)
    await ins(C('h'), '2026-10-01', 'pending', 'archived'); await app1(C('h'), 'submitted', '2026-10-05T10:00:00+09:00');
    await ins(C('i'), '2026-10-01', 'pending'); await app1(C('i'), 'submitted', '2026-10-01T00:10:00+09:00');   // KST 자정 직후 = 10-01(UTC 로는 9-30)
    const q0 = (await row(C('a'))).q;

    const dry = await correctStartDatesToFirstJoin({ dryRun: true });
    ok('미리보기 = 바꾸지 않고 목록만', dry.corrected.some(c => c.id === C('a')) && (await row(C('a'))).sd === '2026-10-01');
    const res = await correctStartDatesToFirstJoin();
    const mine = res.corrected.filter(c => ids.includes(c.id));
    x = await row(C('a'));
    ok('구매 확정 첫날로 앞으로 옮김 · first_join', x.sd === '2026-10-05' && x.b === 'first_join', JSON.stringify(x));
    ok('시작일이 바뀌면 정원 규칙 바뀐 시각이 찍힌다(트리거 그대로)', x.q && (!q0 || new Date(x.q) > new Date(q0)));
    ok('시작일 없던 블로그 공고 → 승인한 날', (await row(C('b'))).sd === '2026-10-07' && (await row(C('b'))).b === 'first_join');
    x = await row(C('c'));
    ok('첫 참여가 시작일보다 이르면 당기지 않는다(희망일 전 공고가 미리 열리지 않게)', x.sd === '2026-10-10' && x.b === 'pending' && res.skippedEarlier.some(s => s.id === C('c')), JSON.stringify(x));
    ok('사람이 정한 날은 안 바꾼다', (await row(C('d'))).sd === '2026-10-01');
    ok('이 칸 이전 공고(NULL)는 안 바꾼다(사용자 확정 1.가)', (await row(C('e'))).sd === '2026-10-01' && (await row(C('e'))).b === null);
    ok('참여가 없으면 그대로(내일 다시 본다)', (await row(C('f'))).sd === '2026-10-01' && (await row(C('f'))).b === 'pending');
    ok('지금 세는 탭 주문이 더 이르면 그날 — 옮긴 뒤에도 그 주문이 집계에 남는다', (await row(C('g'))).sd === '2026-10-03', JSON.stringify(await row(C('g'))));
    ok('보관된 공고는 안 바꾼다', (await row(C('h'))).sd === '2026-10-01');
    ok('날짜는 한국 시간으로 자른다', (await row(C('i'))).sd === '2026-10-01' && (await row(C('i'))).b === 'first_join');
    ok('이번 실행 맞춤 = a·b·g·i 넷', mine.length === 4, JSON.stringify(mine));
    const again = await correctStartDatesToFirstJoin();
    ok('다시 돌려도 더 바꾸지 않는다', again.corrected.filter(c => ids.includes(c.id)).length === 0);
  } finally {
    await pool.query(`DELETE FROM campaign_applications WHERE campaign_id = ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM order_submissions WHERE sheet_id LIKE 'campaign:camp_sd_%' OR sheet_id LIKE 'sheet_sd_%'`).catch(() => {});
    await pool.query(`DELETE FROM recruit_campaigns WHERE id = ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM work_orders WHERE id LIKE $1`, ['wo_sd%_' + st]).catch(() => {});
    srv.close();
  }
}

(async () => {
  if (process.env.PGTEST_URL) {
    await pg();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log(`\n✅ campaignStartDateFirstJoin: ${passed}개 통과${process.env.PGTEST_URL ? ' (진짜 PG 포함)' : ''}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
