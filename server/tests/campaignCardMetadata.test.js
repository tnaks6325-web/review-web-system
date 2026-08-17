/** 카드의 유입방식·자동배지 표기가 저장된 작업 설정과 일치하는지 확인한다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const cards = fs.readFileSync(path.join(root, 'frontend', 'js', 'campaign-cards.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'campaign.routes.js'), 'utf8');

assert.match(cards, /const inflowType = _wd && _wd\.inflowType/,
  '카드는 저장된 work_detail의 유입방식을 사용해야 한다');
assert.match(cards, /inflowType === 'link'/,
  '카드는 링크유입을 가이드 내용보다 우선해야 한다');
assert.match(cards, /String\(b\) !== '사진 5장\+'/,
  '카드는 과거에 자동 저장된 사진 5장+ 배지를 숨긴다');
assert.match(routes, /const workDetail = sanitizeWorkDetail\(camp\.work_detail\)/,
  '목록 API는 공고에 저장된 유입방식의 정규화 원본을 사용해야 한다');

console.log('campaign card metadata: OK');
