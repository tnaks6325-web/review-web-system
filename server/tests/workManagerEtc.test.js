'use strict';
/**
 * 작업담당 「기타」 (결정 374) — 만두·망고 둘 다 아닌 작업(예: 블로그).
 *   ★ 판정 단일 출처 utils/workManager 가 '기타' 를 알아본다 → 미지정이 아니고(질문 안 띄움),
 *     입금관리 담당자 칩은 만두·망고에 섞지 않는다(「전체」·「기타」에서만 — 사용자 확정 '가').
 *   ★ 인트라넷과 같은 네 값(박세희·박은비·랜덤·기타) — 공유 저장 허용 목록·인트라넷 전송·접수 해석이 같은 글자를 쓴다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let passed = 0;
const ok = (n, c, x) => { assert(c, n + (x ? '  ← ' + x : '')); passed++; console.log('  ✓ ' + n); };

const wm = require('../src/utils/workManager');
ok('기타는 기타로 읽는다', wm.mapWorkManager('기타') === '기타' && wm.mapWorkManager(' 기 타 ') === '기타');
ok('다른 이름 속 「기타」 글자는 잡지 않는다', wm.mapWorkManager('기타담당자') === '');
ok('기타는 미지정(직접결정)이 아니다', !wm.isUndecidedWorkManager('기타'));
ok('담당자 판정(단일 출처) = 기타 · 오더가 우선', wm.resolveWorkManager({ orderWorkManager: '기타', tabManager: '만두' }).manager === '기타');
ok('저장 정규화도 기타 그대로', wm.normalizeManagerForStore('기타') === '기타');
ok('화면 라벨', wm.workManagerLabel('기타') === '기타 (기타)' || wm.workManagerLabel('기타') === '기타');
const sf = require('../src/utils/sharedFields');
const canon = sf.canon || (sf.CANON && ((k, v) => sf.CANON.workManager(v)));
ok('공유 칸 비교도 기타 = 기타', canon('work_manager', '기타') === '기타');

const read = p => fs.readFileSync(path.resolve(__dirname, p), 'utf8');
const patch = read('../src/services/sharedPatch.service.js');
ok('담당자 전용 공유 저장 허용 목록에 기타', /\['박세희', '박은비', '랜덤', '기타'\]\.includes\(target\)/.test(patch));
const routes = read('../src/routes/order.routes.js');
ok('인트라넷 접수·수정 해석에서 기타를 버리지 않는다', /if \(mapped === '기타'\) return '기타';/.test(routes));

// 입금관리 담당자 칩 — 기타 작업은 만두·망고 칩에 안 섞이고, 미지정 줄(모든 칩 맨 아래)로도 안 간다
const html = read('../../frontend/workdesk.html');
const grab = name => { const i = html.indexOf('function ' + name + '('); assert(i >= 0, name); let d = 0; for (let k = html.indexOf('{', i); k < html.length; k++) { if (html[k] === '{') d++; else if (html[k] === '}' && --d === 0) return html.slice(i, k + 1); } };
const c = {}; vm.createContext(c);
vm.runInContext(html.slice(html.indexOf('const PM_MANAGER_NICK='), html.indexOf(';', html.indexOf('const PM_MANAGER_NICK=')) + 1).replace('const ', 'var ') + grab('_pmManagerName') + grab('_pmManagerMatch'), c);
ok('입금관리: 기타 작업은 만두 칩에 안 보인다', !c._pmManagerMatch('기타', '만두') && !c._pmManagerMatch('기타', '망고'));
ok('입금관리: 기타 작업은 전체에 보이고, 미지정(빈 담당자)으로 안 접힌다', c._pmManagerMatch('기타', '') && c._pmManagerName('기타') === '기타');

// 작업보드 담당자 빠른 배정 · 관리자 수정 알약
ok('작업보드 빠른 배정에 기타 버튼', /\[\['박세희','만두'\],\['박은비','망고'\],\['기타','기타'\]\]/.test(html) && /\['박세희','박은비','기타'\]\.includes\(value\)/.test(html));
const wod = read('../../frontend/js/work-order-detail.js');
ok('관리자 수정 작업담당 알약에 기타', /\{ v: "기타", l: "기타" \}/.test(wod) && /if \(v === "기타"\) return "기타";/.test(wod));
console.log(`\n✅ workManagerEtc: ${passed}개 통과`);
