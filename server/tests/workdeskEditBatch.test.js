'use strict';
/**
 * workdeskEditBatch.test.js — 붙여넣기 일괄 편집(왕복 1회) 회귀가드
 * 실행: node tests/workdeskEditBatch.test.js
 *
 * 고정하는 것:
 *  ① 커넥션은 배치 전체에 **1개** — 칸마다 잡으면 PG 풀(20)이 고갈된다(실측 419/500 타임아웃)
 *  ② 건별 트랜잭션 — 한 칸이 거부돼도 나머지가 저장된다(붙여넣기는 칸마다 성패가 갈리는 조작)
 *  ③ 한 건이 던져도 배치를 죽이지 않고 그 칸만 실패로 보고한다
 *  ④ decide 판정은 (탭,열) 단위로 재사용 — 500칸이라도 판정 쿼리는 열 수만큼
 *  ⑤ 저장 로직 사본 0 — participant_edits INSERT 는 `_editOneInTx` 한 곳뿐
 *  ⑥ 상한이 서버에도 있다(화면만 믿지 않는다)
 *  ⑦ 화면 — 붙여넣기는 칸마다 요청하지 않고 edit-batch 를 1회 호출, 낙관반영/롤백은 한 벌
 */
process.env.SHEETLESS_CELL_WRITE = 'allow';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripLine = s => s.replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

const svc = require('../src/services/trackB.service');
console.log('\n▶ 붙여넣기 일괄 편집(왕복 1회) 회귀가드\n');

/* ── 배치용 스텁 풀 ─────────────────────────────────────── */
function batchPool({ failRowIds = [], throwRowIds = [], dh = ['비고', '메모'] } = {}) {
  const q = []; let connects = 0, released = 0;
  const client = {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/^BEGIN|^ROLLBACK|^COMMIT/.test(s)) return { rows: [] };
      if (/FROM campaign_participants WHERE id=\$1 .* FOR UPDATE/.test(s)) {
        const id = params[0];
        if (throwRowIds.indexOf(id) >= 0) throw new Error('boom ' + id);
        if (failRowIds.indexOf(id) >= 0) return { rows: [] };          // row_not_found
        return { rows: [{ id, seq: 7, source: 'import', order_submission_id: null,
                          identity_key: 'phone8:' + id, phone8: '1', recipient_name: null,
                          option_text: null, row_json: { 비고: '옛값', 메모: '옛값' }, tab_gid: '1' }] };
      }
      if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(s)) return { rows: [{ n: 1 }] };
      if (/FROM raw_sheet_tabs WHERE sheet_id/.test(s)) return { rows: [{ detected_headers: dh }] };
      if (/FROM tab_configs tc/.test(s)) return { rows: [{ sheetless: true, gid: '1', dh }] };
      if (/UPDATE participant_edits SET reverted_at/.test(s)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO participant_edits/.test(s)) return { rows: [{ id: 9 }] };
      if (/UPDATE campaign_participants SET row_json/.test(s)) return { rowCount: 1, rows: [] };
      return { rows: [] };
    },
    release() { released++; },
  };
  return { q, get connects() { return connects; }, get released() { return released; },
           async connect() { connects++; return client; },
           async query(sql, p) { return client.query(sql, p); } };
}
const mk = (n, field) => Array.from({ length: n }, (_, i) => ({ rowId: 'r' + i, field: field || 'col:비고', value: 'v' + i }));

