/**
 * shortage-prompt.js — 어제 모집 부족 인원 처리 팝업 (사용자 확정 2026-10-02 · 시안 frontend/docs/design-carry-shortage-popup.html 안 1)
 *
 * 로그인한 직원(공고 담당자 · 작업오더 보낸 AE)에게 어제 하루 인원을 다 못 채운 공고를 한 장에 모아 보여주고
 * 공고마다 [기간 늘려 뒤에 붙이기 / 오늘 모집에 +N명 / 1시간 뒤 다시] 중 하나를 **고르기만** 한다.
 * 오른쪽 아래 [반영]을 누를 때만 한꺼번에 서버에 반영하고, 화면 정중앙에 결과가 잠깐 떴다가 천천히 사라진다.
 *
 * ★ 판정·계산은 전부 서버(/api/trackb/shortage-prompts) — 화면은 그리기와 고른 값 전달만 한다(사본 0).
 * ★ "1시간 뒤 다시"는 서버를 부르지 않는다 — 누른 사람의 이 브라우저에만 기억한다(다른 담당자에겐 그대로 뜬다).
 * ★ ✕(닫기)는 이번 로그인 동안만 숨긴다 — 처리하지 않은 공고는 다음 로그인 때 다시 묻는다.
 * ★ 팝업·결과 안내는 body 직속 · onclick 문자열 보간 없음(이벤트 위임 + 인덱스).
 */
