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
// ★ 캐시·커넥션 단언을 정확히 세려면 동시 실행 폭이 정해져 있어야 한다.
//   상한이 실제로 지켜지는지는 아래 §8 에서 자식 프로세스로 따로 확인한다.
if (!process.env.EDIT_BATCH_CONCURRENCY) process.env.EDIT_BATCH_CONCURRENCY = '1';
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
  t('1a: 25칸 배치의 커넥션은 칸 수와 무관하게 상한 안이다(풀 고갈 차단)', () => {
    assert.ok(out1.ok, '배치 성공');
    assert.equal(out1.total, 25); assert.equal(out1.succeeded, 25); assert.equal(out1.failed, 0);
    // ★ 옛 경로는 칸마다 커넥션을 잡아 500칸에 419건이 커넥션 타임아웃으로 죽었다.
    //   여기서 고정하는 것은 "1개"가 아니라 **칸 수에 비례하지 않는다**는 성질이다.
    assert.ok(p1.connects <= svc.EDIT_BATCH_CONCURRENCY,
      '커넥션 ≤ 동시 실행 상한 (받음 ' + p1.connects + ' / 상한 ' + svc.EDIT_BATCH_CONCURRENCY + ')');
    assert.ok(p1.connects < 25, '칸 수만큼 잡으면 안 된다 (받음 ' + p1.connects + ')');
    assert.equal(p1.connects, 1, '동시 1 이면 커넥션도 1개');
    assert.equal(p1.released, p1.connects, '잡은 만큼 반납');
  });
  t('1a2: 동시 실행 상한이 풀(20)보다 충분히 작다 — 여러 명이 동시에 붙여넣어도 여유', () => {
    assert.ok(svc.EDIT_BATCH_CONCURRENCY >= 1 && svc.EDIT_BATCH_CONCURRENCY <= 16,
      '상한 범위 (받음 ' + svc.EDIT_BATCH_CONCURRENCY + ')');
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
  t('2a: decide 판정은 칸 수에 비례하지 않는다 — 칸마다 다시 묻지 않는다', () => {
    // 워커가 동시에 출발하면 첫 판정은 워커 수만큼 겹칠 수 있다(무해·멱등).
    // 고정하는 것은 "25칸이면 25번"이 아니라는 성질이다.
    const n = p1.q.filter(x => /FROM tab_configs tc/.test(x.s)).length;
    assert.equal(n, 1, '판정 쿼리 = 1회 (받음 ' + n + ')');
  });
  t('2a2: 헤더 조회(raw_sheet_tabs)도 칸 수에 비례하지 않는다', () => {
    const n = p1.q.filter(x => /FROM raw_sheet_tabs WHERE sheet_id/.test(x.s)).length;
    assert.equal(n, 1, '헤더 조회 = 1회 (받음 ' + n + ') — 칸마다 다시 읽으면 25회가 된다');
  });
  (async () => {})();
  const p2 = batchPool();
  svc.__setPoolForTest(p2);
  await svc.editWorkdeskRowsBatch({ sheetId: 's', tabName: 'T',
    edits: [...mk(5, 'col:비고'), ...mk(5, 'col:메모')] });
  t('2b: 열이 둘이면 판정도 둘 — 캐시 키에서 열이 빠지면 두 번째 열이 첫 열 판정을 쓴다', () => {
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
    // ★ 실행만 보면 _editOneInTx 자신의 ROLLBACK 이 대신 통과시킨다(변이시험 실측).
    //   그 ROLLBACK 이 실패했을 때의 백스톱이 배치 catch 안에 있어야 한다 — 코드 모양으로 고정.
    const B = stripLine(R('server/src/services/trackB.service.js'));
    const i = B.indexOf('async function editWorkdeskRowsBatch');
    const body = B.slice(i, B.indexOf('\n}\n', i));
    assert.ok(/catch \(err\) \{[\s\S]{0,300}client\.query\('ROLLBACK'\)/.test(body),
      '배치 catch 안에 ROLLBACK 백스톱이 있어야 한다');
  });
  t('3d: 빠진 인자는 쿼리 없이 그 칸만 거부한다', async () => {});
  const p4 = batchPool();
  svc.__setPoolForTest(p4);
  const out4 = await svc.editWorkdeskRowsBatch({ sheetId: 's', tabName: 'T',
    edits: [{ rowId: 'r0', field: 'col:비고', value: 'a' }, { rowId: '', field: 'col:비고', value: 'b' }] });
  t('3e: rowId 없는 칸은 거부되고 나머지는 저장된다', () => {
    assert.equal(out4.succeeded, 1); assert.equal(out4.failed, 1);
    assert.equal(p4.q.filter(x => /^BEGIN/.test(x.s)).length, 1, '거부된 칸은 tx 조차 열지 않는다');
    // ★ 사유를 뭉뚱그리지 않는다 — 배치가 선검사를 빼면 _editOneInTx 가 던져 'edit_failed' 로만 보인다
    //   (변이시험 실측: 건수만 세면 그 회귀를 통과시킨다). 화면이 "무엇이 잘못됐는지"를 말할 수 있어야 한다.
    assert.equal(out4.results[1].error, 'rowId, field 필수', '빠진 인자는 그 사유로 보고');
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
  t('4e: 한 요청에 담는 묶음은 서버 상한 이하 — 넘기면 그 요청이 통째로 거부된다', () => {
    const fe = R('frontend/workdesk.html');
    const m = fe.match(/_PASTE_CHUNK\s*=\s*(\d+)/);
    assert.ok(m, '_PASTE_CHUNK 선언');
    const c = Number(m[1]);
    assert.ok(c >= 1 && c <= svc.EDIT_BATCH_MAX, '묶음 크기 범위 (받음 ' + c + ')');
    assert.ok(c < Number(fe.match(/_PASTE_MAX\s*=\s*(\d+)/)[1]),
      '묶음이 전체 상한과 같으면 나눠 보내는 의미가 없다(게이트웨이 타임아웃 복원)');
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
    const all = FE.slice(i);
    assert.ok(/reasons\[w\]=\(reasons\[w\]\|\|0\)\+1/.test(all.replace(/\s+/g, '')), '사유를 건수로 집계');
  });
  t('7g: 묶음을 나눠 순차로 보낸다 — 실제 실행으로 요청 수와 크기를 센다', () => {
    // ★ 정적 검사만 하면 slice 의 상한을 지워도 통과한다(변이시험 실측). 돌려서 센다.
    const vm = require('vm');
    const grab = (name) => {
      const i = FE.indexOf('function ' + name + '(');
      assert.ok(i > 0, name + ' 정의');
      let d = 0, started = false;
      for (let k = i; k < FE.length; k++) {
        if (FE[k] === '{') { d++; started = true; }
        else if (FE[k] === '}') { d--; if (started && d === 0) return FE.slice(i, k + 1); }
      }
      throw new Error(name + ' 본문 경계');
    };
    const sent = [], toasts = [];
    const syncThen = v => ({ then(f) { const r = f ? f(v) : v; return (r && typeof r.then === 'function') ? r : syncThen(r); }, catch() { return this; } });
    const sandbox = {
      STATE: { cur: { sheetId: 's', tabName: 'T' } },
      toast: m => toasts.push(String(m)),
      _PASTE_CHUNK: 50,
      Promise: { resolve: v => syncThen(v) },
      _applyCellLocal: () => ({ had: false, prev: undefined, rollback() {} }),
      _recordCellUndo: () => {}, _finishCellUndoGroup: () => {}, _wtNotice: () => {},
      reloadWorkdesk: () => {}, setTimeout: () => 0, console,
      api: (url, opt) => {
        const body = JSON.parse(opt.body);
        sent.push(body.edits.length);
        return syncThen({ ok: true, total: body.edits.length, succeeded: body.edits.length, failed: 0,
                          results: body.edits.map((e, k) => ({ index: k, rowId: e.rowId, field: e.field, ok: true })) });
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(grab('_pasteCommitBatch'), sandbox);
    vm.runInContext(grab('_pasteApplyResults'), sandbox);
    sandbox.jobs = Array.from({ length: 120 }, (_, k) => ({ rowId: 'r' + k, field: 'col:비고', val: 'v' + k, td: null }));
    vm.runInContext('_pasteCommitBatch(jobs, {kind:"paste",entries:[],pending:0}, 0)', sandbox);
    assert.equal(sent.length, 3, '120칸 = 50+50+20 → 요청 3회 (받음 ' + sent.length + ')');
    assert.deepEqual(sent, [50, 50, 20], '묶음 크기 (받음 ' + JSON.stringify(sent) + ')');
    assert.ok(sent.every(n => n <= sandbox._PASTE_CHUNK), '어떤 요청도 묶음 상한을 넘지 않는다');
    assert.ok(toasts.some(x => /120개 칸 붙여넣음/.test(x)), '완료를 말한다 — ' + toasts.join('|'));
    assert.ok(toasts.some(x => /50 \/ 120/.test(x)), '진행을 말한다 — ' + toasts.join('|'));
  });
  t('7h: 중간에 끊겨도 이미 저장된 앞 묶음은 되돌리지 않는다(화면만 지우면 더 어긋난다)', () => {
    const i = FE.indexOf('function _pasteCommitBatch');
    const body = FE.slice(i, FE.indexOf('\nfunction _pasteApplyResults'));
    assert.ok(/aborted\s*=\s*true/.test(body), '중단 표시');
    assert.ok(/part\.forEach\(x=>x\.st\.rollback\(\)\)/.test(body), '그 묶음만 되돌린다');
    assert.ok(!/staged\.forEach\(x=>x\.st\.rollback\(\)\)/.test(body), '전체 롤백 금지(서버에 남은 값과 갈린다)');
    assert.ok(/개까지 저장됨/.test(body), '어디까지 저장됐는지 말한다');
  });
  t('7i: 진행 상황을 말한다(수백 칸이 조용히 멈춘 것처럼 보이지 않게)', () => {
    const i = FE.indexOf('function _pasteCommitBatch');
    const body = FE.slice(i, FE.indexOf('\nfunction _pasteApplyResults'));
    assert.ok(/done\+' \/ '\+staged\.length/.test(body), '진행 건수 표기');
  });
  t('7f: 인라인 스크립트가 파싱된다(주석·따옴표로 조용히 죽지 않는다)', () => {
    const vm = require('vm');
    const m = [...FE.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(m.length >= 1);
    for (const x of m) new vm.Script(x[1]);
  });

  /* ── 8) 동시 실행 상한이 실제로 지켜진다(자식 프로세스 — env 는 require 시점에 읽힌다) ── */
  t('8a: 동시 상한 6 이면 100칸이라도 커넥션은 6개 이하', () => {
    const { execFileSync } = require('child_process');
    const probe = `
      process.env.SHEETLESS_CELL_WRITE='allow'; process.env.EDIT_BATCH_CONCURRENCY='6';
      const svc=require('${path.join(ROOT, 'server/src/services/trackB.service.js').replace(/\\/g, '/')}');
      let connects=0, released=0, live=0, peak=0;
      const client={ async query(sql,params){ const s=String(sql).replace(/\\s+/g,' ').trim();
        if(/^BEGIN|^ROLLBACK|^COMMIT/.test(s)) return {rows:[]};
        if(/FROM campaign_participants WHERE id=\\$1 .* FOR UPDATE/.test(s)) return {rows:[{id:params[0],seq:7,source:'import',order_submission_id:null,identity_key:'k'+params[0],phone8:'1',recipient_name:null,option_text:null,row_json:{'비고':'v'},tab_gid:'1'}]};
        if(/COUNT\\(\\*\\)::int AS n/.test(s)) return {rows:[{n:1}]};
        if(/FROM raw_sheet_tabs WHERE sheet_id/.test(s)) return {rows:[{detected_headers:['비고']}]};
        if(/FROM tab_configs tc/.test(s)) return {rows:[{sheetless:true,gid:'1',dh:['비고']}]};
        if(/INSERT INTO participant_edits/.test(s)) return {rows:[{id:1}]};
        if(/UPDATE /.test(s)) return {rows:[],rowCount:1};
        return {rows:[]}; }, release(){ released++; live--; } };
      svc.__setPoolForTest({ async connect(){ connects++; live++; if(live>peak) peak=live; return client; },
                             async query(s,p){ return client.query(s,p); } });
      const edits=Array.from({length:100},(_,i)=>({rowId:'r'+i,field:'col:비고',value:'v'+i}));
      svc.editWorkdeskRowsBatch({sheetId:'s',tabName:'T',edits}).then(o=>{
        console.log(JSON.stringify({conc:svc.EDIT_BATCH_CONCURRENCY,connects,peak,released,ok:o.succeeded}));
        process.exit(0);
      });`;
    const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', cwd: path.join(ROOT, 'server') });
    const j = JSON.parse(out.trim().split('\n').pop());
    assert.equal(j.conc, 6, 'env 로 동시 상한 조절 (받음 ' + j.conc + ')');
    assert.ok(j.peak <= 6, '동시에 잡은 커넥션 ≤ 6 (받음 ' + j.peak + ')');
    assert.ok(j.connects <= 6, '총 커넥션 ≤ 6 (받음 ' + j.connects + ') — 100칸이어도 칸 수에 비례하지 않는다');
    assert.equal(j.released, j.connects, '잡은 만큼 반납(누수 0)');
    assert.equal(j.ok, 100, '100칸 전부 저장');
  });

  console.log('\n✅ 통과 ' + pass + '건\n');
  process.exit(0);
})();
