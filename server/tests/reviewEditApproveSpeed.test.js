/**
 * reviewEditApproveSpeed.test.js — 이미지 교체요청 승인 대기 줄이기 회귀가드 (결정 261 · 2026-10-19 실측)
 *
 * 실측(운영 서버 기록): 승인 1건 5.7~9.1초 — 순차 Drive 왕복(이동·이름 변경·옛 파일 보관 이동·이름 변경)이 지배.
 * 같은 승인이 거의 동시에 6번 들어간 기록도 있었다(버튼 잠금 없음).
 *
 * [A] 이동 + 이름 변경 = Drive files.update **1회**(moveAndRenameFile)
 * [B] 승인 라우트 — 스테이징 폴더 조회 생략 · 새 파일 이동+이름 한 번에(실패 시 종전 2단계 폴백) ·
 *     옛 파일 보관 이동은 **응답 뒤**(throw 없음 · 종전 실패 무시 규율 그대로)
 * [C] 공용 승인·반려 함수 — 같은 요청을 처리 중이면 다시 보내지 않는다(vm 으로 실제 실행)
 * [D] 교체요청 팝업 — 처리 중 버튼 잠금·「처리 중…」·이동 잠금 · 다음 요청 원본 미리 받기(대조는 원본 — 결정 008)
 *
 * 실행: node tests/reviewEditApproveSpeed.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const readF = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };
// ★ 끝까지 못 가고(기다리던 약속이 영영 안 풀려) 조용히 끝나면 **실패**다 — 0 으로 끝나 통과처럼 보이는 것을 막는다.
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.log('  ✗ 끝까지 실행되지 않았다(멈춘 약속)'); process.exitCode = 1; } });
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' — ' + ms + 'ms 안에 안 끝남')), ms))]);

/* ── 가짜 Drive 클라이언트(driveDownloadSingleRoundtrip 과 같은 주입) ── */
delete process.env.DRIVE_OAUTH_CLIENT_ID;
delete process.env.DRIVE_OAUTH_CLIENT_SECRET;
delete process.env.DRIVE_OAUTH_REFRESH_TOKEN;
let CALLS = [];
const fakeDrive = { files: { update: async (params) => { CALLS.push(params); return { data: { id: params.fileId } }; } } };
const sheetsPath = require.resolve('../src/services/sheets.service');
require.cache[sheetsPath] = {
  id: sheetsPath, filename: sheetsPath, loaded: true,
  exports: { drive: fakeDrive, sheets: {}, throttledCall: async (f) => f() },
};
const DS = require('../src/services/drive.service');

