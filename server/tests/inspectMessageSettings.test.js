/**
 * inspectMessageSettings.test.js — 검수 결과 리뷰어 안내문구(설정 관리) 회귀가드.
 *
 * 고정하는 불변식:
 *   A. 문구 단일 출처 = utils/inspectMessages.js — 유형표·기본문구·토큰이 여기 한 곳.
 *      빈 값 저장 = 그 유형만 기본 문구로 복귀(빈 메시지 전송 금지), 모르는 키는 버린다.
 *   B. 저장소 = app_settings 1키(신규 테이블 0) · 권한 = GET 내부인 / POST adminOrMaster
 *   C. 카드 meta 규율 — 리뷰어 응답에 그대로 실리므로 관리자 실명·시트 제목 금지,
 *      파일ID 형식 아닌 값은 버린다(<img> 로 나가지 않게)
 *   D. 프론트 배선 — 설정 패널 등록 · 팝업 프리필은 서버 표(_riMsgFor)만 사용(문구 사본 금지)
 *
 * 실행: node tests/inspectMessageSettings.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const readFront = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

/* 스텁 pool — 라우트가 require 하기 전에 캐시에 주입 */
const poolPath = require.resolve('../src/db/pool');
let _q = [];
let _handlers = [];
let _hi = 0;
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: {
    query: async (sql, params) => {
      _q.push({ sql, params });
      const h = _handlers[Math.min(_hi, Math.max(_handlers.length - 1, 0))]; _hi++;
      if (h instanceof Error) throw h;
      return h || { rows: [], rowCount: 0 };
    },
    /* ★ csBridge 는 방 생성·메시지·방 갱신을 **한 트랜잭션**으로 묶는다(빈 방 방지, 2026-08-21).
         그래서 스텁도 client 를 내줘야 한다 — 쿼리는 같은 핸들러로 흘려보내고
         BEGIN/COMMIT/ROLLBACK 만 흡수한다(검사 의미는 그대로). */
    connect: async () => ({
      query: async (sql, params) => {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(String(sql))) return { rows: [], rowCount: 0 };
        return require('../src/db/pool').query(sql, params);
      },
      release: () => {},
    }),
  },
};
function resetPool(handlers) { _q = []; _handlers = handlers || []; _hi = 0; }

const IM = require('../src/utils/inspectMessages');

