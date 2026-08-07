/**
 * inspectRejectNotify.test.js — 리뷰검수 [✕ 불량] 반려 사유 리뷰어 통지 회귀가드.
 *
 * 고정하는 불변식:
 *   A. notifyInspectionReject — 연락처는 review_index.phone8(소유권 규율)만,
 *      연락처 없음/전송 실패 = sent:false + 사람 안내 문구(조용한 미전송 금지), 절대 throw 없음
 *   B. csBridge.postInspectionReject — 스레드 없으면 생성(★ 관리자 발신이라 admin_unread 0),
 *      메시지 INSERT + reviewer_unread +1 + SSE 는 리뷰어용 이름으로 치환
 *   C. 배선 — resolve 라우트 rejectMessage · workdesk 전용 팝업(프리필·전송 기본 켬·실패 고지)
 *
 * 실행: node tests/inspectRejectNotify.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const readFront = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

/* ── 공용 스텁 pool — csBridge·adminNickname 은 pool 을 직접 require 하므로
     require.cache 에 **먼저** 주입한다(로드 순서가 곧 테스트 장치다). */
const poolPath = require.resolve('../src/db/pool');
let _q = [];
let _handlers = [];
let _hi = 0;
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: {
    query: async (sql, params) => {
      _q.push({ sql, params });
      const h = _handlers[Math.min(_hi, Math.max(_handlers.length - 1, 0))]; _hi++;
      return h || { rows: [], rowCount: 0 };
    },
    connect: async () => { throw new Error('connect 불필요'); },
  },
};
function resetPool(handlers) { _q = []; _handlers = handlers || []; _hi = 0; }

const RI = require('../src/services/reviewInspect.service');
const CSB = require('../src/services/csBridge.service');

