/**
 * captureLinkBackfill.test.js — 구매 캡처 연결 복구(백필) 회귀가드.
 *
 * 고정하는 불변식(틀린 파일을 붙이면 **남의 캡처가 그 주문의 정산 증빙**이 된다):
 *   A. 판정 단일 출처 — 감사 라우트가 서비스를 그대로 태운다(사본 0). 응답 shape 하위호환.
 *   B. fail-closed — 시각 창 밖(low)·후보 여럿(ambiguous)·파일 없음은 **자동 대상 아님**.
 *   C. 미리보기는 쓰기 0건 · `confirm !== true` 도 쓰기 0건.
 *   D. 쓰기 표면 = capture_file_id · capture_uploaded_at 두 칸뿐 · Drive 는 읽기만.
 *   E. 시각은 NOW 가 아니라 **그 파일이 올라간 실제 시각**.
 *   F. 한 파일이 여러 주문에 붙지 않는다 · 그 사이 리뷰어가 보완 첨부했으면 그쪽이 이긴다.
 *
 * 실행: node tests/captureLinkBackfill.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const front = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');

let n = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? ' :: ' + extra : '')); n++; console.log('  ok   ' + name); };

const SVC = require('../src/services/captureLinkBackfill.service');
const SRC = read('src/services/captureLinkBackfill.service.js');
const DIAG = read('src/routes/diag.routes.js');
const TB = read('src/routes/trackB.routes.js');
const AS = front('js/admin-settings.js');

const NOW = Date.now();
const SUBMITTED = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();   // 3시간 전 제출

/** 스텁 — 쿼리를 전부 기록해 "쓰기 0건"을 실행으로 확인한다. */
function stub({ orders, folderUrl = 'https://drive.google.com/drive/folders/FOLDER', files, dupRows = [], updRow = 1, lock }) {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/app_settings/.test(sql)) return { rows: [{ value: new Date(NOW - 30 * 86400000).toISOString() }] };
      if (/FROM order_submissions os/.test(sql)) return { rows: orders };
      if (/capture_folder_url FROM tab_configs/.test(sql)) return { rows: [{ capture_folder_url: folderUrl }] };
      if (/SELECT id FROM order_submissions/.test(sql)) return { rows: dupRows };
      if (/^UPDATE order_submissions/.test(sql.trim())) return { rowCount: updRow };
      return { rows: [] };
    },
  };
  const drive = {
    extractFolderIdFromUrl: (u) => (u ? 'FOLDER' : null),
    listFolderFilesRecursive: async () => files,
  };
  // 기본은 '락을 잡은' 갈래(fn 을 그대로 실행) — 경합 갈래는 그 케이스에서 따로 주입한다.
  SVC.__setDepsForTest(pool, drive, lock || (async (name, fn) => fn()));
  return calls;
}
const writes = (calls) => calls.filter(c => /^(UPDATE|INSERT|DELETE)\b/i.test(c.sql));
const order = (over) => ({ id: 'o1', sheetId: 's1', tabName: 'T1', recipient: '김신혜', orderer: '김신혜',
                           submittedAt: SUBMITTED, preCutoff: false, hasOpenLog: true, ...over });
const file = (over) => ({ id: 'F1', name: '김신혜.jpg', mimeType: 'image/jpeg',
                          createdTime: new Date(NOW - 3 * 60 * 60 * 1000 + 60000).toISOString(), ...over });

