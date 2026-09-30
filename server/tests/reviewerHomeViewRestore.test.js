'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');

function functionSource(name) {
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

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    value: key => values.has(key) ? values.get(key) : null,
  };
}

const functions = [
  '_reviewerHomeViewKey',
  '_reviewerHomeViewStore',
  '_readReviewerHomeView',
  '_saveReviewerHomeView',
  '_clearReviewerHomeView',
  '_restoreReviewerHomeView',
].map(functionSource).join('\n');

function context(user) {
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const switched = [];
  const sandbox = {
    JSON,
    localStorage,
    sessionStorage,
    getSavedUser: () => user,
    _currentTab: 'home',
    _reviewSubTab: 'pending',
    switchTab(tab) { sandbox._currentTab = tab; switched.push(tab); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`const HOME_VIEW_KEY="iad_reviewer_home_view_v1";\n${functions}`, sandbox);
  return { sandbox, localStorage, sessionStorage, switched };
}

let passed = 0;
function ok(name, check) {
  assert.ok(check, name);
  passed++;
  console.log('  ✓ ' + name);
}

console.log('\n▶ 리뷰어홈 마지막 화면 복원\n');

const normalUser = { phone8: '12345678', name: '일반리뷰어' };
let t = context(normalUser);
t.sandbox._currentTab = 'review';
t.sandbox._reviewSubTab = 'pending';
vm.runInContext('_saveReviewerHomeView()', t.sandbox);
const normalKey = 'iad_reviewer_home_view_v1:12345678';
ok('일반 리뷰어의 참여중 화면은 재실행 가능한 localStorage에 저장',
  JSON.parse(t.localStorage.value(normalKey)).tab === 'review'
    && JSON.parse(t.localStorage.value(normalKey)).reviewSubTab === 'pending'
    && t.sessionStorage.value(normalKey) === null);

t.sandbox._currentTab = 'home';
t.sandbox._reviewSubTab = 'done';
vm.runInContext('_restoreReviewerHomeView(getSavedUser())', t.sandbox);
ok('저장된 리뷰내역 > 참여중 화면을 복원',
  t.sandbox._currentTab === 'review' && t.sandbox._reviewSubTab === 'pending' && t.switched.at(-1) === 'review');

const adminUser = { phone8: '87654321', name: '관리자미리보기', adminPreview: true };
t = context(adminUser);
t.sandbox._currentTab = 'my';
vm.runInContext('_saveReviewerHomeView()', t.sandbox);
const adminKey = 'iad_reviewer_home_view_v1:87654321';
ok('관리자 미리보기 상태는 현재 탭의 sessionStorage에만 격리',
  JSON.parse(t.sessionStorage.value(adminKey)).tab === 'my' && t.localStorage.value(adminKey) === null);

t = context(normalUser);
t.localStorage.setItem(normalKey, JSON.stringify({ tab: 'unknown', reviewSubTab: 'done' }));
vm.runInContext('_restoreReviewerHomeView(getSavedUser())', t.sandbox);
ok('알 수 없는 저장값은 무시하고 홈 > 참여중 기본값으로 안전 복귀',
  t.sandbox._currentTab === 'home' && t.sandbox._reviewSubTab === 'pending');

t = context(normalUser);
t.localStorage.setItem(normalKey, '{broken');
vm.runInContext('_restoreReviewerHomeView(getSavedUser())', t.sandbox);
ok('손상된 저장값도 화면을 막지 않고 홈으로 복귀', t.sandbox._currentTab === 'home');

t = context(normalUser);
t.sandbox._currentTab = 'cs';
vm.runInContext('_saveReviewerHomeView()', t.sandbox);
vm.runInContext('_clearReviewerHomeView(getSavedUser())', t.sandbox);
ok('로그아웃하면 현재 리뷰어의 화면 위치를 삭제', t.localStorage.value(normalKey) === null);

ok('직접 이동 주소는 로그인 복원 뒤 실행되어 저장 화면보다 우선',
  /await initPage\(\);[\s\S]{0,500}location\.hash === "#review"[\s\S]{0,180}switchReviewSubTab\("done"\)[\s\S]{0,100}switchTab\("review"\)/.test(source)
    && /else if \(location\.hash === "#my" \|\| location\.hash === "#info"\)[\s\S]{0,100}switchTab\("my"\)/.test(source));

ok('하단 탭과 리뷰 서브탭 전환이 모두 화면 위치를 저장',
  functionSource('switchTab').includes('_saveReviewerHomeView()')
    && functionSource('switchReviewSubTab').includes('_saveReviewerHomeView()'));

console.log(`\n✅ reviewerHomeViewRestore: ${passed}개 통과\n`);
