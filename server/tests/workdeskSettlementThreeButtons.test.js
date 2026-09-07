'use strict';

// 작업보드 정산 UI는 내부·업체 공통으로 진행 현황 안의 세 문서 버튼만 운영한다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
assert.match(src, /STATE\.cur=t; STATE\.settle=null;/,
  '작업 전환 즉시 이전 정산 상태를 비워야 합니다.');
assert.match(src, /class="tp3doc\$\{ready\?' ready':''\}"\$\{d\?'':' disabled'\}/,
  '현재 작업의 정산 정보가 로드되기 전에는 문서 버튼을 비활성화해야 합니다.');
assert.match(src, /if\(!STATE\.cur\|\|STATE\.cur\.sheetId!==t\.sheetId\|\|STATE\.cur\.tabName!==t\.tabName\) return;/,
  '이전 작업의 늦은 정산 응답이 현재 작업 상태를 덮지 않아야 합니다.');

assert.doesNotMatch(src, /id="setldetail"|id="settlementsec"|toggleSettleDetail/,
  '진행 현황 클릭으로 여는 하단 정산 블록이 없어야 합니다.');
assert.doesNotMatch(src, /genCloseout|dlCloseoutCsv|마감자료 생성/,
  '마감자료 생성·다운로드 UI 기능이 없어야 합니다.');
assert.doesNotMatch(src, /견적 수락|미결자료/,
  '제거하기로 한 중간 상태 문구가 없어야 합니다.');

console.log('workdeskSettlementThreeButtons: all tests passed');
