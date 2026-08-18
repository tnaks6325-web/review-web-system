/**
 * paymentResultParse.test.js — 리뷰비 입금 M2 회귀가드 ①: 결과 파일 해석 + 짝 맞추기
 * 실행: node tests/paymentResultParse.test.js
 *
 * 고정하는 것:
 *  A. 파일 형식 3종(.xlsx / 구형 .xls(OLE2) / CSV) × 은행 2종을 **전부** 읽는다
 *     — 실측: 하나은행은 진짜 .xls, 케이뱅크는 **확장자만 .xls 이고 내용은 .xlsx** 였다
 *  B. 헤더 행 번호를 하드코딩하지 않는다(메타 줄이 늘어도 찾아낸다)
 *  C. 성공 판정은 **화이트리스트**(모르는 상태값 = 실패 = 미입금 유지)
 *  D. 계좌는 **숫자만** 비교한다(은행 표기가 우리 표준명과 다르다)
 *  E. 회차 은행 ≠ 파일 은행이면 **거부**(엉뚱한 회차 반영 차단)
 *  F. 같은 계좌·금액이 여러 건이면 **파일 순서대로 배정**하고 그 사실을 보고한다
 *  G. 결과 파일에 없는 건 = 실패(기록 안 함)
 *  H. 이체시점은 **KST 고정**(서버 TZ 무관) · 시트 표기는 기존 수기 기록과 같은 모양
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const XLSX = require('@e965/xlsx');
const { loadSheetAoa, sniffFormat } = require('../src/utils/spreadsheetLoad');
const {
  parseResultAoa, matchResults, matchKey, accountDigits, parseTransferAt, BANK_SPECS,
} = require('../src/utils/paymentResultParse');
const FIX = require('./fixtures/paymentResultFixtures');

let passed = 0;
function ok(name, cond, extra) { assert(cond, name + (extra ? ' :: ' + extra : '')); passed++; console.log('  ✓ ' + name); }

/* ★ 주석 제거는 **줄 접두로만** 한다 — 블록 주석 정규식(`/*…*​/`)은 이 레포의 정규식
   리터럴(`/처리상태/` 등)을 물어 코드를 통째로 지운다(실측 사고). 여기서 걷어내는 것은
   `//` 줄과 JSDoc 의 ` * ` 줄뿐이고, 그것만으로 "설명문에 적힌 단어"를 코드로 오인하는
   오탐이 사라진다. */
const codeOnly = (s) => s.split('\n')
  .filter(l => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

const build = (aoa, bookType) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return XLSX.write(wb, { bookType, type: 'buffer' });
};
const parseBuf = (buf) => { const L = loadSheetAoa(buf); return L.ok ? parseResultAoa(L.aoa) : { ok: false, error: L.error }; };

/* ══════════════ A. 형식 3종 × 은행 2종 ══════════════ */
console.log('\n[A] .xlsx · 구형 .xls(OLE2) · CSV 를 모두 읽는다');
const EXPECT = { HANA_AOA: { bank: 'hana', header: 2 }, KBANK_AOA: { bank: 'kbank', header: 0 } };
for (const [name, aoa] of Object.entries(FIX)) {
  const exp = EXPECT[name];
  for (const [bt, wantFormat] of [['xlsx', 'xlsx'], ['biff8', 'xls'], ['csv', 'text']]) {
    const buf = build(aoa, bt);
    ok(`${name} · ${bt} → 형식 판정 ${wantFormat}`, sniffFormat(buf) === wantFormat, sniffFormat(buf));
    const P = parseBuf(buf);
    ok(`${name} · ${bt} → ${exp.bank} 로 해석`, P.ok && P.bank === exp.bank, P.error || P.bank);
    ok(`${name} · ${bt} → 헤더 ${exp.header}행 · 데이터 10건 전부 성공`,
      P.ok && P.headerRow === exp.header && P.totals.total === 10 && P.totals.success === 10,
      JSON.stringify(P.totals) + ' header=' + P.headerRow);
  }
}
/* ★ 확장자는 판정에 쓰지 않는다 — 실측 케이뱅크 파일이 `.xls` 인데 내용은 xlsx 였다. */
ok('★ 확장자가 거짓이어도 내용으로 판정한다(.xls 이름의 xlsx)',
  loadSheetAoa(build(FIX.KBANK_AOA, 'xlsx'), '결과_20260609.xls').format === 'xlsx');

