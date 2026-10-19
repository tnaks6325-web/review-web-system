/**
 * option-alert-prompt.js — 상품 품절 알림 팝업 (결정 229 · 사용자 확정 2026-10-12)
 *
 * 리뷰어가 "품절이라 구매하지 못했어요"로 취소하면 관리자 전원(마스터·관리자·AE)에게 띄운다.
 *   - 신고 1명     → [품절로 멈추기] / [품절 아님] / [1시간 뒤]
 *   - 신고 2명     → 서버가 이미 그 상품을 멈췄다 → [다시 열기] / [멈춘 채로 두기] / [1시간 뒤]
 *   - 상품을 나누지 않은 공고 → ★ 결정 259: **공고 전체**를 같은 버튼으로 멈춘다(서버가 wholeCampaign=true 를 싣는다).
 *     그사이 상품이 생긴 공고(wholeCampaign=false)만 종전 [확인했어요] / [1시간 뒤]
 * 한 사람이 처리하면 모두에게서 사라진다(서버가 알림을 닫고 실시간 통로로 다시 읽게 한다).
 * 사용자 확정 (가): 화면 팝업 + 컴퓨터 알림(브라우저 알림 — 처음 한 번 허용 필요, 이 창이 열려 있을 때만).
 *
 * ★ 판정·쓰기는 전부 서버(/api/trackb/option-alerts) — 화면은 그리기와 누른 것 전달만(사본 0).
 * ★ 실시간 통로가 끊겨도 1분마다 다시 읽는다(나중에 접속한 사람에게도 처리될 때까지 뜬다).
 * ★ ✕ 닫기 = 이 로그인 동안 지금 보이는 알림만 숨김 — 새 알림이 오면 다시 뜬다. "1시간 뒤" = 이 브라우저에만 기억.
 * ★ 팝업은 body 직속 · onclick 문자열 보간 없음(이벤트 위임 + 인덱스).
 */
