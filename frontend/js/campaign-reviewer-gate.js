/* ══════════════════════════════════════════════════════════════════════════
   campaign-reviewer-gate.js — 모집공고별 참여가능 리뷰어 관리(블랙리스트 건별) 공유 모달
   (migration 091 · 시안 frontend/docs/design-campaign-reviewer-gate.html)

   관리자 대시보드(admin.html)·리뷰웹시스템[3버전](workdesk.html)이 **이 한 벌**을 쓴다
   (모달 사본을 두면 두 화면이 계속 어긋난다 — recruit-modal.js와 같은 규율).

   ★ 2000여명 전체 로드 금지: 기본 화면 = 이 공고의 예외 목록(저장된 행만),
     나머지는 검색(이름/전화 뒤4자리/계좌번호)으로만 부른다(서버 LIMIT 50).
   ★ 체크박스 = 참여가능 / 해제 = 이 공고 참여불가(deny-list). 변경된 사람만 저장.
   ★ onclick 에는 배열 인덱스만 넘긴다 — 리뷰어 이름은 외부 문자열(XSS 규율).
   ★ 경로는 /api/trackb/* 하나 — admin_token·인트라넷 SSO 양쪽에서 그대로 닿는다
     (호스트별 재기준 불필요, 리뷰타입 정리와 같은 판단).
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var EP = '/api/trackb/campaigns/';           // + <id>/reviewer-gate[...]
  var S = { campId: null, title: '', items: [], staged: {}, data: null, msgType: 'closed', histOpen: false };

  function _apiBase() {
    return (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) ? API_BASE_URL : '';
  }
  function _headers() {
    var token = sessionStorage.getItem('admin_token') || localStorage.getItem('admin_token');
    var h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }
  function _esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  async function _get(path) {
    var r = await fetch(_apiBase() + path, { headers: _headers() });
    var j = await r.json().catch(function () { return null; });
    if (!j) throw new Error('HTTP ' + r.status);
    return j;
  }
  async function _post(path, body) {
    var r = await fetch(_apiBase() + path, { method: 'POST', headers: _headers(), body: JSON.stringify(body || {}) });
    var j = await r.json().catch(function () { return null; });
    if (!j) throw new Error('HTTP ' + r.status);
    return j;
  }

  /* ── 마운트(항상 body 직속 — 뷰 스크롤 컨테이너에 넣으면 오버레이가 흐름에 섞인다) ── */
  var CSS = ''
    + '#rgModal{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.55)}'
    + '#rgModal .rg-box{background:var(--card,#fff);color:var(--t1,#1f2937);width:min(960px,94vw);max-height:92vh;display:flex;flex-direction:column;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.28);overflow:hidden}'
    + '#rgModal .rg-hd{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--border,#e5e7eb);background:var(--bg2,#f9fafb);font-weight:800;font-size:.85rem}'
    + '#rgModal .rg-x{margin-left:auto;border:0;background:none;font-size:1.05rem;cursor:pointer;color:var(--t3,#9ca3af)}'
    + '#rgModal .rg-bd{padding:14px 18px;overflow:auto;font-size:.8rem}'
    + '#rgModal .rg-sum{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}'
    + '#rgModal .rg-cell{background:var(--bg2,#f9fafb);border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:6px 12px;font-size:.68rem;color:var(--t3,#6b7280)}'
    + '#rgModal .rg-cell b{display:block;font-size:.95rem;color:var(--t1,#111827)}'
    + '#rgModal .rg-cell.red b{color:#dc2626}'
    + '#rgModal .rg-srch{display:flex;gap:8px;margin-bottom:10px}'
    + '#rgModal .rg-srch input{flex:1;border:1px solid var(--border,#d1d5db);border-radius:8px;padding:8px 12px;font-size:.78rem;background:var(--card,#fff);color:var(--t1,#111827)}'
    + '#rgModal .rg-btn{border:1px solid var(--border,#d1d5db);background:var(--card,#fff);color:var(--t1,#374151);border-radius:8px;padding:7px 13px;font-size:.74rem;font-weight:700;cursor:pointer}'
    + '#rgModal .rg-btn.pri{background:#10b981;border-color:#10b981;color:#fff}'
    + '#rgModal .rg-btn[disabled]{opacity:.45;cursor:default}'
    + '#rgModal table{width:100%;border-collapse:collapse;font-size:.76rem}'
    + '#rgModal th{background:var(--bg2,#f9fafb);color:var(--t3,#6b7280);font-size:.66rem;text-align:left;padding:7px 8px;border-bottom:2px solid var(--border,#e5e7eb);white-space:nowrap}'
    + '#rgModal td{padding:8px;border-bottom:1px solid var(--border,#f1f5f9);vertical-align:middle}'
    + '#rgModal tr.rg-off td{background:rgba(254,226,226,.35)}'
    + '#rgModal .rg-bdg{display:inline-block;border-radius:6px;padding:2px 7px;font-size:.62rem;font-weight:800}'
    + '#rgModal .rg-ok{background:#dcfce7;color:#15803d}#rgModal .rg-blk{background:#fee2e2;color:#b91c1c}'
    + '#rgModal .rg-gbl{background:#111827;color:#fff}#rgModal .rg-wr{background:#fef3c7;color:#b45309}'
    + '#rgModal .rg-gr{background:#f3f4f6;color:#6b7280}'
    + '#rgModal .rg-split{display:flex;gap:14px;align-items:flex-start}'
    + '#rgModal .rg-l{flex:1.8;min-width:0}#rgModal .rg-r{flex:1;min-width:230px}'
    + '#rgModal .rg-panel{background:var(--bg2,#f9fafb);border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:10px 12px;margin-bottom:10px}'
    + '#rgModal .rg-radio{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1.5px solid var(--border,#e5e7eb);border-radius:8px;margin-bottom:8px;background:var(--card,#fff);cursor:pointer}'
    + '#rgModal .rg-radio.on{border-color:#10b981;background:rgba(240,253,244,.7)}'
    + '#rgModal .rg-radio b{display:block;font-size:.74rem}#rgModal .rg-radio small{color:var(--t3,#6b7280);font-size:.66rem;line-height:1.45}'
    + '#rgModal .rg-note{font-size:.66rem;color:var(--t3,#9ca3af);margin-top:6px;line-height:1.5}';

  function _mount() {
    if (document.getElementById('rgModal')) return;
    if (!document.getElementById('rgModalCss')) {
      var st = document.createElement('style'); st.id = 'rgModalCss'; st.textContent = CSS;
      document.head.appendChild(st);
    }
    var d = document.createElement('div');
    d.id = 'rgModal'; d.style.display = 'none';
    d.innerHTML = '<div class="rg-box"><div class="rg-hd">🚫 <span id="rgTitle"></span>'
      + '<button type="button" class="rg-x" onclick="ReviewerGate.close()">✕</button></div>'
      + '<div class="rg-bd" id="rgBody"></div></div>';
    d.addEventListener('click', function (e) { if (e.target === d) close(); });
    document.body.appendChild(d);
  }

  /* ── 열기/닫기 ── */
  async function open(campId, title) {
    _mount();
    S.campId = campId;
    S.title = title || (window._recruitCardTitles && window._recruitCardTitles[campId]) || campId;
    S.items = []; S.staged = {}; S.data = null; S.msgType = 'closed'; S.histOpen = false;
    document.getElementById('rgTitle').textContent = '참여 리뷰어 관리 — ' + S.title;
    document.getElementById('rgModal').style.display = 'flex';
    document.getElementById('rgBody').innerHTML = '<div style="padding:30px;text-align:center;color:#9ca3af">불러오는 중…</div>';
    try {
      var j = await _get(EP + encodeURIComponent(campId) + '/reviewer-gate');
      if (!j.ok) throw new Error(j.error || '조회 실패');
      S.data = j;
      // 기본 화면 = 저장된 예외만 표에 올린다(전체 리뷰어 미로드)
      S.items = (j.blocks || []).concat(j.allows || []).map(function (r) {
        return { name: r.reviewer_name || '', phone8: r.phone8, phoneMasked: '***-' + String(r.phone8 || '').slice(-4),
                 accountTail: '', inGlobalBlacklist: false,
                 gate: { mode: r.mode, messageType: r.message_type }, history: null };
      });
      render();
    } catch (e) {
      // ★ 로딩 자리표시자를 깐 화면은 어떤 예외에도 종결시킨다(무한로딩 금지)
      document.getElementById('rgBody').innerHTML =
        '<div style="padding:24px;text-align:center;color:#b91c1c">' + _esc(e.message || '불러오지 못했습니다')
        + '<br><br><button type="button" class="rg-btn" onclick="ReviewerGate.open(\'' + _esc(campId) + '\')">다시 시도</button></div>';
    }
  }
  function close() {
    var d = document.getElementById('rgModal');
    if (d) d.style.display = 'none';
  }

  /* ── 상태 계산: 체크 = 참여가능 ── */
  function _isChecked(it) {
    var st = S.staged[it.phone8];
    if (st) return st.mode !== 'block';
    return !(it.gate && it.gate.mode === 'block');
  }
  function _stagedCount() { return Object.keys(S.staged).length; }

  function _rowBadges(it) {
    var st = S.staged[it.phone8];
    var mode = st ? st.mode : (it.gate && it.gate.mode) || '';
    var mt = st ? st.messageType : (it.gate && (it.gate.messageType || it.gate.message_type)) || '';
    var out = '';
    if (mode === 'block') out += '<span class="rg-bdg rg-blk">차단' + (mt === 'policy' ? ' · 사유 고지' : ' · 마감 위장') + (st ? ' (변경)' : '') + '</span>';
    else if (mode === 'allow') out += '<span class="rg-bdg rg-ok">허용 예외' + (st ? ' (변경)' : '') + '</span>';
    else if (st && st.mode === 'clear') out += '<span class="rg-bdg rg-gr">기본으로 되돌림</span>';
    else out += '<span class="rg-bdg rg-gr">기본(참여가능)</span>';
    return out;
  }

  /* ── 렌더 ── */
  function render() {
    var d = S.data || {};
    var counts = d.counts || { block: 0, allow: 0 };
    var rows = S.items.map(function (it, i) {
      var checked = _isChecked(it);
      var hist = it.history
        ? '<span style="' + (it.history.level === 'bad' ? 'color:#dc2626;font-weight:700' : it.history.level === 'warn' ? 'color:#b45309;font-weight:700' : it.history.level === 'unknown' ? 'color:#9ca3af' : '') + '">' + _esc(it.history.label) + '</span>'
        : '<span style="color:#c4c9d4">—</span>';
      return '<tr class="' + (checked ? '' : 'rg-off') + '">'
        + '<td><input type="checkbox" ' + (checked ? 'checked' : '') + ' onclick="ReviewerGate._toggle(' + i + ')"></td>'
        + '<td><b>' + _esc(it.name || '(이름 없음)') + '</b></td>'
        + '<td>' + _esc(it.phoneMasked || '') + '</td>'
        + '<td>' + _esc(it.accountTail || '') + '</td>'
        + '<td>' + hist + '</td>'
        + '<td>' + (it.inGlobalBlacklist ? '<span class="rg-bdg rg-gbl">블랙리스트</span>' : '<span class="rg-bdg rg-ok">정상</span>') + '</td>'
        + '<td>' + _rowBadges(it) + '</td></tr>';
    }).join('');

    var histRows = (d.history || []).slice(0, 100).map(function (r) {
      var when = r.created_at ? new Date(r.created_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      var what = r.released_at
        ? (r.mode === 'block' ? '차단 해제' : '허용 해제')
        : (r.mode === 'block' ? '차단 (' + (r.message_type === 'policy' ? '사유 고지' : '마감 위장') + ')' : '허용 예외');
      return '<tr><td>' + _esc(when) + '</td><td>' + _esc(r.reviewer_name || '') + ' (***-' + _esc(String(r.phone8 || '').slice(-4)) + ')</td>'
        + '<td>' + _esc(what) + '</td><td>' + _esc(r.released_at ? (r.released_by || '') : (r.created_by || '')) + '</td></tr>';
    }).join('');

    document.getElementById('rgBody').innerHTML =
      '<div class="rg-sum">'
      + '<div class="rg-cell">기본 상태<b style="color:#15803d">전원 참여가능</b>차단한 사람만 예외 저장</div>'
      + '<div class="rg-cell red">이 공고 차단<b>' + (counts.block | 0) + '명</b></div>'
      + '<div class="rg-cell">허용 예외<b>' + (counts.allow | 0) + '명</b>블랙리스트지만 이 공고는 허용</div>'
      + '<div class="rg-cell" style="margin-left:auto"><button type="button" class="rg-btn" onclick="ReviewerGate._csv()">⬇ 예외 목록 CSV</button></div>'
      + '</div>'
      + '<div class="rg-srch"><input id="rgQ" placeholder="이름 / 전화번호 뒤 4자리 / 등록 계좌번호 검색 (검색된 사람만 표에 추가됩니다)" onkeydown="if(event.key===\'Enter\')ReviewerGate._search()">'
      + '<button type="button" class="rg-btn" onclick="ReviewerGate._search()">🔍 검색</button></div>'
      + '<div class="rg-split"><div class="rg-l">'
      + '<table><tr><th style="width:30px">✓</th><th>이름</th><th>연락처</th><th>계좌</th><th>이전 리뷰</th><th>전역 상태</th><th>이 공고</th></tr>'
      + (rows || '<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:18px">예외 없음 — 검색으로 리뷰어를 찾아 체크를 해제하면 이 공고에서 차단됩니다</td></tr>')
      + '</table>'
      + '<div class="rg-note" id="rgMore"></div>'
      + '<div class="rg-note">체크 = 참여가능 / 해제 = 이 공고 참여불가 · <b>변경된 사람만 저장</b>됩니다. 차단은 새 참여 신청만 막고, 이미 잡힌 자리·제출완료 건은 유지됩니다.</div>'
      + '</div><div class="rg-r">'
      + '<div class="rg-panel"><div style="font-weight:800;font-size:.7rem;margin-bottom:8px">🔔 차단 시 안내 메시지 (이번에 해제한 인원에 적용)</div>'
      + '<div class="rg-radio' + (S.msgType === 'closed' ? ' on' : '') + '" onclick="ReviewerGate._msg(\'closed\')"><span>' + (S.msgType === 'closed' ? '🟢' : '⚪') + '</span><span><b>공고가 마감되었습니다</b><small>마감 위장 — 차단 사실을 드러내지 않습니다. [참여하기] 시점에 실제 마감 화면과 동일하게 보입니다.</small></span></div>'
      + '<div class="rg-radio' + (S.msgType === 'policy' ? ' on' : '') + '" onclick="ReviewerGate._msg(\'policy\')"><span>' + (S.msgType === 'policy' ? '🟢' : '⚪') + '</span><span><b>이전 리뷰 미작성 &amp; 리뷰 기한 경과</b><small>"이전 리뷰 미작성 또는 리뷰 기한 경과로 인해 공고 참여가 불가합니다." — 사유 고지형.</small></span></div></div>'
      + '<div class="rg-panel" style="font-size:.66rem;color:#6b7280;line-height:1.55">블랙리스트 리뷰어도 체크하면 <b>이 공고만 허용</b>됩니다(건별 관리).<br>판정 기준(미작성/기한 경과 일수)은 설정탭 <b>블랙리스트 관리기준</b>에서 바꿉니다.</div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end">'
      + '<button type="button" class="rg-btn" onclick="ReviewerGate.close()">닫기</button>'
      + '<button type="button" class="rg-btn pri" ' + (_stagedCount() ? '' : 'disabled') + ' onclick="ReviewerGate._apply()">선택 적용 (변경 ' + _stagedCount() + '건)</button>'
      + '</div></div></div>'
      + '<div style="margin-top:14px"><button type="button" class="rg-btn" onclick="ReviewerGate._hist()">' + (S.histOpen ? '▾' : '▸') + ' 관리 이력</button>'
      + (S.histOpen ? '<table style="margin-top:8px"><tr><th>일시</th><th>리뷰어</th><th>변경</th><th>처리자</th></tr>' + (histRows || '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:12px">이력 없음</td></tr>') + '</table>' : '')
      + '</div>';
  }

  /* ── 액션(전부 인덱스/내부 상태 기반 — 외부 문자열 onclick 보간 금지) ── */
  function _toggle(i) {
    var it = S.items[i]; if (!it) return;
    var checked = _isChecked(it);
    if (checked) {
      // 참여가능 → 차단 스테이징(현재 선택된 메시지 유형)
      S.staged[it.phone8] = { phone8: it.phone8, name: it.name, mode: 'block', messageType: S.msgType };
    } else {
      var curMode = it.gate && it.gate.mode;
      if (S.staged[it.phone8] && !curMode) delete S.staged[it.phone8];                    // 방금 스테이징한 차단 취소
      else if (it.inGlobalBlacklist) S.staged[it.phone8] = { phone8: it.phone8, name: it.name, mode: 'allow' }; // 블랙리스트 → 건별 허용
      else S.staged[it.phone8] = { phone8: it.phone8, name: it.name, mode: 'clear' };     // 저장된 차단 해제
    }
    render();
  }
  function _msg(t) { S.msgType = t === 'policy' ? 'policy' : 'closed'; render(); }
  function _hist() { S.histOpen = !S.histOpen; render(); }

  async function _search() {
    var q = (document.getElementById('rgQ') || {}).value || '';
    if (!q.trim()) return;
    try {
      var j = await _get(EP + encodeURIComponent(S.campId) + '/reviewer-gate/search?q=' + encodeURIComponent(q));
      if (!j.ok) throw new Error(j.error || '검색 실패');
      // 기존 표에 병합(같은 phone8은 검색 결과로 갱신 — 이력·전역 상태가 더 풍부)
      var byP8 = {};
      S.items.forEach(function (it, i) { byP8[it.phone8] = i; });
      (j.items || []).forEach(function (it) {
        if (byP8[it.phone8] != null) S.items[byP8[it.phone8]] = it;
        else S.items.push(it);
      });
      render();
      var more = document.getElementById('rgMore');
      if (more) more.textContent = j.hasMore ? '⚠ 결과가 50건을 넘습니다 — 검색어를 좁혀주세요(전체를 불러오지 않습니다)' : ('검색 결과 ' + (j.total | 0) + '건을 표에 추가했습니다');
    } catch (e) { alert('검색 실패: ' + (e.message || e)); }
  }

  async function _apply() {
    var changes = Object.keys(S.staged).map(function (k) { return S.staged[k]; });
    if (!changes.length) return;
    var lines = changes.map(function (c) {
      var what = c.mode === 'block' ? ('차단 (' + (c.messageType === 'policy' ? '사유 고지' : '마감 위장') + ')')
        : c.mode === 'allow' ? '허용 예외' : '기본으로 되돌림';
      return '· ' + (c.name || '') + ' (***-' + String(c.phone8).slice(-4) + ') → ' + what;
    });
    if (!confirm('아래 변경을 적용할까요?\n\n' + lines.join('\n') + '\n\n차단은 새 참여 신청만 막습니다(이미 잡힌 자리·제출완료 유지).')) return;
    try {
      var j = await _post(EP + encodeURIComponent(S.campId) + '/reviewer-gate', { changes: changes });
      if (!j.ok) throw new Error(j.error || '저장 실패');
      S.staged = {};
      S.data = j;
      // 표의 게이트 상태를 서버 결과로 재동기화
      var act = {};
      (j.blocks || []).concat(j.allows || []).forEach(function (r) { act[r.phone8] = { mode: r.mode, messageType: r.message_type }; });
      S.items.forEach(function (it) { it.gate = act[it.phone8] || null; });
      render();
      alert('적용했습니다 (차단 ' + ((j.counts || {}).block | 0) + '명 · 허용 예외 ' + ((j.counts || {}).allow | 0) + '명)');
    } catch (e) { alert('저장 실패: ' + (e.message || e)); }
  }

  function _csv() {
    var d = S.data || {};
    var rows = [['구분', '이름', '연락처끝4', '메시지', '처리자', '일시']];
    (d.blocks || []).forEach(function (r) {
      rows.push(['차단', r.reviewer_name || '', String(r.phone8 || '').slice(-4), r.message_type === 'policy' ? '사유고지' : '마감위장', r.created_by || '', r.created_at || '']);
    });
    (d.allows || []).forEach(function (r) {
      rows.push(['허용예외', r.reviewer_name || '', String(r.phone8 || '').slice(-4), '', r.created_by || '', r.created_at || '']);
    });
    var csv = '\uFEFF' + rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'reviewer-gate-' + (S.campId || '') + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  window.ReviewerGate = { open: open, close: close, _toggle: _toggle, _msg: _msg, _hist: _hist, _search: _search, _apply: _apply, _csv: _csv };
})();
