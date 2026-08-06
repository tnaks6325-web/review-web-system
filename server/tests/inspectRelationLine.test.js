/**
 * inspectRelationLine.test.js — 리뷰검수 "무엇과 중복인지" 관계 줄 회귀가드.
 * 시안 = frontend/docs/design-inspect-duplicate-relation.html (사용자 확정 2026-08-06)
 *
 * 고정하는 불변식:
 *   A. 관계 줄 재료(_riRelPairs) — 같은 짝을 가리키는 사유는 **한 줄로 합치고**,
 *      다른 짝이면 두 줄. 줄 번호를 모르면 null 로 남긴다(빈칸 금지).
 *   B. 렌더(_riRelHtml) — 왼쪽 = 이 건 / 오른쪽 = 이미 있던 것(방향 고정),
 *      같은 작업·같은 리뷰어면 이름·작업명을 반복하지 않는다,
 *      다른 리뷰어면 양쪽 이름 + 🔴, 다른 작업이면 오른쪽에 작업명,
 *      줄 번호 없으면 "줄 번호 없음"이라고 **적는다**
 *   C. 배선 — 카드·[🗑 제거] 팝업·상세 팝업이 **같은 렌더러 한 벌**을 쓴다,
 *      카드 사유 문장에서 그 두 사유는 빠지고(중복 표기 제거),
 *      ★ 반려 사유 프리필은 skipRel 없이 부른다(리뷰어 문장은 관계 줄이 없다)
 *   D. 리뷰어에게 나가는 문구에는 줄 번호를 넣지 않는다
 *
 * 실행: node tests/inspectRelationLine.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WD = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

/* ── 관계 줄 함수만 vm 으로 꺼내 **실제 실행**한다(정적 grep 은 스코프·동작을 못 본다) ── */
function block(startMarker, endMarker) {
  const i = WD.indexOf(startMarker);
  assert.ok(i > 0, '블록 시작을 찾지 못했다: ' + startMarker);
  const j = WD.indexOf(endMarker, i);
  assert.ok(j > i, '블록 끝을 찾지 못했다: ' + endMarker);
  return WD.slice(i, j);
}
const src = block('const _riNm =', 'function riTypeSet(');
const sandbox = { esc: (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { _riRelPairs, _riRelHtml } = sandbox;

const ROW = (o) => Object.assign({
  reviewer_name: '이수진', row_index: 40, tab_name: '7/24(네이버)메디슨벨_파라다이스 그레인 200건',
}, o);
const DUP = (o) => Object.assign({ verdict: 'fail', matchFileId: 'F2', matchRow: 31, matchReviewer: '이수진' }, o);
const SIM = (o) => Object.assign({ verdict: 'warn', score: 1, matchRow: 31, matchReviewer: '이수진' }, o);

(() => {
  /* ═══ A. 재료 ═══ */
  console.log('\nA) 관계 줄 재료 — 같은 짝은 합치고 다른 짝은 나눈다');
  {
    // 같은 짝(파일 중복 + 본문 겹침이 둘 다 31행) → 한 줄
    let p = _riRelPairs(ROW({ checks: { duplicate: DUP(), similarity: SIM() } }));
    assert.strictEqual(p.length, 1, '★ 같은 줄을 가리키면 관계 줄 하나');
    assert.strictEqual(p[0].matchRow, 31);
    assert.ok(p[0].notes.some(t => /본문 100% 겹침/.test(t)), '합칠 때 겹침은 설명으로 붙는다');
    ok('A1: ★ 같은 짝 = 관계 줄 1개 + 겹침은 설명으로');

    // 다른 짝(파일은 31행, 본문은 55행) → 두 줄
    p = _riRelPairs(ROW({ checks: { duplicate: DUP(), similarity: SIM({ matchRow: 55 }) } }));
    assert.strictEqual(p.length, 2, '★ 짝이 다르면 관계 줄 2개(합치면 거짓말이 된다)');
    assert.strictEqual(p.map(x => x.matchRow).join(','), '31,55');   // vm 렐름이라 배열 동일성 대신 값 비교
    ok('A2: ★ 다른 짝 = 관계 줄 2개');

    // 중복 근거가 없으면(파일ID 없음) 관계 줄을 만들지 않는다
    assert.strictEqual(_riRelPairs(ROW({ checks: { duplicate: { verdict: 'fail' } } })).length, 0);
    assert.strictEqual(_riRelPairs(ROW({ checks: {} })).length, 0);
    assert.strictEqual(_riRelPairs(ROW({ checks: { similarity: { verdict: 'pass' } } })).length, 0);
    ok('A3: 근거 없는 건은 관계 줄 없음(빈 껍데기 금지)');

    // 완화(warn · 다른 작업)도 관계 줄을 만든다
    p = _riRelPairs(ROW({ checks: { duplicate: DUP({ verdict: 'warn', sameReviewerOtherTab: true, matchTab: '노티드_두바이쫀득쿠키', matchRow: 12 }) } }));
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].multi, true);
    assert.strictEqual(p[0].sameTab, false);
    ok('A4: "한 화면에 여러 리뷰" 완화 건도 관계 줄을 만든다');

    // 짝의 줄 번호를 모르면 null 로 남긴다(0 이나 빈 문자열로 접지 않는다)
    p = _riRelPairs(ROW({ checks: { duplicate: DUP({ matchRow: null }) } }));
    assert.strictEqual(p[0].matchRow, null, '★ 모르는 줄 번호를 0/빈값으로 접지 않는다');
    ok('A5: ★ 줄 번호 모름 = null 유지');
  }

  /* ═══ B. 렌더 ═══ */
  console.log('\nB) 렌더 — 방향 고정 · 다른 점만 덧붙인다');
  {
    // ① 같은 작업 · 같은 리뷰어
    let h = _riRelHtml(ROW({ checks: { duplicate: DUP() } }));
    assert.ok(/이 건[\s\S]{0,120}40행/.test(h), '왼쪽 = 이 건(40행)');
    assert.ok(/이미 제출됨[\s\S]{0,120}31행/.test(h), '오른쪽 = 이미 제출됨(31행)');
    assert.ok(h.indexOf('40행') < h.indexOf('31행'), '★ 방향 고정 — 왼쪽이 지금 보는 건');
    assert.ok(!/이수진/.test(h), '★ 같은 리뷰어면 이름을 반복하지 않는다');
    assert.ok(!/메디슨벨/.test(h), '★ 같은 작업이면 작업명을 반복하지 않는다');
    assert.ok(/같은 작업 · 같은 리뷰어/.test(h));
    ok('B1: ★ ① 같은 작업·같은 리뷰어 — 40행 ▶ 31행, 반복 없음');

    // ② 같은 작업 · 다른 리뷰어 → 양쪽 이름 + 🔴
    h = _riRelHtml(ROW({ checks: { duplicate: DUP({ matchReviewer: '김철수' }) } }));
    assert.ok(/이수진/.test(h) && /김철수/.test(h), '다른 리뷰어면 양쪽에 이름');
    assert.ok(/f-red[\s\S]{0,40}다른 리뷰어/.test(h), '★ 도용 신호를 표시한다');
    ok('B2: ★ ② 다른 리뷰어 — 양쪽 이름 + 빨간 표시');

    // ③ 다른 작업 · 같은 리뷰어 → 오른쪽에 작업명 + 파란 안내
    h = _riRelHtml(ROW({ checks: { duplicate: DUP({ verdict: 'warn', sameReviewerOtherTab: true, matchTab: '노티드_두바이쫀득쿠키', matchRow: 12 }) } }));
    assert.ok(/노티드_두바이쫀득쿠키/.test(h), '오른쪽에 작업명');
    assert.ok(/다른 작업/.test(h) && /f-blue[\s\S]{0,60}한 화면에 여러 리뷰/.test(h));
    assert.ok(!/이수진/.test(h), '같은 리뷰어면 이름은 여전히 반복하지 않는다');
    ok('B3: ★ ③ 다른 작업 — 오른쪽에 작업명 + "한 화면에 여러 리뷰일 수 있음"');

    // ④ 줄 번호 없음 → **적는다**
    h = _riRelHtml(ROW({ checks: { duplicate: DUP({ matchRow: null }) } }));
    assert.ok(/줄 번호 없음/.test(h), '★ 모르면 모른다고 적는다(빈칸 = "같은 줄" 오해)');
    h = _riRelHtml(ROW({ row_index: null, checks: { duplicate: DUP() } }));
    assert.ok(/줄 번호 없음[\s\S]{0,200}31행/.test(h), '이 건의 줄 번호를 몰라도 마찬가지');
    ok('B4: ★ ④ 줄 번호 없음도 문장으로 적는다(양쪽 모두)');

    // 겹침 줄은 라벨이 다르다 + 두 줄이면 두 번 그린다
    h = _riRelHtml(ROW({ checks: { duplicate: DUP(), similarity: SIM({ matchRow: 55 }) } }));
    assert.strictEqual((h.match(/class="rirel /g) || []).length, 2, '짝이 둘이면 관계 줄도 둘');
    assert.ok(/겹친 리뷰/.test(h), '겹침 줄의 오른쪽 라벨');
    ok('B5: 겹침 줄 라벨 + 짝 개수만큼 렌더');

    // 라벨 교체(확인 팝업은 제거/보존)
    h = _riRelHtml(ROW({ checks: { duplicate: DUP() } }), { leftLabel: '제거', rightLabel: '보존' });
    assert.ok(/제거/.test(h) && /보존/.test(h) && !/이미 제출됨/.test(h), '팝업용 라벨 교체');
    ok('B6: 같은 렌더러가 라벨만 바꿔 팝업에도 쓰인다');

    // XSS — 시트에서 온 값은 전부 escape
    h = _riRelHtml(ROW({ reviewer_name: '<img src=x onerror=alert(1)>',
      checks: { duplicate: DUP({ matchReviewer: '"><script>bad()</script>', matchTab: '<b>t</b>' }) } }));
    assert.ok(!/<img|<script|<b>t<\/b>/.test(h), '★ 시트발 문자열은 escape(관계 줄도 예외 없음)');
    ok('B7: ★ XSS — 이름·작업명 escape');
  }

  /* ═══ C·D. 배선 ═══ */
  console.log('\nC) 배선 — 렌더러 한 벌 · 중복 표기 제거 · 리뷰어 문구 보호');
  {
    const calls = WD.match(/_riRelHtml\(/g) || [];
    assert.ok(calls.length >= 4, '정의 + 카드 · 확인 팝업 · 상세 팝업 세 소비처'); // 정의 1 + 호출 3
    assert.ok(/const relHtml = _riRelHtml\(r\);[\s\S]{0,3000}\$\{relHtml\}/.test(WD), '카드에 관계 줄');
    assert.ok(/const relHtml = _riRelHtml\(r, \{leftLabel:'제거', rightLabel:'보존'\}\)/.test(WD)
      && /const pairHtml=relHtml\+/.test(WD), '[🗑 제거] 확인 팝업 — 사진 위에');
    assert.ok(/<div class="rimright">\s*\$\{_riRelHtml\(r\)\}/.test(WD), '상세 팝업 — 머리 바로 아래');
    assert.ok(!/function _riRelHtml2|function _riRelRow/.test(WD), '★ 렌더러 사본 금지');
    ok('C1: ★ 렌더러 한 벌 — 카드 · 확인 팝업 · 상세 팝업');

    assert.ok(/_riReasons\(c, \{skipRel:true\}\)/.test(WD),
      '★ 카드 사유에서 같은 파일·본문 겹침은 뺀다(관계 줄이 말한다 — 두 번 적지 않는다)');
    assert.ok(/_riMsgFor\(_riPrimaryIssue\(r\)\|\|'format_fail'/.test(WD)
      && /const reasons=_riReasons\(r\.checks\|\|\{\}\);/.test(WD),
      '★★ 반려 사유 프리필은 skipRel 없이 — 리뷰어 문장에는 관계 줄이 없으므로 문장으로 다 말해야 한다');
    ok('C2: ★★ 카드는 빼고 · 반려 문장은 그대로(옵션이 리뷰어 문구를 갉아먹지 않는다)');

    assert.ok(/의 사진을 <b>휴지통<\/b>으로 보냅니다/.test(WD) && /\$\{esc\(myRow\)\}/.test(WD)
      && /\$\{esc\(mtRow\)\}/.test(WD), '확인 팝업 조치 문장에 줄 번호');
    assert.ok(/🗑 제거 · \$\{esc\(myRow\)\}/.test(WD) && /✓ 보존 · \$\{esc\(mtRow\)\}/.test(WD),
      '사진 캡션에도 줄 번호');
    ok('C3: 확인 팝업 — 조치 문장·사진 캡션에 줄 번호');

    // D. 리뷰어에게 가는 카드 재료에는 줄 번호가 없다(관리용 번호)
    const cardOf = WD.slice(WD.indexOf('function _riCardOf('), WD.indexOf('function _riCardOf(') + 400);
    assert.ok(!/row_index/.test(cardOf), '★ 리뷰어 채팅 카드에는 줄 번호를 넣지 않는다');
    ok('D1: ★ 리뷰어에게는 줄 번호 미노출(관리자 화면 전용)');
  }

  console.log(`\n✅ inspectRelationLine 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})();
