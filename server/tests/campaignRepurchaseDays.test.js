'use strict';

/**
 * 모집공고별 재참여 제한 저장 → 복원 → 실제 판정 배선 회귀가드.
 * 실행: node tests/campaignRepurchaseDays.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const migration = read(path.join(serverRoot, 'migrations', '148_campaign_repurchase_days.sql'));
const entry = read(path.join(serverRoot, 'index.js'));
const campaigns = read(path.join(serverRoot, 'src', 'routes', 'campaign.routes.js'));
const manualRoute = read(path.join(serverRoot, 'src', 'routes', 'manualOrder.routes.js'));
const manualService = read(path.join(serverRoot, 'src', 'services', 'manualOrder.service.js'));
const guard = read(path.join(serverRoot, 'src', 'utils', 'repurchaseGuard.js'));
const modal = read(path.join(repoRoot, 'frontend', 'js', 'recruit-modal.js'));
const recruit = read(path.join(repoRoot, 'frontend', 'js', 'index-recruit.js'));

assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS repurchase_days INTEGER NOT NULL DEFAULT 14'),
  '기존/신규 공고의 기본값은 종전과 같은 14일');
assert.ok(migration.includes('CHECK (repurchase_days BETWEEN 0 AND 365)'), 'DB가 0~365 범위를 최종 방어');
assert.ok(entry.includes("['recruit_campaigns', 'repurchase_days']"), '컬럼 누락 시 서버 기동을 차단');

assert.ok(campaigns.includes('repurchase_days, // ★ 148'), 'create/update 요청에서 공고별 값을 받음');
assert.ok(campaigns.includes('recall_product, repurchase_days)'), 'create INSERT에 값을 저장');
assert.ok(campaigns.includes('repurchase_days = COALESCE($50::integer, repurchase_days)'),
  'update 미전송은 보존하고 명시값은 갱신');
assert.ok(campaigns.includes('days: camp.repurchase_days'), '리뷰어 참여 최종 차단이 대상 공고 저장값을 사용');
assert.ok(campaigns.includes('재참여 제한 기간은 제한 없음(0일) 또는 1~365일'), '서버 입력 범위 검증');

assert.ok(guard.includes('rc.repurchase_days'), '홈 카드 상태 조회도 공고별 값을 조회');
assert.ok(guard.includes('const days = repurchaseDays(r.repurchase_days)'), '각 공고의 기간으로 상태를 계산');
assert.ok(manualRoute.includes('resolveCampaignRepurchaseDays(pool, campaignId)'),
  '관리자 수동제출 사전 판정도 선택한 공고 값을 사용');
assert.ok(manualRoute.includes('repurchaseDaysOverride: effectiveRepurchaseDays'),
  '사전 판정값을 건별 최종 방어에 전달');
assert.ok(manualService.includes('days: effectiveRepurchaseDays'), '수동제출 최종 방어도 같은 값을 사용');

const multiAt = modal.indexOf('id="rf_multi_account_toggle"');
const repurchaseAt = modal.indexOf('id="rf_repurchase_days_toggle"');
assert.ok(multiAt > -1 && repurchaseAt > multiAt, '재참여 제한은 기본 설정의 다계정 허용 바로 다음에 배치');
for (const label of ['7일', '14일', '21일', '직접입력', '제한 없음']) {
  assert.ok(modal.includes(`>${label}</button>`), `${label} 선택지를 렌더`);
}
assert.ok(modal.includes('id="rf_repurchase_custom_days"') && modal.includes('max="365"'), '직접입력 1~365일 UI');
assert.ok(recruit.includes('payload.repurchase_days = _days'), '저장 payload 포함');
assert.ok(recruit.includes('c.repurchase_days ?? 14'), '편집 시 서버 저장값 복원');
assert.ok(recruit.includes('rfSetRepurchaseDays(14)'), '신규 공고 기본 14일 초기화');

console.log('PASS campaign-specific repurchase days persistence and enforcement wiring');
