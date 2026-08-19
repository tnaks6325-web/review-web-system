/**
 * 작업표 줄 "표에서 분리"(보관) 회귀가드 — 2026-08-19 사용자 확정
 *
 * 왜 이 기능인가:
 *   8/18~19 중복 반영으로 생긴 줄 중 **이체 근거가 걸려 지울 수 없는 줄**(입금 회차에 담김)이
 *   작업표에 남아 담당자가 매일 지나쳐야 했다. 그렇다고 지우면(soft delete) 그 줄의 입금 표시가
 *   표에서 빠져 **남길 줄이 미입금으로 보이고 다음 회차에 다시 담겨 이중 송금**이 난다
 *   (payment.service 입금대상 = 제출완료 ∧ 미입금 ∧ 회차 이력 없음).
 *
 * 이 가드가 고정하는 것 (사용자 확정 "표에서만 빼기")
 *   1. ★★ **삭제가 아니다** — `deleted_at` 을 건드리지 않는다(전용 컬럼 `held_at`).
 *   2. ★★ **장부·검색·입금 무접촉** — 장부 재생성/입금대상 추출 쿼리에 `held_at` 이 없다.
 *      (있으면 그 줄이 review_index 에서 빠져 이중 송금 위험이 되살아난다)
 *   3. 그리드만 거른다 + 조용히 빼지 않는다(`counts.held` 로 건수 고지).
 *   4. 되돌리기가 기본(`hold:false`) · 누가 왜 분리했는지 남긴다.
 *   5. 게이트 = adminOrMaster, 화면 버튼도 같은 조건(죽은 버튼 금지).
 *   6. 마이그레이션은 컬럼 추가만(백필 0 · CHECK 0) — 배포 즉시 동작 불변.
 *
 * 실행: node tests/participantHold.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SRC = p => fs.readFileSync(path.join(root, 'src', p), 'utf8');
const PART = SRC('services/participants.service.js');
const TB = SRC('services/trackB.service.js');
const ROUTES = SRC('routes/trackB.routes.js');
const PAY = SRC('services/payment.service.js');
const LED = SRC('services/sheetlessLedger.service.js');
const HTML = fs.readFileSync(path.join(root, '..', 'frontend', 'workdesk.html'), 'utf8');
const MIG = fs.readFileSync(path.join(root, 'migrations', '129_participant_hold.sql'), 'utf8');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; };

const part = require('../src/services/participants.service');
function stub() {
  const sqls = [];
  const pool = { query: async (sql, params) => { sqls.push({ sql: String(sql), params }); return { rows: [], rowCount: 2 }; } };
  part.__setPoolForTest(pool);
  return sqls;
}

(async () => {
  console.log('\n[A] 마이그레이션 — 추가만');
  ok('컬럼 추가만(백필 0)', /ADD COLUMN IF NOT EXISTS held_at/.test(MIG)
    && !/UPDATE\s+campaign_participants/i.test(MIG));
  ok('CHECK 제약 없음(어휘 확장 때 저장이 막히지 않게)', !/CHECK\s*\(/i.test(MIG));
  ok('★ deleted_at 을 건드리지 않는다(삭제가 아니다)', !/deleted_at\s*=/.test(MIG));

  console.log('\n[B] 서비스 — 실제 실행');
  {
    const sqls = stub();
    const r = await part.holdRows({ sheetId: 'wt_x', tabName: 'T', seqs: [10, 20, 20, 'x', -1], reason: '중복 보류', by: '망고' });
    const q = sqls[0].sql;
    ok('분리는 UPDATE 한 번(전용 컬럼)', sqls.length === 1 && /SET held_at = NOW\(\)/.test(q));
    ok('★★ deleted_at 을 쓰지 않는다(삭제 금지)', !/deleted_at\s*=/.test(q));
    ok('★ 이미 분리된 줄은 다시 건드리지 않는다(멱등)', /held_at IS NULL/.test(q));
    ok('삭제된 줄은 대상 아님', /deleted_at IS NULL/.test(q));
    ok('줄 번호는 중복 제거·정수만', JSON.stringify(sqls[0].params[2]) === '[10,20]' && r.changed === 2);
    ok('누가 왜 분리했는지 남긴다', /held_reason = LEFT\(\$4/.test(q) && /held_by = LEFT\(\$5/.test(q));
  }
  {
    const sqls = stub();
    await part.holdRows({ sheetId: 'wt_x', tabName: 'T', seqs: [10], hold: false });
    ok('★ 되돌리기는 표식만 지운다', /SET held_at = NULL/.test(sqls[0].sql)
      && /held_at IS NOT NULL/.test(sqls[0].sql) && !/deleted_at\s*=/.test(sqls[0].sql));
  }
  {
    const sqls = stub();
    const r = await part.holdRows({ sheetId: 'wt_x', tabName: 'T', seqs: [] });
    ok('★ 대상이 없으면 아무것도 하지 않는다(쿼리 0)', sqls.length === 0 && r.ok === false && r.reason === 'empty');
  }
  {
    const sqls = stub();
    await part.listHeldRows({ sheetId: 'wt_x', tabName: 'T' });
    ok('보관함 목록은 읽기 전용', /^SELECT/.test(sqls[0].sql.trim()) && /held_at IS NOT NULL/.test(sqls[0].sql));
    part.__setPoolForTest(null);
  }

  console.log('\n[C] ★★ 무접촉 — 장부·검색·입금은 held 를 모른다');
  ok('★★ 입금대상 추출에 held 조건이 없다(있으면 그 줄이 빠져 이중 송금 위험)',
    !/held_at/.test(PAY));
  ok('★★ 장부 생성기에 held 조건이 없다(review_index 에서 빠지면 리뷰어 검색이 죽는다)',
    !/held_at/.test(LED));

  console.log('\n[D] 그리드 — 표에서만 빼고 건수를 고지');
  {
    const i = TB.indexOf('// 명단(활성) — 앵커 도출에 필요한 컬럼 포함');
    const seg = TB.slice(i, i + 1400);
    ok('명단 조회가 분리된 줄을 거른다', /AND held_at IS NULL/.test(seg));
    ok('★ 조용히 빼지 않는다 — 건수를 센다', /held_at IS NOT NULL/.test(seg) && /heldCount/.test(seg));
    ok('★ 조회 실패는 fail-soft(표는 떠야 한다)', /heldUnavailable = e\.message/.test(TB));
    ok('응답 counts 에 실린다', /held: heldCount/.test(TB));
  }

  console.log('\n[E] 라우트 (라우터 스택 실검사)');
  {
    const tb = require('../src/routes/trackB.routes');
    const L = p => tb.stack.filter(l => l.route && l.route.path === p)
      .map(l => ({ m: Object.keys(l.route.methods), mw: l.route.stack.map(s => s.name) }));
    const post = L('/worktable/hold-rows'), get = L('/worktable/held-rows');
    ok('분리·되돌리기 POST 등록', post.length === 1 && post[0].m.includes('post'));
    ok('보관함 목록 GET 등록', get.length === 1 && get[0].m.includes('get'));
    ok('★ 둘 다 authMiddleware 뒤', post[0].mw.includes('authMiddleware') && get[0].mw.includes('authMiddleware'));
    ok('★★ adminOrMaster — 중복 정리와 같은 급',
      post[0].mw.includes('adminOrMasterMiddleware') && get[0].mw.includes('adminOrMasterMiddleware'));
    ok('스키마 미적용은 not_ready 로 말한다', /migration 129/.test(ROUTES));
  }

  console.log('\n[F] 화면 배선');
  ok('상단에 분리 건수를 표기한다', /🔒 분리 \$\{c\.held\}/.test(HTML));
  ok('★ 조회 실패는 "0건" 으로 꾸미지 않는다', /c\.heldUnavailable/.test(HTML) && /분리 \?/.test(HTML));
  ok('★★ 화면 게이트 = 서버 게이트(master/admin) — 죽은 버튼 금지',
    /function _hbCan\(\)\{ return STATE\.role === 'master' \|\| STATE\.role === 'admin'; \}/.test(HTML)
    && /_hbCan\(\) \? `<div style="margin:5px 0 0 12px"><button class="wbl-b" onclick="ddHoldSkipped/.test(HTML));
  ok('보류 목록에서 **지울 줄만** 분리한다(남길 줄 보존)',
    /\(g\.removeSeqs \|\| \[\]\)\.filter\(s => Number\(s\) !== Number\(g\.keepSeq\)\)/.test(HTML));
  ok('★ 확인창이 무엇이 되는지 말한다(삭제 아님·되돌리기 가능)',
    /표에서만 빠지고 데이터·이체 근거·리뷰어 검색은 그대로입니다/.test(HTML));
  ok('★ 보관함이 "집계에는 계속 포함" 을 말한다(숫자와 표가 왜 다른지)',
    /참여자·제출·입금 숫자에는 계속 포함/.test(HTML));
  ok('★ 오버레이는 body 직속', /ov\.id = 'hbOv';[\s\S]{0,500}document\.body\.appendChild\(ov\)/.test(HTML));
  ok('★ Esc 리스너는 최상위 1회', /window\._hbKeyBound/.test(HTML));
  ok('★ 조회 실패도 화면을 종결시킨다(무한 로딩 금지)',
    /_HB\.busy = false; _HB\.err = '조회 실패/.test(HTML) && /다시 시도/.test(HTML));
  ok('★ onclick 은 인덱스만(시트발 문자열 보간 금지)',
    /onclick="hbPick\(\$\{i\}\)"/.test(HTML) && /onclick="ddHoldSkipped\(\$\{i\}\)"/.test(HTML));

  console.log(`\n✅ participantHold ${pass} 케이스 통과`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