(async () => {
  /* ═══ A. notifyInspectionReject ═══ */
  console.log('\nA) notifyInspectionReject');
  {
    // csBridge 를 스파이로 교체(모듈 캐시의 export 객체를 직접 패치 — reviewInspect 는 lazy require)
    const calls = [];
    const orig = CSB.postInspectionReject;
    CSB.postInspectionReject = async (p) => { calls.push(p); return { threadId: 7, messageId: 9 }; };

    const _row = (o) => ({ query: async () => ({ rows: [Object.assign({
      sheet_id: 's', tab_name: 't', row_index: 48, reviewer_name: '신명기',
      p_row: null, p_link: null, p_pl: null, p_name: null, name_cnt: 0,
    }, o)] }) });

    // A1: 시트 현재값(그 줄의 연락처) → csBridge 로 그대로 전달, sent:true
    RI.__setPoolForTest(_row({ p_row: '12345678' }));
    const r1 = await RI.notifyInspectionReject({ fileId: 'F', message: '사유입니다', by: '만두' });
    assert.strictEqual(r1.sent, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].phone8, '12345678');
    assert.strictEqual(calls[0].message, '사유입니다');
    ok('A1: ① 시트 현재값(review_index — 소유권 규율)이 최우선');

    // A1b: ★ 시트 값이 없어도 포기하지 않는다 — ②결정적 링크 → ③확정신원 → ④유일 동명
    //   (종전엔 ①만 봐서 row_index 가 NULL 이거나 연락처 칸이 비면 전건 미전송이었다)
    for (const [k, via] of [['p_link', 'link'], ['p_pl', 'participation'], ['p_name', 'name']]) {
      RI.__setPoolForTest(_row({ [k]: '87654321' }));
      const g = await RI.resolveReviewerPhone8('F');
      assert.strictEqual(g.phone8, '87654321');
      assert.strictEqual(g.via, via, `${k} → via:${via}`);
    }
    RI.__setPoolForTest(_row({ p_row: '11111111', p_link: '22222222' }));
    assert.strictEqual((await RI.resolveReviewerPhone8('F')).via, 'row', '★ 우선순위 고정(①이 ②를 이긴다)');
    ok('A1b: ★ 4갈래 폴백 + 우선순위 고정(①시트 → ②결정적링크 → ③확정신원 → ④유일 동명)');

    // A2: 어디에도 없음 → 미전송 + **사유를 구분한** 안내(csBridge 미호출)
    RI.__setPoolForTest(_row({ row_index: null }));
    const r2 = await RI.notifyInspectionReject({ fileId: 'F', message: 'x', by: '' });
    assert.strictEqual(r2.sent, false);
    assert.ok(/어느 줄인지 연결되어 있지 않/.test(r2.error), 'row_index 없음 = 그 사유를 말한다');
    assert.ok(/직접 안내/.test(r2.error), '실패 안내가 다음 행동(1:1 직접 안내)을 말한다');
    assert.strictEqual(calls.length, 1, '연락처 없으면 csBridge 미호출');

    RI.__setPoolForTest(_row({ row_index: 48 }));
    assert.ok(/48행의 연락처 칸이 비어/.test((await RI.resolveReviewerPhone8('F')).error),
      '행은 있는데 시트 연락처가 빈 경우');
    RI.__setPoolForTest(_row({ name_cnt: 3 }));
    assert.ok(/3명이라 연락처를 특정할 수 없/.test((await RI.resolveReviewerPhone8('F')).error),
      '동명이인 = 특정 불가(★ 아무에게나 보내지 않는다)');
    ok('A2: ★ 연락처 없음 = 미전송 + **사유 구분** 안내(조용한 미전송·오배송 금지)');

    // A3: 빈 사유 = 미전송 / 조회 예외 = throw 없이 실패 반환
    assert.strictEqual((await RI.notifyInspectionReject({ fileId: 'F', message: '  ' })).sent, false);
    RI.__setPoolForTest({ query: async () => { throw new Error('db down'); } });
    const r3 = await RI.notifyInspectionReject({ fileId: 'F', message: 'x' });
    assert.strictEqual(r3.sent, false, '예외도 throw 없이 실패 반환(불량 확인을 되돌리지 않는다)');
    ok('A3: 빈 사유·조회 예외 전부 fail-soft(절대 throw 없음)');

    CSB.postInspectionReject = orig;
    RI.__setPoolForTest(null);
  }

  /* ═══ B. csBridge.postInspectionReject ═══ */
  console.log('\nB) csBridge.postInspectionReject');
  {
    // B1: 스레드 없음 → 생성(admin_unread 0) → 메시지 INSERT → reviewer_unread +1
    resetPool([
      { rows: [] },                                   // 스레드 SELECT — 없음
      { rows: [{ id: 11 }] },                         // 스레드 INSERT
      { rows: [{ id: 22, createdAt: 'now' }] },       // 메시지 INSERT
      { rows: [], rowCount: 1 },                      // 스레드 UPDATE
      { rows: [] },                                   // adminNickname 맵 조회(무엇이든)
    ]);
    const out = await CSB.postInspectionReject({
      sheetId: 's', tabName: '6/26레노버라방_리뷰', rowIndex: 48,
      reviewerName: '신명기', phone8: '12345678', message: '반려 사유', by: '박세희',
    });
    assert.ok(out && out.threadId === 11 && out.messageId === 22);
    const tIns = _q.find(q => /INSERT INTO cs_threads/.test(q.sql));
    assert.ok(/admin_unread_count\)[\s\S]*,0\)/.test(tIns.sql.replace(/\s+/g, '')) || /,0\)\s*$/m.test(tIns.sql.split('VALUES')[1].split('ON CONFLICT')[0].trim()),
      '★ 관리자 발신 스레드 생성 = admin_unread 0(새 문의 도착으로 오인 금지)');
    const mIns = _q.find(q => /INSERT INTO cs_messages/.test(q.sql));
    assert.strictEqual(mIns.params[1], '박세희', 'DB 에는 로그인명(책임추적 — 표시 치환은 읽는 시점)');
    const tUpd = _q.find(q => /reviewer_unread_count = reviewer_unread_count \+ 1/.test(q.sql));
    assert.ok(tUpd, '리뷰어 미확인 +1(뱃지)');
    ok('B1: 스레드 생성(admin_unread 0) → 메시지 → reviewer_unread +1 시퀀스');

    // B2: 실패해도 throw 하지 않는다(확인 원장을 되돌리면 안 됨)
    resetPool([]);
    _handlers = [];
    require.cache[poolPath].exports.query = async () => { throw new Error('boom'); };
    const out2 = await CSB.postInspectionReject({ sheetId: 's', tabName: 't', phone8: '1', message: 'x' });
    assert.strictEqual(out2, null);
    ok('B2: ★ 절대 throw 없음(교체요청 통지와 같은 규율)');

    // B3: SSE 는 리뷰어용 이름 치환을 반드시 거친다(페이로드 실명 유출 차단)
    const src = read('src/services/csBridge.service.js');
    const fn = src.slice(src.indexOf('async function postInspectionReject'));
    assert.ok(/toReviewerName\(senderName, nickMap\)/.test(fn), 'SSE senderName = 닉네임 치환(fail-closed)');
    ok('B3: ★ SSE 페이로드 발신자 = 리뷰어용 이름(닉네임 규율)');
  }

  /* ═══ C. 배선 ═══ */
  console.log('\nC) 배선');
  {
    const tb = read('src/routes/trackB.routes.js');
    assert.ok(/rejectMessage/.test(tb) && /resolution === 'bad' && rejectMessage/.test(tb),
      'resolve 라우트 — 불량 + 사유일 때만 통지');
    assert.ok(/notify = await _inspectSvc\.notifyInspectionReject/.test(tb)
      && /res\.json\(\{ ok: true, \.\.\.r, notify \}\)/.test(tb),
      '통지 결과를 응답에 실어 화면이 실패를 말할 수 있다');
    ok('C1: 라우트 — rejectMessage 조건부 통지 + notify 응답 동봉');

    const wd = readFront('workdesk.html');
    assert.ok(/riBadPopup\(\$\{i\}\)/.test(wd) && /riBadPopup\(\$\{idx\},true\)/.test(wd),
      '카드·상세 [✕ 불량] = 전용 팝업(인덱스 전달)');
    assert.ok(/id="riBadSend" checked/.test(wd), '★ 전송 체크 기본 켬');
    // ⚠ 문구는 설정(설정 › 리뷰어 안내문구)이 진실원본이 됐다 — 프론트는 유형별 틀을 받아
    //   판정 근거({reason})만 끼운다. 검사 의미 불변: 근거가 프리필되고 사람이 고칠 수 있다.
    assert.ok(/_riReasons\(r\.checks\|\|\{\}\)/.test(wd)
      && /_riMsgFor\(_riPrimaryIssue\(r\)\|\|'format_fail'/.test(wd)
      && /reason: reasons\.length\?reasons\.join/.test(wd),
      '사유 = 판정 근거 프리필(사람이 고쳐 보낸다)');
    assert.ok(!/const def='제출하신 리뷰 캡처가/.test(wd),
      '★ 프론트에 문구 사본을 두지 않는다(설정에서 고쳐도 안 바뀌는 사고 차단)');
    assert.ok(/rejectMessage:msg/.test(wd), '전송 페이로드 배선');
    assert.ok(/반려 안내 전송 실패/.test(wd) && /res\.notify \|\| !res\.notify\.sent/.test(wd),
      '★ 전송 실패는 반드시 화면이 말한다(확인 완료와 구분)');
    assert.ok(!/confirm\('.*불량/.test(wd), '불량 처리에 시스템 confirm 미사용(전용 팝업 확정 시안)');
    ok('C2: workdesk — 전용 팝업·프리필·기본 켬·실패 고지');
  }

  console.log(`\n✅ inspectRejectNotify 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
