/*
 * 무시트 작업표의 홈 표시/공고발행 회귀 가드.
 * 빈 슬롯은 review_index 에 존재하지 않는 것이 정상이라, 홈 집계와 발행 프리필이
 * 그 검색 인덱스만 보지 않도록 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const trackB = read('src/services/trackB.service.js');
const workdesk = read('../frontend/workdesk.html');

assert.match(trackB,
  /CASE WHEN COALESCE\(tc\.sheetless, FALSE\) THEN COALESCE\(cp\.total_count, 0\) ELSE im\.row_count END AS "rowCount"/,
  '무시트 홈 총원은 검색 인덱스가 아닌 활성 작업표 슬롯을 써야 한다');
assert.match(trackB,
  /COUNT\(\*\) FILTER \(WHERE active AND deleted_at IS NULL\)::int AS total_count/,
  '삭제·비활성 슬롯은 홈 총원에서 제외해야 한다');
assert.match(workdesk,
  /const wo=await _campWorkOrderForTab\(t\);[\s\S]{0,260}_woCampaignPrefill\(wo\)/,
  '홈 공고발행도 작업오더 원본을 공용 프리필에 전달해야 한다');
assert.match(workdesk,
  /openRecruitModal\(id\|\|null, prefill, woOrderId\|\|null\)/,
  '홈에서 만든 공고도 작업오더 역연결 ID를 전달해야 한다');

console.log('✅ sheetlessHomeCampaign: 4개 통과');
