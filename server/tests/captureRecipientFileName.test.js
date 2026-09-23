/**
 * captureRecipientFileName.test.js — 리뷰 캡처 파일명 = 그 건의 **수취인** 회귀가드.
 *
 * 왜 있나(2026-09-22 실사고): 타계정 참여 3건이 Drive 에 전부 **주문자(로그인 본계정)** 이름으로
 * 쌓여 어떤 타계정의 리뷰인지 구분할 수 없었다. 원인 두 겹 —
 *   ㉮ 무시트 장부 재생성(sheetlessLedger)이 `review_index.recipient_name` 을 **안 채워서**
 *      프론트의 "수취인 우선" 규칙이 항상 주문자로 폴백했다(시트 기반 빌더에는 있던 칸).
 *   ㉯ 파일명 이름을 **화면이 골라 보내** 창구마다 기준이 갈렸다(작업보드 [📎 리뷰 대신 제출]은
 *      참여자 이름만 보낸다).
 *
 * 고정하는 불변식:
 *   A. 해석 단일 출처 — `captureOwnerName.recipientNameForRow` 하나. 순서 = 검색 명단 →
 *      작업표 → 주문 원장. 좌표 없음·조회 실패 = null(fail-soft, 업로드를 막지 않는다).
 *   B. 읽기 전용 — 쓰기 문장 0.
 *   C. 서버가 정한다 — `/review-upload` 가 `generateReviewFileName` 에 화면이 보낸
 *      `reviewerName` 을 직접 넘기지 않는다. 못 찾을 때만 그 값으로 접는다.
 *   D. `reviewerName` 자체는 무접촉 — 원장·알림·검수는 계속 참여자 기준(파일명만 바뀐다).
 *   E. 사본 0 — 교체 승인 rename 도 같은 함수를 쓴다(한쪽만 참여자 이름이면 "교체하면
 *      이름이 바뀌는" 드리프트).
 *   F. 파일명 모양 불변 — `{이름}_{순번}_{타임스탬프}` 왕복(정리 도구의 이름↔행 매칭 생존).
 *   G. 장부에 수취인 합류 — INSERT 컬럼 ≡ 자리표시자 ≡ 파라미터 계수, 값은 파서가 준 것.
 *   H. 구매(주문) 캡처는 무접촉 — 이미 수취인 기준이라 건드리지 않는다.
 *
 * 실행: node tests/captureRecipientFileName.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const srv = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const front = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let n = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? ' :: ' + extra : '')); n++; console.log('  ✓ ' + name); };

const SVC = require('../src/services/captureOwnerName.service');
const SVC_SRC = srv('src/services/captureOwnerName.service.js');
const DIAG = srv('src/routes/diag.routes.js');
const REDIT = srv('src/routes/reviewEdit.routes.js');
const LEDGER = srv('src/services/sheetlessLedger.service.js');
const TB = srv('src/routes/trackB.routes.js');
const DRIVE = srv('src/services/drive.service.js');

/** 스텁 pool — 쿼리를 전부 기록해 "쓰기 0건"을 실행으로 확인한다. */
function stub(rowsOrThrow) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (rowsOrThrow instanceof Error) throw rowsOrThrow;
      return { rows: rowsOrThrow };
    },
  };
}
const writes = (calls) => calls.filter(c => /\b(INSERT|UPDATE|DELETE\s+FROM)\b/i.test(c.sql));

/** 해석 순서를 실제 SQL(COALESCE) 로 흉내 내는 스텁 — 세 출처 중 살아있는 첫 값을 돌려준다. */
function sourcesStub({ index = null, worktable = null, order = null } = {}) {
  const pick = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };
  return stub([{ name: pick(index) || pick(worktable) || pick(order) }]);
}