(async () => {
  /* ═══ A. 단일 출처 · 정규화 ═══ */
  console.log('\nA) utils/inspectMessages — 문구 단일 출처');
  {
    assert.ok(Array.isArray(IM.INSPECT_MSG_KINDS) && IM.INSPECT_MSG_KINDS.length >= 7,
      '유형표는 리뷰검수 카드 유형과 1:1(중복·리뷰화면아님·상품명·채널·본문겹침·작성자·이동)');
    for (const want of ['duplicate', 'format_fail', 'product', 'channel', 'similarity', 'author', 'moved'])
      assert.ok(IM.KEYS.includes(want), `유형 ${want} 존재`);
    for (const k of IM.KEYS) assert.ok(String(IM.DEFAULTS[k] || '').trim(), `${k} 기본 문구 있음(빈 문구 금지)`);
    ok('A1: 유형 7종 + 유형마다 기본 문구(빈 문구 없음)');

    // 사용자 확정 문구 — 중복 제거 안내 첫 줄
    assert.ok(/^중복이미지 제출로 반려되었습니다\./.test(IM.DEFAULTS.duplicate),
      '★ 중복 안내 첫 문장은 사용자 확정 문구 그대로');
    ok('A2: ★ 중복 기본 문구 = "중복이미지 제출로 반려되었습니다."');

    // 빈 값 = 기본 복귀 / 공백만도 기본 / 모르는 키는 버림
    const m1 = IM.merge({ duplicate: '', format_fail: '   ', product: '내 문구', zzz: '침입' });
    assert.strictEqual(m1.duplicate, IM.DEFAULTS.duplicate, '빈 값 = 기본 문구 복귀');
    assert.strictEqual(m1.format_fail, IM.DEFAULTS.format_fail, '공백만도 기본 문구 복귀');
    assert.strictEqual(m1.product, '내 문구', '저장값이 있으면 그대로');
    assert.ok(!('zzz' in m1), '모르는 키는 병합 결과에 없다');
    assert.ok(!('zzz' in IM.normalize({ zzz: 'x' })), '모르는 키는 저장값에서도 버린다');
    ok('A3: ★ 빈 값 = 그 유형만 기본 복귀(빈 메시지가 리뷰어에게 나가지 않는다)');

    // 길이 상한
    const long = IM.normalize({ duplicate: 'ㄱ'.repeat(IM.MAX_LEN + 500) });
    assert.strictEqual(long.duplicate.length, IM.MAX_LEN, '상한 클램프');
    ok('A4: 문구 길이 상한(MAX_LEN) 클램프');

    // 토큰 치환 — 값 있는 토큰만 바꾸고 모르는 토큰은 남긴다
    assert.strictEqual(IM.render('사유: {reason} / {to} / {nope}', { reason: 'A', to: 'B' }),
      '사유: A / B / {nope}');
    assert.strictEqual(IM.render('사유: {reason}', {}), '사유: {reason}',
      '★ 값 없는 토큰은 지우지 않는다("사유:" 만 남은 문장 방지)');
    assert.strictEqual(IM.render('{work}', { work: '6/26탭' }), '6/26탭');
    ok('A5: ★ 토큰 치환 — 값 있는 것만 바꾸고 값 없는/모르는 토큰은 보존');
  }

  /* ═══ B. 저장·권한 ═══ */
  console.log('\nB) 저장소 · 라우트 권한');
  {
    const tb = read('src/routes/trackB.routes.js');
    const g = tb.match(/router\.get\('\/settings\/inspect-messages'[^\n]*/)[0];
    const p = tb.match(/router\.post\('\/settings\/inspect-messages'[^\n]*/)[0];
    assert.ok(/authMiddleware, internalMiddleware/.test(g), 'GET = 내부인(팝업 프리필에 필요 — AE 도 검수한다)');
    assert.ok(/authMiddleware, adminOrMasterMiddleware/.test(p), '★ POST = adminOrMaster(전사 문구)');
    ok('B1: 권한 — GET 내부인 / POST adminOrMaster');

    assert.ok(/app_settings/.test(tb.slice(tb.indexOf(g), tb.indexOf(g) + 2500)),
      '저장소 = app_settings(신규 테이블 0)');
    assert.ok(!/CREATE TABLE/i.test(read('src/utils/inspectMessages.js')), '유틸에 스키마 없음');
    ok('B2: 저장소 = app_settings JSON 1키(신규 테이블 0)');

    // 라우터 스택 실검사 — 두 경로가 실제로 등록돼 있다
    const router = require('../src/routes/trackB.routes');
    const stack = (router.stack || []).filter(l => l.route && /inspect-messages/.test(l.route.path));
    assert.strictEqual(stack.length, 2, 'GET·POST 두 경로 등록');
    const byMethod = {};
    for (const l of stack) byMethod[Object.keys(l.route.methods)[0]] = l.route.stack.map(s => s.name);
    assert.ok(byMethod.get && byMethod.post, 'GET·POST 모두');
    assert.ok(byMethod.post.some(nm => /adminOrMaster/i.test(nm)),
      '★ POST 스택에 adminOrMaster 미들웨어 실제 존재');
    ok('B3: 라우터 스택 실검사 — GET/POST 등록 + POST 관리자 게이트');

    // 라우트 실제 실행 — 저장은 normalize 된 값만, 응답은 merge 된 최종표
    const route = stack.find(l => l.route.methods.post).route;
    const handler = route.stack[route.stack.length - 1].handle;
    resetPool([{ rows: [], rowCount: 1 }]);
    let body = null;
    await handler({ body: { messages: { duplicate: '  내 중복문구  ', format_fail: '', hack: 'x' } } },
      { json: (j) => { body = j; }, status() { return this; } });
    assert.ok(body && body.ok);
    const saved = JSON.parse(_q[0].params[1]);
    assert.deepStrictEqual(Object.keys(saved), ['duplicate'], '★ 빈 값·모르는 키는 저장하지 않는다');
    assert.strictEqual(saved.duplicate, '내 중복문구', '트림 후 저장');
    assert.strictEqual(body.messages.format_fail, IM.DEFAULTS.format_fail, '응답은 기본 병합된 최종표');
    ok('B4: POST 실행 — normalize 저장 + merge 응답(빈 값 = 기본 복귀)');

    // GET 실행 — 조회 실패해도 기본 문구를 돌려준다(팝업이 빈 채로 열리지 않게)
    const groute = stack.find(l => l.route.methods.get).route;
    const ghandler = groute.stack[groute.stack.length - 1].handle;
    resetPool([new Error('db down')]);
    let gbody = null;
    await ghandler({}, { json: (j) => { gbody = j; }, status() { return this; } });
    assert.ok(gbody && gbody.ok && gbody.messages && gbody.messages.duplicate === IM.DEFAULTS.duplicate,
      '★ 조회 실패 = 기본 문구(fail-soft)');
    assert.ok(Array.isArray(gbody.kinds) && gbody.kinds.length === IM.KEYS.length,
      '유형표를 화면에 그대로 내려준다(프론트 사본 금지의 짝)');
    ok('B5: GET 실행 — 조회 실패도 기본 문구 + 유형표 동봉(fail-soft)');
  }

  /* ═══ C. 카드 meta 규율 ═══ */
  console.log('\nC) 사진 카드 meta');
  {
    const src = read('src/services/csBridge.service.js');
    const fn = src.slice(src.indexOf('async function postInspectionReject'));
    assert.ok(/_fid = \(v\) =>[\s\S]*replace\(\/\[\^-\\w\]\/g, ''\)/.test(fn),
      '★ 파일ID 는 [-\\w] 밖 전부 제거(잘못된 값이 <img> 로 나가지 않게)');
    assert.ok(/const meta = card \?/.test(fn), 'card 있을 때만 meta');
    // ★ 경계는 **SQL 문**으로 잡는다 — 선언 형태(const/구조분해)에 기대면 코드가 조금만 바뀌어도
    //   slice 가 -1 로 무너져 검사가 조용히 무의미해진다(2026-08-21 실측: 트랜잭션 도입 때 밟음).
    const metaBlock = fn.slice(fn.indexOf('const meta = card ?'), fn.indexOf('INSERT INTO cs_messages'));
    assert.ok(!/senderName|by\b|sheetId/.test(metaBlock),
      '★★ meta 에 관리자 실명·시트 제목 금지(리뷰어 응답에 그대로 실린다)');
    assert.ok(/msg_type, meta/.test(fn) && /'inspect_result' : 'text'/.test(fn),
      'card 있으면 inspect_result, 없으면 종전 text(구경로 무회귀)');
    assert.ok(/msgType: meta \? 'inspect_result' : 'text', meta: meta \|\| null/.test(fn),
      '★ SSE 실시간 푸시에도 카드가 실린다(목록 API 만 고치면 푸시로 샌다의 반대편)');
    ok('C1: ★ meta 위생 — 파일ID 형식 검증 · 실명/시트제목 미포함 · SSE 동봉');

    // CHECK 제약 확장(마이그레이션)
    const mig = read('migrations/093_cs_inspect_result_msg.sql');
    assert.ok(/inspect_result/.test(mig) && /NOT VALID/i.test(mig),
      '★ CHECK 확장은 NOT VALID(러너가 파일을 암묵 트랜잭션으로 돌린다 — 스캔 중 ACCESS EXCLUSIVE 방지)');
    ok('C2: migration 093 — msg_type CHECK 확장(NOT VALID)');

    // 리뷰어·관리자 양쪽이 같은 렌더러를 쓴다(사본 금지)
    const card = readFront('js/cs-review-edit-card.js');
    assert.ok(/inspectHtml: inspectHtml/.test(card), '공용 렌더러로 노출');
    for (const f of ['js/reviewer-cs.js', 'js/cs-inquiry.js'])
      assert.ok(/msgType === 'inspect_result'[\s\S]{0,200}CsReviewEditCard\.inspectHtml/.test(readFront(f)),
        `${f} — 공용 렌더러 호출(사본 금지)`);
    ok('C3: 카드 렌더러 한 벌 — 리뷰어 채팅·관리자 대화창 공용');

    // 응답에 msgType/meta 가 실려야 카드가 그려진다
    for (const f of ['src/routes/reviewer.routes.js', 'src/routes/cs.routes.js'])
      assert.ok(/msg_type AS "msgType", meta/.test(read(f)), `${f} — 목록 응답에 msgType·meta`);
    ok('C4: 메시지 목록 응답에 msgType·meta 동봉(양쪽)');
  }

  /* ═══ D. 프론트 배선 ═══ */
  console.log('\nD) 프론트 배선');
  {
    const as = readFront('js/admin-settings.js');
    assert.ok(/IMSG_EP = '\/api\/trackb\/settings\/inspect-messages'/.test(as),
      '★ 경로 재기준하지 않는다(admin·리뷰웹시스템[3버전] 양쪽에서 그대로 닿는다)');
    assert.ok(/inspectmsg: _inspectmsgHtml/.test(as) && /inspectmsg: loadInspectMessages/.test(as),
      'PANELS·LOADERS 등록(안 그리면 로더가 조용히 no-op)');
    assert.ok(/inspectmsg: \{ ic: '💬'/.test(as), '목차 항목 등록');
    assert.ok(/window\.saveInspectMessages/.test(as) && /window\._imsgReset/.test(as),
      'onclick 이 부를 전역 노출(빠지면 조용한 ReferenceError)');
    assert.ok(/_imsgKinds/.test(as) && !/중복이미지 제출로 반려되었습니다/.test(as),
      '★★ 설정 화면도 문구 사본을 두지 않는다(서버 표를 그대로 그린다)');
    ok('D1: ★ 설정 패널 등록 + 문구 사본 0(서버 표를 그린다)');

    assert.ok(/class="as-imsg-grid"/.test(as) && /class="as-imsg-colhead"/.test(as)
      && /class="as-imsg-row"/.test(as),
      '안내문구는 항목명·입력란을 같은 행에 두는 2열 편집 구조');
    assert.ok(/\.as-imsg-row\{display:grid;grid-template-columns:/.test(as)
      && /@media \(max-width:640px\)\{[\s\S]{0,250}\.as-imsg-row\{grid-template-columns:1fr/.test(as),
      '2열 편집은 좁은 화면에서 한 열로 안전하게 전환');
    ok('D1a: 리뷰어 안내문구 = 데스크톱 2열 · 모바일 1열 편집');

    assert.ok(/class="as-imsg-input"[\s\S]{0,90}rows="3"/.test(as)
      && /\.as-imsg-meta\{padding:9px 12px/.test(as)
      && /\.as-imsg-input\{[\s\S]{0,90}min-height:66px/.test(as),
      '안내문구 행 기본 높이는 기존 2열 UI보다 약 30% 낮게 유지');
    ok('D1b: 리뷰어 안내문구 행 높이 30% 축소');

    const wd = readFront('workdesk.html');
    assert.ok(/_riMsgAll\(\)[\s\S]{0,400}\/api\/trackb\/settings\/inspect-messages/.test(wd),
      '팝업 프리필도 같은 설정 표에서 읽는다');
    assert.ok(/_riMsgFor\('moved'/.test(wd) && /_riMsgFor\('duplicate'/.test(wd)
      && /_riMsgFor\(_riPrimaryIssue\(r\)\|\|'format_fail'/.test(wd),
      '이동·중복·불량 세 팝업 전부 설정 문구 사용');
    assert.ok(!/중복이미지 제출로 반려되었습니다/.test(wd),
      '★★ workdesk 에 문구 사본 금지(설정에서 고쳐도 안 바뀌는 사고 차단)');
    ok('D2: ★★ 세 팝업 모두 설정 문구 사용 · 프론트 사본 0');

    assert.ok(/id="rcNotifySend" checked/.test(wd), '★ 이동·중복 팝업도 전송 기본 켬');
    assert.ok(/function _rcNotifyMsg\(\)/.test(wd)
      && /const g=f\?f\(\):null; riRcClose\(\);/.test(wd),
      '★ 팝업이 닫히기 전에 문구를 읽는다(닫으면 DOM 이 사라져 빈 문구가 나간다)');
    ok('D3: ★ 전송 기본 켬 + 닫기 전에 문구 읽기');

    assert.ok(/card:_riCardOf\(r,'duplicate'/.test(wd) && /card:_riCardOf\(r,'moved'\)/.test(wd)
      && /card:_riCardOf\(r,'reject'\)/.test(wd), '세 경로 모두 사진 카드 재료 전달');
    const cardOf = wd.slice(wd.indexOf('function _riCardOf('), wd.indexOf('function _riCardOf(') + 400);
    assert.ok(!/row_index/.test(cardOf),
      '★ 카드에 줄 번호를 넣지 않는다(관리용 번호 — 리뷰어는 참여 순번·상품으로 안다)');
    ok('D4: ★ 사진 카드 재료 전달 + 리뷰어에게 줄 번호 미노출');

    for (const host of ['admin.html', 'workdesk.html'])
      assert.ok(/'inspectmsg'/.test(readFront(host)), `${host} — 설정 패널 목록에 등록`);
    ok('D5: 두 호스트(admin·리뷰웹시스템[3버전]) 모두 패널 노출');
  }

  console.log(`\n✅ inspectMessageSettings 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
