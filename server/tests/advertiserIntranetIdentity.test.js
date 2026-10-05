/**
 * 회귀가드: 업체 ↔ 인트라넷 광고주 동일성 (2026-09-28 올곧은무역·어니스트캄 — 같은 업체가 둘로 갈린 사고).
 *
 * 고정하는 것:
 *   A. 동일성 판정 단일 출처(utils/advertiserIdentity) — 법인 표기만 다르면 같은 업체로 **보인다**(후보)
 *   B. 접수: 원본 ID 가 없는 옛 업체가 표기만 다르면 **새로 만들지 않고 사람에게 묻는다**(자동 병합 금지 유지)
 *   C. 연결 점검(planIntranetSync) 분류 — 자동으로 고치는 것은 link·rename·bizno 뿐
 *   D. 업체 합치기가 업체 id 를 품은 **모든 표**를 다룬다(마이그레이션과 대조 — 표가 늘면 빨개진다)
 *   E. 등록 경로가 원본 ID 를 저장한다(근본 원인) · 옛 링크 별칭은 대상 링크 상태를 따른다
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
function ok(msg, cond) { if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } }

function stubPool(handlers) {
  const log = [];
  const client = {
    query: async (sql, params) => {
      const text = String(sql);
      log.push({ text, params });
      for (const [re, res] of handlers) if (re.test(text)) return typeof res === 'function' ? res(params) : res;
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { pool: { connect: async () => client }, log };
}
const ran = (log, re) => log.some(q => re.test(q.text));

(async () => {
  console.log('advertiserIntranetIdentity');

  // ── A. 판정 ──
  const { sameAdvertiser, advertiserNameKey, bizDigits } = require('../src/utils/advertiserIdentity');
  ok('법인 표기만 다른 이름은 같은 업체로 보인다(실사고 두 쌍)',
    sameAdvertiser({ name: '주식회사 올곧은무역' }, { name: '(주)올곧은무역' })
    && sameAdvertiser({ name: '어니스트캄' }, { name: '주식회사 어니스트캄' }));
  ok('글자가 다른 이름은 다른 업체다', !sameAdvertiser({ name: '올곧은무역' }, { name: '올바른무역' }));
  ok('사업자번호는 숫자만 비교한다', sameAdvertiser({ name: 'A사', businessNumber: '534-88-03338' }, { name: 'B사', businessNumber: '5348803338' }));
  ok('빈 이름·짧은 이름·자릿수 틀린 번호끼리는 같다고 하지 않는다',
    !sameAdvertiser({ name: '(주)' }, { name: '주식회사' }) && advertiserNameKey('㈜') === '' && bizDigits('123') === '');
  ok('이름 정규화는 계약 매칭과 같은 함수를 쓴다(사본 금지)',
    /require\('\.\/contractMatch'\)/.test(read('src/utils/advertiserIdentity.js'))
    && !/주식회사\|/.test(read('src/utils/advertiserIdentity.js')));

  // ── B. 접수 ──
  const { projectIntranetAdvertiser, ADVERTISER_NAME_CONFLICT } = require('../src/services/advertiserProjection.service');
  const ORDER = { id: 'wo_1', intranet_advertiser_id: 'iadv-olgot', intranet_advertiser_name: '(주)올곧은무역',
    intranet_advertiser_business_number: '534-88-03338' };
  {
    const { pool, log } = stubPool([
      [/WHERE intranet_advertiser_id = \$1/, { rows: [] }],
      [/FROM advertisers WHERE name = \$1 FOR UPDATE/, { rows: [] }],
      [/WHERE COALESCE\(intranet_advertiser_id,''\) = '' AND COALESCE\(status,''\) <> 'ended'/,
        { rows: [{ id: 'adv_old', name: '주식회사 올곧은무역', biz: '' }, { id: 'adv_x', name: '다른무역', biz: '' }] }],
      [/FROM advertisers a/, (p) => ({ rows: (p[0] || []).map(id => ({ id, name: id === 'adv_old' ? '주식회사 올곧은무역' : '?' })) })],
    ]);
    let err = null;
    try { await projectIntranetAdvertiser(ORDER, {}, { pool }); } catch (e) { err = e; }
    ok('표기만 다른 옛 업체가 있으면 새 업체를 만들지 않고 사람에게 묻는다(실사고 재현)',
      err && err.code === ADVERTISER_NAME_CONFLICT && err.detail.candidates.length === 1
      && err.detail.candidates[0].id === 'adv_old' && !ran(log, /INSERT INTO advertisers/));
  }
  {
    const { pool, log } = stubPool([
      [/WHERE intranet_advertiser_id = \$1/, { rows: [] }],
      [/FROM advertisers WHERE name = \$1 FOR UPDATE/, { rows: [] }],
      [/WHERE COALESCE\(intranet_advertiser_id,''\) = '' AND COALESCE\(status,''\) <> 'ended'/,
        { rows: [{ id: 'adv_old', name: '주식회사 올곧은무역', biz: '' }] }],
      [/FROM advertisers WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'adv_old', name: '주식회사 올곧은무역', cur: '', biz: '' }] }],
      [/UPDATE advertisers SET\s+intranet_advertiser_id/, { rows: [{ id: 'adv_old' }], rowCount: 1 }],
      [/INSERT INTO portal_works/, { rows: [{ id: 'pw_1' }] }],
    ]);
    const out = await projectIntranetAdvertiser(ORDER, { linkAdvertiserId: 'adv_old' }, { pool });
    const upd = log.find(q => /UPDATE advertisers SET\s+intranet_advertiser_id/.test(q.text));
    ok('사람이 "같은 업체"를 누르면 옛 업체에 원본 ID 를 채우고 이름도 원본 표기로 맞춘다(다른 업체가 쓰면 그대로)',
      out.advertiserId === 'adv_old' && upd && /name = CASE WHEN NOT EXISTS/.test(upd.text) && upd.params[4] === '(주)올곧은무역');
  }
  {
    const svc = read('src/services/advertiserProjection.service.js');
    ok('원본 ID 로 찾은 업체의 이름 갱신은 UNIQUE 충돌로 접수를 죽이지 않는다',
      /name = CASE WHEN NOT EXISTS \(SELECT 1 FROM advertisers o WHERE o\.name = \$2 AND o\.id <> \$1\)/.test(svc));
    ok('이미 다른 인트라넷 광고주에 연결된 업체는 표기가 비슷해도 후보가 아니다(확실히 다른 원본)',
      /WHERE COALESCE\(intranet_advertiser_id,''\) = '' AND COALESCE\(status,''\) <> 'ended'/.test(svc));
  }

  // ── C. 연결 점검 분류 ──
  const { planIntranetSync, AUTO_KINDS } = require('../src/services/advertiserIntranetSync.service');
  const intra = [
    { intranetId: 'i1', name: '(주)올곧은무역', bizNo: '534-88-03338' },
    { intranetId: 'i2', name: '정확회사', bizNo: '111-11-11111' },
    { intranetId: 'i3', name: '주식회사 비슷', bizNo: '' },
    { intranetId: 'i4', name: '새이름', bizNo: '222-22-22222' },
    { intranetId: 'i5', name: '동명', bizNo: '' }, { intranetId: 'i6', name: '동명', bizNo: '' },
  ];
  const advs = [
    { id: 'a_old', name: '주식회사 올곧은무역', intranetId: '', businessNumber: '' },
    { id: 'a_new', name: '(주)올곧은무역', intranetId: 'i1', businessNumber: '534-88-03338' },
    { id: 'a_exact', name: '정확회사', intranetId: '', businessNumber: '' },
    { id: 'a_sim', name: '비슷', intranetId: '', businessNumber: '' },
    { id: 'a_ren', name: '옛이름', intranetId: 'i4', businessNumber: '' },
    { id: 'a_amb', name: '동명', intranetId: '', businessNumber: '' },
    { id: 'a_none', name: '없는회사', intranetId: '', businessNumber: '' },
    { id: 'a_orph', name: '지워진원본', intranetId: 'i9', businessNumber: '' },
  ];
  const plan = planIntranetSync(advs, intra);
  const kindOf = (id, kind) => plan.items.some(it => it.id === id && it.kind === kind);
  ok('같은 인트라넷 광고주가 이미 다른 업체에 연결돼 있으면 "합치기 대상"으로 알린다(실사고)',
    plan.items.some(it => it.id === 'a_old' && it.kind === 'duplicate' && it.mergeWith.id === 'a_new'));
  ok('이름이 정확히 같은 광고주가 하나면 원본 ID 를 채운다', kindOf('a_exact', 'link'));
  ok('법인 표기만 다르면 자동으로 채우지 않고 사람 확인으로 둔다', kindOf('a_sim', 'suggest'));
  ok('인트라넷에서 이름이 바뀌면 따라간다 + 빈 사업자번호를 채운다', kindOf('a_ren', 'rename') && kindOf('a_ren', 'bizno'));
  ok('인트라넷에 같은 이름이 둘이면 정하지 않는다', kindOf('a_amb', 'ambiguous'));
  ok('인트라넷에 없거나 원본이 사라지면 알리기만 한다', kindOf('a_none', 'not_found') && kindOf('a_orph', 'orphan'));
  ok('자동으로 고치는 종류는 link·rename·bizno 셋뿐(합치기·추정 연결은 사람이)',
    JSON.stringify(AUTO_KINDS) === '["link","rename","bizno"]');
  const blocked = planIntranetSync(
    [{ id: 'x1', name: '옛표기', intranetId: 'j1', businessNumber: '' }, { id: 'x2', name: '새표기', intranetId: '', businessNumber: '' }],
    [{ intranetId: 'j1', name: '새표기', bizNo: '' }]);
  ok('새 이름을 다른 업체가 쓰고 있으면 이름을 바꾸지 않고 합치기 대상으로 알린다',
    blocked.items.some(it => it.kind === 'rename_blocked' && it.blockedBy.id === 'x2'));
  const taken = planIntranetSync(
    [{ id: 'y1', name: '옛표기', intranetId: 'k1', businessNumber: '' }, { id: 'y2', name: '새표기', intranetId: 'k2', businessNumber: '' }],
    [{ intranetId: 'k1', name: '새표기', bizNo: '' }, { intranetId: 'k2', name: '새표기', bizNo: '' }]);
  ok('새 이름을 쥔 업체가 다른 인트라넷 광고주에 연결돼 있으면 합치기 대상이 아니라 name_taken',
    taken.items.some(it => it.id === 'y1' && it.kind === 'name_taken') && !taken.items.some(it => it.kind === 'rename_blocked'));
  ok('rename_blocked 는 이름을 쥔 쪽의 연결 여부를 싣는다', blocked.items.find(it => it.kind === 'rename_blocked').blockedBy.intranetLinked === false);
  {
    const sync = read('src/services/advertiserIntranetSync.service.js');
    ok('인트라넷 도달 불가면 아무것도 쓰지 않는다(fail-closed)', /if \(!L\.ok\) return \{ ok: false, code: 503/.test(sync));
    ok('원본 ID 채우기는 비어 있을 때만 + 다른 업체가 그 ID 를 쓰면 안 한다',
      /WHERE id = \$1 AND COALESCE\(intranet_advertiser_id,''\) = ''\s+AND NOT EXISTS \(SELECT 1 FROM advertisers o WHERE o\.intranet_advertiser_id = \$2/.test(sync));
    const suggestGate = /const suggestPicked = it\.kind === 'suggest' && pick\.has\(it\.id\)/.test(sync);
    ok('추정 연결(suggest)은 사람이 id 로 지목한 것만', suggestGate);
  }

  // ── D. 합치기가 업체 id 를 품은 모든 표를 다룬다 ──
  {
    const { MERGE_TABLES } = require('../src/services/advertiserMerge.service');
    const migDir = path.join(root, 'migrations');
    const tables = new Set();
    for (const f of fs.readdirSync(migDir).filter(f => f.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
      const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
      let m;
      while ((m = re.exec(sql))) if (/^\s*advertiser_id\s/m.test(m[2])) tables.add(m[1]);
      const re2 = /ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS advertiser_id\b/g;
      while ((m = re2.exec(sql))) tables.add(m[1]);
    }
    const missing = [...tables].filter(t => !MERGE_TABLES.includes(t));
    ok('업체 id 칼럼을 가진 표는 전부 합치기 대상이다(누락: ' + (missing.join(',') || '없음') + ')', tables.size >= 8 && !missing.length);
    const svc = read('src/services/advertiserMerge.service.js');
    const touched = MERGE_TABLES.filter(t => !new RegExp('(UPDATE|DELETE FROM) ' + t + '\\b').test(svc));
    ok('목록의 표는 실제로 옮기거나 정리한다(목록만 있고 처리 없는 표 금지: ' + (touched.join(',') || '없음') + ')', !touched.length);
    ok('옛 업체를 지우기 전에 남은 정보가 없는지 확인한다(CASCADE 로 조용히 사라지지 않게)',
      svc.indexOf("throw new MergeError(`옛 업체에 옮기지 못한") < svc.indexOf('DELETE FROM advertisers WHERE id = $1'));
    ok('미리보기(confirm 없음)는 ROLLBACK 으로 끝난다(쓰기 0)', /if \(confirm !== true\) \{\s+await client\.query\('ROLLBACK'\)/.test(svc));
    const routes = read('src/routes/trackB.routes.js');
    ok('합치기·연결 점검 창구는 관리자 전용이다',
      /router\.post\('\/advertisers\/merge', authMiddleware, adminOrMasterMiddleware/.test(routes)
      && /router\.get\('\/advertisers\/intranet-sync', authMiddleware, adminOrMasterMiddleware/.test(routes)
      && /router\.post\('\/advertisers\/intranet-sync', authMiddleware, adminOrMasterMiddleware/.test(routes));
    ok('합치기는 confirm:true 일 때만 쓴다', /confirm: b\.confirm === true/.test(routes));
  }

  // ── E. 근본 원인 · 별칭 ──
  {
    const tb = read('src/services/trackB.service.js');
    ok('업체관리 등록이 인트라넷 원본 ID·사업자번호를 함께 저장한다',
      /intranet_advertiser_id, intranet_business_number\)\s+VALUES \(\$1,\$2,'active',\$3,'','',0,\$4,\$5\)/.test(tb));
    ok('등록 전에 같은 업체로 보이는 기존 업체를 찾아 막는다', /const same = await findSameAdvertiser\(db,/.test(tb));
    // 업무포털 거래처 추가 창구(portal.routes)는 결정 186 45번에서 제거 — 업체 등록 창구는 업체관리 한 곳.
    ok('업무포털 거래처 추가 창구가 되살아나지 않았다(규칙이 다른 두 번째 등록 창구 금지)',
      !fs.existsSync(path.join(__dirname, '..', 'src', 'routes', 'portal.routes.js')));
    ok('링크 회전은 병합으로 붙은 옛 주소도 지운다(업체·브랜드)',
      /DELETE FROM trackb_link_aliases WHERE kind = 'advertiser' AND target_id = \$1/.test(tb)
      && /DELETE FROM trackb_link_aliases WHERE kind = 'brand' AND target_id = \$1/.test(tb));
    const auth = read('src/services/auth.service.js');
    ok('옛 업체 링크는 대상 업체의 **현재 활성 링크**가 있을 때만 열린다',
      /JOIN trackb_advertiser_links l ON l\.advertiser_id = a\.id AND l\.active = TRUE/.test(auth));
    ok('옛 브랜드 링크는 대상 브랜드의 현재 링크 상태를 그대로 따른다',
      /const out = await loginByBrandToken\(rows\[0\]\.link_token, _pool\)/.test(auth));
    ok('별칭 표가 없거나 조회가 실패해도 로그인은 종전대로(fail-soft)', /\} catch \(_\) \{ return null; \}/.test(auth));
    const cron = read('src/jobs/cron.js');
    ok('인트라넷 이름 동기화는 주기적으로 돌고 끌 수 있다', /ADVERTISER_INTRANET_SYNC !== '0'/.test(cron)
      && /withJobLock\('advertiser_intranet_sync'/.test(cron));
  }

  const NUL = String.fromCharCode(0);
  ok('새 파일에 리터럴 NUL 이 없다', ['src/utils/advertiserIdentity.js', 'src/services/advertiserMerge.service.js',
    'src/services/advertiserIntranetSync.service.js'].every(p => !read(p).includes(NUL)));

  console.log(failed ? `advertiserIntranetIdentity: FAILED (${failed})` : 'advertiserIntranetIdentity: passed');
  process.exit(failed ? 1 : 0);
})();
