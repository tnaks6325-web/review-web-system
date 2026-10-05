/**
 * 회귀가드: 업체관리 「인트라넷 연결 확인」 — 표기만 다른 인트라넷 광고주 연결 제안(suggest)의 화면 창구 (2026-10-01).
 *   서버: "다른 회사" 기억(dismissed) · 낡은 화면 방어(expect) · 지금 제안에 있는 조합만 받는다
 *   화면: 서버 분류 그대로 · 연결/거절 요청 모양 · AE 미표시 · onclick 인덱스만
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const svc = require('../src/services/advertiserIntranetSync.service');

let failed = 0;
function ok(msg, cond) { if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } }

const ADVS = [{ id: 'a1', name: '비슷무역', intranetId: '', businessNumber: '' }];
const INTRA = [{ intranetId: 'i1', name: '주식회사 비슷무역', bizNo: '111-22-33333' }];
function stub(dismissed) {
  const writes = [];
  const q = async (sql, p) => {
    const t = String(sql);
    if (/FROM advertisers WHERE COALESCE\(status/.test(t)) return { rows: ADVS };
    if (/SELECT value FROM app_settings/.test(t)) return { rows: dismissed == null ? [] : [{ value: JSON.stringify(dismissed) }] };
    writes.push({ t, p });
    return { rows: [], rowCount: /UPDATE advertisers/.test(t) ? 1 : 0 };
  };
  const pool = { query: q, connect: async () => ({ query: q, release() {} }) };
  return { deps: { pool, trackB: { intranetAdvertiserIndex: async () => ({ ok: true, rows: INTRA }) } }, writes };
}

(async () => {
  console.log('advertiserSyncSuggest');
  // 판정
  const p1 = svc.planIntranetSync(ADVS, INTRA);
  ok('법인 표기만 다른 인트라넷 광고주 하나 = suggest', p1.items[0].kind === 'suggest' && p1.items[0].intranetId === 'i1');
  const p2 = svc.planIntranetSync(ADVS, INTRA, { dismissed: new Set(['a1|i1']) });
  ok('"다른 회사"로 답한 조합은 dismissed(사람 확인 필요 건수에서 빠짐)', p2.items[0].kind === 'dismissed' && !p2.counts.suggest);
  ok('다른 인트라넷 광고주면 다시 묻는다(조합 단위로만 기억)',
    svc.planIntranetSync(ADVS, INTRA, { dismissed: new Set(['a1|i9']) }).items[0].kind === 'suggest');

  // ③ "다른 회사" 답은 모든 분류보다 먼저(Codex 리뷰)
  { const advs = [{ id: 'a1', name: '비슷무역', intranetId: '', businessNumber: '' }, { id: 'h', name: '주식회사 비슷무역', intranetId: 'i1', businessNumber: '' }];
    const p = svc.planIntranetSync(advs, INTRA, { dismissed: new Set(['a1|i1']) });
    ok('그 인트라넷 광고주가 나중에 다른 업체에 연결돼도 합치기 권유(duplicate)로 되살아나지 않는다',
      p.items.find(x => x.id === 'a1').kind === 'dismissed' && !p.items.some(x => x.kind === 'duplicate')); }
  { const p = svc.planIntranetSync([{ id: 'a1', name: '주식회사 비슷무역', intranetId: '', businessNumber: '' }], INTRA, { dismissed: new Set(['a1|i1']) });
    ok('이름이 정확히 같아져도 자동 연결(link)로 되살아나지 않는다', p.items[0].kind === 'dismissed'); }
  { const p = svc.planIntranetSync([{ id: 'x1', name: '옛표기', intranetId: 'i1', businessNumber: '' }, { id: 'h2', name: '주식회사 비슷무역', intranetId: '', businessNumber: '' }],
      INTRA, { dismissed: new Set(['h2|i1']) });
    ok('이름을 쥔 쪽을 "다른 회사"라 답했으면 합칠 짝이 아니라 name_taken', p.items.some(x => x.id === 'x1' && x.kind === 'name_taken') && !p.items.some(x => x.kind === 'rename_blocked')); }
  ok('미리보기가 [다른 회사] 창구 지원 여부를 알린다', (await svc.previewIntranetSync(stub([]).deps)).dismissSupported === true);
  // ① 동시 거절 직렬화 — 같은 트랜잭션에서 잠금 후 읽고 쓴다
  { const { deps, writes } = stub([]);
    await svc.dismissSuggest({ advertiserId: 'a1', intranetId: 'i1' }, deps);
    const iLock = writes.findIndex(x => /pg_advisory_xact_lock/.test(x.t)), iIns = writes.findIndex(x => /INSERT INTO app_settings/.test(x.t));
    ok('거절 기록은 트랜잭션 잠금 안에서 쓴다(동시 거절이 서로 지우지 않게)', writes[0] && /BEGIN/.test(writes[0].t) && iLock >= 0 && iLock < iIns && writes.some(x => /COMMIT/.test(x.t))); }

  // dismissSuggest
  { const { deps, writes } = stub([]);
    const r = await svc.dismissSuggest({ advertiserId: 'a1', intranetId: 'i1', by: 't' }, deps);
    const w = writes.find(x => /INSERT INTO app_settings/.test(x.t));
    ok('다른 회사 표시는 app_settings 한 키에만 쓴다', r.ok && w && w.p[0] === svc.DISMISS_KEY && !writes.some(x => /UPDATE advertisers|DELETE FROM/.test(x.t))
      && JSON.parse(w.p[1])[0].advertiserId === 'a1' && JSON.parse(w.p[1])[0].intranetId === 'i1'
      && !writes.some(x => /UPDATE advertisers/.test(x.t))); }
  { const { deps, writes } = stub([]);
    const r = await svc.dismissSuggest({ advertiserId: 'a1', intranetId: 'i9' }, deps);
    ok('지금 제안에 없는 조합은 거부(쓰기 0)', !r.ok && r.code === 409 && writes.length === 0); }
  { const { deps, writes } = stub([{ advertiserId: 'a1', intranetId: 'i1' }]);
    const r = await svc.dismissSuggest({ advertiserId: 'a1', intranetId: 'i1' }, deps);
    ok('이미 표시한 조합은 멱등(쓰기 0)', r.ok && r.already && writes.length === 0); }
  { const { deps, writes } = stub([]);
    const r = await svc.dismissSuggest({ advertiserId: '', intranetId: 'i1' }, deps);
    ok('값이 비면 거부', !r.ok && r.code === 400 && writes.length === 0); }

  // apply — 사람이 지목한 suggest 만, 화면에서 본 광고주와 같을 때만
  { const { deps, writes } = stub([]);
    const r = await svc.applyIntranetSync({ kinds: [], ids: ['a1'], expect: { a1: 'i1' } }, deps);
    ok('지목한 제안은 연결한다', r.done.length === 1 && writes.some(x => /UPDATE advertisers SET intranet_advertiser_id/.test(x.t))); }
  { const { deps, writes } = stub([]);
    const r = await svc.applyIntranetSync({ kinds: [], ids: ['a1'], expect: { a1: 'i-다름' } }, deps);
    ok('화면에서 본 인트라넷 광고주와 지금 판정이 다르면 연결하지 않는다', r.done.length === 0 && r.failed.length === 1 && !writes.length); }
  { const { deps, writes } = stub([{ advertiserId: 'a1', intranetId: 'i1' }]);
    const r = await svc.applyIntranetSync({ kinds: [], ids: ['a1'], expect: { a1: 'i1' } }, deps);
    ok('"다른 회사"로 표시된 조합은 지목해도 연결하지 않는다', r.done.length === 0 && !writes.length); }

  // 라우트
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
  ok('거절 창구는 관리자 전용', /router\.post\('\/advertisers\/intranet-sync\/dismiss', authMiddleware, adminOrMasterMiddleware/.test(routes));
  ok('연결 요청이 expect 를 서비스로 넘긴다', /applyIntranetSync\(\{ kinds: b\.kinds, ids: b\.ids, expect: b\.expect/.test(routes));

  // 화면
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
  const start = html.indexOf('/* ══ 같은 업체로 보이는 업체 알림 배너');
  const end = html.indexOf("document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&_ovmmPop)");
  const block = html.slice(start, end);
  const mk = (role) => {
    const els = { ovmmBox: { innerHTML: '' } }; const calls = [];
    const sb = { STATE: { role, advs: [{ id: 'a1', name: '비슷무역', works: 3 }] },
      esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      document: { getElementById: id => els[id] || null }, Date, toast: () => {}, confirm: () => true,
      renderOwnershipView: async () => {},
      api: async (u, o) => { calls.push({ u, b: o && o.body ? JSON.parse(o.body) : null });
        if (/dismiss/.test(u)) return { ok: true };
        if (o && o.method === 'POST') return { ok: true, done: [{ id: 'a1' }], failed: [] };
        return { ok: true, dismissSupported: sb.__cap !== false, items: [{ kind: 'suggest', id: 'a1', name: '비슷무역', intranetId: 'i1', intranetName: '주식회사 비슷무역', bizNo: '111-22-33333' }, { kind: 'link', id: 'x' }] }; } };
    vm.createContext(sb);
    vm.runInContext(block.replace(/^let _OVMM=/m, 'var _OVMM=') + '\nthis._S=()=>_OVMM;', sb);
    return { sb, els, calls };
  };
  { const { sb, els, calls } = mk('master');
    await sb._ovmmLoad(true);
    ok('서버 suggest 만 연결 확인 대상', sb._S().suggests.length === 1 && sb._S().pairs.length === 0);
    const h = els.ovmmBox.innerHTML;
    ok('합칠 쌍이 없어도 연결 확인 배너를 띄운다(초록 "없음"으로 덮지 않음)', /연결 확인이 필요한 업체가 1곳/.test(h) && !/ovm-mg-bn ok/.test(h));
    sb._ovmmSuggestToggle();
    const h2 = els.ovmmBox.innerHTML;
    ok('카드에 리뷰웹 업체와 인트라넷 광고주(사업자번호)를 나란히', /비슷무역/.test(h2) && /주식회사 비슷무역/.test(h2) && /111-22-33333/.test(h2));
    ok('onclick 에는 인덱스만', /_ovmmSuggestLink\(0\)/.test(h2) && /_ovmmSuggestDismiss\(0\)/.test(h2) && !/onclick="[^"]*비슷/.test(h2));
    await sb._ovmmSuggestLink(0);
    const c = calls.find(x => x.b && x.b.ids);
    ok('연결은 그 업체 하나만 · 화면에서 본 광고주를 expect 로', c && c.b.confirm === true && c.b.kinds.length === 0
      && c.b.ids[0] === 'a1' && c.b.expect.a1 === 'i1'); }
  { const { sb, calls } = mk('master');
    await sb._ovmmLoad(true); sb._ovmmSuggestToggle();
    await sb._ovmmSuggestDismiss(0);
    const c = calls.find(x => /dismiss/.test(x.u));
    ok('다른 회사는 거절 API 로 그 조합을 보내고 목록에서 뺀다', c && c.b.advertiserId === 'a1' && c.b.intranetId === 'i1' && sb._S().suggests.length === 0); }
  { const { sb, calls } = mk('master'); sb.confirm = () => false;
    await sb._ovmmLoad(true); await sb._ovmmSuggestLink(0); await sb._ovmmSuggestDismiss(0);
    ok('확인창에서 취소하면 아무 요청도 안 보낸다', !calls.some(x => x.b)); }
  { const { sb, els, calls } = mk('master'); sb.__cap = false;
    await sb._ovmmLoad(true); sb._ovmmSuggestToggle();
    await sb._ovmmSuggestDismiss(0);
    ok('서버가 [다른 회사]를 지원하지 않으면(구버전) 버튼을 그리지도 부르지도 않는다',
      !/_ovmmSuggestDismiss/.test(els.ovmmBox.innerHTML) && /_ovmmSuggestLink\(0\)/.test(els.ovmmBox.innerHTML) && !calls.some(x => /dismiss/.test(x.u))); }
  { const { sb, els, calls } = mk('staff');
    await sb._ovmmLoad(true);
    ok('AE 에게는 그리지도 부르지도 않는다', els.ovmmBox.innerHTML === '' && calls.length === 0); }

  console.log(failed ? `advertiserSyncSuggest: FAILED (${failed})` : 'advertiserSyncSuggest: passed');
  process.exit(failed ? 1 : 0);
})();
