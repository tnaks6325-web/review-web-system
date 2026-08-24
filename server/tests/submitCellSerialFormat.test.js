/**
 * submitCellSerialFormat.test.js — 회귀가드: 리뷰제출 칸의 시트 일련번호 표기 보완
 * 실행: node tests/submitCellSerialFormat.test.js
 *
 * 배경(사용자 신고 2026-08-23 "구매일자나 리뷰제출일, 입금일이 46139 등으로 깨진 값"):
 *   본섭 전수 점검 결과 일련번호가 든 칸은 8,044개인데, 그중 **7,902개는 이미 정상 표기**였다
 *   (`_gridEditVal` 이 일련번호→ISO 로 바꾼 뒤 `_fmtKDate`/`_fmtMD` 가 그린다).
 *   남은 **142개는 리뷰제출 칸** — 그 열의 헤더(`리뷰`·`리뷰제출`·`리뷰제출일`)가
 *   `/일자|날짜|date/` 에도 `/입금/` 에도 걸리지 않아 **어느 갈래도 타지 못하고 원본이 그대로** 나왔다.
 *
 * 고정하는 것:
 *  A. 리뷰제출 칸 판정은 **`_workdeskStatusKind` 단일 출처**(서버 statusCols) — 이름 목록 사본 금지
 *  B. 분기 순서 — 날짜형 헤더(`리뷰제출일자` 등)는 **종전 갈래**가 이긴다(무회귀)
 *  C. 일련번호만 바꾼다 — `5/4 20:09`·`완료`·`true`·ISO 는 한 글자도 안 바뀐다
 *  D. 표기는 그 칸의 집주인 형식 `M/D HH:MM`(정수 일련번호는 `M/D`), 시각을 자르지 않는다
 *  E. 오변환 방지 — 4자리·6자리·범위 밖 숫자는 날짜가 되지 않는다
 *  F. 복사(`data-val`)도 보이는 값 — 단, **입금 칸은 종전 정본 복사 유지**
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readRoot = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const html = readRoot('frontend/workdesk.html');
const fn = name => {                       // 선언부터 그 함수의 닫는 줄까지 — 고정 폭 슬라이스 금지(레포 규율)
  const i = html.indexOf('function ' + name + '(');
  assert(i > 0, name + ' 을 찾지 못했다');
  const e = html.indexOf('\n}', i);
  return html.slice(i, e > i ? e + 2 : html.indexOf('\n', i));
};

console.log('\n[A] 판정 단일 출처 — 이름 목록 사본을 새로 만들지 않는다');
{
  const g = fn('_gridVal');
  ok('★ 리뷰제출 판정은 `_workdeskStatusKind` 를 부른다', /_workdeskStatusKind\(h\)\s*===\s*'review'/.test(g), g);
  ok('★ `_gridVal` 안에 헤더 이름 목록 사본이 없다',
    !/리뷰제출일|리뷰제출\b|_WD_SUBMIT_HEADERS/.test(g.replace(/\/\*[\s\S]*?\*\//g, '')), g);
  const k = fn('_workdeskStatusKind');
  ok('판정은 서버 statusCols 를 먼저 본다(폴백은 그 다음)', /STATE\.wd\.statusCols/.test(k) && k.indexOf('statusCols') < k.indexOf('_WD_SUBMIT_HEADERS'));
}

console.log('\n[B] 분기 순서 — 날짜형 헤더는 종전 갈래가 이긴다');
{
  const g = fn('_gridVal');
  const iDate = g.indexOf("일자|날짜|date"), iSub = g.indexOf("_workdeskStatusKind(h)");
  ok('★ 날짜 갈래가 리뷰제출 갈래보다 **앞**', iDate > 0 && iSub > iDate,
    '뒤로 가면 `리뷰제출일자` 탭의 "4/27 (월)" 이 ISO 로 되돌아간다');
  ok('입금 갈래가 맨 앞(종전 그대로)', g.indexOf('_isDepositCol(h)') < iDate);
}

console.log('\n[C~E] 표기 — 함수를 vm 으로 꺼내 실제 실행');
{
  const code = [fn('_isDepositCol'), fn('_isPhoneHeader'), fn('_serialToDate'), fn('_gridEditVal'),
    fn('_fmtKDate'), fn('_fmtMD'), fn('_fmtPhone'), fn('_serialToMDHM'), fn('_fmtSubmitCell'),
    fn('_gridVal'), fn('_workdeskStatusKind')].join('\n');
  const sb = { STATE: { wd: { statusCols: { submit: '리뷰', paid: '입금' } } }, _WD_SUBMIT_HEADERS: new Set(), _WD_PAID_HEADERS: new Set() };
  vm.createContext(sb); vm.runInContext(code, sb);
  const run = (h, v) => { sb.STATE.wd.statusCols.submit = h; return sb._gridVal(h, v); };

  ok('★ 일련번호+시각 → M/D HH:MM', run('리뷰', '46105.66875') === '3/24 16:03', run('리뷰', '46105.66875'));
  ok('★ 정수 일련번호 → M/D(없는 시각을 지어내지 않는다)', run('리뷰제출일', '46245') === '8/11', run('리뷰제출일', '46245'));
  ok('헤더가 `리뷰제출` 인 탭도 같다', run('리뷰제출', '46111.46041666667') === '3/30 11:03');

  ok('★ 이미 읽히는 값은 한 글자도 안 바뀐다 — 시각이 잘리지 않는다', run('리뷰', '5/4 20:09') === '5/4 20:09');
  for (const v of ['완료', 'true', 'O', '2026-04-27', '제출'])
    ok(`★ 일련번호가 아닌 값 보존 — ${JSON.stringify(v)}`, run('리뷰', v) === v, run('리뷰', v));
  ok('빈 칸은 빈 칸', run('리뷰', '') === '' && run('리뷰', null) === '');

  ok('★ 오변환 방지 — 4자리 숫자는 날짜가 아니다', run('리뷰', '1234') === '1234');
  ok('★ 오변환 방지 — 범위 밖 5자리', run('리뷰', '99999') === '99999');
  ok('★ 오변환 방지 — 6자리', run('리뷰', '123456') === '123456');
  /* ★ 칸 전체가 일련번호일 때만 바꾼다 — 숫자로 시작하는 메모(`46105 완료`)를 날짜로 접으면
     담당자가 적어 둔 뒷말이 사라진다(`parseFloat` 은 앞 숫자만 읽고 나머지를 버린다). */
  for (const v of ['46105 완료', '46105원', '46105-1', ' 46105x'])
    ok(`★ 숫자로 시작하는 메모 보존 — ${JSON.stringify(v)}`, run('리뷰', v) === v.trim(), run('리뷰', v));
  ok('★ 소수 자리가 하루를 넘겨도 날짜가 밀리지 않는다(23:59 로 붙인다)',
    run('리뷰', '46105.9999999') === '3/24 23:59', run('리뷰', '46105.9999999'));

  // 무회귀: 종전 갈래
  ok('무회귀 — 구매일자 일련번호는 종전대로 "M/D (요일)"', run('구매일자', '46105') === '3/24 (화)', run('구매일자', '46105'));
  ok('무회귀 — 입금 일련번호는 종전대로 "M/D"', run('입금', '46105') === '3/24');
  ok('무회귀 — 날짜형 이름의 리뷰 칸은 종전 갈래가 이긴다', run('리뷰제출일자', '46105') === '3/24 (화)', run('리뷰제출일자', '46105'));
}

console.log('\n[F] 복사(data-val) — 보이는 값, 단 입금은 종전 정본');
{
  const i = html.indexOf('const eCell=(field, disp, edited, extraCls, styleI, editv, hist)=>');
  assert(i > 0, 'eCell 을 찾지 못했다');
  const cell = html.slice(i, html.indexOf('\n    };', i));
  ok("★ 리뷰제출 칸만 보이는 값으로 복사", /if\(statusKind==='review'\)\s*editv=disp;/.test(cell), cell.slice(0, 500));
  ok('★ 입금 칸은 건드리지 않는다', !/statusKind==='payment'\s*\)\s*editv/.test(cell));
  ok('data-val 은 여전히 editv 우선', /data-val="\$\{esc\(editv!=null\?editv:disp\)\}"/.test(cell));
}

console.log(`\n결과: ${passed} 통과 / 0 실패`);