(function () {
  'use strict';
  var BASE = '/api/trackb/option-alerts';
  var SNOOZE_MS = 60 * 60 * 1000;
  var POLL_MS = 60 * 1000;
  var S = { api: null, name: '', items: [], view: [], timer: null, gen: 0, busy: false, debounce: null };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sig(it) { return it.id + ':' + it.kind + ':' + (it.reportCount | 0); }   // 같은 알림이 올라가면(신고 → 자동 멈춤) 다시 띄운다
  function snoozeKey() { return 'wd_optalert_snooze_v1_' + S.name; }
  function dismissKey() { return 'wd_optalert_dismiss_v1_' + S.name; }
  function notifiedKey() { return 'wd_optalert_notified_v1'; }
  function readJson(store, k) { try { return JSON.parse(store.getItem(k) || '{}') || {}; } catch (_) { return {}; } }
  function writeJson(store, k, v) { try { store.setItem(k, JSON.stringify(v)); } catch (_) { /* noop */ } }
  function fmtTime(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function injectStyles() {
    if (document.getElementById('oaPromptStyles')) return;
    var st = document.createElement('style');
    st.id = 'oaPromptStyles';
    st.textContent = [
      '#oaOv{position:fixed;inset:0;z-index:9550;background:rgba(20,26,40,.42);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}',
      '#oaOv *{box-sizing:border-box}',
      '#oaOv .oa-box{width:min(600px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#fff;color:#1d2433;border-radius:14px;border:1px solid #dfe3ea;font-family:inherit}',
      '#oaOv .oa-hd{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:16px 18px 6px}',
      '#oaOv .oa-hd h2{font-size:1.05rem;margin:0}',
      '#oaOv .oa-x{border:0;background:none;color:#5b6478;font-size:1.1rem;cursor:pointer;padding:4px 8px}',
      '#oaOv .oa-lead{margin:0 18px 10px;color:#5b6478;font-size:.84rem}',
      '#oaOv .oa-list{overflow:auto;min-height:0;padding:0 18px 12px;display:grid;gap:10px}',
      '#oaOv .oa-item{border:1px solid #dfe3ea;border-radius:10px;padding:12px;display:grid;grid-template-columns:56px minmax(0,1fr);column-gap:12px;align-items:start}',
      '#oaOv .oa-item.auto{border-color:#e8a29a;background:#fff8f7}',
      '#oaOv .oa-th{position:relative;width:56px;height:56px;border-radius:9px;border:1px solid #dfe3ea;background:#e9ecf1;display:flex;align-items:center;justify-content:center;color:#5b6478;font-weight:700;font-size:.85rem;overflow:hidden}',
      '#oaOv .oa-th img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
      '#oaOv .oa-body{display:grid;gap:6px;min-width:0}',
      '#oaOv .oa-top{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '#oaOv .oa-top b{min-width:0;overflow-wrap:anywhere}',
      '#oaOv .oa-tag{font-size:.72rem;border-radius:6px;padding:2px 7px;font-weight:700;white-space:nowrap;background:#fdf1e2;color:#b5620b}',
      '#oaOv .oa-tag.auto{background:#fde4e1;color:#b42318}',
      '#oaOv .oa-opt{font-size:.86rem;font-weight:700;overflow-wrap:anywhere}',
      '#oaOv .oa-meta{color:#5b6478;font-size:.8rem}',
      '#oaOv .oa-acts{display:flex;flex-wrap:wrap;gap:6px}',
      '#oaOv .oa-b{font:inherit;font-size:.8rem;border-radius:9px;border:1px solid #dfe3ea;background:#fff;color:#1d2433;padding:6px 10px;cursor:pointer}',
      '#oaOv .oa-b.pri{border-color:#2f5bd3;background:#2f5bd3;color:#fff}',
      '#oaOv .oa-b.warn{border-color:#b42318;background:#b42318;color:#fff}',
      '#oaOv .oa-b:disabled{opacity:.45;cursor:not-allowed}',
      '#oaOv .oa-b:focus-visible,#oaOv .oa-x:focus-visible,#oaOv .oa-nb:focus-visible{outline:2px solid #2f5bd3;outline-offset:2px}',
      '#oaOv .oa-ft{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 18px;border-top:1px solid #dfe3ea;color:#5b6478;font-size:.8rem}',
      '#oaOv .oa-nb{font:inherit;font-size:.8rem;border-radius:9px;border:1px solid #2f5bd3;background:#eef2fb;color:#2f5bd3;padding:6px 10px;cursor:pointer;font-weight:700}',
      '#oaMsg{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9600;pointer-events:none;background:#1d2433;color:#fff;border-radius:14px;padding:16px 22px;display:grid;gap:6px;text-align:center;max-width:calc(100vw - 32px);box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:inherit}',
      '#oaMsg b{font-size:1.05rem}#oaMsg span{font-size:.82rem;opacity:.85}#oaMsg .bad{color:#ffb4a8;opacity:1}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function visibleItems() {
    var sn = readJson(localStorage, snoozeKey()), dis = readJson(sessionStorage, dismissKey()), now = Date.now();
    return S.items.filter(function (it) { return !(sn[sig(it)] && sn[sig(it)] > now) && !dis[sig(it)]; });
  }
  function thumbHtml(it) {
    var u = String(it.thumbnailUrl || '');
    var ini = esc(String(it.title || '?').replace(/^[^가-힣A-Za-z0-9]+/, '').slice(0, 2) || '상품');
    var img = /^https:\/\//i.test(u) ? '<img alt="" src="' + esc(u) + '" onerror="this.remove()">' : '';
    return '<div class="oa-th">' + ini + img + '</div>';
  }
  function notifSupported() { return typeof window.Notification === 'function'; }

  function itemHtml(it, i) {
    var auto = it.kind === 'auto_paused';
    var tag = auto ? '<span class="oa-tag auto">자동으로 멈춤 · 신고 ' + (it.reportCount | 0) + '명</span>'
      : '<span class="oa-tag">품절 신고 ' + (it.reportCount | 0) + '명</span>';
    var lead, acts;
    var dis = S.busy ? ' disabled' : '';
    var unit = it.hasOptions ? '이 상품' : '이 공고';   // 결정 259: 공고 전체
    if (!it.hasOptions && !it.wholeCampaign) {
      lead = '상품을 나누지 않은 공고라 상품만 멈출 수 없어요. 정말 품절이면 공고를 멈추거나 인원을 조절해 주세요.';
      acts = '<button type="button" class="oa-b pri" data-i="' + i + '" data-a="ack"' + dis + '>확인했어요</button>';
    } else if (auto) {
      lead = '다른 리뷰어 ' + (it.reportCount | 0) + '명이 품절이라 취소해서 ' + unit + '의 새 신청을 멈췄어요. 이미 참여 중인 사람은 그대로 진행해요.';
      acts = '<button type="button" class="oa-b pri" data-i="' + i + '" data-a="reopen"' + dis + '>다시 열기 — 재고가 있어요</button>' +
        '<button type="button" class="oa-b" data-i="' + i + '" data-a="keep"' + dis + '>멈춘 채로 두기</button>';
    } else {
      lead = '리뷰어 1명이 품절이라 취소했어요. 한 명이 더 같은 이유로 취소하면 자동으로 멈춰요.';
      acts = '<button type="button" class="oa-b warn" data-i="' + i + '" data-a="pause"' + dis + '>품절로 멈추기</button>' +
        '<button type="button" class="oa-b" data-i="' + i + '" data-a="not_soldout"' + dis + '>품절 아님 — 계속 받기</button>';
    }
    acts += '<button type="button" class="oa-b" data-i="' + i + '" data-a="snooze"' + dis + '>1시간 뒤 다시</button>';
    return '<div class="oa-item' + (auto ? ' auto' : '') + '">' + thumbHtml(it) +
      '<div class="oa-body"><div class="oa-top"><b>' + esc(it.title) + '</b>' + tag + '</div>' +
      (it.hasOptions ? '<div class="oa-opt">상품: ' + esc(it.optKey) + '</div>' : (it.wholeCampaign ? '<div class="oa-opt">공고 전체(상품을 나누지 않은 공고)</div>' : '')) +
      '<div class="oa-meta">' + esc(lead) + '</div>' +
      '<div class="oa-meta">' + esc([it.manager ? '담당 ' + it.manager : '', it.tabName ? '작업 ' + it.tabName : '', fmtTime(it.updatedAt || it.createdAt)].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="oa-acts">' + acts + '</div></div></div>';
  }

  function render() {
    var ov = document.getElementById('oaOv');
    var list = visibleItems();
    if (!list.length) { if (ov) ov.remove(); return; }
    if (!ov) { ov = document.createElement('div'); ov.id = 'oaOv'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'oaTitle'); document.body.appendChild(ov); bind(ov); }
    var nb = (notifSupported() && Notification.permission === 'default')
      ? '<button type="button" class="oa-nb" data-n="1">컴퓨터 알림 켜기 — 다른 창을 보고 있어도 알려줘요</button>' : '';
    ov.innerHTML = '<div class="oa-box"><div class="oa-hd"><h2 id="oaTitle">상품 품절 알림</h2>' +
      '<button type="button" class="oa-x" data-x="1" aria-label="닫기">✕</button></div>' +
      '<p class="oa-lead">관리자 모두에게 보이는 알림이에요. 한 분이 처리하면 모두의 화면에서 사라져요.</p>' +
      '<div class="oa-list">' + list.map(itemHtml).join('') + '</div>' +
      '<div class="oa-ft"><span>' + list.length + '건</span>' + nb + '</div></div>';
    S.view = list;
  }

  function bind(ov) {
    ov.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t || t.disabled) return;
      if (t.getAttribute('data-x')) {
        var dis = readJson(sessionStorage, dismissKey());
        (S.view || []).forEach(function (it) { dis[sig(it)] = 1; });
        writeJson(sessionStorage, dismissKey(), dis);
        ov.remove(); return;
      }
      if (t.getAttribute('data-n')) { askPermission(); return; }
      var i = Number(t.getAttribute('data-i')), a = t.getAttribute('data-a');
      var it = (S.view || [])[i]; if (!it) return;
      if (a === 'snooze') { var sn = readJson(localStorage, snoozeKey()); sn[sig(it)] = Date.now() + SNOOZE_MS; writeJson(localStorage, snoozeKey(), sn); render(); return; }
      act(it, a);
    });
  }

  function message(title, sub, bad) {
    var old = document.getElementById('oaMsg'); if (old) old.remove();
    var m = document.createElement('div'); m.id = 'oaMsg'; m.setAttribute('role', 'status');
    m.innerHTML = '<b>' + esc(title) + '</b>' + (sub ? '<span class="' + (bad ? 'bad' : '') + '">' + esc(sub) + '</span>' : '');
    document.body.appendChild(m);
    setTimeout(function () { if (m.parentNode) m.remove(); }, 3400);
  }

  var DONE = { reopen: '다시 열었어요 — 새 신청을 받아요', keep: '멈춘 채로 두었어요', pause: '품절로 멈췄어요 — 새 신청을 받지 않아요',
    not_soldout: '계속 받아요 — 쌓인 신고를 정리했어요', ack: '확인했어요' };

  async function act(it, a) {
    if (S.busy || !S.api) return;
    S.busy = true; render();
    var gen = S.gen;
    try {
      var j = await S.api(BASE + '/' + encodeURIComponent(it.id) + '/resolve', { method: 'POST', body: JSON.stringify({ action: a }) });
      if (gen !== S.gen) return;
      if (!j || !j.ok) throw new Error((j && j.error) || '서버가 처리하지 못했습니다');
      if (j.already) message('이미 다른 분이 처리했어요', j.resolvedBy ? ('처리한 사람: ' + j.resolvedBy) : '', false);
      else message(DONE[a] || '처리했어요', it.hasOptions ? it.optKey : '', false);
      if (typeof window.__onOptionPauseChanged === 'function') { try { window.__onOptionPauseChanged(it.campaignId); } catch (_) { /* noop */ } }
    } catch (e) {
      message('처리하지 못했습니다', (e && e.message) || '', true);
    } finally {
      S.busy = false;
      if (gen === S.gen) await load();
    }
  }

  /* ── 컴퓨터 알림(브라우저 알림) — 사용자 확정 (가). 같은 알림은 이 브라우저에서 한 번만(여러 창이 열려 있어도). ── */
  function askPermission() {
    if (!notifSupported()) return;
    try {
      var p = Notification.requestPermission(function () { render(); });
      if (p && typeof p.then === 'function') p.then(function () { render(); notifyNew(); });
    } catch (_) { /* noop */ }
  }
  function notifyNew() {
    if (!notifSupported() || Notification.permission !== 'granted') return;
    var seen = readJson(localStorage, notifiedKey()), now = Date.now(), changed = false;
    Object.keys(seen).forEach(function (k) { if (now - seen[k] > 7 * 86400000) { delete seen[k]; changed = true; } });
    visibleItems().forEach(function (it) {
      var k = sig(it);
      if (seen[k]) return;
      seen[k] = now; changed = true;
      try {
        var title = it.kind === 'auto_paused' ? '품절로 자동 멈춤 — ' + (it.optKey || it.title) : '품절 신고 — ' + (it.optKey || it.title);
        var n = new Notification(title, { body: it.title + ' · 리뷰웹시스템에서 확인해 주세요', tag: 'optalert_' + k, requireInteraction: true });
        n.onclick = function () { try { window.focus(); } catch (_) { /* noop */ } try { n.close(); } catch (_) { /* noop */ } render(); };
      } catch (_) { /* 알림 생성 미지원(모바일 등) — 화면 팝업이 1차 통로 */ }
    });
    if (changed) writeJson(localStorage, notifiedKey(), seen);
  }

  async function load() {
    if (!S.api) return false;
    var gen = S.gen;
    try {
      var j = await S.api(BASE);
      if (gen !== S.gen) return false;
      if (!j || !j.ok) return false;
      S.items = j.items || [];
      render();
      notifyNew();
      return true;
    } catch (_) { return false; }
  }

  /** 실시간 통로(SSE 'option_alert')가 부른다 — 여러 건이 몰려도 한 번만 읽는다. */
  function refresh() {
    if (!S.api) return;
    if (S.debounce) clearTimeout(S.debounce);
    S.debounce = setTimeout(function () { S.debounce = null; if (!S.busy) load(); }, 600);
  }

  function start(opts) {
    if (!opts || typeof opts.api !== 'function') return;
    S.gen++; S.api = opts.api; S.name = String(opts.name || '');
    injectStyles();
    load();
    if (S.timer) clearInterval(S.timer);
    S.timer = setInterval(function () { if (!S.busy) load(); }, POLL_MS);
  }
  function stop() {
    S.gen++;
    if (S.timer) clearInterval(S.timer); S.timer = null;
    if (S.debounce) clearTimeout(S.debounce); S.debounce = null;
    try { Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('wd_optalert_dismiss_v1_') === 0) sessionStorage.removeItem(k); }); } catch (_) { /* noop */ }
    var msg = document.getElementById('oaMsg'); if (msg) msg.remove();
    var ov = document.getElementById('oaOv'); if (ov) ov.remove();
    S.items = []; S.view = []; S.api = null; S.busy = false;
  }

  window.OptionAlertPrompt = { start: start, stop: stop, refresh: refresh, _state: S, _render: render };
  if (window.__OPTALERT_PENDING) { var p = window.__OPTALERT_PENDING; window.__OPTALERT_PENDING = null; start(p); }
})();