/* ══════════════ B. 헤더 행 하드코딩 금지 ══════════════ */
console.log('\n[B] 헤더 행 번호를 고정하지 않는다');
{
  const shifted = [['안내문'], [''], ['추가 메타'], ...FIX.KBANK_AOA];   // 케이뱅크 헤더를 0행 → 3행으로 밀어본다
  const P = parseResultAoa(shifted);
  ok('메타 줄이 늘어도 헤더를 찾아낸다', P.ok && P.headerRow === 3 && P.totals.total === 10,
    P.error || ('header=' + P.headerRow));
  const src = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src/utils/paymentResultParse.js'), 'utf8'));
  ok('파서에 행 번호 상수(=2 / =3)로 헤더를 잡는 코드가 없다',
    !/headerRow\s*=\s*[123]\b/.test(src));
}

/* ══════════════ C. 성공은 화이트리스트로만 ══════════════ */
console.log('\n[C] 성공 판정 — 모르는 값은 전부 실패(미입금 유지)');
{
  const aoa = JSON.parse(JSON.stringify(FIX.HANA_AOA));
  const st = aoa[2].indexOf('처리상태');
  aoa[3][st] = '오류';          // 실패(실물에 없던 표기)
  aoa[4][st] = '처리중';        // 모르는 값
  aoa[5][st] = '';              // 빈 값
  aoa[6][st] = ' 처리완료 ';    // 공백 섞인 정상
  const P = parseResultAoa(aoa);
  ok('처리완료만 성공 — 오류·처리중·빈값은 실패', P.ok && P.totals.success === 7 && P.totals.fail === 3,
    JSON.stringify(P.totals));
  ok('앞뒤 공백이 있어도 성공으로 인정', P.rows[3].success === true);
  ok('★ 성공 문자열은 은행별 상수 하나 — 하나=처리완료 / 케이뱅크=이체완료',
    BANK_SPECS.hana.success === '처리완료' && BANK_SPECS.kbank.success === '이체완료');
}
{
  /* 케이뱅크 성공 표기를 하나은행 것으로 바꿔 보면 전부 실패여야 한다
     (은행별 판정이 섞이면 남의 표기로 입금완료가 찍힌다). */
  const aoa = JSON.parse(JSON.stringify(FIX.KBANK_AOA));
  const st = aoa[0].indexOf('처리결과');
  for (let i = 1; i < aoa.length; i++) aoa[i][st] = '처리완료';
  const P = parseResultAoa(aoa);
  ok('케이뱅크 파일에 "처리완료"가 적혀 있어도 성공이 아니다', P.ok && P.totals.success === 0);
}

/* ══════════════ D. 계좌는 숫자만 ══════════════ */
console.log('\n[D] 계좌 대조 — 은행 표기를 믿지 않는다');
ok('은행명 + 하이픈 계좌 → 숫자만', accountDigits('국민 202-6020-428-6813') === '20260204286813');
ok('은행명 + 무하이픈 계좌 → 숫자만', accountDigits('우리은행 1002839010303') === '1002839010303');
ok('★ 은행 표기에 숫자가 섞여도 계좌에 딸려오지 않는다',
  accountDigits('iM뱅크(대구) 508123456789') === '508123456789');
ok('KEB하나 같은 비표준 표기도 계좌만 뽑는다', accountDigits('KEB하나 163-9105-839-1307') === '16391058391307');
ok('은행명이 없어도 동작', accountDigits('3333-01-2345678') === '3333012345678');
ok('빈 값은 빈 문자열', accountDigits('') === '' && accountDigits(null) === '');
ok('대조 키는 계좌숫자+금액 하나(예금주·통장표시는 표시용)',
  matchKey('1002839010303', 17800) === '1002839010303|17800');

/* ══════════════ E. 회차 은행 ≠ 파일 은행 → 거부 ══════════════ */
console.log('\n[E] 엉뚱한 회차에 올리면 거부한다');
{
  const P = parseResultAoa(FIX.KBANK_AOA, { expectBank: 'hana' });
  ok('하나은행 회차에 케이뱅크 파일 → 거부', !P.ok && /케이뱅크/.test(P.error) && /하나은행/.test(P.error), P.error);
  const P2 = parseResultAoa(FIX.KBANK_AOA, { expectBank: 'kbank' });
  ok('같은 은행이면 통과', P2.ok === true);
}

