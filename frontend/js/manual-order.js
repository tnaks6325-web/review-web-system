/* ══════════════════════════════════════════════════════════════
   외부모집 구매양식 — 관리자 수동제출 (공용 모달)

   카톡으로 모집한 외부 리뷰어의 슬래시양식을 붙여넣어 시스템에 정식 제출한다.
   기존에는 관리자가 구글시트에 직접 수기 입력했고, 그게 "유령 written"(DB=성공/시트=없음)
   사고의 유발 조건이자 모집 정원 누락·리뷰어 미등록의 원인이었다.

   진입점 3곳이 이 모듈 하나를 쓴다(사본을 두면 화면마다 규칙이 어긋난다):
     ① 관리자 대시보드 · 캠페인 탭 관리   ② 참여형 관제 패널(📡)   ③ 리뷰어 홈 참여형 카드
   ③은 **진짜 admin_token 보유자에게만** 노출한다 — 리뷰어앱 공고수정 스코프 토큰
   (via:'reviewer_campaign')은 이 API에 도달할 수 없어(403) 버튼을 보여주면 막다른 길이 된다.

   사용: ManualOrder.open({ sheetId, tabName, gid, campaignId, title })
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.ManualOrder) return;

  // 오리진은 api.js가 이미 판정해 둔 값을 그대로 쓴다(사본을 두면 배포처가 바뀔 때 한쪽만 남는다).
  function _api() {
    if (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) return API_BASE_URL;
    if (window.REVIEW_API_URL) return window.REVIEW_API_URL;
    if (location.hostname === 'localhost') return 'http://localhost:3000';
    return 'https://sublime-magic-production-790b.up.railway.app';
  }

  function tok() {
    try { return sessionStorage.getItem('admin_token') || localStorage.getItem('admin_token') || ''; }
    catch (_) { return ''; }
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function api(path, opts) {
    const o = Object.assign({ headers: {} }, opts || {});
    o.headers['Authorization'] = 'Bearer ' + tok();
    if (o.body) o.headers['Content-Type'] = 'application/json';
    const r = await fetch(_api() + path, o);
    return r.json();
  }

  let CTX = null;      // { sheetId, tabName, gid, campaignId, title }
  let ROWS = [];       // 파싱 결과 + 캡처 상태
  let BUSY = false;

  // ── 스타일(1회 주입) ───────────────────────────────────────
  function styles() {
    if (document.getElementById('mo-style')) return;
    const st = document.createElement('style');
    st.id = 'mo-style';
    st.textContent = `
.mo-ovl{position:fixed;inset:0;background:rgba(17,24,39,.5);z-index:100001;display:flex;align-items:center;justify-content:center;padding:20px}
.mo-box{background:#fff;border-radius:16px;width:1040px;max-width:97vw;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.3);font-family:'Pretendard',-apple-system,'Noto Sans KR',sans-serif;color:#191F28}
.mo-hd{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #EFEFF3}
.mo-hd b{font-size:15px} .mo-hd .sub{font-size:11.5px;color:#8B95A1}
.mo-hd .sp{flex:1}
.mo-bd{padding:16px 18px;overflow:auto;background:#F4F5F8}
.mo-ft{display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid #EFEFF3;background:#fff}
.mo-ft .sp{flex:1}
.mo-btn{font:inherit;font-size:13px;font-weight:750;padding:9px 16px;border-radius:10px;border:none;cursor:pointer;font-family:inherit}
.mo-btn.pri{background:#3182f6;color:#fff} .mo-btn.pri:disabled{background:#D1D5DB;cursor:default}
.mo-btn.gh{background:#F1F2F6;color:#191F28}
.mo-btn.xs{font-size:11px;padding:5px 10px;border-radius:8px}
.mo-pane{background:#fff;border:1px solid #EFEFF3;border-radius:12px;padding:13px 14px;margin-bottom:12px}
.mo-pane h4{margin:0 0 8px;font-size:12.5px;font-weight:750;display:flex;align-items:center;gap:6px}
.mo-ta{width:100%;min-height:110px;font-family:'SF Mono',ui-monospace,monospace;font-size:12px;line-height:1.75;
  border:1.5px dashed #cce0fb;border-radius:11px;padding:11px 12px;background:#F7FAFF;color:#191F28;resize:vertical;outline:none}
.mo-ta:focus{border-color:#3182f6;background:#fff}
.mo-hint{font-size:11px;color:#6B7280;margin-top:7px;line-height:1.6}
.mo-tbl{width:100%;border-collapse:collapse;font-size:11.5px;background:#fff;border:1px solid #EFEFF3;border-radius:10px;overflow:hidden}
.mo-tbl th{background:#F7F8FB;color:#6B7280;font-weight:750;font-size:10px;padding:7px 8px;text-align:left;border-bottom:1px solid #EFEFF3;white-space:nowrap}
.mo-tbl td{padding:7px 8px;border-bottom:1px solid #EFEFF3;vertical-align:top}
.mo-tbl tr:last-child td{border-bottom:none}
.mo-tbl tr.bad td{background:#FEF2F2}
.mo-in{width:100%;font:inherit;font-size:11.5px;border:1px solid transparent;border-radius:6px;padding:3px 5px;background:transparent;color:#191F28}
.mo-in:hover{border-color:#E6EAF0;background:#fff} .mo-in:focus{border-color:#3182f6;background:#fff;outline:none}
.mo-bdg{font-size:9.5px;font-weight:800;border-radius:5px;padding:2px 6px;white-space:nowrap;display:inline-block}
.mo-bdg.grn{background:#F0FDF4;color:#15803D;border:1px solid #BBF7D0}
.mo-bdg.vio{background:#efecfa;color:#6d5ac9}
.mo-bdg.amb{background:#FFFBEB;color:#B45309;border:1px solid #FDE68A}
.mo-bdg.red{background:#E5484D;color:#fff}
.mo-bdg.ai{background:#EEF2FF;color:#4338CA;border:1px solid #C7D2FE}
.mo-cap{width:96px;height:58px;border:1.5px dashed #cce0fb;border-radius:9px;background:#F7FAFF;display:flex;flex-direction:column;
  align-items:center;justify-content:center;cursor:pointer;font-size:9.5px;color:#1b64da;font-weight:700;text-align:center;line-height:1.35;outline:none}
.mo-cap:focus{border-color:#3182f6;background:#EBF3FE}
.mo-cap.has{border-style:solid;border-color:#BBF7D0;background:#F0FDF4;color:#15803D}
.mo-pick{display:inline-block;margin-top:3px;font-size:9.5px;font-weight:700;color:#6B7280;text-decoration:underline;cursor:pointer}
.mo-pick:hover{color:#1b64da}
.mo-msg{font-size:10.5px;line-height:1.5;margin-top:3px}
.mo-msg.e{color:#B91C1C} .mo-msg.w{color:#B45309}
.mo-res{display:flex;gap:9px;align-items:flex-start;border:1px solid #EFEFF3;border-radius:11px;padding:10px 12px;margin-bottom:7px;background:#fff}
.mo-res.ok{background:#F0FDF4;border-color:#BBF7D0} .mo-res.no{background:#FEF2F2;border-color:#FEE2E2}
.mo-res .ci{width:20px;height:20px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:800}
.mo-res.ok .ci{background:#22C55E} .mo-res.no .ci{background:#E5484D}
.mo-res .t{font-size:12.5px;font-weight:700} .mo-res .s{font-size:10.5px;color:#6B7280;line-height:1.55}
`;
    document.head.appendChild(st);
  }

  // ── 열기 ───────────────────────────────────────────────────
  function open(ctx) {
    if (!tok()) { alert('관리자 로그인이 필요합니다.'); return; }
    styles();
    CTX = Object.assign({ sheetId: '', tabName: '', gid: '', campaignId: null, title: '' }, ctx || {});
    if (!CTX.sheetId || !CTX.tabName) { alert('연결된 작업(시트·탭) 정보가 없어 수동제출을 열 수 없습니다.'); return; }
    ROWS = [];
    let ovl = document.getElementById('moOvl');
    if (!ovl) {
      ovl = document.createElement('div');
      ovl.id = 'moOvl'; ovl.className = 'mo-ovl';
      ovl.addEventListener('click', e => { if (e.target === ovl) close(); });
      document.body.appendChild(ovl);
    }
    ovl.style.display = 'flex';
    renderInput();
  }
  function close() {
    const o = document.getElementById('moOvl');
    if (o) o.remove();
    CTX = null; ROWS = []; BUSY = false;
  }

  function shell(bodyHtml, footHtml) {
    const o = document.getElementById('moOvl');
    if (!o) return;
    o.innerHTML = `<div class="mo-box">
      <div class="mo-hd">
        <b>🧾 외부참여 수동제출</b>
        <span class="sub">${esc(CTX.title || CTX.tabName)}${CTX.campaignId ? ' · 참여형(정원 차감)' : ''}</span>
        <span class="sp"></span>
        <button class="mo-btn gh xs" onclick="ManualOrder.close()">닫기</button>
      </div>
      <div class="mo-bd">${bodyHtml}</div>
      <div class="mo-ft">${footHtml}</div>
    </div>`;
  }

  // ── 1단계: 붙여넣기 ────────────────────────────────────────
  function renderInput() {
    shell(`
      <div class="mo-pane">
        <h4>구매양식 붙여넣기 <span class="mo-bdg grn">여러 줄 = 여러 건</span></h4>
        <textarea class="mo-ta" id="moText" placeholder="카톡에서 받은 슬래시양식을 그대로 붙여넣으세요 (한 줄 = 한 명)&#10;예) 이시현/이시현/kirei223/010-7701-1701/부산시 수영구 광안동 119-3번지, 109호/신한은행/496-04-007701/이시현/15800"></textarea>
        <div class="mo-hint">
          순서: <b>리뷰어 / 수취인 / 아이디 / 전화번호 / 주소 / 은행 / 계좌번호 / 예금주 / 결제금액</b><br>
          · 주소에 슬래시(/)가 있어도 앞뒤 칸이 밀리지 않게 자동으로 주소로 합칩니다<br>
          · 리뷰어와 수취인이 다르면 <b>타계정 참여</b>로 처리합니다<br>
          · 슬래시(/)가 빠져도 됩니다 — <b>빠진 자리를 자동으로 찾아 나누고</b>, 어떤 항목이 없는지 알려드려요
        </div>
      </div>`,
      `<span class="sp"></span><button class="mo-btn pri" onclick="ManualOrder.parse()">다음 — 자동으로 나누기</button>`);
    setTimeout(() => { const t = document.getElementById('moText'); if (t) t.focus(); }, 40);
  }

  // ── 2단계: 파싱 미리보기 ───────────────────────────────────
  async function parse() {
    const el = document.getElementById('moText');
    const text = el ? el.value : '';
    if (!text.trim()) { alert('붙여넣은 내용이 없습니다.'); return; }
    let r;
    try {
      r = await api('/api/manual-order/preview', { method: 'POST', body: JSON.stringify({ text }) });
    } catch (e) { alert('분해 실패: ' + (e && e.message ? e.message : '서버에 연결하지 못했습니다')); return; }
    if (!r || !r.ok) { alert('분해 실패: ' + ((r && r.error) || '오류')); return; }
    ROWS = (r.items || []).map(it => Object.assign({}, it, { capture: null, extract: null }));
    if (r.repairedCount) console.info('[ManualOrder] 자동보정 ' + r.repairedCount + '건');
    if (r.truncated) alert(`한 번에 최대 50건까지 처리합니다. ${r.truncated}건은 제외되었습니다.`);
    renderPreview();
  }

  function rowHtml(it, i) {
    const f = it.fields || {};
    const bad = !it.ok;
    const sub = f.isSubAccount;
    const msgs = []
      .concat((it.errors || []).map(m => `<div class="mo-msg e">✕ ${esc(m)}</div>`))
      .concat((it.warnings || []).map(m => `<div class="mo-msg w">⚠ ${esc(m)}</div>`))
      .join('');
    const inp = (k, w) => `<input class="mo-in" style="${w ? 'min-width:' + w : ''}" value="${esc(f[k] == null ? '' : f[k])}"
        oninput="ManualOrder.edit(${i},'${k}',this.value)">`;
    // 🔧/🤖 보정 배지 — 자동으로 고친 줄은 반드시 눈에 띄게 표시한다(조용한 수정 금지)
    const fixBdg = it.aiRepaired ? '<span class="mo-bdg ai">🤖 AI 보정</span>'
                 : (it.repairs || []).length ? '<span class="mo-bdg amb">🔧 자동보정</span>' : '';
    const capCls = it.capture ? 'mo-cap has' : 'mo-cap';
    const capTxt = it.capture ? '✓ 첨부됨<br>' + (it.extract && it.extract.orderNumber ? '주문번호 인식' : '') : '클릭 후<br>Ctrl+V';
    // 붙여넣기가 안 먹는 브라우저(파이어폭스 등)를 위한 파일 선택 폴백 — 첨부 경로가 하나뿐이면 막힌다
    const capPick = `<label class="mo-pick">파일 선택<input type="file" accept="image/*" hidden
        onchange="ManualOrder.onFile(event,${i})"></label>`;
    return `<tr class="${bad ? 'bad' : ''}">
      <td style="width:22px;color:#8B95A1">${i + 1}${fixBdg ? '<div style="margin-top:3px">' + fixBdg + '</div>' : ''}</td>
      <td style="width:96px">${inp('reviewerName')}${sub ? '<span class="mo-bdg vio">타계정</span>' : '<span class="mo-bdg grn">본인</span>'}</td>
      <td style="width:86px">${inp('recipient')}</td>
      <td style="width:86px">${inp('userId')}</td>
      <td style="width:118px">${inp('phone')}</td>
      <td>${inp('address')}</td>
      <td style="width:82px">${inp('bank')}</td>
      <td style="width:110px">${inp('account')}</td>
      <td style="width:74px">${inp('depositor')}</td>
      <td style="width:74px">${inp('price')}</td>
      <td style="width:104px">
        <div class="${capCls}" tabindex="0" onpaste="ManualOrder.onPaste(event,${i})" onclick="this.focus()">${capTxt}</div>
        ${capPick}
        ${msgs}
      </td>
    </tr>`;
  }

  function renderPreview() {
    const okN = ROWS.filter(r => r.ok).length;
    const badN = ROWS.length - okN;
    const fixN = ROWS.filter(r => (r.repairs || []).length || r.aiRepaired).length;
    shell(`
      <div class="mo-pane">
        <h4>분해 결과 확인 <span class="mo-bdg grn">정상 ${okN}건</span>${badN ? ` <span class="mo-bdg red">오류 ${badN}건</span>` : ''}${fixN ? ` <span class="mo-bdg amb">자동보정 ${fixN}건</span>` : ''}</h4>
        <div style="overflow-x:auto">
          <table class="mo-tbl">
            <thead><tr>
              <th></th><th>리뷰어</th><th>수취인</th><th>아이디</th><th>전화번호</th><th>주소</th>
              <th>은행</th><th>계좌번호</th><th>예금주</th><th>금액</th><th>구매캡쳐</th>
            </tr></thead>
            <tbody>${ROWS.map(rowHtml).join('')}</tbody>
          </table>
        </div>
        <div class="mo-hint">
          · 칸을 눌러 바로 수정할 수 있습니다 · 오류가 있는 줄은 제출에서 제외됩니다<br>
          · 구매캡쳐 칸을 클릭하고 <b>Ctrl+V</b> 하면 첨부됩니다 — 캡처 속 주문번호를 자동으로 읽습니다<br>
          · <b>🔧 자동보정 / 🤖 AI 보정</b> 표시가 붙은 줄은 <b>슬래시(/)가 빠진 자리를 시스템이 찾아 나눈 것</b>입니다 — 값이 맞는지 꼭 확인하세요
        </div>
      </div>`,
      `<button class="mo-btn gh" onclick="ManualOrder.back()">← 다시 붙여넣기</button><span class="sp"></span>
       <button class="mo-btn pri" id="moSubmit" ${okN ? '' : 'disabled'} onclick="ManualOrder.submit()">${okN}건 제출</button>`);
  }

  function back() { renderInput(); }

  const REQUIRED = ['reviewerName', 'recipient', 'phone', 'address', 'bank', 'account', 'depositor', 'price'];

  // 셀 인라인 수정 — 값만 바꾸고 표는 다시 그리지 않는다(입력 중 포커스 유실 방지)
  function edit(i, key, val) {
    const it = ROWS[i]; if (!it) return;
    it.fields[key] = (key === 'price') ? (parseInt(String(val).replace(/[^0-9]/g, ''), 10) || null) : val;
    if (key === 'reviewerName' || key === 'recipient') {
      const n = s => String(s || '').replace(/\s+/g, '');
      it.fields.isSubAccount = !!(it.fields.reviewerName && it.fields.recipient
        && n(it.fields.reviewerName) !== n(it.fields.recipient));
    }
    // ★ 재판정은 **양방향**이어야 한다. 채워지면 풀고 끝이면, 채웠다가 다시 지운 칸이
    //   여전히 '정상'으로 남아 빈 주소·빈 계좌인 채로 제출된다(서버 최소검증은 수취인·전화만 본다).
    const f = it.fields;
    const pd = String(f.phone || '').replace(/[^0-9]/g, '');
    const missing = REQUIRED.filter(k => !String(f[k] == null ? '' : f[k]).trim());
    const bad = missing.length > 0 || (pd.length !== 11 && pd.length !== 10);
    it.ok = !bad;
    it.errors = bad ? (missing.length ? ['필수 항목이 비어 있습니다'] : ['전화번호 자릿수가 이상합니다']) : [];
    const btn = document.getElementById('moSubmit');
    if (btn) { const n = ROWS.filter(r => r.ok).length; btn.disabled = !n; btn.textContent = n + '건 제출'; }
    // 오류 여부가 바뀐 줄만 색을 맞춘다(표 재렌더 없이 — 입력 중 포커스 유지)
    const tr = document.querySelectorAll('.mo-tbl tbody tr')[i];
    if (tr) {
      tr.classList.toggle('bad', bad);
      // 고친 줄에 옛 ✕/⚠ 문구가 남아 있으면 "아직 오류"로 읽힌다 → 함께 갱신
      tr.querySelectorAll('.mo-msg').forEach(el => el.remove());
      const cell = tr.lastElementChild;
      if (cell && bad) {
        const d = document.createElement('div');
        d.className = 'mo-msg e';
        d.textContent = '✕ ' + it.errors[0];
        cell.appendChild(d);
      }
    }
  }

  // ── 캡처 붙여넣기 → AI 추출 ────────────────────────────────
  function onPaste(ev, i) {
    const items = (ev.clipboardData || {}).items || [];
    for (const it of items) {
      if (it.type && it.type.indexOf('image/') === 0) {
        const f = it.getAsFile();
        if (f) { ev.preventDefault(); attach(i, f); return; }
      }
    }
  }
  function onFile(ev, i) {
    const f = ev.target && ev.target.files && ev.target.files[0];
    if (f) attach(i, f);
  }
  /**
   * 붙여넣은 캡처를 1920px·JPEG로 줄인다.
   * ★ 서버 본문 상한이 10MB라 윈도우 전체화면 캡처를 원본 base64로 보내면 413으로 통째로 실패한다
   *   (리뷰어 경로도 같은 이유로 compressImage를 거친다). 실패 시 원본으로 폴백.
   */
  function shrink(file) {
    return new Promise(resolve => {
      const done = (b64, mime) => resolve({ base64: b64, mime });
      const raw = () => {
        const rd = new FileReader();
        rd.onload = () => done(String(rd.result || '').split(',')[1] || '', file.type || 'image/jpeg');
        rd.onerror = () => resolve(null);
        rd.readAsDataURL(file);
      };
      if (file.size <= 1024 * 1024 && file.type === 'image/jpeg') return raw();
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          let w = img.width, h = img.height;
          if (w > 1920) { h = Math.round(h * (1920 / w)); w = 1920; }
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          const durl = cv.toDataURL('image/jpeg', 0.75);
          done(durl.split(',')[1] || '', 'image/jpeg');
        } catch (_) { raw(); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); raw(); };
      img.src = url;
    });
  }

  function attach(i, file) {
    const row = ROWS[i]; if (!row) return;
    (async () => {
      const shrunk = await shrink(file);
      if (!shrunk || !shrunk.base64) { alert('이미지를 읽지 못했습니다.'); return; }
      const b64 = shrunk.base64;
      row.capture = { base64: b64, mime: shrunk.mime };
      renderPreview();
      // 캡처에서 주문번호 등 자동 인식(실패해도 첨부는 유지)
      try {
        const r = await api('/api/image/image-extract', { method: 'POST', body: JSON.stringify({ imageBase64: b64, mimeType: shrunk.mime }) });
        if (r && r.ok) {
          row.extract = r;
          if (r.orderNumber && !row.fields.orderNum) row.fields.orderNum = r.orderNumber;
          renderPreview();
        }
      } catch (_) { /* 추출 실패는 무시 — 슬래시양식이 정본 */ }
    })();
  }

  // ── 3단계: 제출 ────────────────────────────────────────────
  async function submit() {
    if (BUSY) return;
    const targets = ROWS.map((r, i) => ({ r, i })).filter(x => x.r.ok);
    if (!targets.length) return;
    if (!confirm(`${targets.length}건을 제출합니다.\n리뷰어 자동 등록${CTX.campaignId ? ' · 모집 정원 차감' : ''}이 함께 진행됩니다.`)) return;
    BUSY = true;
    const btn = document.getElementById('moSubmit');
    if (btn) { btn.disabled = true; btn.textContent = '제출 중…'; }

    let out;
    try {
      out = await api('/api/manual-order/submit', {
        method: 'POST',
        body: JSON.stringify({
          sheetId: CTX.sheetId, tabName: CTX.tabName, gid: CTX.gid || '',
          campaignId: CTX.campaignId || null,
          items: targets.map(x => ({ fields: x.r.fields, optionKey: x.r.fields.optionKey || '' })),
        }),
      });
    } catch (e) { out = { ok: false, error: e.message }; }

    if (!out || !out.ok) {
      BUSY = false;
      if (btn) { btn.disabled = false; btn.textContent = targets.length + '건 제출'; }
      alert('제출 실패: ' + ((out && out.error) || '오류'));
      return;
    }

    // 성공 건의 캡처를 주문에 연결(기존 업로드 경로 재사용 — 신규 저장소 0)
    for (let k = 0; k < (out.results || []).length; k++) {
      const res = out.results[k];
      const t = (res && typeof res.index === 'number') ? targets[res.index] : targets[k];
      const src = t && t.r;
      if (!res || !res.ok || !src || !src.capture || !res.orderSubmissionId) continue;
      try {
        const up = await api('/api/image/image-upload', {
          method: 'POST',
          body: JSON.stringify({
            imageBase64: src.capture.base64, mimeType: src.capture.mime,
            fileName: (src.fields.recipient || '주문캡처') + '.' + (src.capture.mime === 'image/png' ? 'png' : 'jpg'),
            tabName: CTX.tabName, sheetId: CTX.sheetId, displayName: CTX.title || '',
            orderSubmissionId: res.orderSubmissionId,
          }),
        });
        res.captureAttached = !!(up && up.ok);
        if (!res.captureAttached) {
          (res.warnings = res.warnings || []).push('구매캡쳐 첨부 실패: ' + ((up && up.error) || '알 수 없는 오류'));
        }
      } catch (e) {
        res.captureAttached = false;
        (res.warnings = res.warnings || []).push('구매캡쳐 첨부 실패: ' + (e && e.message ? e.message : '오류'));
      }
    }

    BUSY = false;
    renderResult(out);
  }

  function renderResult(out) {
    const rows = (out.results || []).map(r => {
      if (r.ok) {
        const bits = [];
        if (r.reviewerRegistered) bits.push(r.linkedOwner ? `‘${esc(r.linkedOwner)}’ 리뷰어의 타계정으로 등록` : '리뷰어 자동 등록됨');
        if (r.quotaCounted) bits.push('모집인원 1명 차감');
        if (r.captureAttached) bits.push('구매캡쳐 첨부됨');
        bits.push(r.queued ? '시트 기록 예약됨' : '시트 기록은 자동복구 대기');
        const warn = (r.warnings || []).length
          ? `<div class="mo-msg w" style="margin-top:4px">⚠ ${(r.warnings || []).map(esc).join(' · ')}</div>` : '';
        return `<div class="mo-res ok"><span class="ci">✓</span><div>
          <div class="t">${esc(r.name || '')} — 접수 완료</div>
          <div class="s">${bits.join(' · ')}</div>${warn}</div></div>`;
      }
      return `<div class="mo-res no"><span class="ci">!</span><div>
        <div class="t">${esc(r.name || '')} — 실패</div>
        <div class="s">${esc(r.error || '알 수 없는 오류')}</div></div></div>`;
    }).join('');
    shell(`
      <div class="mo-pane">
        <h4>제출 결과 <span class="mo-bdg grn">성공 ${out.okCount}건</span>${out.failCount ? ` <span class="mo-bdg red">실패 ${out.failCount}건</span>` : ''}</h4>
        ${rows}
        ${out.failCount ? '<div class="mo-hint">실패한 건은 원인을 고쳐 다시 붙여넣어 제출하세요. 성공한 건은 이미 접수되어 다시 넣으면 중복됩니다.</div>' : ''}
      </div>`,
      `<span class="sp"></span>
       <button class="mo-btn gh" onclick="ManualOrder.back()">계속 입력</button>
       <button class="mo-btn pri" onclick="ManualOrder.close()">완료</button>`);
    // 목록/관제가 열려 있으면 갱신(있을 때만 — 없는 화면에서 조용히 무시)
    try { if (typeof loadTabDashboard === 'function') loadTabDashboard(); } catch (_) {}
    try { if (CTX && CTX.campaignId && typeof _loadCampControl === 'function') _loadCampControl(CTX.campaignId); } catch (_) {}
  }

  window.ManualOrder = { open, close, parse, back, edit, onPaste, onFile, submit };
})();
