/**
 * retiredBulkTools.test.js — 결정 186(코드 다이어트)에서 제거한 "한 번에 운영 자료를 바꾸는" 옛 도구가
 * 되살아나지 않는지 본다. 모두 게이트가 authMiddleware(로그인 여부) 뿐이었다.
 *   62번  POST /api/tab/reset-all             — review_index·index_master·tab_configs·campaigns 등 전체 DELETE
 *   60번  POST /api/drive/migrate-names        — 모든 탭 폴더를 [리뷰]·[구매캡처]로 일괄 개명
 *   60번  POST /api/drive/reset-folder-urls    — 재탐색 없이 폴더 URL 비움
 *   74번  POST /api/admin/db-rebuild           — 운영 4표 전체 DELETE 후 구글시트에서 재등록(무시트 작업 복구 불가)
 * 실행: node tests/retiredBulkTools.test.js
 */
const assert = require('assert');
const tab = require('../src/routes/tabconfig.routes');
const drive = require('../src/routes/drive.routes');
const admin = require('../src/routes/admin.routes');
const has = (r, p) => r.stack.some(l => l.route && l.route.path === p);

assert.ok(!has(tab, '/reset-all'), '62번: 운영 자료 전체 초기화 입구가 되살아났다');
assert.ok(!has(drive, '/migrate-names'), '60번: 폴더 일괄 개명 입구가 되살아났다');
assert.ok(!has(drive, '/reset-folder-urls'), '60번: 폴더 URL 초기화 입구가 되살아났다');
assert.ok(!has(drive, '/migrate-to-new-structure'), '60번: 폴더 통째 복사 이관 입구가 되살아났다');
assert.ok(!has(admin, '/db-rebuild'), '74번: DB 재구축(전체 삭제 후 시트 재등록) 입구가 되살아났다');
console.log('✅ retiredBulkTools: 제거된 일괄 도구 부재 확인');
process.exit(0);
