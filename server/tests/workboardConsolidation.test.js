'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const migration = read('migrations/139_workboard_consolidation_foundation.sql');
const safetyMigration = read('migrations/140_workboard_consolidation_safety.sql');
const service = read('src/services/workboardConsolidation.service.js');
const route = read('src/routes/workboardConsolidation.routes.js');
const app = read('src/app.js');
const orderLedgerUi = read('../frontend/js/index-order-ledger.js');
let passed = 0;
function ok(name, value) { assert.ok(value, name); passed++; }

ok('가산적 foundation migration', /ADD COLUMN IF NOT EXISTS workboard_id/.test(migration));
ok('배포 기본값은 legacy', /mode TEXT NOT NULL DEFAULT 'legacy'/.test(migration));
ok('백업은 sealed 상태로 생성', /state TEXT NOT NULL DEFAULT 'sealed'/.test(migration));
ok('백업 레코드는 원문 JSONB를 보관', /row_data JSONB NOT NULL/.test(migration));
ok('백업 대상은 최대 120건으로 제한', /const MAX_TARGETS = 120/.test(service));
ok('백업은 repeatable-read와 advisory lock으로 일관성을 확보', /BEGIN ISOLATION LEVEL REPEATABLE READ/.test(service) && /workboard_consolidation_backup/.test(service));
ok('연결 변경은 sealed 백업과 동일한 대상만 허용', /backup_target_mismatch/.test(service) && /state = 'sealed'/.test(service));
ok('연결 변경 저널이 있어야 ID를 비우는 롤백을 허용', /workboard_consolidation_link_events/.test(migration) && /revertAdditiveMappings/.test(service));
ok('즉시 롤백은 legacy 경로만 되살린다', /mode = 'legacy'/.test(service));
ok('백업·연결·롤백 API는 관리자 전용', /router\.post\('\/backups', authMiddleware, adminOrMasterMiddleware/.test(route) && /router\.post\('\/mappings', authMiddleware, adminOrMasterMiddleware/.test(route) && /rollback-mode', authMiddleware, adminOrMasterMiddleware/.test(route));
ok('연결과 롤백 API에는 명시 확인이 필요', /CREATE-WORKBOARD-PILOT-MAPPINGS/.test(route) && /ROLLBACK-WORKBOARD-CONSOLIDATION/.test(route) && /REVERT-WORKBOARD-PILOT-MAPPINGS/.test(route));
ok('라우터가 앱에 등록됨', /workboardConsolidationRoutes/.test(app) && /\/api\/workboard-consolidation/.test(app));
ok('기존 120건 승인목록과 새 작업은 서로 다른 출처로 고정',
  /legacy_120/.test(safetyMigration) && /new_work/.test(safetyMigration) && /ensureNewWorkTarget/.test(service));
ok('전체 전환 뒤 새 작업도 자동으로 enabled 상태가 됨',
  /source = 'new_work' AND workboard_id IS NOT NULL/.test(service));
ok('주문 원장 화면에서 실패 이유와 개별 다시 처리를 제공',
  /실패 이유/.test(orderLedgerUi) && /_olRetry/.test(orderLedgerUi) && /syncQueueRetry/.test(orderLedgerUi));

console.log(`workboardConsolidation: ${passed}개 통과`);