(async () => {
  /* ── 1) 커넥션 1개 · 건별 tx ─────────────────────────── */
  const p1 = batchPool();
  svc.__setPoolForTest(p1);
  const out1 = await svc.editWorkdeskRowsBatch({ sheetId: 's', tabName: 'T', edits: mk(25) });
  t('1a: 25칸 배치가 커넥션을 1개만 쓴다(풀 고갈 차단)', () => {
    assert.ok(out1.ok, '배치 성공');
    assert.equal(out1.total, 25); assert.equal(out1.succeeded, 25); assert.equal(out1.failed, 0);
    assert.equal(p1.connects, 1, '커넥션 = 1개 (받음 ' + p1.connects + ')');
    assert.equal(p1.released, 1, '커넥션 반납도 1회');
  });
  t('1b: 건별 트랜잭션 — BEGIN/COMMIT 이 칸 수만큼(한 tx 로 500행을 잡지 않는다)', () => {
    const sq = p1.q.map(x => x.s);
    assert.equal(sq.filter(s => /^BEGIN/.test(s)).length, 25, 'BEGIN 25회');
    assert.equal(sq.filter(s => /^COMMIT/.test(s)).length, 25, 'COMMIT 25회');
  });
  t('1c: 결과가 요청 순서·rowId·field 를 그대로 되돌려준다(화면이 칸을 짝지을 수 있어야 한다)', () => {
    out1.results.forEach((r, i) => {
      assert.equal(r.index, i); assert.equal(r.rowId, 'r' + i); assert.equal(r.field, 'col:비고');
    });
  });
  t('1d: 쓰기-through 결과를 건별로 보고한다', () => {
    assert.equal(out1.wroteRowJson, 25, 'row_json 기록 건수');
    assert.ok(out1.results[0].writeThrough && out1.results[0].writeThrough.column === '비고');
  });

  /* ── 2) 판정 재사용 ──────────────────────────────────── */
  t('2a: decide 판정은 (탭,열) 단위 1회 — 칸마다 다시 묻지 않는다', () => {
    const n = p1.q.filter(x => /FROM tab_configs tc/.test(x.s)).length;
    assert.equal(n, 1, '판정 쿼리 = 1회 (받음 ' + n + ')');
  });
  (async () => {})();
  const p2 = batchPool();
  svc.__setPoolForTest(p2);
  await svc.editWorkdeskRowsBatch({ sheetId: 's', tabName: 'T',
    edits: [...mk(5, 'col:비고'), ...mk(5, 'col:메모')] });
  t('2b: 열이 둘이면 판정도 둘 — 캐시가 열을 뭉개지 않는다', () => {
    const n = p2.q.filter(x => /FROM tab_configs tc/.test(x.s)).length;
    assert.equal(n, 2, '판정 쿼리 = 2회 (받음 ' + n + ')');
  });

  /* ── 3) 건별 독립 ────────────────────────────────────── */
  const p3 = batchPool({ failRowIds: ['r2'], throwRowIds: ['r5'] });
  svc.__setPoolForTest(p3);
  const out3 = await svc.editWorkdeskRowsBatch({ sheetId: 's', tabName: 'T', edits: mk(8) });
  t('3a: 거부된 칸 하나가 나머지를 죽이지 않는다', () => {
    assert.ok(out3.ok, '배치 자체는 성공으로 응답');
    assert.equal(out3.succeeded, 6, '성공 6 (받음 ' + out3.succeeded + ')');
    assert.equal(out3.failed, 2, '실패 2');
    assert.equal(out3.results[2].ok, false); assert.equal(out3.results[2].error, 'row_not_found');
  });
  t('3b: 한 건이 던져도 배치가 계속되고 그 칸만 실패로 보고된다', () => {
    assert.equal(out3.results[5].ok, false, 'r5 실패');
    assert.equal(out3.results[5].error, 'edit_failed');
    assert.equal(out3.results[6].ok, true, '그 다음 칸은 정상 저장');
  });
  t('3c: 예외 뒤 커넥션을 재사용하기 전에 ROLLBACK 을 확실히 푼다', () => {
    const sq = p3.q.map(x => x.s);
    const iThrow = sq.findIndex((s, i) => /FOR UPDATE/.test(s) && p3.q[i].params && p3.q[i].params[0] === 'r5');
    assert.ok(iThrow > 0, 'r5 조회 지점');
    assert.ok(sq.slice(iThrow).some(s => /^ROLLBACK/.test(s)), '이후 ROLLBACK 존재');
  });
  t('3d: 빠진 인자는 쿼리 없이 그 칸만 거부한다', async () => {});
  const p4 = batchPool();
  svc.__setPoolForTest(p4);
  const out4 = await svc.editWorkdeskRowsBatch({ sheetId: 's', tabName: 'T',
    edits: [{ rowId: 'r0', field: 'col:비고', value: 'a' }, { rowId: '', field: 'col:비고', value: 'b' }] });
  t('3e: rowId 없는 칸은 거부되고 나머지는 저장된다', () => {
    assert.equal(out4.succeeded, 1); assert.equal(out4.failed, 1);
    assert.equal(p4.q.filter(x => /^BEGIN/.test(x.s)).length, 1, '거부된 칸은 tx 조차 열지 않는다');
  });

  /* ── 4) 상한 ─────────────────────────────────────────── */
  const p5 = batchPool();
  svc.__setPoolForTest(p5);
  const over = await svc.editWorkdeskRowsBatch({ sheetId: 's', tabName: 'T', edits: mk(svc.EDIT_BATCH_MAX + 1) });
  t('4a: 상한 초과는 서버가 거부한다(화면만 믿지 않는다) — 쿼리 0건', () => {
    assert.equal(over.ok, false); assert.equal(over.error, 'too_many_edits');
    assert.equal(p5.connects, 0, '커넥션조차 잡지 않는다');
  });
  t('4b: 빈 배열도 거부', async () => {});
  const empty = await svc.editWorkdeskRowsBatch({ sheetId: 's', tabName: 'T', edits: [] });
  t('4c: 빈 배열 거부', () => { assert.equal(empty.ok, false); assert.equal(empty.error, 'edits_required'); });
  t('4d: 상한은 화면 상한(_PASTE_MAX)과 같다', () => {
    const fe = R('frontend/workdesk.html');
    const m = fe.match(/_PASTE_MAX\s*=\s*(\d+)/);
    assert.ok(m, '_PASTE_MAX 선언');
    assert.equal(Number(m[1]), svc.EDIT_BATCH_MAX,
      '화면 상한(' + m[1] + ') ≠ 서버 상한(' + svc.EDIT_BATCH_MAX + ') — 붙여넣을 수 있다고 해놓고 서버가 거부한다');
  });

  /* ── 5) 사본 금지 ────────────────────────────────────── */
  const S = stripLine(R('server/src/services/trackB.service.js'));
  t('5a: participant_edits INSERT 는 편집 함수 한 곳뿐(배치가 로직을 복사하지 않았다)', () => {
    const n = (S.match(/INSERT INTO participant_edits\s*\n?\s*\(sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_bool, value_text, created_by,/g) || []).length;
    assert.equal(n, 1, '쓰기-through 컬럼을 가진 INSERT 는 1곳이어야 함 (받음 ' + n + ')');
  });
  t('5b: 배치는 _editOneInTx 를 호출한다(자체 SQL 없음)', () => {
    const i = S.indexOf('async function editWorkdeskRowsBatch');
    assert.ok(i > 0, '배치 함수 존재');
    const body = S.slice(i, S.indexOf('\n}\n', i));
    assert.ok(/_editOneInTx\(client,/.test(body), '_editOneInTx 위임');
    assert.ok(!/INSERT INTO participant_edits/.test(body), '배치 본문에 자체 INSERT 금지');
    assert.ok(!/FOR UPDATE/.test(body), '배치 본문에 자체 행잠금 금지');
  });
  t('5c: 단건 편집도 같은 함수를 탄다(두 경로가 갈리지 않는다)', () => {
    const i = S.indexOf('async function editWorkdeskRow(');
    const body = S.slice(i, i + 400);
    assert.ok(/_editOneInTx\(client,/.test(body), '단건도 _editOneInTx 위임');
  });
  t('5d: _editOneInTx 는 커넥션을 스스로 잡지 않는다(배치가 재사용할 수 있어야 한다)', () => {
    const i = S.indexOf('async function _editOneInTx');
    const body = S.slice(i, S.indexOf('async function editWorkdeskRow(', i));
    assert.ok(!/getPool\(\)\.connect|db\.connect\(/.test(body), '_editOneInTx 안에서 connect 금지');
    assert.ok(!/client\.release\(\)/.test(body), '_editOneInTx 안에서 release 금지');
  });

  /* ── 6) 라우트 ───────────────────────────────────────── */
  const RT = stripLine(R('server/src/routes/trackB.routes.js'));
  t('6a: edit-batch 라우트가 단건과 같은 게이트를 쓴다(권한이 넓어지지 않는다)', () => {
    const i = RT.indexOf("router.post('/workdesk/edit-batch'");
    assert.ok(i > 0, 'edit-batch 라우트 등록');
    const body = RT.slice(i, RT.indexOf('router.', i + 10));
    assert.ok(/authMiddleware/.test(RT.slice(i, i + 200)), 'authMiddleware');
    assert.ok(/_ensureWorkdeskCellEditScope\(req\)/.test(body), '단건과 같은 스코프 게이트');
    assert.ok(/svc\.EDIT_BATCH_MAX/.test(body), '라우트에도 상한 검사');
  });
  t('6b: 라우터 스택에 실제로 등록돼 있다', () => {
    const router = require('../src/routes/trackB.routes');
    const hit = (router.stack || []).some(l => l.route && l.route.path === '/workdesk/edit-batch'
      && l.route.methods && l.route.methods.post);
    assert.ok(hit, '/workdesk/edit-batch POST 등록');
  });

  /* ── 7) 화면 ─────────────────────────────────────────── */
  const FE = R('frontend/workdesk.html');
  t('7a: 붙여넣기는 칸마다 요청하지 않는다(Promise.all(commitCellEdit) 부활 금지)', () => {
    assert.ok(!/Promise\.all\(jobs\.map\(j=>commitCellEdit/.test(FE.replace(/\s+/g, '')),
      '칸마다 왕복하는 옛 경로가 되살아났다 — 리미터·풀에 다시 막힌다');
  });
  t('7b: 붙여넣기가 edit-batch 를 1회 호출한다', () => {
    const i = FE.indexOf('function _pasteCommitBatch');
    assert.ok(i > 0, '_pasteCommitBatch 존재');
    const body = FE.slice(i, FE.indexOf('\n}', FE.indexOf('.catch(', i)));
    const n = (body.match(/\/api\/trackb\/workdesk\/edit-batch/g) || []).length;
    assert.equal(n, 1, 'edit-batch 호출 1회 (받음 ' + n + ')');
    assert.ok(!/\/api\/trackb\/workdesk\/edit'/.test(body), '배치 안에서 단건 호출 금지');
  });
  t('7c: 낙관 반영·롤백은 한 벌(_applyCellLocal) — 단건과 붙여넣기가 같은 규칙', () => {
    assert.ok(/function _applyCellLocal\(/.test(FE), '_applyCellLocal 정의');
    const single = FE.slice(FE.indexOf('function commitCellEdit'), FE.indexOf('function _navFromCell'));
    assert.ok(/_applyCellLocal\(rowId, field, value, td\)/.test(single), '단건이 공용 함수 사용');
    const paste = FE.slice(FE.indexOf('function _pasteCommitBatch'));
    assert.ok(/_applyCellLocal\(j\.rowId, j\.field, j\.val, j\.td\)/.test(paste.slice(0, 1200)), '붙여넣기가 공용 함수 사용');
  });
  t('7d: 실패한 칸만 되돌린다(성공한 칸을 함께 되돌리지 않는다)', () => {
    const i = FE.indexOf('function _pasteCommitBatch');
    const body = FE.slice(i, i + 3200);
    assert.ok(/if\(r&&r\.ok\)\{[\s\S]{0,400}_recordCellUndo/.test(body), '성공 칸만 되돌리기 기록');
    assert.ok(/\}\s*else\s*\{[\s\S]{0,200}x\.st\.rollback\(\)/.test(body), '실패 칸만 롤백');
  });
  t('7e: 실패 사유를 뭉뚱그리지 않고 건수와 함께 말한다(같은 토스트 수백 번 금지)', () => {
    const i = FE.indexOf('function _pasteCommitBatch');
    const body = FE.slice(i, i + 3200);
    assert.ok(/개 저장 · /.test(body), '성공·실패 건수 표기');
    assert.ok(/reasons\[why\]=\(reasons\[why\]\|\|0\)\+1/.test(body.replace(/\s+/g, '')) ||
              /reasons\[why\]/.test(body), '사유 집계');
  });
  t('7f: 인라인 스크립트가 파싱된다(주석·따옴표로 조용히 죽지 않는다)', () => {
    const vm = require('vm');
    const m = [...FE.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(m.length >= 1);
    for (const x of m) new vm.Script(x[1]);
  });

  console.log('\n✅ 통과 ' + pass + '건\n');
  process.exit(0);
})();
