/**
 * driveUploadRoundtripCut.test.js — 리뷰 캡처 업로드의 Drive 왕복 줄이기 회귀가드.
 *
 * 배경(2026-09-23 실측): 리뷰 캡처 제출 4.1초의 내역이
 *   폴더 조회 0.9초 · 업로드+공개 3.1초 · AI 0.14초(캐시 히트) · 나머지 0.2초 였다.
 *   Drive 는 파일 크기와 무관하게 **왕복 하나당 0.8~1.5초**(008)라, 줄일 것은
 *   파일 크기가 아니라 **말 거는 횟수**다.
 *
 * 고정하는 불변식:
 *   A. 같은 (부모, 이름) 서브폴더는 **한 번만** 묻는다(두 번째부터 캐시).
 *   B. 다른 폴더는 따로 묻는다(키가 뭉개지지 않는다).
 *   C. 업로드가 실패하면 그 폴더 캐시를 **그 자리에서 버린다**(죽은 폴더 ID 를 붙잡지 않는다 = 자가치유).
 *   D. `deferShare` 면 공개 권한을 **기다리지 않고** 뒤에서 건다 — 응답이 먼저 나간다.
 *   E. 인자를 안 주면 **종전대로 기다린다**(무회귀) — 미루기는 옵트인.
 *   F. 리뷰 캡처 경로만 `deferShare` 를 쓴다(다른 업로드 소비처 무변경).
 *
 * 실행: node tests/driveUploadRoundtripCut.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

/* ── 가짜 Drive 주입: OAuth env 를 비워 SA 하나만 쓰게 한다(호출 계수가 명확) ── */
delete process.env.DRIVE_OAUTH_CLIENT_ID;
delete process.env.DRIVE_OAUTH_CLIENT_SECRET;
delete process.env.DRIVE_OAUTH_REFRESH_TOKEN;

let CALLS = [];
let LIST_HIT = true;       // 폴더 검색이 찾았다고 할지
let UPLOAD_FAIL = false;

const fakeDrive = {
  files: {
    list: async () => {
      CALLS.push('folder.list');
      return { data: { files: LIST_HIT ? [{ id: 'FOLDER1', name: '포토' }] : [] } };
    },
    create: async (params) => {
      const isUpload = !!params.media;
      CALLS.push(isUpload ? 'file.create' : 'folder.create');
      if (isUpload && UPLOAD_FAIL) throw new Error('File not found: 404');
      return { data: { id: isUpload ? 'FILE1' : 'FOLDER1', name: params.requestBody.name, webViewLink: 'L' } };
    },
  },
  permissions: {
    create: async (params) => {
      CALLS.push(params.requestBody && params.requestBody.role === 'owner' ? 'owner.transfer' : 'share.public');
      await new Promise((r) => setTimeout(r, 15));
      return { data: {} };
    },
  },
  about: { get: async () => { CALLS.push('about'); return { data: { user: { emailAddress: 'sa@x' } } }; } },
};

const sheetsPath = require.resolve('../src/services/sheets.service');
require.cache[sheetsPath] = {
  id: sheetsPath, filename: sheetsPath, loaded: true,
  exports: { drive: fakeDrive, sheets: {}, throttledCall: async (f) => f(), driveThrottledCall: async (f) => f() },
};

const D = require('../src/services/drive.service');
const tick = () => new Promise((r) => setImmediate(() => setTimeout(r, 40)));

