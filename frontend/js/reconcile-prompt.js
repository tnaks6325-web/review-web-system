/**
 * reconcile-prompt.js — 오더·공고 값이 다른 작업 담당자 팝업 (결정 284 · 사용자 확정 2026-10-23 「1.가 2.좋다」)
 *
 * 인트라넷 리뷰오더와 리뷰웹 모집공고의 값이 서로 달라 아직 양방향으로 연결되지 않은 작업을, 그 작업의 **담당자**(작업오더 작업담당)가
 * 리뷰웹 작업보드를 열 때 묻는다. 한 번에 한 작업 · 고르면 끝까지 해 보고(dryRun) 바뀌는 내용을 보여 준 뒤 [맞추고 연결].
 *   [공고대로 맞추기] — 리뷰어 화면(모집공고)은 그대로 · 리뷰오더(작업오더)를 공고 값으로
 *   [오더대로 맞추기] — 모집공고를 리뷰오더 값으로(리뷰어 화면이 바뀐다)
 *   [칸마다 고르기]   — 「오더·공고 맞추기」 화면을 이 작업이 펼쳐진 채로 연다
 *   [따로 두기]       — 맞추지 않고 지금처럼 따로 둔다 · 다시 묻지 않는다(서버 표시 — 맞추기 화면에서는 그대로 보인다)
 *   [나중에]          — 오늘은 이 작업을 다시 묻지 않는다(이 브라우저 · 날이 바뀌면 다시)
 *
 * ★ 판정·쓰기는 전부 서버 — 목록 = GET /api/trackb/bidir/reconcile(맞추기 화면과 같은 응답) · 맞추기 = 같은 POST(맞추기 화면과 같은 길) ·
 *   따로 두기 = POST …/skip. 화면은 그리기와 누른 것 전달만(사본 0). 칸마다 어느 쪽을 고를 수 있는지도 서버 판정(campaignSide·orderSide)을 그대로 쓴다.
 * ★ 담당자 = 작업오더 work_manager · 이름 비교는 작업보드 표기 함수(_pmManagerName — 박은비→망고 등)로 양쪽을 같은 모양으로.
 * ★ 관리자 이상만(맞추기 API 와 같은 문 — 눌러도 안 되는 사람에게는 띄우지 않는다).
 * ★ 가격 신고(9545)·품절(9550) 팝업보다 아래(9540) — 둘이 더 급하다. 팝업은 body 직속 · onclick 문자열 보간 없음(이벤트 위임).
 */
