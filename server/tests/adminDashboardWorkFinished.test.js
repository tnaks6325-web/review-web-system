/**
 * adminDashboardWorkFinished.test.js — 결정 255 회귀가드
 * 실행: node tests/adminDashboardWorkFinished.test.js
 *
 * 작업보드 🏁 마감(trackb_tab_finished)을 옛 관리자 대시보드에 **표시만** 한다.
 *  ① 서버: /api/admin/dashboard 가 판정 단일 출처(trackB.finishedTabsMap/isTabFinishedIn)로 workFinished 를 싣는다.
 *  ② 화면: 표시 판정은 ⬛ ∪ 🏁, 체크박스·[실행] 변경 판정은 저장된 ⬛ 만(섞으면 is_closed 를 써 버린다 — 완화 금지).
 *  ③ tab_configs.is_closed 쓰기 0.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 옛 대시보드 — 작업보드 마감 표시 (결정 255)\n');

const route = S('src/routes/admin.routes.js');
const dashStart = route.indexOf("router.get('/dashboard'");
const dash = route.slice(dashStart, route.indexOf('router.', dashStart + 10));
t('서버: 마감 판정은 trackB 단일 출처', /trackB\.finishedTabsMap\(\)/.test(dash) && /workFinished: trackB\.isTabFinishedIn\(fin\.map, t\.sheetId, t\.tabName, t\.tabGid\)/.test(dash));
t('서버: 조회 실패를 응답에 고지', /fin\.ok \? \{\} : \{ workFinishedUnavailable: true \}/.test(dash));
t('서버: is_closed 쓰기 없음', !/UPDATE\s+tab_configs/i.test(dash) && !/(FROM|INTO|UPDATE)\s+trackb_tab_finished/i.test(dash));

const app = F('js/index-app.js');
const grab = name => { const m = app.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}')); assert(m, name + ' 추출 실패'); return m[0]; };
const ctx = { _closedSet: new Set(), _closedRoundSet: new Set(), _workFinSet: new Set() };
vm.createContext(ctx);
vm.runInContext([grab('_isShownClosed'), grab('_savedClosed'), grab('_closedLblHtml')].join('\n'), ctx);

const K = 'S1||작업A';
ctx._workFinSet.add(K);
t('🏁 마감 작업은 마감으로 보인다', ctx._isShownClosed(K) === true);
t('🏁 마감 작업의 체크박스는 체크되지 않는다(저장된 ⬛ 만)', ctx._savedClosed(K) === false);
t('🏁 차수 행도 체크박스에 섞이지 않는다', ctx._savedClosed(K + '||1차') === false);
t('🏁 라벨', /🏁 마감/.test(ctx._closedLblHtml(K)));
ctx._closedSet.add('S1||작업B');
t('⬛ 마감은 종전대로 체크·라벨', ctx._savedClosed('S1||작업B') === true && /⬛ 마감/.test(ctx._closedLblHtml('S1||작업B')));
ctx._closedRoundSet.add('S1||작업A||2차');
t('차수 ⬛ 마감은 🏁 보다 우선', /⬛ 마감/.test(ctx._closedLblHtml(K, 'S1||작업A||2차')));
t('아무 마감도 아니면 마감 아님', ctx._isShownClosed('S1||작업C') === false);

t('체크박스는 _savedClosed 를 쓴다', /class="closed-cb" data-tabkey="\$\{escHtml\(tabKey\)\}" \$\{_savedClosed\(tabKey\) \? "checked" : ""\}/.test(app));
const exec = grab('execClosed');
t('[실행] 변경 판정은 🏁 를 보지 않는다', !/_workFinSet|_isShownClosed/.test(exec));
t('응답의 workFinished 로 집합을 채운다', /if \(t\.workFinished\) _workFinSet\.add\(/.test(app));
t('스크립트 캐시 버전 갱신', /js\/index-app\.js\?v=20261019-workfin/.test(F('admin.html')));

console.log(`\n✅ adminDashboardWorkFinished: ${pass}/${pass}\n`);
