/**
 * 작업 조건 [미설정]은 작업오더 원본 편집이 아닌 모집공고 설정으로 이어져야 한다.
 * 실행: node server/tests/workdeskConditionRecruitSettingsRoute.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const wd = fs.readFileSync(path.join(root, 'frontend', 'workdesk.html'), 'utf8').replace(/\r\n/g, '\n');
const block = (start, end) => wd.slice(wd.indexOf(start), wd.indexOf(end, wd.indexOf(start)));
const fixGate = block('function _cndFixGate(cd,kind){', '\nasync function _cndFix(kind){');
const fix = block('async function _cndFix(kind){', '\n/* 작업오더 수정');
const publish = block('async function _cndPublish(cd){', '\n/* 공용 미니 팝업');

assert.ok(/if\(kind==='order'\) return cd\.campaignId[\s\S]*?모집공고 설정/.test(fixGate),
  '결제금액·유입방식 등의 미설정 안내는 모집공고 설정이어야 한다');
assert.ok(/if\(kind==='quota'\)\{[\s\S]*?if\(cd\.campaignId\) return openCurrentCampaignDailyPlan\(\);[\s\S]*?return _cndPublish\(cd\);/.test(fix),
  '공고 없는 총건수·일건수는 작업오더 수정이 아니라 모집공고 설정을 열어야 한다');
assert.ok(/if\(kind==='order'\|\|kind==='displayName'\)\{[\s\S]*?if\(!cd\.campaignId\) return _cndPublish\(cd\);[\s\S]*?return openRecruitModal\(String\(cd\.campaignId\)\);/.test(fix),
  '공고 유무와 관계없이 작업조건의 order 항목은 모집공고 설정으로 가야 한다');
assert.ok(!/_cndOrderModal\(cd\)/.test(fix),
  '작업 조건의 수정 동선은 작업오더 관리자 수정 모달을 열지 않는다');
assert.ok(/_woCampaignPrefill\(o\),o\.id/.test(publish),
  '연결 작업오더 값은 모집공고 설정의 프리필로만 전달한다');
assert.ok(/function _woAdminEdit\(id\)\{[\s\S]*?woAdminEditModal\(o,\{/.test(wd),
  '작업오더 탭의 별도 관리자 수정 기능은 그대로 유지한다');

console.log('✅ workdeskConditionRecruitSettingsRoute: 6 cases passed');