(function () {
  'use strict';
  var BASE = '/api/trackb/shortage-prompts';
  var SNOOZE_MS = 60 * 60 * 1000;
  var POLL_MS = 60 * 1000;
  var S = { api: null, name: '', items: [], sel: {}, timer: null, open: false, date: '', gen: 0 };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function snoozeKey() { return 'wd_shortage_snooze_v1_' + S.name; }
  function dismissKey() { return 'wd_shortage_dismiss_v1_' + S.name + '_' + S.date; }
  function readSnooze() { try { return JSON.parse(localStorage.getItem(snoozeKey()) || '{}') || {}; } catch (_) { return {}; } }
  function writeSnooze(m) { try { localStorage.setItem(snoozeKey(), JSON.stringify(m)); } catch (_) { /* 기억 못 해도 동작은 계속 */ } }
  function isDismissed() { try { return sessionStorage.getItem(dismissKey()) === '1'; } catch (_) { return false; } }
  function setDismissed() { try { sessionStorage.setItem(dismissKey(), '1'); } catch (_) { /* noop */ } }

  function injectStyles() {
    if (document.getElementById('spStyles')) return;
    var st = document.createElement('style');
    st.id = 'spStyles';
    st.textContent = [
      '#spOv{position:fixed;inset:0;z-index:9500;background:rgba(20,26,40,.42);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}',
      '#spOv *{box-sizing:border-box}',
      '#spOv .sp-box{width:min(640px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#fff;color:#1d2433;border-radius:14px;border:1px solid #dfe3ea;font-family:inherit}',
      '#spOv .sp-hd{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:16px 18px 6px}',
      '#spOv .sp-hd h2{font-size:1.05rem;margin:0}',
      '#spOv .sp-x{border:0;background:none;color:#5b6478;font-size:1.1rem;cursor:pointer;padding:4px 8px}',
      '#spOv .sp-lead{margin:0 18px 10px;color:#5b6478;font-size:.84rem}',
      '#spOv .sp-list{overflow:auto;min-height:0;padding:0 18px 12px;display:grid;gap:10px}',
      '#spOv .sp-item{border:1px solid #dfe3ea;border-radius:10px;padding:12px;display:grid;grid-template-columns:64px minmax(0,1fr);column-gap:12px;align-items:start}',
      '#spOv .sp-item.picked{border-color:#2f5bd3}',
      '#spOv .sp-th{position:relative;width:64px;height:64px;border-radius:9px;border:1px solid #dfe3ea;background:#e9ecf1;display:flex;align-items:center;justify-content:center;color:#5b6478;font-weight:700;font-size:.9rem;overflow:hidden}',
      '#spOv .sp-th img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
      '#spOv .sp-body{display:grid;gap:7px;min-width:0}',
      '#spOv .sp-top{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '#spOv .sp-top b{min-width:0;overflow-wrap:anywhere}',
      '#spOv .sp-tag{font-size:.72rem;border-radius:6px;padding:2px 7px;background:#fdf1e2;color:#b5620b;font-weight:700;white-space:nowrap}',
      '#spOv .sp-meta{color:#5b6478;font-size:.8rem;font-variant-numeric:tabular-nums}',
      '#spOv .sp-acts{display:flex;flex-wrap:wrap;gap:6px}',
      '#spOv .sp-b{font:inherit;font-size:.8rem;border-radius:9px;border:1px solid #dfe3ea;background:#fff;color:#1d2433;padding:6px 10px;cursor:pointer}',
      '#spOv .sp-b[aria-pressed="true"]{border-color:#2f5bd3;background:#2f5bd3;color:#fff}',
      '#spOv .sp-b:disabled{opacity:.45;cursor:not-allowed}',
      '#spOv .sp-b:focus-visible,#spOv .sp-apply:focus-visible,#spOv .sp-x:focus-visible{outline:2px solid #2f5bd3;outline-offset:2px}',
      '#spOv .sp-ft{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 18px;border-top:1px solid #dfe3ea}',
      '#spOv .sp-apply{font:inherit;font-weight:700;border:0;border-radius:9px;padding:10px 22px;background:#2f5bd3;color:#fff;cursor:pointer}',
      '#spOv .sp-apply:disabled{opacity:.45;cursor:not-allowed}',
      '#spMsg{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9600;pointer-events:none;background:#1d2433;color:#fff;border-radius:14px;padding:16px 22px;display:grid;gap:6px;text-align:center;max-width:calc(100vw - 32px);box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:inherit}',
      '#spMsg b{font-size:1.05rem}#spMsg span{font-size:.82rem;opacity:.85}#spMsg .bad{color:#ffb4a8;opacity:1}',
      '@media (prefers-reduced-motion:no-preference){#spMsg{animation:spfade 3.2s ease-in forwards}@keyframes spfade{0%{opacity:0;transform:translate(-50%,-46%)}10%{opacity:1;transform:translate(-50%,-50%)}60%{opacity:1}100%{opacity:0}}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function visibleItems() {
    var sn = readSnooze(), now = Date.now();
    return S.items.filter(function (it) { return !(sn[it.campaignId] && sn[it.campaignId] > now); });
  }

  function thumbHtml(it) {
    // 글자 썸네일을 깔고 그 위에 이미지를 덮는다 — 이미지를 못 불러오면 이미지만 숨겨 글자가 보인다
    var u = String(it.thumbnailUrl || '');
    var ini = esc(String(it.title || '?').replace(/^[^가-힣A-Za-z0-9]+/, '').slice(0, 2) || '상품');
    var img = /^https:\/\//i.test(u) ? '<img alt="" src="' + esc(u) + '" onerror="this.remove()">' : '';
    return '<div class="sp-th">' + ini + img + '</div>';
  }

  function hintFor(it, c) {
    if (c === 'extend') return '그대로 끝나는 날을 뒤로 미룹니다' + (it.endDate ? ' (예상 종료 ' + esc(it.endDate) + ')' : '') + ' · 이 공고는 앞으로 묻지 않음';
    if (c === 'today') return '오늘 정원 ' + it.todayQuota + '명 → ' + (it.todayQuota + it.addable) + '명';
    if (c === 'later') return '1시간 뒤 다시 묻습니다';
    return '아직 고르지 않았습니다';
  }

  function render() {
    var list = visibleItems();
    var ov = document.getElementById('spOv');
    if (!list.length) { if (ov) ov.remove(); S.open = false; return; }
    if (!ov) { ov = document.createElement('div'); ov.id = 'spOv'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', '어제 모집 부족 인원'); document.body.appendChild(ov); ov.addEventListener('click', onClick); }
    S.open = true;
    var nSel = list.filter(function (it) { return S.sel[it.campaignId]; }).length;
    ov.innerHTML = '<div class="sp-box">' +
      '<div class="sp-hd"><h2>어제 모집 인원이 부족한 공고 ' + list.length + '건</h2><button type="button" class="sp-x" data-a="close" aria-label="닫기">✕</button></div>' +
      '<p class="sp-lead">공고마다 처리 방법을 고른 뒤 오른쪽 아래 [반영]을 누르면 한꺼번에 적용됩니다.</p>' +
      '<div class="sp-list">' + list.map(function (it) {
        var i = S.items.indexOf(it), c = S.sel[it.campaignId];
        function pb(a, t, dis, why) { return '<button type="button" class="sp-b" data-a="pick" data-c="' + a + '" data-i="' + i + '" aria-pressed="' + (c === a) + '"' + (dis ? ' disabled title="' + esc(why) + '"' : '') + '>' + t + '</button>'; }
        return '<div class="sp-item' + (c ? ' picked' : '') + '">' + thumbHtml(it) + '<div class="sp-body">' +
          '<div class="sp-top"><b>' + esc(it.title) + '</b><span class="sp-tag">어제 ' + it.shortage + '명 부족</span></div>' +
          '<div class="sp-meta">어제 계획 ' + it.yesterdayQuota + '명 · 실제 ' + it.yesterdayConfirmed + '명' + (it.manager ? ' · 담당 ' + esc(it.manager) : '') + '</div>' +
          '<div class="sp-acts">' + pb('extend', '기간 늘려 뒤에 붙이기') +
            pb('today', it.canAddToday ? '오늘 모집에 +' + it.addable + '명' : '오늘 모집에 더하기', !it.canAddToday, it.todayBlockedReason || '') +
            pb('later', '1시간 뒤 다시') + '</div>' +
          '<div class="sp-meta">' + hintFor(it, c) +
            (!c && !it.canAddToday && it.todayBlockedReason ? ' · 오늘에 더할 수 없음: ' + esc(it.todayBlockedReason) : '') +
            ((!c || c === 'today') && it.canAddToday && it.addable < it.shortage ? ' · 남은 총인원 때문에 ' + it.addable + '명까지만 더할 수 있습니다' : '') + '</div>' +
          '</div></div>';
      }).join('') + '</div>' +
      '<div class="sp-ft"><span class="sp-meta">' + nSel + '건 선택' + (list.length - nSel ? ' · 고르지 않은 ' + (list.length - nSel) + '건은 다음 로그인 때 다시 묻습니다' : '') + '</span>' +
      '<button type="button" class="sp-apply" data-a="apply"' + (nSel ? '' : ' disabled') + '>반영</button></div></div>';
  }

  function showMsg(title, lines) {
    var old = document.getElementById('spMsg'); if (old) old.remove();
    var m = document.createElement('div'); m.id = 'spMsg'; m.setAttribute('role', 'status');
    m.innerHTML = '<b>' + esc(title) + '</b>' + lines.map(function (l) { return '<span' + (l.bad ? ' class="bad"' : '') + '>' + esc(l.text) + '</span>'; }).join('');
    document.body.appendChild(m);
    var gone = function () { if (m.parentNode) m.parentNode.removeChild(m); };
    m.addEventListener('animationend', gone);
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(gone, reduce ? 2600 : 3600);   // 애니메이션 이벤트가 안 와도 반드시 사라진다
  }

  var LABEL = { extend: '기간을 늘려 뒤에 붙임', today: '오늘 모집에 더함', later: '1시간 뒤 다시 묻기' };

  async function apply() {
    var picks = Object.keys(S.sel).map(function (id) { return { campaignId: id, choice: S.sel[id] }; });
    if (!picks.length) return;
    var btn = document.querySelector('#spOv .sp-apply'); if (btn) { btn.disabled = true; btn.textContent = '반영 중…'; }
    var later = picks.filter(function (p) { return p.choice === 'later'; });
    var send = picks.filter(function (p) { return p.choice !== 'later'; });
    var lines = [], okCount = 0, failed = false, applied = [];
    if (later.length) {
      var sn = readSnooze(); var until = Date.now() + SNOOZE_MS;
      later.forEach(function (p) { sn[p.campaignId] = until; });
      writeSnooze(sn); okCount += later.length;
      later.forEach(function (p) { var it = byId(p.campaignId); lines.push({ text: (it ? it.title : '') + ' — ' + LABEL.later }); });
    }
    if (send.length) {
      // ★ 서버는 한 번에 50건까지만 받는다 → 50건씩 나눠 보낸다(51건 이상이면 통째로 거절되던 것 — 코덱스 리뷰)
      var r = { ok: true, results: [] }, gen = S.gen;
      for (var bi = 0; bi < send.length; bi += 50) {
        var rr = null;
        try { rr = await S.api(BASE + '/apply', { method: 'POST', body: JSON.stringify({ decisions: send.slice(bi, bi + 50), date: S.date }) }); } catch (e) { rr = null; }
        if (gen !== S.gen) return;   // 그 사이 로그아웃
        if (!rr || !rr.ok) { if (!r.results.length) r = rr; else { r.ok = true; failed = true; lines.push({ bad: true, text: '일부(' + (send.length - bi) + '건)는 반영하지 못했습니다: ' + ((rr && rr.error) || '연결 오류') + ' — 다시 골라 주세요' }); } break; }
        r.results = r.results.concat(rr.results || []);
      }
      if (!r || !r.ok) {
        failed = true;
        lines.push({ bad: true, text: '반영하지 못했습니다: ' + ((r && r.error) || '연결 오류') + ' — 다시 골라 주세요' });
      } else {
        (r.results || []).forEach(function (x) {
          var it = byId(x.campaignId), t = (x.title || (it && it.title) || '');
          if (x.ok) {
            okCount++; applied.push(x);
            lines.push({ text: t + ' — ' + (x.choice === 'today' ? (x.todayTo != null ? '오늘 모집 ' + x.todayFrom + '명 → ' + x.todayTo + '명' : '오늘 모집에 더함') : LABEL.extend) });
            if (x.worktable && (x.worktable.ok === false || x.worktable.warn)) lines.push({ bad: true, text: t + ' — ' + (x.worktable.reason || '작업표 확인 필요') });
          } else { if (x.code !== 'already_decided') failed = true; lines.push({ bad: true, text: t + ' — ' + (x.code === 'already_decided' ? '' : '반영 실패: ') + (x.reason || '') }); }
        });
      }
    }
    S.sel = {};
    var ov = document.getElementById('spOv'); if (ov) ov.remove(); S.open = false;
    showMsg((failed ? '' : '✓ ') + okCount + '건 반영했습니다', lines);
    // 반영된 것은 서버 목록에서 빠진다 — 다시 받는다. ★ 실패가 있으면 그 공고를 **다시 띄운다**(조용히 숨지 않게 — 코덱스 리뷰).
    // ★ 다시 받는 것마저 실패하면 1분마다 다시 시도하도록 "아직 못 받음" 상태로 돌려 둔다(코덱스 리뷰)
    if (failed) { S.loadedOnce = false; setTimeout(function () { if (!S.loading) load(true); }, 3700); } else load(false);
    // 화면 갱신은 **실제로 바뀐 공고가 있을 때만**(1시간 뒤 다시만 고른 경우 표 상태를 흔들지 않는다)
    if (applied.length) { try { if (typeof window.SHORTAGE_ON_APPLIED === 'function') window.SHORTAGE_ON_APPLIED(applied); } catch (_) { /* 화면 갱신 실패는 반영과 무관 */ } }
  }

  function byId(id) { for (var k = 0; k < S.items.length; k++) if (String(S.items[k].campaignId) === String(id)) return S.items[k]; return null; }

  function onClick(e) {
    var b = e.target.closest('[data-a]'); if (!b) return;
    var a = b.getAttribute('data-a');
    if (a === 'close') { setDismissed(); var ov = document.getElementById('spOv'); if (ov) ov.remove(); S.open = false; return; }
    if (a === 'apply') { apply(); return; }
    if (a === 'pick') {
      var it = S.items[Number(b.getAttribute('data-i'))]; if (!it) return;
      var c = b.getAttribute('data-c');
      if (S.sel[it.campaignId] === c) delete S.sel[it.campaignId]; else S.sel[it.campaignId] = c;
      render();
    }
  }

  // 성공하면 true — 1시간 뒤 다시 묻기 표시는 다시 받는 데 **성공한 뒤에만** 지운다(코덱스 리뷰)
  async function load(show) {
    // ★ 로그아웃·계정 전환 뒤 늦게 도착한 응답은 버린다(이전 사람의 공고가 새 화면에 그려지지 않게 — 코덱스 리뷰)
    var gen = S.gen, api = S.api;
    if (!api) return;
    var r = null;
    try { r = await api(BASE); } catch (_) { r = null; }
    if (gen !== S.gen || !S.api) return false;
    if (!r || !r.ok) return false;   // 조회 실패 = 팝업 안 띄움(화면은 정상)
    S.date = r.date || '';
    S.items = Array.isArray(r.items) ? r.items : [];
    // 사라진 공고의 선택은 버린다
    var keep = {}; S.items.forEach(function (it) { if (S.sel[it.campaignId]) keep[it.campaignId] = S.sel[it.campaignId]; }); S.sel = keep;
    S.loadedOnce = true; S.lastFetch = Date.now();
    if (show && !isDismissed() && visibleItems().length) render();
    else if (S.open) render();
    return true;
  }

  /** 1분마다: 1시간이 지난 "다시 묻기"가 있으면 다시 받아 띄운다. 숨긴 탭에서는 쉬었다가 돌아오면 확인. */
  var REFRESH_MS = 15 * 60 * 1000;
  function kstYesterday() { return new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10); }

  function tick() {
    if (!S.api || document.hidden) return;
    // ★ 팝업이 열린 채 자정을 넘기면 그 목록은 지난 날 것이다 → 닫고 새 날짜 목록으로 다시 띄운다(코덱스 리뷰).
    //   고른 선택은 버린다(다른 날의 부족 인원에 적용하지 않게 — 서버도 날짜가 다르면 거절한다).
    if (S.open && S.date && kstYesterday() !== S.date && !S.loading) {
      var ov0 = document.getElementById('spOv'); if (ov0) ov0.remove(); S.open = false; S.sel = {};
      S.loading = true; load(true).then(function () { S.loading = false; }, function () { S.loading = false; }); return;
    }
    if (S.open) return;
    if (S.loading) return;
    // 첫 조회가 실패했으면(배포 직후 서버가 아직 옛 버전 등) 성공할 때까지 1분마다 다시 시도한다(코덱스 리뷰)
    if (!S.loadedOnce) { S.loading = true; load(true).then(function () { S.loading = false; }, function () { S.loading = false; }); return; }
    // ★ 화면을 켜 둔 채 한국 시간 자정을 넘기면 "어제"가 바뀐다 → 새 날짜 목록을 다시 받는다(코덱스 리뷰)
    if (S.date && kstYesterday() !== S.date) { S.loading = true; load(true).then(function () { S.loading = false; }, function () { S.loading = false; }); return; }
    var sn = readSnooze(), now = Date.now(), due = Object.keys(sn).filter(function (k) { return sn[k] <= now; });
    // ★ 고를 게 없어도 15분마다 다시 받는다 — 결제 중 자리가 풀려 새로 물을 공고가 생길 수 있다(코덱스 리뷰).
    //   ✕로 닫은 날은 다시 띄우지 않는다(load 안에서 isDismissed 확인).
    if (!due.length) {
      if (now - (S.lastFetch || 0) < REFRESH_MS) return;
      S.loading = true; load(true).then(function () { S.loading = false; }, function () { S.loading = false; }); return;
    }
    S.loading = true;
    load(true).then(function (ok) {
      S.loading = false;
      if (!ok) return;   // 실패면 표시를 남겨 다음 1분에 다시 시도
      var cur = readSnooze(); due.forEach(function (k) { if (cur[k] <= Date.now()) delete cur[k]; }); writeSnooze(cur);
    }, function () { S.loading = false; });
  }

  function start(opts) {
    if (!opts || typeof opts.api !== 'function') return;
    S.gen++; S.loading = false; S.loadedOnce = false; S.api = opts.api; S.name = String(opts.name || '');
    injectStyles();
    load(true);
    if (S.timer) clearInterval(S.timer);
    S.timer = setInterval(tick, POLL_MS);
    if (!S.visBound) { S.visBound = true; document.addEventListener('visibilitychange', function () { if (!document.hidden && S.api) tick(); }); }
  }
  function stop() {
    S.gen++; S.loading = false; S.loadedOnce = false;
    if (S.timer) clearInterval(S.timer); S.timer = null;
    // ★ ✕ 닫기는 "이번 로그인 동안만" — 로그아웃하면 지운다(같은 탭에서 다시 로그인하면 다시 묻는다)
    try { Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('wd_shortage_dismiss_v1_') === 0) sessionStorage.removeItem(k); }); } catch (_) { /* noop */ }
    var msg = document.getElementById('spMsg'); if (msg) msg.remove();
    var ov = document.getElementById('spOv'); if (ov) ov.remove();
    S.items = []; S.sel = {}; S.open = false; S.api = null;
  }

  window.ShortagePrompt = { start: start, stop: stop, _state: S, _render: render };
  // ★ 화면이 이 파일보다 먼저 시작을 요청했으면(새로고침·SSO 자동 로그인 — 코덱스 리뷰) 여기서 이어 시작한다
  if (window.__SHORTAGE_PENDING) { var p = window.__SHORTAGE_PENDING; window.__SHORTAGE_PENDING = null; start(p); }
})();