(function () {
  'use strict';
  var BASE = '/api/trackb/bidir/reconcile';
  var POLL_MS = 30 * 60 * 1000;
  var MAX_ROWS = 8;
  var S = { api: null, name: '', items: [], gen: 0, timer: null, busy: false, cur: null, choice: null, preview: null, err: '' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function laterKey() { return 'wd_rcask_later_v1_' + S.name; }
  function readJson(k) { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (_) { return {}; } }
  function writeJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* noop */ } }
  function mgr(s) { var v = String(s == null ? '' : s).trim(); try { if (typeof window._pmManagerName === 'function') return String(window._pmManagerName(v) || '').trim(); } catch (_) { /* noop */ } return v; }

  function pickable(it) { return (it.fields || []).filter(function (f) { return !f.derived; }); }
  function sideOk(f, side) { return side === 'campaign' ? !!(f.campaignSide && f.campaignSide.ok) : !(f.orderSide && f.orderSide.ok === false); }
  /** 한쪽으로 전부 맞출 수 있나 — 못 고르는 칸이 하나라도 있으면 그 이유(서버 판정 문구). 고를 칸이 없는(합계만 다른) 작업은 오더 쪽만. */
  function sideBlock(it, side) {
    var ps = pickable(it);
    if (!ps.length) return side === 'campaign' ? '이 작업은 옵션별 값이 같고 합계만 달라 공고 쪽으로 고를 칸이 없습니다' : '';
    for (var i = 0; i < ps.length; i++) {
      if (!sideOk(ps[i], side)) {
        var r = side === 'campaign' ? ps[i].campaignSide : ps[i].orderSide;
        return ps[i].label + ' — ' + ((r && r.reason) || (side === 'campaign' ? '공고 쪽으로 맞출 수 없는 칸입니다' : '오더 쪽으로 맞출 수 없는 칸입니다'));
      }
    }
    return '';
  }
  function picksFor(it, side) { var p = {}; pickable(it).forEach(function (f) { p[f.id] = side; }); return p; }

  /** 내가 물어볼 작업 — 내 담당 · 따로 두기 아님 · 막힌 작업 아님 · 오늘 「나중에」 아님 */
  function mine() {
    var me = mgr(S.name), later = readJson(laterKey()), d = today();
    if (!me) return [];
    return (S.items || []).filter(function (it) {
      return it && !it.skipped && !it.blocked && (it.fields || []).length
        && (mgr(it.workManager) === me || String(it.workManager || '').trim() === String(S.name).trim())
        && later[it.workOrderId] !== d;
    });
  }

  function injectStyles() {
    if (document.getElementById('rcAskStyles')) return;
    var st = document.createElement('style');
    st.id = 'rcAskStyles';
    st.textContent = [
      '#rcAskOv{position:fixed;inset:0;z-index:9540;background:rgba(20,26,40,.42);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}',
      '#rcAskOv *{box-sizing:border-box}',
      '#rcAskOv .ra-box{width:min(640px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#fff;color:#1d2433;border-radius:14px;border:1px solid #dfe3ea;font-family:inherit}',
      '#rcAskOv .ra-hd{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:16px 18px 6px}',
      '#rcAskOv .ra-hd h2{font-size:1.05rem;margin:0}',
      '#rcAskOv .ra-n{font-size:.76rem;color:#5b6478;font-weight:700;white-space:nowrap}',
      '#rcAskOv .ra-lead{margin:0 18px 10px;color:#5b6478;font-size:.84rem;line-height:1.55}',
      '#rcAskOv .ra-body{overflow:auto;min-height:0;padding:0 18px 12px;display:grid;gap:12px}',
      '#rcAskOv .ra-job{border:1px solid #dfe3ea;border-radius:10px;padding:12px;display:grid;gap:4px}',
      '#rcAskOv .ra-job b{font-size:.95rem;overflow-wrap:anywhere}',
      '#rcAskOv .ra-meta{color:#5b6478;font-size:.8rem}',
      '#rcAskOv .ra-tw{overflow-x:auto;border:1px solid #dfe3ea;border-radius:10px}',
      '#rcAskOv table{border-collapse:collapse;width:100%;min-width:460px;font-size:.82rem}',
      '#rcAskOv th,#rcAskOv td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f4;vertical-align:top;overflow-wrap:anywhere}',
      '#rcAskOv tr:last-child td{border-bottom:0}',
      '#rcAskOv th{color:#5b6478;font-weight:700;font-size:.74rem;background:#f7f8fa}',
      '#rcAskOv td.v{font-weight:700;font-variant-numeric:tabular-nums}',
      '#rcAskOv .ra-more{color:#5b6478;font-size:.78rem;padding:6px 10px}',
      '#rcAskOv .ra-choices{display:grid;gap:8px}',
      '#rcAskOv .ra-choice{font:inherit;text-align:left;width:100%;display:grid;grid-template-columns:minmax(0,1fr) 22px;gap:4px 10px;align-items:center;border:1px solid #dfe3ea;border-radius:10px;background:#fff;color:#1d2433;padding:11px 12px;cursor:pointer}',
      '#rcAskOv .ra-choice b{font-size:.9rem}',
      '#rcAskOv .ra-choice span{grid-column:1;color:#5b6478;font-size:.78rem}',
      '#rcAskOv .ra-choice i{grid-row:1/span 2;grid-column:2;width:22px;height:22px;border-radius:999px;border:1.5px solid #c9cfda;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:.75rem;color:#fff}',
      '#rcAskOv .ra-choice.on{border-color:#2f5bd3;background:#eef3fe}',
      '#rcAskOv .ra-choice.on i{background:#2f5bd3;border-color:#2f5bd3}',
      '#rcAskOv .ra-choice:disabled{cursor:not-allowed;opacity:.55;background:#f7f8fa}',
      '#rcAskOv .ra-choice:focus-visible,#rcAskOv .ra-b:focus-visible{outline:2px solid #2f5bd3;outline-offset:2px}',
      '#rcAskOv .ra-why{color:#b5620b !important}',
      '#rcAskOv .ra-prev{border:1px solid #dfe3ea;border-radius:10px;padding:10px 12px;background:#f7f8fa}',
      '#rcAskOv .ra-prev ul{margin:6px 0 0;padding-left:18px;line-height:1.7;font-size:.84rem}',
      '#rcAskOv .ra-err{color:#b3382e;font-size:.82rem;font-weight:700}',
      '#rcAskOv .ra-ft{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:12px 18px;border-top:1px solid #dfe3ea}',
      '#rcAskOv .ra-ft .ra-l,#rcAskOv .ra-ft .ra-r{display:flex;gap:6px;flex-wrap:wrap}',
      '#rcAskOv .ra-b{font:inherit;font-size:.8rem;border-radius:9px;border:1px solid #dfe3ea;background:#fff;color:#1d2433;padding:7px 11px;cursor:pointer}',
      '#rcAskOv .ra-b.pri{border-color:#2f5bd3;background:#2f5bd3;color:#fff;font-weight:700}',
      '#rcAskOv .ra-b.quiet{border-color:transparent;color:#5b6478}',
      '#rcAskOv .ra-b:disabled{opacity:.45;cursor:not-allowed}',
      '#rcAskMsg{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9600;pointer-events:none;background:#1d2433;color:#fff;border-radius:14px;padding:16px 22px;display:grid;gap:6px;text-align:center;max-width:calc(100vw - 32px);box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:inherit}',
      '#rcAskMsg b{font-size:1.05rem}#rcAskMsg span{font-size:.82rem;opacity:.85}#rcAskMsg .bad{color:#ffb4a8;opacity:1}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function message(title, sub, bad) {
    var old = document.getElementById('rcAskMsg'); if (old) old.remove();
    var m = document.createElement('div'); m.id = 'rcAskMsg'; m.setAttribute('role', 'status');
    m.innerHTML = '<b>' + esc(title) + '</b>' + (sub ? '<span class="' + (bad ? 'bad' : '') + '">' + esc(sub) + '</span>' : '');
    document.body.appendChild(m);
    setTimeout(function () { if (m.parentNode) m.remove(); }, 3400);
  }

  function diffTable(it) {
    var fs = it.fields || [];
    var rows = fs.slice(0, MAX_ROWS).map(function (f) {
      return '<tr><td>' + esc(f.label) + (f.derived ? '<div class="ra-meta">옵션별 값을 따라 맞춰집니다</div>' : '') + '</td>' +
        '<td class="v">' + esc(f.orderText != null ? f.orderText : f.order) + '</td><td class="v">' + esc(f.campaignText != null ? f.campaignText : f.campaign) + '</td></tr>';
    }).join('');
    return '<div class="ra-tw"><table><thead><tr><th>다른 칸</th><th>인트라넷 리뷰오더</th><th>모집공고 (리뷰어 화면)</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      (fs.length > MAX_ROWS ? '<div class="ra-more">… 외 ' + (fs.length - MAX_ROWS) + '칸 — [칸마다 고르기]에서 전부 볼 수 있어요</div>' : '') + '</div>';
  }

  function choiceHtml(it, side) {
    var why = sideBlock(it, side), on = S.choice === side;
    var title = side === 'campaign' ? '공고대로 맞추기' : '오더대로 맞추기';
    var sub = side === 'campaign' ? '리뷰어가 보는 모집공고는 그대로 두고, 리뷰오더를 공고 값으로 바꿉니다'
      : '모집공고를 리뷰오더 값으로 바꿉니다 — 리뷰어가 보는 화면이 바뀝니다';
    return '<button type="button" class="ra-choice' + (on ? ' on' : '') + '" data-c="' + side + '" aria-pressed="' + on + '"' + (why || S.busy ? ' disabled' : '') + '>' +
      '<b>' + title + '</b><i aria-hidden="true">' + (on ? '✓' : '') + '</i><span' + (why ? ' class="ra-why"' : '') + '>' + esc(why ? '고를 수 없어요 · ' + why : sub) + '</span></button>';
  }

  function previewHtml(it) {
    var side = S.choice, lines = (it.fields || []).map(function (f) {
      var o = f.orderText != null ? f.orderText : f.order, c = f.campaignText != null ? f.campaignText : f.campaign;
      return side === 'campaign' ? '<li><b>리뷰오더</b> ' + esc(f.label) + ': ' + esc(o) + ' → ' + esc(c) + '</li>'
        : '<li><b>모집공고</b> ' + esc(f.label) + ': ' + esc(c) + ' → ' + esc(o) + '</li>';
    }).join('');
    var closed = (S.preview && S.preview.closed_options) || [];
    return '<div class="ra-prev"><b>이렇게 바뀝니다</b> — 끝까지 해 보고 되돌린 결과예요. [맞추고 연결]을 눌러야 실제로 바뀝니다.<ul>' + lines + '</ul>' +
      (closed.length ? '<div class="ra-meta" style="color:#8a5a00">이미 참여한 분이 있어 지우지 않고 마감으로 남깁니다: ' + esc(closed.map(function (c) { return [c.pName, c.oLabel].filter(Boolean).join(' / ') + ' (' + c.used + '명)'; }).join(', ')) + '</div>' : '') +
      (side === 'campaign' ? '<div class="ra-meta">인트라넷 리뷰오더 목록에는 리뷰웹 → 인트라넷 보내기를 켜면 반영됩니다(수정 창은 지금도 리뷰웹 값으로 열려요).</div>' : '') + '</div>';
  }

  function render() {
    var list = mine(), ov = document.getElementById('rcAskOv');
    if (!list.length) { if (ov) ov.remove(); S.cur = null; return; }
    var it = list.find(function (x) { return S.cur && x.workOrderId === S.cur.workOrderId; }) || list[0];
    if (!S.cur || S.cur.workOrderId !== it.workOrderId || S.cur.fingerprint !== it.fingerprint) { S.choice = null; S.preview = null; S.err = ''; }
    S.cur = it;
    if (!ov) { ov = document.createElement('div'); ov.id = 'rcAskOv'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'rcAskTitle'); document.body.appendChild(ov); bind(ov); }
    var meta = [it.workManager ? '담당 ' + mgr(it.workManager) : '', it.joined != null ? '지금까지 참여 ' + it.joined + '명' : '', it.campaignTitle && it.campaignTitle !== it.title ? '공고 「' + it.campaignTitle + '」' : ''].filter(Boolean).join(' · ');
    var dis = S.busy ? ' disabled' : '';
    var foot = S.preview
      ? '<div class="ra-r"><button type="button" class="ra-b" data-a="back"' + dis + '>뒤로</button><button type="button" class="ra-b pri" data-a="commit"' + dis + '>' + (S.busy ? '맞추는 중…' : '맞추고 연결') + '</button></div>'
      : '<div class="ra-r"><button type="button" class="ra-b" data-a="later"' + dis + '>나중에</button><button type="button" class="ra-b pri" data-a="try"' + (S.choice && !S.busy ? '' : ' disabled') + '>' + (S.busy ? '확인하는 중…' : '바뀌는 내용 보기') + '</button></div>';
    ov.innerHTML = '<div class="ra-box"><div class="ra-hd"><h2 id="rcAskTitle">오더와 공고 값이 다른 작업이 있어요</h2><span class="ra-n">' + (list.length > 1 ? '1 / ' + list.length : '') + '</span></div>' +
      '<p class="ra-lead">인트라넷 리뷰오더와 리뷰웹 모집공고의 값이 서로 달라 아직 연결되지 않은 작업이에요. 어느 쪽 값을 남길지 골라 주세요. 맞춘 뒤에는 한쪽을 고치면 다른 쪽도 따라 바뀝니다.</p>' +
      '<div class="ra-body"><div class="ra-job"><b>' + esc(it.title || it.workOrderId) + '</b>' + (meta ? '<span class="ra-meta">' + esc(meta) + '</span>' : '') + '</div>' +
      diffTable(it) +
      (S.preview ? previewHtml(it) : '<div class="ra-choices" role="group" aria-label="남길 쪽">' + choiceHtml(it, 'campaign') + choiceHtml(it, 'order') + '</div>') +
      (S.err ? '<div class="ra-err" role="alert">' + esc(S.err) + '</div>' : '') + '</div>' +
      '<div class="ra-ft"><div class="ra-l"><button type="button" class="ra-b quiet" data-a="detail"' + dis + '>칸마다 고르기</button><button type="button" class="ra-b quiet" data-a="skip"' + dis + '>따로 두기 — 묻지 않기</button></div>' + foot + '</div></div>';
  }

  function bind(ov) {
    ov.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t || t.disabled || !S.cur) return;
      var c = t.getAttribute('data-c');
      if (c) { S.choice = c; S.err = ''; render(); return; }
      var a = t.getAttribute('data-a');
      if (a === 'later') { var l = readJson(laterKey()); l[S.cur.workOrderId] = today(); writeJson(laterKey(), l); S.cur = null; render(); return; }
      if (a === 'back') { S.preview = null; S.err = ''; render(); return; }
      if (a === 'detail') { openDetail(S.cur); return; }
      if (a === 'skip') { skip(S.cur); return; }
      if (a === 'try') { tryChoice(S.cur); return; }
      if (a === 'commit') { commit(S.cur); }
    });
  }

  /** 「오더·공고 맞추기」 화면을 이 작업이 펼쳐진 채로 — 이 팝업은 오늘 이 작업을 다시 묻지 않는다(화면에서 고르는 중) */
  function openDetail(it) {
    var l = readJson(laterKey()); l[it.workOrderId] = today(); writeJson(laterKey(), l);
    var ov = document.getElementById('rcAskOv'); if (ov) ov.remove();
    S.cur = null;
    try {
      if (typeof window.switchView === 'function') window.switchView('orders');
      if (typeof window._rcState === 'function') { var st = window._rcState(); st.open = it.workOrderId; st.mgr = ''; st.q = ''; }
      if (typeof window._rcOpen === 'function') window._rcOpen();
    } catch (_) { /* noop */ }
  }

  async function post(it, body) {
    return S.api(BASE + '/' + encodeURIComponent(it.workOrderId), { method: 'POST', body: JSON.stringify(body) });
  }

  async function tryChoice(it) {
    if (S.busy || !S.choice) return;
    S.busy = true; S.err = ''; render();
    var gen = S.gen;
    try {
      var j = await post(it, { picks: picksFor(it, S.choice), fingerprint: it.fingerprint, dryRun: true });
      if (gen !== S.gen) return;
      if (!j || !j.ok) { S.err = '맞출 수 없어요 — ' + ((j && j.error) || '서버가 처리하지 못했습니다'); if (j && j.code === 'reconcile_stale') { S.busy = false; await load(); return; } }
      else S.preview = j;
    } catch (e) { S.err = '확인하지 못했어요 — ' + ((e && e.message) || ''); }
    finally { if (gen === S.gen) { S.busy = false; render(); } }
  }

  async function commit(it) {
    if (S.busy || !S.choice || !S.preview) return;
    S.busy = true; S.err = ''; render();
    var gen = S.gen;
    try {
      var j = await post(it, { picks: picksFor(it, S.choice), fingerprint: it.fingerprint, opId: 'rcask-' + it.workOrderId + '-' + it.fingerprint });
      if (gen !== S.gen) return;
      if (!j || !j.ok) { S.err = '맞추지 못했어요 — ' + ((j && j.error) || '서버가 처리하지 못했습니다'); S.preview = null; }
      else { message('맞추고 연결했어요', it.title || '', false); S.cur = null; S.choice = null; S.preview = null; refreshScreen(); }
    } catch (e) { S.err = '맞추지 못했어요 — ' + ((e && e.message) || ''); }
    finally { if (gen === S.gen) { S.busy = false; await load(); } }
  }

  async function skip(it) {
    if (S.busy) return;
    S.busy = true; S.err = ''; render();
    var gen = S.gen;
    try {
      var j = await S.api(BASE + '/' + encodeURIComponent(it.workOrderId) + '/skip', { method: 'POST', body: JSON.stringify({ skip: true }) });
      if (gen !== S.gen) return;
      if (!j || !j.ok) S.err = '따로 두지 못했어요 — ' + ((j && j.error) || '서버가 아직 이 기능을 모릅니다(배포 중일 수 있어요)');
      else { message('따로 두었어요', '이 작업은 더 묻지 않아요 · 「오더·공고 맞추기」에서 언제든 맞출 수 있어요', false); S.cur = null; refreshScreen(); }
    } catch (e) { S.err = '따로 두지 못했어요 — ' + ((e && e.message) || ''); }
    finally { if (gen === S.gen) { S.busy = false; await load(); } }
  }

  /** 맞추기 화면이 열려 있으면 같이 새로 읽는다(같은 목록 · 숫자 배지) */
  function refreshScreen() { try { if (typeof window._rcLoad === 'function') window._rcLoad(); } catch (_) { /* noop */ } }

  async function load() {
    if (!S.api) return false;
    var gen = S.gen;
    try {
      var j = await S.api(BASE);
      if (gen !== S.gen) return false;
      if (!j || !j.ok) return false;   // 못 읽으면 묻지 않는다(값·연결은 그대로 — 화면을 막지 않는다)
      S.items = j.items || [];
      if (!S.busy) render();
      return true;
    } catch (_) { return false; }
  }

  function start(opts) {
    if (!opts || typeof opts.api !== 'function') return;
    if (!(opts.role === 'admin' || opts.role === 'master')) return;   // 맞추기 API 와 같은 문
    S.gen++; S.api = opts.api; S.name = String(opts.name || ''); S.cur = null; S.choice = null; S.preview = null; S.err = '';
    injectStyles();
    load();
    if (S.timer) clearInterval(S.timer);
    S.timer = setInterval(function () { if (!S.busy && !document.getElementById('rcAskOv')) load(); }, POLL_MS);
  }
  function stop() {
    S.gen++;
    if (S.timer) clearInterval(S.timer); S.timer = null;
    var m = document.getElementById('rcAskMsg'); if (m) m.remove();
    var ov = document.getElementById('rcAskOv'); if (ov) ov.remove();
    S.items = []; S.api = null; S.busy = false; S.cur = null; S.choice = null; S.preview = null; S.err = '';
  }

  window.ReconcilePrompt = { start: start, stop: stop, refresh: load, _state: S, _mine: mine, _sideBlock: sideBlock, _picksFor: picksFor };
  if (window.__RCASK_PENDING) { var p = window.__RCASK_PENDING; window.__RCASK_PENDING = null; start(p); }
})();
