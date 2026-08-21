/**
 * orphanCaptureCleanup.test.js — 회귀가드: 고아 캡처 자동 정리 (A종류: 링크 끊김)
 * 실행: node tests/orphanCaptureCleanup.test.js
 *
 * 왜: 행 삭제·구매기록 취소도, 작업 통째 삭제도 Drive 파일을 건드리지 않아 고아 캡처가
 *   계속 쌓였고 치우는 자동 경로가 없었다. 자동으로 **파일을 지우는** 기능이므로
 *   "무엇을 지우지 않는가"를 코드보다 강하게 고정한다.
 *
 * 고정하는 것:
 *  A. 판정 근거는 **file_id / review_index_id 뿐** — 위치키(row_index)를 근거로 쓰지 않는다
 *  B. **미리보기 기본** — dryRun 이면 Drive·DB 쓰기 0
 *  C. 후보 교집합 — 화면이 보낸 fileIds 라도 후보 밖이면 절대 안 지운다
 *  D. **TOCTOU 재검사** — 휴지통 직전에 그 한 건을 다시 확인, 조건이 풀렸으면 건너뛴다
 *  E. **휴지통만** — 영구삭제(files.delete) 호출 표면이 없다
 *  F. 원장 표기는 휴지통 성공 뒤에만 · fileRoute 와 같은 칸(slot_key='trashed')
 *  G. 크론 배선 — 킬스위치·jobLock·유예·상한이 살아 있다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const S = require('../src/services/orphanCaptureCleanup.service');

/* ── 스텁 pool: 후보 조회 SQL 을 알아보고 지정한 행을 돌려준다 ── */
function makePool({ candidates = [], recheck = null } = {}) {
  const seen = [];
  let findCalls = 0;
  return {
    seen,
    get findCalls() { return findCalls; },
    writes: () => seen.filter(r => /^\s*(UPDATE|INSERT|DELETE)/i.test(r.q)),
    query: async (sql, params) => {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      seen.push({ q, params });
      if (/FROM review_submissions rs/.test(q)) {
        findCalls++;
        // oneFile = TOCTOU 재검사 경로(파라미터 3개)
        if (params && params.length === 3) {
          const list = recheck === null ? candidates : recheck;
          return { rows: list.filter(r => r.fileId === params[2]) };
        }
        return { rows: candidates };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}
function makeDrive({ fail = false } = {}) {
  const trashed = [];
  return {
    trashed,
    trashFiles: async (files) => {
      if (fail) return { success: 0, failed: files.length, errors: [{ error: 'boom' }] };
      files.forEach(f => trashed.push(f.id));
      return { success: files.length, failed: 0, errors: [] };
    },
  };
}
const C = (fileId, extra = {}) => Object.assign({
  fileId, fileName: fileId + '.jpg', sheetId: 'wt_x', tabName: '탭', rowIndex: 3,
  reviewerName: '홍길동', slotKey: 'review', uploadedAt: '2026-01-01T00:00:00Z',
  reason: 'order_canceled',
}, extra);

(async () => {
  console.log('\n[A] 판정 근거 — 위치키(row_index) 금지');
  const src = read('src/services/orphanCaptureCleanup.service.js');
  {
    // 후보 SQL 안에서 row_index 가 쓰이는 자리는 ① SELECT 표시용 ② 활성 줄 **제외** 조건뿐.
    // 고아 "근거"(OR 블록) 안에 row_index 가 들어오면 위치키 판정이 부활한 것이다.
    const orBlock = src.slice(src.indexOf('AND (\n'), src.indexOf('AND NOT EXISTS (SELECT 1 FROM order_submissions ol'));
    ok('고아 근거 블록에 row_index 가 없다', !/row_index/.test(orBlock), orBlock.slice(0, 200));
    ok('고아 근거는 capture_file_id 와 review_index_id 둘뿐',
      /capture_file_id/.test(orBlock) && /review_index_id/.test(orBlock));
    ok('review_index_id 가 NULL 인 행은 근거로 쓰지 않는다',
      /rs\.review_index_id IS NOT NULL/.test(orBlock));
  }
  {
    const pool = makePool({ candidates: [C('f1')] });
    S.__setPoolForTest(pool);
    const r = await S.findOrphanCaptures({});
    ok('후보 조회는 읽기 전용(쓰기 쿼리 0)', pool.writes().length === 0);
    ok('유예 일수를 파라미터로 넘긴다', String(pool.seen[0].params[0]) === '7');
    ok('기본 유예 = 7일', r.graceDays === 7);
  }

  console.log('\n[B] 미리보기 기본 — 쓰기 0');
  {
    const pool = makePool({ candidates: [C('f1'), C('f2')] });
    const drive = makeDrive();
    S.__setPoolForTest(pool); S.__setDriveForTest(drive);
    const r = await S.trashOrphanCaptures({});   // 인자 없음 = dryRun 기본
    ok('인자 없이 부르면 dryRun', r.dryRun === true);
    ok('dryRun 이면 Drive 휴지통 호출 0', drive.trashed.length === 0);
    ok('dryRun 이면 DB 쓰기 0', pool.writes().length === 0);
    ok('dryRun 도 후보는 그대로 보고한다', r.total === 2);
  }

  console.log('\n[C] 후보 교집합 — 화면 목록 불신');
  {
    const pool = makePool({ candidates: [C('f1')] });
    const drive = makeDrive();
    S.__setPoolForTest(pool); S.__setDriveForTest(drive);
    const r = await S.trashOrphanCaptures({ dryRun: false, fileIds: ['f1', 'NOT_A_CANDIDATE'] });
    ok('후보 밖 파일은 지우지 않는다', !drive.trashed.includes('NOT_A_CANDIDATE'));
    ok('후보 안 파일만 지운다', drive.trashed.length === 1 && drive.trashed[0] === 'f1');
    ok('처리 건수를 사실대로 보고', r.trashed === 1);
  }
  {
    const pool = makePool({ candidates: [C('f1')] });
    const drive = makeDrive();
    S.__setPoolForTest(pool); S.__setDriveForTest(drive);
    const r = await S.trashOrphanCaptures({ dryRun: false, fileIds: ['NOPE'] });
    ok('교집합이 비면 아무것도 안 지운다', drive.trashed.length === 0 && r.trashed === 0);
  }

  console.log('\n[D] TOCTOU 재검사');
  {
    // 조회 때는 후보였는데, 휴지통 직전 재확인에서 조건이 풀린(다시 쓰이기 시작한) 경우
    const pool = makePool({ candidates: [C('f1')], recheck: [] });
    const drive = makeDrive();
    S.__setPoolForTest(pool); S.__setDriveForTest(drive);
    const r = await S.trashOrphanCaptures({ dryRun: false });
    ok('재검사에서 빠지면 휴지통으로 보내지 않는다', drive.trashed.length === 0);
    ok('건너뛴 건수를 보고한다(조용한 no-op 금지)', r.skippedRecheck === 1 && r.trashed === 0);
    ok('재검사는 파일 단위로 다시 조회한다', pool.findCalls >= 2);
  }

  console.log('\n[E] 휴지통만 — 영구삭제 표면 없음');
  {
    ok('files.delete 호출이 없다', !/files\.delete/.test(src));
    ok('trashFiles 만 쓴다', /trashFiles/.test(src));
    ok('폴더 스캔(B종류)을 하지 않는다 — DB 기준만',
      !/listFolderFilesRecursive|listFolderContents/.test(src));
  }

  console.log('\n[F] 원장 표기 — 휴지통 성공 뒤에만 · fileRoute 와 같은 칸');
  {
    const pool = makePool({ candidates: [C('f1')] });
    const drive = makeDrive({ fail: true });
    S.__setPoolForTest(pool); S.__setDriveForTest(drive);
    const r = await S.trashOrphanCaptures({ dryRun: false });
    ok('휴지통 실패면 원장을 고치지 않는다', pool.writes().length === 0);
    ok('실패 건수를 보고한다', r.failed === 1 && r.trashed === 0);
  }
  {
    const pool = makePool({ candidates: [C('f1')] });
    const drive = makeDrive();
    S.__setPoolForTest(pool); S.__setDriveForTest(drive);
    await S.trashOrphanCaptures({ dryRun: false, by: '망고' });
    const w = pool.writes();
    ok('성공하면 원장 1건 갱신', w.length === 1);
    ok("slot_key='trashed' 로 표기(fileRoute 와 같은 칸)", /slot_key = 'trashed'/.test(w[0].q));
    ok('routed_from_slot 을 보존해 되돌릴 수 있다', /routed_from_slot = COALESCE\(routed_from_slot, slot_key\)/.test(w[0].q));
    ok('감사 표기에 주체가 남는다', String(w[0].params[1]).startsWith('orphan:'));
  }

  console.log('\n[G] 크론 배선');
  {
    const cron = read('src/jobs/cron.js');
    ok('킬스위치 ORPHAN_CAPTURE_CLEAN', /ORPHAN_CAPTURE_CLEAN !== '0'/.test(cron));
    ok('jobLock 으로 직렬화', /withJobLock\('orphan_capture_clean'/.test(cron));
    ok('크론은 실행 모드로 부른다', /trashOrphanCaptures\(\{ dryRun: false, by: 'cron' \}\)/.test(cron));
    ok('정리 실패가 크론을 죽이지 않는다', /\[CRON-OrphanCapture\] error/.test(cron));
    const svc = src;
    ok('유예는 env 로 조절 가능', /ORPHAN_CAPTURE_GRACE_DAYS/.test(svc));
    ok('한 회차 상한이 있다(폭발반경 제한)', /ORPHAN_CAPTURE_CLEAN_CAP/.test(svc));
  }
  {
    const routes = read('src/routes/drive.routes.js');
    ok('수동 창구는 adminOrMaster 전용',
      /'\/orphan-capture-cleanup', authMiddleware, adminOrMasterMiddleware/.test(routes));
    ok('수동 창구도 미리보기 기본', /dryRun: dryRun !== false/.test(routes));
    ok('수동 창구는 크론과 같은 함수를 쓴다(사본 금지)', /trashOrphanCaptures/.test(routes));
  }

  console.log(`\n✅ orphanCaptureCleanup: ${passed} checks passed\n`);
})().catch(err => { console.error('\n❌ ' + err.message + '\n'); process.exit(1); });
