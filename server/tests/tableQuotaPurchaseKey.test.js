/**
 * 결정 193 — 모기위키 499/500 사고 회귀가드.
 *  ① 총원 마감 재료(주문 원장)는 "구매 1건" 단위로 센다: 주문번호(6자리+)+연락처 끝8 / 약한 번호는 기록 id.
 *     취소된 기록이라도 살아 있는 작업표 줄이 가리키면 센다.
 *  ② 외부모집 수동제출은 같은 주문번호·연락처로 **앱(campaign: 좌표)** 에 이미 접수된 구매를 막는다.
 */
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ❌ ' + name, extra === undefined ? '' : extra); } };

const stateSrc = fs.readFileSync(path.join(__dirname, '../src/services/campaignState.service.js'), 'utf8');
const moSrc = fs.readFileSync(path.join(__dirname, '../src/services/manualOrder.service.js'), 'utf8');

(async () => {
  console.log('\n[1] 구매 키·포함 규칙(SQL 문장 고정 — 스텁은 SQL 을 해석하지 않는다)');
  const keySql = stateSrc.slice(stateSrc.indexOf('const ORDER_PURCHASE_KEY_SQL'), stateSrc.indexOf('async function _loadLinkedOrderCounts'));
  ok('주문번호 키는 연락처 끝8 까지 묶는다(다른 사람 같은 번호를 한 명으로 접지 않는다)',
    /dedup_key \|\| '\|' \|\| RIGHT\(regexp_replace\(COALESCE\(os\.phone, ''\), '\[\^0-9\]', '', 'g'\), 8\)/.test(keySql));
  ok('약한 번호는 기록 id 로 센다', /ELSE 'id:' \|\| os\.id::text/.test(keySql));
  ok('취소 기록은 살아 있는 줄이 가리킬 때만 포함', /os\.deleted_at IS NULL OR EXISTS/.test(keySql) && /cpx\.deleted_at IS NULL AND cpx\.active/.test(keySql));
  ok('★ 그 줄은 이 공고의 연결 작업표 줄이어야 한다(다른 표의 옛 링크 차단 · gid 폴백)',
    /cpx\.sheet_id = rc\.linked_sheet_id/.test(keySql) && /cpx\.tab_name = rc\.linked_tab_name/.test(keySql)
      && /NULLIF\(cpx\.tab_gid,''\) = NULLIF\(rc\.linked_tab_gid,''\)/.test(keySql));
  const body = stateSrc.slice(stateSrc.indexOf('async function _loadLinkedOrderCounts'), stateSrc.indexOf('function __resetTableQuotaCacheForTest'));
  const nKey = (body.match(/COUNT\(DISTINCT \$\{ORDER_PURCHASE_KEY_SQL\}\)/g) || []).length;
  ok('모든 구간(전체·어제까지·오늘·이월·보류)이 같은 키로 센다', nKey === 6 && !/COUNT\(DISTINCT os\.id\)/.test(body), nKey);

  console.log('\n[2] 외부모집 같은 주문번호 차단 — 실제 실행');
  const svc = require('../src/services/manualOrder.service');
  const poolMod = require('../src/db/pool');
  const realQuery = poolMod.query;
  let sameBuySql = null, sameBuyParams = null;
  const stub = (hit) => async (sql, params) => {
    const s = String(sql);
    if (/dedup_key = \$3/.test(s)) { sameBuySql = s; sameBuyParams = params; return { rows: hit ? [{ submitted_at: new Date(), via_app: true }] : [] }; }
    return { rows: [] };
  };
  const fields = { recipient: '고은지', phone: '010-3313-3999', address: 'a', bank: 'b', account: 'c', depositor: 'd', orderNum: '20102794569385' };
  const base = { sheetId: 'wt_x', tabName: '모기위키', gid: '773477918', fields, campaignId: null, adminName: 'A' };
  const run = async (args) => {
    try { return await svc.submitExternalOrder(args); } catch (e) { return { threw: true, msg: e.message }; }
  };

  poolMod.query = stub(true);
  const a = await run({ ...base });
  ok('앱으로 이미 접수된 같은 구매 → 막는다', a && a.ok === false && a.duplicate === true && a.sameOrderNum === true, a);
  ok('문구가 "앱으로 직접 참여"와 두 번 세어진다는 사실을 말한다', a && /앱으로 직접 참여/.test(a.error) && /두 명으로 세어/.test(a.error));
  ok('★★ 연결 공고(campaign:) 좌표까지 본다', sameBuySql && /'campaign:' \|\| rc\.id FROM recruit_campaigns rc/.test(sameBuySql) && /os\.deleted_at IS NULL/.test(sameBuySql));
  ok('키 = num:<숫자> + 연락처 끝8', sameBuyParams && sameBuyParams[2] === 'num:20102794569385' && sameBuyParams[3] === '33133999', sameBuyParams);
  ok('★ 탭 이름이 바뀐 공고도 gid 로 찾는다(빈 gid 는 절 미발동)', /NULLIF\(\$6, ''\) IS NOT NULL AND NULLIF\(rc\.linked_tab_gid, ''\) = \$6/.test(sameBuySql || ''));

  sameBuySql = null;
  poolMod.query = stub(true);
  const b = await run({ ...base, force: true });
  ok('확인 후 재시도(force)면 이 확인을 건너뛴다', sameBuySql === null && !(b && b.sameOrderNum));

  sameBuySql = null;
  poolMod.query = stub(true);
  const c = await run({ ...base, fields: { ...fields, orderNum: '123' } });
  ok('약한 주문번호(6자리 미만)는 확인하지 않는다(모르는 채 막지 않는다)', sameBuySql === null && !(c && c.sameOrderNum));

  poolMod.query = async (sql) => { if (/dedup_key = \$3/.test(String(sql))) throw new Error('boom'); return { rows: [] }; };
  const d = await run({ ...base });
  ok('조회 실패는 막지 않는다(fail-open — 원장 단계까지 진행)', !(d && d.sameOrderNum));

  poolMod.query = realQuery;
  ok('gid 가 6번째 인자로 간다', sameBuyParams && sameBuyParams[5] === '773477918', sameBuyParams);

  console.log('\n[3] 화면 — 중복으로 되돌아온 건만 확인 후 force 재전송(막다른 길 금지)');
  const fe = fs.readFileSync(path.join(__dirname, '../../frontend/js/manual-order.js'), 'utf8');
  ok('force 를 요청 본문에 싣는다', /force: force === true/.test(fe));
  ok('중복 건만 골라 다시 보낸다', /filter\(r => r && !r\.ok && r\.duplicate\)/.test(fe) && /post\(_overDailyOk, _repurchaseOk, idxs, true\)/.test(fe));
  ok('확인창을 거친다', /if \(okGo\) \{\s*const idxs = dups\.map/.test(fe));
  ok('다시 보낸 결과를 원래 자리로 되돌려 캡처 연결이 맞는 줄에 간다', /r2\.index = orig/.test(fe));
  ok('검사는 원장 기록보다 앞에 있다', moSrc.indexOf('⓪-0.5') > 0 && moSrc.indexOf('⓪-0.5') < moSrc.indexOf('createOrderLedgerEntry({'));

  console.log(`\n${fail ? '❌' : '✅'} tableQuotaPurchaseKey: ${pass}개 통과${fail ? `, ${fail}개 실패` : ''}`);
  process.exit(fail ? 1 : 0);
})();
