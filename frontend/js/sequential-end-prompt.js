/**
 * sequential-end-prompt.js — 순차진행 공고 「정규 일정 끝」 팝업 (결정 228 · 사용자 확정 2026-10-12)
 *
 * 순차진행 공고는 못 채운 건을 다음 날로 넘기지 않는다. 일정표가 끝난 다음 날, 공고 담당자와 그 작업오더를 보낸 AE 에게
 * 상품별로 모자란 건수를 보여 주고 공고마다 [추가 모집 / 그대로 끝내기 / 1시간 뒤 다시] 중 하나를 **고르기만** 한다.
 * 오른쪽 아래 [반영]을 누를 때만 한꺼번에 서버에 보낸다(모양·규율은 어제 부족 인원 팝업 shortage-prompt.js 와 같다).
 *
 * ★ 판정·계산은 전부 서버(/api/trackb/sequential-end-prompts) — 화면은 그리기와 고른 값 전달만(사본 0).
 * ★ "1시간 뒤 다시"는 이 브라우저에만 기억 · ✕ 닫기는 이번 로그인 동안만 숨김.
 * ★ 팝업·결과 안내는 body 직속 · onclick 문자열 보간 없음(이벤트 위임 + 인덱스).
 */
(function () {
  'use strict';
  var BASE = '/api/trackb/sequential-end-prompts';
  var SNOOZE_MS = 60 * 60 * 1000;
  var POLL_MS = 60 * 1000;
  var REFRESH_MS = 15 * 60 * 1000;
  var S = { api: null, name: '', items: [], sel: {}, timer: null, gen: 0, lastFetch: 0, busy: false };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function snoozeKey() { return 'wd_seqend_snooze_v1_' + S.name; }
  function dismissKey() { return 'wd_seqend_dismiss_v1_' + S.name; }
  function readSnooze() { try { return JSON.parse(localStorage.getItem(snoozeKey()) || '{}') || {}; } catch (_) { return {}; } }
  function writeSnooze(m) { try { localStorage.setItem(snoozeKey(), JSON.stringify(m)); } catch (_) { /* noop */ } }
  function isDismissed() { try { return sessionStorage.getItem(dismissKey()) === '1'; } catch (_) { return false; } }
  function setDismissed() { try { sessionStorage.setItem(dismissKey(), '1'); } catch (_) { /* noop */ } }
  function fmtMD(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); if (!m) return String(iso || '');
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return (+m[2]) + '/' + (+m[3]) + '(' + '일월화수목금토'[d.getUTCDay()] + ')';
  }

  function injectStyles() {
    if (document.getElementById('sePromptStyles')) return;
    var st = document.createElement('style');
    st.id = 'sePromptStyles';
    st.textContent = [
      '#seOv{position:fixed;inset:0;z-index:9500;background:rgba(20,26,40,.42);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}',
      '#seOv *{box-sizing:border-box}',
      '#seOv .se-box{width:min(640px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#fff;color:#1d2433;border-radius:14px;border:1px solid #dfe3ea;font-family:inherit}',
      '#seOv .se-hd{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:16px 18px 6px}',
      '#seOv .se-hd h2{font-size:1.05rem;margin:0}',
      '#seOv .se-x{border:0;background:none;color:#5b6478;font-size:1.1rem;cursor:pointer;padding:4px 8px}',
      '#seOv .se-lead{margin:0 18px 10px;color:#5b6478;font-size:.84rem}',
      '#seOv .se-list{overflow:auto;min-height:0;padding:0 18px 12px;display:grid;gap:10px}',
      '#seOv .se-item{border:1px solid #dfe3ea;border-radius:10px;padding:12px;display:grid;grid-template-columns:64px minmax(0,1fr);column-gap:12px;align-items:start}',
      '#seOv .se-item.picked{border-color:#2f5bd3}',
      '#seOv .se-th{position:relative;width:64px;height:64px;border-radius:9px;border:1px solid #dfe3ea;background:#e9ecf1;display:flex;align-items:center;justify-content:center;color:#5b6478;font-weight:700;font-size:.9rem;overflow:hidden}',
      '#seOv .se-th img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
      '#seOv .se-body{display:grid;gap:7px;min-width:0}',
      '#seOv .se-top{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '#seOv .se-top b{min-width:0;overflow-wrap:anywhere}',
      '#seOv .se-tag{font-size:.72rem;border-radius:6px;padding:2px 7px;background:#fdf1e2;color:#b5620b;font-weight:700;white-space:nowrap}',
      '#seOv .se-meta{color:#5b6478;font-size:.8rem;font-variant-numeric:tabular-nums}',
      '#seOv .se-short{display:flex;flex-wrap:wrap;gap:6px}',
      '#seOv .se-short span{font-size:.8rem;border-radius:6px;padding:2px 8px;background:#eef2fb;color:#2f5bd3;font-weight:700;font-variant-numeric:tabular-nums}',
      '#seOv .se-acts{display:flex;flex-wrap:wrap;gap:6px}',
      '#seOv .se-b{font:inherit;font-size:.8rem;border-radius:9px;border:1px solid #dfe3ea;background:#fff;color:#1d2433;padding:6px 10px;cursor:pointer}',
      '#seOv .se-b[aria-pressed="true"]{border-color:#2f5bd3;background:#2f5bd3;color:#fff}',
      '#seOv .se-b:focus-visible,#seOv .se-apply:focus-visible,#seOv .se-x:focus-visible{outline:2px solid #2f5bd3;outline-offset:2px}',
      '#seOv .se-ft{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 18px;border-top:1px solid #dfe3ea}',
      '#seOv .se-apply{font:inherit;font-weight:700;border:0;border-radius:9px;padding:10px 22px;background:#2f5bd3;color:#fff;cursor:pointer}',
      '#seOv .se-apply:disabled{opacity:.45;cursor:not-allowed}',
      '#seMsg{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9600;pointer-events:none;background:#1d2433;color:#fff;border-radius:14px;padding:16px 22px;display:grid;gap:6px;text-align:center;max-width:calc(100vw - 32px);box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:inherit}',
      '#seMsg b{font-size:1.05rem}#seMsg span{font-size:.82rem;opacity:.85}#seMsg .bad{color:#ffb4a8;opacity:1}',
      '@media (prefers-reduced-motion:no-preference){#seMsg{animation:sefade 3.2s ease-in forwards}@keyframes sefade{0%{opacity:0;transform:translate(-50%,-46%)}10%{opacity:1;transform:translate(-50%,-50%)}60%{opacity:1}100%{opacity:0}}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function visibleItems() {
    var sn = readSnooze(), now = Date.now();
    return S.items.filter(function (it) { return !(sn[it.campaignId] && sn[it.campaignId] > now); });
  }
  function thumbHtml(it) {
    var u = String(it.thumbnailUrl || '');
    var ini = esc(String(it.title || '?').replace(/^[^가-힣A-Za-z0-9]+/, '').slice(0, 2) || '상품');
    var img = /^https:\/\//i.test(u) ? '<img alt="" src="' + esc(u) + '" onerror="this.remove()">' : '';
    return '<div class="se-th">' + ini + img + '</div>';
  }

  function render() {
    var ov = document.getElementById('seOv');
    var list = visibleItems();
    if (!list.length || isDismissed()) { if (ov) ov.remove(); return; }
    if (!ov) { ov = document.createElement('div'); ov.id = 'seOv'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'seTitle'); document.body.appendChild(ov); bind(ov); }
    var picked = 0;
    var rows = list.map(function (it, i) {
      var sel = S.sel[it.campaignId] || '';
      if (sel) picked++;
      // ★ 결정 229: 품절로 멈춘 상품은 표시 — 추가 모집 전에 작업 조건 카드에서 다시 열어야 그날 받을 수 있다
      var shorts = (it.shortages || []).map(function (x) { return '<span' + (x.paused ? ' title="품절로 멈춘 상품 — 추가 모집 전에 작업 조건 카드에서 다시 열어야 받을 수 있어요" style="background:#fde4e1;color:#b42318"' : '') + '>' + esc(x.optKey) + ' ' + (x.n | 0) + '건' + (x.paused ? ' · 품절 멈춤' : '') + '</span>'; }).join('');
      return '<div class="se-item' + (sel ? ' picked' : '') + '">' + thumbHtml(it) +
        '<div class="se-body"><div class="se-top"><b>' + esc(it.title) + '</b><span class="se-tag">' + (it.total | 0) + '건 모자람</span></div>' +
        '<div class="se-meta">정규 일정 ' + esc(fmtMD(it.end)) + ' 끝 · 상품별 모자란 건수</div>' +
        '<div class="se-short">' + shorts + '</div>' +
        '<div class="se-acts">' +
          '<button type="button" class="se-b" data-i="' + i + '" data-a="extra" aria-pressed="' + (sel === 'extra') + '">추가 모집 — 다음 영업일부터 같은 순서로</button>' +
          '<button type="button" class="se-b" data-i="' + i + '" data-a="finish" aria-pressed="' + (sel === 'finish') + '">그대로 끝내기 — 공고 마감</button>' +
          '<button type="button" class="se-b" data-i="' + i + '" data-a="snooze" aria-pressed="false">1시간 뒤 다시</button>' +
        '</div></div></div>';
    }).join('');
    ov.innerHTML = '<div class="se-box"><div class="se-hd"><h2 id="seTitle">순서대로 진행한 공고의 정규 일정이 끝났습니다</h2>' +
      '<button type="button" class="se-x" data-x="1" aria-label="닫기">✕</button></div>' +
      '<p class="se-lead">못 채운 건은 다음 날로 넘기지 않았습니다. 공고마다 추가로 모집할지, 그대로 끝낼지 골라 주세요.</p>' +
      '<div class="se-list">' + rows + '</div>' +
      '<div class="se-ft"><span class="se-meta">' + picked + '개 골랐음 · 고르지 않은 공고는 다음 로그인 때 다시 묻습니다</span>' +
      '<button type="button" class="se-apply" data-apply="1"' + (picked && !S.busy ? '' : ' disabled') + '>반영</button></div></div>';
    S.view = list;
  }

  function bind(ov) {
    ov.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.getAttribute('data-x')) { setDismissed(); ov.remove(); return; }
      if (t.getAttribute('data-apply')) { apply(); return; }
      var i = Number(t.getAttribute('data-i')), a = t.getAttribute('data-a');
      var it = (S.view || [])[i]; if (!it) return;
      if (a === 'snooze') { var sn = readSnooze(); sn[it.campaignId] = Date.now() + SNOOZE_MS; writeSnooze(sn); delete S.sel[it.campaignId]; render(); return; }
      S.sel[it.campaignId] = S.sel[it.campaignId] === a ? '' : a;
      render();
    });
  }

  function message(title, sub, bad) {
    var old = document.getElementById('seMsg'); if (old) old.remove();
    var m = document.createElement('div'); m.id = 'seMsg'; m.setAttribute('role', 'status');
    m.innerHTML = '<b>' + esc(title) + '</b>' + (sub ? '<span class="' + (bad ? 'bad' : '') + '">' + esc(sub) + '</span>' : '');
    document.body.appendChild(m);
    setTimeout(function () { if (m.parentNode) m.remove(); }, 3400);
  }

  async function apply() {
    if (S.busy || !S.api) return;
    var decisions = (S.view || []).filter(function (it) { return S.sel[it.campaignId]; })
      .map(function (it) { return { campaignId: it.campaignId, action: S.sel[it.campaignId], end: it.end }; });
    if (!decisions.length) return;
    // ★ 레드팀 P1-2: [그대로 끝내기]는 공고를 마감한다 — 한 번 더 확인한다(다시 게시하면 이 질문이 다시 뜬다)
    var fin = decisions.filter(function (d) { return d.action === 'finish'; });
    if (fin.length && !window.confirm(fin.length + '개 공고를 마감합니다. 모자란 건은 더 모집하지 않습니다.\n계속할까요?')) return;
    S.busy = true; render();
    var gen = S.gen;
    try {
      // ★ Codex P2: 50개씩 나눠 보내고(서버 상한) · 서버가 통째로 실패하면 "반영했습니다"로 접지 않는다(고른 값 유지)
      var res = [];
      for (var bi = 0; bi < decisions.length; bi += 50) {
        var j = await S.api(BASE + '/apply', { method: 'POST', body: JSON.stringify({ decisions: decisions.slice(bi, bi + 50) }) });
        if (gen !== S.gen) return;
        if (!j || !j.ok) throw new Error((j && j.error) || '서버가 반영하지 못했습니다');
        res = res.concat(j.results || []);
      }
      var ok = res.filter(function (r) { return r.ok; }).length, bad = res.filter(function (r) { return !r.ok; });
      message('반영했습니다 · ' + ok + '건', bad.length ? (bad.length + '건은 반영하지 못했습니다 — ' + (bad[0].error || '')) : '', bad.length > 0);
      res.forEach(function (r) { if (r.ok) delete S.sel[r.campaignId]; });
    } catch (e) {
      message('반영하지 못했습니다', (e && e.message) || '', true);
    } finally {
      S.busy = false;
      await load(true);
    }
  }

  async function load(force) {
    if (!S.api) return false;
    var gen = S.gen;
    try {
      var j = await S.api(BASE);
      if (gen !== S.gen) return false;
      S.lastFetch = Date.now();
      if (!j || !j.ok) return false;
      S.items = j.items || [];
      render();
      return true;
    } catch (_) { return false; }
  }

  function tick() {
    if (!S.api || S.busy) return;
    if (Date.now() - S.lastFetch < REFRESH_MS) { render(); return; }
    load(true);
  }

  function start(opts) {
    if (!opts || typeof opts.api !== 'function') return;
    S.gen++; S.api = opts.api; S.name = String(opts.name || ''); S.sel = {};
    injectStyles();
    load(true);
    if (S.timer) clearInterval(S.timer);
    S.timer = setInterval(tick, POLL_MS);
  }
  function stop() {
    S.gen++;
    if (S.timer) clearInterval(S.timer); S.timer = null;
    try { Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('wd_seqend_dismiss_v1_') === 0) sessionStorage.removeItem(k); }); } catch (_) { /* noop */ }
    var msg = document.getElementById('seMsg'); if (msg) msg.remove();
    var ov = document.getElementById('seOv'); if (ov) ov.remove();
    S.items = []; S.sel = {}; S.api = null;
  }

  window.SequentialEndPrompt = { start: start, stop: stop, _state: S, _render: render };
  if (window.__SEQEND_PENDING) { var p = window.__SEQEND_PENDING; window.__SEQEND_PENDING = null; start(p); }
})();
