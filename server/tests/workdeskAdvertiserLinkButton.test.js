'use strict';
/**
 * workdeskAdvertiserLinkButton.test.js — 작업보드 [🏢 광고주링크] (사용자 요청 2026-10-09)
 * 이 작업의 소유 업체(광고주) 접속 링크를 즉시 복사한다. 링크는 업체관리의 「광고주 접속 링크」와 같은 것.
 * 실행: node tests/workdeskAdvertiserLinkButton.test.js
 */
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '../../frontend/workdesk.html'), 'utf8');
function fn(name) {
  const re = new RegExp('(?:async )?function ' + name + '\\(');
  const m = re.exec(html); assert(m, name);
  let i = html.indexOf('{', m.index), d = 0;
  for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}' && --d === 0) break; }
  return html.slice(m.index, i + 1);
}
let passed = 0;
async function ok(name, f) { await f(); passed++; console.log('  ✓ ' + name); }
function harness(cur, apiResult, copyOk = true) {
  const log = { alerts: [], ok: [], popup: [], calls: [], copied: [] };
  const ctx = {
    STATE: { cur }, location: { origin: 'https://review-web-system.pages.dev' },
    toast: m => log.alerts.push('toast:' + m), alert: m => log.alerts.push(m),
    api: async (url, o) => { log.calls.push([url, JSON.parse(o.body)]); if (apiResult instanceof Error) throw apiResult; return apiResult; },
    _copyText: async t => { log.copied.push(t); return copyOk; },
    _shareLinkOk: m => log.ok.push(m), _shareLinkPopup: (...a) => log.popup.push(a),
  };
  vm.createContext(ctx);
  vm.runInContext(fn('_advLinkUrl') + '\n' + fn('copyAdvertiserLink'), ctx);
  return { ctx, log };
}
(async () => {
  await ok('업체가 지정된 작업 → 그 업체 링크를 ensure(회전 아님)로 받아 즉시 복사', async () => {
    const { ctx, log } = harness({ sheetId: 'S', tabName: 'T', advertiserId: 'adv1', advertiserName: '친구사이' }, { ok: true, link: { token: 'tok123', active: true } });
    await ctx.copyAdvertiserLink();
    assert.deepEqual(log.calls[0], ['/api/trackb/advertiser-link', { action: 'ensure', advertiserId: 'adv1' }]);
    assert.equal(log.copied[0], 'https://review-web-system.pages.dev/workdesk#a=tok123');
    assert(/친구사이/.test(log.ok[0])); assert.equal(log.alerts.length, 0);
  });
  await ok('업체 미지정 작업 → 서버 호출 없이 "업체를 먼저 지정" 안내(막다른 길 대신 갈 곳)', async () => {
    const { ctx, log } = harness({ sheetId: 'S', tabName: 'T' }, null);
    await ctx.copyAdvertiserLink();
    assert.equal(log.calls.length, 0); assert(/업체관리/.test(log.alerts[0])); assert.equal(log.copied.length, 0);
  });
  await ok('폐기된 링크는 복사하지 않는다(fail-closed) · [다시 활성] 위치 안내', async () => {
    const { ctx, log } = harness({ advertiserId: 'adv1', advertiserName: '친구사이' }, { ok: true, link: { token: 'tok123', active: false } });
    await ctx.copyAdvertiserLink();
    assert.equal(log.copied.length, 0); assert(/폐기/.test(log.alerts[0]) && /다시 활성/.test(log.alerts[0]));
  });
  await ok('서버 오류·응답 없음 → 복사하지 않고 실패를 말한다', async () => {
    for (const res of [new Error('net'), { ok: false, error: '권한 없음' }, { ok: true, link: null }]) {
      const { ctx, log } = harness({ advertiserId: 'adv1' }, res);
      await ctx.copyAdvertiserLink();
      assert.equal(log.copied.length, 0); assert(/불러오지 못했습니다/.test(log.alerts[0]));
    }
  });
  await ok('자동 복사가 막히면 주소 창을 띄우고 노출 범위를 경고한다(조용한 실패 금지)', async () => {
    const { ctx, log } = harness({ advertiserId: 'adv1', advertiserName: 'A' }, { ok: true, link: { token: 't', active: true } }, false);
    await ctx.copyAdvertiserLink();
    assert.equal(log.popup.length, 1); assert(/리뷰어 연락처·주소/.test(log.popup[0][3]));
  });
  await ok('버튼: 내부 역할만 · [링크 복사] 바로 옆 · 마감 작업은 숨김(링크 복사와 같은 규칙)', async () => {
    assert(/const advLinkBtn=_isInternalRole\(\)\?/.test(html));
    assert(/\$\{wd\.archived\?'':shareBtn\}\s*\$\{wd\.archived\?'':advLinkBtn\}/.test(html));
  });
  console.log(`\n✅ workdeskAdvertiserLinkButton: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
