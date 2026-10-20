/**
 * staff-notice-prompt.js — 직원 공지 팝업 (결정 265 · 사용자 확정 2026-10-20)
 *
 * 옛 관리자 대시보드(index-app.js `_showAdminNoticePopup`)에만 있던 "로그인하면 뜨는 관리자 공지"를
 * 작업보드로 옮겼다. 공지 작성·수정은 작업보드 설정 → 「📢 직원 공지」(admin-settings.js).
 *   - 안 읽은 공지만 뜬다(대상 이름이 비었으면 전체, 아니면 그 이름의 직원만) — 판정은 서버.
 *   - [확인] = 읽음 기록 → 다음 접속부터 안 뜬다. ✕ 닫기 = 이번 접속에서만 숨김(기록 안 남김).
 *   - 본문에 [필수열람] + 문서 주소(https://…)가 있으면 그 링크를 열기 전까지 [확인]이 잠긴다(결정 001 그대로).
 *     링크 없는 필수열람은 잠그지 않는다(잠금 사고 방지).
 *
 * ★ 판정·쓰기는 전부 서버(/api/trackb/staff-notices) — 화면은 그리기와 누른 것 전달만(사본 0).
 * ★ 링크화는 escape 한 뒤 따옴표·꺾쇠 없는 주소만 바꾼다(href 탈출 방지 — 결정 001 과 같은 원칙).
 * ★ 팝업은 body 직속 · onclick 문자열 보간 없음(이벤트 위임 + data-*).
 */
