/**
 * inspectReviewTypeHint.test.js — "구매확정 작업인데 리뷰검수가 불량" 원인 표시 회귀가드.
 *
 * 실사고(2026-08-06): 이노크아든_면마스크는 구매확정 작업인데 리뷰검수가
 * "리뷰 화면이 아닙니다" 불량을 냈다. 원인 = 리뷰타입 판정이 null 이었던 것
 * (`tab_configs.review_type` 에 **배송유형** '실배송'이 들어 있고 공고엔 리뷰타입 없음).
 * 그런데 **화면 어디에도 그 사실이 안 보여** 담당자가 원인을 알 길이 없었다.
 *
 * 고정하는 불변식:
 *   A. 판정은 여전히 utils/reviewType 한 곳 — 배송유형 값은 리뷰타입이 아니다(null)
 *   B. reviewTypeDetailsForTabs — 판정 + **근거값(tabRaw/campRaw)** 을 함께 준다, fail-soft
 *   C. 목록 라우트가 그것을 실어 보낸다(실패해도 목록은 뜬다)
 *   D. 화면이 사유를 문장으로 말하고, 조치가 명확한 케이스에는 다음 행동을 안내한다
 *      ★ 필드가 없으면(구버전 백엔드) 아무것도 그리지 않는다("미지정"으로 꾸미지 않는다)
 *
 * 실행: node tests/inspectReviewTypeHint.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WD = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

const poolPath = require.resolve('../src/db/pool');
let _q = [];
let _res = { rows: [] };
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: {
    query: async (sql, params) => { _q.push({ sql, params }); if (_res instanceof Error) throw _res; return _res; },
    connect: async () => { throw new Error('nope'); },
  },
};

const RT = require('../src/utils/reviewType');
const CTX = require('../src/services/reviewTypeContext.service');

(async () => {
  /* ═══ A. 판정 규칙 ═══ */
  console.log('\nA) 판정 — 배송유형은 리뷰타입이 아니다');
  {
    assert.strictEqual(RT.resolveReviewType({ tabReviewType: '실배송' }), null,
      '★★ 이 사고의 핵심 — 탭 설정의 "실배송"은 배송유형이라 리뷰타입 판정에서 null');
    assert.strictEqual(RT.resolveReviewType({ tabReviewType: '빈박스' }), null);
    assert.strictEqual(RT.resolveReviewType({ tabReviewType: '구매확정' }), 'confirm');
    assert.strictEqual(RT.resolveReviewType({ campaignType: 'confirm', tabReviewType: '실배송' }), 'confirm',
      '공고가 말하면 탭의 옛 값과 무관하게 구매확정');
    assert.strictEqual(RT.resolveReviewType({ campaignType: 'mixed', tabReviewType: '실배송' }), null,
      '혼합뿐이면 행을 정할 수 없어 null(오늘 동작 그대로)');
    ok('A1: ★★ 배송유형 값 = 리뷰타입 null · 공고 > 탭 우선순위');
  }

  /* ═══ B. 근거값을 함께 준다 ═══ */
  console.log('\nB) reviewTypeDetailsForTabs — 판정 + 근거값');
  {
    _q = [];
    _res = { rows: [
      { sheet_id: 'S', tab_name: '0729)이노크아든_면마스크 200건(실배)', tab_review_type: '실배송', camp_review_type: null },
      { sheet_id: 'S', tab_name: '다른탭', tab_review_type: '', camp_review_type: 'confirm' },
    ] };
    const out = await CTX.reviewTypeDetailsForTabs([
      { sheetId: 'S', tabName: '0729)이노크아든_면마스크 200건(실배)' },
      { sheetId: 'S', tabName: '다른탭' },
      { sheetId: 'S', tabName: '다른탭' },   // 중복은 접힌다
    ]);
    assert.strictEqual(_q.length, 1, '★ 한 번의 쿼리로 여러 탭(N+1 금지)');
    assert.strictEqual(_q[0].params[0].length, 2, '중복 제거 후 2개');
    assert.strictEqual(out[0].type, null, '실배송 = 판정 없음');
    assert.strictEqual(out[0].tabRaw, '실배송', '★ 근거값을 그대로 돌려준다(원인을 화면이 말할 수 있게)');
    assert.strictEqual(out[1].type, 'confirm');
    ok('B1: ★ 배치 1쿼리 + 판정 + 근거값(tabRaw/campRaw)');

    // ★ 단건·배치·검수가 **같은 상수**를 끼워 쓰므로 실행 SQL 에 그 조각이 그대로 들어 있다
    assert.ok(_q[0].sql.includes(CTX.CAMPAIGN_REVIEW_TYPE_LATERAL),
      '★ 공고 매칭 규칙은 SQL 단일 출처 상수 그대로(모양이 갈리면 화면과 검수가 다른 공고를 본다)');
    ok('B2: ★ 공고 매칭 SQL = 단일 출처 상수');

    _res = new Error('db down');
    assert.deepStrictEqual(await CTX.reviewTypeDetailsForTabs([{ sheetId: 'S', tabName: 'T' }]), [],
      '★ fail-soft — 조회 실패는 빈 배열(목록을 죽이지 않는다)');
    assert.deepStrictEqual(await CTX.reviewTypeDetailsForTabs([]), [], '빈 입력 = 쿼리 0');
    ok('B3: ★ fail-soft · 빈 입력 무쿼리');

    const src = read('src/services/reviewTypeContext.service.js');
    assert.ok(!/normalizeReviewType|구매확정|실배송/.test(src.split('module.exports')[0].replace(/\/\*[\s\S]*?\*\//g, '')),
      '★ 판정 규칙 사본 금지 — resolveReviewType 에만 맡긴다');
    ok('B4: ★ 판정 규칙 사본 0(utils/reviewType 단일 출처)');
  }

  /* ═══ B2. 공고 매칭 규칙(실사고 후속) ═══ */
  console.log('\nB2) 공고 매칭 — 리네임·차수 재발행에서도 설정이 풀리지 않는다');
  {
    const src = read('src/services/reviewTypeContext.service.js');
    assert.ok(/const CAMPAIGN_REVIEW_TYPE_LATERAL = `/.test(src), 'SQL 단일 출처 상수');
    assert.ok(/COALESCE\(c\.tab_gid, ''\) <> '' AND linked_tab_gid = c\.tab_gid/.test(src),
      '★ gid 폴백 — 탭 리네임으로 설정이 조용히 풀리지 않게. ★ **빈 gid 는 키를 만들지 않는다**');
    assert.ok(/AND COALESCE\(review_type, ''\) <> ''/.test(src),
      "★★ 값이 있는 최신 공고 — 최신 공고의 '미지정'이 옛 공고의 '구매확정'을 가리지 않는다");
    // 소비처 3곳이 **같은 상수**를 끼워 쓴다(사본 금지)
    const ri = read('src/services/reviewInspect.service.js');
    assert.ok(/CAMPAIGN_REVIEW_TYPE_LATERAL/.test(ri), 'loadTabExpectations 도 같은 상수');
    assert.strictEqual((src.match(/LEFT JOIN LATERAL\n\s*\(?\s*SELECT review_type/g) || []).length, 0,
      '상수 밖에 리뷰타입 LATERAL 사본 없음');
    // ★ 채널 LATERAL 은 그대로 — channel+channel_custom 짝이 깨지면 안 된다
    assert.ok(/SELECT channel, channel_custom\n\s*FROM recruit_campaigns/.test(ri),
      '★ 채널은 여전히 한 행에서(짝 보존)');
    assert.ok(!/SELECT channel, channel_custom, review_type/.test(ri),
      '리뷰타입은 채널 LATERAL 에서 분리됨');
    ok('B5: ★★ gid 폴백 + 값 있는 최신 공고 · 채널 짝 보존 · 사본 0');

    if (process.env.PGTEST_URL) {
      const { Client } = require('pg');
      const c = new Client({ connectionString: process.env.PGTEST_URL });
      await c.connect();
      await c.query(`CREATE TEMP TABLE tab_configs(sheet_id TEXT, tab_name TEXT, tab_gid TEXT,
        review_type TEXT DEFAULT '', PRIMARY KEY(sheet_id,tab_name))`);
      await c.query(`CREATE TEMP TABLE recruit_campaigns(id TEXT PRIMARY KEY, linked_sheet_id TEXT,
        linked_tab_name TEXT, linked_tab_gid TEXT, review_type TEXT, created_at TIMESTAMPTZ)`);
      await c.query(`INSERT INTO tab_configs VALUES
        ('S','A','111','실배송'),('S','B-새이름','222','실배송'),('S','C','333','실배송'),('S','D','','실배송')`);
      await c.query(`INSERT INTO recruit_campaigns VALUES
        ('c1','S','A','111','구매확정', now()-interval '2 day'),
        ('c2','S','A','111',NULL,       now()-interval '1 day'),
        ('c3','S','B-옛이름','222','구매확정', now()),
        ('c4','S','C','333','구매확정', now()-interval '2 day'),
        ('c5','S','C','333','포토',     now()),
        ('c6','S','다른탭','','구매확정', now())`);
      const q = async (tab) => (await c.query(
        `SELECT c.review_type AS tabRaw, rt.review_type AS campRaw
           FROM tab_configs c${CTX.CAMPAIGN_REVIEW_TYPE_LATERAL}
          WHERE c.sheet_id='S' AND c.tab_name=$1`, [tab])).rows[0];
      const t = async (tab) => { const r = await q(tab);
        return RT.resolveReviewType({ campaignType: r.camprraw ?? r.campraw, tabReviewType: r.tabraw }); };
      assert.strictEqual(await t('A'), 'confirm',
        "★★ 공고 2개 — 최신이 '미지정'이어도 옛 공고의 구매확정을 본다(종전엔 null)");
      assert.strictEqual(await t('B-새이름'), 'confirm',
        '★★ 탭 리네임 — gid 로 공고를 다시 찾는다(종전엔 null)');
      assert.strictEqual(await t('C'), 'photo', "★ 최신이 '포토'로 **명시**되면 최신이 이긴다");
      assert.strictEqual(await t('D'), null, '★ 빈 gid 는 아무 공고에도 매칭되지 않는다');
      await c.end();
      ok('B6: ★★ 진짜 PG16 — 재발행·리네임·명시 최신·빈 gid 네 경우');
    } else {
      console.log('  (PGTEST_URL 없음 — 매칭 규칙 실행 검증 생략)');
    }
  }

  /* ═══ C. 라우트 ═══ */
  console.log('\nC) 목록 라우트');
  {
    const tb = read('src/routes/trackB.routes.js');
    assert.ok(/reviewTypeDetailsForTabs\(items\.map\(it => \(\{ sheetId: it\.sheet_id, tabName: it\.tab_name \}\)\)\)/.test(tb),
      '목록에 실린 건들의 탭만 조회');
    assert.ok(/let reviewTypes = \[\];[\s\S]{0,400}catch \(_\)/.test(tb),
      '★ 실패해도 목록은 나간다(표시 보조)');
    assert.ok(/scoped: !!sc\.scoped, reviewTypes \}\)/.test(tb), '응답 동봉');
    ok('C1: 목록 응답 동봉 + fail-soft');
  }

  /* ═══ D. 화면 ═══ */
  console.log('\nD) 화면 — 사유를 말하고 다음 행동을 안내한다');
  {
    // 헬퍼를 vm 으로 꺼내 **실제 실행**
    const i = WD.indexOf('const _RI_RT_LABEL=');
    const j = WD.indexOf('const _riNm =', i);
    assert.ok(i > 0 && j > i, '헬퍼 블록 추출');
    const sb = {
      STATE: { riRT: new Map() },
      esc: (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      _riFmtKind: (fm) => (fm && (fm.got || fm.kind)) || '',
    };
    vm.createContext(sb);
    vm.runInContext(WD.slice(i, j), sb);

    const K = (sh, tb) => sh + '\u0000' + tb;   // ★ 리터럴 NUL 금지(파일이 바이너리로 취급된다)
    const R = (checks) => ({ sheet_id: 'S', tab_name: 'T', checks });
    const FAIL = { format: { verdict: 'fail', kind: 'purchase_confirm' } };

    // ★ 필드 없음(구버전 백엔드) = 아무것도 그리지 않는다
    assert.strictEqual(sb._riRTNote(R(FAIL)), '', '★ 모르면 침묵(없는 것을 "미지정"으로 꾸미지 않는다)');
    assert.strictEqual(sb._riConfirmMisset(R(FAIL)), false, '★ 모르면 조치 안내도 안 한다');
    ok('D1: ★ 리뷰타입 정보가 없으면 아무 말도 하지 않는다');

    // 이 사고 그대로 — 탭에 '실배송', 공고 미지정
    sb.STATE.riRT = new Map([[K('S','T'), { type: null, tabRaw: '실배송', campRaw: '' }]]);
    const note = sb._riRTNote(R(FAIL));
    assert.ok(/미지정/.test(note), '미지정임을 말한다');
    assert.ok(/실배송[\s\S]{0,60}배송유형/.test(note),
      '★★ 왜 미지정인지까지 말한다 — 옛 배송유형 값이 남아 있는 것이 원인');
    assert.strictEqual(sb._riConfirmMisset(R(FAIL)), true);
    ok('D2: ★★ "실배송은 배송유형이라 리뷰타입으로 인정되지 않습니다" — 원인 설명');

    // 구매확정으로 설정되면 정상이라고 말한다
    sb.STATE.riRT = new Map([[K('S','T'), { type: 'confirm', tabRaw: '', campRaw: 'confirm' }]]);
    assert.ok(/구매확정[\s\S]{0,60}정상/.test(sb._riRTNote(R(FAIL))), '구매확정 작업임을 말한다');
    assert.strictEqual(sb._riConfirmMisset(R(FAIL)), false, '★ 이미 구매확정이면 조치 안내 없음');
    ok('D3: 구매확정 작업 = "구매확정 완료 화면도 정상" · 조치 안내 없음');

    // 조치 안내는 **그 케이스에만** — 다른 종류의 불량엔 뜨지 않는다
    sb.STATE.riRT = new Map([[K('S','T'), { type: null, tabRaw: '', campRaw: '' }]]);
    assert.strictEqual(sb._riConfirmMisset(R({ format: { verdict: 'fail', kind: 'receipt' } })), false,
      '★ 현금영수증으로 판별된 건에는 뜨지 않는다(조치가 다르다)');
    assert.strictEqual(sb._riConfirmMisset(R({ duplicate: { verdict: 'fail' } })), false);
    assert.strictEqual(sb._riConfirmMisset(R({ format: { verdict: 'warn', kind: 'purchase_confirm' } })), false,
      '불량이 아닌 건에는 뜨지 않는다');
    ok('D4: ★ 조치 안내는 "구매확정 캡처 + 리뷰타입 미설정 + 불량" 한 케이스에만');

    // XSS — 설정값(tabRaw)이 화면으로 나가는 자리가 esc 를 거치는지 **소스로** 고정한다.
    //   (지금은 '실배송'·'빈박스' 두 리터럴일 때만 출력돼 값으로는 재현할 수 없다 —
    //    조건을 넓히는 순간 설정발 문자열이 그대로 나가므로 여기서 막아 둔다.)
    const noteFn = WD.slice(WD.indexOf('function _riRTNote('), WD.indexOf('function _riRTNote(') + 700);
    const raws = noteFn.match(/\$\{[^}]*rt\.(tabRaw|campRaw)[^}]*\}/g) || [];
    assert.ok(raws.length > 0, 'tabRaw 를 화면에 쓰는 자리가 있다');
    assert.ok(raws.every(x => /esc\(/.test(x)), '★ 설정값 출력은 전부 esc 경유: ' + raws.join(' | '));
    ok('D5: ★ XSS — 설정값 출력은 전부 esc 경유(소스 고정)');

    // 배선
    assert.ok(/STATE\.riRT = new Map\(\(r\.reviewTypes\|\|\[\]\)/.test(WD), '목록 응답을 받아 둔다');
    assert.ok(/_riConfirmMisset\(r\)\?`<div class="rirtfix">/.test(WD)
      && /공고에서 <b>구매확정<\/b>으로 저장한 뒤 다시 검수하면 통과됩니다/.test(WD),
      '★ 카드가 다음 행동(구매확정 저장 → 재검수)을 말한다');
    // ★★ 안내가 가리키는 버튼은 **그 자리에 있어야** 한다 — 상단 [♻ 재검수]는 작업을 고른
    //   뒤에만 보여 "재검수 버튼이 어디 있냐"는 신고가 실제로 났다(2026-08-06).
    assert.ok(/riReinspectTab\(\$\{i\}\)/.test(WD), '★ 카드 안내에 그 작업 재검수 버튼');
    assert.ok(/STATE\.role==='master'\|\|STATE\.role==='admin'\?`<button[\s\S]{0,200}riReinspectTab\(\$\{i\}\)/.test(WD),
      '★ 권한 있는 사람에게만(서버 게이트 adminOrMaster 와 1:1 — 눌러도 안 되는 버튼 금지)');
    assert.ok(/event\.stopPropagation\(\);riReinspectTab/.test(WD),
      '★ 카드 본문 클릭(상세 열기)과 분리');
    // 실행부는 한 벌 — 진입만 둘
    assert.strictEqual((WD.match(/async function riReinspectTab\(/g) || []).length, 1,
      '★ 재검수 실행 함수는 한 벌(확인 문구·후처리가 갈리지 않게)');
    assert.ok(/const r0 = \(i!=null\) \? \(STATE\.ri\|\|\[\]\)\[i\] : null;/.test(WD)
      && /const t = r0 \? \{ sheetId:r0\.sheet_id, tabName:r0\.tab_name \} : STATE\.riTab;/.test(WD),
      '인자 있으면 그 카드의 작업 / 없으면 선택된 작업(상단 버튼 동작 불변)');
    // ★★ 재검수는 **어느 카드에서든** 닿아야 한다 — 상단 버튼은 "작업을 고른 뒤"에만,
    //   카드 안내 버튼은 "리뷰타입 미설정"일 때만 떠서 정작 필요할 때 안 보였다(실사용 신고).
    assert.ok(/const _riAdmin = STATE\.role==='master' \|\| STATE\.role==='admin';[\s\S]{0,300}_riAdmin\?\[\{h:`riReinspectTab\(\$\{i\}\)`,t:'♻ 이 작업 재검수'\}\]:\[\]/.test(WD),
      "★★ [⋯] 메뉴에 항상 있다(관리자만 — 서버 게이트와 1:1)");
    // ★ 상단 버튼은 숨기지 말고 **왜 안 되는지 말한다**(숨기면 "어디 있냐"가 된다)
    assert.ok(/\$\{isAdmin\?`<button class="btn"\$\{reOn\?'':' style="opacity:\.5"'\} onclick="riReinspectTab\(\)"/.test(WD)
      && /유형 칩이나 작업을 먼저 고르세요/.test(WD),
      '★ 대상 미선택이어도 버튼을 보여주고 고르는 법을 말한다');
    // ★★ 라벨이 **무엇이 돌지**를 말한다(유형 칩 선택 시 그 유형 / 작업 선택 시 그 작업)
    assert.ok(/const reLbl = curType!=='all' \? `♻ \$\{RI_TYPE_META\[curType\]/.test(WD)
      && /const reOn = curType!=='all' \|\| !!t;/.test(WD),
      '★ 대상이 라벨에 드러난다(무엇이 돌지 모르는 버튼 금지)');
    assert.ok(/\+ \(_riRTNote\(r\)\?`<br>\$\{_riRTNote\(r\)\}`:''\)/.test(WD),
      '상세 팝업 리뷰 화면·채널 줄에 기대 설명');
    ok('D6: 배선 — 목록 수신 · 카드 조치 안내 · 상세 설명');
  }

  console.log(`\n✅ inspectReviewTypeHint 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
