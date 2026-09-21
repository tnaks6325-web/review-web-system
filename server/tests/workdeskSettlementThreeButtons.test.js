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
assert.match(src, /btn\('quote','견적서',qReady,qSub,!qReady&&!qRetry,qRetry\)/,
  '견적서가 확정적으로 없을 때만 견적서 버튼이 disabled 상태여야 합니다.');
assert.match(src, /\.tp3doc:disabled\{cursor:not-allowed;color:#aeb6c2;background:#f5f7fa[^}]*opacity:1\}/,
  '없는 견적서 버튼은 불투명한 회색 상태로 명확히 보여야 합니다.');
assert.ok(src.indexOf('.tp3doc:disabled{') > src.indexOf('.tp3doc:hover,'),
  '비활성 버튼에도 :hover 가 걸리므로 :disabled 규칙이 뒤에 와서 이겨야 합니다.');
assert.match(src, /\.tp3doc\{[^}]*color:#98a2b3/,
  '자료가 비어 있는 정산 버튼은 회색 글자여야 합니다(파란 글자면 이미 된 것처럼 보입니다).');
assert.match(src, /\.tp3doc\.ready\{[^}]*color:var\(--accent-deep\)/,
  '자료가 있는 정산 버튼은 연보라색이 아닌 공통 블루 토큰을 사용해야 합니다.');
assert.match(src, /\.tp3doc\.ready \.tp3dot\{background:var\(--accent\)/,
  '자료가 있으면 상태 점이 블루로 채워져야 합니다.');
assert.doesNotMatch(src, /\.tp3doc\.ready::before/,
  '체크 표시는 폐지했습니다 - 컬러(자료 있음) 대 회색(비어 있음)으로만 가릅니다.');
assert.match(src, /\.tp3match\{grid-column:1;border-style:dashed[^}]*padding:7px 5px\}/,
  '계약 매칭은 문서 칸이 아니므로 점·날짜 없는 종전 모양을 유지해야 합니다.');
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
assert.match(src, /class="tp3doc\$\{ready\?' ready':''\}\$\{unknown\?' unknown':''\}"\$\{disabled\?' disabled':''\}/,
  '현재 작업의 정산 정보가 로드되기 전에는 문서 버튼을 비활성화해야 합니다.');
assert.match(src, /<span class="tp3dot"><\/span>\$\{label\}<span class="tp3sub">\$\{esc\(sub\)\}<\/span>/,
  '정산 버튼은 상태 점과 값 한 조각(날짜/미발행)을 함께 그려야 합니다.');
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
// setlSummaryHtml 이 쓰는 헬퍼는 스텁이 아니라 **구현을 그대로** 넣는다(사본을 두면 거기서만 회귀를 못 본다).
const pick = (needle, endsWith) => {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `${needle} 구현을 찾지 못했습니다.`);
  const j = src.indexOf(endsWith, i);
  assert.ok(j > i, `${needle} 구현의 끝을 찾지 못했습니다.`);
  return src.slice(i, j + endsWith.length);
};
const box = { STATE: { role: 'master' } };
vm.createContext(box);
vm.runInContext(pick('const esc=s=>String(', '\n'), box);
vm.runInContext(pick('function _awMD(d){', 'v.slice(0,10); }'), box);
vm.runInContext(summarySrc, box);
// 버튼 안에 상태 점·값 span 이 들어 있으므로 닫는 태그로 끊어 그 라벨이 든 조각을 고른다.
const button = (html, label) => {
  const part = html.split('</button>').find(chunk => chunk.includes('>' + label + '<'));
  return part == null ? '' : part + '</button>';
};
const sub = (html, label) => ((button(html, label).match(/<span class="tp3sub">([^<]*)<\/span>/) || [])[1]) || '';

let html = box.setlSummaryHtml({ linked: false });
assert.match(button(html, '견적서'), / disabled/,
  '미매칭 탭의 없는 견적서는 클릭할 수 없는 회색 버튼이어야 합니다.');
assert.doesNotMatch(button(html, '계산서'), / disabled/,
  '견적서 없음 상태가 다른 확인 버튼까지 비활성화하면 안 됩니다.');
