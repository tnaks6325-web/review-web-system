/**
 * orphanCaptureCleanup.test.js — 회귀가드: 고아 캡처 정리 (A 자동 · B·C 수동)
 * 실행: node tests/orphanCaptureCleanup.test.js
 *
 * 왜: 행 삭제·구매기록 취소도, 작업 통째 삭제도 Drive 파일을 건드리지 않아 고아 캡처가
 *   계속 쌓였고 치우는 자동 경로가 없었다. 자동으로 **파일을 지우는** 기능이므로
 *   "무엇을 지우지 않는가"를 코드보다 강하게 고정한다.
 *
 * 고아 캡처 세 종류 (2026-08-21 기준 확정 · 2026-08-24 B·C 구현):
 *   A 링크 끊김  — 원장은 살아 있는데 그 칸이 파일을 더는 안 가리킨다  → **크론 자동**
 *   B 원장 없음  — Drive 에는 있는데 원장 어디에서도 안 가리킨다        → **사람 수동**
 *   C 작업 소멸  — 작업이 통째로 지워져 원장 자체가 없어졌다(묘비 134)  → **사람 수동**
 *
 * 고정하는 것:
 *  A. 판정 근거는 **file_id / review_index_id 뿐** — 위치키(row_index)를 근거로 쓰지 않는다
 *  B. **미리보기 기본** — dryRun 이면 Drive·DB 쓰기 0
 *  C. 후보 교집합 — 화면이 보낸 fileIds 라도 후보 밖이면 절대 안 지운다
 *  D. **TOCTOU 재검사** — 휴지통 직전에 그 한 건을 다시 확인, 조건이 풀렸으면 건너뛴다
 *  E. **휴지통만** — 영구삭제(files.delete) 호출 표면이 없다 · 폴더 스캔은 B 전용
 *  F. 원장 표기는 휴지통 성공 뒤에만 · fileRoute 와 같은 칸(slot_key='trashed')
 *  G. 크론 배선 — 킬스위치·jobLock·유예·상한이 살아 있다
 *  H. C종류 — ★★ 묘비 기록이 **삭제보다 앞** · 실패해도 삭제는 계속(fail-soft)
 *  I. B종류 — ★★★ `fileIds` 없이는 **한 건도 안 지운다**(일괄 삭제 표면 없음)
 *  J. 크론은 **A만** 돈다 — B·C 는 사람이 눌러야 움직인다
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
    /* 폴더 스캔은 **B종류 전용**이다(2026-08-24 B·C 추가).
       A(자동·크론)는 여전히 DB 기준만 — A 경로 본문에 폴더 목록 호출이 새면
       크론이 원장 밖 파일까지 지우기 시작한다. 그래서 "없다"가 아니라
       "B 함수 안에만 있다"로 고정한다. */
    const aPath = src.slice(src.indexOf('async function findOrphanCaptures'),
      src.indexOf('async function findTombstonedCaptures'));
    ok('★★ A 경로(크론)는 폴더를 스캔하지 않는다 — DB 기준만',
      !/listFolderFilesRecursive|listFolderContents/.test(aPath));
    const bScan = src.slice(src.indexOf('async function scanFolderOrphans'),
      src.indexOf('async function _trashFiles'));
    ok('★ 폴더 스캔은 B 전용 함수 안에만 있다',
      /listFolderContents/.test(bScan)
      && src.split('listFolderContents').length - 1 === bScan.split('listFolderContents').length - 1);
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
    /* dryRun 은 종류가 셋으로 갈리면서 한 번만 계산해 세 갈래가 나눠 쓴다(2026-08-24).
       "명시적으로 dryRun:false 를 보내야만 실행" 이라는 계약 자체를 고정한다. */
    ok('수동 창구도 미리보기 기본(dryRun:false 를 명시해야만 실행)',
      /const dryRun = b\.dryRun !== false/.test(routes));
    ok('★ 세 종류가 같은 dryRun 을 쓴다(한쪽만 바로 실행되는 일 금지)',
      routes.split('dryRun, fileIds, by').length - 1 >= 1
      && /trashFolderOrphans\(\{[\s\S]{0,160}dryRun/.test(routes));
    ok('수동 창구는 크론과 같은 함수를 쓴다(사본 금지)', /trashOrphanCaptures/.test(routes));
  }


  console.log('\n[L] ★★★ 후보 SQL 의 표·칸이 실제로 존재하는가 (2026-08-24 실사고)');
  {
    /* ⚠ **왜 이 검사가 필요한가**: 이 파일의 다른 검사는 전부 **스텁 pool** 을 쓴다.
       스텁은 SQL 을 해석하지 않으므로 `campaign_participants.row_index` 처럼 **없는 칸**을
       적어도 전부 초록이었다 — 그래서 A종류 자동 청소가 배포 뒤 본섭에서 매번
       `column cp.row_index does not exist` 로 죽고 있었다(실측). 크론은 오류를 삼켜
       조용히 아무 일도 안 했고, 화면 창구는 "서버 오류"만 돌려줬다.
       ★ 진짜 PG 없이도 잡는다 — 마이그레이션에서 표의 칸 목록을 읽어 **정적으로 대조**한다. */
    const migDir = path.join(__dirname, '..', 'migrations');
    const migSql = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()
      .map(f => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');

    /** 표별 칸 목록 — CREATE TABLE + 이후 ALTER TABLE ... ADD COLUMN 까지 모은다. */
    const cols = {};
    let m;
    const reCreate = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/g;
    while ((m = reCreate.exec(migSql))) {
      const set = cols[m[1]] || (cols[m[1]] = new Set());
      m[2].split('\n').map(x => x.trim()).forEach(line => {
        const c = /^(\w+)\s+[A-Za-z]/.exec(line);
        if (c && !/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT|CHECK)$/i.test(c[1])) set.add(c[1]);
      });
    }
    /* ⚠ `ALTER TABLE t ADD COLUMN a …, ADD COLUMN b …;` 한 문장에 여러 칸이 붙는 형태가 있다
       (047 이 그렇다). 첫 칸만 읽으면 나머지가 "없는 칸"으로 잘못 잡힌다 — 실제로 `active` 에서
       거짓 경보가 났다. **문장 전체를 잡아 그 안의 ADD COLUMN 을 모두** 읽는다. */
    const reAlterStmt = /ALTER TABLE (?:IF EXISTS )?(\w+)([\s\S]*?);/gi;
    while ((m = reAlterStmt.exec(migSql))) {
      const set = cols[m[1]] || (cols[m[1]] = new Set());
      let c; const reAdd = /ADD COLUMN (?:IF NOT EXISTS )?(\w+)/gi;
      while ((c = reAdd.exec(m[2]))) set.add(c[1]);
    }

    const sql = S.__candidateSqlForTest();
    /* 별칭 → 표 이름 (FROM/JOIN 뒤의 `표 별칭`) */
    const alias = {};
    const reAlias = /\b(?:FROM|JOIN)\s+(\w+)\s+(\w+)\b/g;
    while ((m = reAlias.exec(sql))) {
      if (!/^(WHERE|ON|AND|OR|SELECT|GROUP|ORDER|LIMIT)$/i.test(m[2])) alias[m[2]] = m[1];
    }
    ok('후보 SQL 에서 표 별칭을 읽었다', Object.keys(alias).length >= 6, JSON.stringify(alias));

    /* SQL 주석은 걷어낸다 — 주석 속 `rs.review_index_id` 같은 표기가 오탐이 된다. */
    const bare = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const bad = [];
    const reRef = /\b(\w+)\.(\w+)\b/g;
    while ((m = reRef.exec(bare))) {
      const t = alias[m[1]];
      if (!t || !cols[t]) continue;              // 모르는 표는 판정하지 않는다
      if (!cols[t].has(m[2])) bad.push(`${m[1]}.${m[2]} (= ${t}.${m[2]})`);
    }
    ok('★★★ 후보 SQL 이 참조하는 칸이 전부 실제로 존재한다', bad.length === 0,
      '없는 칸: ' + [...new Set(bad)].join(', '));
    ok('★ 작업표 줄 제외는 seq 로 잇는다(campaign_participants 에 row_index 는 없다)',
      /cp\.seq = rs\.row_index/.test(sql));
  }

  console.log('\n[K] ★★★ Codex 리뷰 3종 (2026-08-24) — 전부 실측 확인 후 수정');
  {
    /* K-1 (P1) 아카이브된 차수를 "행이 사라졌다"로 읽으면 정상 리뷰 이미지를 지운다.
         차수 아카이브가 review_index 행을 옮기고 원본을 지우므로 ㉠ review_index_id 가 dangling 이 되고
         ㉡ 재생성 뒤 review_file_id 스냅샷 복원도 그 행을 못 찾아 링크 제외까지 무너진다. */
    ok('★★★ 아카이브된 차수 행은 후보에서 제외한다',
      /NOT EXISTS \(SELECT 1 FROM review_index_archive ria/.test(src));
    ok('★ 제외는 그 작업·그 좌표로 잇는다(과거 아카이브분까지 덮는다)',
      /ria\.sheet_id = rs\.sheet_id AND ria\.tab_name = rs\.tab_name[\s\S]{0,80}ria\.row_index = rs\.row_index/.test(src));
    ok('★ 제외 블록에 있지 근거(OR) 블록에 있지 않다 — 아카이브가 삭제 근거가 되면 안 된다',
      !/AND \(\n[\s\S]*?review_index_archive[\s\S]*?\n\s*\)/.test(src));

    /* K-2 (P1) listFolderContents 는 mimeType **완전일치**로 질의한다 —
         'image/' 로 거르면 image/jpeg·image/png 어느 것과도 안 맞아 B 스캔이 언제나 0건이었다. */
    ok('★★★ 폴더 스캔이 mimeType 완전일치로 거르지 않는다',
      !/listFolderContents\([^)]*'image\/'\)/.test(src));
    ok('★ 이미지 판정은 접두사로 한다', /startsWith\('image\/'\)/.test(src));
  }
  {
    /* K-2 실행 확인 — 진짜 mimeType 이 섞인 목록에서 이미지만 골라내는가. */
    process.env.AI_REVIEW_FOLDER_ID = 'ROOT';
    const files = [
      { id: 'ok1', name: 'a.jpg', mimeType: 'image/jpeg', createdTime: '2020-01-01T00:00:00Z' },
      { id: 'ok2', name: 'b.png', mimeType: 'image/png',  createdTime: '2020-01-01T00:00:00Z' },
      { id: 'no1', name: 'c.pdf', mimeType: 'application/pdf', createdTime: '2020-01-01T00:00:00Z' },
      { id: 'no2', name: 'd',     mimeType: 'application/vnd.google-apps.folder', createdTime: '2020-01-01T00:00:00Z' },
    ];
    let sawMime;
    S.__setDriveForTest(Object.assign(makeDrive(), {
      ensureReviewFolderPath: async () => ({ id: 'F_REVIEW' }),
      ensureCaptureFolderPath: async () => ({ id: 'F_CAPTURE' }),
      listFolderContents: async (id, mime) => { sawMime = mime; return id === 'F_REVIEW' ? files : []; },
    }));
    S.__setPoolForTest({ query: async (sql) => /FROM tab_configs/.test(String(sql))
      ? { rows: [{ title: '시트' }] } : { rows: [], rowCount: 1 } });
    const scan = await S.scanFolderOrphans({ sheetId: 's', tabName: 't' });
    ok('★★★ 실제 mimeType(image/jpeg·image/png)을 후보로 잡는다',
      scan.ok === true && scan.items.map(i => i.fileId).join() === 'ok1,ok2');
    ok('★ 이미지가 아닌 파일·폴더는 건드리지 않는다',
      !scan.items.some(i => /^no/.test(i.fileId)));
    ok('★ Drive 질의에 완전일치 mime 을 넘기지 않는다', sawMime === undefined);
    delete process.env.AI_REVIEW_FOLDER_ID;
  }
  {
    /* K-3 (P2) 열린 트랜잭션에서 INSERT 가 실패하면 PG 가 tx 를 abort 로 표시한다.
         try/catch 만으로는 fail-soft 가 성립하지 않는다 — SAVEPOINT 로 되돌려야 한다. */
    const src2 = read('src/services/workTabDelete.service.js');
    const del = src2.slice(src2.indexOf('async function deleteTask'),
      src2.indexOf('async function findOrphanCampaigns'));
    /* ⚠ `/SAVEPOINT orphan_tomb/` 만 보면 ROLLBACK·RELEASE 줄에도 걸려, **세이브포인트를
         만드는 줄을 지워도 초록**이다(변이시험 실측). 생성문 자체와 **순서**를 고정한다. */
    const iSp  = del.indexOf("query('SAVEPOINT orphan_tomb')");
    const iIns = del.indexOf('INSERT INTO orphan_capture_tombstones');
    ok('★★★ 세이브포인트를 실제로 만든다', iSp > 0);
    ok('★★★ 만드는 것이 INSERT 보다 앞이다(뒤면 감싼 게 아니다)', iSp > 0 && iIns > 0 && iSp < iIns);
    ok('★★★ 실패하면 되돌린다(이 한 줄이 fail-soft 의 전부)',
      /ROLLBACK TO SAVEPOINT orphan_tomb/.test(del));
    ok('★ 성공하면 해제한다(세이브포인트를 쌓아 두지 않는다)',
      /RELEASE SAVEPOINT orphan_tomb/.test(del));
    ok('★★ 되돌리기가 catch 안에 있다(로그만 남기고 넘어가면 뒤 DELETE 가 25P02 로 죽는다)',
      /catch \(tombErr\) \{[\s\S]{0,300}ROLLBACK TO SAVEPOINT orphan_tomb/.test(del));
  }

  console.log('\n[H] C종류 — 작업 소멸(묘비 134)');
  {
    const src2 = read('src/services/workTabDelete.service.js');
    /* `for (const t of DELETE_TABLES)` 는 미리보기(previewTaskDelete)에도 있다.
       순서 계약은 **실제로 지우는** deleteTask 안에서만 뜻이 있으므로 그 본문만 본다. */
    const del = src2.slice(src2.indexOf('async function deleteTask'),
      src2.indexOf('async function findOrphanCampaigns'));
    ok('★★ 묘비 기록이 DELETE_TABLES 루프보다 **앞**(뒤면 읽을 원장이 없다)',
      del.indexOf('orphan_capture_tombstones') > 0
      && del.indexOf('orphan_capture_tombstones') < del.indexOf('for (const t of DELETE_TABLES)'));
    ok('★ 묘비 실패가 삭제를 막지 않는다(fail-soft)', /캡처 묘비 기록 실패\(삭제는 계속\)/.test(src2));
    ok('★ 조용히 넘기지 않고 건수를 보고한다', /recordedTombstones/.test(src2));
    ok('★ 재실행 안전(같은 파일 두 번 안 남긴다)', /ON CONFLICT \(file_id\) DO NOTHING/.test(src2));
    ok('★ 이미 휴지통 처리된 파일은 안 남긴다', /slot_key,''\) <> 'trashed'/.test(src2));

    const mig = read('migrations/134_orphan_capture_tombstones.sql');
    ok('묘비 테이블 마이그레이션', /CREATE TABLE IF NOT EXISTS orphan_capture_tombstones/.test(mig));
    ok('★ file_id 유니크', /uq_orphan_tombstone_file/.test(mig));
    ok('★ 처리되면 지우지 않고 시각을 찍는다', /resolved_at/.test(mig));
  }
  {
    const rows = [{ fileId: 'c1', fileName: 'c1.jpg', sheetId: 's', tabName: 't', reason: 'work_deleted' }];
    const seen = [];
    const pool = { seen, query: async (sql, params) => {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      seen.push({ q, params });
      return /FROM orphan_capture_tombstones t/.test(q) ? { rows } : { rows: [], rowCount: 1 };
    } };
    S.__setPoolForTest(pool);
    const drive = makeDrive();
    S.__setDriveForTest(drive);
    const prev = await S.trashTombstonedCaptures({});
    ok('C 도 미리보기 기본', prev.dryRun === true && drive.trashed.length === 0);
    ok('C 미리보기는 쓰기 0', !seen.some(x => /^UPDATE|^INSERT|^DELETE/i.test(x.q)));
    const r = await S.trashTombstonedCaptures({ dryRun: false, fileIds: ['NOPE'] });
    ok('★ C 도 후보 교집합(고른 것 밖은 안 지운다)', r.trashed === 0 && drive.trashed.length === 0);

    seen.length = 0;
    const r2 = await S.trashTombstonedCaptures({ dryRun: false, by: '망고' });
    ok('C 실행은 후보를 휴지통으로', r2.trashed === 1 && drive.trashed.join() === 'c1');
    const w = seen.filter(x => /^UPDATE/i.test(x.q));
    ok('★ 묘비는 지우지 않고 처리 시각을 찍는다',
      w.length === 1 && /UPDATE orphan_capture_tombstones SET resolved_at = NOW\(\)/.test(w[0].q));
    ok('★★ C 는 원장을 고치지 않는다 — 가리키던 원장이 이미 없다',
      !seen.some(x => /UPDATE review_submissions/.test(x.q)));
    ok('★ 이미 처리한 묘비는 두 번 찍지 않는다(resolved_at IS NULL)', /resolved_at IS NULL/.test(w[0].q));
  }

  console.log('\n[I] ★★★ B종류 — 원장 없음(Drive 스캔) · 일괄 삭제 금지');
  {
    const svc = read('src/services/orphanCaptureCleanup.service.js');
    ok('★★★ fileIds 없이 실행하면 아무것도 안 지운다',
      /fileIds 필수 — 폴더 고아는 사람이 고른 파일만 정리합니다/.test(svc));
    ok('★ 스캔은 읽기 전용(폴더 목록 + 원장 대조)', /listFolderContents/.test(svc));
    ok('★ 묘비에 이미 있는 파일은 B 후보가 아니다(중복 취급 금지)',
      /FROM orphan_capture_tombstones t WHERE t\.file_id = ANY/.test(svc));
    ok('★ 오판 위험을 화면에 문장으로 고지', /원장 기록만 실패한 정상 캡처가 섞일 수 있습니다/.test(svc));
    ok('★ 폴더 조회 실패는 사유를 말한다(조용한 0건 금지)', /폴더 조회 실패/.test(svc));

    /* ★ 스캔이 **진짜 후보를 뱉는 상태**로 만들어 놓고 부른다.
       폴더 조회가 실패해 조기 반환되면 "0건"이 나와도 가드를 시험한 게 아니다
       (그 스텁으로는 가드를 지워도 테스트가 통과해 버린다 — 검출력 0). */
    process.env.AI_REVIEW_FOLDER_ID = 'ROOT';
    /* ★ mimeType 을 실제 값으로 둔다 — Drive 는 항상 실어 보내고(fields 에 포함),
       코드가 접두사로 거르므로 없는 값으로 두면 그건 현실이 아니라 픽스처 오류다. */
    const old = { id: 'g1', name: 'g1.jpg', mimeType: 'image/jpeg', createdTime: '2020-01-01T00:00:00Z' };
    const drive = Object.assign(makeDrive(), {
      ensureReviewFolderPath: async () => ({ id: 'F_REVIEW' }),
      ensureCaptureFolderPath: async () => ({ id: 'F_CAPTURE' }),
      listFolderContents: async (id) => (id === 'F_REVIEW' ? [old] : []),
    });
    S.__setDriveForTest(drive);
    S.__setPoolForTest({ query: async (sql) => /FROM tab_configs/.test(String(sql))
      ? { rows: [{ title: '시트' }] } : { rows: [], rowCount: 1 } });

    const scan = await S.scanFolderOrphans({ sheetId: 's', tabName: 't' });
    ok('스캔이 원장에 없는 파일을 후보로 잡는다(가드 시험 전제)',
      scan.ok === true && scan.total === 1 && scan.items[0].fileId === 'g1');

    const r = await S.trashFolderOrphans({ sheetId: 's', tabName: 't', dryRun: false });
    ok('★★★ 후보가 있어도 fileIds 없으면 0건 — 일괄 삭제 표면이 없다',
      (r.trashed || 0) === 0 && drive.trashed.length === 0 && /fileIds 필수/.test(r.error || ''));
    const r2 = await S.trashFolderOrphans({ sheetId: 's', tabName: 't', dryRun: false, fileIds: ['NOPE'] });
    ok('★ 고른 것이 후보 밖이면 0건(교집합)', (r2.trashed || 0) === 0 && drive.trashed.length === 0);
    const r3 = await S.trashFolderOrphans({ sheetId: 's', tabName: 't', dryRun: false, fileIds: ['g1'] });
    ok('★ 사람이 고른 후보만 휴지통으로', r3.trashed === 1 && drive.trashed.join() === 'g1');
    /* ★★ mimeType 을 모르는 파일은 후보로 삼지 않는다 — 모르면 건드리지 않는다(안전 방향). */
    S.__setDriveForTest(Object.assign(makeDrive(), {
      ensureReviewFolderPath: async () => ({ id: 'F_REVIEW' }),
      ensureCaptureFolderPath: async () => ({ id: 'F_CAPTURE' }),
      listFolderContents: async (id) => (id === 'F_REVIEW'
        ? [{ id: 'unknown', name: 'x', createdTime: '2020-01-01T00:00:00Z' }] : []),
    }));
    const rU = await S.scanFolderOrphans({ sheetId: 's', tabName: 't' });
    ok('★★ mimeType 을 모르는 파일은 후보가 아니다', rU.ok === true && rU.total === 0);
    delete process.env.AI_REVIEW_FOLDER_ID;
  }

  console.log('\n[J] 크론은 여전히 A만 돌린다');
  {
    const cron = read('src/jobs/cron.js');
    ok('★★ 크론이 B·C 를 부르지 않는다',
      !/trashTombstonedCaptures|trashFolderOrphans/.test(cron));
    ok('크론은 A 만', /trashOrphanCaptures\(\{ dryRun: false, by: 'cron' \}\)/.test(cron));
    const routes = read('src/routes/drive.routes.js');
    ok('★ 수동 창구가 종류를 나눠 받는다', /kind === 'tombstoned'/.test(routes) && /kind === 'folder'/.test(routes));
    ok('★ 미지정은 종전 동작(A)', /String\(b\.kind \|\| 'linked'\)/.test(routes));
    ok('★ 모르는 kind 는 거부(조용한 오동작 금지)', /알 수 없는 kind/.test(routes));
  }

  console.log(`\n✅ orphanCaptureCleanup: ${passed} checks passed\n`);
})().catch(err => { console.error('\n❌ ' + err.message + '\n'); process.exit(1); });
