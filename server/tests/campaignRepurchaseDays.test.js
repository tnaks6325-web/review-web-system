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
const home = read(path.join(repoRoot, 'frontend', 'index.html'));

assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS repurchase_days INTEGER;'),
  '기존 공고는 NULL로 두어 배포 전 운영 기본값을 상속');
assert.ok(migration.includes('ALTER COLUMN repurchase_days SET DEFAULT 14'),
  '직접 INSERT 등 신규 공고의 DB 안전망 기본값은 14일');
assert.ok(!migration.includes('SET repurchase_days = 14') && !migration.includes('ALTER COLUMN repurchase_days SET NOT NULL'),
  '기존 공고의 운영 기본값을 14일로 강제 덮어쓰지 않음');
assert.ok(migration.includes('CHECK (repurchase_days IS NULL OR repurchase_days BETWEEN 0 AND 365)'),
  'DB가 레거시 NULL 또는 0~365 범위만 허용');
assert.ok(entry.includes("['recruit_campaigns', 'repurchase_days']"), '컬럼 누락 시 서버 기동을 차단');

assert.ok(campaigns.includes('repurchase_days, // ★ 148'), 'create/update 요청에서 공고별 값을 받음');
assert.ok(campaigns.includes('recall_product, repurchase_days)'), 'create INSERT에 값을 저장');
assert.ok(campaigns.includes('repurchase_days = COALESCE($50::integer, repurchase_days)'),
  'update 미전송은 보존하고 명시값은 갱신');
assert.ok(campaigns.includes('repurchase_days: effectiveRepurchaseDays'),
  '기존 NULL 공고 편집 시 운영 중인 유효 기본값을 복원');
assert.ok(campaigns.includes('days: camp.repurchase_days'), '리뷰어 참여 최종 차단이 대상 공고 저장값을 사용');
assert.ok(campaigns.includes('재참여 제한 기간은 제한 없음(0일) 또는 1~365일'), '서버 입력 범위 검증');
const confirmStart = campaigns.indexOf("router.post('/admin/:id/confirm'");
const confirmEnd = campaigns.indexOf("router.post('/admin/:id/dismiss'", confirmStart);
const confirmRoute = campaigns.slice(confirmStart, confirmEnd);
assert.ok(confirmStart > -1 && !confirmRoute.includes("status = 'submitted' LIMIT 1"),
  '기간을 지킨 재참여의 지각 주문도 과거 submitted 행 때문에 영구 차단하지 않음');

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
assert.ok(recruit.includes('sessionStorage.getItem("rapp_camp_edit_token")'),
  '리뷰어용 제한 편집 세션을 식별');
assert.ok(recruit.includes('row.hidden = hidden') && recruit.includes('row.style.display = hidden ? "none" : ""'),
  '제한 편집 화면에서는 저장되지 않는 재참여 설정을 숨김');
assert.ok(recruit.includes('if (_repurchaseEl && !_rfIsReviewerScopedEditor())'),
  '제한 편집 세션에서는 재참여 값을 payload에 싣지 않음');
assert.ok(recruit.includes('rfSetRepurchaseDays(14)'), '신규 공고 기본 14일 초기화');
assert.ok(home.includes('ids.forEach(id => { delete nextStatus[id]; });'),
  '0일 전환 시 응답 캐시에서 기존 잠금을 제거');
assert.ok(home.includes('else delete c.repurchase;'),
  '재렌더 때 캐시된 공고 객체의 기존 잠금도 제거');

console.log('PASS campaign-specific repurchase days persistence and enforcement wiring');
