/**
 * 2026-10-30 — 구매캡처 저장이 끝나기 전에 참여 화면을 떠나 2장째가 사라지던 문제 · 사진 전송 실패를 "AI 분석 실패"로 안내하던 문제.
 *   A. api.js gasPostUpload — 서버에 닿지 못한 실패(시간 초과·중단·네트워크)에만 _transport 를 붙인다(vm 실행).
 *   B. 구매양식 — 첫 장 실패 문구 갈래 · 2장째 라벨 갈래 · 저장 중이면 uploadsPending + 끝나면 capture-uploads-done.
 *   C. 참여 화면 — 저장 중 떠나는 버튼 잠금(채팅 버튼 제외) · 150초 상한 · 신호 없는 옛 양식은 잠그지 않음 · 보낸 창 확인.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

(async () => {
  // ── A ──
  {
    const api = read('frontend/api.js');
    const s = api.indexOf('async function gasPostUpload(body, timeout) {');
    const e = api.indexOf('\n}\n', s) + 3;
    const mk = (mode) => {
      const ctx = {
        _ACTION_MAP: { extractOrderImage: { method: 'POST', path: '/x' } }, API_BASE_URL: 'http://t',
        _uploadProgress: { show() {}, update() {}, hide() {} }, _apiToast() {},
        _xhrPost: async () => { if (mode === 'ok') return { ok: false, error: '주문 정보를 인식하지 못했습니다.' }; throw new Error(mode); },
      };
      vm.createContext(ctx); vm.runInContext(api.slice(s, e) + '; this.f = gasPostUpload;', ctx); return ctx.f;
    };
    for (const m of ['timeout', 'aborted', '네트워크 오류 — 인터넷 연결을 확인하세요.', 'weird']) {
      const r = await mk(m)({ action: 'extractOrderImage' });
      assert.equal(r._transport, true, 'transport failure flagged: ' + m); assert.ok(r.error);
    }
    const srv = await mk('ok')({ action: 'extractOrderImage' });
    assert.ok(!srv._transport && /인식하지 못했습니다/.test(srv.error), 'server answered with an error → not a transport failure');
  }

  // ── B ──
  {
    const sa = read('frontend/js/search-app.js');
    assert.ok(/_renderIdentityMatchState\(cid, "ERROR", \[json && json\._transport\s*\? "사진을 서버로 보내지 못했어요\.[^"]*"\s*: "AI 분석을 완료하지 못했습니다\."\], !!st\.extractToken\);/.test(sa),
      'first photo: transport → send-failure wording · manual confirm still needs the server proof');
    assert.ok(/if \(json && json\._transport\) \{ say\("2장째 · 사진을 서버로 보내지 못했어요[^"]*"\); return; \}\s*\n\s*if \(!json \|\| !json\.ok\) \{ say\("2장째 첨부됨 · 내용은 읽지 못했지만/.test(sa), '2nd photo label distinguishes transport failure');
    assert.ok(/has2: !!\(o\.img2Src && o\.img2Src\.startsWith\("data:"\)\)/.test(sa), 'slot knows a 2nd photo is coming');
    assert.ok(/const _uploadsPending = _capList\.some\(x => x\.status === "uploading" \|\| x\.status2 === "uploading" \|\| \(x\.has2 && x\.status === "ok" && !x\.status2\)\);/.test(sa), 'pending covers the gap between 1st done and 2nd start');
    assert.ok(/_embedPost\(\{ type: "order-submitted", successCount, campaignHold: _derived, results, uploadsPending: _uploadsPending \}\);/.test(sa));
    assert.ok(/window\._capUploadChain\.then\(\(\) => \{[\s\S]{0,200}_embedPost\(\{ type: "capture-uploads-done", failed \}\);/.test(sa), 'done signal after the upload chain settles');

    // vm: 2장째가 있는 칸 — 첫 장 성공 직후(2장째 시작 전)도 저장 중으로 본다
    const pend = (list) => list.some(x => x.status === "uploading" || x.status2 === "uploading" || (x.has2 && x.status === "ok" && !x.status2));
    assert.equal(pend([{ status: 'ok', has2: true }]), true);
    assert.equal(pend([{ status: 'ok', has2: false }]), false);
    assert.equal(pend([{ status: 'fail', has2: true }]), false, '1st failed → 2nd never starts → not pending');
    assert.equal(pend([{ status: 'ok', has2: true, status2: 'ok' }]), false);
  }

  // ── C ── 참여 화면 _capSaveHold 를 가짜 DOM 으로 실행
  {
    const cp = read('frontend/campaign.html');
    assert.ok(/if\(d\.uploadsPending === true && ev\.source === \(\$\('orderFrame'\)\|\|\{\}\)\.contentWindow\) _capSaveHold\(true\);/.test(cp), 'hold only on the explicit signal from our form');
    assert.ok(/else if\(d\.type === 'capture-uploads-done'\)\{\s*if\(ev\.source === \(\$\('orderFrame'\)\|\|\{\}\)\.contentWindow\) _capSaveHold\(false, Number\(d\.failed\) \|\| 0\);/.test(cp));
    const s = cp.indexOf('let _capSaveTimer = null;');
    const e = cp.indexOf('\n}\n', cp.indexOf('function _capSaveHold(on, failed){', s)) + 3;
    const btn = (id) => ({ id, disabled: false, style: {} });
    const leave = btn(''), next = btn('doneNextBtn'), chat = btn('doneChatBtn');
    const els = {};
    const sec = { querySelectorAll: () => [leave, next, chat], parentNode: { insertBefore: (n) => { els[n.id] = n; } } };
    const listeners = {}; const timers = [];
    const ctx = {
      $: (id) => (id === 'vDone' ? { querySelector: () => sec } : els[id] || null),
      document: { createElement: () => ({ id: '', style: {}, innerHTML: '' }) },
      window: { addEventListener: (k, f) => { listeners[k] = f; }, removeEventListener: (k, f) => { if (listeners[k] === f) delete listeners[k]; } },
      setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: () => {},
    };
    vm.createContext(ctx); vm.runInContext(cp.slice(s, e) + '; this.hold = _capSaveHold;', ctx);
    ctx.hold(true);
    assert.ok(leave.disabled && next.disabled && !chat.disabled, 'leave buttons locked, chat stays usable');
    assert.ok(listeners.beforeunload, 'warns before closing the tab');
    assert.equal(timers[0].ms, 150000, 'never locks forever');
    assert.ok(/저장하고 있어요/.test(els.capSaveNote.innerHTML));
    ctx.hold(false, 0);
    assert.ok(!leave.disabled && !next.disabled && !listeners.beforeunload && /저장 완료/.test(els.capSaveNote.innerHTML), 'released on done');
    ctx.hold(true); ctx.hold(false, 1);
    assert.ok(!leave.disabled && /1건을 저장하지 못했어요/.test(els.capSaveNote.innerHTML), 'failure told to the reviewer');
    ctx.hold(true); timers[timers.length - 1].f();
    assert.ok(!leave.disabled && /늦어지고 있어요/.test(els.capSaveNote.innerHTML), 'timeout releases with guidance');
  }
  // ── D ── 칸이 비어 빈칸 목록이 뜨면 이유가 가려졌다(실측 2026-10-30) — 사진 전송 실패일 때만 이유를 목록 위에 붙인다.
  {
    const sa = read('frontend/js/search-app.js');
    assert.ok(/st\.lastBase64 = base64; st\.lastMime = mimeType;\s*\n\s*st\.captureTransportFail = false;/.test(sa), 'flag resets at every new analysis');
    assert.ok(/st\.captureTransportFail = !!\(json && json\._transport\);\s*\n\s*_renderIdentityMatchState\(cid, "ERROR", \[json && json\._transport/.test(sa), 'flag set right before the failure render');
    const s = sa.indexOf('function _renderIdentityMatchState(cid, status, reasons, canManual) {');
    const e = sa.indexOf('\n}\n', s) + 3;
    const run = (st, status, reasons, issues) => {
      const box = { style: {}, innerHTML: '' };
      const ctx = { _cardAiState: { c: st }, _identityIssues: () => issues, _safeText: (t) => String(t), _identityNeedsNewCapture: () => false,
        _identityAddressDifference: () => null, _syncSubmissionIdentityAction() {}, _activeIdentityContext: null,
        document: { getElementById: (id) => (id === 'c_identityStatus' ? box : null) } };
      vm.createContext(ctx); vm.runInContext(sa.slice(s, e) + '; this.f = _renderIdentityMatchState;', ctx);
      ctx.f('c', status, reasons, false); return box.innerHTML;
    };
    const blank = [{ field: 'recipient', label: '수취인', edit: true, reason: '입력해주세요.' }];
    const sendFail = '사진을 서버로 보내지 못했어요. 인터넷 연결을 확인하고 「캡처 다시 분석하기」를 눌러 주세요.';
    const h1 = run({ lastBase64: 'x', captureTransportFail: true }, 'ERROR', [sendFail], blank);
    assert.ok(h1.indexOf('사진을 서버로 보내지 못했어요') >= 0 && h1.indexOf('사진을 서버로') < h1.indexOf('수취인'), 'send failure shown above the blank-field list');
    assert.ok(/캡처 다시 분석하기<\/button>/.test(h1), 'retry button still there');
    const h2 = run({ lastBase64: 'x', captureTransportFail: false }, 'ERROR', ['AI 분석을 완료하지 못했습니다.'], blank);
    assert.ok(!/AI 분석을 완료하지/.test(h2) && /수취인/.test(h2), 'other errors keep the old screen (unchanged)');
    const h3 = run({ lastBase64: 'x', captureTransportFail: true }, 'ERROR', [sendFail], []);
    assert.equal((h3.match(/사진을 서버로 보내지 못했어요/g) || []).length, 1, 'no blank fields → shown once (old path)');
  }
  console.log('captureSaveHold: passed');
})().catch((err) => { console.error(err); process.exit(1); });