async function run() {
  console.log('\n[A] 해석 단일 출처 — 순서 · fail-soft');
  {
    const db1 = sourcesStub({ index: '김석진', worktable: '허다은', order: '허다은' });
    ok('① 검색 명단의 수취인이 최우선',
      (await SVC.recipientNameForRow({ db: db1, sheetId: 'S', tabName: 'T', rowIndex: 80 })) === '김석진');

    const db2 = sourcesStub({ index: null, worktable: '김분자', order: '허다은' });
    ok('② 명단이 비면 작업표 수취인(무시트 작업의 정상 경로)',
      (await SVC.recipientNameForRow({ db: db2, sheetId: 'S', tabName: 'T', rowIndex: 198 })) === '김분자');

    const db3 = sourcesStub({ index: '   ', worktable: '', order: '허다은' });
    ok('③ 둘 다 비면 주문 원장의 수취인 (공백만 있는 값은 빈 값으로 본다)',
      (await SVC.recipientNameForRow({ db: db3, sheetId: 'S', tabName: 'T', rowIndex: 301 })) === '허다은');

    const db4 = sourcesStub({});
    ok('★ 어디에도 없으면 null — 이름을 지어내지 않는다',
      (await SVC.recipientNameForRow({ db: db4, sheetId: 'S', tabName: 'T', rowIndex: 1 })) === null);
  }
  {
    const boom = stub(new Error('42P01 relation does not exist'));
    ok('★★ 조회 실패 = null (fail-soft — 파일명 때문에 제출이 죽으면 안 된다)',
      (await SVC.recipientNameForRow({ db: boom, sheetId: 'S', tabName: 'T', rowIndex: 1 })) === null);

    const noRow = stub([{ name: '김석진' }]);
    ok('★ 줄 번호가 없으면 조회조차 하지 않는다(그 행을 특정할 수 없다)',
      (await SVC.recipientNameForRow({ db: noRow, sheetId: 'S', tabName: 'T', rowIndex: null })) === null
      && noRow.calls.length === 0);

    const noTab = stub([{ name: '김석진' }]);
    ok('★ 작업 좌표가 없으면 조회하지 않는다',
      (await SVC.recipientNameForRow({ db: noTab, sheetId: '', tabName: 'T', rowIndex: 3 })) === null
      && noTab.calls.length === 0);

    ok('★ db 가 없어도 던지지 않는다',
      (await SVC.recipientNameForRow({ sheetId: 'S', tabName: 'T', rowIndex: 3 })) === null);
  }
  {
    const db = sourcesStub({ index: '김석진' });
    await SVC.recipientNameForRow({ db, sheetId: 'S', tabName: 'T', rowIndex: 80 });
    const sql = db.calls[0].sql;
    ok('한 왕복으로 세 출처를 본다(N+1 금지)', db.calls.length === 1);
    ok('출처 3곳을 실제로 조회한다',
      /review_index/.test(sql) && /campaign_participants/.test(sql) && /order_submissions/.test(sql));
    ok('★ COALESCE 순서 = 명단 → 작업표 → 원장',
      sql.indexOf('ri.recipient_name') < sql.indexOf('cp.recipient_name')
      && sql.indexOf('cp.recipient_name') < sql.indexOf('os.recipient'));
    ok('★ 지워진/비활성 작업표 줄은 근거가 아니다',
      /cp\.deleted_at IS NULL/.test(sql) && /cp\.active = TRUE/.test(sql));
    ok('★ 취소된 주문은 근거가 아니다', /os\.deleted_at IS NULL/.test(sql));
  }

  console.log('\n[B] 읽기 전용');
  {
    const db = sourcesStub({ index: '김석진' });
    await SVC.recipientNameForRow({ db, sheetId: 'S', tabName: 'T', rowIndex: 80 });
    ok('★★ 쓰기 0건(실행 확인)', writes(db.calls).length === 0);
    ok('★★ 서비스에 쓰기 문장 자체가 없다',
      !/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i.test(SVC_SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
  }

  console.log('\n[C] 파일명 이름은 서버가 정한다');
  {
    ok('★ /review-upload 가 해석기를 부른다', /recipientNameForRow\(\s*\{\s*db:\s*pool/.test(DIAG));
    const call = DIAG.slice(DIAG.indexOf('const captureOwnerName ='), DIAG.indexOf('const captureOwnerName =') + 260);
    ok('★★ 못 찾을 때만 화면이 보낸 이름으로 접는다',
      /\|\|\s*reviewerName\s*\|\|\s*'익명'/.test(call));
    const gen = DIAG.slice(DIAG.indexOf('const reviewFileName = driveService.generateReviewFileName'),
                           DIAG.indexOf('const reviewFileName = driveService.generateReviewFileName') + 200);
    ok('★★★ 파일명에 화면이 보낸 이름을 직접 넘기지 않는다',
      /generateReviewFileName\(\s*captureOwnerName/.test(gen) && !/reviewerName/.test(gen));
  }

  console.log('\n[D] reviewerName 자체는 무접촉(파일명만 바뀐다)');
  {
    ok('★ 제출 원장은 계속 참여자 이름으로 기록한다',
      /\[sheetId, tabName, gid \|\| null, rowIdx, reviewerName \|\| null, reviewIndexId,/.test(DIAG));
    ok('★ 관리자 알림 문구도 참여자 기준 그대로',
      /\$\{reviewerName \|\| '리뷰어'\}님이/.test(DIAG));
    ok('★ 중복 판정 신원도 종전 그대로(로그인 이름 우선)',
      /reviewerName: reviewerIdentity\.reviewerName \|\| reviewerName,/.test(DIAG));
  }

  console.log('\n[E] 사본 0 — 교체 승인 rename 도 같은 해석');
  {
    ok('reviewEdit 가 같은 함수를 쓴다',
      /require\('\.\.\/services\/captureOwnerName\.service'\)/.test(REDIT)
      && /recipientNameForRow\(\{ db: pool, sheetId: r0\.sheet_id/.test(REDIT));
    const fin = REDIT.slice(REDIT.indexOf('const _finalOwner ='), REDIT.indexOf('const finalName =') + 120);
    ok('★ 못 찾으면 요청에 적힌 이름으로 접는다(승인이 막히면 안 된다)',
      /\|\|\s*r0\.reviewer_name\s*\|\|\s*'익명'/.test(fin) && /generateReviewFileName\(_finalOwner/.test(fin));
    const uses = (SVC_SRC.match(/COALESCE\(/g) || []).length;
    ok('해석 SQL 사본은 서비스 안에만 있다',
      uses >= 1 && !/NULLIF\(BTRIM\(cp\.recipient_name/.test(DIAG) && !/NULLIF\(BTRIM\(cp\.recipient_name/.test(REDIT));
  }
  {
    ok('★ 작업보드 [📎 리뷰 대신 제출]도 같은 핸들러를 탄다(위임 — 창구별 사본 0)',
      /_workdeskReviewUpload = _delegate\(require\('\.\/diag\.routes'\), 'post', '\/review-upload'\)/.test(TB));
  }

  console.log('\n[F] 파일명 모양 불변 — 정리 도구의 이름↔행 매칭 생존');
  {
    const drive = require('../src/services/drive.service');
    const made = drive.generateReviewFileName('김석진', 1, 'image/jpeg');
    ok('모양은 종전 그대로 {이름}_{순번}_{날짜_시각}.jpg', /^김석진_1_\d{8}_\d{6}\.jpg$/.test(made), made);
    ok('★★ 파일명에서 이름을 되읽을 수 있다(고아 캡처 정리·폴더 백필의 단서)',
      drive.extractReviewerNameFromFile(made) === '김석진');
    ok('★ 이름에 슬래시가 섞여도 파일명이 깨지지 않는다',
      !/[\/\\:*?"<>|]/.test(drive.generateReviewFileName('김/석:진', 2, 'image/png')));
  }
  {
    const LINK = srv('src/services/reviewFileLink.service.js');
    ok('★★ 이름↔행 매칭이 수취인·주문자 **둘 다** 후보로 쓴다(수취인 파일명이 매칭된다)',
      /addRow\(r\.reviewer_name, r\); addRow\(r\.recipient_name, r\);/.test(LINK));
  }

  console.log('\n[G] 해석 1순위(장부의 수취인)가 실제로 채워지는 전제');
  {
    /* ★ 상세 검사(컬럼 계수·파서 실행)는 `reviewerHistoryRecipientName.test.js` 소관 —
       여기서는 **해석 1순위의 전제가 살아 있는지**만 본다(사본을 두면 그쪽이 바뀔 때 함께 빨개진다). */
    ok('★ 무시트 장부가 수취인을 저장한다(파일명 해석 1순위의 전제)',
      /round, phone8, recipient_name, built_at\)/.test(LEDGER) && /r\.recipientName \|\| null/.test(LEDGER));
    ok('★ 시트 빌더도 같은 칸을 넣는다(두 경로가 갈리지 않는다)',
      /recipient_name\)/.test(srv('src/services/indexBuilder.service.js')));
    ok('★★ 그래도 장부에만 기대지 않는다 — 비어 있으면 작업표·원장에서 찾는다',
      /cp\.recipient_name/.test(SVC_SRC) && /os\.recipient/.test(SVC_SRC));
  }

  console.log('\n[H] 구매(주문) 캡처는 무접촉 — 이미 수취인 기준');
  {
    ok('구매 캡처 파일명은 종전 규칙 그대로(수취인 우선, 다르면 주문자 병기)',
      /namePart\s*=\s*\[_imgCtx\.recipient\|\|_imgCtx\.orderer/.test(front('js/search-app.js')));
    const up = DIAG.slice(DIAG.indexOf("router.post('/image-upload'"), DIAG.indexOf("router.post('/review-upload'"));
    ok('★ 구매 캡처 핸들러는 해석기를 부르지 않는다(무회귀)', !/recipientNameForRow/.test(up));
  }

  console.log(`\n✅ captureRecipientFileName: ${n} cases passed`);
}

run().then(() => process.exit(0)).catch(e => { console.error('\n❌', e && e.message); process.exit(1); });
