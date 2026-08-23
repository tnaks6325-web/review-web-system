/* 제출물 미리보기 — 제출현황 표기 · 팝업 좌우 동시 · 목록 4열(B안) 회귀가드
   사용자 확정 2026-08-21 · 시안 `frontend/docs/design-submission-preview.html`
   ★ grep 만으로는 "그린다"를 못 본다 → 렌더 함수를 vm 으로 꺼내 **실제 실행**한다. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = f => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
const WD = R('frontend/workdesk.html');
const SVC = R('server/src/services/trackB.service.js');
const RN = require('../src/utils/rowNumbering');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x ? ' — ' + x : '')); } };

/* workdesk.html 의 함수 묶음을 sandbox 로 꺼낸다(호스트 전역은 일부러 최소로 둔다). */
function grab(names) {
  const src = names.map(n => {
    const i = WD.indexOf('\nfunction ' + n + '(');
    const j = WD.indexOf('\nconst ' + n + '=');
    const k = WD.indexOf('\nconst ' + n + ' =');
    const at = [i, j, k].filter(x => x > 0).sort((a, b) => a - b)[0];
    if (at == null) throw new Error('not found: ' + n);
    // 다음 최상위 선언 전까지
    const rest = WD.slice(at + 1);
    const m = rest.slice(1).search(/\n(function |const |\/\* |\/\/ ══)/);
    return rest.slice(0, m < 0 ? rest.length : m + 1);
  }).join('\n');
  const sb = { STATE: {}, API_BASE: '', _rvPopRender(){}, esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), console };
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return sb;
}

console.log('\nA) 판정 사본 0 — 서버가 실어 준 값을 그리기만 한다');
ok('★ "채워진 줄" 판정은 게이지 분자와 **같은 호출**(isFilledRow)',
  /syn\.filled\s*=\s*_isFilledRow\(syn\);\s*\n\s*if \(syn\.filled\) filledCount\+\+;/.test(SVC));
ok('★ 표의 「번호」 칸 이름은 numberColumnKey 단일 출처',
  /numberColumnKey: _numberColumnKey/.test(SVC) && /_numberColumnKey\(r\.row_json\)/.test(SVC));
ok('★ 셀 편집이 있으면 그 값이 이긴다(표와 같게)', /pick\('col:' \+ _nk,/.test(SVC));
ok('★ 마스킹보다 앞에서 계산한다(광고주 렌즈가 빈 칸을 채워진 걸로 뒤집지 않게)',
  SVC.indexOf('syn.boardNo =') < SVC.indexOf('if (maskPII)'));
ok('★ 화면에 FILLED_FIELDS 사본이 없다',
  !/order_submission_id.*reviewer_name.*recipient_name/s.test(WD.slice(WD.indexOf('function _rvPeople'), WD.indexOf('function _rvPeople') + 1200)));
ok('★ 분모는 한 곳(_rvFilledOf)에서만 만든다 — 게이지도 그것을 쓴다',
  (WD.match(/_rvFilledOf\(/g) || []).length >= 3 && /const filled=_rvFilledOf\(c\);/.test(WD));
ok('★ 갈래 판정은 _rvKindFiles 하나 — 팝업이 slot 을 직접 비교하지 않는다',
  !/slot\s*===\s*'order_capture'/.test(WD.slice(WD.indexOf('function _rvPopCol'), WD.indexOf('function _rvPopRender'))));

console.log('\nB) 제출현황 줄');
{
  const sb = grab(['_rvKindFiles', '_rvFilledOf', '_rvStatHtml']);
  const roster = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }];
  sb.STATE.wd = { counts: { filled: 500, total: 512 }, roster };
  sb.STATE.rvImgs = {
    '1': [{ slot: 'order_capture' }, { slot: 'review' }],
    '2': [{ slot: 'order_capture' }],
    '3': [{ slot: 'review' }],
    // 4 = 아무것도 없음
  };
  const h = sb._rvStatHtml();
  ok('구매 캡처 = 그 갈래를 낸 줄 수 / 채워진 줄', /🛒<\/span><span class="lb">구매 캡처<\/span><span class="nm">2<small> \/ 500</.test(h), h);
  ok('리뷰 캡처도 같은 규칙', /📷<\/span><span class="lb">리뷰 캡처<\/span><span class="nm">2<small> \/ 500</.test(h), h);
  ok('★ 분모는 counts.total(512) 이 아니라 게이지와 같은 filled(500)', !/\/ 512/.test(h));

  sb.STATE.rvImgs = null;                       // 조회 실패
  const h2 = sb._rvStatHtml();
  ok('★ 조회 실패는 "?" — 0 으로 꾸미지 않는다', /class="s unk"/.test(h2) && /">\?<small>/.test(h2) && !/">0<small>/.test(h2), h2);

  sb.STATE.rvImgs = {}; sb.STATE.wd.counts = {};   // 구버전 백엔드(filled·total 부재)
  ok('★ 분모를 모르면 분모도 "?"', / \/ \?</.test(sb._rvStatHtml()));

  sb.STATE.wd.counts = { total: 200 };
  ok('★ filled 미동봉(구버전)이면 줄 수로 접는다 — 게이지와 같은 폴백', / \/ 200</.test(sb._rvStatHtml()));
}

