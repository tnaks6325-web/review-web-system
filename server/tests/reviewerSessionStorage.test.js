'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const api = fs.readFileSync(path.join(root, 'frontend', 'api.js'), 'utf8');
const campaign = fs.readFileSync(path.join(root, 'frontend', 'campaign.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const searchApp = fs.readFileSync(path.join(root, 'frontend', 'js', 'search-app.js'), 'utf8');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} 시작점을 찾을 수 없음`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} 끝점을 찾을 수 없음`);
}

function memoryStorage(initial) {
  const values = new Map(Object.entries(initial || {}).map(([k, v]) => [k, String(v)]));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    value: key => values.has(key) ? values.get(key) : null,
  };
}

const keyDecl = "const _REVIEWER_AUTH_STORAGE_KEY = 'rapp_reviewer_auth';";
assert(api.includes(keyDecl), '공통 리뷰어 세션 키 선언이 필요함');
const sharedSource = [
  keyDecl,
  functionSource(api, '_getReviewerSessionStore'),
  functionSource(api, '_getReviewerSession'),
  functionSource(api, '_clearReviewerSession'),
  functionSource(api, '_getAuthHeaders'),
  functionSource(campaign, 'getSession'),
].join('\n');

function makeContext({ tab, local }) {
  const sessionStorage = memoryStorage(tab ? { rapp_reviewer_auth: JSON.stringify(tab) } : {});
  const localStorage = memoryStorage(local ? { rapp_reviewer_auth: JSON.stringify(local) } : {});
  const sandbox = { sessionStorage, localStorage, JSON, Number, Date };
  vm.createContext(sandbox);
  vm.runInContext(sharedSource, sandbox);
  return { sandbox, sessionStorage, localStorage };
}

const future = Date.now() + 60_000;
const past = Date.now() - 60_000;
const kim = { name: '김민혜', phone8: '11110876', reviewerToken: 'kim-token', expAt: future };
const park = { name: '박은비', phone8: '22227191', reviewerToken: 'park-token', expAt: future };

let t = makeContext({ tab: park, local: kim });
assert.strictEqual(vm.runInContext('_getReviewerSession().name', t.sandbox), '박은비');
assert.strictEqual(vm.runInContext('getSession().name', t.sandbox), '박은비');
assert.strictEqual(vm.runInContext("_getAuthHeaders()['X-Reviewer-Token']", t.sandbox), 'park-token');
console.log('  ✓ 관리자 홈 탭은 본계정 표시와 인증 헤더 모두 sessionStorage의 박은비를 사용');

t = makeContext({ tab: { ...park, expAt: past }, local: kim });
assert.strictEqual(vm.runInContext('_getReviewerSession()', t.sandbox), null);
assert.strictEqual(vm.runInContext("_getAuthHeaders()['X-Reviewer-Token'] || null", t.sandbox), null);
console.log('  ✓ 만료된 관리자 홈 세션은 localStorage의 다른 리뷰어로 폴백하지 않음');

t = makeContext({ tab: park, local: kim });
t.sessionStorage.setItem('rapp_reviewer_auth', '{broken');
assert.strictEqual(vm.runInContext('_getReviewerSession()', t.sandbox), null);
console.log('  ✓ 손상된 관리자 홈 세션도 다른 리뷰어로 폴백하지 않음');

t = makeContext({ local: kim });
assert.strictEqual(vm.runInContext('getSession().name', t.sandbox), '김민혜');
assert.strictEqual(vm.runInContext("_getAuthHeaders()['X-Reviewer-Token']", t.sandbox), 'kim-token');
console.log('  ✓ 일반 리뷰어의 localStorage 로그인은 기존처럼 유지');

t = makeContext({ tab: park, local: kim });
vm.runInContext('_clearReviewerSession()', t.sandbox);
assert.strictEqual(t.sessionStorage.value('rapp_reviewer_auth'), '');
assert.strictEqual(JSON.parse(t.localStorage.value('rapp_reviewer_auth')).name, '김민혜');
assert.strictEqual(vm.runInContext('_getReviewerSession()', t.sandbox), null);
console.log('  ✓ 관리자 홈 로그아웃은 다른 탭의 일반 로그인을 지우거나 즉시 노출하지 않음');

