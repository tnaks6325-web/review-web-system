/**
 * reviewFolderBackfill.test.js — 탭 [리뷰] 폴더 스캔 → 파일↔행 링크 백필 회귀가드.
 *
 * 배경(실사용 신고): 업체 뷰어 리뷰 미리보기가 "리뷰 캡처 미등록"으로 뜨는 탭 —
 *   폴더에는 캡처가 있는데 원장(review_submissions)·대표(review_index.review_file_*)가 빈 상태.
 *   POST /api/drive/review-folder-backfill 이 폴더를 스캔해 파일명 이름↔행 결정적 매칭으로 백필한다.
 *
 * 고정하는 것:
 *   1. 공용 헬퍼(linkReviewFilesToRows, 스텁 db 실행): 결정적 링크 1건만 / 동명 모호 스킵 /
 *      이미 링크된 행 보존 / dryRun 무write / 원장 upsert(source='backfill').
 *   2. ★ 사본 금지: relocate-orphan-reviews 도 같은 헬퍼를 쓴다(백필 SQL 이 라우트에 없다).
 *   3. 라우트 배선: dryRun 기본 true · 폴더 자동 매핑(ensureReviewFolderPath) · 폴더 내 이미지만 나열.
 *   4. 프론트 배선: api.js 액션 맵 + 관리자 '리뷰 캡처 정리' 모달 버튼/러너.
 *
 * 실행: node tests/reviewFolderBackfill.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { linkReviewFilesToRows } = require('../src/services/reviewFileLink.service');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

function stubDb() {
  const q = [];
  return { q, async query(sql, params) { q.push({ s: String(sql).replace(/\s+/g, ' ').trim(), params }); return { rows: [], rowCount: 1 }; } };
}
// 파일명 이름 추출 스텁 — drive.service.extractReviewerNameFromFile 과 같은 3패턴(정규식은 아래 5절이 원본과 대조)
const extractName = (fn) => {
  const b = String(fn || '').replace(/\.[^.]+$/, '');
  const m1 = b.match(/^(.+?)_\d+_\d{8}_\d{6}$/); if (m1) return m1[1].trim();
  const m2 = b.match(/^(.+?)_\d+$/); if (m2) return m2[1].trim();
  return b.trim();
};

async function run() {
  const rows = () => ([
    { id: 'i1', row_index: 1, reviewer_name: '박지나', recipient_name: '박지나', review_file_id: null },
    { id: 'i2', row_index: 2, reviewer_name: '안보람', recipient_name: '안보람', review_file_id: null },
    { id: 'i3', row_index: 3, reviewer_name: '김철수', recipient_name: '김철수', review_file_id: null },   // 동명 i4 와 모호
    { id: 'i4', row_index: 4, reviewer_name: '김철수', recipient_name: '김철수', review_file_id: null },
    { id: 'i5', row_index: 5, reviewer_name: '이미연', recipient_name: '이미연', review_file_id: 'OLDFILE' }, // 이미 대표 링크됨
  ]);
  const files = [
    { id: 'F1', name: '박지나_1_20260703_120000.jpg', createdTime: '2026-07-03T03:00:00Z' },
    { id: 'F2', name: '안보람.jpg', createdTime: null },                    // 패턴3(이름만)도 연결
    { id: 'F3', name: '김철수_1.jpg', createdTime: null },                  // 동명 2행 → 모호
    { id: 'F4', name: '이미연_2.jpg', createdTime: null },                  // 행은 이미 링크됨 → already(원장만)
    { id: 'F5', name: '명단에없는사람_1.jpg', createdTime: null },          // unmatched(원장만)
  ];

  /* ═══ 1. 실제 실행(적용 모드) ═══ */
  let db = stubDb();
  const r1 = await linkReviewFilesToRows({ db, sheetId: 'S', tabName: 'T', files, indexRows: rows(), isDryRun: false, extractName });
  ok('결정적 매칭 2건 링크(리뷰형식 + 이름만 패턴)', r1.linked === 2);
  ok('동명 2행은 모호 — 자동 링크하지 않는다(틀린 행에 붙느니 빈 값)', r1.ambiguous === 1 && r1.samples.ambiguous[0] === '김철수_1.jpg');
  ok('이미 대표가 있는 행은 already(덮어쓰기 없음)', r1.already === 1);
  ok('명단에 없는 이름은 unmatched 로 리포트', r1.unmatched === 1 && r1.samples.unmatched[0] === '명단에없는사람_1.jpg');
  ok('원장(review_submissions)은 전 파일 기록(5건)', r1.recorded === 5);
  const upd = db.q.filter(x => /UPDATE review_index/.test(x.s));
  ok('대표(review_file_id) UPDATE 는 결정적 2건만', upd.length === 2 && upd.every(u => ['i1', 'i2'].includes(u.params[4])));
  const ins = db.q.filter(x => /INSERT INTO review_submissions/.test(x.s));
  ok("원장 INSERT 는 source='backfill' + file_id 업서트", ins.length === 5 && ins.every(i => /'backfill'/.test(i.s) && /ON CONFLICT \(file_id\)/.test(i.s)));
  ok('already 파일도 원장에는 행 연결(row_index=5)', ins.some(i => i.params[5] === 'F4' && i.params[2] === 5));
  ok('모호/명단없음 파일은 원장에 행 미지정(row_index NULL)', ins.filter(i => ['F3', 'F5'].includes(i.params[5])).every(i => i.params[2] === null));
  ok('원장 업서트가 기존 row_index 를 COALESCE 로 보존(재실행 안전)', ins.every(i => /COALESCE\(EXCLUDED\.row_index, review_submissions\.row_index\)/.test(i.s)));

  /* ═══ 2. dryRun — 어떤 write 도 없다 ═══ */
  db = stubDb();
  const r2 = await linkReviewFilesToRows({ db, sheetId: 'S', tabName: 'T', files, indexRows: rows(), isDryRun: true, extractName });
  ok('dryRun: 판정 리포트는 동일(연결 2·모호 1·기존 1·명단없음 1)', r2.linked === 2 && r2.ambiguous === 1 && r2.already === 1 && r2.unmatched === 1);
  ok('★ dryRun: DB write 0 (UPDATE/INSERT 모두 없음)', db.q.length === 0 && r2.recorded === 0);

  /* ═══ 3. 같은 이름 파일 2장 — 첫 장이 대표, 둘째는 already ═══ */
  db = stubDb();
  const r3 = await linkReviewFilesToRows({
    db, sheetId: 'S', tabName: 'T', isDryRun: false, extractName,
    files: [{ id: 'A1', name: '박지나_1.jpg' }, { id: 'A2', name: '박지나_2.jpg' }],
    indexRows: [{ id: 'i1', row_index: 1, reviewer_name: '박지나', recipient_name: '박지나', review_file_id: null }],
  });
  ok('같은 이름 2장: 대표 1건 + already 1건(둘 다 원장 기록)', r3.linked === 1 && r3.already === 1 && r3.recorded === 2);

  /* ═══ 4. 라우트·사본 금지 배선 ═══ */
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'drive.routes.js'), 'utf8');
  ok('POST /review-folder-backfill 라우트 존재(authMiddleware)', /router\.post\('\/review-folder-backfill', authMiddleware/.test(routeSrc));
  const seg = routeSrc.slice(routeSrc.indexOf("'/review-folder-backfill'"));
  ok('dryRun 기본 true(미리보기 먼저)', /const isDryRun = dryRun !== false/.test(seg));
  ok('폴더 미연결 시 ensureReviewFolderPath 로 자동 매핑 + tab_configs 연결', /ensureReviewFolderPath\(rootFolderId, sheetTitle, tabName\)/.test(seg) && /UPDATE tab_configs SET folder_url/.test(seg));
  ok('폴더 내 이미지만 나열(in parents + image mime, 이동 없음)', /in parents and trashed = false and mimeType contains 'image\/'/.test(seg) && !/moveFile/.test(seg.slice(0, seg.indexOf('review-submissions'))));
  ok('★ 두 소비처 모두 공용 헬퍼 사용(사본 금지)', (routeSrc.match(/linkReviewFilesToRows\(\{/g) || []).length === 2);
  ok('★ 백필 SQL(INSERT INTO review_submissions)이 라우트에서 사라졌다(서비스 단일 출처)', !/INSERT INTO review_submissions/.test(routeSrc));

  /* ═══ 5. 이름 추출 3패턴이 원본(drive.service)과 일치 ═══ */
  const drvSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'drive.service.js'), 'utf8');
  ok('extractReviewerNameFromFile 3패턴(타임스탬프/순번/이름만) 생존',
    /\^\(\.\+\?\)_\\d\+_\\d\{8\}_\\d\{6\}\$/.test(drvSrc) && /\^\(\.\+\?\)_\\d\+\$/.test(drvSrc));

  /* ═══ 6. 프론트 배선 ═══ */
  const apiSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'api.js'), 'utf8');
  ok("api.js 액션 맵: reviewFolderBackfill → POST /api/drive/review-folder-backfill",
    /'reviewFolderBackfill': \{ method: 'POST', path: '\/api\/drive\/review-folder-backfill' \}/.test(apiSrc));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'index-app.js'), 'utf8');
  ok('관리자 리뷰 캡처 정리 모달에 백필 버튼', /_reviewFolderBackfill\(false\)/.test(appSrc) && /폴더 이미지 연결/.test(appSrc));
  ok('러너: dryRun 미리보기 → [실제 연결 실행] 2단계', /_reviewFolderBackfill\(true\)/.test(appSrc) && /dryRun: !apply/.test(appSrc.slice(appSrc.indexOf('async function _reviewFolderBackfill'), appSrc.indexOf('async function _reviewFolderBackfill') + 2600)));

  console.log(`\n✅ reviewFolderBackfill: ${n} cases passed`);
}

run().then(() => process.exit(0)).catch(e => { console.error('\n❌', e && e.message); process.exit(1); });
