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
  var S = { api: null, name: '', items: [], sel: {}, start: {}, focus: null, onDone: null, timer: null, gen: 0, lastFetch: 0, busy: false };

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
      // 결정 377 — 모집인원 조절 창(z-index 10050) 위에서 열 때는 그보다 위에 둔다(같거나 낮으면 바탕 창이 클릭을 가로챈다)
      '#seOv.over{z-index:10100}#seMsg.over{z-index:10110}',
      '#seOv .se-start{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:.8rem}',
      '#seOv .se-start .lb{color:#5b6478}',
      '#seOv .se-b:disabled{opacity:.45;cursor:not-allowed}',
      '#seOv .se-why{color:#5b6478;font-size:.76rem;line-height:1.45}',
      '#seMsg{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9600;pointer-events:none;background:#1d2433;color:#fff;border-radius:14px;padding:16px 22px;display:grid;gap:6px;text-align:center;max-width:calc(100vw - 32px);box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:inherit}',
      '#seMsg b{font-size:1.05rem}#seMsg span{font-size:.82rem;opacity:.85}#seMsg .bad{color:#ffb4a8;opacity:1}',
      '@media (prefers-reduced-motion:no-preference){#seMsg{animation:sefade 3.2s ease-in forwards}@keyframes sefade{0%{opacity:0;transform:translate(-50%,-46%)}10%{opacity:1;transform:translate(-50%,-50%)}60%{opacity:1}100%{opacity:0}}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function visibleItems() {
    var sn = readSnooze(), now = Date.now();
    // 결정 377 — 조절 창의 [추가 모집 정하기]로 열었으면 그 공고 하나만 보인다
    if (S.focus) return S.items.filter(function (it) { return String(it.campaignId) === S.focus; });
    return S.items.filter(function (it) { return !(sn[it.campaignId] && sn[it.campaignId] > now); });
  }
  /* ★ 결정 377 — Q&A [추가 모집] 시작일(오늘부터/내일부터). 판정·날짜는 서버가 준 값 그대로(사본 0).
       서버가 선택지를 안 주면(구버전 서버·계산 실패) 이 줄은 없고 종전 버튼 하나(= 내일부터)로 그린다. */
  function fmtDays(days) { return (days || []).map(fmtMD).join('·'); }
  function startPick(it) {
    var o = it.start, v = S.start[it.campaignId];
    if (v === 'today' && !(o.today && o.today.ok)) v = '';
    return v || o['default'] || 'tomorrow';
  }
  function startHtml(it, i) {
    var o = it.start, pick = startPick(it), td = o.today || {}, tm = o.tomorrow || {};
    var cut = td.cutoffAt ? new Date(td.cutoffAt) : null;
    var cutTxt = cut ? (function (k) { return ('0' + k.getUTCHours()).slice(-2) + ':' + ('0' + k.getUTCMinutes()).slice(-2); })(new Date(cut.getTime() + 9 * 3600000)) : '';
    var cur = pick === 'today' ? td : tm;
    var why = (pick === 'today' ? '오늘 ' + esc(cutTxt) + '까지 신청을 받습니다 · ' : '')
      + (cur.days && cur.days.length ? esc(fmtDays(cur.days)) + '에 다시 엽니다' : '')
      + (cur.skipped && cur.skipped.length ? ' · 0명(휴무)으로 닫아 둔 ' + esc(fmtDays(cur.skipped)) + '은 건너뜁니다' : '');
    return '<div class="se-start"><span class="lb">시작일</span>'
      + '<button type="button" class="se-b" data-i="' + i + '" data-s="today" aria-pressed="' + (pick === 'today') + '"' + (td.ok ? '' : ' disabled title="' + esc(td.why || '') + '"') + '>오늘부터</button>'
      + '<button type="button" class="se-b" data-i="' + i + '" data-s="tomorrow" aria-pressed="' + (pick === 'tomorrow') + '">내일부터</button></div>'
      + '<div class="se-why">' + why + (td.ok ? '' : (td.why ? '<br>오늘부터: ' + esc(td.why) : '')) + '</div>';
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
    if (!list.length || (isDismissed() && !S.focus)) { if (ov) ov.remove(); if (S.focus) closeFocus(); return; }
    if (!ov) { ov = document.createElement('div'); ov.id = 'seOv'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'seTitle'); document.body.appendChild(ov); bind(ov); }
    if (S.focus) ov.classList.add('over'); else ov.classList.remove('over');
    var picked = 0;
    var rows = list.map(function (it, i) {
      var sel = S.sel[it.campaignId] || '';
      if (sel) picked++;
      // ★ 결정 229: 품절로 멈춘 상품은 표시 — 추가 모집 전에 작업 조건 카드에서 다시 열어야 그날 받을 수 있다
      var shorts = (it.shortages || []).map(function (x) { return '<span' + (x.paused ? ' title="품절로 멈춘 상품 — 추가 모집 전에 작업 조건 카드에서 다시 열어야 받을 수 있어요" style="background:#fde4e1;color:#b42318"' : '') + '>' + esc(x.optKey) + ' ' + (x.n | 0) + '건' + (x.paused ? ' · 품절 멈춤' : '') + '</span>'; }).join('');
      return '<div class="se-item' + (sel ? ' picked' : '') + '">' + thumbHtml(it) +
        '<div class="se-body"><div class="se-top"><b>' + esc(it.title) + '</b><span class="se-tag">' + (it.total | 0) + '건 모자람</span></div>' +
        '<div class="se-meta">' + (it.kind === 'qna' ? 'Q&amp;A · ' : '') + '정규 일정 ' + esc(fmtMD(it.end)) + ' 끝 · 상품별 모자란 건수</div>' +
        '<div class="se-short">' + shorts + '</div>' +
        (it.kind === 'qna' && it.start ? startHtml(it, i) : '') +
        '<div class="se-acts">' +
          // 💬 결정 321: Q&A 공고는 못 채운 자리를 같은 공개 여부·문구로 다음 영업일부터 같은 하루 건수로 다시 깐다
          '<button type="button" class="se-b" data-i="' + i + '" data-a="extra" aria-pressed="' + (sel === 'extra') + '">' + (it.kind === 'qna' ? (it.start ? '추가 모집 — 같은 하루 건수로' : '추가 모집 — 다음 영업일부터 같은 하루 건수로') : '추가 모집 — 다음 영업일부터 같은 순서로') + '</button>' +
          '<button type="button" class="se-b" data-i="' + i + '" data-a="finish" aria-pressed="' + (sel === 'finish') + '">그대로 끝내기 — 공고 마감</button>' +
          '<button type="button" class="se-b" data-i="' + i + '" data-a="snooze" aria-pressed="false">1시간 뒤 다시</button>' +
        '</div></div></div>';
    }).join('');
    var allQna = list.every(function (x) { return x.kind === 'qna'; });
    ov.innerHTML = '<div class="se-box"><div class="se-hd"><h2 id="seTitle">' + (allQna ? 'Q&amp;A 공고의 정규 일정이 끝났습니다' : list.some(function (x) { return x.kind === 'qna'; }) ? '정규 일정이 끝난 공고가 있습니다' : '순서대로 진행한 공고의 정규 일정이 끝났습니다') + '</h2>' +
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
      if (t.getAttribute('data-x')) { if (S.focus) { closeFocus(); return; } setDismissed(); ov.remove(); return; }
      if (t.getAttribute('data-apply')) { apply(); return; }
      var i = Number(t.getAttribute('data-i')), a = t.getAttribute('data-a');
      var it = (S.view || [])[i]; if (!it) return;
      var sv = t.getAttribute('data-s');
      if (sv) { if (!t.disabled) { S.start[it.campaignId] = sv; render(); } return; }
      if (a === 'snooze') { var sn = readSnooze(); sn[it.campaignId] = Date.now() + SNOOZE_MS; writeSnooze(sn); delete S.sel[it.campaignId]; render(); return; }
      S.sel[it.campaignId] = S.sel[it.campaignId] === a ? '' : a;
      render();
    });
  }

  function message(title, sub, bad) {
    var old = document.getElementById('seMsg'); if (old) old.remove();
    var m = document.createElement('div'); m.id = 'seMsg'; m.setAttribute('role', 'status');
    if (S.focus || S.onDone) m.className = 'over';
    m.innerHTML = '<b>' + esc(title) + '</b>' + (sub ? '<span class="' + (bad ? 'bad' : '') + '">' + esc(sub) + '</span>' : '');
    document.body.appendChild(m);
    setTimeout(function () { if (m.parentNode) m.remove(); }, 3400);
  }

  async function apply() {
    if (S.busy || !S.api) return;
    var decisions = (S.view || []).filter(function (it) { return S.sel[it.campaignId]; })
      .map(function (it) {
        var d = { campaignId: it.campaignId, action: S.sel[it.campaignId], end: it.end };
        // 결정 377 — 서버가 시작일 선택지를 준 Q&A 공고만 보낸다(안 주면 보내지 않음 = 서버 종전 = 내일부터)
        if (it.kind === 'qna' && it.start && d.action === 'extra') d.start = startPick(it);
        return d;
      });
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
      var done = S.onDone;
      message('반영했습니다 · ' + ok + '건', bad.length ? (bad.length + '건은 반영하지 못했습니다 — ' + (bad[0].error || '')) : '', bad.length > 0);
      res.forEach(function (r) { if (r.ok) delete S.sel[r.campaignId]; });
      if (ok && done) { S.focus = null; S.onDone = null; try { done(res); } catch (_) { /* 바탕 화면 다시 그리기 실패는 팝업과 무관 */ } }
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

  /* ★ 결정 377 — 모집인원 조절 창의 [추가 모집 정하기] 바로가기. 같은 팝업·같은 반영 길(새 경로 0)을 그 공고 하나만 보이게 연다.
       ✕ 닫기·1시간 뒤 다시로 숨겨 둔 것과 무관하게 연다(사람이 직접 눌렀다). 목록에 없으면(이미 처리됨·받는 사람 아님) false.
       @returns Promise<{ok:boolean, reason?:string}> */
  async function openFor(campaignId, opts) {
    if (!S.api) return { ok: false, reason: 'not_started' };
    S.focus = String(campaignId); S.onDone = (opts && typeof opts.onDone === 'function') ? opts.onDone : null;
    var sn = readSnooze(); if (sn[S.focus]) { delete sn[S.focus]; writeSnooze(sn); }
    var okLoad = await load(true);
    if (!okLoad) { closeFocus(); return { ok: false, reason: 'load_failed' }; }
    if (!S.items.some(function (it) { return String(it.campaignId) === String(campaignId); })) { closeFocus(); return { ok: false, reason: 'not_listed' }; }
    return { ok: true };
  }
  function closeFocus() {
    S.focus = null; S.onDone = null;
    var ov = document.getElementById('seOv'); if (ov) ov.remove();
    if (!isDismissed()) render();
  }

  function tick() {
    if (!S.api || S.busy || S.focus) return;
    if (Date.now() - S.lastFetch < REFRESH_MS) { render(); return; }
    load(true);
  }

  function start(opts) {
    if (!opts || typeof opts.api !== 'function') return;
    S.gen++; S.api = opts.api; S.name = String(opts.name || ''); S.sel = {}; S.start = {}; S.focus = null; S.onDone = null;
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
    S.items = []; S.sel = {}; S.start = {}; S.focus = null; S.onDone = null; S.api = null;
  }

  window.SequentialEndPrompt = { start: start, stop: stop, openFor: openFor, _state: S, _render: render };
  if (window.__SEQEND_PENDING) { var p = window.__SEQEND_PENDING; window.__SEQEND_PENDING = null; start(p); }
})();