assert.ok(html.indexOf('계약 매칭</button>') > html.indexOf('>입금<'),
  '계약 매칭은 첫 줄 문서 버튼 뒤에 렌더되어 CSS 그리드의 견적서 아래 칸에 놓여야 합니다.');
assert.equal(sub(html, '견적서'), '없음', '계약 미매칭 탭의 견적서 칸은 비어 있다고 적어야 합니다.');
assert.equal(sub(html, '입금'), '미입금', '아직 입금되지 않은 칸은 미입금이라고 적어야 합니다.');

html = box.setlSummaryHtml({ linked: true, quote: null });
assert.match(button(html, '견적서'), / disabled/);
assert.doesNotMatch(html, /계약 매칭/,
  '계약이 이미 매칭됐으면 견적서 유무와 무관하게 계약 매칭 버튼을 숨겨야 합니다.');

html = box.setlSummaryHtml({ linked: true, quote: null, quoteLookupFailed: true });
assert.doesNotMatch(button(html, '견적서'), / disabled/,
  '인트라넷 견적 조회가 일시 실패했으면 견적서 버튼을 열어 재조회할 수 있어야 합니다.');
assert.match(button(html, '견적서'), /class="tp3doc unknown"/,
  '조회에 실패한 견적서는 회색(없음)이 아니라 주황(모름)으로 구분해야 합니다.');
assert.equal(sub(html, '견적서'), '확인 필요',
  '조회 실패를 없음이라고 적으면 자료가 없다고 거짓으로 알려 주게 됩니다.');

html = box.setlSummaryHtml({ linked: true, quote: { quoteNumber: 'Q-1' } });
assert.match(button(html, '견적서'), /class="tp3doc ready"/);
assert.doesNotMatch(button(html, '견적서'), / disabled/,
  '실제 견적번호가 있으면 견적서 버튼은 블루 활성 상태여야 합니다.');
assert.equal(sub(html, '견적서'), '등록됨',
  '견적일을 모르면 날짜를 지어내지 말고 등록됐다고만 적어야 합니다.');

// 인트라넷 날짜는 ISO 와 붙여 쓴 8자리 두 모양으로 온다 - 둘 다 날짜로 읽어야 한다.
html = box.setlSummaryHtml({ linked: true, quote: { quoteNumber: 'Q-1', quoteDate: '2026-09-12' },
  invoice: { status: 'issued', date: '20260918' }, payment: { status: 'paid' }, paidDate: '2026-09-20' });
assert.equal(sub(html, '견적서'), '9/12', 'ISO 날짜를 월/일로 줄여 적어야 합니다.');
assert.equal(sub(html, '계산서'), '9/18', '붙여 쓴 8자리 날짜도 월/일로 읽어야 합니다.');
assert.equal(sub(html, '입금'), '9/20');
['견적서', '계산서', '입금'].forEach(label =>
  assert.match(button(html, label), /class="tp3doc ready"/, `${label}가 준비됐으면 컬러여야 합니다.`));

// 날짜로 읽을 수 없는 값은 그대로 흘리지 않는다(20260912 가 버튼에 박히던 자리).
html = box.setlSummaryHtml({ linked: true, quote: { quoteNumber: 'Q-1', quoteDate: '기재없음' } });
assert.equal(sub(html, '견적서'), '등록됨', '날짜로 못 읽은 원본 값을 버튼에 그대로 찍으면 안 됩니다.');

// 광고주 정산 비공개는 '아직'이 아니라 '모름' - 미발행이라고 단정하지 않는다.
html = box.setlSummaryHtml({ hidden: true, linked: true });
assert.equal(sub(html, '계산서'), '—', '정산이 비공개면 발행 여부를 단정해 적으면 안 됩니다.');

// 정산 정보가 도착하기 전에는 값 자리를 비워 둔다.
html = box.setlSummaryHtml(null);
['견적서', '계산서', '입금'].forEach(label => {
  assert.match(button(html, label), / disabled/, '로드 전에는 문서 버튼을 비활성화해야 합니다.');
  assert.equal(sub(html, label), '…', '로드 전에는 값을 지어내지 말아야 합니다.');
});

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
