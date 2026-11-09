'use strict';
/**
 * 결정 356 — 차례 타이머 배선 가드(정적). 의미:
 *  ① 신청 행 status 를 바꾸는 모든 문장을 센다 — 새 자리가 생기면 이 표가 깨진다(당길지/말지 정하고 표를 고친다 · RED-06).
 *  ② 끝남 4곳(제출 확정·수동확정·외부확정·취소)은 pullChainEarlierSafe 를 부르고, 만료·Q&A·작업표 삭제·주문 취소·미참여 확정·블로그는 부르지 않는다.
 *  ③ 취소는 차례 줄 행이면 캠페인 행을 먼저 잠근다(apply·확정과 같은 순서 · RED-09).
 *  ④ /apply: sequential:true + 자격일 때만 · INSERT 칸 목록 불변 · 거절은 INSERT 앞 · cutoff 는 상태 엔진 값(st.cutoffAt) 하나.
 *  ⑤ 스키마: 217 은 칸 추가만(신청 행 UPDATE·트리거 없음) · 218 은 백업 → UPDATE → DEFAULT 순 · REQUIRED_SCHEMA 2칸.
 *  ⑥ 당기기만: 서비스에 expires_at 늘리기·NULL·status 쓰기 없음 · change-option 은 차례 칸을 쓰지 않는다.
 */
const fs = require('fs');
const path = require('path');
const R = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) passed++; else { failed++; console.log('❌ ' + name); } };

// ① status 를 바꾸는 문장 전수(파일별 개수 고정)
const RE = /UPDATE\s+campaign_applications(?:\s+(?!SET\b)\w+)?\s+SET\s+status\s*=\s*'(\w+)'/g;
const found = {};
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) {
      const s = fs.readFileSync(p, 'utf8'); let m; const list = [];
      while ((m = RE.exec(s))) list.push(m[1]);
      if (list.length) found[path.relative(path.join(__dirname, '..'), p).split(path.sep).join('/')] = list.join(',');
    }
  }
})(path.join(__dirname, '..', 'src'));
const EXPECTED = {
  // 끝남(당김) = cancel(취소)·cancelled+submitted(수동확정 선-취소+확정) · 나머지는 ALLOW(사유)
  'src/routes/campaign.routes.js': 'cancelled,expired,cancelled,submitted,applied,blog_rejected,cancelled',
  //  ↑ 취소(HOOK) · 신청 앞 만료(ALLOW: 예상 마감이 곧 다음 시작) · 수동확정 선-취소(HOOK) · 수동확정(HOOK) · 블로그 승인/반려(ALLOW: 차례 제외) · 미참여 확정(ALLOW: 이미 끝난 행)
  'src/services/campaignHold.service.js': 'submitted,expired',          // 제출 확정(HOOK) · 스윕 만료(ALLOW: I5)
  'src/services/manualOrder.service.js': 'submitted',                    // 외부/담당자 확정(HOOK)
  'src/services/orderCancellation.service.js': 'cancelled',              // 주문 취소(ALLOW: submitted 행 — applied 가 아니다)
  'src/services/qnaSlots.service.js': 'expired',                         // Q&A(ALLOW: 차례 제외)
  'src/services/trackB.service.js': 'cancelled',                         // 작업표 줄 삭제(ALLOW: 주문 붙은 행만 · 예상 마감대로)
};
ok('① 신청 행 status 변경 자리 = 고정 표(새 자리는 당길지 정하고 표를 고친다)', JSON.stringify(found) === JSON.stringify(EXPECTED));
if (JSON.stringify(found) !== JSON.stringify(EXPECTED)) console.log('   실제:', JSON.stringify(found, null, 1));

const routes = R('src/routes/campaign.routes.js');
const hold = R('src/services/campaignHold.service.js');
const mo = R('src/services/manualOrder.service.js');
const chain = R('src/services/campaignHoldChain.service.js');
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); return i >= 0 && j > i ? s.slice(i, j) : ''; };