const subLogin = { name: '양승호(회사)', phone8: '33337191', reviewerToken: 'sub-token', expAt: future };
t = makeContext({ local: subLogin });
assert.strictEqual(vm.runInContext('getSession().name', t.sandbox), '양승호(회사)');
console.log('  ✓ 타계정 직접 로그인 명의도 바꾸지 않음');

const indexSessionStorage = memoryStorage();
const indexLocalStorage = memoryStorage({ rapp_reviewer_auth: JSON.stringify(kim) });
const indexContext = { sessionStorage: indexSessionStorage, localStorage: indexLocalStorage, JSON, Date };
vm.createContext(indexContext);
vm.runInContext(functionSource(indexHtml, 'syncSearchSession'), indexContext);
vm.runInContext('syncSearchSession({name:"박은비",phone8:"22227191",reviewerToken:"park-token",adminPreview:true})', indexContext);
assert.strictEqual(JSON.parse(indexSessionStorage.value('rapp_reviewer_auth')).name, '박은비');
assert.strictEqual(JSON.parse(indexLocalStorage.value('rapp_reviewer_auth')).name, '김민혜');
vm.runInContext('syncSearchSession({name:"새로그인",phone8:"44444444",reviewerToken:"new-token"})', indexContext);
assert.strictEqual(indexSessionStorage.value('rapp_reviewer_auth'), null);
assert.strictEqual(JSON.parse(indexLocalStorage.value('rapp_reviewer_auth')).name, '새로그인');
console.log('  ✓ 홈 진입은 탭 세션만 쓰고 명시적 일반 로그인은 오래된 탭 세션을 해제');

const searchSessionStorage = memoryStorage({ rapp_reviewer_auth: JSON.stringify(park) });
const searchLocalStorage = memoryStorage({ rapp_reviewer_auth: JSON.stringify(kim) });
const searchContext = { sessionStorage: searchSessionStorage, localStorage: searchLocalStorage, JSON, Date };
vm.createContext(searchContext);
vm.runInContext(`const REVIEWER_AUTH_KEY="rapp_reviewer_auth"; const REVIEWER_AUTH_MS=${12 * 60 * 60 * 1000}; let _authState=null;\n${functionSource(searchApp, '_saveAuthSession')}`, searchContext);
vm.runInContext('_saveAuthSession("직접로그인",true,true,"55555555","direct-token")', searchContext);
assert.strictEqual(searchSessionStorage.value('rapp_reviewer_auth'), null);
assert.strictEqual(JSON.parse(searchLocalStorage.value('rapp_reviewer_auth')).name, '직접로그인');
console.log('  ✓ 구매양식의 명시적 로그인도 오래된 관리자 홈 세션을 해제');

assert(!/function getSession\(\)[\s\S]{0,350}localStorage\.getItem\('rapp_reviewer_auth'\)/.test(campaign),
  'campaign getSession이 localStorage를 직접 읽으면 안 됨');
assert(!/localStorage\.getItem\(["']rapp_reviewer_auth["']\)/.test(searchApp),
  'search-app의 프로필·정산 경로가 reviewer 세션을 직접 읽으면 안 됨');
assert(/if \(user && user\.adminPreview\)[\s\S]{0,180}sessionStorage\.setItem\(REVIEWER_AUTH_KEY/.test(indexHtml)
  && /else \{[\s\S]{0,180}sessionStorage\.removeItem\(REVIEWER_AUTH_KEY\)[\s\S]{0,100}localStorage\.setItem\(REVIEWER_AUTH_KEY/.test(indexHtml),
  '관리자 홈과 일반 로그인 저장소 분리가 유지돼야 함');
console.log('  ✓ 캠페인·구매양식·프로필·정산 경로가 공통 판독기를 사용');

console.log('\n✅ reviewerSessionStorage: 9개 시나리오 통과');
