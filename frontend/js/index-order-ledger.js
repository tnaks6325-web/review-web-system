/* ══════════════════════════════════════════════════════════════
   주문 원장(Order Ledger) — DB 주체 인라인 뷰어/편집/취소/수동추가 (PR-B)
   - order_submissions(DB)를 보고 편집하면 DB→시트로 in-place 반영.
   - 쓰기는 백엔드 ORDER_LEDGER_WRITE_ENABLED='true'에서만(off면 503 안내).
   - 폴링(15s) + 액션 후 갱신. 상태 배지로 시트반영/충돌/취소 가시화.
   ══════════════════════════════════════════════════════════════ */
(function () {
  const EDITABLE = ['orderer', 'recipient', 'phone', 'address', 'bank', 'account', 'depositor', 'price', 'order_num', 'date_str', 'memo'];
  const COLS = [
    { k: 'mirrorStatus', label: '상태', w: 110 },
    { k: 'orderer', label: '주문자', w: 90, edit: 1 },
    { k: 'recipient', label: '수취인', w: 90, edit: 1 },
    { k: 'phone', label: '연락처', w: 120, edit: 1 },
    { k: 'address', label: '주소', w: 200, edit: 1 },
    { k: 'price', label: '금액', w: 80, edit: 1 },
    { k: 'order_num', label: '주문번호', w: 130, edit: 1 },
    { k: 'date_str', label: '일자', w: 90, edit: 1 },
    { k: 'memo', label: '비고', w: 140, edit: 1 },
    { k: 'sheetRow', label: '행', w: 56 },
    { k: 'tabName', label: '탭', w: 140 },
  ];
  const FIELD_OF = { order_num: 'orderNum', date_str: 'dateStr' }; // 컬럼키→응답필드명(다른 것만)
  const STATUS = {
    written: ['#D1FAE5', '#065F46', '반영완료'], queued: ['#FEF3C7', '#92400E', '큐'],
    pending: ['#FEF3C7', '#92400E', '대기'], pending_no_row: ['#FFEDD5', '#9A3412', '행없음'],
    failed: ['#FEE2E2', '#991B1B', '실패'], conflict: ['#EDE9FE', '#5B21B6', '충돌'],
    canceled: ['#F3F4F6', '#374151', '취소'], canceled_sheet_dirty: ['#FFE4E6', '#9F1239', '취소-수동확인'],
  };
  let _rows = [], _filter = { sheetId: '', tabName: '', mirrorStatus: '', q: '' }, _timer = null, _orig = {};

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function valOf(row, k) { return row[FIELD_OF[k] || k]; }

  window.loadOrderLedger = async function () {
    const pane = document.getElementById('tab-order-ledger');
    if (!pane) return;
    if (!pane._init) { _renderShell(pane); pane._init = true; }
    await _fetch();
    _startPoll();
  };

  function _startPoll() {
    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => {
      const pane = document.getElementById('tab-order-ledger');
      if (!pane || !pane.classList.contains('active')) { clearInterval(_timer); _timer = null; return; }
      _fetch();
    }, 15000);
  }

  function _renderShell(pane) {
    pane.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px">
        <b style="font-size:1rem">📒 주문 원장 (DB 주체)</b>
        <input id="olQ" placeholder="🔎 주문자/수취인/연락처/주문번호" style="padding:5px 8px;border:1px solid var(--border);border-radius:7px;font-size:.8rem"/>
        <select id="olStatus" style="padding:5px;border:1px solid var(--border);border-radius:7px;font-size:.8rem">
          <option value="">전체 상태</option>
          <option value="written">반영완료</option><option value="queued">큐</option>
          <option value="pending_no_row">행없음</option><option value="failed">실패</option>
          <option value="conflict">충돌</option><option value="canceled_sheet_dirty">취소-수동확인</option>
        </select>
        <button class="btn-sm" onclick="window._olManualAdd()" style="font-size:.75rem;background:#e8f1fe;color:#1b64da;border:1px solid #cce0fb;border-radius:7px;padding:4px 10px;cursor:pointer">+ 수동추가</button>
        <button class="btn-sm" onclick="window._olCsv()" style="font-size:.75rem;border:1px solid var(--border);border-radius:7px;padding:4px 10px;cursor:pointer;background:#fff">CSV</button>
        <button class="btn-sm" onclick="window.loadOrderLedger()" style="font-size:.75rem;border:1px solid var(--border);border-radius:7px;padding:4px 10px;cursor:pointer;background:#fff">새로고침</button>
        <span id="olMsg" style="font-size:.75rem;color:#6B7280"></span>
      </div>
      <div id="olGrid" style="overflow:auto;max-height:72vh;border:1px solid var(--border);border-radius:10px"></div>`;
    const q = pane.querySelector('#olQ'), st = pane.querySelector('#olStatus');
    let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { _filter.q = q.value.trim(); _fetch(); }, 350); });
    st.addEventListener('change', () => { _filter.mirrorStatus = st.value; _fetch(); });
  }

  async function _fetch() {
    const r = await gasGet({ action: 'orderLedgerList', limit: 200, q: _filter.q, mirrorStatus: _filter.mirrorStatus, sheetId: _filter.sheetId, tabName: _filter.tabName });
    if (!r || r.error || !r.ok) { _msg('조회 실패: ' + ((r && r.error) || '오류'), true); return; }
    _rows = r.rows || []; _renderGrid();
    _msg(`${_rows.length}건${r.nextCursor ? ' (이후 더 있음)' : ''}`);
  }

  function _renderGrid() {
    const grid = document.getElementById('olGrid'); if (!grid) return;
    const head = '<tr>' + COLS.map(c => `<th style="position:sticky;top:0;background:#F9FAFB;border-bottom:1px solid var(--border);padding:6px 8px;font-size:.72rem;text-align:left;white-space:nowrap;min-width:${c.w}px">${c.label}</th>`).join('') + '<th style="position:sticky;top:0;background:#F9FAFB;border-bottom:1px solid var(--border);padding:6px 8px"></th></tr>';
    const body = _rows.map(row => {
      _orig[row.id] = _orig[row.id] || {};
      const tds = COLS.map(c => {
        if (c.k === 'mirrorStatus') { const s = STATUS[row.mirrorStatus] || ['#F3F4F6', '#374151', row.mirrorStatus || '']; return `<td style="padding:4px 6px"><span style="background:${s[0]};color:${s[1]};font-size:.68rem;padding:2px 7px;border-radius:99px;white-space:nowrap">${esc(s[2])}</span></td>`; }
        const v = valOf(row, c.k);
        if (c.edit) { _orig[row.id][c.k] = v == null ? '' : String(v); return `<td style="padding:2px 4px"><input data-id="${esc(row.id)}" data-f="${c.k}" value="${esc(v)}" style="width:${c.w}px;border:1px solid transparent;border-radius:5px;padding:3px 5px;font-size:.76rem;background:transparent" onfocus="this.style.border='1px solid #cce0fb'" onblur="window._olBlur(this)"/></td>`; }
        return `<td style="padding:4px 6px;font-size:.74rem;color:#374151;white-space:nowrap">${esc(v)}</td>`;
      }).join('');
      const cancelBtn = (row.deletedAt || row.mirrorStatus === 'canceled') ? '' : `<button onclick="window._olCancel('${esc(row.id)}')" style="font-size:.68rem;color:#991B1B;background:#FEE2E2;border:none;border-radius:6px;padding:3px 8px;cursor:pointer">취소</button>`;
      return `<tr style="border-bottom:1px solid #F3F4F6">${tds}<td style="padding:4px 6px">${cancelBtn}</td></tr>`;
    }).join('');
    grid.innerHTML = `<table style="border-collapse:collapse;width:max-content;min-width:100%">${head}${body}</table>`;
  }

  window._olBlur = async function (inp) {
    const id = inp.getAttribute('data-id'), f = inp.getAttribute('data-f');
    const oldValue = (_orig[id] && _orig[id][f] != null) ? _orig[id][f] : '';
    const newValue = inp.value;
    if (String(oldValue) === String(newValue)) return;
    inp.disabled = true;
    const r = await gasPost({ action: 'orderEdit', orderSubmissionId: id, edits: [{ field: f, oldValue, newValue }] });
    inp.disabled = false;
    if (r && r.ok) { _orig[id][f] = newValue; inp.style.background = '#ECFDF5'; setTimeout(() => { inp.style.background = 'transparent'; _fetch(); }, 1200); _msg('편집 반영 중…'); }
    else if (r && r.error && /503|비활성/.test(JSON.stringify(r))) { inp.value = oldValue; _msg('쓰기 비활성: 관리자 환경변수(ORDER_LEDGER_WRITE_ENABLED) 필요', true); }
    else { inp.value = oldValue; _msg('편집 실패: ' + ((r && r.error) || '오류'), true); }
  };

  window._olCancel = async function (id) {
    if (!confirm('이 주문을 취소(소프트삭제)하고 시트행을 비울까요?')) return;
    const r = await gasPost({ action: 'orderCancel', orderSubmissionId: id });
    if (r && r.ok) { _msg(r.alreadyCanceled ? '이미 취소됨' : '취소 처리 중…'); _fetch(); }
    else { _msg('취소 실패: ' + ((r && r.error) || '오류'), true); }
  };

  window._olManualAdd = async function () {
    const sheetId = prompt('시트 ID(sheetId):', _filter.sheetId || ''); if (!sheetId) return;
    const tabName = prompt('탭 이름(tabName):', _filter.tabName || ''); if (!tabName) return;
    const gid = prompt('탭 gid(필수):', ''); if (!gid) return;
    const orderer = prompt('주문자:', '') || '';
    const recipient = prompt('수취인:', orderer) || '';
    const phone = prompt('연락처:', '') || '';
    const address = prompt('주소:', '') || '';
    const r = await gasPost({ action: 'orderManualAdd', sheetId, tabName, gid, phone, orderData: { orderer, recipient, phone, address } });
    if (r && r.ok) { _filter.sheetId = sheetId; _filter.tabName = tabName; _msg('수동추가 완료(' + (r.mirrorStatus || '') + ')'); _fetch(); }
    else { _msg('수동추가 실패: ' + ((r && r.error) || '오류'), true); }
  };

  window._olCsv = async function () {
    if (!_filter.sheetId || !_filter.tabName) { _msg('CSV는 시트/탭 필터가 있을 때(수동추가/조회로 지정). 상단 검색·수동추가로 탭 지정 후 사용', true); return; }
    const token = sessionStorage.getItem('admin_token');
    const base = (typeof API_BASE_URL !== 'undefined') ? API_BASE_URL : '';
    const url = base + `/api/diag/order-stuck-export?sheetId=${encodeURIComponent(_filter.sheetId)}&tabName=${encodeURIComponent(_filter.tabName)}&includeWritten=true&format=csv`;
    try {
      const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
      const blob = await res.blob(); const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `order_ledger_${_filter.tabName}.csv`; a.click();
    } catch (e) { _msg('CSV 실패: ' + e.message, true); }
  };

  function _msg(t, err) { const el = document.getElementById('olMsg'); if (el) { el.textContent = t; el.style.color = err ? '#DC2626' : '#6B7280'; } }
})();