(async () => {
  /* ═══ A·B. 서브폴더 캐시 ═══ */
  console.log('\nA) 같은 폴더는 한 번만 묻는다');
  CALLS = [];
  const f1 = await D.getOrCreateSubFolder('PARENT_A', '포토');
  const firstCalls = CALLS.filter((c) => c.startsWith('folder.')).length;
  assert.ok(firstCalls >= 1, '첫 조회는 Drive 에 물어야 한다');
  ok(`첫 조회는 Drive 왕복 ${firstCalls}회`);

  CALLS = [];
  const f2 = await D.getOrCreateSubFolder('PARENT_A', '포토');
  assert.strictEqual(CALLS.filter((c) => c.startsWith('folder.')).length, 0,
    '두 번째 조회가 또 Drive 에 물었다 — 캐시가 동작하지 않는다');
  assert.strictEqual(f2.id, f1.id, '캐시가 다른 폴더를 돌려준다');
  ok('두 번째부터 Drive 왕복 0회(같은 폴더 반환)');

  console.log('\nB) 다른 폴더는 따로 묻는다');
  CALLS = [];
  await D.getOrCreateSubFolder('PARENT_A', '텍스트');
  assert.ok(CALLS.filter((c) => c.startsWith('folder.')).length >= 1, '이름이 다른데 캐시를 재사용했다');
  CALLS = [];
  await D.getOrCreateSubFolder('PARENT_B', '포토');
  assert.ok(CALLS.filter((c) => c.startsWith('folder.')).length >= 1, '부모가 다른데 캐시를 재사용했다');
  ok('부모·이름이 다르면 각각 조회한다(키 뭉개짐 없음)');

  /* ═══ C. 업로드 실패 = 캐시 자가치유 ═══ */
  console.log('\nC) 업로드가 실패하면 그 폴더 캐시를 버린다');
  UPLOAD_FAIL = true;
  await assert.rejects(
    () => D.uploadFileBase64('QUJD', 'a.jpg', 'image/jpeg', 'FOLDER1'),
    /404|not found/i, '업로드 실패가 그대로 올라와야 한다');
  UPLOAD_FAIL = false;

  CALLS = [];
  await D.getOrCreateSubFolder('PARENT_A', '포토');   // FOLDER1 을 가리키던 캐시
  assert.ok(CALLS.filter((c) => c.startsWith('folder.')).length >= 1,
    '업로드 실패 뒤에도 옛 폴더 ID 를 계속 돌려준다 — 폴더가 지워지면 영영 실패한다');
  ok('실패한 폴더를 가리키던 캐시가 비워져 다시 조회한다');

  const removed = D.invalidateSubFolderById('FOLDER1');
  assert.ok(typeof removed === 'number', '무효화 함수가 없다');
  ok('invalidateSubFolderById 로 수동 무효화도 가능');

  /* ═══ D·E. 공개 권한 미루기 ═══ */
  console.log('\nD) deferShare 면 공개를 기다리지 않는다');
  CALLS = [];
  const up = await D.uploadFileBase64('QUJD', 'b.jpg', 'image/jpeg', 'FOLDER9', { deferShare: true });
  assert.strictEqual(up.id, 'FILE1');
  assert.ok(CALLS.includes('file.create'), '업로드는 응답 전에 끝나야 한다');
  assert.ok(!CALLS.includes('share.public'),
    'deferShare 인데 공개 권한을 기다렸다 — 그 1초가 그대로 리뷰어 대기시간이 된다');
  ok('응답 시점에 공개 권한을 기다리지 않는다');

  assert.ok(!CALLS.includes('owner.transfer'),
    '소유권 보정을 기다렸다 — 한쪽만 미루면 남은 쪽의 await 사이에 미룬 쪽이 끼어들어 결국 기다린 셈이 된다');
  ok('소유권 보정도 함께 미룬다(뒷정리는 한 덩어리)');

  await tick();
  assert.ok(CALLS.includes('share.public'),
    '미룬 공개 권한이 끝내 걸리지 않았다 — 파일이 비공개로 남는다');
  assert.ok(CALLS.includes('owner.transfer'), '미룬 소유권 보정이 끝내 돌지 않았다');
  ok('응답 뒤에 공개 권한·소유권 보정이 실제로 걸린다(빠뜨리지 않는다)');

  console.log('\nE) 인자를 안 주면 종전대로 기다린다');
  CALLS = [];
  await D.uploadFileBase64('QUJD', 'c.jpg', 'image/jpeg', 'FOLDER9');
  assert.ok(CALLS.includes('share.public'),
    '기본 동작이 바뀌었다 — 미루기는 옵트인이어야 한다(다른 업로드 소비처 무회귀)');
  ok('기본값은 공개까지 기다린다(무회귀)');

  CALLS = [];
  await D.uploadFileBase64('QUJD', 'd.jpg', 'image/jpeg', 'FOLDER9', { shareAnyone: false, deferShare: true });
  await tick();
  assert.ok(!CALLS.includes('share.public'), '비공개 업로드가 공개로 바뀌었다');
  ok('shareAnyone:false 는 미루기와 무관하게 공개하지 않는다');

  /* ═══ F. 리뷰 캡처 경로만 ═══ */
  console.log('\nF) deferShare 는 리뷰 캡처 업로드에만');
  const srcDir = path.join(__dirname, '..', 'src');
  const hits = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (f.endsWith('.js') && !p.includes('drive.service')) {
        const t = fs.readFileSync(p, 'utf8');
        if (/deferShare/.test(t)) hits.push(path.relative(srcDir, p));
      }
    }
  })(srcDir);
  assert.deepStrictEqual(hits, ['routes/diag.routes.js'],
    `deferShare 사용처가 늘었다(${hits.join(', ')}) — 다른 업로드는 공개를 기다려야 한다`);
  ok('사용처는 리뷰 캡처 업로드 한 곳뿐');

  const diag = fs.readFileSync(path.join(srcDir, 'routes', 'diag.routes.js'), 'utf8');
  const m = /uploadFileBase64\(\s*\n\s*file\.data,[\s\S]{0,700}?\)\;/.exec(diag);
  assert.ok(m && /deferShare: true/.test(m[0]), '리뷰 캡처 업로드에 deferShare 가 붙어 있지 않다');
  ok('리뷰 캡처 업로드 호출에 deferShare: true');

  console.log(`\n✅ driveUploadRoundtripCut: ${n}건 통과`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ 실패:', e.message); process.exit(1); });
