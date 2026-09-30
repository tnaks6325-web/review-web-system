/**
 * driveDownloadSingleRoundtrip.test.js — Drive 이미지 프록시 왕복 회귀가드
 *
 * 배경: `downloadFile` 이 파일 1장마다 files.get 을 **두 번**(메타 + 본문) 쳐서
 *       31KB 리뷰 캡처 한 장이 실측 2.0~2.6초였다(크기 무관 = 왕복 지연이 지배).
 *       media 응답 헤더의 content-type 이 곧 그 파일의 mime 이므로 메타는 불필요.
 *
 * [A] 기본 경로 = 왕복 1회 (헤더에서 mime·파일명)
 * [B] 헤더가 없으면 메타 폴백 (헤더만 믿고 octet-stream 으로 접는 조용한 회귀 차단)
 * [C] 계약 불변 — {buffer, mimeType, name}, name 폴백 순서
 * [D] 소비처 5곳이 `.name` 을 쓰지 않는다(계약 좁히기 사고 차단) + 스텁 가드 무결합
 *
 * 실행: node tests/driveDownloadSingleRoundtrip.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

/* ── 가짜 Drive 클라이언트 주입 ──────────────────────────────
   drive.service 는 읽기 클라이언트를 sheets.service 의 `drive` 로 가져온다.
   OAuth env 를 비워 두면 clients = [SA 하나] 가 되어 호출 계수가 명확해진다. */
delete process.env.DRIVE_OAUTH_CLIENT_ID;
delete process.env.DRIVE_OAUTH_CLIENT_SECRET;
delete process.env.DRIVE_OAUTH_REFRESH_TOKEN;

let CALLS = [];
let MEDIA_HEADERS = {};
let META = { mimeType: 'image/png', name: '메타이름.png' };
let METAFAIL = false;

const fakeDrive = {
  files: {
    get: async (params) => {
      CALLS.push(params.alt === 'media' ? 'media' : 'meta');
      if (params.alt === 'media') return { data: Buffer.from('IMGDATA'), headers: MEDIA_HEADERS };
      if (METAFAIL) throw new Error('meta 실패');
      return { data: META };
    },
  },
};

const sheetsPath = require.resolve('../src/services/sheets.service');
require.cache[sheetsPath] = {
  id: sheetsPath, filename: sheetsPath, loaded: true,
  exports: { drive: fakeDrive, sheets: {}, throttledCall: async (f) => f() },
};

const DS = require('../src/services/drive.service');

function reset(headers, meta, metaFail) {
  CALLS = [];
  MEDIA_HEADERS = headers || {};
  META = meta || { mimeType: 'image/png', name: '메타이름.png' };
  METAFAIL = !!metaFail;
}