(async () => {
  console.log('\n▶ reviewEditApproveSpeed 회귀가드\n');

  // ── A ──
  {
    CALLS = [];
    await DS.moveAndRenameFile('FILE_00000000000000000001', 'NEWPARENT', 'OLDPARENT', '홍길동_리뷰1.jpg');
    assert.strictEqual(CALLS.length, 1, `이동+이름 변경은 Drive 왕복 1회여야 한다 (실제 ${CALLS.length}회)`);
    const p = CALLS[0];
    assert.strictEqual(p.addParents, 'NEWPARENT');
    assert.strictEqual(p.removeParents, 'OLDPARENT');
    assert.deepStrictEqual(p.requestBody, { name: '홍길동_리뷰1.jpg' });
    assert.strictEqual(p.supportsAllDrives, true);
    ok('[A] moveAndRenameFile = files.update 1회(부모 이동 + 이름을 한 요청에)');
  }

  // ── B ──
  const RE = read('src/routes/reviewEdit.routes.js');
  {
    const ap = RE.slice(RE.indexOf("router.post('/approve'"), RE.indexOf("router.post('/reject'"));
    assert.ok(ap.length > 500, '승인 라우트를 찾지 못했다');
    assert.match(ap, /_resolveFolders\(\s*r0\.sheet_id, r0\.tab_name, r0\.slot_key \|\| 'review', \{ withStaging: false \}\s*\)/,
      '승인은 스테이징 폴더가 필요 없다(Drive 검색 1회 절약)');
    const fr = /async function _resolveFolders\([^)]*\{ withStaging = true \} = \{\}\)[\s\S]*?const staging = withStaging \? await driveService\.getOrCreateSubFolder\(rootFolderIdForStaging, '\[리뷰수정대기\]'\) : null;/;
    assert.match(RE, fr, '_resolveFolders: 기본은 종전대로 스테이징 확보(업로드 경로 불변) · 끌 때만 생략');
    ok('[B1] 승인만 스테이징 조회 생략(업로드 경로는 종전 그대로)');

    assert.match(ap, /try \{\s*await driveService\.moveAndRenameFile\(r0\.new_file_id, targetFolderId, parents\[0\] \|\| r0\.new_parent_id, finalName\);\s*\} catch \(e\) \{[\s\S]{0,200}await driveService\.moveFile\(r0\.new_file_id, targetFolderId, parents\[0\] \|\| r0\.new_parent_id\);\s*try \{ await driveService\.renameFile\(r0\.new_file_id, finalName\); \}\s*catch \(e2\)/,
      '새 파일: 한 번에 이동+이름 · 실패 시 종전 2단계(이동 실패 = 승인 실패 · 이름 실패 = 무시)');
    assert.ok(ap.indexOf('const finalName') < ap.indexOf('moveAndRenameFile'), '이름을 먼저 정해야 한 번에 보낼 수 있다');
    ok('[B2] 새 파일 이동+이름 = 왕복 1회 · 실패 시 종전 2단계 폴백(이동 실패는 여전히 승인 실패)');

    const resAt = ap.indexOf('res.json({ ok: true });');
    const archAt = ap.indexOf('_archiveOldFileAfterReply(committed);');
    assert.ok(resAt > 0 && archAt > resAt, '옛 파일 보관 이동은 응답을 보낸 **뒤**에 시작해야 한다');
    assert.ok(!/_resolveArchiveFolder\(\)/.test(ap), '승인 요청 안에서 보관 폴더를 다루지 않는다(응답 뒤 함수로 옮겼다)');
    assert.ok(ap.indexOf("postReviewEditDecision(committed, 'approved'") < resAt, '리뷰어 통지는 여전히 응답 전(저장 확정 뒤)');
    const h = RE.slice(RE.indexOf('function _archiveOldFileAfterReply('), RE.indexOf("router.post('/approve'"));
    assert.match(h, /setImmediate\(async \(\) => \{\s*try \{[\s\S]*\} catch \(e\) \{\s*logger\.warn\(`\[review-edit\] 구 파일 보관 이동 실패\(무시\)/,
      '응답 뒤 작업은 전부 try/catch — 잡아 줄 곳이 없어 throw 하면 안 된다');
    assert.match(h, /getFileParents\(committed\.old_file_id\)[\s\S]*moveAndRenameFile\(committed\.old_file_id, archiveId/,
      '보관 이동도 한 번에(실패 시 2단계)');
    assert.ok(!/\bthrow\b/.test(h), '응답 뒤 함수에 throw 금지');
    ok('[B3] 옛 파일 보관 이동은 응답 뒤 · throw 없음 · 리뷰어 통지는 응답 전 그대로');
  }

  // ── C — 공용 승인·반려 함수를 vm 으로 실제 실행 ──
  {
    const CS = readF('frontend/js/cs-inquiry.js');
    const s = CS.indexOf('const _reInflight = new Set();');
    const e = CS.indexOf('function csReloadAfterReviewEdit()');
    assert.ok(s > 0 && e > s, '처리 중 잠금 블록을 찾지 못했다');
    const calls = [];
    const toasts = [];
    let release;
    const ctx = {
      calls, toasts,
      showToast: (m) => toasts.push(m),
      confirm: () => true, prompt: () => '사유',
      csReloadAfterReviewEdit: () => {},
      _reCall: (p, body) => { calls.push(p + ':' + body.id); return new Promise((r) => { release = () => r({ ok: true }); }); },
    };
    vm.createContext(ctx);
    vm.runInContext(CS.slice(s, e) + '\nthis.approve = csApproveReviewEdit; this.reject = csRejectReviewEdit;', ctx);
    const p1 = ctx.approve('REQ1', { skipConfirm: true, skipReload: true });
    const r2 = await within(ctx.approve('REQ1', { skipConfirm: true, skipReload: true }), 500, '두 번째 승인이 막히지 않고 서버를 기다린다');
    const r3 = await within(ctx.reject('REQ1', { note: '흐림', skipReload: true }), 500, '처리 중 반려가 막히지 않고 서버를 기다린다');
    assert.strictEqual(r2, false, '처리 중인 같은 요청의 두 번째 승인은 보내지 않는다');
    assert.strictEqual(r3, false, '처리 중인 같은 요청의 반려도 보내지 않는다');
    assert.deepStrictEqual(calls, ['/approve:REQ1'], `서버 호출은 1번이어야 한다 (실제 ${JSON.stringify(calls)})`);
    assert.ok(toasts.some((t) => /처리 중입니다/.test(t)), '막을 때 이유를 말한다');
    release();
    assert.strictEqual(await p1, true);
    const p4 = ctx.approve('REQ1', { skipConfirm: true, skipReload: true });
    release();
    assert.strictEqual(await p4, true, '끝난 뒤에는 다시 보낼 수 있다(잠금이 풀린다)');
    // 네트워크 오류 = 실패로 접고 잠금을 푼다(영원히 "처리 중"이 되지 않게)
    ctx._reCall = () => Promise.reject(new Error('offline'));
    vm.runInContext('_reCall = this._reCall', ctx);
    assert.strictEqual(await ctx.approve('REQ2', { skipConfirm: true, skipReload: true }), false);
    ctx._reCall = (p, b) => { calls.push(p + ':' + b.id); return Promise.resolve({ ok: true }); };
    vm.runInContext('_reCall = this._reCall', ctx);
    assert.strictEqual(await ctx.approve('REQ2', { skipConfirm: true, skipReload: true }), true, '오류 뒤에도 잠금이 풀린다');
    ok('[C] 같은 요청 처리 중 재승인·반려 = 서버 호출 0 · 끝나면(오류 포함) 잠금 해제 — vm 실행');
  }

  // ── D — 팝업 ──
  {
    const WD = readF('frontend/workdesk.html');
    const rs = WD.slice(WD.indexOf('async function _rePopupResolve('), WD.indexOf('function _reRenderReviewPopup('));
    assert.match(rs, /if\(_RE_POPUP\.busy\) return;/, '처리 중 재진입 차단');
    assert.match(rs, /_rePopupSetBusy\(true, action\);\s*try\{[\s\S]*csApproveReviewEdit\(rid,\{ skipConfirm:true, skipReload:true \}\)[\s\S]*\}finally\{\s*_rePopupSetBusy\(false, action\);/,
      '버튼 잠금 → 요청 → 무조건 해제(실패해도 다시 누를 수 있게)');
    assert.match(WD, /function _rePopupSetBusy\(on, action\)\{[\s\S]*btn\.textContent='처리 중…'/, '처리 중 문구');
    assert.match(WD, /function _reMoveReviewPopup\(delta\)\{\s*if\(_RE_POPUP\.busy\) return;/, '처리 중 이전·다음 이동 잠금(방향키 포함)');
    ok('[D1] 팝업: 처리 중 버튼·이동 잠금 + 「처리 중…」 · 끝나면 해제');

    assert.match(WD, /function _rePopupImageUrl\(fileId\)\{[\s\S]*`\$\{API_BASE\}\/api\/drive\/image\/\$\{encodeURIComponent\(id\)\}`/,
      '대조 이미지는 원본 프록시(결정 008 — 썸네일 CDN 금지)');
    const pf = WD.slice(WD.indexOf('function _rePrefetchRow('), WD.indexOf('function _rePopupSetBusy('));
    assert.match(pf, /_rePopupImageUrl\(fid\)/, '미리 받기는 팝업과 **같은 주소**(그래야 브라우저가 기억한 것을 쓴다)');
    assert.ok(!/DriveThumb|thumbnail\?id=/.test(pf), '미리 받기에 썸네일 주소를 쓰지 않는다');
    assert.match(pf, /_RE_PREFETCHED\.size>12/, '잡아 두는 개수 상한');
    assert.match(WD, /_rePrefetchRow\(_RE_POPUP\.rows\[_RE_POPUP\.index\+1\]\);/, '다음 요청 미리 받기');
    assert.match(WD, /function _reRenderQueue\(\)\{[\s\S]{0,300}_rePrefetchRow\(_rePopupPendingRows\(\)\[0\]\)/, '대기 큐가 보이면 맨 앞 요청 미리 받기');
    ok('[D2] 다음 요청·맨 앞 요청 원본 미리 받기(같은 주소 · 상한 12 · 썸네일 금지)');
  }

  finished = true;
  console.log(`\n${n}/${n} 통과`);
})().catch((e) => { console.error('  ✗', e && e.message); process.exit(1); });
