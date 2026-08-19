/**
 * reviewerPhoneChange.test.js — 등록리뷰어DB 로그인 번호 변경 회귀가드 (migration 126)
 * 실행: node tests/reviewerPhoneChange.test.js
 *      PGTEST_URL=postgres://… node tests/reviewerPhoneChange.test.js   ← 진짜 PG16 시나리오까지
 *
 * 고정하는 것:
 *  A. 순수함수 — 11자리 규칙 · 같은 번호 거부 · 승격 시 sub_accounts 구성(방향 계약)
 *  B. checkPhoneChange 실행(스텁 db) — 차단 4종 · 쓰기 0
 *  C. 라우터 — /reviewers/phone 권한 체인(adminOrMaster) · confirm 없으면 미리보기
 *  D. 프론트 — 버튼·팝업 배선 · 바깥클릭 미닫힘 · onclick 인덱스만 · 프론트 재판정 0
 *  E. ★ 진짜 PG16 end-to-end — 승격 후 과거 이력이 계속 조회되는지(이 기능의 존재 이유),
 *     키 이관·충돌 보존·블랙리스트 승계·감사 이력·차단 시 쓰기 0
 */
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;   // pool 은 require 시점에 읽는다
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0;
function ok(name, cond, extra) {
  assert(cond, name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  passed++; console.log('  ✓ ' + name);
}

(async () => {
  const svc = require('../src/services/reviewerPhoneChange.service');
  const svcSrc = read('src/services/reviewerPhoneChange.service.js');
  const trackBSrc = read('src/routes/trackB.routes.js');
  const wdk = read('../frontend/workdesk.html');

  // ── A. 순수함수 ──
  console.log('\n[A] 순수함수 — 형식 규칙 · 승격 시 타계정 구성');
  {
    ok('11자리 아니면 거부', svc.validateNewPhone('01085926325', '0109186994').code === 'bad_phone');
    ok('하이픈은 정규화해서 통과', svc.validateNewPhone('01085926325', '010-9186-9944').phone === '01091869944');
    ok('같은 번호는 거부(no-op 저장 금지)', svc.validateNewPhone('010-8592-6325', '01085926325').code === 'same_phone');

    const subs = svc.buildSubAccounts([], { name: '김수만', oldPhone: '01085926325', newPhone8: '91869944' });
    ok('★ 옛 번호가 같은 이름으로 타계정에 남는다(과거 이력 조회의 근거)',
      subs.length === 1 && subs[0].phone === '01085926325' && subs[0].name === '김수만', subs);
    const again = svc.buildSubAccounts(subs, { name: '김수만', oldPhone: '01085926325', newPhone8: '91869944' });
    ok('중복 추가 없음(뒤 8자리 기준)', again.length === 1);
    const promoted = svc.buildSubAccounts(
      [{ name: '김수만', phone: '01091869944' }], { name: '김수만', oldPhone: '01085926325', newPhone8: '91869944' });
    ok('★ 승격된 새 번호는 타계정에서 걷어낸다', promoted.length === 1 && promoted[0].phone === '01085926325', promoted);
    ok('문자열 이중인코딩 sub_accounts 도 파싱',
      svc.buildSubAccounts('[{"name":"김수만","phone":"01000000000"}]',
        { name: '김수만', oldPhone: '01085926325', newPhone8: '91869944' }).length === 2);
  }

  // ── B. checkPhoneChange 실행(스텁 db) — 차단 4종 ──
  console.log('\n[B] checkPhoneChange (스텁 db 실행) — 차단 사유 · 쓰기 0');
  {
    const ME = { id: '11111111-1111-4111-8111-111111111111', name: '김수만', phone: '01085926325', phone8: '85926325', sub_accounts: [] };
    const mk = (over) => {
      const writes = [];
      const db = { query: async (sql, params) => {
        if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) { writes.push(sql); return { rowCount: 1, rows: [] }; }
        if (/FROM reviewers WHERE id = \$1/.test(sql)) return { rows: [ME] };
        if (/FROM reviewers\s+WHERE id <> \$1/.test(sql)) return { rows: over.dup || [] };
        if (/jsonb_array_elements/.test(sql)) return { rows: over.subOwner || [] };
        if (/campaign_applications\s*\n?\s*WHERE status = 'applied'/.test(sql) || /status = 'applied'/.test(sql))
          return { rows: [{ n: over.hold || 0 }] };
        return { rows: [{ n: 0 }] };
      } };
      return { db, writes };
    };
    const codes = async (over) => {
      const { db, writes } = mk(over);
      const out = await svc.checkPhoneChange(db, { id: ME.id, newPhone: '01091869944' });
      ok('미리보기는 쓰기 0 (' + (over.label || 'clean') + ')', writes.length === 0, writes);
      return out.blockers.map(b => b.code);
    };
    ok('정상이면 차단 0', (await codes({ label: 'clean' })).length === 0);
    ok('① 번호가 이미 다른 리뷰어 것 → phone_taken',
      (await codes({ label: 'taken', dup: [{ id: 'x', name: '홍길동', phone: '01091869944', phone8: '91869944' }] })).includes('phone_taken'));
    ok('② 뒤 8자리만 겹쳐도 차단 → phone8_taken (phone8 은 비유니크)',
      (await codes({ label: 'p8', dup: [{ id: 'x', name: '홍길동', phone: '01191869944', phone8: '91869944' }] })).includes('phone8_taken'));
    ok('③ 남의 타계정으로 등록된 번호 → sub_of_other',
      (await codes({ label: 'sub', subOwner: [{ name: '정라희' }] })).includes('sub_of_other'));
    ok('④ 유효 홀드 있으면 차단 → active_hold',
      (await codes({ label: 'hold', hold: 2 })).includes('active_hold'));
    try { await svc.checkPhoneChange(mk({}).db, { id: 'not-a-uuid', newPhone: '01091869944' }); ok('bad_id 던짐', false); }
    catch (e) { ok('id 는 UUID 만 (phone8 키 지목 금지)', e.code === 'bad_id'); }
  }

  // ── C. 라우터 ──
  console.log('\n[C] 라우터 — 권한 체인 · 2단 계약');
  {
    const router = require('../src/routes/trackB.routes');
    const layer = router.stack.find(l => l.route && l.route.path === '/reviewers/phone');
    ok('POST /reviewers/phone 등록됨', !!layer && !!layer.route.methods.post);
    const names = layer.route.stack.map(s => s.name);
    ok('★ authMiddleware + adminOrMaster (등록리뷰어DB 와 같은 게이트 — AE·광고주 차단)',
      names.some(n => /auth/i.test(n)) && names.some(n => /adminOrMaster/i.test(n)), names);
    // ★ 함수 본문만 잘라서 본다 — 다음 라우트의 주석(reviewers/delete 의 force 설명)이
    //   섞여 들어오면 "force 우회 없음" 검사가 잘못된 이유로 실패한다.
    const body = trackBSrc.slice(trackBSrc.indexOf("router.post('/reviewers/phone'"));
    const end = body.indexOf('\n});');
    const fn = body.slice(0, end > 0 ? end + 4 : 4000);
    ok('confirm !== true 면 previewPhoneChange(쓰기 0)', /confirm !== true[\s\S]{0,200}previewPhoneChange/.test(fn));
    ok('★ blockers 남으면 409 로 거부(force 우회 없음)',
      /!out\.ok\)\s*return res\.status\(409\)/.test(fn) && !/force/.test(fn));
    ok('42P01 은 not_ready 로 말한다(마스킹 방지)', /42P01[\s\S]{0,160}not_ready/.test(fn));
  }

  // ── D. 프론트 ──
  console.log('\n[D] 프론트(등록리뷰어DB) — 배선 · 팝업 규율');
  {
    ok('연락처 칸에 [변경] 버튼 — onclick 은 인덱스만',
      /_rvPhone\(\$\{i\}\)/.test(wdk) && !/_rvPhone\('\$\{/.test(wdk));
    ok('팝업은 body 직속', /_rvPhone[\s\S]{0,2600}document\.body\.appendChild/.test(wdk));
    // ★ 변이시험이 뚫은 자리: "인라인 onclick 문자열이 없다"만 보면 setAttribute·addEventListener·d.onclick
    //   어느 쪽으로 붙여도 통과한다 → **_rvPhone 본문에 오버레이 클릭 핸들러 자체가 없음**을 고정한다.
    const openFn = wdk.slice(wdk.indexOf('function _rvPhone(i){'), wdk.indexOf('async function _rvPhCheck'));
    ok('Esc 로 닫는 길은 있다', /_rvPhEsc[\s\S]{0,200}Escape/.test(openFn));
    ok('★ 바깥 클릭으로 닫지 않는다(입력한 번호 보호) — Esc/[취소]만',
      !/event\.target\s*===\s*this/.test(openFn) && !/d\.onclick/.test(openFn)
      && !/setAttribute\(\s*'onclick'/.test(openFn) && !/addEventListener\(\s*'click'/.test(openFn));
    ok('Esc 리스너는 닫을 때 해제(중복 누적 방지)', /removeEventListener\('keydown',\s*window\._rvPhEsc\)/.test(wdk));
    const check = wdk.slice(wdk.indexOf('async function _rvPhCheck'), wdk.indexOf('async function _rvPhApply'));
    ok('1단계는 confirm 없이 물어본다(쓰기 0)', /reviewers\/phone[\s\S]{0,200}id:row\.id,phone\}/.test(check));
    ok('★ 프론트 재판정 0 — 서버 blockers 를 그대로 그린다',
      /r\.blockers/.test(check) && !/length !== 11/.test(check));
    ok('차단이 있으면 [이대로 변경] 버튼을 만들지 않는다',
      check.indexOf('bl.length') < check.indexOf('_rvPhApply('));
    const apply = wdk.slice(wdk.indexOf('async function _rvPhApply'));
    ok('2단계는 confirm:true 로 보낸다', /confirm:true/.test(apply.slice(0, 1200)));
    ok('옮기지 못한 항목(kept)을 조용히 넘기지 않는다', /kept/.test(apply.slice(0, 1600)));
  }

  // ── E. 진짜 PG16 end-to-end ──
  if (!process.env.PGTEST_URL) {
    console.log('\n[E] (건너뜀) PGTEST_URL 이 없어 진짜 PG 시나리오는 실행하지 않았습니다.');
  } else {
    console.log('\n[E] 진짜 PG16 — 김수만 01085926325 → 01091869944 시나리오');
    const pool = require('../src/db/pool');
    const q = (sql, p) => pool.query(sql, p);
    const CID = 'camp_rpc_test';
    const cleanup = async () => {
      await q(`DELETE FROM reviewer_phone_changes WHERE reviewer_name LIKE '테스트%'`);
      await q(`DELETE FROM campaign_reviewer_gates WHERE campaign_id = $1`, [CID]);
      await q(`DELETE FROM recruit_campaigns WHERE id = $1`, [CID]);
      await q(`DELETE FROM cs_threads WHERE campaign_key = 'sheet_rpc'`);
      await q(`DELETE FROM reviewer_campaign_editors WHERE phone8 IN ('85926325','91869944','55550001')`);
      await q(`DELETE FROM blacklist WHERE phone IN ('01085926325','01091869944','01055550001')`);
      await q(`DELETE FROM review_index WHERE sheet_id = 'sheet_rpc'`);
      await q(`DELETE FROM order_submissions WHERE sheet_id = 'sheet_rpc'`);
      await q(`DELETE FROM campaign_applications WHERE campaign_id = $1`, [CID]);
      // ★ sub_accounts 를 건드리므로 계좌 감사 트리거(121/123/125)가 함께 돈다 — 그 행을 먼저 지운다.
      await q(`DELETE FROM reviewer_account_change_audit a
                USING reviewers r WHERE a.reviewer_id = r.id AND r.name LIKE '테스트%'`);
      await q(`DELETE FROM reviewers WHERE name LIKE '테스트%'`);
      await q(`DELETE FROM blacklist WHERE phone = '01055550001'`);
    };
    await cleanup();

    // 시드: 김수만(옛 번호)로 과거 이력이 쌓여 있는 상태
    const { rows: [me] } = await q(
      `INSERT INTO reviewers (name, phone, bank_name, bank_account, account_holder)
       VALUES ('테스트김수만','01085926325','하나','12345678','테스트김수만') RETURNING id, phone8`);
    ok('시드: phone8 은 GENERATED 로 파생', me.phone8 === '85926325', me);
    await q(`INSERT INTO review_index (sheet_id, tab_name, row_index, reviewer_name, phone8, is_submitted)
             VALUES ('sheet_rpc','7월탭',10,'테스트김수만','85926325',TRUE),
                    ('sheet_rpc','7월탭',11,'테스트김수만','85926325',FALSE)`);
    await q(`INSERT INTO order_submissions (sheet_id, tab_name, orderer, recipient, phone)
             VALUES ('sheet_rpc','7월탭','테스트김수만','테스트김수만','010-8592-6325')`);
    await q(`INSERT INTO cs_threads (reviewer_phone8, campaign_key, campaign_label) VALUES ('85926325','sheet_rpc','7월탭')`);
    await q(`INSERT INTO reviewer_campaign_editors (phone8, label) VALUES ('85926325','테스트김수만')`);
    await q(`INSERT INTO recruit_campaigns (id, title) VALUES ($1,'테스트공고')`, [CID]);
    await q(`INSERT INTO campaign_reviewer_gates (campaign_id, phone8, reviewer_name, mode, message_type)
             VALUES ($1,'85926325','테스트김수만','block','policy')`, [CID]);
    await q(`INSERT INTO blacklist (phone, name, reason) VALUES ('01085926325','테스트김수만','리뷰 미작성')`);

    // ── E-1. 차단: 뒤 8자리가 겹치는 타인 ──
    const { rows: [other] } = await q(
      `INSERT INTO reviewers (name, phone) VALUES ('테스트홍길동','01191869944') RETURNING id`);
    let r = await svc.applyPhoneChange({ id: me.id, newPhone: '01091869944', by: 'tester' });
    ok('E-1 ★ 뒤 8자리 겹침 → 차단', r.ok === false && r.blockers.some(b => b.code === 'phone8_taken'), r.blockers);
    const { rows: [after1] } = await q('SELECT phone FROM reviewers WHERE id = $1', [me.id]);
    ok('E-1 ★ 차단이면 쓰기 0(번호 그대로)', after1.phone === '01085926325');
    await q('DELETE FROM reviewers WHERE id = $1', [other.id]);

    // ── E-2. 차단: 유효 홀드 ──
    await q(`INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, phone8, status, expires_at)
             VALUES ($1,'테스트김수만','01085926325','85926325','applied', NOW() + interval '10 min')`, [CID]);
    r = await svc.applyPhoneChange({ id: me.id, newPhone: '01091869944', by: 'tester' });
    ok('E-2 ★ 진행 중 홀드가 있으면 차단(제출 확정 소각 방지)',
      r.ok === false && r.blockers.some(b => b.code === 'active_hold'), r.blockers);
    await q(`UPDATE campaign_applications SET status='expired' WHERE campaign_id=$1`, [CID]);

    // ── E-3. 새 번호로 이미 문의방이 있는 상태(이관 충돌) ──
    await q(`INSERT INTO cs_threads (reviewer_phone8, campaign_key, campaign_label) VALUES ('91869944','sheet_rpc','7월탭')`);

    // ── E-3b. 프로브 하나가 42703/42P01 로 죽어도 점검·실행이 살아남는가(SAVEPOINT 격리) ──
    //   ★ 진짜 PG 로만 재현된다 — 격리가 없으면 25P02 로 트랜잭션 전체가 죽어 변경이 통째로 실패한다.
    await q('ALTER TABLE blacklist RENAME TO blacklist_rpc_tmp');
    let isolated;
    try { isolated = await svc.previewPhoneChange({ id: me.id, newPhone: '01091869944' }); }
    catch (e) { isolated = { failedWith: e.message }; }
    finally { await q('ALTER TABLE blacklist_rpc_tmp RENAME TO blacklist'); }
    ok('E-3b 집계 프로브가 죽어도 **미리보기**는 끝까지 간다(pool 경로 fail-soft)',
      !!isolated && !isolated.failedWith && isolated.countsPartial === true
      && (isolated.counts.reviewRows | 0) === 2, isolated && (isolated.failedWith || isolated.counts));

    // ── E-4. 실행 ──
    r = await svc.applyPhoneChange({ id: me.id, newPhone: '010-9186-9944', by: '관리자테스트' });
    ok('E-4 변경 성공', r.ok === true, r);
    const { rows: [now] } = await q('SELECT phone, phone8, sub_accounts FROM reviewers WHERE id = $1', [me.id]);
    ok('E-4 본계정이 새 번호', now.phone === '01091869944' && now.phone8 === '91869944', now);
    ok('E-4 ★ 옛 번호가 타계정으로 남는다',
      now.sub_accounts.some(s => s.phone === '01085926325' && s.name === '테스트김수만'), now.sub_accounts);

    // ★ 이 기능의 존재 이유 — 과거 이력이 계속 조회되는가(실제 소비 함수로 확인)
    const { _getReviewerPhoneList } = require('../src/services/search.service');
    const list = await _getReviewerPhoneList('91869944');
    ok('E-4 ★★ 새 번호 세션이 옛 번호까지 스코프에 담는다', list.includes('91869944') && list.includes('85926325'), list);
    const { rows: seen } = await q(
      `SELECT COUNT(*)::int AS n FROM review_index WHERE phone8 = ANY($1)`, [list]);
    ok('E-4 ★★ 옛 번호로 적힌 참여 2건이 그대로 조회된다(리뷰 내역·검색 경로)', seen[0].n === 2, seen[0]);
    ok('E-4 ★ review_index 는 건드리지 않았다(시트가 진실원본)',
      !/UPDATE review_index|UPDATE participation_links|UPDATE order_submissions/.test(svcSrc));

    // 키 이관
    const { rows: cs } = await q(
      `SELECT reviewer_phone8 AS p8, COUNT(*)::int AS n FROM cs_threads
        WHERE campaign_key='sheet_rpc' GROUP BY 1 ORDER BY 1`);
    ok('E-4 ★ 문의방은 대상에 이미 있으면 옮기지 않고 남긴다(UNIQUE 충돌 보존)',
      cs.length === 2 && cs.every(x => x.n === 1), cs);
    ok('E-4 옮기지 못한 건수를 보고한다', r.moved.inquiries.kept === 1, r.moved.inquiries);
    const { rows: g } = await q(`SELECT phone8 FROM campaign_reviewer_gates WHERE campaign_id=$1 AND released_at IS NULL`, [CID]);
    ok('E-4 공고별 참여 예외가 새 번호로 이관', g.length === 1 && g[0].phone8 === '91869944', g);
    const { rows: ed } = await q(`SELECT phone8 FROM reviewer_campaign_editors WHERE phone8 IN ('85926325','91869944')`);
    ok('E-4 공고수정 허용명단 이관', ed.length === 1 && ed[0].phone8 === '91869944', ed);
    const { rows: bl } = await q(`SELECT phone FROM blacklist WHERE phone IN ('01085926325','01091869944') ORDER BY 1`);
    ok('E-4 ★★ 블랙리스트는 새 번호에도 등록(번호를 갈아 차단을 피할 수 없다)',
      bl.length === 2, bl);
    const { rows: log } = await q(`SELECT old_phone, new_phone, changed_by, moved FROM reviewer_phone_changes WHERE reviewer_id=$1`, [me.id]);
    ok('E-4 ★ 감사 이력 1행(누가·언제·무엇을)',
      log.length === 1 && log[0].old_phone === '01085926325' && log[0].new_phone === '01091869944' && log[0].changed_by === '관리자테스트', log[0]);

    // ★ 계좌 감사 트리거(121/123/125)는 sub_accounts UPDATE 에 걸려 있다 — 번호 변경이 그 트리거를
    //   실제로 지나가는지(함수 본문은 실행 시점에만 터진다) 여기서 확인한다.
    {
      const { rows: aud } = await q(
        `SELECT COUNT(*)::int AS n FROM reviewer_account_change_audit WHERE reviewer_id = $1`, [me.id]);
      ok('E-4 ★ 계좌 감사 트리거를 통과했다(무신호 실패 없음)', aud[0].n >= 1, aud[0]);
    }

    // ── E-5. 되돌리기(다시 옛 번호로) — 승격 왕복 ──
    r = await svc.applyPhoneChange({ id: me.id, newPhone: '01085926325', by: 'tester' });
    ok('E-5 ★ 되돌릴 수 있다(옛 번호가 자기 타계정이라 sub_of_other 로 막히지 않는다)', r.ok === true, r.blockers);
    const { rows: [back] } = await q('SELECT phone, sub_accounts FROM reviewers WHERE id=$1', [me.id]);
    ok('E-5 왕복 후 본계정은 옛 번호, 새 번호가 타계정',
      back.phone === '01085926325' && back.sub_accounts.some(s => s.phone === '01091869944'), back);

    // ── E-6. ★ 잠금 트랜잭션 안에서 프로브가 죽어도 변경은 완주하는가(SAVEPOINT 격리) ──
    //   격리가 없으면 실패한 프로브 하나가 25P02 로 tx 전체를 죽여 **변경이 통째로 실패**한다.
    //   (previewPhoneChange 는 pool 경로라 이 회귀를 못 잡는다 — 변이시험이 짚은 자리)
    await q('ALTER TABLE blacklist RENAME TO blacklist_rpc_tmp');
    let txSafe;
    try { txSafe = await svc.applyPhoneChange({ id: me.id, newPhone: '01055550001', by: 'tester' }); }
    catch (e) { txSafe = { ok: false, threw: e.message }; }
    finally { await q('ALTER TABLE blacklist_rpc_tmp RENAME TO blacklist'); }
    ok('E-6 ★★ 프로브 실패가 트랜잭션을 죽이지 않는다(SAVEPOINT 격리)',
      txSafe && txSafe.ok === true, txSafe && (txSafe.threw || txSafe.blockers));

    await cleanup();
    await pool.end();
  }

  console.log(`\n결과: ${passed} 통과 / 0 실패`);
  process.exit(0);
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
