'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const cron = fs.readFileSync(path.join(ROOT, 'src/jobs/cron.js'), 'utf8');
const apply = fs.readFileSync(path.join(ROOT, 'src/services/workboardQueueApply.service.js'), 'utf8');

assert.ok(/WORKBOARD_RECONCILE_CRON !== '0'/.test(cron), '독립 작업보드 리컨실 킬스위치가 필요하다');
assert.ok(/WORKBOARD_RECONCILE_CRON_SCHEDULE \|\| '1-59\/2 \* \* \* \*'/.test(cron), '시트 리컨실과 어긋난 기본 주기가 필요하다');
assert.ok(/withJobLock\('order_reconcile'/.test(cron), '기존 리컨실과 같은 advisory lock을 사용해야 한다');
const block = cron.split("WORKBOARD_RECONCILE_CRON !== '0'")[1].split('// ── written 사후검증')[0];
assert.ok(!/ORDER_BATCH_AUTO/.test(block), 'ORDER_BATCH_AUTO가 작업보드 큐 복구를 차단하면 안 된다');
assert.ok(/recoverMissingWorkboardQueues/.test(block), '큐 누락 전용 복구 함수를 호출해야 한다');
assert.ok(/WORKBOARD_RECONCILE_WINDOW_HOURS \|\| '48'/.test(block), '오래된 이관 잔여분을 자동 재처리하지 않도록 시간창이 필요하다');
assert.ok(/NOT EXISTS \([\s\S]*?campaign_participants/.test(apply), '이미 작업표 링크가 있는 주문은 제외해야 한다');
assert.ok(/os\.workboard_id IS NULL OR os\.workboard_id = t\.workboard_id/.test(apply), '다른 작업보드 연결은 자동 변경하면 안 된다');
assert.ok(/Math\.min\(Math\.max\(parseInt\(limit/.test(apply), '회차 처리 상한이 필요하다');

console.log('workboardReconcileCron: 9개 통과');
