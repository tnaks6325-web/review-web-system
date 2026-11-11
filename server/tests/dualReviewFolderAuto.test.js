'use strict';
/* 결정 367: 동시진행 리뷰 제출이 [리뷰] 폴더 미연결 작업에서 review_folder_missing 으로 막히던 사고
   (2026-11-11 운영 · 젖산마그네슘 네/쿠 동시진행). 일반 리뷰 업로드처럼 폴더를 준비해 연결해야 한다. */
require('./helpers/dualChannelDependencies.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const svc = require('../src/services/dualChannelReview.service');

function fakeDb(row) {
  const calls = [];
  const state = { row: row ? { ...row } : null };
  return {
    calls, state,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT[\s\S]*FROM tab_configs/i.test(sql)) return { rows: state.row ? [{ ...state.row }] : [] };
      if (/UPDATE tab_configs SET folder_url/i.test(sql)) {
        if (state.row && !state.row.folder_url) { state.row.folder_url = params[0]; return { rowCount: 1 }; }
        return { rowCount: 0 };
      }
      throw new Error('unexpected sql ' + sql.slice(0, 60));
    },
  };
}
function fakeDrive(extra = {}) {
  const made = [];
  return {
    made,
    extractFolderIdFromUrl: (u) => { const m = String(u || '').match(/folders\/([-\w]{10,})/); return m ? m[1] : null; },
    getFileParents: async (id) => ({ id, parents: id === 'CAPFOLDER0001' ? ['TABFOLDER0001'] : [] }),
    getOrCreateSubFolder: async (parent, name) => { made.push([parent, name]); return { id: parent + ':' + name }; },
    ...extra,
  };
}
const target = { sheetId: 'S1', tabName: '젖산마그네슘 네/쿠 동시진행' };
const slot = { key: 'review', label: '네이버 리뷰' };

test('[리뷰] 폴더가 없으면 같은 작업의 [구매캡처] 옆에 만들어 연결하고 그 안에 올린다', async () => {
  const db = fakeDb({ folder_url: null, capture_folder_url: 'https://drive.google.com/drive/folders/CAPFOLDER0001', campaign_name: null });
  const drive = fakeDrive();
  const folder = await svc.resolveReviewFolderInTx(db, target, slot, { driveService: drive });
  assert.deepEqual(drive.made[0], ['TABFOLDER0001', '[리뷰]']);
  assert.equal(db.state.row.folder_url, 'https://drive.google.com/drive/folders/TABFOLDER0001:[리뷰]');
  assert.deepEqual(drive.made[1], ['TABFOLDER0001:[리뷰]', '네이버 리뷰']);
  assert.equal(folder, 'TABFOLDER0001:[리뷰]:네이버 리뷰');
});

test('이미 연결된 [리뷰] 폴더가 있으면 그대로 쓴다(새로 만들지 않음)', async () => {
  const db = fakeDb({ folder_url: 'https://drive.google.com/drive/folders/REVIEWROOT01', capture_folder_url: null });
  const drive = fakeDrive();
  const folder = await svc.resolveReviewFolderInTx(db, target, slot, { driveService: drive });
  assert.deepEqual(drive.made, [['REVIEWROOT01', '네이버 리뷰']]);
  assert.equal(folder, 'REVIEWROOT01:네이버 리뷰');
  assert.ok(!db.calls.some(c => /UPDATE/i.test(c.sql)));
});

test('구매캡처 폴더도 없으면 일반 업로드와 같은 규칙(공고 이름 → 작업 이름 → [리뷰])으로 만든다', async () => {
  const db = fakeDb({ folder_url: '', capture_folder_url: '', campaign_name: '업체A' });
  let asked = null;
  const drive = fakeDrive();
  const folder = await svc.resolveReviewFolderInTx(db, target, slot, {
    driveService: drive,
    ensureReviewFolderPath: async (q) => { asked = q; return { id: 'NEWREVIEW001', url: 'https://drive.google.com/drive/folders/NEWREVIEW001' }; },
  });
  assert.deepEqual(asked, { sheetId: 'S1', tabName: target.tabName, campaignName: '업체A' });
  assert.equal(db.state.row.folder_url, 'https://drive.google.com/drive/folders/NEWREVIEW001');
  assert.equal(folder, 'NEWREVIEW001:네이버 리뷰');
});

test('그 사이 다른 요청이 먼저 연결했으면 그 폴더를 쓴다(덮어쓰지 않음)', async () => {
  const db = fakeDb({ folder_url: null, capture_folder_url: 'https://drive.google.com/drive/folders/CAPFOLDER0001' });
  const realQuery = db.query.bind(db);
  db.query = async (sql, params) => {
    if (/UPDATE tab_configs SET folder_url/i.test(sql)) { db.state.row.folder_url = 'https://drive.google.com/drive/folders/WINNER000001'; return { rowCount: 0 }; }
    return realQuery(sql, params);
  };
  const drive = fakeDrive();
  const folder = await svc.resolveReviewFolderInTx(db, target, slot, { driveService: drive });
  assert.equal(folder, 'WINNER000001:네이버 리뷰');
});

test('등록되지 않은 작업이거나 폴더 준비가 실패하면 review_folder_missing 으로 막는다(루트에 올리지 않음)', async () => {
  await assert.rejects(svc.resolveReviewFolderInTx(fakeDb(null), target, slot, { driveService: fakeDrive() }), /review_folder_missing/);
  const db = fakeDb({ folder_url: null, capture_folder_url: '' });
  await assert.rejects(svc.resolveReviewFolderInTx(db, target, slot, {
    driveService: fakeDrive(), ensureReviewFolderPath: async () => { throw new Error('drive down'); },
  }), /review_folder_missing/);
});

test('실제 제출 경로가 이 함수를 쓴다(옛 즉시 거절 코드가 남아 있지 않다)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/dualChannelReview.service.js'), 'utf8');
  const body = src.slice(src.indexOf('async function recordReviewUploadInTx'), src.indexOf('async function completeReviewUploadInTx'));
  assert.match(body, /resolveReviewFolderInTx\(client,target,slot/);
  assert.doesNotMatch(body, /if\(!root\)throw fail\('review_folder_missing'\)/);
});
