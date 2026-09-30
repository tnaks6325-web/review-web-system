'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const queueApply = read('src/services/workboardQueueApply.service.js');
const queue = read('src/services/syncQueue.service.js');
const ledger = read('src/services/orderLedger.service.js');
const submit = read('src/routes/submit.routes.js');
let passed = 0;
function ok(name, value) { assert.ok(value, name); passed++; }

ok('legacy에서는 새 큐 경로를 차단한다', /control\.mode === 'legacy'/.test(queueApply));
ok('workboard_id 없는 무시트 작업도 새 큐 경로를 차단한다', /reason: 'not_mapped'/.test(queueApply));
ok('큐 소비자는 기존 작업보드 기록 함수 하나만 사용한다', /sheetlessOrder\.service'\)\.writeOrderToWorktable/.test(queueApply));
ok('큐 타입이 워커에 등록된다', /case 'workboard_apply'/.test(queue));
ok('큐 대기 중에는 원장을 written으로 조기 전이하지 않는다', /deferSheetlessApply/.test(ledger) && /workboard_apply_pending/.test(ledger));
ok('제출은 pilot 대상만 workboard_apply를 enqueue한다', /enqueue\('workboard_apply'/.test(submit) && /queuedWorkboardApply/.test(submit));
ok('새 경로 큐는 일반 order_append 배치가 아니라 queuePump로 즉시 소비한다', /if \(queuedWorkboardApply\)[\s\S]{0,140}kickQueuePump/.test(submit));
ok('직접 반영은 새 큐 대상에서 실행하지 않는다', /if \(ledger\.sheetRow && !queuedWorkboardApply\)/.test(submit));
ok('큐 누락 복구는 기존 큐 이력이 한 건도 없는 주문만 고른다',
  /NOT EXISTS \([\s\S]*?FROM sync_queue sq[\s\S]*?sq\.type = 'workboard_apply'[\s\S]*?orderSubmissionId/.test(queueApply));
ok('큐 누락 복구는 제출 직후 정상 enqueue와 경합하지 않도록 유예한다',
  /submitted_at < NOW\(\) - make_interval\(secs => \$2::int\)/.test(queueApply));
ok('큐 누락 복구는 현재 활성 작업보드와 rollout 상태를 함께 검증한다',
  /JOIN workboards w[\s\S]*?w\.state = 'active'[\s\S]*?t\.rollout_state = 'enabled'/.test(queueApply));
console.log(`workboardQueueApply: ${passed}개 통과`);