/* ══════════════ F·G. 짝 맞추기 ══════════════ */
console.log('\n[F·G] 짝 맞추기 — 순서 배정 · 결과 없음 = 실패');
{
  const P = parseResultAoa(FIX.KBANK_AOA);
  const items = P.rows.map((r, i) => ({
    id: 'it' + i, bankAccount: r.accountDigits, amount: r.amount,
    reviewerName: r.holder, transferMemo: r.memo, rowIndex: 10 + i,
  }));
  items.push({ id: 'ghost', bankAccount: '99999999', amount: 12345, reviewerName: '없는사람', rowIndex: 999 });

  const M = matchResults(items, P.rows);
  ok('회차 11건 중 10건 짝 · 1건은 결과에 없음',
    M.summary.items === 11 && M.summary.matched === 10 && M.summary.notInFile === 1, JSON.stringify(M.summary));
  ok('결과에 없는 건은 성공이 아니다(미입금 유지)',
    M.pairs.find(p => p.item.id === 'ghost').success === false &&
    M.pairs.find(p => p.item.id === 'ghost').reason === 'not_in_file');
  ok('★ 픽스처의 3중복 그룹이 순서 배정으로 보고된다',
    M.summary.orderAssignedGroups === 1 && M.orderAssigned[0].count === 3, JSON.stringify(M.orderAssigned));
  ok('결과 파일에만 있는 행은 없다(전부 소진)', M.summary.unmatchedResults === 0);

  /* ★★ 이 검사가 이 파일의 핵심 — 3중복 중 **가운데만 실패**일 때
     파일 순서 그대로 1·3번째가 성공이어야 한다. 순서 배정을 임의로 바꾸면 여기서 깨진다. */
  const rows2 = JSON.parse(JSON.stringify(P.rows));
  const dupKey = M.orderAssigned[0].matchKey;
  let n = 0;
  for (const r of rows2) if (matchKey(r.accountDigits, r.amount) === dupKey) { n++; if (n === 2) { r.success = false; r.statusRaw = '오류'; } }
  const M2 = matchResults(items, rows2);
  const grp = M2.pairs.filter(p => p.matchKey === dupKey);
  ok('3중복 중 2번째만 실패 → 1·3번째만 성공(파일 순서 그대로)',
    grp.length === 3 && grp[0].success === true && grp[1].success === false && grp[2].success === true,
    JSON.stringify(grp.map(p => p.success)));
  ok('실패 사유가 구분된다(은행 실패 vs 결과 없음)',
    grp[1].reason === 'bank_failed' && M2.pairs.find(p => p.item.id === 'ghost').reason === 'not_in_file');

  /* 결과 파일에만 있는 행(다른 회차 파일을 잘못 올린 경우)도 드러나야 한다 */
  const M3 = matchResults(items.slice(0, 3), P.rows);
  ok('회차에 없는 결과 행을 세어 보고한다', M3.summary.unmatchedResults === 7, JSON.stringify(M3.summary));
}

