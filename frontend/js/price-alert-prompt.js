/**
 * price-alert-prompt.js — 가격 신고 알림 팝업 (결정 266 · 사용자 확정 2026-10-20)
 *
 * 리뷰어가 "화면과 가격이 달라요"로 취소한 리뷰어가 **2명**이 되면 관리자 전원(마스터·관리자·AE)에게 띄운다.
 *   [금액 고치기] — 칸에 적은 1건당 금액으로 리뷰웹 모집공고 금액을 바로 바꾼다(인트라넷 리뷰오더는 그대로).
 *   [금액 맞음 — 그대로 두기] — 쌓인 신고를 정리한다.
 *   [결정 보류] — 알림만 닫는다(신고는 남는다 — 한 명이 더 신고하면 다시 뜬다).
 * 처리 결과는 작업조건 카드 「가격 신고」 줄에 이력으로 남는다(고침 전→후 · 누가 · 언제).
 * 한 사람이 처리하면 모두에게서 사라진다(서버가 알림을 닫고 실시간 통로로 다시 읽게 한다).
 *
 * ★ 판정·쓰기는 전부 서버(/api/trackb/price-alerts) — 화면은 그리기와 누른 것 전달만(사본 0).
 * ★ 실시간 통로가 끊겨도 1분마다 다시 읽는다 · ✕ 닫기 = 이 로그인 동안 지금 보이는 알림만 숨김.
 * ★ 품절 팝업(option-alert-prompt, z 9550)과 따로 뜬다 — 둘이 겹치면 품절이 위(멈춤이 더 급하다).
 * ★ 팝업은 body 직속 · onclick 문자열 보간 없음(이벤트 위임 + 인덱스) · 입력 중에는 다시 그리지 않는다(적던 금액 보호).
 */