(async () => {
  console.log('\nA) 판정 단일 출처');
  ok('감사 라우트가 서비스를 태운다(사본 0)',
    /captureLinkBackfill\.auditCaptureLinks\(/.test(DIAG) && !/listFolderFilesRecursive/.test(DIAG));
  {
    /* ★ 문자열 grep 이 아니라 **핸들러를 실제로 실행**해 응답 키를 대조한다 —
       화면(workdesk `_auditNoCapture`)이 s.attachedHigh · preCutoff · legacy 를 읽는다. */
    stub({ orders: [order(), order({ id: 'o2', preCutoff: true })], files: [file(), file({ id: 'F2', name: '김신혜.png', mimeType: 'image/png' })] });
    const diagRouter = require('../src/routes/diag.routes');
    const layer = diagRouter.stack.find(l => l.route && l.route.path === '/no-capture-audit');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    let body = null;
    await handler({ query: { days: 30 } }, { json: (x) => { body = x; } }, (e) => { throw e; });
    ok('감사 응답 계약 — ok·summary·current·legacy·note·items·cutoff',
      body && body.ok === true && body.summary && body.current && body.legacy
      && typeof body.note === 'string' && Array.isArray(body.items) && 'cutoff' in body);
    ok('★ 화면이 읽는 필드가 살아 있다(attachedHigh · preCutoff)',
      typeof body.summary.attachedButUnlinked === 'number'
      && body.items.some(x => 'preCutoff' in x));
    ok('★ 0건이면 종전처럼 조기 반환(scanned:0 · summary:{} · items:[])', /scanned: 0, summary: \{\}, items: \[\]/.test(DIAG));
  }
  {
    const i = TB.indexOf("router.get('/capture-link/audit'");
    const j = TB.indexOf("router.post('/capture-link/backfill'");
    ok('Track B 경로 2개 — 둘 다 adminOrMaster(감사와 같은 게이트)',
      i > 0 && j > 0
      && /authMiddleware, adminOrMasterMiddleware/.test(TB.slice(i, i + 120))
      && /authMiddleware, adminOrMasterMiddleware/.test(TB.slice(j, j + 120)));
  }

  /* ★★ 스텁 pool 은 SQL 을 해석하지 않는다 — 대상 선정 조건이 빠지는 변이는 실행으로 못 잡는다.
     쓰기 쪽처럼 **문장으로 고정**한다(취소된 주문·이미 연결된 주문·갓 제출한 주문 제외). */
  ok('★ 대상 선정 SQL — capture_uploaded_at IS NULL · deleted_at IS NULL · 20분 경과',
    /os\.deleted_at IS NULL AND os\.capture_uploaded_at IS NULL/.test(SRC)
    && /os\.submitted_at < NOW\(\) - interval '20 minutes'/.test(SRC));

  {
    /* ★★ 탭 리네임 폴백 (2026-08-20 실측) — 시트 탭은 건수가 바뀌며 이름이 바뀐다
       (`…_500건` → `…_443건`). 주문 원장은 제출 당시 이름을 들고 있어 **이름으로만 조인하면
       폴더가 멀쩡히 있는데 `no_capture_folder`** 로 떨어진다. gid 로도 찾아야 한다. */
    ok('★ 폴더 조회에 gid 폴백이 있다(이름 우선)',
      /WHERE sheet_id = \$1 AND \(tab_name = \$2 OR \(\$3 <> '' AND tab_gid = \$3\)\)/.test(SRC)
      && /ORDER BY \(tab_name = \$2\) DESC/.test(SRC));
    ok('★ 빈 gid 는 절을 켜지 않는다(켜면 gid 없는 행이 전부 매칭)', /\$3 <> ''/.test(SRC));
    ok('★ 주문의 tab_gid 를 실제로 읽는다', /os\.tab_gid AS "tabGid"/.test(SRC));
    // 실행으로 확인 — 이름이 바뀐 탭도 폴더를 찾아 판정이 unknown 에서 벗어난다
    let seenParams = null;
    const pool = { query: async (sql, params) => {
      if (/app_settings/.test(sql)) return { rows: [] };
      if (/FROM order_submissions os/.test(sql)) return { rows: [order({ tabGid: '777', tabName: '옛이름_500건' })] };
      if (/capture_folder_url FROM tab_configs/.test(sql)) {
        seenParams = params;
        // 이름은 안 맞지만 gid 로 찾은 상황을 흉내낸다
        return { rows: [{ capture_folder_url: 'https://drive.google.com/drive/folders/F' }] };
      }
      return { rows: [] };
    } };
    SVC.__setDepsForTest(pool, { extractFolderIdFromUrl: () => 'F', listFolderFilesRecursive: async () => [file()] },
                         async (n, fn) => fn());
    const r = await SVC.auditCaptureLinks({ days: 30 });
    ok('★★ 리네임된 탭도 gid 로 폴더를 찾아 판정된다(unknown 아님)',
      r.items[0].verdict === 'attachedButUnlinked', r.items[0].verdict + '/' + (r.items[0].reason || ''));
    ok('★ gid 를 조회 파라미터로 넘긴다', seenParams && seenParams[2] === '777', JSON.stringify(seenParams));
    SVC.__setDepsForTest(null, null, null);
  }

  console.log('\nB) fail-closed — 무엇을 자동으로 붙이지 않는가');
  {
    const hi = { verdict: 'attachedButUnlinked', confidence: 'high', fileId: 'F1', winCandidates: 1, candidates: 1 };
    ok('시각 창 안 · 후보 유일 → 대상', SVC.backfillEligibility(hi).ok === true);
    ok('★ 시각 창 밖(low)은 기본 제외',
      SVC.backfillEligibility({ ...hi, confidence: 'low' }).reason === 'low_confidence');
    ok('★ low 는 명시 옵션으로만 열린다(그때도 후보 유일 조건은 남는다)',
      SVC.backfillEligibility({ ...hi, confidence: 'low', candidates: 1 }, { allowLow: true }).ok === true
      && SVC.backfillEligibility({ ...hi, confidence: 'low', candidates: 2 }, { allowLow: true }).reason === 'ambiguous');
    ok('★★ 후보가 여럿이면 붙이지 않는다(어느 것인지 정할 근거가 없다)',
      SVC.backfillEligibility({ ...hi, winCandidates: 2 }).reason === 'ambiguous');
    ok('파일 없음·판정 보류는 대상 아님',
      SVC.backfillEligibility({ verdict: 'notAttached' }).reason === 'not_attached'
      && SVC.backfillEligibility({ verdict: 'unknown' }).reason === 'not_attached');
    ok('fileId 가 없으면 붙이지 않는다', SVC.backfillEligibility({ ...hi, fileId: '' }).reason === 'no_file_id');
  }

  {
    /* ★★★ 역-유일성 — 같은 수취인이 같은 탭에 20분 간격으로 두 번 제출하면 파일 하나가
       **두 주문의 시각 창에 모두** 들어간다. 그대로 두면 나중 주문이 먼저 가져가 진짜 주인의
       증빙이 뒤바뀐다(코드리뷰가 잡은 오연결 경로). 한 파일을 둘이 노리면 **양쪽 다** 제외. */
    const o1 = order({ id: 'oA', submittedAt: new Date(NOW - 3 * 3600000).toISOString() });
    const o2 = order({ id: 'oB', submittedAt: new Date(NOW - 3 * 3600000 + 20 * 60000).toISOString() });
    const calls = stub({ orders: [o1, o2], files: [file()] });
    const r = await SVC.backfillCaptureLinks({ days: 30, dryRun: false, confirm: true });
    ok('★★★ 한 파일을 두 주문이 노리면 양쪽 다 붙이지 않는다',
      r.linked === 0 && r.planned === 0 && writes(calls).length === 0
      && r.skippedItems.filter(x => x.skip === 'ambiguous_file').length === 2);
  }
  {
    /* ★★ 주문자 이름으로만 걸린 파일 — 파일명 첫 토큰은 **항상 수취인**이라 그 파일은 대개
       "그 이름이 수취인인 다른 주문"의 캡처다. 수취인이 있는 주문에서는 자동 근거가 못 된다. */
    const it = { verdict: 'attachedButUnlinked', confidence: 'high', fileId: 'F1',
                 winCandidates: 1, candidates: 1, matchedBy: 'orderer', hasRecipient: true };
    ok('★★ 주문자 매칭만으로는 붙이지 않는다', SVC.backfillEligibility(it).reason === 'orderer_only');
    ok('★ 수취인이 빈 주문에서는 주문자 매칭이 정당하다',
      SVC.backfillEligibility({ ...it, hasRecipient: false }).ok === true);
  }

  console.log('\nC) 미리보기는 쓰기 0건');
  {
    let calls = stub({ orders: [order()], files: [file()] });
    const r = await SVC.backfillCaptureLinks({ days: 30 });          // dryRun 기본
    ok('미리보기: 연결 예정 1건 · DB 쓰기 0건', r.planned === 1 && r.linked === 0 && writes(calls).length === 0);
    ok('미리보기는 dryRun 을 응답에 밝힌다', r.dryRun === true);

    calls = stub({ orders: [order()], files: [file()] });
    const r2 = await SVC.backfillCaptureLinks({ days: 30, dryRun: false });   // confirm 없음
    ok('★ confirm 없이 dryRun:false 만 와도 쓰기 0건', r2.linked === 0 && writes(calls).length === 0);
  }

  console.log('\nD~F) 실행 — 무엇을 어떻게 쓰는가');
  {
    const f = file();
    const calls = stub({ orders: [order()], files: [f] });
    const r = await SVC.backfillCaptureLinks({ days: 30, dryRun: false, confirm: true, by: '망고' });
    ok('연결 1건', r.linked === 1);
    const w = writes(calls);
    /* ★ 운영 테이블 쓰기는 `order_submissions` UPDATE 한 문장뿐 —
       나머지 한 건은 되돌릴 근거를 남기는 `app_settings` 이력(신규 테이블 0)이다. */
    const opWrites = w.filter(x => !/app_settings/.test(x.sql));
    ok('운영 테이블 쓰기는 UPDATE 한 문장뿐',
      opWrites.length === 1 && /^UPDATE order_submissions/.test(opWrites[0].sql));
    ok('★ 이력은 app_settings 한 곳에만 쌓는다',
      w.filter(x => /app_settings/.test(x.sql)).every(x => /capture_link_backfill_log/.test(x.sql)));
    w.length = 0; w.push(...opWrites);   // 아래 단언은 운영 쓰기만 본다
    ok('★ 쓰기 표면 = capture_file_id · capture_uploaded_at 두 칸뿐',
      /SET capture_file_id = \$2, capture_uploaded_at = COALESCE\(\$3::timestamptz, NOW\(\)\)/.test(w[0].sql));
    ok('★ 이미 연결된 주문은 덮지 않는다(조건부 UPDATE)',
      /WHERE id = \$1 AND capture_uploaded_at IS NULL AND deleted_at IS NULL/.test(w[0].sql));
    ok('★ 시각은 NOW 가 아니라 그 파일이 올라간 실제 시각', w[0].params[2] === f.createdTime);
    ok('Drive 는 읽기만(서비스에 생성·이동·삭제 호출 0)',
      !/uploadFileBase64|createFolder|trashFiles|trashDuplicateFile|moveFile/.test(SRC));
    ok('시트·장부·정원 무접촉', !/review_index|campaign_participants|raw_sheet|recruit_campaigns/.test(SRC));
  }
  {
    const calls = stub({ orders: [order()], files: [file()], dupRows: [{ id: 'other' }] });
    const r = await SVC.backfillCaptureLinks({ days: 30, dryRun: false, confirm: true });
    ok('★★ 한 파일이 여러 주문에 붙지 않는다(이미 쓰는 주문이 있으면 건너뜀)',
      r.linked === 0 && r.conflicts === 1 && writes(calls).length === 0);
  }
  {
    stub({ orders: [order()], files: [file()], updRow: 0 });
    const r = await SVC.backfillCaptureLinks({ days: 30, dryRun: false, confirm: true });
    ok('★ 그 사이 리뷰어가 보완 첨부했으면 그쪽이 이긴다(경합 0행 = raced)',
      r.linked === 0 && r.raced === 1);
  }
  {
    // 이름이 같은 파일이 창 안에 둘 → 모호 → 붙이지 않는다(실행으로)
    const calls = stub({ orders: [order()], files: [file(), file({ id: 'F2', name: '김신혜.png', mimeType: 'image/png' })] });
    const r = await SVC.backfillCaptureLinks({ days: 30, dryRun: false, confirm: true });
    ok('★★ 같은 이름 파일이 둘이면 실행에서도 안 붙는다',
      r.linked === 0 && r.planned === 0 && writes(calls).length === 0);
  }
  {
    // 이름이 다른 파일뿐 → notAttached(리뷰어 재요청 대상)
    stub({ orders: [order()], files: [file({ id: 'FX', name: '박다른.jpg' })] });
    const r = await SVC.auditCaptureLinks({ days: 30 });
    ok('파일 없음은 notAttached 로 분류(복구 불가 — 리뷰어 재요청)', r.items[0].verdict === 'notAttached');
  }
  {
    // 폴더 미연결 → unknown(오판 금지)
    stub({ orders: [order()], folderUrl: '', files: [] });
    const r = await SVC.auditCaptureLinks({ days: 30 });
    ok('폴더 미연결은 unknown(오판 금지)', r.items[0].verdict === 'unknown' && r.items[0].reason === 'no_capture_folder');
  }
  {
    // 컷오프 이전(legacy)도 **복구 대상**이다 — 그때는 링크 코드가 없어 미링크가 정상이었다
    stub({ orders: [order({ preCutoff: true })], files: [file()] });
    const r = await SVC.backfillCaptureLinks({ days: 3650 });
    ok('★ 배포 이전(legacy) 건도 복구 대상에서 빼지 않는다(오히려 주 대상)', r.planned === 1);
  }
  SVC.__setDepsForTest(null, null, null);

  {
    // ★ 동시 실행 직렬화 — 락을 못 잡으면 쓰기 0건 + 그 사실을 말한다(조용한 no-op 금지)
    ok('★ 실행은 advisory lock 으로 직렬화된다',
      /lock\(\)\('capture_link_backfill'/.test(SRC) && /withJobLock/.test(SRC));
    // 경합 갈래를 **실제로 실행**한다(락을 못 잡은 상황 주입)
    const calls = stub({ orders: [order()], files: [file()],
                         lock: async (name, fn, o) => (o && o.onBusy ? o.onBusy() : false) });
    const rBusy = await SVC.backfillCaptureLinks({ days: 30, dryRun: false, confirm: true });
    ok('★ 락 경합이면 쓰기 0건 + busy 를 알린다(조용한 no-op 금지)',
      rBusy.busy === true && rBusy.linked === 0 && writes(calls).length === 0 && !!rBusy.error);
    ok('★ 되돌릴 근거를 남긴다(어느 주문에 어느 파일을 붙였나)',
      /capture_link_backfill_log/.test(SRC) && /ids: \(result\.plannedItems \|\| \[\]\)\.filter\(x => x\._linked\)/.test(SRC));
    ok('★ 이력 기록 실패가 본작업을 죽이지 않는다', /이력 기록 실패\(무시\)/.test(SRC));
    SVC.__setDepsForTest(null, null, null);
  }

  console.log('\nG) 화면 — 미리보기 → 확인 → 실행');
  ok('설정 패널이 등록됐다(양쪽 화면 공용 모듈)',
    /capturelink: _captureLinkHtml/.test(AS) && /capturelink: loadCaptureLinkBackfill/.test(AS)
    && /capturelink: \{ ic: '📎'/.test(AS));
  /* ★★ 등록만으로는 **사람이 열 수 없다** — mount(elId,{panels:[...]}) 가 그 목록만 그리고,
     목차 토글도 그린 것만 본다. 실제로 코드리뷰가 이 구멍을 잡았다(서버·가드는 다 있는데 창구 0).
     그래서 두 호스트의 panels 배열에 키가 있는지까지 본다. */
  const ADM = front('admin.html'), WD = front('workdesk.html');
  {
    const admCall = ADM.slice(ADM.indexOf("AdminSettings.mount('adminSettingsMount'"), ADM.indexOf("AdminSettings.mount('adminSettingsMount'") + 260);
    const wdCall = WD.slice(WD.indexOf("AdminSettings.mount('adminSettingsMount'"), WD.indexOf("AdminSettings.mount('adminSettingsMount'") + 320);
    ok("★★ 관리자 대시보드가 이 패널을 실제로 마운트한다", /'capturelink'/.test(admCall));
    ok("★★ 리뷰웹시스템[3버전]도 마운트한다(한쪽만 넣으면 화면이 갈린다)", /'capturelink'/.test(wdCall));
    // AE 목록에는 넣지 않는다 — 서버가 adminOrMaster 라 눌러도 403 인 죽은 버튼이 된다.
    const aePart = wdCall.slice(wdCall.indexOf(':', wdCall.indexOf('isAdmin ?')));
    ok('★ AE 목록에는 넣지 않는다(서버 게이트와 1:1 — 죽은 버튼 금지)', !/'capturelink'/.test(aePart));
  }
  {
    /* ★★★ 일반 규칙 — **등록만 하고 마운트를 빠뜨리는 실수**를 이 자리에서 끝낸다.
       `PANELS` 에 있어도 어느 호스트의 `mount({panels:[...]})` 에도 없으면 사람이 열 방법이 없다
       (실제로 capturelink 가 그랬고, [✅ 리뷰타입 정리]는 그 상태로 오래 방치돼 있었다).
       ★ 어느 호스트에 두는지는 기능마다 다르므로 **최소 한 곳**만 요구한다. */
    const hosts = ADM + '\n' + WD + '\n' + front('admin-siand.html');
    const keys = (/var PANELS = \{([^}]*)\}/.exec(AS) || [, ''])[1]
      .split(',').map(x => x.split(':')[0].trim()).filter(Boolean);
    ok('PANELS 키를 읽었다(3개 이상)', keys.length >= 3, keys.join('|'));
    const orphan = keys.filter(k => !new RegExp("'" + k + "'").test(hosts));
    ok('★★★ 등록된 설정 패널은 어느 호스트든 최소 한 곳에서 마운트된다(도달 불가 패널 0)',
      orphan.length === 0, '마운트 안 된 패널: ' + orphan.join(', '));
  }
  ok('실행 핸들러가 전역에 노출된다(onclick 에서 부른다)', /window\.captureLinkRun = captureLinkRun/.test(AS));
  {
    const fn = AS.slice(AS.indexOf('async function captureLinkRun'), AS.indexOf('function loadCaptureLinkBackfill'));
    ok('미리보기는 dryRun:true · 실행은 confirm:true 를 함께 보낸다',
      /dryRun: !!dryRun, confirm: !dryRun/.test(fn));
    ok('★ 실행은 confirm() 을 거친다', /if \(!dryRun && !confirm\(/.test(fn));
    ok('★ 미리보기 전에는 실행 버튼이 없다(연결 가능 0건이면 계속 숨김)',
      /style="display:none" onclick="captureLinkRun\(false\)"/.test(AS)
      && /applyBtn\.style\.display = \(j\.planned > 0\) \? '' : 'none'/.test(fn));
    ok('★ 파일 없는 건은 "리뷰어 재요청"이라고 화면이 말한다(조용한 누락 금지)',
      /리뷰어에게 다시 요청/.test(fn) && /notAttached/.test(fn));
    ok('서버발 문자열은 escape 한다(작업명·수취인·파일명)',
      /escHtml\(x\.tabName/.test(fn) && /escHtml\(x\.recipient/.test(fn) && /escHtml\(x\.file/.test(fn));
    ok('★ 펼칠 때 자동 실행하지 않는다(Drive 를 훑는 작업)',
      /function loadCaptureLinkBackfill\(\) \{ _setNavBadge\('capturelink', '점검'\); \}/.test(AS));
  }

  console.log(`\n${n} checks passed`);
  process.exit(0);
})();