// ② 끝남 4곳
const conf = between(hold, 'async function confirmHoldInTx(', 'async function logIdentityBlockedExpiries(');
ok('② 제출 확정: submitted UPDATE 뒤 · return \'confirmed\' 앞에서 당긴다',
  /SET status = 'submitted'[\s\S]*maybePersistClosed[\s\S]*pullChainEarlierSafe\(client, \{ campaignId, endedIds: \[appId\], cause: 'submit' \}\);\s*\n\s*\}\s*\n\s*return 'confirmed';/.test(conf));
const adm = between(routes, "router.post('/admin/:id/confirm'", '_handlers.adminConfirm');
ok('② 수동확정: 선-취소 RETURNING id + maybePersistClosed 뒤 · COMMIT 앞에서 당긴다',
  /AND status = 'applied' RETURNING id`/.test(adm) && /maybePersistClosed\(client, id\);[^\n]*\n[\s\S]{0,200}pullChainEarlierSafe\(client, \{[\s\S]{0,120}endedIds: \[appId, \.\.\.preCancel\.rows\.map\(r => r\.id\)\][\s\S]{0,200}\n\s*await client\.query\('COMMIT'\);/.test(adm));
const ext = between(mo, 'async function confirmExternalApplication(', '/* 외부모집 수동제출도');
ok('② 외부/담당자 확정: 살아 있던 홀드(applied)일 때만 당긴다', /if \(selectedApplication\.status === 'applied' && cRows\[0\]\.multi_account_mode === true\) \{\s*\n\s*await require\('\.\/campaignHoldChain\.service'\)\.pullChainEarlierSafe\(client, \{ campaignId, endedIds: \[appId\], cause: 'staff_confirm' \}\);/.test(ext));
const cancel = between(routes, "router.post('/:id/cancel'", "router.post('/:id/change-option'");
ok('③ 취소: 트랜잭션 · 차례 줄 행이면 캠페인 행 FOR UPDATE 가 status UPDATE 보다 먼저 · 당김은 COMMIT 앞',
  /await client\.query\('BEGIN'\);/.test(cancel)
  && cancel.indexOf("SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE") > 0
  && cancel.indexOf("SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE") < cancel.indexOf("SET status = 'cancelled'")
  && cancel.indexOf('pullChainEarlierSafe(') > cancel.indexOf("SET status = 'cancelled'")
  && cancel.indexOf('pullChainEarlierSafe(') < cancel.indexOf("await client.query('COMMIT');")
  && /client\.release\(\);/.test(cancel));
ok('② 만료·Q&A·작업표 삭제·주문 취소는 당기지 않는다',
  !/pullChainEarlier/.test(between(hold, 'async function sweepExpiredHoldsInTx(', 'module.exports'))
  && !/pullChainEarlier/.test(R('src/services/qnaSlots.service.js'))
  && !/pullChainEarlier/.test(R('src/services/trackB.service.js'))
  && !/pullChainEarlier/.test(R('src/services/orderCancellation.service.js')));
ok('② DB 트리거 없음(RED-25)', !/CREATE (OR REPLACE )?TRIGGER/i.test(R('migrations/217_campaign_hold_chain.sql')));

// ④ /apply
const apply = between(routes, 'async function _applyParticipation(', "router.post('/:id/apply'");
ok('④ 차례 줄은 sequential:true + Q&A·블로그 아님 + 공고 자격일 때만',
  /if \(req\.body\.sequential === true && !qnaApply && !blogApply && holdChain\.chainEligibleCampaign\(camp\)\)/.test(apply));
ok('④ cutoff·마감은 상태 엔진 값 하나(st.cutoffAt·st.closesAt) — close_buffer_min 사본 없음',
  /closesAt: st\.closesAt, cutoffAt: st\.cutoffAt/.test(apply) && !/close_buffer_min\s*\?\?/.test(chain));
ok('④ chain_after_close 거절은 INSERT 앞(자리 미점유)', apply.indexOf("reason: 'chain_after_close'") > 0
  && apply.indexOf("reason: 'chain_after_close'") < apply.indexOf('INSERT INTO campaign_applications'));
ok('④ INSERT 칸 목록 불변 · 차례 칸은 뒤이은 UPDATE 로',
  /\(campaign_id, applicant_name, applicant_phone, phone8, owner_phone8, status, expires_at, hold_token, option_key, review_fee_snapshot, blog_url, is_popular_snapshot\)/.test(apply)
  && /UPDATE campaign_applications SET turn_starts_at = \$2, chain_ttl_min = \$3 WHERE id = \$1/.test(apply));
ok('④ 본계정 TTL 폴백 = 단일 상수(20)', /Number\(camp\.hold_ttl_min\) \|\| holdChain\.MAIN_HOLD_TTL_DEFAULT_MIN/.test(apply)
  && !/hold_ttl_min\) \|\| 30/.test(routes) && /MAIN_HOLD_TTL_DEFAULT_MIN = 20;/.test(chain));
ok('④ 응답 expiresAt = 저장된 진짜 마감(ins.rows[0].expires_at)', /expiresAt: ins\.rows\[0\]\.expires_at, serverNow/.test(apply));
const wd = between(routes, "router.get('/:id/work-detail'", "router.post('/:id/cancel'");
ok('④ work-detail 유예 없음 판정 불변(결정 351)', /const validHold = app\.status === 'applied' && app\.expires_at && new Date\(app\.expires_at\) > now;/.test(wd));
ok('④ work-detail 차례 정보는 실패해도 생략(fail-open)', /ownerChainView\(pool,[\s\S]{0,120}\}\s*catch \(e\) \{ chain = undefined;/.test(wd));

// ⑤ 스키마
const m217 = R('migrations/217_campaign_hold_chain.sql'), m218 = R('migrations/218_main_hold_ttl_20min.sql');
const sqlOnly = s => s.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
ok('⑤ 217 = 칸 추가만(IF NOT EXISTS) · 신청 행을 바꾸지 않는다', /ADD COLUMN IF NOT EXISTS turn_starts_at TIMESTAMPTZ/.test(m217)
  && /ADD COLUMN IF NOT EXISTS chain_ttl_min INT/.test(m217) && !/UPDATE\s+campaign_applications/i.test(sqlOnly(m217)) && !/DEFAULT/i.test(sqlOnly(m217)));
{
  const s = sqlOnly(m218);
  const iB = s.indexOf('INSERT INTO campaign_hold_ttl_backup_218'), iU = s.indexOf('UPDATE recruit_campaigns'), iD = s.indexOf('SET DEFAULT 20');
  ok('⑤ 218 = 백업 → UPDATE → DEFAULT(ACCESS EXCLUSIVE 는 맨 끝 잠깐) · 신청 행 무접촉', iB >= 0 && iB < iU && iU < iD && !/campaign_applications/i.test(s));
}
const idx = R('index.js');
ok('⑤ REQUIRED_SCHEMA 에 217 두 칸', /\['campaign_applications', 'turn_starts_at'\]/.test(idx) && /\['campaign_applications', 'chain_ttl_min'\]/.test(idx));

// ⑥ 당기기만
ok('⑥ 서비스는 status 를 쓰지 않고 expires_at 을 늘리거나 비우지 않는다',
  !/SET\s+status\s*=/.test(chain) && !/expires_at\s*=\s*NULL/i.test(chain) && !/\+\s*interval|make_interval/i.test(chain)
  && /turn_starts_at >= \$2::timestamptz AND expires_at >= \$3::timestamptz/.test(chain) && /SAVEPOINT hold_chain/.test(chain) && /ROLLBACK TO SAVEPOINT hold_chain/.test(chain));
ok('⑥ change-option 은 차례 칸·마감을 쓰지 않는다', !/turn_starts_at|chain_ttl_min/.test(between(routes, "router.post('/:id/change-option'", 'function _publicTierView(')));
ok('⑥ 차례 칸 쓰기는 /apply 후속 UPDATE 와 서비스 두 곳뿐',
  (routes.match(/SET turn_starts_at/g) || []).length === 1 && !/SET turn_starts_at|chain_ttl_min =/.test(hold + mo));

console.log(`\n${failed ? '❌' : '✅'} campaignHoldChainSites: ${passed}개 통과${failed ? ` · ${failed}개 실패` : ''}`);
if (failed) process.exit(1);
