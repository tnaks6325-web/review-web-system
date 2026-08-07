/* ══════════════════════════════════════════════════════════════════════════
   campaign-daily-plan.js — 모집공고 날짜별 모집인원 조절 + 차수(물량 추가) 공유 모달
   (migration 095 · 시안 frontend/docs/모집인원조절_이월차수_와이어프레임.html)

   관리자 대시보드(admin.html)·리뷰웹시스템[3버전](workdesk.html)이 **이 한 벌**을 쓴다
   (모달 사본을 두면 두 화면이 계속 어긋난다 — campaign-reviewer-gate.js 와 같은 규율).

   시안에서 브라우저 검증으로 확정한 규칙 2건이 여기 그대로 산다:
   ★ "빠진 인원 처리" 질문은 조절 한 묶음당 한 번(0.7초 디바운스) — 클릭마다 팝업이 뜨면
     연속 조절이 불가능하다(실측).
   ★ "남은 날 분산"의 범위 = 축소 전 종료일까지의 남은 진행일 — 그 밖의 날까지 나누면
     얹는 의미가 없어 종료일이 그대로 밀린다(실측).

   ★ 조절은 [확정 저장]을 눌러야 서버 반영(드래그·버튼만으로는 저장 안 됨 — 오조작 방어).
     차수 추가/제거는 총량 변경이라 건별 confirm 후 즉시 반영.
   ★ onclick 에는 배열 인덱스·고정 문자열만(XSS 규율). 마운트는 body 직속 + var() 폴백.
   ★ 경로는 /api/trackb/* 하나 — admin_token·인트라넷 SSO 양쪽에서 그대로 닿는다
     (호스트별 재기준 불필요, 리뷰어 게이트와 같은 판단).
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var EP = '/api/trackb/campaigns/';           // + <id>/daily-plan | <id>/rounds
  var SETTLE_MS = 700;                          // 조절 멈춤 판정(질문은 한 묶음당 한 번)
  var ROW_DAYS = 14;                            // 기본 표시 일수(오늘 포함) — 조절된 날은 그 밖이어도 표시

  var S = null; // { campId, title, data, plan:{d:n}, base:{d:n}, notes:[], sessions:{d:{start,timer}}, choice, saving }

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
  async function _req(method, path, body) {
    var opt = { method: method, headers: _headers() };
    if (body !== undefined) opt.body = JSON.stringify(body || {});
    var r = await fetch(_apiBase() + path, opt);
    var j = await r.json().catch(function () { return null; });
    if (!j) throw new Error('HTTP ' + r.status);
    if (!j.ok) { var e = new Error(j.error || 'HTTP ' + r.status); e.code = j.code; e.floor = j.floor; throw e; }
    return j;
  }

  /* ── 날짜 유틸(문자열 산술 — 타임존 무관) ── */
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];
  function addDays(iso, n) {
    var t = Date.parse(iso + 'T00:00:00Z') + n * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  }
  function fmtMD(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
    var d = new Date(Date.parse(iso + 'T00:00:00Z'));
    return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' (' + DOW[d.getUTCDay()] + ')';
  }

  function planFor(d) {
    return (S.plan[d] != null) ? S.plan[d] : (S.data.defaultDaily || 0);
  }
  /** 예상 종료일: 오늘부터 계획값대로 채운다고 가정(최대 400일 탐색). 무제한이면 null */
  function endDate() {
    var total = S.data.recruitTotal || 0;
    if (total <= 0) return null;
    var todaySub = S.data.byDateSubmitted[S.data.today] || 0;
    var remain = total - Math.max(0, (S.data.submittedAll || 0) - todaySub);
    if (remain <= 0) return S.data.today;
    var d = S.data.today;
    for (var i = 0; i < 400; i++) {
      remain -= planFor(d);
      if (remain <= 0) return d;
      d = addDays(d, 1);
    }
    return null; // 계획이 전부 0이거나 도달 불가 — '계산 불가'로 표기
  }

  /* ── 마운트(body 직속) ───────────────────────────────────── */
  var CSS = ''
    + '#cdpModal{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.55)}'
    + '#cdpModal .cdp-box{background:var(--card,#fff);color:var(--t1,#1f2937);width:min(680px,94vw);max-height:92vh;display:flex;flex-direction:column;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.28);overflow:hidden}'
    + '#cdpModal .cdp-hd{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--border,#e5e7eb);background:var(--bg2,#f9fafb);font-weight:800;font-size:.85rem}'
    + '#cdpModal .cdp-x{margin-left:auto;border:0;background:none;font-size:1.05rem;cursor:pointer;color:var(--t3,#9ca3af)}'
    + '#cdpModal .cdp-bd{padding:14px 18px;overflow:auto;font-size:.8rem}'
    + '#cdpModal .cdp-sub{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px;margin-bottom:8px;font-size:.72rem;color:var(--t3,#6b7280)}'
    + '#cdpModal .cdp-sub b{color:#1b64da}'
    + '#cdpModal .cdp-note{background:var(--bg2,#f9fafb);border:1px solid var(--border,#e5e7eb);border-left:4px solid #94a3b8;border-radius:8px;padding:8px 12px;font-size:.72rem;margin:8px 0;color:var(--t2,#475569)}'
    + '#cdpModal .cdp-note.warn{border-left-color:#f59e0b;background:#fffbeb;color:#92400e}'
    + '#cdpModal .cdp-note.err{border-left-color:#dc2626;background:#fef2f2;color:#991b1b}'
    + '#cdpModal .cdp-row{display:grid;grid-template-columns:96px 1fr 118px;align-items:center;gap:10px;padding:6px 4px;border-bottom:1px dashed var(--border,#eef2f7)}'
    + '#cdpModal .cdp-row.today{background:var(--bg2,#f0f7ff);border-radius:8px}'
    + '#cdpModal .cdp-d{font-size:.74rem;color:var(--t2,#334155)}'
    + '#cdpModal .cdp-tag{display:inline-block;font-size:.6rem;font-weight:800;border-radius:999px;padding:0 6px;margin-left:4px;vertical-align:1px}'
    + '#cdpModal .cdp-tag.tdy{color:#1d4ed8;background:#dbeafe}'
    + '#cdpModal .cdp-tag.adj{color:#92400e;background:#fef3c7}'
    + '#cdpModal .cdp-g{position:relative;height:24px;border-radius:12px;background:var(--bg2,#f1f5f9);cursor:ew-resize;user-select:none;touch-action:none}'
    + '#cdpModal .cdp-g .f{position:absolute;left:0;top:0;bottom:0;border-radius:12px;background:linear-gradient(90deg,#60a5fa,#3b82f6)}'
    + '#cdpModal .cdp-g .c{position:absolute;left:0;top:0;bottom:0;border-radius:12px 0 0 12px;background:#1d4ed8;opacity:.5;pointer-events:none}'
    + '#cdpModal .cdp-g .b{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--t3,#94a3b8);pointer-events:none}'
    + '#cdpModal .cdp-g .k{position:absolute;top:50%;transform:translate(-50%,-50%);width:16px;height:16px;border-radius:50%;background:#fff;border:3px solid #2563eb;box-shadow:0 1px 4px rgba(15,23,42,.25);pointer-events:none}'
    + '#cdpModal .cdp-ctl{display:flex;align-items:center;gap:4px;justify-content:flex-end}'
    + '#cdpModal .cdp-num{width:46px;text-align:center;font-weight:800;font-size:.84rem}'
    + '#cdpModal .cdp-num small{display:block;font-weight:400;font-size:.58rem;color:var(--t3,#94a3b8)}'
    + '#cdpModal .cdp-st{width:25px;height:25px;border-radius:8px;border:1px solid var(--border,#cbd5e1);background:var(--card,#fff);color:var(--t1,#334155);font-size:.9rem;font-weight:800;cursor:pointer;line-height:1}'
    + '#cdpModal .cdp-reset{border:0;background:none;color:var(--t3,#94a3b8);font-size:.62rem;cursor:pointer;text-decoration:underline;padding:0}'
    + '#cdpModal .cdp-end{margin-top:10px;background:var(--bg2,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:9px 13px;font-size:.76rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}'
    + '#cdpModal .cdp-end b{color:#1b64da}'
    + '#cdpModal .cdp-end .chg{color:#b45309;font-weight:700;font-size:.68rem}'
    + '#cdpModal .cdp-sec{margin-top:14px;border-top:1px solid var(--border,#e2e8f0);padding-top:11px}'
    + '#cdpModal .cdp-sec .h{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;font-weight:800;font-size:.76rem}'
    + '#cdpModal .cdp-rr{display:flex;align-items:center;gap:9px;font-size:.73rem;padding:4px 2px}'
    + '#cdpModal .cdp-rno{font-weight:800;background:#e0e7ff;color:#3730a3;border-radius:6px;padding:1px 7px;font-size:.64rem}'
    + '#cdpModal .cdp-rmeta{color:var(--t3,#64748b)}'
    + '#cdpModal .cdp-rprog{margin-left:auto;font-weight:700}'
    + '#cdpModal .cdp-btn{border:1px solid var(--border,#d1d5db);background:var(--card,#fff);color:var(--t1,#374151);border-radius:8px;padding:6px 12px;font-size:.72rem;font-weight:700;cursor:pointer}'
    + '#cdpModal .cdp-btn.pri{background:#2563eb;border-color:#2563eb;color:#fff}'
    + '#cdpModal .cdp-btn:disabled{opacity:.45;cursor:default}'
    + '#cdpModal .cdp-radd{display:none;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px}'
    + '#cdpModal .cdp-radd.on{display:flex}'
    + '#cdpModal .cdp-radd input{border:1px solid var(--border,#d1d5db);border-radius:8px;padding:6px 9px;font-size:.74rem;background:var(--card,#fff);color:var(--t1,#111827)}'
    + '#cdpModal .cdp-hist{list-style:none;padding:0;margin:6px 0 0;font-size:.68rem;color:var(--t2,#475569);max-height:150px;overflow:auto}'
    + '#cdpModal .cdp-hist li{padding:3px 8px;border-left:3px solid #c7d2fe;margin-bottom:3px;background:var(--bg2,#f8fafc);border-radius:0 6px 6px 0}'
    + '#cdpModal .cdp-ft{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:11px 18px;border-top:1px solid var(--border,#e5e7eb);background:var(--bg2,#f8fafc)}'
    + '#cdpModal .cdp-hint{font-size:.64rem;color:var(--t3,#64748b)}'
    + '#cdpModal .cdp-ro{border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:10px 13px;background:var(--bg2,#fafafa);font-size:.75rem}'
    + '#cdpModal .cdp-ro .rr2{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dashed var(--border,#e2e8f0);font-size:.72rem}'
    + '#cdpModal .cdp-ro .rr2:last-child{border-bottom:none}'
    + '#cdpChoice{position:fixed;inset:0;z-index:10060;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);padding:16px}'
    + '#cdpChoice .ch-box{width:440px;max-width:100%;background:var(--card,#fff);color:var(--t1,#1f2937);border-radius:14px;padding:18px;box-shadow:0 12px 40px rgba(15,23,42,.3)}'
    + '#cdpChoice h4{font-size:.84rem;margin:0 0 5px}'
    + '#cdpChoice .cd{font-size:.74rem;color:var(--t3,#475569);margin-bottom:12px}'
    + '#cdpChoice .op{display:block;width:100%;text-align:left;border:1.5px solid var(--border,#cbd5e1);border-radius:10px;background:var(--card,#fff);color:var(--t1,#1f2937);padding:10px 13px;margin-bottom:7px;cursor:pointer;font-size:.74rem}'
    + '#cdpChoice .op:hover{border-color:#2563eb}'
    + '#cdpChoice .op b{display:block;font-size:.76rem;margin-bottom:2px}'
    + '#cdpChoice .op small{color:var(--t3,#64748b);font-size:.68rem;line-height:1.45;display:block}'
    + '#cdpChoice .op:disabled{opacity:.45;cursor:default}'
    + '#cdpChoice .cx{display:block;margin:5px auto 0;border:0;background:none;color:var(--t3,#94a3b8);font-size:.7rem;cursor:pointer;text-decoration:underline}';

  function ensureMount() {
    if (document.getElementById('cdpModal')) return;
    var st = document.createElement('style');
    st.id = 'cdpModalCss';
    st.textContent = CSS;
    document.head.appendChild(st);
    var ov = document.createElement('div');
    ov.id = 'cdpModal';
    ov.style.display = 'none';
    ov.innerHTML = '<div class="cdp-box">'
      + '<div class="cdp-hd">📅 <span id="cdpTitle"></span><button type="button" class="cdp-x" onclick="CampaignDailyPlan.close()">✕</button></div>'
      + '<div class="cdp-bd" id="cdpBody"></div>'
      + '<div class="cdp-ft"><span class="cdp-hint" id="cdpHint"></span>'
      + '<span><button type="button" class="cdp-btn" onclick="CampaignDailyPlan.close()">닫기</button> '
      + '<button type="button" class="cdp-btn pri" id="cdpSaveBtn" onclick="CampaignDailyPlan._save()">확정 저장</button></span></div>'
      + '</div>';
    document.body.appendChild(ov);
    // 오버레이 바깥 클릭으로 닫지 않는다 — 조절해 둔 값이 실수 클릭 한 번에 날아가지 않게(리뷰검수 팝업 규율).
    var ch = document.createElement('div');
    ch.id = 'cdpChoice';
    ch.style.display = 'none';
    ch.innerHTML = '<div class="ch-box"><h4 id="cdpChTitle"></h4><div class="cd" id="cdpChDesc"></div>'
      + '<button type="button" class="op" id="cdpChExtend" onclick="CampaignDailyPlan._chExtend()"><b>㉮ 종료일 연장 (계획 유지)</b><small id="cdpChExtendDesc"></small></button>'
      + '<button type="button" class="op" id="cdpChSpread" onclick="CampaignDailyPlan._chSpread()"><b>㉯ 남은 날 분산 (종료일 유지)</b><small id="cdpChSpreadDesc"></small></button>'
      + '<button type="button" class="cx" onclick="CampaignDailyPlan._chCancel()">취소 (원래 인원으로 되돌리기)</button></div>';
    document.body.appendChild(ch);
  }

  /* ── 열기/닫기 ───────────────────────────────────────────── */
  async function open(campId) {
    ensureMount();
    S = { campId: String(campId), title: '', data: null, plan: {}, base: {}, notes: [],
          sessions: {}, choice: null, saving: false, baseEnd: null, error: null };
    document.getElementById('cdpModal').style.display = 'flex';
    document.getElementById('cdpTitle').textContent = '모집인원 조절';
    document.getElementById('cdpBody').innerHTML = '<div class="cdp-note">불러오는 중…</div>';
    document.getElementById('cdpSaveBtn').disabled = true;
    try {
      applyOverview(await _req('GET', EP + encodeURIComponent(S.campId) + '/daily-plan'));
    } catch (e) {
      // 로딩 자리표시자를 깐 함수는 어떤 예외에도 화면을 종결시킨다(무한로딩 금지)
      document.getElementById('cdpBody').innerHTML =
        '<div class="cdp-note err">불러오지 못했습니다: ' + _esc(e.message || e) + '</div>'
        + '<button type="button" class="cdp-btn" onclick="CampaignDailyPlan._retry()">다시 시도</button>';
    }
  }
  function _retry() { if (S) open(S.campId); }
  function close() {
    if (S && dirtyDates().length && !window.confirm('저장하지 않은 조절이 있습니다. 닫을까요?')) return;
    var m = document.getElementById('cdpModal');
    if (m) m.style.display = 'none';
    var c = document.getElementById('cdpChoice');
    if (c) c.style.display = 'none';
    S = null;
  }

  function applyOverview(j) {
    S.data = j;
    S.title = j.title || '';
    S.plan = {};
    S.base = {};
    (j.plans || []).forEach(function (p) {
      if (p.date >= j.today) { S.plan[p.date] = p.count; S.base[p.date] = p.count; }
    });
    S.baseEnd = null;
    document.getElementById('cdpTitle').textContent = '모집인원 조절 — ' + (S.title || S.campId);
    render();
  }

  function dirtyDates() {
    if (!S || !S.data) return [];
    var out = [];
    var ds = {};
    Object.keys(S.plan).forEach(function (d) { ds[d] = 1; });
    Object.keys(S.base).forEach(function (d) { ds[d] = 1; });
    Object.keys(ds).forEach(function (d) {
      var a = S.plan[d], b = S.base[d];
      if ((a == null) !== (b == null) || (a != null && a !== b)) out.push(d);
    });
    return out.sort();
  }

  /* ── 렌더 ───────────────────────────────────────────────── */
  function rowDates() {
    var ds = {};
    for (var i = 0; i < ROW_DAYS; i++) ds[addDays(S.data.today, i)] = 1;
    Object.keys(S.plan).forEach(function (d) { if (d >= S.data.today) ds[d] = 1; });
    return Object.keys(ds).sort();
  }

  function render() {
    var j = S.data;
    var bd = document.getElementById('cdpBody');
    var save = document.getElementById('cdpSaveBtn');
    var hint = document.getElementById('cdpHint');

    if (j.scheduleDriven === true) {
      // 확정 ③: 시트 일정 캠페인 = 읽기 전용(시트가 진실원본)
      var lis = (j.scheduleDates || []).map(function (d) {
        return '<div class="rr2"><span>' + _esc(fmtMD(d.date)) + (d.date === j.today ? ' <span class="cdp-tag tdy">오늘</span>' : '') + '</span><span>시트에 ' + d.slots + '행 → ' + d.slots + '명</span></div>';
      }).join('');
      bd.innerHTML = '<div class="cdp-ro"><p style="font-weight:800;margin:0 0 8px">📄 이 캠페인의 날짜별 정원은 <span style="color:#1b64da">시트의 구매일자 컬럼</span>에서 자동으로 읽어옵니다.</p>'
        + lis
        + '<p style="margin:10px 0 0;font-size:.7rem;color:#92400e"><b>⚠ 여기서는 조절할 수 없습니다.</b> 인원을 바꾸려면 시트에서 그날 날짜가 적힌 행 수를 조절하세요(최대 5분 뒤 자동 반영). 차수(총량)도 시트 행 수가 기준입니다.</p></div>'
        + histHtml();
      save.disabled = true;
      hint.textContent = '시트 일정 캠페인 — 읽기 전용';
      return;
    }
    if (j.scheduleDriven === null) {
      // 판정 실패 = 잠금(fail-closed) — 시트 일정 캠페인에 조절을 쌓으면 화면만 어긋난다
      bd.innerHTML = '<div class="cdp-note err">시트 일정 여부를 판정하지 못했습니다 — 조절을 잠갔습니다. 잠시 후 다시 시도해주세요.</div>'
        + '<button type="button" class="cdp-btn" onclick="CampaignDailyPlan._retry()">다시 시도</button>';
      save.disabled = true;
      hint.textContent = '';
      return;
    }

    var killOff = j.planEnabled === false;
    var scale = gaugeScale();
    var rows = rowDates().map(function (d, i) {
      var v = planFor(d);
      var isToday = d === j.today;
      var adjusted = S.plan[d] != null;
      var conf = isToday ? (j.todayUsed || 0) : 0;
      var pw = Math.min(100, scale ? (v / scale * 100) : 0);
      var cw = Math.min(100, scale ? (conf / scale * 100) : 0);
      var bw = Math.min(100, scale ? ((j.defaultDaily || 0) / scale * 100) : 0);
      return '<div class="cdp-row' + (isToday ? ' today' : '') + '">'
        + '<span class="cdp-d">' + _esc(fmtMD(d))
        + (isToday ? '<span class="cdp-tag tdy">오늘</span>' : '')
        + (adjusted ? '<span class="cdp-tag adj">조절</span>' : '') + '</span>'
        + '<div class="cdp-g" data-i="' + i + '">'
        + '<div class="f" style="width:' + pw + '%"></div>'
        + (conf > 0 ? '<div class="c" style="width:' + cw + '%"></div>' : '')
        + '<div class="b" style="left:' + bw + '%"></div>'
        + '<div class="k" style="left:' + pw + '%"></div>'
        + '</div>'
        + '<div class="cdp-ctl">'
        + '<button type="button" class="cdp-st" data-i="' + i + '" data-d="-1"' + (killOff ? ' disabled' : '') + '>−</button>'
        + '<span class="cdp-num">' + v + '<small>' + (isToday && conf > 0 ? '확정·진행 ' + conf : (adjusted ? '<button type="button" class="cdp-reset" data-i="' + i + '">기본으로</button>' : '기본 ' + (j.defaultDaily || 0))) + '</small></span>'
        + '<button type="button" class="cdp-st" data-i="' + i + '" data-d="1"' + (killOff ? ' disabled' : '') + '>＋</button>'
        + '</div></div>';
    }).join('');

    var e = endDate();
    var endTxt = (j.recruitTotal || 0) <= 0 ? '무제한(총모집 미설정)' : (e ? fmtMD(e) : '계산 불가');
    if (S.baseEnd === null) S.baseEnd = endTxt;

    var roundsHtml = (j.rounds || []).map(function (r, i) {
      var prev = (j.rounds || []).slice(0, i).reduce(function (s, x) { return s + (x.count || 0); }, 0);
      var got = Math.max(0, Math.min(r.count || 0, (j.submittedAll || 0) - prev));
      var done = got >= (r.count || 0);
      return '<div class="cdp-rr"><span class="cdp-rno">' + r.roundNo + '차</span>'
        + '<span>' + (r.count || 0) + '건</span>'
        + '<span class="cdp-rmeta">' + _esc((r.startDate ? fmtMD(r.startDate) + ' 시작' : '시작일 없음') + (r.label ? ' · ' + r.label : '')) + '</span>'
        + '<span class="cdp-rprog" style="color:' + (done ? '#16a34a' : '#1b64da') + '">' + got + '/' + (r.count || 0) + (done ? ' 완료' : '') + '</span></div>';
    }).join('');

    bd.innerHTML =
      (killOff ? '<div class="cdp-note err">킬스위치(CAMPAIGN_DAILY_PLAN=0)로 날짜별 계획이 꺼져 있습니다 — 저장해도 정원에 반영되지 않아 조절을 잠갔습니다.</div>' : '')
      + '<div class="cdp-sub"><span>날짜별 모집 계획 — 게이지 드래그 또는 −/＋</span>'
      + '<span>기본 일건수 <b>' + (j.defaultDaily || 0) + '명</b> · 총량 <b>' + ((j.recruitTotal || 0) > 0 ? j.recruitTotal + '명' : '무제한') + '</b> · 확정 <b>' + (j.submittedAll || 0) + '명</b></span></div>'
      + '<div id="cdpRows">' + rows + '</div>'
      + '<div class="cdp-end"><span>예상 종료일: <b>' + _esc(endTxt) + '</b> '
      + (endTxt !== S.baseEnd ? '<span class="chg">(원래 ' + _esc(S.baseEnd) + ' → 변경됨)</span>' : '') + '</span>'
      + '<button type="button" class="cdp-btn" onclick="CampaignDailyPlan._revert()" style="padding:5px 10px;font-size:.66rem">조절 전으로 되돌리기</button></div>'
      + '<div class="cdp-note">줄이면 "빠진 인원 처리(종료일 연장/남은 날 분산)"를 묻고, 늘리면 다른 날은 그대로입니다. '
      + '총량은 어느 조절로도 변하지 않으며(도달까지 모집 계속), 총량 추가는 아래 [＋ 차수 추가]로만 합니다.</div>'
      + '<div class="cdp-sec"><div class="h"><span>차수 (물량 추가 이력)</span>'
      + '<span><button type="button" class="cdp-btn" onclick="CampaignDailyPlan._roundForm()">＋ 차수 추가</button>'
      + ((j.rounds || []).length >= 2 ? ' <button type="button" class="cdp-btn" onclick="CampaignDailyPlan._roundRemove()" title="마지막 차수 제거(오등록 복구)">− 마지막 차수 제거</button>' : '')
      + '</span></div>'
      + (roundsHtml || '<div class="cdp-rmeta" style="font-size:.7rem">아직 차수가 없습니다 — 물량이 추가되면 [＋ 차수 추가]로 등록하세요(총량 ' + ((j.recruitTotal || 0) > 0 ? j.recruitTotal + '건이 1차(초도)로 흡수됩니다' : '이 추가 건수로 설정됩니다') + ').</div>')
      + '<div class="cdp-radd" id="cdpRoundForm">'
      + '<input id="cdpRfCount" type="number" min="1" placeholder="추가 건수" style="width:90px">'
      + '<input id="cdpRfDate" type="date" title="시작일(선택)">'
      + '<input id="cdpRfLabel" type="text" maxlength="40" placeholder="메모(선택)" style="width:120px">'
      + '<button type="button" class="cdp-btn pri" onclick="CampaignDailyPlan._roundAdd()">추가</button></div>'
      + (j.roundsDrift ? '<div class="cdp-note warn">⚠ 총모집(' + (j.recruitTotal || 0) + ')이 차수 합계(' + (j.roundsTotal || 0) + ')와 다릅니다 — 다른 창구에서 총모집이 바뀐 흔적입니다. 차수를 추가/제거하면 합계로 다시 맞춰집니다.</div>' : '')
      + '</div>'
      + histHtml();

    bindRowEvents();
    var dirty = dirtyDates().length > 0;
    save.disabled = killOff || S.saving || !dirty;
    hint.textContent = dirty
      ? '조절 ' + dirtyDates().length + '일 — [확정 저장]을 눌러야 반영됩니다'
      : '조절은 [확정 저장]을 눌러야 반영됩니다 · 차수는 즉시 반영';
  }

  function histHtml() {
    var evs = (S.data.events || []);
    if (!evs.length) return '';
    var lis = evs.map(function (ev) {
      var t = '';
      try { t = new Date(ev.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) {}
      return '<li>' + _esc(t + ' · ' + (ev.actor || '?') + ' — ' + evText(ev)) + '</li>';
    }).join('');
    return '<div class="cdp-sec"><div class="h"><span>조절 이력</span></div><ul class="cdp-hist">' + lis + '</ul></div>';
  }
  function evText(ev) {
    var d = ev.detail || {};
    if (ev.action === 'round_add') return (d.roundNo || '?') + '차 추가 +' + (d.count || 0) + '건' + (d.startDate ? ' (' + fmtMD(d.startDate) + ' 시작)' : '') + ' · 총량 ' + (d.newTotal || '?');
    if (ev.action === 'round_remove') return (d.roundNo || '?') + '차 제거 −' + (d.count || 0) + '건 · 총량 ' + (d.newTotal || '?');
    if (ev.action === 'plan_save') {
      var parts = (d.set || []).map(function (x) { return fmtMD(x.date) + ' ' + x.count + '명'; })
        .concat((d.remove || []).map(function (x) { return fmtMD(x) + ' 기본으로'; }));
      return '계획 저장: ' + parts.join(', ') + (d.note ? ' · ' + d.note : '');
    }
    return ev.action;
  }

  /* ── 값 변경(세션 디바운스 — 질문은 조절 한 묶음당 한 번) ── */
  function gaugeScale() {
    var mx = (S.data.defaultDaily || 0) * 2;
    rowDates().forEach(function (d) { mx = Math.max(mx, planFor(d)); });
    return Math.max(10, mx);
  }
  function minFor(d) { return d === S.data.today ? (S.data.todayUsed || 0) : 0; }

  function commitValue(d, next) {
    if (S.data.planEnabled === false) return;
    var cur = planFor(d);
    next = Math.max(minFor(d), Math.min(9999, Math.round(next)));
    if (next === cur) {
      if (next === minFor(d) && d === S.data.today && minFor(d) > 0) {
        toast('이미 확정·진행 중인 ' + minFor(d) + '명 아래로는 줄일 수 없습니다');
      }
      if (S.sessions[d]) scheduleSettle(d);
      return;
    }
    if (!S.sessions[d]) S.sessions[d] = { start: cur, timer: null };
    setPlan(d, next);
    render();
    scheduleSettle(d);
  }
  function setPlan(d, v) {
    if (v === (S.data.defaultDaily || 0) && S.base[d] == null) delete S.plan[d];  // 기본값 복귀 = 조절 없음
    else S.plan[d] = v;
  }
  function scheduleSettle(d) {
    var s = S.sessions[d];
    clearTimeout(s.timer);
    s.timer = setTimeout(function () { settle(d); }, SETTLE_MS);
  }
  function settle(d) {
    var s = S.sessions[d];
    if (!s || !S.data) return;
    delete S.sessions[d];
    var start = s.start, fin = planFor(d);
    var dl = S.data.defaultDaily || 0;
    if (fin === start) return;
    if (fin < start && fin < dl) {
      // 축소 → 처리 방식 선택(한 묶음당 한 번). 분산 범위 = 축소 전 종료일까지(시안 실측 규칙).
      var missing = Math.max(0, Math.min(start, dl) - fin);
      var saved = S.plan[d];
      setPlan(d, start);
      var prevEnd = endDate();
      if (saved == null) delete S.plan[d]; else S.plan[d] = saved;
      var untilN = prevEnd ? Math.max(0, Math.round((Date.parse(prevEnd) - Date.parse(d)) / 86400000)) : 0;
      S.choice = { date: d, prev: start, next: fin, missing: missing, until: prevEnd, untilN: untilN };
      document.getElementById('cdpChTitle').textContent = fmtMD(d) + ' 인원을 ' + fin + '명으로 줄였습니다 — 빠진 ' + missing + '명은 어떻게 할까요?';
      document.getElementById('cdpChDesc').textContent = '총량 ' + ((S.data.recruitTotal || 0) > 0 ? S.data.recruitTotal + '명' : '') + '은 그대로 지켜집니다 — 빠진 인원을 언제 모집할지만 고릅니다.';
      document.getElementById('cdpChExtendDesc').textContent = '이후 날들은 계획 그대로(기본 ' + dl + '명) 진행하고, 종료일이 뒤로 밀립니다.';
      var sp = document.getElementById('cdpChSpread');
      if (untilN > 0) {
        sp.disabled = false;
        document.getElementById('cdpChSpreadDesc').textContent = '종료일(' + fmtMD(prevEnd) + ')까지 남은 ' + untilN + '일에 약 +' + Math.ceil(missing / untilN) + '명씩 얹어 종료일을 유지합니다.';
      } else {
        sp.disabled = true;
        document.getElementById('cdpChSpreadDesc').textContent = '남은 진행일이 없어 이 선택지는 쓸 수 없습니다.';
      }
      document.getElementById('cdpChoice').style.display = 'flex';
    } else if (fin > start && fin > dl) {
      toast('이 날만 ' + fin + '명으로 늘립니다 — 다른 날은 그대로, 총량은 변하지 않습니다');
      S.notes.push(fmtMD(d) + ' ' + start + '→' + fin + ' (증가)');
      render();
    } else {
      S.notes.push(fmtMD(d) + ' ' + start + '→' + fin);
      render();
    }
  }
  function _chExtend() {
    if (!S || !S.choice) return;
    S.notes.push(fmtMD(S.choice.date) + ' ' + S.choice.prev + '→' + S.choice.next + ' (빠진 ' + S.choice.missing + '명: 종료일 연장)');
    document.getElementById('cdpChoice').style.display = 'none';
    S.choice = null;
    render();
  }
  function _chSpread() {
    if (!S || !S.choice) return;
    var c = S.choice;
    if (!c.untilN) return;
    var per = Math.floor(c.missing / c.untilN), extra = c.missing % c.untilN;
    for (var k = 1; k <= c.untilN; k++) {
      var d2 = addDays(c.date, k);
      var add = per + (k <= extra ? 1 : 0);
      if (add > 0) S.plan[d2] = planFor(d2) + add;
    }
    S.notes.push(fmtMD(c.date) + ' ' + c.prev + '→' + c.next + ' (빠진 ' + c.missing + '명: 남은 ' + c.untilN + '일 분산)');
    document.getElementById('cdpChoice').style.display = 'none';
    S.choice = null;
    render();
  }
  function _chCancel() {
    if (S && S.choice) setPlan(S.choice.date, S.choice.prev);
    document.getElementById('cdpChoice').style.display = 'none';
    if (S) S.choice = null;
    render();
  }
  function _revert() {
    if (!S || !S.data) return;
    S.plan = {};
    Object.keys(S.base).forEach(function (d) { S.plan[d] = S.base[d]; });
    S.notes = [];
    S.baseEnd = null;
    render();
  }

  /* ── 게이지 드래그 + −/＋ (렌더마다 위임 재바인딩 — #cdpRows 는 render 가 갈아치운다) ── */
  var drag = null;
  function bindRowEvents() {
    var wrap = document.getElementById('cdpRows');
    if (!wrap) return;
    var dates = rowDates();
    wrap.addEventListener('pointerdown', function (ev) {
      var g = ev.target.closest('.cdp-g');
      if (!g || !S || S.data.planEnabled === false) return;
      var d = dates[Number(g.dataset.i)];
      drag = { d: d, el: g, start: planFor(d) };
      try { g.setPointerCapture(ev.pointerId); } catch (_) {}
      dragTo(ev);
    });
    wrap.addEventListener('pointermove', function (ev) { if (drag) dragTo(ev); });
    wrap.addEventListener('pointerup', function () {
      if (!drag) return;
      var d = drag.d, live = planFor(d);
      setPlan(d, drag.start);         // 확정은 commitValue 가 담당(세션·질문 트리거 포함)
      drag = null;
      commitValue(d, live);
    });
    wrap.addEventListener('pointercancel', function () {
      if (drag) { setPlan(drag.d, drag.start); drag = null; render(); }
    });
    wrap.addEventListener('click', function (ev) {
      var st = ev.target.closest('.cdp-st');
      if (st) {
        var d = dates[Number(st.dataset.i)];
        commitValue(d, planFor(d) + Number(st.dataset.d));
        return;
      }
      var rs = ev.target.closest('.cdp-reset');
      if (rs) {
        var d2 = dates[Number(rs.dataset.i)];
        commitValue(d2, S.data.defaultDaily || 0);
        // "기본으로" = 조절 해제 의도 — 값이 기본과 같아도 base 에 있으면 remove 로 저장된다
        if (S.plan[d2] === (S.data.defaultDaily || 0) && S.base[d2] != null) { delete S.plan[d2]; render(); }
      }
    });
  }
  function dragTo(ev) {
    if (!drag) return;
    var rect = drag.el.getBoundingClientRect();
    var ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    var v = Math.round(ratio * gaugeScale());
    v = Math.max(minFor(drag.d), Math.min(9999, v));
    if (v !== planFor(drag.d)) {
      S.plan[drag.d] = v;   // 드래그 중에는 그 줄만 가볍게 갱신(전체 재렌더 금지 — 드래그 끊김)
      var pw = Math.min(100, v / gaugeScale() * 100);
      drag.el.querySelector('.f').style.width = pw + '%';
      drag.el.querySelector('.k').style.left = pw + '%';
      var num = drag.el.parentElement.querySelector('.cdp-num');
      if (num) num.firstChild.textContent = v;
    }
  }

  /* ── 저장 ───────────────────────────────────────────────── */
  async function _save() {
    if (!S || !S.data || S.saving) return;
    var dl = S.data.defaultDaily || 0;
    var set = [], remove = [];
    dirtyDates().forEach(function (d) {
      if (S.plan[d] != null) set.push({ date: d, count: S.plan[d] });
      else remove.push(d);
    });
    if (!set.length && !remove.length) return;
    var lines = set.map(function (x) { return '· ' + fmtMD(x.date) + ' → ' + x.count + '명' + (x.count === dl ? ' (기본과 동일)' : ''); })
      .concat(remove.map(function (d) { return '· ' + fmtMD(d) + ' → 기본(' + dl + '명)으로 해제'; }));
    if (!window.confirm('아래 조절을 저장할까요?\n\n' + lines.join('\n') + '\n\n총량은 변하지 않습니다.')) return;
    S.saving = true;
    document.getElementById('cdpSaveBtn').disabled = true;
    try {
      var j = await _req('POST', EP + encodeURIComponent(S.campId) + '/daily-plan',
        { set: set, remove: remove, note: S.notes.join(' / ').slice(0, 500) });
      S.notes = [];
      applyOverview(j);
      toast('저장했습니다 — 카드·리뷰어 화면에 바로 반영됩니다');
      refreshHost();
    } catch (e) {
      toast('저장 실패: ' + (e.message || e));
      if (S) S.saving = false;
      render();   // 저장 버튼 되살림(스테이징 유지 — 다시 시도 가능)
    } finally {
      if (S) S.saving = false;
    }
  }

  /* ── 차수 ───────────────────────────────────────────────── */
  function _roundForm() {
    var f = document.getElementById('cdpRoundForm');
    if (f) f.classList.toggle('on');
  }
  async function _roundAdd() {
    if (!S || !S.data) return;
    var count = Number((document.getElementById('cdpRfCount') || {}).value);
    var startDate = String((document.getElementById('cdpRfDate') || {}).value || '');
    var label = String((document.getElementById('cdpRfLabel') || {}).value || '');
    if (!Number.isInteger(count) || count <= 0) { toast('추가 건수를 입력해주세요'); return; }
    var curTotal = S.data.recruitTotal || 0;
    var nextNo = (S.data.rounds || []).length ? Math.max.apply(null, S.data.rounds.map(function (r) { return r.roundNo; })) + 1 : (curTotal > 0 ? 2 : 1);
    if (!window.confirm(nextNo + '차로 ' + count + '건을 추가할까요?\n총량 ' + (curTotal > 0 ? curTotal : '무제한') + ' → ' + (curTotal + count) + '건'
      + (curTotal <= 0 ? '\n(무제한 공고가 총량 관리로 전환됩니다)' : ''))) return;
    try {
      var j = await _req('POST', EP + encodeURIComponent(S.campId) + '/rounds', { count: count, startDate: startDate || undefined, label: label || undefined });
      applyOverview(j);
      toast(j.roundNo + '차 +' + count + '건 — 총량 ' + j.newTotal + '건');
      refreshHost();
    } catch (e) { toast('차수 추가 실패: ' + (e.message || e)); }
  }
  async function _roundRemove() {
    if (!S || !S.data) return;
    var rs = S.data.rounds || [];
    if (rs.length < 2) return;
    var last = rs[rs.length - 1];
    if (!window.confirm(last.roundNo + '차(' + last.count + '건)를 제거할까요?\n총량 ' + (S.data.recruitTotal || 0) + ' → ' + ((S.data.recruitTotal || 0) - last.count) + '건')) return;
    try {
      var j = await _req('DELETE', EP + encodeURIComponent(S.campId) + '/rounds');
      applyOverview(j);
      toast(j.removedRoundNo + '차 제거 — 총량 ' + j.newTotal + '건');
      refreshHost();
    } catch (e) { toast('차수 제거 실패: ' + (e.message || e)); }
  }

  /* ── 호스트 목록 갱신(별표 토글과 같은 순서) ── */
  function refreshHost() {
    try {
      if (typeof window.loadRecruitList === 'function') window.loadRecruitList();
      else if (typeof window.loadRecruitPreview === 'function') window.loadRecruitPreview();
    } catch (_) {}
  }

  function toast(msg) {
    var t = document.getElementById('cdpToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'cdpToast';
      t.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1e293b;color:#fff;font-size:.76rem;padding:9px 17px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .25s;z-index:10070;max-width:92vw;text-align:center';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '.96';
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.style.opacity = '0'; }, 2600);
  }

  window.CampaignDailyPlan = {
    open: open, close: close,
    _save: _save, _retry: _retry, _revert: _revert,
    _chExtend: _chExtend, _chSpread: _chSpread, _chCancel: _chCancel,
    _roundForm: _roundForm, _roundAdd: _roundAdd, _roundRemove: _roundRemove,
  };
})();
