/**
 * 다계정 리뷰 독립 제출 가상 시나리오
 * 실행: node tests/campaignIndependentSubmitVirtual.test.js
 *
 * 실제 API·DB·리뷰어 데이터를 호출하지 않는다. campaign.html의 홀드 저장 함수를 VM에서
 * 직접 실행해 A/B/C의 제출 순서와, 과거 batch URL의 단건 강등을 확인한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const campaign = fs.readFileSync(path.join(root, 'frontend', 'campaign.html'), 'utf8');
const searchApp = fs.readFileSync(path.join(root, 'frontend', 'js', 'search-app.js'), 'utf8');
let passed = 0;
function ok(name, condition) { assert(condition, name); passed++; console.log('  ✓ ' + name); }

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}
function between(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert(start >= 0 && end > start, `소스 구간을 찾을 수 없음: ${from}`);
  return source.slice(start, end);
}

// 실제 campaign.html의 명의별 홀드 함수만 격리 실행한다.
const storage = memoryStorage();
const ctx = {
  PREVIEW: false,
  CAMP_ID: 'virtual-campaign',
  HOLD_KEY: 'camp_hold_virtual-campaign',
  HOLDS_KEY: 'camp_holds_virtual-campaign',
  ACTIVE_KEY: 'camp_active_virtual-campaign',
  localStorage: storage,
  JSON,
  Object,
  String,
};
vm.createContext(ctx);
vm.runInContext(between(campaign, 'function _allHolds()', '/* ═══ 작업내용 표시 정규화'), ctx);

const A = '11111111', B = '22222222', C = '33333333';
storage.setItem(ctx.HOLDS_KEY, JSON.stringify({
  [A]: { applicationId: 'app-A', holdToken: 'token-A', phone8: A, name: 'A' },
  [B]: { applicationId: 'app-B', holdToken: 'token-B', phone8: B, name: 'B', isSub: true },
  [C]: { applicationId: 'app-C', holdToken: 'token-C', phone8: C, name: 'C', isSub: true },
}));
storage.setItem(ctx.ACTIVE_KEY, A);

// A 화면에서 A 컨텍스트만 열고 제출한다.
let active = vm.runInContext('getHold()', ctx);
ok('A 화면은 A application 하나를 선택한다', active.applicationId === 'app-A' && active.holdToken === 'token-A');
vm.runInContext('clearHold()', ctx);
let holds = JSON.parse(storage.getItem(ctx.HOLDS_KEY));
ok('A 제출 뒤 B/C 홀드는 유지된다', !holds[A] && holds[B] && holds[C]);
ok('A 제출 뒤 다음 활성 명의는 B로 이동한다', storage.getItem(ctx.ACTIVE_KEY) === B);

// B와 C를 서로 다른 시점에 이어서 제출한다.
active = vm.runInContext('getHold()', ctx);
ok('B는 A와 분리된 application으로 제출할 수 있다', active.applicationId === 'app-B' && active.holdToken === 'token-B');
vm.runInContext('clearHold()', ctx);
holds = JSON.parse(storage.getItem(ctx.HOLDS_KEY));
ok('B 제출 뒤 C 홀드는 유지된다', !holds[B] && holds[C]);
active = vm.runInContext('getHold()', ctx);
ok('C는 마지막으로 독립 제출할 수 있다', active.applicationId === 'app-C' && active.holdToken === 'token-C');
vm.runInContext('clearHold()', ctx);
holds = JSON.parse(storage.getItem(ctx.HOLDS_KEY));
ok('A/B/C 제출 완료 뒤 홀드가 모두 정리된다', Object.keys(holds).length === 0);

// 과거 batch=1 URL/세션은 search-app.js의 실제 부팅 함수에서 무조건 단건 경로로 떨어진다.
const bootSource = between(searchApp, 'function _batchBoot()', '/** 배치 카드 장식');
const bootCtx = {};
vm.createContext(bootCtx);
vm.runInContext(bootSource, bootCtx);
ok('과거 batch=1 값이 있어도 다건 폼은 부팅하지 않는다', vm.runInContext('_batchBoot()', bootCtx) === null);

// 부모가 batch 파라미터를 다시 만들지 않는지도 함께 고정한다.
ok('부모 iframe URL은 현재 application만 전달하고 batch를 추가하지 않는다',
  /qp\.set\('app', String\(j\.application\.id\)\); qp\.set\('holdToken', h\.holdToken\); qp\.set\('holdPhone8', h\.phone8\);/.test(campaign)
  && !/qp\.set\('batch'/.test(campaign));

console.log(`\n✅ campaignIndependentSubmitVirtual: ${passed}개 통과`);
