const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/reviewer.routes.js'), 'utf8');
const frontend = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const routeStart = routeSource.indexOf("router.get('/overdue-review-warning'");
const routeEnd = routeSource.indexOf("router.get('/review-earnings'", routeStart);
const routeBlock = routeSource.slice(routeStart, routeEnd);

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed++;
  console.log('  ✓ ' + name);
}

ok('로그인 세션 전용 API', routeStart >= 0 && /overdue-review-warning', reviewerSessionMiddleware/.test(routeBlock));
ok('구매양식 제출 후 10일 경과 기준', /os\.submitted_at <= NOW\(\) - INTERVAL '10 days'/.test(routeBlock));
ok('구매양식 제출시간이 가장 오래된 1건', /ORDER BY os\.submitted_at ASC, os\.id ASC[\s\S]*LIMIT 1/.test(routeBlock));
ok('작업표에 반영된 주문만 대상', /os\.mirror_status = 'written'/.test(routeBlock));
ok('소유자 범위의 어느 명의로든 제출완료면 제외', /WITH owner_rows AS/.test(routeBlock)
  && /BOOL_OR\(work_submitted\)/.test(routeBlock)
  && /NOT COALESCE\(cp\.owner_work_submitted, FALSE\)/.test(routeBlock)
  && /NOT COALESCE\(ri\.is_submitted, FALSE\)/.test(routeBlock));
ok('활성·보관 리뷰색인을 함께 완료 근거로 사용', /EXISTS \([\s\S]*FROM review_index dri/.test(routeBlock)
  && /EXISTS \([\s\S]*FROM review_index_archive dra/.test(routeBlock));
ok('같은 주문의 타소유자 행을 최신순으로 임의 선택하지 않음', /p\.owner_reviewer_id = \$1/.test(routeBlock)
  && /owner_identity\.owner_reviewer_id = \$1/.test(routeBlock)
  && /p\.phone8 = ANY\(\$2\)/.test(routeBlock));
ok('소유자 범위에 서로 다른 작업행이 여러 개면 팝업 미노출', /COUNT\(DISTINCT \(sheet_id, tab_name, seq\)\)/.test(routeBlock)
  && /COALESCE\(cp\.owner_link_count, 1\) = 1/.test(routeBlock));
ok('삭제된 참여건 제외', /workdesk_participant_deletions/.test(routeBlock) && /os\.deleted_at IS NULL/.test(routeBlock));
ok('주문 UUID 없는 레거시는 위치와 phone8이 모두 맞아야 함', /cp\.sheet_id IS NOT NULL[\s\S]*ri\.phone8 = RIGHT\(regexp_replace/.test(routeBlock));
ok('소유자가 기록된 주문은 전화번호 재사용으로 다른 계정에 귀속되지 않음',
  /os\.owner_reviewer_id = \$1[\s\S]*OR \(os\.owner_reviewer_id IS NULL[\s\S]*= ANY\(\$2\)/.test(routeBlock));
ok('레거시 행의 연락처가 비었으면 확정 참여링크로 보조 매칭',
  /ri\.phone8 IS NULL AND EXISTS[\s\S]*FROM participation_links pl[\s\S]*pl\.phone8 = RIGHT\(regexp_replace/.test(routeBlock));
ok('경고 API는 읽기 전용', !/\b(INSERT|UPDATE|DELETE)\b/.test(routeBlock.replace(/deleted_at/g, '')));

ok('팝업 문구와 작은 X 닫기 버튼', /id="overdueReviewWarning"/.test(frontend)
  && /리뷰를 제출해 주세요/.test(frontend)
  && /class="orw-x"/.test(frontend));
ok('24시간 숨김 기능 없음', !/24시간.{0,10}(보지|숨김)/.test(frontend));
ok('경고를 닫아도 캠페인 참여 가능 안내', /닫아도 다른 캠페인에 참여할 수 있어요/.test(frontend));
ok('버튼은 리뷰내역의 해당 작업을 연다', /function goToOverdueReview\(\)[\s\S]*switchTab\('review'\)[\s\S]*openPartInfoSheet\(\[item\]/.test(frontend));
ok('카드별 제출기한 카운트다운을 되살리지 않음', !/_reviewDeadlineState|status-badge-deadline|deadline-close-note/.test(frontend));

const pool = require('../src/db/pool');
const originalQuery = pool.query;
const router = require('../src/routes/reviewer.routes');

function handlerFor(routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods.get);
  assert.ok(layer, '라우트를 찾을 수 없음: ' + routePath);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(req) {
  const handler = handlerFor('/overdue-review-warning');
  return await new Promise(resolve => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode:this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res, err => resolve({ err }))).catch(err => resolve({ err }));
  });
}

(async () => {
  let mainParams = null;
  pool.query = async (sql, params) => {
    if (/FROM reviewers WHERE id/.test(sql)) {
      return { rows:[{ phone8:'11112222', sub_accounts:[{ phone:'010-3333-4444' }] }] };
    }
    if (/FROM order_submissions os/.test(sql)) {
      mainParams = params;
      return { rows:[{
        orderSubmissionId:'11111111-1111-1111-1111-111111111111',
        submittedAt:'2026-09-02T05:18:00.000Z', elapsedDays:12,
        targetSheetId:'sheet-a', targetTabName:'작업표A', targetRowIndex:7,
        campaignTitle:'9/10(쿠팡) 아누아 어성초 클렌징폼',
      }] };
    }
    if (/FROM reviewer_identities/.test(sql)) {
      return { rows:[{ current_phone8:'55556666' }] };
    }
    throw new Error('예상하지 못한 쿼리: ' + String(sql).slice(0, 80));
  };

  const result = await call({ reviewer:{ ownerReviewerId:'owner-1' } });
  assert.ifError(result.err);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.item.displayName, '9/10(쿠팡) 아누아 어성초 클렌징폼');
  assert.equal(result.body.item.elapsedDays, 12);
  assert.deepEqual(mainParams, ['owner-1', ['11112222', '33334444', '55556666'], false, null]);
  passed++;
  console.log('  ✓ 세션 소유자의 본계정·타계정 범위로 1건 반환');

  pool.query = async sql => {
    if (/FROM reviewers WHERE id/.test(sql)) return { rows:[] };
    throw new Error('소유자 없음 뒤에는 쿼리하면 안 됨');
  };
  const missing = await call({ reviewer:{ ownerReviewerId:'missing' } });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.body.code, 'REVIEWER_AUTH_INVALID');
  passed++;
  console.log('  ✓ 세션 소유자를 찾지 못하면 401');

  console.log(`✅ reviewerOverdueReviewWarning — ${passed}케이스 통과`);
})().catch(err => {
  console.error('❌ ' + err.stack);
  process.exitCode = 1;
}).finally(() => {
  pool.query = originalQuery;
});