(function () {
  'use strict';
  var BASE = '/api/trackb/staff-notices';
  var S = { api: null, name: '', items: [], gate: {}, gen: 0, busy: false };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function dismissKey() { return 'wd_staffnotice_dismiss_v1_' + S.name; }
  function readJson(k) { try { return JSON.parse(sessionStorage.getItem(k) || '{}') || {}; } catch (_) { return {}; } }
  function writeJson(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* noop */ } }
  function fmtDate(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + '.';
  }

  function injectStyles() {
    if (document.getElementById('snPromptStyles')) return;
    var st = document.createElement('style');
    st.id = 'snPromptStyles';
    st.textContent = [
      '#snOv{position:fixed;inset:0;z-index:9560;background:rgba(20,26,40,.42);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}',
      '#snOv *{box-sizing:border-box}',
      '#snOv .sn-box{width:min(520px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#fff;color:#1d2433;border-radius:14px;border:1px solid #dfe3ea;font-family:inherit}',
      '#snOv .sn-hd{display:flex;align-items:center;gap:8px;padding:16px 18px 6px}',
      '#snOv .sn-hd h2{font-size:1.05rem;margin:0}',
      '#snOv .sn-cnt{font-size:.74rem;font-weight:700;border-radius:999px;padding:2px 8px;background:#fdf1e2;color:#b5620b}',
      '#snOv .sn-x{margin-left:auto;border:0;background:none;color:#5b6478;font-size:1.1rem;cursor:pointer;padding:4px 8px}',
      '#snOv .sn-lead{margin:0 18px 10px;color:#5b6478;font-size:.84rem}',
      '#snOv .sn-list{overflow:auto;min-height:0;padding:0 18px 12px;display:grid;gap:10px}',
      '#snOv .sn-item{border:1px solid #dfe3ea;border-radius:10px;padding:12px 14px;display:grid;gap:6px}',
      '#snOv .sn-item.req{border-color:#f0b4ad;background:#fff8f7}',
      '#snOv .sn-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '#snOv .sn-top b{min-width:0;overflow-wrap:anywhere;font-size:.92rem}',
      '#snOv .sn-tag{font-size:.7rem;border-radius:6px;padding:2px 7px;font-weight:700;white-space:nowrap;background:#e8effc;color:#2f5bd3}',
      '#snOv .sn-tag.req{background:#fde4e1;color:#b42318}',
      '#snOv .sn-body{font-size:.86rem;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}',
      '#snOv .sn-body a{color:#2f5bd3;font-weight:700;text-decoration:underline;word-break:break-all}',
      '#snOv .sn-body a.done{color:#127a5e}',
      '#snOv .sn-meta{color:#5b6478;font-size:.78rem}',
      '#snOv .sn-ft{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;padding:12px 18px;border-top:1px solid #dfe3ea}',
      '#snOv .sn-hint{margin-right:auto;font-size:.8rem;font-weight:700;color:#b42318}',
      '#snOv .sn-hint.ok{color:#127a5e}',
      '#snOv .sn-b{font:inherit;font-size:.84rem;font-weight:700;border-radius:9px;border:1px solid #2f5bd3;background:#2f5bd3;color:#fff;padding:7px 16px;cursor:pointer}',
      '#snOv .sn-b:disabled{opacity:.45;cursor:not-allowed}',
      '#snOv .sn-b:focus-visible,#snOv .sn-x:focus-visible,#snOv .sn-body a:focus-visible{outline:2px solid #2f5bd3;outline-offset:2px}',
    ].join('\n');
    document.head.appendChild(st);
  }

  /** 본문 → 표시용 HTML. [필수열람] 표시는 지우고, 주소는 escape 뒤에만 링크로 바꾼다. */
  function bodyHtml(n) {
    var raw = String(n.content || '');
    var required = raw.indexOf('[필수열람]') >= 0;
    var text = required ? raw.split('[필수열람]').join('').trim() : raw;
    var id = Number(n.id) || 0;
    var html = esc(text).replace(/(https?:\/\/[^\s"'<>]+)/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener" data-doc="' + id + '"' + (S.gate[id] ? ' class="done"' : '') + '>' + u + '</a>';
    });
    return { html: html, required: required, gated: required && /https?:\/\//.test(text) };
  }

  function visibleItems() {
    var dis = readJson(dismissKey());
    return S.items.filter(function (n) { return !dis[n.id]; });
  }
  function gateOpen() { return Object.keys(S.gate).every(function (k) { return S.gate[k]; }); }

  function render() {
    var ov = document.getElementById('snOv');
    var list = visibleItems();
    if (!list.length) { if (ov) ov.remove(); return; }
    if (!ov) { ov = document.createElement('div'); ov.id = 'snOv'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'snTitle'); document.body.appendChild(ov); bind(ov); }
    var items = list.map(function (n) {
      var b = bodyHtml(n);
      if (b.gated && !(n.id in S.gate)) S.gate[n.id] = false;
      return '<div class="sn-item' + (b.required ? ' req' : '') + '">' +
        '<div class="sn-top"><span class="sn-tag">공지</span>' + (b.required ? '<span class="sn-tag req">필수열람</span>' : '') + '<b>' + esc(n.title) + '</b></div>' +
        '<div class="sn-body">' + b.html + '</div>' +
        '<div class="sn-meta">' + esc([n.created_by ? '작성 ' + n.created_by : '', fmtDate(n.created_at), n.expires_at ? fmtDate(n.expires_at) + '까지 보임' : ''].filter(Boolean).join(' · ')) + '</div></div>';
    }).join('');
    var gated = Object.keys(S.gate).length > 0, open = gateOpen();
    var hint = gated ? (open ? '<span class="sn-hint ok">문서를 열었어요 — 확인을 눌러 주세요</span>'
      : '<span class="sn-hint">필수열람 문서(링크)를 열면 확인 버튼이 눌려요</span>') : '';
    ov.innerHTML = '<div class="sn-box"><div class="sn-hd"><h2 id="snTitle">직원 공지</h2><span class="sn-cnt">' + list.length + '건</span>' +
      '<button type="button" class="sn-x" data-x="1" aria-label="닫기">✕</button></div>' +
      '<p class="sn-lead">확인을 누르면 다음 접속부터 다시 뜨지 않아요. ✕로 닫으면 다음 접속 때 다시 보여요.</p>' +
      '<div class="sn-list">' + items + '</div>' +
      '<div class="sn-ft">' + hint + '<button type="button" class="sn-b" data-ok="1"' + ((gated && !open) || S.busy ? ' disabled' : '') + '>확인</button></div></div>';
    S.view = list;
  }

  function bind(ov) {
    ov.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[data-doc]') : null;
      if (a) {   // 링크 기본 동작(새 탭 열기)은 그대로 — 열었다는 표시만 남긴다
        var id = Number(a.getAttribute('data-doc'));
        if (id in S.gate) { S.gate[id] = true; setTimeout(render, 0); }
        return;
      }
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t || t.disabled) return;
      if (t.getAttribute('data-x')) {
        var dis = readJson(dismissKey());
        (S.view || []).forEach(function (n) { dis[n.id] = 1; });
        writeJson(dismissKey(), dis);
        ov.remove(); return;
      }
      if (t.getAttribute('data-ok')) confirmRead();
    });
  }

  /** 확인 = 보이는 공지 전부 읽음 기록. 기록에 실패한 공지는 다음 접속 때 다시 뜬다(조용히 사라지지 않는다). */
  async function confirmRead() {
    if (S.busy || !S.api || !gateOpen()) return;
    S.busy = true; render();
    var gen = S.gen, ids = (S.view || []).map(function (n) { return n.id; }), failed = [];
    for (var i = 0; i < ids.length; i++) {
      try {
        var j = await S.api(BASE + '/read', { method: 'POST', body: JSON.stringify({ notice_id: ids[i] }) });
        if (!j || j.success !== true) failed.push(ids[i]);
      } catch (_) { failed.push(ids[i]); }
      if (gen !== S.gen) return;
    }
    S.busy = false;
    S.items = S.items.filter(function (n) { return ids.indexOf(n.id) < 0; });
    render();
    if (failed.length && typeof window.toast === 'function') window.toast('공지 ' + failed.length + '건은 확인 기록을 남기지 못했어요 — 다음 접속 때 다시 보여요');
  }

  async function load() {
    if (!S.api) return false;
    var gen = S.gen;
    try {
      var j = await S.api(BASE + '/unread');
      if (gen !== S.gen) return false;
      if (!j || j.success !== true) return false;   // 조회 실패·구버전 서버 = 팝업 생략(업무를 막지 않는다)
      S.items = j.notices || [];
      render();
      return true;
    } catch (_) { return false; }
  }

  /** 로그인 직후 한 번 — 옛 대시보드와 같다(접속할 때마다 안 읽은 공지를 본다). */
  function start(opts) {
    if (!opts || typeof opts.api !== 'function') return;
    S.gen++; S.api = opts.api; S.name = String(opts.name || '');
    S.items = []; S.gate = {}; S.busy = false;
    injectStyles();
    load();
  }
  function stop() {
    S.gen++;
    try { Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('wd_staffnotice_dismiss_v1_') === 0) sessionStorage.removeItem(k); }); } catch (_) { /* noop */ }
    var ov = document.getElementById('snOv'); if (ov) ov.remove();
    S.items = []; S.view = []; S.gate = {}; S.api = null; S.busy = false;
  }

  window.StaffNoticePrompt = { start: start, stop: stop, _state: S, _render: render, _bodyHtml: bodyHtml };
  if (window.__STAFFNOTICE_PENDING) { var p = window.__STAFFNOTICE_PENDING; window.__STAFFNOTICE_PENDING = null; start(p); }
})();
