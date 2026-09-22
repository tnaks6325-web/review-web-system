/**
 * captureRenameBackfill.test.js — 과거 리뷰 캡처 파일명 소급 정정(주문자 → 수취인) 회귀가드.
 *
 * 되돌리기 어려운 **외부 저장(Drive) 쓰기**라, 아래가 깨지면 남의 파일 이름이 잘못 바뀌거나
 * DB·Drive 가 갈린다.
 *
 * 고정하는 불변식:
 *   A. 미리보기 기본 — `dryRun` 을 안 주면 Drive·DB 쓰기 0건. 실행은 `dryRun:false` **와**
 *      `confirm:true` 가 **둘 다** 있어야 한다(하나만으로는 절대 안 쓴다).
 *   B. 대상 제한 — 그 줄이 확정된 파일만 · 표준 파일명만 · 수취인을 아는 것만 ·
 *      이미 같은 이름이면 부르지 않는다.
 *   C. 꼬리(순번·제출시각·확장자) 보존 — 새로 만들지 않는다(제출 시각 소실·매칭 모양 파손 금지).
 *   D. 순서 — Drive 성공 뒤에만 DB. 되돌리기 재료(`renamed_from`)는 **덮지 않는다**(최초 이름 보존).
 *   E. 건별 격리 — 한 건 실패가 나머지를 막지 않고, 사유를 보고한다.
 *   F. 되돌리기 — `renamed_from` 이 있는 파일만 그 이름으로.
 *   G. 해석 사본 0 — 이름 판정은 `captureOwnerName` 의 공유 SQL 조각을 쓴다.
 *   H. 게이트 — adminOrMaster (리뷰 캡처 정리와 같은 급).
 *
 * 실행: node tests/captureRenameBackfill.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const srv = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let n = 0;
const ok = (name, cond, extra) => { assert.ok(cond, name + (extra ? ' :: ' + extra : '')); n++; console.log('  ✓ ' + name); };

const SVC = require('../src/services/captureFileRename.service');
const SRC = srv('src/services/captureFileRename.service.js');
const DRIVE_ROUTES = srv('src/routes/drive.routes.js');
const driveService = require('../src/services/drive.service');

/** 스텁 db — 모든 쿼리를 기록한다(쓰기 0건을 실행으로 확인). */
function stubDb(planRows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/^WITH f AS/i.test(s)) return { rows: planRows };
      if (/renamed_from IS NOT NULL/.test(s)) return { rows: planRows };
      return { rows: [], rowCount: 1 };
    },
  };
}
const writes = (calls) => calls.filter(c => /\b(INSERT|UPDATE|DELETE\s+FROM)\b/i.test(c.sql));

/** Drive rename 스텁 — 호출을 기록하고, 지정 파일만 실패시킨다. */
function stubDrive(failIds = []) {
  const renamed = [];
  const orig = driveService.renameFile;
  driveService.renameFile = async (id, name) => {
    if (failIds.includes(id)) throw new Error('Drive 403');
    renamed.push({ id, name });
    return { id, name };
  };
  return { renamed, restore: () => { driveService.renameFile = orig; } };
}

const ROW = (o = {}) => ({
  fileId: 'F1', fileName: '허다은_1_20260824_101112.jpg', sheetId: 'S', tabName: 'T',
  rowIndex: 80, recipient: '김석진', isPrimary: false, ...o,
});