(async () => {
  console.log('\n▶ driveDownloadSingleRoundtrip 회귀가드\n');

  // ── A. 기본 경로 = 왕복 1회 ────────────────────────────────
  {
    reset({ 'content-type': 'image/jpeg', 'content-disposition': 'attachment; filename="캡처.jpg"' });
    const f = await DS.downloadFile('FILEID_0000000000000000001');
    assert.deepStrictEqual(CALLS, ['media'], `기본 경로는 Drive 왕복 1회여야 한다 (실제: ${JSON.stringify(CALLS)})`);
    assert.strictEqual(f.mimeType, 'image/jpeg', 'mime 은 media 응답 헤더에서 읽는다');
    assert.strictEqual(f.buffer.toString(), 'IMGDATA', '본문 버퍼');
    ok('A1: 헤더로 mime 해석 — files.get 1회 (메타 조회 없음)');
  }
  {
    reset({ 'content-type': 'image/jpeg; charset=binary' });
    const f = await DS.downloadFile('FILEID_0000000000000000002');
    assert.strictEqual(f.mimeType, 'image/jpeg', 'content-type 의 파라미터(charset 등)는 잘라낸다');
    ok('A2: content-type 파라미터 절단');
  }

  // ── B. 헤더 없음 → 메타 폴백(fail-safe) ────────────────────
  {
    reset({}, { mimeType: 'image/png', name: 'meta.png' });
    const f = await DS.downloadFile('FILEID_0000000000000000003');
    assert.deepStrictEqual(CALLS, ['media', 'meta'], '헤더에 mime 이 없으면 메타 1회 폴백');
    assert.strictEqual(f.mimeType, 'image/png', '폴백은 종전 동작(메타의 mimeType)을 복원한다');
    ok('B1: content-type 부재 → 메타 폴백 (octet-stream 으로 조용히 접지 않는다)');
  }
  {
    reset({}, null, true); // 메타까지 실패
    const f = await DS.downloadFile('FILEID_0000000000000000004');
    assert.strictEqual(f.mimeType, 'application/octet-stream', '메타까지 실패하면 최후 기본값');
    assert.strictEqual(f.buffer.toString(), 'IMGDATA', '메타 실패가 본문을 버리지 않는다');
    ok('B2: 메타 폴백 실패해도 본문은 돌려준다');
  }

  // ── C. 계약 불변 ───────────────────────────────────────────
  {
    reset({ 'content-type': 'image/jpeg', 'content-disposition': "attachment; filename*=UTF-8''%ED%95%9C%EA%B8%80.jpg" });
    const f = await DS.downloadFile('FILEID_0000000000000000005');
    assert.strictEqual(f.name, '한글.jpg', 'RFC 5987 filename* 디코드');
    assert.deepStrictEqual(CALLS, ['media'], '파일명까지 헤더에 있으면 여전히 왕복 1회');
    ok('C1: name — content-disposition 우선');
  }
  {
    reset({ 'content-type': 'image/jpeg' }, { mimeType: 'image/jpeg', name: 'meta.jpg' });
    const f = await DS.downloadFile('FILEID_0000000000000000006');
    assert.strictEqual(f.name, 'meta.jpg', 'disposition 없으면 메타 name');
    ok('C2: name — 메타 폴백 (계약 좁히지 않음)');
  }
  {
    reset({ 'content-type': 'image/jpeg' }, null, true);
    const f = await DS.downloadFile('FILEID_0000000000000000007');
    assert.strictEqual(f.name, 'FILEID_0000000000000000007', '이름을 못 구하면 fileId (종전과 동일)');
    assert.ok(Buffer.isBuffer(f.buffer) && typeof f.mimeType === 'string' && typeof f.name === 'string',
      '반환 shape {buffer, mimeType, name} 불변');
    ok('C3: name — fileId 최후 폴백 + 반환 shape 불변');
  }

  // ── D. 소비처 계약 ─────────────────────────────────────────
  {
    const consumers = [
      'src/routes/drive.routes.js',
      'src/routes/order.routes.js',
      'src/services/fileRoute.service.js',
      'src/services/reviewInspect.service.js',
    ];
    let seen = 0;
    for (const c of consumers) {
      const s = read(c);
      const idxs = [];
      let i = s.indexOf('downloadFile(');
      while (i >= 0) { idxs.push(i); i = s.indexOf('downloadFile(', i + 1); }
      for (const at of idxs) {
        const win = s.slice(at, at + 600);
        assert.ok(!/\bf\.name\b/.test(win),
          `${c} — downloadFile 결과의 .name 을 쓰면 안 된다(계약상 fileId 폴백이 섞인다)`);
        seen++;
      }
    }
    assert.ok(seen >= 5, `downloadFile 소비처 5곳 이상을 검사해야 한다 (실제 ${seen})`);
    ok(`D1: 소비처 ${seen}곳 — .name 미사용 확인`);
  }
  {
    const ds = read('src/services/drive.service.js');
    const m = /async function downloadFile\(fileId\)[\s\S]*?\n}/.exec(ds);
    assert.ok(m, 'downloadFile 본문을 찾지 못했다');
    const body = m[0];
    const first = body.indexOf('files.get(');
    const firstCall = body.slice(first, first + 200);
    assert.ok(/alt:\s*'media'/.test(firstCall),
      '첫 Drive 호출은 본문(alt:media)이어야 한다 — 메타를 앞세우면 왕복이 다시 2회가 된다');
    assert.ok(/res\.headers/.test(body) && /content-type/.test(body),
      'mime 을 응답 헤더에서 읽어야 한다');
    assert.ok(/fields:\s*'mimeType, name'/.test(body),
      '헤더 실패 시 메타 폴백이 남아 있어야 한다');
    ok('D2: 호출 순서 — media 먼저, 메타는 폴백으로만');
  }
  {
    // 스텁 가드 2종은 downloadFile 을 통째로 대체한다(내부 구조 무결합)
    for (const g of ['tests/sampleAccumulateRoute.test.js', 'tests/inspectTypeActions.test.js']) {
      assert.ok(/downloadFile:\s*async/.test(read(g)), `${g} — downloadFile 스텁 유지`);
    }
    ok('D3: 인접 가드 2종 — 스텁 방식이라 이 변경과 무결합');
  }

  console.log(`\n✅ driveDownloadSingleRoundtrip 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
