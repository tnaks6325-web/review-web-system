/**
 * campaignAutoDismiss.test.js — 구매시간만료 자동 취소확정 회귀가드 (126)
 * 실행: node tests/campaignAutoDismiss.test.js
 *
 * 확정된 규칙(사용자 2026-08-19):
 *   ① 주문 흔적이 하나도 없는 만료 건만 시스템이 취소확정한다(기구매 = 사람이 [제출확정]).
 *   ② 시점은 만료 즉시(매분 스윕).
 * 이 파일은 그 규칙과, 자동화가 만드는 유일한 새 위험(만료 뒤 도착한 주문이 가려지는 것)을
 * 막는 되살리기 경로를 **스텁 pool 로 실제 실행**해 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const NUL = String.fromCharCode(0);

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

const idx = read('index.js');
const mig = read('migrations/126_campaign_app_auto_dismiss.sql');
const cron = read('src/jobs/cron.js');
// campaign.routes.js 는 의도된 NUL(복합키 구분자)이 있어 git 이 바이너리로 취급한다 → 읽을 때만 걷어낸다.
const routes = read('src/routes/campaign.routes.js').split(NUL).join('');
const front = read('../frontend/js/index-recruit.js');

/* ═══ 1. 마이그레이션 = 컬럼 추가만(가산적) ═══ */
ok('126: dismissed_by TEXT 컬럼 추가(IF NOT EXISTS)',
  /ADD COLUMN IF NOT EXISTS dismissed_by TEXT/.test(mig));