console.log('\nC) 팝업 목록 — B안(채워진 줄 전체) · 4열');
{
  const sb = grab(['_rvNo', '_rvWho', '_rvKindFiles', '_rvUrl', '_rvPeople', '_rvPopIdx', '_rvPopStep2', '_RV_POP_COL', '_rvPopCol', '_rvPopItem']);
  const rows = [
    { id: 'a', seq: 2, recipient: '심수현', boardNo: '1', filled: true },
    { id: 'b', seq: 3, recipient: '조성훈', boardNo: '2', filled: true },
    { id: 'c', seq: 4, recipient: '빈칸없음', boardNo: '', filled: true },   // 번호 칸이 빈 줄
    { id: 'd', seq: 5, recipient: '', boardNo: '9', filled: false },        // 빈 슬롯
  ];
  sb.STATE.wd = { roster: rows };
  sb.STATE.rvImgs = {
    '2': [{ fileId: 'F1aaaaaaaaaaaaaaaaaaaa', slot: 'order_capture' }],        // 구매만
    '3': [{ fileId: 'F2aaaaaaaaaaaaaaaaaaaa', slot: 'order_capture' }, { fileId: 'F3aaaaaaaaaaaaaaaaaaaa', slot: 'review' }],
    // 4 = 아무것도 없음 · 5 = 빈 슬롯
  };
  const people = sb._rvPeople();
  ok('★ B안 — 아무것도 안 낸 채워진 줄도 목록에 있다', people.length === 3 && people.map(x => x.r.id).join() === 'a,b,c', JSON.stringify(people.map(x => x.r.id)));
  ok('★ 빈 슬롯(filled=false, 파일 없음)은 목록에 없다', !people.some(x => x.r.id === 'd'));

  sb.STATE.rvPop = { people, idx: 1, i2: { cap: 0, rev: 0 } };
  const it0 = sb._rvPopItem(people[0], 0, false);
  ok('★ 번호는 표의 「번호」(boardNo) — seq 가 아니다', />1<\/span>/.test(it0) && !/>2<\/span>/.test(it0), it0);
  ok('★ 시트 행 번호는 툴팁으로만', /title="시트 행 2"/.test(it0));
  ok('구매 ✓ · 리뷰 ✗ 가 갈려 보인다', /mk y">✓<\/span><span class="mk n">✗</.test(it0), it0);
  ok('둘 다 있으면 ✓ ✓', /mk y">✓<\/span><span class="mk y">✓</.test(sb._rvPopItem(people[1], 1, true)));
  ok('★ 둘 다 없으면 ✗ ✗ (빠진 사람이 보인다 = B안의 목적)', /mk n">✗<\/span><span class="mk n">✗</.test(sb._rvPopItem(people[2], 2, false)));
  ok('★ 번호 칸이 비면 추측하지 않고 —', /class="no">—<\/span>/.test(sb._rvPopItem(people[2], 2, false)));
  ok('★ onclick 은 인덱스만(시트발 문자열 보간 금지)',
    /onclick="_rvPopPick\(0\)"/.test(it0) && !/onclick="[^"]*심수현/.test(it0));

  // XSS — 수취인에 따옴표가 섞여도 onclick 을 탈출하지 못한다
  const evil = { r: { id: 'x', seq: 7, recipient: `x'),alert(1),String('`, boardNo: `'"` }, files: [] };
  const eh = sb._rvPopItem(evil, 5, false);
  ok('★ 따옴표 섞인 수취인·번호가 onclick 을 탈출하지 못한다',
    /onclick="_rvPopPick\(5\)"/.test(eh) && !/alert\(1\)/.test(eh.split('onclick=')[1].split(' ')[0]), eh);
}

console.log('\nD) 팝업 무대 — 좌우 동시');
{
  const sb = grab(['_rvNo', '_rvWho', '_rvKindFiles', '_rvUrl', '_rvPeople', '_rvPopIdx', '_rvPopStep2', '_RV_POP_COL', '_rvPopCol', '_rvPopItem']);
  sb.STATE.rvPop = { people: [], idx: 0, i2: { cap: 0, rev: 0 } };
  const files = [{ slot: 'order_capture', url: 'u1' }, { slot: 'order_capture', url: 'u2' }, { slot: 'review', url: 'u3' }];
  const cap = sb._rvPopCol('cap', files), rev = sb._rvPopCol('rev', files);
  ok('구매 칸은 구매만(2장)', /구매 캡처<span class="cnt">2</.test(cap) && /src="u1"/.test(cap) && !/src="u3"/.test(cap));
  ok('리뷰 칸은 리뷰만(1장)', /리뷰 캡처<span class="cnt">1</.test(rev) && /src="u3"/.test(rev));
  ok('★ 2장 이상이면 넘김 줄이 뜬다', /_rvPopStep2\('cap',1,2\)/.test(cap));
  ok('★ 1장이면 넘김 줄은 자리만 지킨다(두 칸 높이가 어긋나지 않게)', /style="visibility:hidden"/.test(rev));
  ok('★ 첫 장에서 ‹ 는 잠긴다(끝에서 순환하지 않는다)', /<button type="button" disabled onclick="_rvPopStep2\('cap',-1,2\)/.test(cap));

  const only = [{ slot: 'order_capture', url: 'u1' }];
  const rev2 = sb._rvPopCol('rev', only);
  ok('★ 한쪽이 없으면 그 칸만 "미제출"이라고 말한다(양쪽을 뭉뚱그리지 않는다)',
    /rvpempty warn"><b>리뷰 미제출/.test(rev2) && !/<img/.test(rev2), rev2);

  sb._rvPopStep2('cap', 1, 2);
  ok('넘기면 그 칸만 다음 장', /src="u2"/.test(sb._rvPopCol('cap', files)) && /src="u3"/.test(sb._rvPopCol('rev', files)));
  /* ★ 순환 금지는 **실행으로** 봐야 잡힌다 — 버튼의 disabled 는 i 로만 그려져
     넘김 함수가 순환하도록 바뀌어도 그대로 통과한다(변이시험 실측). */
  sb._rvPopStep2('cap', 1, 2);
  ok('★ 마지막 장에서 더 눌러도 처음으로 돌아가지 않는다', /src="u2"/.test(sb._rvPopCol('cap', files)), sb._rvPopCol('cap', files));
  sb._rvPopStep2('cap', -1, 2); sb._rvPopStep2('cap', -1, 2);
  ok('★ 첫 장에서 더 눌러도 끝으로 감기지 않는다', /src="u1"/.test(sb._rvPopCol('cap', files)));
}

console.log('\nE) 배선·계약');
ok('★ 팝업이 무대를 좌우로 나눈다(단일 img 렌더 부재)',
  /<div class="rvpcols">\$\{_rvPopCol\('cap',cur\.files\)\}\$\{_rvPopCol\('rev',cur\.files\)\}<\/div>/.test(WD)
  && !/aria-label="리뷰 캡처 크게 보기"/.test(WD));
ok('★ 패널 제목 아래에 제출현황이 붙는다', /tp3chev">∨<\/span><\/div>`\+_rvStatHtml\(\);/.test(WD));
ok('★ 누른 장이 열린다 — 전역 인덱스를 갈래+순번으로 옮긴다', /i2\[k\]=Math\.max\(0,_rvKindFiles\(files,k\)\.findIndex/.test(WD));
ok('★ 사람을 바꾸면 칸 위치를 초기화한다(_rvPopPick·_rvPopStep 둘 다)',
  /_rvPopPick\(idx\)\{[^}]*p\.i2=\{cap:0,rev:0\};/.test(WD) && /_rvPopStep\(delta\)\{[^}]*p\.i2=\{cap:0,rev:0\};/.test(WD));
ok('CSS 는 4열 목록·2분할 무대를 갖는다',
  /\.rvplitem\{width:100%;display:grid;grid-template-columns:38px minmax\(0,1fr\) 30px 30px/.test(WD)
  && /\.rvpcols\{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr/.test(WD));
ok('★ 세로로 긴 캡처가 칸을 뚫지 않는다(min-height:0)', /\.rvpbody\{flex:1;min-height:0;/.test(WD));
ok('좁은 화면은 목록 머리를 접고 무대를 위아래로', /\.rvplhd,\.rvplcols\{display:none\}/.test(WD) && /\.rvpcols\{grid-template-columns:1fr;grid-template-rows:1fr 1fr\}/.test(WD));
ok('시안 문서가 있다', fs.existsSync(path.join(__dirname, '..', '..', 'frontend/docs/design-submission-preview.html')));

console.log('\nF) rowNumbering 계약(서버가 기대는 것)');
ok('numberColumnKey 가 「번호」를 찾는다', RN.numberColumnKey({ '번호': '1', '수취인': 'a' }) === '번호');
ok('★ 번호 칸이 없으면 null(빈 값으로 접지 않는다)', RN.numberColumnKey({ '수취인': 'a' }) === null);
ok('isFilledRow — 이름만 있어도 채워진 줄', RN.isFilledRow({ name: '홍길동' }) === true);
ok('isFilledRow — 전부 비면 빈 줄', RN.isFilledRow({ name: '', recipient: '  ', phone8: '', hasOrder: false }) === false);

/* ══ G) 폴더 바로가기 — 표 윗줄 버튼을 제출물 미리보기로 옮겼다(사용자 확정 2026-08-21) ══ */
console.log('\nG) 구매 캡처·리뷰 캡처 = 폴더 바로가기');
{
  const sb = grab(['_rvKindFiles', '_rvFilledOf', '_rvStatHtml']);
  sb.STATE.wd = { counts: { filled: 10 }, roster: [{ seq: 1 }] };
  sb.STATE.rvImgs = { '1': [{ slot: 'order_capture' }, { slot: 'review' }] };
  sb.STATE.role = 'admin';
  sb.STATE.cur = { sheetId: 'S', tabName: 'T' };
  const calls = [];
  sb._folState = (t, src, kind) => { calls.push([src, kind]); return { on: kind !== 'review', tip: kind === 'review' ? '아직 폴더가 생성되지 않았습니다' : kind + ' 폴더 열기' }; };
  const h = sb._rvStatHtml();
  ok('★ 요약 줄이 폴더 창구 — 열 수 있으면 onclick + ↗',
    /class="s lk"[^>]*onclick="_rvOpenFolder\('capture'\)"/.test(h) && /↗/.test(h), h);
  ok('★ 열 수 없으면 onclick 을 만들지 않는다(눌러도 아무 일 없는 자리 금지) + 사유 툴팁',
    !/_rvOpenFolder\('review'\)/.test(h) && /폴더를 열 수 없습니다 — 아직 폴더가 생성되지 않았습니다/.test(h), h);
  ok('★ 판정은 _folState 재사용(사본 0) — 작업보드 재료(cur)로 묻는다',
    calls.length === 2 && calls.every(c => c[0] === 'cur') && calls.map(c => c[1]).join('/') === 'capture/review',
    JSON.stringify(calls));
  // 광고주 격리 — /tab-folders 는 내부인 전용이라 창구를 만들면 막다른 길
  const sb2 = grab(['_rvKindFiles', '_rvFilledOf', '_rvStatHtml']);
  sb2.STATE.wd = { counts: { filled: 10 }, roster: [{ seq: 1 }] };
  sb2.STATE.rvImgs = {}; sb2.STATE.role = 'advertiser'; sb2.STATE.cur = { sheetId: 'S', tabName: 'T' };
  let asked = 0; sb2._folState = () => { asked++; return { on: true, tip: 'x' }; };
  const ha = sb2._rvStatHtml();
  ok('★ 광고주에게는 폴더 창구를 그리지 않는다', asked === 0 && !/_rvOpenFolder/.test(ha));
}
/* ★★ 창구는 **요약 줄 하나**(사용자 확정 2026-08-21) — 칸 제목은 "지금 보고 있는 그 리뷰어의
   제출물"을 말하는 자리라, 거기서 탭 전체 폴더가 열리면 무엇을 여는지 헷갈린다. */
ok('★ 칸 제목에는 폴더 바로가기가 없다(요약 줄 하나로 수렴)', (() => {
  const i = WD.indexOf('const col=(kind,icon,title,emptyB,emptyS,warn)=>{');
  const seg = WD.slice(i, WD.indexOf('\n  const left=col(', i));
  return i > 0 && !/_rvOpenFolder/.test(seg) && !/_folState/.test(seg) && !/rv2h\$\{/.test(seg);
})());
ok('★ 칸 제목 링크 CSS 도 남아 있지 않다(눌리는 것처럼 보이면 안 된다)',
  !/rv2h\.lk/.test(WD));

/* ══ H) 사람 옆 번호 = 작업보드 「번호」(boardNo) ══════════════════════════════ */
console.log('\nH) 미리보기 번호 = 작업보드 번호');
{
  const sb = grab(['_rvNo', '_rvNoHtml']);
  ok('★ 값이 있으면 "번호 N"(시트 행 seq 가 아니다)',
    /번호 19/.test(sb._rvNoHtml({ boardNo: '19', seq: 25 })) && !/#25/.test(sb._rvNoHtml({ boardNo: '19', seq: 25 })));
  ok('★ 없으면 지어내지 않는다 — "번호 —" + 시트 행은 툴팁으로',
    /번호 —/.test(sb._rvNoHtml({ seq: 25 })) && /시트 행 25/.test(sb._rvNoHtml({ seq: 25 })));
  ok('★ 공백만 있는 값도 없는 것으로 본다', /번호 —/.test(sb._rvNoHtml({ boardNo: '  ', seq: 3 })));
}
ok('★ 미리보기 두 곳(내부·광고주)이 같은 헬퍼를 쓴다 — #seq 표기 부활 0',
  (WD.match(/\$\{_rvNoHtml\(r\)\}/g) || []).length === 2 && !/<span>#\$\{esc\(r\.seq\)\}<\/span>/.test(WD));
ok('★ 팝업도 같은 헬퍼(번호 판정 사본 0)',
  (WD.match(/_rvNo\((x|cur)\.r\)/g) || []).length === 2
  && !/boardNo==null\?''/.test(WD.replace(/function _rvNo\(r\)\{[^}]*\}/, '')));
ok('★ 번호 칸 판정은 서버 단일 출처(rowNumbering.numberColumnKey) — 프론트에 키 목록 사본 없음',
  !/\['번호'\s*,\s*'no'/.test(WD));
ok('★ 실행부는 기존 openTabFolder 하나(새 경로·사본 0)',
  /function _rvOpenFolder\(kind\)\{ if\(STATE\.role==='advertiser'\|\|!STATE\.cur\) return; openTabFolder\(0,kind,'cur'\); \}/.test(WD));
ok('★ 명칭 통일 — 화면에 "리뷰 이미지" 라는 말이 남아 있지 않다(리뷰 캡처)',
  !/리뷰 이미지/.test(WD) && !/리뷰이미지/.test(WD));

console.log('\n' + (fail ? `실패 ${fail} / ` : '') + (pass + fail) + ' checks' + (fail ? '' : ' passed'));
process.exit(fail ? 1 : 0);
