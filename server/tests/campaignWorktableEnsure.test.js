/**
 * campaignWorktableEnsure.test.js — 공고 전용 작업보드 자동 확보 (탈 구글시트, 사용자 확정 2026-08-19)
 *
 * 고정하는 계약
 *   ① 이미 연결된 공고는 **손대지 않는다**(멱등 — 접수로 만든 작업표를 새 것으로 갈아치우지 않는다)
 *   ② 연결이 없으면 가상 작업표를 만들고 `tab_configs.sheetless=TRUE` 로 등록한 뒤 공고에 연결한다
 *   ③ 구글 API 호출 0 · `sheet_url` 은 빈 값(죽은 링크 금지)
 *   ④ 실패는 조용히 성공으로 꾸미지 않는다(ok:false + 사유)
 *   ⑤ 제출 경로가 작업보드 없을 때 이 함수를 부른다(= `no_worktable_mapping` 반복 오류 제거)
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }
const SRC = p => path.join(__dirname, '../src', p);
const read = p => fs.readFileSync(SRC(p), 'utf8');

/** 스텁 pool — 쿼리 텍스트로 분기하고 실행 로그를 남긴다. */
function stubPool(handlers) {
  const log = [];
  const run = async (text, params) => {
    log.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
    for (const [re, rows] of handlers) if (re.test(text)) return { rows: typeof rows === 'function' ? rows(params) : rows, rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return {
    log,
    query: run,
    connect: async () => ({ query: run, release() {} }),
  };
}

(async () => {
  console.log('\n[A] 이미 연결된 공고 — 새로 만들지 않는다');
  {
    const svc = require('../src/services/campaignWorktable.service');
    const pool = stubPool([
      [/FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/, [{
        id: 'c1', title: '작업A', linked_sheet_id: 'wt_abc', linked_tab_name: '작업A', linked_tab_gid: '77',
      }]],
    ]);
    svc.__setPoolForTest(pool);
    const out = await svc.ensureCampaignWorktable({ campaignId: 'c1' });
    ok('연결 그대로 반환하고 created=false', out.ok && out.created === false && out.sheetId === 'wt_abc');
    ok('★ tab_configs·recruit_campaigns 에 쓰기 0', !pool.log.some(q => /INSERT INTO tab_configs|UPDATE recruit_campaigns/.test(q.text)));
    svc.__setPoolForTest(null);
  }

  console.log('\n[B] 연결이 없는 공고 — 가상 작업표를 만들어 연결한다');
  {
    delete require.cache[require.resolve('../src/services/campaignWorktable.service')];
    const svc = require('../src/services/campaignWorktable.service');
    const pool = stubPool([
      [/FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/, [{
        id: 'c2', title: '모기위키 모기기피제', landing_url: 'https://www.coupang.com/vp/products/1',
        linked_sheet_id: '', linked_tab_name: '', linked_tab_gid: '',
      }]],
    ]);
    svc.__setPoolForTest(pool);
    // 표준 열 템플릿은 관리자 설정(app_settings)에서 온다 — 여기선 그 조회만 스텁한다.
    require('../src/services/worktable.service').getTemplate = async () => ({
      core: ['번호', '구매일자', '수취인', '연락처', '주소', '결제금액', '리뷰제출', '입금'],
      channels: { coupang: ['쿠팡ID'] }, workTypes: [],
    });
    const consolidation = require('../src/services/workboardConsolidation.service');
    const originalEnsureNew = consolidation.ensureNewWorkTarget;
    consolidation.ensureNewWorkTarget = async () => ({ ok: true, source: 'new_work', rolloutState: 'mapped', workboardId: 'wb-new' });
    const out = await svc.ensureCampaignWorktable({ campaignId: 'c2', by: 'test' });
    consolidation.ensureNewWorkTarget = originalEnsureNew;
    ok('created=true 로 새 작업보드를 돌려준다', out.ok === true && out.created === true);
    ok('★ 가상 시트ID(wt_ 접두) — 구글 시트가 아니다', /^wt_[0-9a-f]{20}$/.test(out.sheetId));
    const again = require('../src/services/sheetlessAccept.service').virtualSheetIdForOrder('campaign:c2');
    ok('★ 결정적 파생 — 다시 불러도 같은 시트ID(재시도해도 탭이 늘지 않는다)', out.sheetId === again);
    ok('★ 탭 이름 = 공고 제목', out.tabName === '모기위키 모기기피제');
    const tcq = pool.log.find(q => /INSERT INTO tab_configs/.test(q.text));
    /* ★ VALUES 와 ON CONFLICT **양쪽 다** TRUE 여야 한다 — 한쪽만 보면 신규 INSERT 가
       sheetless=FALSE 로 들어가는 회귀를 통과시킨다(그러면 장부 재생성이 `not_sheetless` 로
       거부되고 그 탭이 크론에서 구글시트로 취급된다). 변이시험이 실제로 뚫은 자리. */
    ok('tab_configs 에 sheetless=TRUE 로 등록한다(VALUES)',
      !!tcq && /VALUES \(\$1, \$2, \$3, '', \$4, \$4, TRUE,/.test(tcq.text));
    ok('★ 재실행(ON CONFLICT)에서도 sheetless=TRUE 로 못박는다',
      !!tcq && /ON CONFLICT[\s\S]*sheetless = TRUE/.test(tcq.text));
    ok("★ sheet_url 은 빈 값 — 가상 ID 를 구글 URL 로 조립하면 죽은 링크가 된다",
      !!tcq && !/docs\.google\.com/.test(tcq.text));
    ok('공고에 연결을 기록한다', pool.log.some(q => /UPDATE recruit_campaigns[\s\S]*linked_sheet_id = \$2/.test(q.text)));
    ok('★ 공고 행을 잠그고(FOR UPDATE) 커밋한다 — 동시 주문에 작업표가 두 개 생기지 않는다',
      pool.log.some(q => /FOR UPDATE/.test(q.text)) && pool.log.some(q => /^COMMIT$/.test(q.text)));
    svc.__setPoolForTest(null);
  }

  console.log('\n[C] 못 만들면 사실대로 말한다');
  {
    delete require.cache[require.resolve('../src/services/campaignWorktable.service')];
    const svc = require('../src/services/campaignWorktable.service');
    svc.__setPoolForTest(stubPool([]));   // 공고 행 없음
    const out = await svc.ensureCampaignWorktable({ campaignId: 'nope' });
    ok('★ 공고가 없으면 ok:false + 사유(조용한 성공 위장 금지)', out.ok === false && out.reason === 'campaign_not_found');
    ok('campaignId 없으면 bad_request', (await svc.ensureCampaignWorktable({})).reason === 'bad_request');
    svc.__setPoolForTest(null);
  }

  console.log('\n[D] 소스 계약');
  {
    const src = read('services/campaignWorktable.service.js');
    ok('★ 구글 시트/드라이브 호출 0', !/sheets\.service|getSpreadsheetMeta|writeSheet\(|drive\.service/.test(src));
    ok('★ 가상 ID 는 sheetlessAccept 단일 출처에서 받는다(접두 사본 금지)',
      /virtualSheetIdForOrder/.test(src) && !/'wt_'/.test(src) && !/newVirtualSheetId/.test(src));
    ok('★ 열 구성은 표준 열 템플릿(buildColumns) — 규칙 사본 금지', /buildColumns/.test(src));
    ok('★ 장부는 rebuildLedgers 재사용 · 등록(sheetless) 커밋 뒤에 부른다',
      src.lastIndexOf("query('COMMIT')") < src.indexOf('rebuildLedgers({')
      && src.indexOf('rebuildLedgers({') > 0);

    const sub = read('routes/submit.routes.js');
    ok('★ 제출 경로가 작업보드 없을 때 ensureCampaignWorktable 을 부른다',
      /if \(!wt && holdCtx && holdCtx\.campaignId\)[\s\S]{0,400}?ensureCampaignWorktable/.test(sub));
    ok('★ 확보 실패가 제출을 죽이지 않는다(fail-soft)',
      /ensureCampaignWorktable[\s\S]{0,400}?catch \(ensErr\)/.test(sub));

    const led = read('services/orderLedger.service.js');
    ok("★ 큐 복구 스캔에서 `campaign:*` 좌표를 제외한다 — 큐로는 영원히 복구되지 않아 스캔만 축낸다",
      /os\.sheet_id NOT LIKE 'campaign:%'/.test(led));

    const cards = fs.readFileSync(path.join(__dirname, '../../frontend/js/campaign-cards.js'), 'utf8');
    ok('★ 카드에 "시트 탭 미연결" 안내가 없다', !/시트 탭 미연결/.test(cards));
  }

  console.log(`\n✅ campaignWorktableEnsure: ${pass} cases passed`);
  process.exit(0);
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