/* ══════════════ H. 이체시점 ══════════════ */
console.log('\n[H] 이체시점 — KST 고정 · 시트 표기 형식');
{
  const a = parseTransferAt('2026-06-09 12:26:09');
  const b = parseTransferAt('2026.06.09 11:46:52');
  ok('하나 표기 파싱', a.iso === '2026-06-09T12:26:09+09:00' && a.stamp === '2026.6.9 12:26', JSON.stringify(a));
  ok('케이뱅크 표기 파싱', b.iso === '2026-06-09T11:46:52+09:00' && b.stamp === '2026.6.9 11:46', JSON.stringify(b));
  ok('★ 시트 입금칸 표기는 기존 수기 기록과 같은 모양(YYYY.M.D HH:mm)', /^\d{4}\.\d{1,2}\.\d{1,2} \d{2}:\d{2}$/.test(a.stamp));
  ok('★ KST 고정 — 서버 TZ 와 무관하게 같은 값', a.iso.endsWith('+09:00') && b.iso.endsWith('+09:00'));
  ok('시각 없는 날짜만 있어도 파싱', parseTransferAt('2026-06-09').stamp === '2026.6.9 00:00');
  ok('해석 불가는 null(추측하지 않는다)', parseTransferAt('알 수 없음') === null && parseTransferAt('') === null);

  const src = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src/utils/paymentResultParse.js'), 'utf8'));
  ok('★ 파서에 Date.now()/new Date() 가 없다(결정적)', !/Date\.now\(\)|new Date\(/.test(src));
  ok('★ 파서에 DB·네트워크 의존이 없다', !/require\(/.test(src));
}

/* ══════════════ I. 잡음 행 처리 ══════════════ */
console.log('\n[I] 빈 줄·합계 줄은 데이터가 아니다');
{
  const aoa = JSON.parse(JSON.stringify(FIX.HANA_AOA));
  aoa.push(['', '', '', '', '', '', '', '', '']);
  aoa.push(['합계', '', '', '', '', '', '', '', '']);
  const P = parseResultAoa(aoa);
  ok('빈 줄·계좌금액 없는 줄은 건수에서 빠진다', P.ok && P.totals.total === 10, JSON.stringify(P.totals));
}
{
  const aoa = JSON.parse(JSON.stringify(FIX.KBANK_AOA));
  /* 인쇄/복사본에서 본문 중간에 반복된 열 제목 + 합계 금액만 있는 줄. 둘 다
     이체결과가 아니므로 10건에 영향을 주면 안 된다. */
  aoa.splice(4, 0, [...aoa[0]]);
  aoa.push(['', '', '합계', '', '178,000', '', '', '']);
  const P = parseResultAoa(aoa);
  ok('★ 반복 헤더와 금액만 있는 합계 줄은 결과 행으로 세지 않는다',
    P.ok && P.totals.total === 10 && P.rows.every(r => r.accountDigits && r.amount > 0), JSON.stringify(P.totals));
}
{
  const P = parseResultAoa([['아무', '상관없는', '표']]);
  ok('은행 파일이 아니면 사유를 말하고 거부', !P.ok && /입금계좌/.test(P.error), P.error);
  ok('빈 파일도 거부', parseResultAoa([]).ok === false);
}
{
  const aoa = JSON.parse(JSON.stringify(FIX.HANA_AOA));
  aoa[3][1] = '';   // 이체처리(예정)일 비우기
  const P = parseResultAoa(aoa);
  ok('★ 이체시점을 못 읽은 성공 건은 경고로 드러난다(조용한 누락 금지)',
    P.ok && P.warnings.some(w => w.code === 'no_date' && w.count === 1), JSON.stringify(P.warnings));
}

/* ══════════════ J. 픽스처가 실측 특성을 유지하는지 ══════════════ */
console.log('\n[J] 픽스처 — 실측 특성을 "정리"하면 이 가드가 막는다');
{
  const h = FIX.HANA_AOA, k = FIX.KBANK_AOA;
  ok('하나: 헤더 위 메타 2줄이 있다', /그룹이체명/.test(String(h[0][0])) && /출금계좌/.test(String(h[1][0])));
  ok('하나: 금액에 콤마가 없다', h.slice(3).every(r => !String(r[3]).includes(',')));
  ok('케이뱅크: 맨 앞 빈 열이 있다', String(k[0][0]).trim() === '' && /이체일시/.test(String(k[0][1])));
  ok('케이뱅크: 금액에 콤마가 있다', k.slice(1).some(r => String(r[4]).includes(',')));
  ok('★ 계좌·금액·예금주·통장표시가 전부 같은 행이 남아 있다(순서 배정의 존재 이유)', (() => {
    const seen = new Map();
    for (const r of k.slice(1)) { const kk = r.slice(2, 7).join('|'); seen.set(kk, (seen.get(kk) || 0) + 1); }
    return [...seen.values()].some(n => n >= 3);
  })());
  ok('픽스처에 실명·실계좌가 남아 있지 않다(마스킹)',
    !JSON.stringify(FIX).includes('1002839010303') && !JSON.stringify(FIX).includes('202-6020-428-6813'));
}

console.log(`\n✅ paymentResultParse 회귀가드 통과 — ${passed}케이스`);