(function () {
  'use strict';
  var BASE = '/api/trackb/price-alerts';
  var POLL_MS = 60 * 1000;
  var S = { api: null, name: '', items: [], view: [], timer: null, gen: 0, busy: false, debounce: null, draft: {} };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function won(n) { return n == null || !isFinite(Number(n)) ? '' : Number(n).toLocaleString('ko-KR') + '원'; }
  function sig(it) { return it.id + ':' + (it.reportCount | 0); }   // 신고가 더 오면 다시 띄운다
  function dismissKey() { return 'wd_pricealert_dismiss_v1_' + S.name; }
  function notifiedKey() { return 'wd_pricealert_notified_v1'; }
  function readJson(store, k) { try { return JSON.parse(store.getItem(k) || '{}') || {}; } catch (_) { return {}; } }
  function writeJson(store, k, v) { try { store.setItem(k, JSON.stringify(v)); } catch (_) { /* noop */ } }
  function fmtTime(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  /** 입력값 → 정수 원(쉼표·"원"·공백 허용). 숫자가 아니면 NaN. */
  function parseWon(v) {
    var s = String(v == null ? '' : v).replace(/[,\s원]/g, '');
    return /^\d{1,7}$/.test(s) ? Number(s) : NaN;
  }

  function injectStyles() {
    if (document.getElementById('paPromptStyles')) return;
    var st = document.createElement('style');
    st.id = 'paPromptStyles';
    st.textContent = [
      '#paOv{position:fixed;inset:0;z-index:9545;background:rgba(20,26,40,.42);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}',
      '#paOv *{box-sizing:border-box}',
      '#paOv .pa-box{width:min(600px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#fff;color:#1d2433;border-radius:14px;border:1px solid #dfe3ea;font-family:inherit}',
      '#paOv .pa-hd{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:16px 18px 6px}',
      '#paOv .pa-hd h2{font-size:1.05rem;margin:0}',
      '#paOv .pa-x{border:0;background:none;color:#5b6478;font-size:1.1rem;cursor:pointer;padding:4px 8px}',
      '#paOv .pa-lead{margin:0 18px 10px;color:#5b6478;font-size:.84rem}',
      '#paOv .pa-list{overflow:auto;min-height:0;padding:0 18px 12px;display:grid;gap:10px}',
      '#paOv .pa-item{border:1px solid #dfe3ea;border-radius:10px;padding:12px;display:grid;grid-template-columns:56px minmax(0,1fr);column-gap:12px;align-items:start}',
      '#paOv .pa-th{position:relative;width:56px;height:56px;border-radius:9px;border:1px solid #dfe3ea;background:#e9ecf1;display:flex;align-items:center;justify-content:center;color:#5b6478;font-weight:700;font-size:.85rem;overflow:hidden}',
      '#paOv .pa-th img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
      '#paOv .pa-body{display:grid;gap:6px;min-width:0}',
      '#paOv .pa-top{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '#paOv .pa-top b{min-width:0;overflow-wrap:anywhere}',
      '#paOv .pa-tag{font-size:.72rem;border-radius:6px;padding:2px 7px;font-weight:700;white-space:nowrap;background:#e8effd;color:#2f5bd3}',
      '#paOv .pa-opt{font-size:.86rem;font-weight:700;overflow-wrap:anywhere}',
      '#paOv .pa-meta{color:#5b6478;font-size:.8rem}',
      '#paOv .pa-now{font-size:.86rem}#paOv .pa-now b{font-size:.95rem}',
      '#paOv .pa-edit{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      '#paOv .pa-in{font:inherit;font-size:.9rem;width:130px;border:1px solid #c9cfda;border-radius:9px;padding:6px 10px;text-align:right}',
      '#paOv .pa-in:focus{outline:2px solid #2f5bd3;outline-offset:1px;border-color:#2f5bd3}',
      '#paOv .pa-acts{display:flex;flex-wrap:wrap;gap:6px}',
      '#paOv .pa-b{font:inherit;font-size:.8rem;border-radius:9px;border:1px solid #dfe3ea;background:#fff;color:#1d2433;padding:6px 10px;cursor:pointer}',
      '#paOv .pa-b.pri{border-color:#2f5bd3;background:#2f5bd3;color:#fff}',
      '#paOv .pa-b:disabled{opacity:.45;cursor:not-allowed}',
      '#paOv .pa-b:focus-visible,#paOv .pa-x:focus-visible{outline:2px solid #2f5bd3;outline-offset:2px}',
      '#paOv .pa-warn{color:#b5620b;font-size:.8rem}',
      '#paOv .pa-ft{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 18px;border-top:1px solid #dfe3ea;color:#5b6478;font-size:.8rem}',
      '#paMsg{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9600;pointer-events:none;background:#1d2433;color:#fff;border-radius:14px;padding:16px 22px;display:grid;gap:6px;text-align:center;max-width:calc(100vw - 32px);box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:inherit}',
      '#paMsg b{font-size:1.05rem}#paMsg span{font-size:.82rem;opacity:.85}#paMsg .bad{color:#ffb4a8;opacity:1}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function visibleItems() {
    var dis = readJson(sessionStorage, dismissKey());
    return S.items.filter(function (it) { return !dis[sig(it)]; });
  }
  function thumbHtml(it) {
    var u = String(it.thumbnailUrl || '');
    var ini = esc(String(it.title || '?').replace(/^[^가-힣A-Za-z0-9]+/, '').slice(0, 2) || '상품');
    var img = /^https:\/\//i.test(u) ? '<img alt="" src="' + esc(u) + '" onerror="this.remove()">' : '';
    return '<div class="pa-th">' + ini + img + '</div>';
  }
  var WHY = {
    multiple_amounts: '공고 글에 금액이 여러 개라 여기서 고칠 수 없어요. 모집공고 수정에서 고쳐 주세요.',
    has_options: '그사이 상품이 나뉜 공고예요. 모집공고 수정에서 상품별 금액을 고쳐 주세요.',
    no_work_detail: '공고 내용을 읽지 못했어요. 모집공고 수정에서 고쳐 주세요.',
  };

  function itemHtml(it, i) {
    var dis = S.busy ? ' disabled' : '';
    var draft = S.draft[it.id] == null ? '' : S.draft[it.id];
    var edit = it.editable
      ? '<div class="pa-edit"><label class="pa-meta" for="paIn' + i + '">새 금액(1건당)</label>' +
        '<input id="paIn' + i + '" class="pa-in" data-in="' + i + '" inputmode="numeric" autocomplete="off" placeholder="' + esc(it.currentAmount ? Number(it.currentAmount).toLocaleString('ko-KR') : '예: 8,900') + '" value="' + esc(draft) + '"' + dis + '>' +
        '<span class="pa-meta">원</span>' +
        '<button type="button" class="pa-b pri" data-i="' + i + '" data-a="edit"' + dis + '>금액 고치기</button></div>'
      : '<div class="pa-warn">' + esc(WHY[it.notEditableWhy] || '여기서 고칠 수 없어요. 모집공고 수정에서 고쳐 주세요.') + '</div>';
    var acts = '<button type="button" class="pa-b" data-i="' + i + '" data-a="keep"' + dis + '>금액 맞음 — 그대로 두기</button>' +
      '<button type="button" class="pa-b" data-i="' + i + '" data-a="defer"' + dis + '>결정 보류</button>';
    return '<div class="pa-item">' + thumbHtml(it) +
      '<div class="pa-body"><div class="pa-top"><b>' + esc(it.title) + '</b><span class="pa-tag">가격 신고 ' + (it.reportCount | 0) + '명</span></div>' +
      (it.hasOptions ? '<div class="pa-opt">상품: ' + esc(it.optKey) + '</div>' : '<div class="pa-opt">공고 전체(상품을 나누지 않은 공고)</div>') +
      '<div class="pa-meta">리뷰어 ' + (it.reportCount | 0) + '명이 "화면과 가격이 달라요"로 주문을 취소했어요. 스토어 가격을 확인해 주세요.</div>' +
      '<div class="pa-now">지금 공고 금액 <b>' + (it.currentAmount ? esc(won(it.currentAmount)) : '모름') + '</b></div>' +
      edit +
      '<div class="pa-meta">' + esc([it.manager ? '담당 ' + it.manager : '', it.tabName ? '작업 ' + it.tabName : '', fmtTime(it.updatedAt || it.createdAt)].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="pa-acts">' + acts + '</div></div></div>';
  }

  function editing() {
    var a = document.activeElement;
    return !!(a && a.getAttribute && a.getAttribute('data-in') != null && document.getElementById('paOv') && document.getElementById('paOv').contains(a));
  }

  function render(force) {
    var ov = document.getElementById('paOv');
    var list = visibleItems();
    if (!list.length) { if (ov) ov.remove(); S.view = []; return; }
    if (!force && editing()) return;   // ★ 금액을 적는 중에는 1분 갱신·실시간 갱신이 칸을 지우지 않게
    if (!ov) { ov = document.createElement('div'); ov.id = 'paOv'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'paTitle'); document.body.appendChild(ov); bind(ov); }
    ov.innerHTML = '<div class="pa-box"><div class="pa-hd"><h2 id="paTitle">가격 신고 알림</h2>' +
      '<button type="button" class="pa-x" data-x="1" aria-label="닫기">✕</button></div>' +
      '<p class="pa-lead">관리자 모두에게 보이는 알림이에요. 한 분이 처리하면 모두의 화면에서 사라져요. 고친 금액은 리뷰웹 모집공고에만 반영돼요(인트라넷 리뷰오더는 그대로).</p>' +
      '<div class="pa-list">' + list.map(itemHtml).join('') + '</div>' +
      '<div class="pa-ft"><span>' + list.length + '건</span><span>처리한 결과는 작업 조건 카드 「가격 신고」 줄에 남아요</span></div></div>';
    S.view = list;
  }

  function bind(ov) {
    ov.addEventListener('input', function (e) {
      var t = e.target; if (!t || t.getAttribute('data-in') == null) return;
      var it = (S.view || [])[Number(t.getAttribute('data-in'))]; if (it) S.draft[it.id] = t.value;
    });
    ov.addEventListener('keydown', function (e) {
      var t = e.target; if (!t || t.getAttribute('data-in') == null || e.key !== 'Enter') return;
      var it = (S.view || [])[Number(t.getAttribute('data-in'))]; if (it) { e.preventDefault(); act(it, 'edit'); }
    });
    ov.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t || t.disabled) return;
      if (t.getAttribute('data-x')) {
        var dis = readJson(sessionStorage, dismissKey());
        (S.view || []).forEach(function (it) { dis[sig(it)] = 1; });
        writeJson(sessionStorage, dismissKey(), dis);
        ov.remove(); return;
      }
      var it = (S.view || [])[Number(t.getAttribute('data-i'))]; if (!it) return;
      act(it, t.getAttribute('data-a'));
    });
  }

  function message(title, sub, bad) {
    var old = document.getElementById('paMsg'); if (old) old.remove();
    var m = document.createElement('div'); m.id = 'paMsg'; m.setAttribute('role', 'status');
    m.innerHTML = '<b>' + esc(title) + '</b>' + (sub ? '<span class="' + (bad ? 'bad' : '') + '">' + esc(sub) + '</span>' : '');
    document.body.appendChild(m);
    setTimeout(function () { if (m.parentNode) m.remove(); }, 3400);
  }

  var DONE = { edit: '금액을 고쳤어요 — 리뷰어 화면에 바로 반영돼요', keep: '그대로 두었어요 — 쌓인 신고를 정리했어요', defer: '보류했어요 — 한 명이 더 신고하면 다시 알려드려요' };

  async function act(it, a) {
    if (S.busy || !S.api) return;
    var body = { action: a };
    if (a === 'edit') {
      var amt = parseWon(S.draft[it.id]);
      if (!(amt > 0)) { message('금액을 숫자로 적어 주세요', '1건당 금액 · 예: 8900 또는 8,900', true); return; }
      body.amount = amt;
    }
    S.busy = true; render(true);
    var gen = S.gen;
    try {
      var j = await S.api(BASE + '/' + encodeURIComponent(it.id) + '/resolve', { method: 'POST', body: JSON.stringify(body) });
      if (gen !== S.gen) return;
      if (!j || !j.ok) throw new Error((j && j.error) || '서버가 처리하지 못했습니다');
      delete S.draft[it.id];
      if (j.already) message('이미 다른 분이 처리했어요', j.resolvedBy ? ('처리한 사람: ' + j.resolvedBy) : '', false);
      else message(DONE[a] || '처리했어요', a === 'edit' ? (won(j.oldAmount) ? won(j.oldAmount) + ' → ' : '') + won(j.newAmount) : (it.hasOptions ? it.optKey : ''), false);
      if (typeof window.__onOptionPauseChanged === 'function') { try { window.__onOptionPauseChanged(it.campaignId); } catch (_) { /* noop */ } }
    } catch (e) {
      message('처리하지 못했습니다', (e && e.message) || '', true);
    } finally {
      S.busy = false;
      if (gen === S.gen) await load(true);
    }
  }

  /* 컴퓨터 알림 — 품절 팝업이 받아 둔 허용을 같이 쓴다(이 팝업은 허용을 따로 묻지 않는다). 같은 알림은 이 브라우저에서 한 번만. */
  function notifyNew() {
    if (typeof window.Notification !== 'function' || Notification.permission !== 'granted') return;
    var seen = readJson(localStorage, notifiedKey()), now = Date.now(), changed = false;
    Object.keys(seen).forEach(function (k) { if (now - seen[k] > 7 * 86400000) { delete seen[k]; changed = true; } });
    visibleItems().forEach(function (it) {
      var k = sig(it);
      if (seen[k]) return;
      seen[k] = now; changed = true;
      try {
        var n = new Notification('가격 신고 ' + (it.reportCount | 0) + '명 — ' + (it.optKey || it.title), { body: it.title + ' · 리뷰웹시스템에서 금액을 확인해 주세요', tag: 'pricealert_' + k, requireInteraction: true });
        n.onclick = function () { try { window.focus(); } catch (_) { /* noop */ } try { n.close(); } catch (_) { /* noop */ } render(true); };
      } catch (_) { /* 알림 생성 미지원 — 화면 팝업이 1차 통로 */ }
    });
    if (changed) writeJson(localStorage, notifiedKey(), seen);
  }

  async function load(force) {
    if (!S.api) return false;
    var gen = S.gen;
    try {
      var j = await S.api(BASE);
      if (gen !== S.gen) return false;
      if (!j || !j.ok) return false;
      S.items = j.items || [];
      render(force === true);
      notifyNew();
      return true;
    } catch (_) { return false; }
  }

  /** 실시간 통로(SSE 'price_alert')가 부른다 — 여러 건이 몰려도 한 번만 읽는다. */
  function refresh() {
    if (!S.api) return;
    if (S.debounce) clearTimeout(S.debounce);
    S.debounce = setTimeout(function () { S.debounce = null; if (!S.busy) load(); }, 600);
  }

  function start(opts) {
    if (!opts || typeof opts.api !== 'function') return;
    S.gen++; S.api = opts.api; S.name = String(opts.name || ''); S.draft = {};
    injectStyles();
    load();
    if (S.timer) clearInterval(S.timer);
    S.timer = setInterval(function () { if (!S.busy) load(); }, POLL_MS);
  }
  function stop() {
    S.gen++;
    if (S.timer) clearInterval(S.timer); S.timer = null;
    if (S.debounce) clearTimeout(S.debounce); S.debounce = null;
    try { Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('wd_pricealert_dismiss_v1_') === 0) sessionStorage.removeItem(k); }); } catch (_) { /* noop */ }
    var msg = document.getElementById('paMsg'); if (msg) msg.remove();
    var ov = document.getElementById('paOv'); if (ov) ov.remove();
    S.items = []; S.view = []; S.api = null; S.busy = false; S.draft = {};
  }

  window.PriceAlertPrompt = { start: start, stop: stop, refresh: refresh, _state: S, _render: render, _parseWon: parseWon };
  if (window.__PRICEALERT_PENDING) { var p = window.__PRICEALERT_PENDING; window.__PRICEALERT_PENDING = null; start(p); }
})();
