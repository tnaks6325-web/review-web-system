'use strict';

// 작업보드 정산 UI는 문서 세 버튼을 공통으로 쓰고, 내부 미매칭 상태만 계약 매칭을 덧붙인다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

assert.match(src, /const setlIn=`<div class="setlin" id="setlCell">/,
  '진행 현황 안에 정산 버튼 영역이 있어야 합니다.');
assert.doesNotMatch(src, /const setlIn=isAdv\?/,
  '업체 화면에서 정산 버튼을 제외하는 역할 분기가 없어야 합니다.');
assert.match(src, /btn\('quote','견적서'/);
assert.match(src, /btn\('invoice','계산서'/);
assert.match(src, /btn\('payment','입금'/);
assert.match(src, /function openSettlementPayment\(\)/,
  '입금 버튼도 실제 확인 팝업을 열어야 합니다.');
assert.match(src, /btn\('quote','견적서',qReady,!qReady&&!qRetry\)/,
  '견적서가 확정적으로 없을 때만 견적서 버튼이 disabled 상태여야 합니다.');
assert.match(src, /\.tp3doc:disabled\{cursor:not-allowed;color:#98a2b3;background:#eef1f5/,
  '없는 견적서 버튼은 불투명한 회색 상태로 명확히 보여야 합니다.');
assert.match(src, /\.tp3doc\{[^}]*color:var\(--accent\)/,
  '정산 버튼 텍스트는 연보라색이 아닌 공통 블루 토큰을 사용해야 합니다.');
assert.match(src, /const canMatch=!!d&&!d\.hidden&&!d\.linked&&\(STATE\.role==='master'\|\|STATE\.role==='admin'\|\|STATE\.role==='staff'\)/,
  '계약 매칭 버튼은 미매칭 상태의 내부 편집 역할에만 보여야 합니다.');
assert.match(src, /class="tp3doc tp3match" onclick="openProgressContractMatch\(event\)">계약 매칭<\/button>/,
  '미매칭 계약 액션이 견적서 아래의 그리드 첫 칸에 있어야 합니다.');
assert.match(src, /\.tp3match\{grid-column:1;/,
  '계약 매칭 버튼 위치는 견적서 바로 아래로 고정해야 합니다.');
assert.match(src, /function openProgressContractMatch\(ev\)[\s\S]{0,280}STATE\.role==='master'[\s\S]{0,280}d\.linked\) return;/,
  '업체 화면이나 이미 매칭된 상태에서 직접 호출해도 계약 매칭 모달이 열리지 않아야 합니다.');
assert.match(src, /STATE\.cur=t; STATE\.settle=null;/,
  '작업 전환 즉시 이전 정산 상태를 비워야 합니다.');
assert.match(src, /class="tp3doc\$\{ready\?' ready':''\}"\$\{disabled\?' disabled':''\}/,
  '현재 작업의 정산 정보가 로드되기 전에는 문서 버튼을 비활성화해야 합니다.');
assert.match(src, /if\(!STATE\.cur\|\|STATE\.cur\.sheetId!==t\.sheetId\|\|STATE\.cur\.tabName!==t\.tabName\) return;/,
  '이전 작업의 늦은 정산 응답이 현재 작업 상태를 덮지 않아야 합니다.');

assert.doesNotMatch(src, /id="setldetail"|id="settlementsec"|toggleSettleDetail/,
  '진행 현황 클릭으로 여는 하단 정산 블록이 없어야 합니다.');
assert.doesNotMatch(src, /genCloseout|dlCloseoutCsv|마감자료 생성/,
  '마감자료 생성·다운로드 UI 기능이 없어야 합니다.');
assert.doesNotMatch(src, /견적 수락|미결자료/,
  '제거하기로 한 중간 상태 문구가 없어야 합니다.');

// 실제 렌더 함수를 실행해 역할·연결·견적 유무 조합을 고정한다.
const summarySrc = src.slice(src.indexOf('function setlSummaryHtml(d){'), src.indexOf('function openSettlementDocument(ev,kind){'));
const box = { STATE: { role: 'master' } };
vm.createContext(box);
vm.runInContext(summarySrc, box);
const button = (html, label) => (html.match(new RegExp(`<button[^>]*>${label}<\\/button>`)) || [''])[0];

let html = box.setlSummaryHtml({ linked: false });
assert.match(button(html, '견적서'), / disabled/,
  '미매칭 탭의 없는 견적서는 클릭할 수 없는 회색 버튼이어야 합니다.');
assert.doesNotMatch(button(html, '계산서'), / disabled/,
  '견적서 없음 상태가 다른 확인 버튼까지 비활성화하면 안 됩니다.');
assert.ok(html.indexOf('계약 매칭</button>') > html.indexOf('입금</button>'),
  '계약 매칭은 첫 줄 문서 버튼 뒤에 렌더되어 CSS 그리드의 견적서 아래 칸에 놓여야 합니다.');

html = box.setlSummaryHtml({ linked: true, quote: null });
assert.match(button(html, '견적서'), / disabled/);
assert.doesNotMatch(html, /계약 매칭/,
  '계약이 이미 매칭됐으면 견적서 유무와 무관하게 계약 매칭 버튼을 숨겨야 합니다.');

html = box.setlSummaryHtml({ linked: true, quote: null, quoteLookupFailed: true });
assert.doesNotMatch(button(html, '견적서'), / disabled/,
  '인트라넷 견적 조회가 일시 실패했으면 견적서 버튼을 열어 재조회할 수 있어야 합니다.');

html = box.setlSummaryHtml({ linked: true, quote: { quoteNumber: 'Q-1' } });
assert.match(button(html, '견적서'), /class="tp3doc ready"/);
assert.doesNotMatch(button(html, '견적서'), / disabled/,
  '실제 견적번호가 있으면 견적서 버튼은 블루 활성 상태여야 합니다.');

box.STATE.role = 'advertiser';
html = box.setlSummaryHtml({ linked: false });
assert.doesNotMatch(html, /계약 매칭/,
  '광고주 화면에는 편집 권한이 필요한 계약 매칭 버튼을 노출하지 않아야 합니다.');

const openSrc = src.slice(src.indexOf('function openProgressContractMatch(ev){'), src.indexOf('// 업체관리와 작업보드가 같은 계약 매칭 모달을 공유한다.'));
let opened = null;
const openBox = { STATE: { role: 'advertiser', settle: { data: { linked: false }, tab: { sheetId: 'S1', tabName: 'T1' } } }, openContractMatchModal: ctx => { opened = ctx; } };
vm.createContext(openBox);
vm.runInContext(openSrc, openBox);
openBox.openProgressContractMatch(null);
assert.equal(opened, null, '광고주가 함수를 직접 호출해도 모달이 열리지 않아야 합니다.');
openBox.STATE.role = 'staff';
openBox.openProgressContractMatch(null);
assert.deepEqual(opened, { sheetId: 'S1', tabName: 'T1', linked: false },
  '내부 미매칭 탭은 기존 공용 계약 매칭 모달을 정확한 탭 문맥으로 열어야 합니다.');

console.log('workdeskSettlementThreeButtons: all tests passed');