ok('126: 백필·CHECK·FK 없음(기존 행/동작 무영향)',
  !/UPDATE\s+campaign_applications/i.test(mig) && !/CHECK\s*\(/i.test(mig) && !/REFERENCES/i.test(mig));
ok('★ REQUIRED_SCHEMA 등록 — 컬럼 없으면 매분 스윕이 42703 으로 죽어 만료 마킹까지 멈춘다',
  /\['campaign_applications', 'dismissed_by'\]/.test(idx));

/* ═══ 2. 스윕 실행 — 스텁 pool 로 실제 호출 ═══ */
function runSweep(env, capture) {
  const saved = Object.assign({}, process.env);
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/services/campaignHold.service')];
  const { sweepExpiredHolds } = require('../src/services/campaignHold.service');
  const pool = {
    query: async (sql, params) => {
      capture.push({ sql: String(sql), params });
      if (/SELECT rc\.id, rc\.linked_sheet_id/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  };
  const p = sweepExpiredHolds(pool);
  process.env = saved;
  return p;
}

async function main() {
  const q = [];
  const r = await runSweep({}, q);
  const sqls = q.map(x => x.sql);
  const dismiss = sqls.find(s => /dismissed_by = 'auto'/.test(s) && /SET dismissed_at = NOW\(\)/.test(s));
  const revive = sqls.find(s => /SET dismissed_at = NULL, dismissed_by = NULL/.test(s));
  const iLate = sqls.findIndex(s => /SET late_order_id = o\.id/.test(s));

  ok('스윕이 자동 취소확정 UPDATE 를 실행한다', !!dismiss);
  ok('★ 대상은 만료 && 미확정 건만',
    /status = 'expired'/.test(dismiss) && /dismissed_at IS NULL/.test(dismiss));
  ok('★★ 기구매(late_order_id)·확정주문(order_submission_id)은 자동 대상에서 제외 — 결제한 리뷰어를 시스템이 미참여로 접지 않는다',
    /late_order_id IS NULL/.test(dismiss) && /order_submission_id IS NULL/.test(dismiss));
  ok('★★ 살아있는 주문이 있으면 제외(NOT EXISTS · deleted_at IS NULL) — 링크 백필 전이라도 fail-closed',
    /NOT EXISTS \(SELECT 1 FROM order_submissions o[\s\S]*?campaign_application_id = a\.id[\s\S]*?deleted_at IS NULL\)/.test(dismiss));
  ok('★ status 는 expired 그대로 — cancelled 로 바꾸면 late 백필(status=expired 조건)이 끊겨 되살리기가 무력화된다',
    !/status = 'cancelled'/.test(dismiss));
  ok('사이클 상한(LIMIT) + SKIP LOCKED — 백로그를 한 번에 몰아치지 않고 확정 tx와 교착 0',
    /LIMIT \$1/.test(dismiss) && /FOR UPDATE SKIP LOCKED/.test(dismiss));

  ok('★★ 되살리기: 자동 확정 뒤 주문이 붙으면 다시 목록으로 올린다', !!revive);
  ok('★★ 되살리는 대상은 시스템 확정분만 — 사람이 미참여로 판단한 건은 되돌리지 않는다',
    /dismissed_by = 'auto'/.test(revive) && !/'admin'/.test(revive));
  ok('되살리기 조건 = 주문 흔적 3종(late · 확정 · 살아있는 주문)',
    /late_order_id IS NOT NULL/.test(revive) && /order_submission_id IS NOT NULL/.test(revive)
      && /EXISTS \(SELECT 1 FROM order_submissions/.test(revive));
  ok('★ 순서 계약: late 백필 → 되살리기 → 자동 취소확정(같은 사이클에서 방금 붙은 링크까지 본다)',
    iLate > -1 && iLate < sqls.indexOf(revive) && sqls.indexOf(revive) < sqls.indexOf(dismiss));
  ok('반환값에 건수 노출(조용한 처리 금지)',
    typeof r.autoDismissed === 'number' && typeof r.revived === 'number');
  ok('cron 로그가 자동 처리 건수를 남긴다', /autoDismissed=/.test(cron) && /revived=/.test(cron));

  const q2 = [];
  const r2 = await runSweep({ CAMPAIGN_AUTO_DISMISS: '0' }, q2);
  ok('★ 킬스위치 CAMPAIGN_AUTO_DISMISS=0 = 종전 동작(자동 UPDATE 0건)',
    !q2.some(x => /dismissed_by = 'auto'/.test(x.sql)) && r2.autoDismissed === 0 && r2.revived === 0);
  ok('킬스위치여도 만료 마킹은 계속된다', q2.some(x => /SET status = 'expired'/.test(x.sql)));

  /* ═══ 3. 라우트 배선 ═══ */
  ok('관제 응답에 dismissed_by 동봉(화면이 자동/수동을 구분)',
    /owner_phone8, dismissed_at,\s*\n\s*dismissed_by/.test(routes));
  ok('수동 취소확정은 admin 으로 기록 — 자동 되살리기 대상에서 제외',
    /SET status = 'cancelled', dismissed_at = NOW\(\), dismissed_by = 'admin'/.test(routes));
  ok('수동 제출확정은 마커를 비운다(잔류 금지)', /dismissed_at = NULL, dismissed_by = NULL/.test(routes));

  /* ═══ 4. 화면 배선 ═══ */
  ok('자동 확정건은 "미참여(자동)"으로 구분 표기',
    /autoDismissed \? "🚫 미참여\(자동\)" : "🚫 취소확정"/.test(front));
  ok('★★ 자동 확정건에도 [제출확정]은 남는다 — 시스템 주문 링크 없는 실구매의 막다른 길 방지',
    /const canConfirm = [^\n]*\(!dismissed \|\| autoDismissed\)/.test(front));
  ok('자동 확정건에 [취소확정]은 안 띄운다(이미 확정 상태)',
    /const canDismiss = [^\n]*&& !dismissed;/.test(front)
      && /\$\{canDismiss \? `<button onclick="campDismiss/.test(front));
  ok('화면이 자동 처리 사실을 문장으로 고지한다', /미참여\(자동\)<\/b> = 구매시간이 만료됐고/.test(front));

  console.log('\n✅ campaignAutoDismiss: ' + passed + '건 통과');
}

main().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
