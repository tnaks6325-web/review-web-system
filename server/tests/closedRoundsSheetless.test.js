/**
 * closedRoundsSheetless.test.js — 회귀가드: 차수 마감·아카이브를 무시트 장부에도 집행 (2026-08-24)
 * 실행: node tests/closedRoundsSheetless.test.js
 *
 * 왜: 차수 마감(`tab_configs.closed_rounds`, 010)·아카이브(`archived_rounds`, 012)는
 *   **시트 경로(indexBuilder)에만** 집행돼 있었다. 무시트 장부 재생성(`rebuildLedgers`)은
 *   `review_index` 를 통째로 지우고 **활성 줄 전부를 다시 넣으면서** 그 두 칸을 한 번도
 *   읽지 않았다 → 무시트 작업에서 차수를 아카이브하면 화면은 성공했다고 말하고 다음
 *   재생성이 그대로 되살렸다(조용한 no-op). 2026-08-07 쿠팡 50→216명과 같은 메커니즘.
 *   `archive.routes` 에 무시트 제외 필터가 없어 목록에 뜨고 눌리기까지 했다.
 *
 * 고정하는 것:
 *  A. 판정·집행은 `closedRounds.service` **단일 출처** — 두 경로가 같은 함수를 쓴다(사본 금지)
 *  B. 제외 집합 = closed_rounds ∪ archived_rounds · 공백/빈 값 정리
 *  C. ★★ 순서 계약 — **아카이브로 옮긴 뒤** review_index 를 지운다(반대면 기록이 증발)
 *  D. 제외 차수는 재삽입하지 않는다 · **집계도 같은 목록에서** 센다(조용한 불일치 금지)
 *  E. 못 읽으면 제외 없음(fail-open) — 명단에서 사람을 빼는 쪽으로 접지 않는다
 *  F. 기록은 지우지 않는다 — `review_index_archive` 로 **옮긴다**
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const CR = require('../src/services/closedRounds.service');

(async () => {
  console.log('\n[B] 제외 집합 판정');
  {
    ok('closed ∪ archived', JSON.stringify(CR.excludedRounds({ closed_rounds: '1차,2차', archived_rounds: '2차,3차' }))
      === JSON.stringify(['1차', '2차', '3차']));
    ok('공백·빈 값 정리', JSON.stringify(CR.excludedRounds({ closed_rounds: ' 1차 , ,2차,' })) === JSON.stringify(['1차', '2차']));
    ok('둘 다 비면 빈 배열', CR.excludedRounds({}).length === 0 && CR.excludedRounds(null).length === 0);
    ok('필터는 제외 차수 행만 뺀다', JSON.stringify(
      CR.filterRows([{ round: '1차' }, { round: '2차' }, { round: null }], ['1차']).map(r => r.round))
      === JSON.stringify(['2차', null]));
    ok('제외가 없으면 원본 그대로', CR.filterRows([{ round: '1차' }], []).length === 1);
  }

  console.log('\n[E] ★ 조회 실패는 제외 없음(fail-open)');
  {
    CR.__setPoolForTest({ query: async () => { throw new Error('boom'); } });
    ok('DB 오류면 빈 배열 — 명단에서 사람을 빼지 않는다',
      (await CR.loadExcludedRounds({ sheetId: 's', tabName: 't' })).length === 0);
    CR.__setPoolForTest({ query: async () => ({ rows: [] }) });
    ok('탭 설정이 없으면 빈 배열', (await CR.loadExcludedRounds({ sheetId: 's', tabName: 't' })).length === 0);
    CR.__setPoolForTest(null);
  }

  console.log('\n[F] 기록은 옮긴다 — 지우지 않는다');
  {
    const seen = [];
    const db = { query: async (sql, p) => { seen.push({ q: String(sql).replace(/\s+/g, ' '), p }); return { rowCount: 2 }; } };
    const r = await CR.archiveExcludedRounds({ sheetId: 's1', tabName: 't1', exclude: ['1차'], db, by: 'test' });
    ok('INSERT ... review_index_archive 먼저', /INSERT INTO review_index_archive/.test(seen[0].q));
    ok('그 다음 원본 DELETE', /DELETE FROM review_index /.test(seen[1].q));
    ok('★ 순서가 계약 — 옮기기가 지우기보다 앞', seen.findIndex(x => /INSERT INTO review_index_archive/.test(x.q))
      < seen.findIndex(x => /DELETE FROM review_index /.test(x.q)));
    ok('이미 아카이브된 행은 다시 안 넣는다(NOT EXISTS)', /NOT EXISTS/.test(seen[0].q));
    ok('건수를 사실대로 보고', r.moved === 2 && r.deleted === 2 && r.failed === 0);
    ok('★ 구매기록·작업표는 사정거리 밖',
      !seen.some(x => /order_submissions|campaign_participants/.test(x.q)));
  }
  {
    const db = { query: async (sql) => { if (/INSERT INTO review_index_archive/.test(sql)) throw new Error('nope'); return { rowCount: 9 }; } };
    const r = await CR.archiveExcludedRounds({ sheetId: 's1', tabName: 't1', exclude: ['1차'], db });
    ok('★ 옮기기가 실패하면 지우지도 않는다(원장 없는 실종 금지)', r.deleted === 0 && r.failed === 1);
  }

  console.log('\n[A] 단일 출처 — 두 경로가 같은 함수를 쓴다');
  {
    const ib = read('src/services/indexBuilder.service.js');
    const sl = read('src/services/sheetlessLedger.service.js');
    ok('시트 경로가 공용 서비스를 쓴다', /closedRounds\.service/.test(ib) && /_cr\.filterRows/.test(ib));
    ok('★ 시트 경로에 인라인 사본이 없다(아카이브 SQL 이관 완료)',
      !/INSERT INTO review_index_archive[\s\S]{0,400}ri\.round/.test(ib));
    ok('무시트 경로가 같은 서비스를 쓴다', /closedRounds\.service/.test(sl));
    ok('★ 무시트 게이트 조회가 두 칸을 읽는다', /closed_rounds, archived_rounds\s*\n\s*FROM tab_configs/.test(sl));
  }

  console.log('\n[C][D] 무시트 재생성 — 순서·재삽입·집계');
  {
    const sl = read('src/services/sheetlessLedger.service.js');
    const iArch = sl.indexOf('archiveExcludedRounds({');
    const iDel = sl.indexOf("DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2");
    ok('★★ 아카이브 이동이 review_index 삭제보다 앞', iArch > 0 && iDel > 0 && iArch < iDel);
    ok('★ 같은 트랜잭션(client)에서 돈다', /archiveExcludedRounds\(\{[\s\S]{0,120}db: client/.test(sl));
    ok('★ 제외 차수는 재삽입하지 않는다(필터된 목록으로 루프)', /for \(const r of indexed\)/.test(sl));
    ok('★★ 집계도 같은 목록에서 센다(parsed.length 보고 금지)',
      /indexRows: indexed\.length/.test(sl) && !/indexRows: parsed\.length/.test(sl));
    ok('★ 제출 집계도 같은 목록', /const submittedCount = indexed\.filter/.test(sl));
    ok('★ 제외된 건수를 조용히 넘기지 않고 보고한다',
      /excludedRows: excludedCount/.test(sl) && /excludedRounds: excludeRounds/.test(sl));
  }

  console.log(`\n✅ closedRoundsSheetless: ${passed} checks passed\n`);
})().catch(err => { console.error('\n❌ ' + err.message + '\n'); process.exit(1); });
