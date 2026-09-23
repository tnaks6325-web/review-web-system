/**
 * startSetupLinkAndThumb.test.js — [⚙ 작업 시작 설정] 두 사고의 회귀가드 (2026-09-23).
 *
 * ① 저장이 "작업보드 표시명은 연결된 작업보드에서만 설정할 수 있습니다"로 거부되던 것:
 *    작업오더에서 [⚙ 작업 시작 설정]을 누르면 모집공고 화면으로 옮기면서(탭 목록을 await 없이
 *    다시 받음) 모달을 연다. 모달이 연결 작업을 고른 뒤에 그 목록 요청이 끝나면 드롭다운이
 *    통째로 비워져, 저장이 "연결 안 함"으로 나가고 표시명 칸은 켜진 채 남았다.
 *    ⇒ 목록 갱신은 그 순간의 선택을 되살리고, 표시명 칸은 연결값과 같은 근거로만 전송한다.
 * ② 리뷰오더에서 고른 썸네일이 모집공고로 안 넘어오던 것: 발행 프리필(_woCampaignPrefill)에
 *    thumbnail_url 이 없었고 자동수집이 빈 값을 채웠다.
 * 실행: node tests/startSetupLinkAndThumb.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const recruit = readF('js/index-recruit.js');
const wod = readF('js/work-order-detail.js');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert(i >= 0, name + ' 없음');
  const open = src.indexOf('{', i);
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  throw new Error(name + ' 끝 못 찾음');
}

console.log('[①] 목록 갱신이 고른 연결 작업을 지우지 않는다');
{
  const load = fnSrc(recruit, 'loadRecruitTabOptions');
  ok('목록 갱신 두 갈래 모두 선택 보존 함수를 쓴다', (load.match(/_rfRepopulateLinkedSelects\(\)/g) || []).length === 2);
  ok('목록 갱신이 선택을 버리는 맨 호출을 하지 않는다', !/_populateCampaignSelect\(\)/.test(load));

  // 실행: 선택 → 재구성(선택 지움) → 되살림
  const calls = [];
  const tab = { value: 'S1||탭A' };
  const sandbox = {
    document: { getElementById: (id) => (id === 'rf_linked_tab' ? tab : null) },
    _populateCampaignSelect: () => { calls.push('populate'); tab.value = ''; },
    _restoreLinkedTab: (s, t) => { calls.push('restore:' + s + '|' + t); tab.value = s + '||' + t; return true; },
    _syncWorkboardDisplayNameInput: () => calls.push('sync'),
  };
  vm.runInNewContext(fnSrc(recruit, '_rfRepopulateLinkedSelects') + ';_rfRepopulateLinkedSelects();', sandbox);
  ok('재구성 뒤 같은 연결 작업을 되살린다', calls.includes('restore:S1|탭A') && tab.value === 'S1||탭A');
  ok('되살린 뒤 표시명 칸 잠금을 다시 맞춘다', calls[calls.length - 1] === 'sync');

  const pop = fnSrc(recruit, '_populateCampaignSelect');
  ok('드롭다운을 비울 때 표시명 칸도 다시 맞춘다', /_syncWorkboardDisplayNameInput\(\)/.test(pop));

  const save = fnSrc(recruit, 'saveRecruitPostImpl');
  ok('표시명은 연결값(tabKey)이 있거나 수정 모드일 때만 전송', /!workboardDisplayNameInput\.disabled && \(tabKey \|\| _recruitEditId\)/.test(save));
}

console.log('[②] 리뷰오더 썸네일 → 모집공고');
{
  const sandbox = { window: {}, console };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(wod, sandbox, { filename: 'work-order-detail.js' });
  const p = sandbox.window._woCampaignPrefill({ id: 'w1', title: 't', thumbnail_url: 'https://api.example/api/order/guide-image/abcdefghijkl' });
  ok('발행 프리필이 썸네일을 싣는다', p.thumbnail_url === 'https://api.example/api/order/guide-image/abcdefghijkl');
  ok('썸네일이 없으면 빈 값', sandbox.window._woCampaignPrefill({ id: 'w2', title: 't' }).thumbnail_url === '');

  const open = fnSrc(recruit, 'openRecruitModal');
  ok('신규 발행 프리필이 썸네일 칸을 채운다', /if \(prefill\.thumbnail_url\)/.test(open));
  ok('수정 모드는 공고 저장값 우선, 비었을 때만 작업오더 값', /c\.thumbnail_url \|\| \(prefill && prefill\.thumbnail_url\)/.test(open));

  const fetchSrc = fnSrc(recruit, 'fetchProductInfo');
  ok('자동수집 1회 시도는 이미 있는 썸네일을 덮지 않는다', /r\.thumbnail && !\(auto && _hasThumb\)/.test(fetchSrc));
}

console.log(`✅ startSetupLinkAndThumb: ${n}개 통과`);
