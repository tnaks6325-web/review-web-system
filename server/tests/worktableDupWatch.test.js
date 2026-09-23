/**
 * worktableDupWatch.test.js — 회귀가드: 작업표 중복 줄 감시망 (2026-08-19)
 * 실행: node tests/worktableDupWatch.test.js
 *
 * 왜: 같은 구매가 표에 여러 줄로 늘어난 사고를 **아무도 몰랐다**(사람이 우연히 발견).
 *   기록 경로의 2차 중복 판정이 최종 방어지만, 그것이 또 뚫려도 알 길이 없는 상태를 없앤다.
 *
 * 고정하는 것:
 *  A. 판정 키는 **표 주문번호(공유 조각) + 명의(phone8)** — 사본 금지
 *  B. **읽기 전용** — 줄·주문에 쓰기 0
 *  C. 무시트 탭만 · 모르는 것(번호 6자리 미만·명의 없음)은 세지 않는다
 *  D. **늑대소년 방지** — 직전과 같으면 알리지 않는다, 줄이 하나라도 늘면 다시 알린다
 *  E. 크론은 감시망 실패로 죽지 않는다 · 조회 라우트는 스냅샷을 갱신하지 않는다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const W = require('../src/services/worktableDupWatch.service');

/* ── 스텁 pool: SQL 조각으로 분기. 더 좁은 조건을 먼저(스텁 매칭 순서 함정). ── */
function makePool({ groups = [], snapshot = null, scanThrows = false } = {}) {
  const seen = [];
  return {
    seen,
    query: async (sql, params) => {
      const q = String(sql).replace(/\s+/g, ' ');
      seen.push({ q, params });
      if (/INSERT INTO app_settings/.test(q)) return { rows: [] };
      if (/FROM app_settings/.test(q)) return { rows: snapshot ? [{ value: JSON.stringify(snapshot) }] : [] };
      if (/FROM campaign_participants/.test(q)) {
        if (scanThrows) throw new Error('boom');
        return { rows: groups };
      }
      return { rows: [] };
    },
  };
}
const G = (tabName, orderNum, phone8, rows, seqs) =>
  ({ sheetId: 's1', tabName, orderNum, phone8, rows, seqs, name: '홍길동' });

