/**
 * 회귀가드: 접수 시 업체 소유 자동 지정 (2026-09-23 「고양이사료」 실사고).
 * 광고주·계약이 붙어 접수됐는데 advertiser_campaigns 가 없어 작업이 「미지정」으로 떨어졌다.
 * 고정: (1) 탭 단위 INSERT·덮지 않음·해제 미부활·종료 거래처 제외 (2) 결과 코드 (3) 절대 throw 없음
 *       (4) 접수 라우트 배선 (5) 소급 마이그레이션 규율.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { ensureTabOwnership } = require(path.join(root, 'src/services/advertiserProjection.service.js'));
const route = fs.readFileSync(path.join(root, 'src/routes/order.routes.js'), 'utf8');
const mig = fs.readFileSync(path.join(root, 'migrations/165_accept_advertiser_ownership_backfill.sql'), 'utf8');

let failed = 0;
const ok = (m, c) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
function stub(handlers) {
  const log = [];
  return { log, pool: { query: async (sql, p) => {
    const t = String(sql); log.push({ t, p });
    for (const [re, res] of handlers) if (re.test(t)) { if (res instanceof Error) throw res; return typeof res === 'function' ? res(p) : res; }
    return { rows: [] };
  } } };
}
const ARGS = { advertiserId: 'adv_1', sheetId: 'wt_x', tabGid: '123', by: '자동' };

(async () => {
  console.log('accept → advertiser ownership');
  { const s = stub([[/INSERT INTO advertiser_campaigns/, { rows: [{ id: 'u1' }] }]]);
    const r = await ensureTabOwnership(ARGS, s);
    ok('소유 없으면 지정(assigned)', r.status === 'assigned');
    const ins = s.log[0];
    ok('탭 단위 INSERT(gid 전달)', ins.p[2] === '123' && ins.p[1] === 'wt_x' && ins.p[0] === 'adv_1');
    ok('기존 소유(탭·시트 전체) 있으면 안 넣는 조건', /NOT EXISTS[\s\S]*tab_gid IS NULL OR tab_gid = \$3/.test(ins.t));
    ok('종료 거래처 제외 조건', /status,''\) <> 'ended'/.test(ins.t));
    ok('해제 행 미부활(DO NOTHING)', /DO NOTHING/.test(ins.t) && !/deleted_at = NULL/.test(ins.t)); }
  { const s = stub([[/INSERT/, { rows: [] }], [/FROM advertiser_campaigns ac/, { rows: [{ advertiserId: 'adv_2', name: '남의업체' }] }]]);
    const r = await ensureTabOwnership(ARGS, s);
    ok('남이 소유 중이면 덮지 않고 kept_existing', r.status === 'kept_existing' && r.owner === '남의업체'); }
  { const s = stub([[/INSERT/, { rows: [] }], [/FROM advertiser_campaigns ac/, { rows: [{ advertiserId: 'adv_1', name: 'x' }] }]]);
    ok('이미 같은 업체면 already', (await ensureTabOwnership(ARGS, s)).status === 'already'); }
  { const s = stub([[/INSERT/, { rows: [] }], [/FROM advertiser_campaigns ac/, { rows: [] }], [/SELECT status FROM advertisers/, { rows: [{ status: 'ended' }] }]]);
    ok('종료 거래처면 advertiser_ended', (await ensureTabOwnership(ARGS, s)).status === 'advertiser_ended'); }
  { const s = stub([[/INSERT/, { rows: [] }], [/FROM advertiser_campaigns ac/, { rows: [] }], [/SELECT status FROM advertisers/, { rows: [{ status: 'active' }] }]]);
    ok('사람이 해제한 행이면 kept_removed', (await ensureTabOwnership(ARGS, s)).status === 'kept_removed'); }
  { const s = stub([]);
    const r = await ensureTabOwnership({ ...ARGS, tabGid: '' }, s);
    ok('gid 없으면 쓰기 0(no_gid) — 시트 전체 소유 금지', r.status === 'no_gid' && s.log.length === 0); }
  { const s = stub([[/INSERT/, new Error('boom')]]);
    const r = await ensureTabOwnership(ARGS, s);
    ok('DB 오류도 throw 없이 failed', r.status === 'failed' && /boom/.test(r.error)); }

  const i8c = route.indexOf('8c) 업체 소유 자동 지정');
  ok('접수 라우트가 ensureTabOwnership 호출', /ensureTabOwnership\(\{[\s\S]{0,200}tabGid: gid/.test(route));
  ok('상태 전이 UPDATE 뒤에 둔다(upd 재료)', i8c > route.indexOf('RETURNING *`,\n      [id, nextStatus'));
  ok('응답에 ownershipAssigned 동봉', /\n\s+ownershipAssigned,/.test(route));

  ok('소급: 탭 gid 필수', /COALESCE\(w\.linked_tab_gid,''\) <> ''/.test(mig));
  ok('소급: 기존 소유 무접촉', /NOT EXISTS[\s\S]*tab_gid IS NULL OR ac\.tab_gid = w\.linked_tab_gid/.test(mig));
  ok('소급: 해제 행 미부활·멱등', /DO NOTHING;\s*$/.test(mig));
  ok('소급: 종료 거래처 제외', /<> 'ended'/.test(mig));

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