async function run() {
  console.log('\n[C] 이름만 바꾼다 — 꼬리 보존 · 위생');
  {
    ok('꼬리(순번·시각·확장자)를 그대로 둔다',
      SVC.renamedTo('허다은_1_20260824_101112.jpg', '김석진') === '김석진_1_20260824_101112.jpg');
    ok('여러 장이면 순번도 그대로',
      SVC.renamedTo('허다은_3_20260824_101112.png', '김분자') === '김분자_3_20260824_101112.png');
    ok('★ 표준형이 아니면 건드리지 않는다',
      SVC.renamedTo('아무이름.jpg', '김석진') === null && SVC.renamedTo('_1_20260824_101112.jpg', '김') === null);
    ok('★ 이미 수취인 이름이면 부르지 않는다',
      SVC.renamedTo('김석진_1_20260824_101112.jpg', '김석진') === null);
    ok('★ 수취인을 모르면 부르지 않는다',
      SVC.renamedTo('허다은_1_20260824_101112.jpg', '') === null
      && SVC.renamedTo('허다은_1_20260824_101112.jpg', null) === null);
    ok('★ 파일명 금지문자는 업로드와 같은 규칙으로 접는다(_)',
      SVC.renamedTo('허다은_1_20260824_101112.jpg', '김/석:진') === '김_석_진_1_20260824_101112.jpg');
    const parts = SVC.splitFileName('허다은_1_20260824_101112.jpg');
    ok('가르기: 이름 + 꼬리', parts.head === '허다은' && parts.tail === '_1_20260824_101112.jpg');
  }

  console.log('\n[A] 미리보기 기본 — 두 값이 모두 명시일 때만 쓴다');
  {
    let d = stubDb([ROW()]); let dr = stubDrive();
    let r = await SVC.applyRecipientRenames({ db: d });                       // 아무것도 안 줌
    ok('★★ 기본은 미리보기 — Drive 0건 · DB 쓰기 0건',
      r.dryRun === true && r.planned === 1 && r.renamed === 0
      && dr.renamed.length === 0 && writes(d.calls).length === 0);
    ok('★ 미리보기도 무엇을 바꿀지는 말한다',
      r.items.length === 1 && r.items[0].from === '허다은_1_20260824_101112.jpg'
      && r.items[0].to === '김석진_1_20260824_101112.jpg');
    dr.restore();

    d = stubDb([ROW()]); dr = stubDrive();
    r = await SVC.applyRecipientRenames({ db: d, dryRun: false });            // confirm 없음
    ok('★★ dryRun:false 만으로는 쓰지 않는다',
      r.renamed === 0 && dr.renamed.length === 0 && writes(d.calls).length === 0);
    dr.restore();

    d = stubDb([ROW()]); dr = stubDrive();
    r = await SVC.applyRecipientRenames({ db: d, confirm: true });            // dryRun 기본(true)
    ok('★★ confirm 만으로도 쓰지 않는다',
      r.renamed === 0 && dr.renamed.length === 0 && writes(d.calls).length === 0);
    dr.restore();

    d = stubDb([ROW()]); dr = stubDrive();
    r = await SVC.applyRecipientRenames({ db: d, dryRun: false, confirm: true });
    ok('둘 다 명시하면 실행한다', r.renamed === 1 && dr.renamed.length === 1);
    dr.restore();
  }

  console.log('\n[B] 대상 제한 — 계획 단계에서 거른다');
  {
    const rows = [
      ROW({ fileId: 'A' }),                                             // 정상 대상
      ROW({ fileId: 'B', recipient: null }),                            // 수취인 모름
      ROW({ fileId: 'C', fileName: '이상한이름.jpg' }),                  // 표준형 아님
      ROW({ fileId: 'D', fileName: '김석진_1_20260824_101112.jpg' }),    // 이미 같은 이름
    ];
    const d = stubDb(rows);
    const plan = await SVC.planRecipientRenames({ db: d });
    ok('★★ 정상 대상만 남는다(수취인 모름·비표준·이미 같음 제외)',
      plan.length === 1 && plan[0].fileId === 'A', JSON.stringify(plan.map(p => p.fileId)));
    const sql = d.calls[0].sql;
    ok('★★ 그 줄이 확정된 파일만 본다', /WHERE f\.row_index IS NOT NULL/.test(sql));
    ok('★ 리뷰 슬롯만(영수증·휴지통 제외)', /COALESCE\(rs\.slot_key, 'review'\) = 'review'/.test(sql));
    ok('★ 지워진 줄·취소된 주문은 근거가 아니다',
      /cp\.deleted_at IS NULL/.test(sql) && /cp\.active = TRUE/.test(sql) && /os\.deleted_at IS NULL/.test(sql));
    ok('★ 계획 조회는 읽기 전용', writes(d.calls).length === 0);
  }

  console.log('\n[D] 순서 · 되돌리기 재료');
  {
    const d = stubDb([ROW({ isPrimary: true })]);
    const dr = stubDrive();
    await SVC.applyRecipientRenames({ db: d, dryRun: false, confirm: true });
    const w = writes(d.calls);
    ok('★★ 원장 이름 갱신 + 되돌리기 재료 기록',
      /UPDATE review_submissions SET file_name = \$2, renamed_from = COALESCE\(renamed_from, \$3\)/.test(w[0].sql));
    ok('★★ renamed_from 은 덮지 않는다(최초 이름 보존 — 두 번 돌려도 원본을 잃지 않는다)',
      /COALESCE\(renamed_from, \$3\)/.test(w[0].sql));
    ok('★ 대표 이미지면 그 이름도 함께 갱신', w.length === 2 && /UPDATE review_index SET review_file_name/.test(w[1].sql));
    ok('★ 대표 갱신은 그 파일일 때만(남의 줄 이름을 바꾸지 않는다)', /AND review_file_id = \$1/.test(w[1].sql));
    dr.restore();

    const d2 = stubDb([ROW({ isPrimary: false })]);
    const dr2 = stubDrive();
    await SVC.applyRecipientRenames({ db: d2, dryRun: false, confirm: true });
    ok('★ 대표가 아니면 review_index 는 건드리지 않는다',
      writes(d2.calls).filter(c => /review_index/.test(c.sql)).length === 0);
    dr2.restore();
  }
  {
    // Drive 가 실패하면 DB 를 고치지 않는다
    const d = stubDb([ROW({ fileId: 'X' })]);
    const dr = stubDrive(['X']);
    const r = await SVC.applyRecipientRenames({ db: d, dryRun: false, confirm: true });
    ok('★★ Drive 실패 건은 DB 를 고치지 않는다(DB·Drive 불일치 금지)',
      r.renamed === 0 && r.failed === 1 && writes(d.calls).length === 0);
    ok('★ 실패 사유를 보고한다', r.failures.length === 1 && /Drive 403/.test(r.failures[0].reason));
    dr.restore();
  }

  console.log('\n[E] 건별 격리');
  {
    const d = stubDb([ROW({ fileId: 'A' }), ROW({ fileId: 'B' }), ROW({ fileId: 'C' })]);
    const dr = stubDrive(['B']);
    const r = await SVC.applyRecipientRenames({ db: d, dryRun: false, confirm: true });
    ok('★★ 한 건 실패해도 나머지는 계속한다',
      r.renamed === 2 && r.failed === 1 && dr.renamed.map(x => x.id).join(',') === 'A,C');
    dr.restore();
  }

  console.log('\n[F] 되돌리기');
  {
    const d = stubDb([{ fileId: 'F1', fileName: '김석진_1_20260824_101112.jpg',
                        newName: '허다은_1_20260824_101112.jpg', sheetId: 'S', tabName: 'T', rowIndex: 80 }]);
    const dr = stubDrive();
    let r = await SVC.revertRecipientRenames({ db: d });
    ok('★ 되돌리기도 미리보기 기본', r.dryRun === true && r.renamed === 0 && writes(d.calls).length === 0);
    dr.restore();

    const d2 = stubDb([{ fileId: 'F1', fileName: '김석진_1_20260824_101112.jpg',
                         newName: '허다은_1_20260824_101112.jpg', sheetId: 'S', tabName: 'T', rowIndex: 80 }]);
    const dr2 = stubDrive();
    r = await SVC.revertRecipientRenames({ db: d2, dryRun: false, confirm: true });
    ok('바꾸기 전 이름으로 되돌린다',
      r.renamed === 1 && dr2.renamed[0].name === '허다은_1_20260824_101112.jpg');
    ok('★ 되돌린 뒤에는 재료를 비운다(두 번 되돌리지 않는다)',
      /renamed_from = NULL/.test(writes(d2.calls)[0].sql));
    ok('★ 대상은 재료가 있는 파일뿐', /renamed_from IS NOT NULL/.test(d2.calls[0].sql));
    dr2.restore();
  }

  console.log('\n[G] 해석 사본 0');
  {
    const own = srv('src/services/captureOwnerName.service.js');
    ok('★★ 이름 판정은 공유 조각을 쓴다(SQL 복사 금지)',
      /RECIPIENT_PICK_SQL, recipientJoinSql \}/.test(SRC)
      && /\$\{RECIPIENT_PICK_SQL\}/.test(SRC) && /recipientJoinSql\('f'\)/.test(SRC));
    ok('★ 조각의 주인은 captureOwnerName',
      /RECIPIENT_PICK_SQL/.test(own) && /function recipientJoinSql/.test(own));
    ok('★ 제출 경로도 같은 조각을 쓴다(두 경로가 갈리지 않는다)',
      /\$\{RECIPIENT_PICK_SQL\} AS name/.test(own) && /recipientJoinSql\('k'\)/.test(own));
    ok('★ Drive 호출은 throttle 을 거친다(쿼터 보호)',
      /driveThrottledCall\(\(\) => driveService\.renameFile/.test(SRC));
    ok('★ 한 번에 바꾸는 양에 상한이 있다', /MAX_BATCH = \d+/.test(SRC) && SVC.MAX_BATCH <= 1000);
  }

  console.log('\n[H] 게이트 · 라우터');
  {
    const r = require('../src/routes/drive.routes');
    const layer = (r.stack || []).find(l => l.route && l.route.path === '/capture-rename-recipient');
    ok('라우트가 실제로 등록돼 있다', !!layer && !!layer.route.methods.post);
    const names = layer.route.stack.map(s => s.handle.name);
    ok('★★ adminOrMaster 게이트(리뷰 캡처 정리와 같은 급)',
      names.includes('authMiddleware') && names.includes('adminOrMasterMiddleware'), names.join(','));
    ok('★ 마이그레이션 미적용은 사유를 말한다(조용한 500 금지)',
      /code: 'not_ready'/.test(DRIVE_ROUTES) && /migration 164/.test(DRIVE_ROUTES));
    ok('★ 되돌리기도 같은 창구', /revert === true/.test(DRIVE_ROUTES));
  }

  console.log('\n[I] 마이그레이션 164');
  {
    const m = srv('migrations/164_capture_rename_provenance.sql');
    ok('★ 컬럼 추가만(배포 즉시 동작 불변)',
      /ADD COLUMN IF NOT EXISTS renamed_from TEXT/.test(m)
      && !/\b(DROP|DELETE|UPDATE|NOT NULL|CHECK)\b/i.test(m));
  }

  console.log(`\n✅ captureRenameBackfill: ${n} cases passed`);
}

run().then(() => process.exit(0)).catch(e => { console.error('\n❌', e && e.message); process.exit(1); });