(async () => {
  console.log('\n[A] 판정 키 — 공유 조각 + 명의(사본 금지)');
  {
    const src = read('src/services/worktableDupWatch.service.js');
    ok('표 주문번호는 공유 조각을 쓴다', /tableOrderNumSql\('cp'\)/.test(src));
    ok('인라인 사본이 없다', !/jsonb_each_text\(COALESCE\(cp\.row_json/.test(src));
    ok('명의(phone8)로도 묶는다', /GROUP BY 1, 2, 3, 4/.test(src) && /cp\.phone8/.test(src));
    ok('최소 자릿수도 공유 상수', /MIN_ORDER_NUM_DIGITS/.test(src));
  }

  console.log('\n[B] 읽기 전용 — 줄·주문에 쓰기 0');
  {
    const src = read('src/services/worktableDupWatch.service.js');
    ok('campaign_participants 쓰기 없음', !/(UPDATE|DELETE FROM|INSERT INTO)\s+campaign_participants/.test(src));
    ok('order_submissions 쓰기 없음', !/(UPDATE|DELETE FROM|INSERT INTO)\s+order_submissions/.test(src));
    ok('쓰기는 app_settings 스냅샷 한 곳뿐', (src.match(/INSERT INTO |UPDATE [a-z_]+ SET/g) || []).length === 1);
  }

  console.log('\n[C] 대상 범위 — 무시트 탭 · 아는 것만');
  {
    const src = read('src/services/worktableDupWatch.service.js');
    ok('무시트 탭만', /COALESCE\(tc\.sheetless, FALSE\) = TRUE/.test(src));
    ok('삭제된 줄은 세지 않는다', /cp\.deleted_at IS NULL/.test(src));
    ok('명의 없는 줄은 세지 않는다', /length\(COALESCE\(cp\.phone8, ''\)\) >= 8/.test(src));
    ok('판정 불가 번호는 세지 않는다', />= \$2/.test(src));
  }

  console.log('\n[D] 늑대소년 방지 — 달라졌을 때만 알린다');
  {
    const rows = [G('탭A', '1234567890', '11112222', 3, [10, 20, 30])];
    // ① 처음 발견 → 알림
    const p1 = makePool({ groups: rows });
    W.__setPoolForTest(p1);
    const r1 = await W.watchDuplicateRows({ by: 't' });
    W.__setPoolForTest(null);
    ok('처음 발견하면 알린다', r1.alerted === true && r1.groupCount === 1, JSON.stringify(r1));
    ok('군더더기 줄 수 = 줄수 − 1', r1.extraRows === 2);
    ok('스냅샷을 남긴다', p1.seen.some(c => /INSERT INTO app_settings/.test(c.q)));

    // ② 같은 상태 → 알리지 않는다
    const snap = { fingerprint: W.fingerprint(rows) };
    const p2 = makePool({ groups: rows, snapshot: snap });
    W.__setPoolForTest(p2);
    const r2 = await W.watchDuplicateRows({ by: 't' });
    W.__setPoolForTest(null);
    ok('★ 직전과 같으면 알리지 않는다', r2.alerted === false && r2.changed === false, JSON.stringify(r2));
    ok('그래도 현황은 돌려준다', r2.groupCount === 1);

    // ③ 줄이 하나 늘면 다시 알린다
    const p3 = makePool({ groups: [G('탭A', '1234567890', '11112222', 4, [10, 20, 30, 40])], snapshot: snap });
    W.__setPoolForTest(p3);
    const r3 = await W.watchDuplicateRows({ by: 't' });
    W.__setPoolForTest(null);
    ok('★ 줄이 하나라도 늘면 다시 알린다', r3.alerted === true, JSON.stringify(r3));

    // ④ 중복이 사라지면 알릴 것이 없다
    const p4 = makePool({ groups: [], snapshot: snap });
    W.__setPoolForTest(p4);
    const r4 = await W.watchDuplicateRows({ by: 't' });
    W.__setPoolForTest(null);
    ok('중복 0건이면 알리지 않는다', r4.alerted === false && r4.groupCount === 0);

    // ⑤ 스냅샷을 못 읽으면 알린다(놓치는 쪽보다 한 번 더)
    const p5 = makePool({ groups: rows });
    p5.query = (sql, params) => (/FROM app_settings/.test(String(sql)) && !/INSERT/.test(String(sql)))
      ? Promise.reject(new Error('read fail'))
      : makePool({ groups: rows }).query(sql, params);
    W.__setPoolForTest(p5);
    const r5 = await W.watchDuplicateRows({ by: 't' });
    W.__setPoolForTest(null);
    ok('스냅샷 조회 실패는 알리는 쪽으로', r5.alerted === true);
  }

  console.log('\n[E] 실패해도 죽지 않는다 · 조회는 스냅샷을 건드리지 않는다');
  {
    const p = makePool({ scanThrows: true });
    W.__setPoolForTest(p);
    const r = await W.watchDuplicateRows({ by: 't' });
    W.__setPoolForTest(null);
    ok('조회 실패는 throw 하지 않고 사유를 돌려준다', r.ok === false && r.reason === 'scan_failed');

    const p2 = makePool({ groups: [G('탭A', '1234567890', '11112222', 2, [1, 2])] });
    W.__setPoolForTest(p2);
    await W.watchDuplicateRows({ by: 'admin', record: false });
    W.__setPoolForTest(null);
    ok('★ record:false 면 스냅샷을 갱신하지 않는다', !p2.seen.some(c => /INSERT INTO app_settings/.test(c.q)));
  }

  console.log('\n[F] 배선 — 크론 · 라우트');
  {
    const cron = read('src/jobs/cron.js');
    ok('크론에 등록', /worktableDupWatch\.service/.test(cron) && /watchDuplicateRows/.test(cron));
    ok('잡 락으로 인스턴스 직렬화', /withJobLock\('worktable_dup_watch'/.test(cron));
    ok('킬스위치', /WORKTABLE_DUP_WATCH !== '0'/.test(cron));
    ok('★ 크론은 감시망 실패로 죽지 않는다', /\[CRON-DupWatch\] error/.test(cron));

    const routes = read('src/routes/trackB.routes.js');
    ok('조회 라우트 등록', /'\/worktable\/dup-watch'/.test(routes));
    ok('게이트 = adminOrMaster', /'\/worktable\/dup-watch', authMiddleware, adminOrMasterMiddleware/.test(routes));
    ok('★ 라우트는 record:false', /watchDuplicateRows\(\{ by: _by\(req\), record: false \}\)/.test(routes));

    // 라우터 스택 실검사 — 문자열이 아니라 실제 등록 여부
    const layers = require('../src/routes/trackB.routes').stack || [];
    const hit = layers.filter(l => l.route && l.route.path === '/worktable/dup-watch');
    ok('라우터 스택에 실제로 있다', hit.length === 1, '등록 ' + hit.length + '개');
    ok('POST 로 등록', hit.length === 1 && !!hit[0].route.methods.post);
  }

  console.log('\n통과: ' + passed + '건');
  process.exit(0);
})().catch(e => { console.error('\n✗ ' + e.message); process.exit(1); });
