/* ============================================================
 * 공고 편집 상품 카드 — 「쇼핑몰에서 가져오기」 (결정 271 · 사용자 확정 2026-10-22 「1.나」)
 *
 * 인트라넷 리뷰오더 상품 카드의 같은 버튼(public/static/js/review-order-product-page.js)과 같은 흐름이다:
 *   확장 프로그램(INADD 리뷰오더 상품정보 가져오기 1.0.5+)에 열린 쇼핑몰 상품 탭을 묻고(LIST) → 하나면 바로, 여럿이면 고르게 →
 *   그 탭을 읽고(READ) → 서버(POST /api/trackb/campaigns/product-page/extract)가 AI 로 판독 → 확인 화면 →
 *   담당자가 고른 항목만 카드 칸에 넣는다.
 *
 * ★ 저장하지 않는다 — 칸을 채울 뿐이고, 저장은 종전 그대로 [저장] 버튼으로만 된다.
 * ★ 모집인원·일건수는 채우지 않는다 — 상품페이지에 없는 값이다(인트라넷과 같다).
 * ★ 잠긴 칸(disabled·readOnly·rf-locked)에는 쓰지 않는다. 저장돼 있던 옵션 줄은 지우지 않는다(이름 바꾸기·참여 기록 보호).
 * ★ 확장 프로그램과는 externally_connectable(chrome.runtime.sendMessage(확장ID, …))로만 이야기한다 — 리뷰웹 화면에 확장의
 *   스크립트를 심지 않는다(새 권한 경고가 생기면 이미 설치한 PC 의 확장이 업데이트 때 꺼진다).
 * ★ 안내는 이 창 안에서 한다 — 리뷰웹 토스트는 공고 창(z-index 5000) 아래에 깔려 안 보인다(recruit-modal.js 실측 주석).
 * ============================================================ */
(function () {
  "use strict";
  var EXTENSION_FALLBACK_ID = "hlhphdglgkacdbbknpfmaoklcbinnaoe";
  var STORE_URL = "https://chromewebstore.google.com/detail/" + EXTENSION_FALLBACK_ID;
  var MALLS_TEXT = "네이버 스마트스토어 · 쿠팡 · 올리브영 · 카카오메이커스";
  var ASK_TIMEOUT_MS = 20000;
  var EXTRACT_PATH = "/api/trackb/campaigns/product-page/extract";

  var _box = null;      // 지금 가져오는 상품 카드(.rf-gp)
  var _result = null;   // 서버 판독 결과
  var _seq = 0;         // 창을 다시 열면 늦게 온 옛 응답을 버린다

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function money(v) { return Math.round(Number(v) || 0).toLocaleString("ko-KR") + "원"; }
  function num(v) { var n = Number(String(v == null ? "" : v).replace(/[^\d]/g, "")); return isFinite(n) ? n : 0; }

  /** 리뷰어가 낼 금액 = 상품가 + 배송비(무료·기준금액 이상이면 0). 서버 계산과 같은 규칙. */
  function payFor(price, shipping, includeShipping) {
    var p = num(price);
    if (!p) return 0;
    if (!includeShipping || !shipping || shipping.isFree || !shipping.fee) return p;
    if (shipping.freeThreshold && p >= shipping.freeThreshold) return p;
    return p + shipping.fee;
  }

  function extensionId() {
    var g = window.productReaderGate && window.productReaderGate._internals;
    return (g && g.EXTENSION_ID) || EXTENSION_FALLBACK_ID;
  }

  /**
   * 확장 프로그램에 한 가지를 묻는다. 결과: { ok, ... } 또는 { ok:false, kind:'missing'|'old'|'error', error }.
   * 1.0.4 이하는 PING 외의 요청에 { ok:false } 만 답한다 → 'old'(업데이트 안내).
   */
  function ask(type, extra) {
    return new Promise(function (resolve) {
      var rt = window.chrome && window.chrome.runtime;
      if (!rt || typeof rt.sendMessage !== "function") return resolve({ ok: false, kind: "missing" });
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true;
        resolve({ ok: false, kind: "error", error: "확장 프로그램이 응답하지 않습니다. 이 화면을 새로고침한 뒤 다시 시도해 주세요." });
      }, ASK_TIMEOUT_MS);
      var msg = { type: type };
      if (extra) Object.keys(extra).forEach(function (k) { msg[k] = extra[k]; });
      try {
        rt.sendMessage(extensionId(), msg, function (res) {
          if (done) return; done = true; clearTimeout(timer);
          if (rt.lastError || !res) return resolve({ ok: false, kind: "missing" });
          if (res.ok) return resolve(res);
          if (!res.error) return resolve({ ok: false, kind: "old" });
          resolve({ ok: false, kind: "error", error: String(res.error) });
        });
      } catch (_) { done = true; clearTimeout(timer); resolve({ ok: false, kind: "missing" }); }
    });
  }

  /* ── 창 ─────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById("rfShopStyle")) return;
    var st = document.createElement("style");
    st.id = "rfShopStyle";
    st.textContent = [
      "#rfShopModal{position:fixed;inset:0;z-index:5400;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:20px}",
      "#rfShopModal .rs-dlg{width:min(680px,100%);max-height:calc(100vh - 40px);display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 24px 60px rgba(15,23,42,.28);font-size:13px;color:#0F172A}",
      "#rfShopModal header{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #E2E8F0}",
      "#rfShopModal header strong{font-size:14px;font-weight:800}",
      "#rfShopModal header button{margin-left:auto;border:0;background:none;font-size:20px;line-height:1;color:#64748B;cursor:pointer}",
      "#rfShopModal .rs-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:12px}",
      "#rfShopModal .rs-status{margin:0;color:#334155}#rfShopModal .rs-status.err{color:#B42318}",
      "#rfShopModal .rs-sub{color:#64748B;font-size:12px}",
      "#rfShopModal .rs-hint{margin:0;color:#475569}",
      "#rfShopModal .rs-warn{margin:0;padding:8px 10px 8px 26px;border:1px solid #FDE68A;border-radius:8px;background:#FFFBEB;color:#92400E;line-height:1.55}",
      "#rfShopModal .rs-tabs{display:flex;flex-direction:column;gap:6px}",
      "#rfShopModal .rs-tab{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;text-align:left;padding:9px 11px;border:1px solid #E2E8F0;border-radius:8px;background:#fff;cursor:pointer;font:inherit}",
      "#rfShopModal .rs-tab:hover{border-color:#9DBDF2;background:#F7FAFF}",
      "#rfShopModal .rs-tab-mall{grid-row:span 2;align-self:center;font-weight:800;color:#2769DF}",
      "#rfShopModal .rs-tab-title{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "#rfShopModal .rs-tab-url{color:#64748B;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "#rfShopModal .rs-grid{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px 10px;align-items:center}",
      "#rfShopModal .rs-in{width:100%;box-sizing:border-box;height:32px;padding:0 9px;border:1px solid #CBD5E1;border-radius:7px;font:inherit;background:#fff}",
      "#rfShopModal .rs-sec{border-top:1px solid #EEF2F7;padding-top:10px;display:flex;flex-direction:column;gap:8px}",
      "#rfShopModal .rs-sec h4{margin:0;font-size:13px;font-weight:800}",
      "#rfShopModal .rs-check{display:flex;align-items:center;gap:6px;cursor:pointer}",
      "#rfShopModal .rs-prices{display:flex;flex-direction:column;gap:4px}",
      "#rfShopModal .rs-price em{color:#64748B;font-style:normal}",
      "#rfShopModal .rs-pay{display:flex;align-items:center;gap:10px}#rfShopModal .rs-pay .rs-in{width:140px}",
      "#rfShopModal .rs-muted{opacity:.55}",
      "#rfShopModal .rs-tablewrap{overflow-x:auto}",
      "#rfShopModal table{width:100%;border-collapse:collapse}",
      "#rfShopModal th,#rfShopModal td{padding:5px 6px;border-bottom:1px solid #EEF2F7;text-align:left;vertical-align:middle}",
      "#rfShopModal th{font-size:12px;color:#64748B;font-weight:700}",
      "#rfShopModal td.rs-num{text-align:right;white-space:nowrap}",
      "#rfShopModal td .rs-in{height:30px}#rfShopModal td .rs-opt-pay{width:110px}",
      "#rfShopModal .rs-tag{margin-left:6px;padding:1px 6px;border-radius:5px;background:#FDE4E1;color:#B42318;font-size:11px;font-weight:800;white-space:nowrap}",
      "#rfShopModal .rs-tag.addon{background:#EEF2F7;color:#475569}",
      "#rfShopModal .rs-acts{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}",
      "#rfShopModal .rs-btn{height:34px;padding:0 14px;border:1px solid #CBD5E1;border-radius:8px;background:#fff;font:inherit;font-weight:700;cursor:pointer}",
      "#rfShopModal .rs-btn.pri{border-color:#2769DF;background:#2769DF;color:#fff}",
      "#rfShopModal a.rs-link{color:#2769DF;font-weight:800;text-decoration:underline}",
      "#recruitModal .rf-shop-filled{background:#FFF8D6!important;border-color:#F2C94C!important}",
      "#recruitModal .rf-shop-note{margin:0 0 6px;padding:6px 10px;border:1px solid #F2C94C;border-radius:7px;background:#FFFBEB;color:#7A5B00;font-size:12px;font-weight:700}",
    ].join("\n");
    document.head.appendChild(st);
  }

  function shell(bodyHtml) {
    injectStyle();
    var old = document.getElementById("rfShopModal"); if (old) old.remove();
    var no = (_box && _box.querySelector(".rf-card-no") || {}).textContent || "상품";
    var m = document.createElement("div");
    m.id = "rfShopModal";
    m.innerHTML = '<div class="rs-dlg" role="dialog" aria-modal="true" aria-labelledby="rfShopTitle">' +
      '<header><strong id="rfShopTitle">쇼핑몰에서 가져오기 · ' + esc(no) + '</strong><button type="button" aria-label="닫기" data-rs-close>×</button></header>' +
      '<div class="rs-body" id="rfShopBody">' + bodyHtml + '</div></div>';
    m.addEventListener("click", function (ev) {
      if (ev.target === m || (ev.target.closest && ev.target.closest("[data-rs-close]"))) close();
    });
    document.body.appendChild(m);
    return m;
  }
  function setBody(html) { var b = document.getElementById("rfShopBody"); if (b) b.innerHTML = html; return b; }
  function status(text, err) { return '<p class="rs-status' + (err ? " err" : "") + '" aria-live="polite">' + text + "</p>"; }
  function acts(extra) { return '<div class="rs-acts">' + (extra || "") + '<button type="button" class="rs-btn" data-rs-close>닫기</button></div>'; }
  function close() { var m = document.getElementById("rfShopModal"); if (m) m.remove(); _box = null; _result = null; _seq++; }

  function installHtml() {
    return '<p><b>이 PC의 크롬에 「INADD 리뷰오더 상품정보 가져오기」 확장 프로그램이 없습니다.</b></p>' +
      '<p class="rs-hint">설치하면 열어 둔 쇼핑몰 상품페이지에서 상품명·가격·옵션·배송비를 이 카드로 바로 가져올 수 있습니다. 설치 뒤 이 화면을 새로고침하세요.</p>' +
      '<p><a class="rs-link" href="' + esc(STORE_URL) + '" target="_blank" rel="noopener">크롬 웹스토어에서 설치하기</a></p>' + acts();
  }
  function oldHtml() {
    return '<p><b>확장 프로그램을 새 버전으로 업데이트해야 합니다.</b></p>' +
      '<p class="rs-hint">공고 화면에서 가져오기는 확장 프로그램 새 버전부터 됩니다. 크롬이 보통 하루 안에 자동으로 업데이트합니다. ' +
      '바로 하려면 크롬 주소창에 chrome://extensions 를 열고 위쪽 「업데이트」를 누른 뒤 이 화면을 새로고침하세요.</p>' + acts();
  }

  /* ── 흐름 ───────────────────────────────────────── */
  /** 카드의 [쇼핑몰에서 가져오기] — 확장 프로그램에 열린 상품 탭을 묻고, 하나면 바로 읽고, 여럿이면 고르게 한다. */
  async function rfImportFromShop(box) {
    if (!box) return;
    _box = box; _result = null;
    var my = ++_seq;
    shell(status("열려 있는 쇼핑몰 상품페이지를 찾는 중…"));
    var res = await ask("LIST");
    if (my !== _seq) return;
    if (!res.ok) {
      setBody(res.kind === "missing" ? installHtml() : res.kind === "old" ? oldHtml() : status(esc(res.error), true) + acts());
      return;
    }
    var tabs = Array.isArray(res.tabs) ? res.tabs : [];
    if (!tabs.length) {
      var b0 = setBody('<p><b>열려 있는 쇼핑몰 상품페이지가 없습니다.</b></p>' +
        '<p class="rs-hint">다른 탭에 상품페이지를 열어 두고 [다시 찾기]를 누르세요. 옵션 목록이 접혀 있으면 펼쳐 두면 더 정확합니다.</p>' +
        '<p class="rs-sub">지원: ' + MALLS_TEXT + '</p>' + acts('<button type="button" class="rs-btn pri" id="rsRetry">다시 찾기</button>'));
      b0.querySelector("#rsRetry").addEventListener("click", function () { rfImportFromShop(box); });
      return;
    }
    if (tabs.length === 1) { readTab(tabs[0], my); return; }
    var rows = tabs.map(function (t, i) {
      return '<button type="button" class="rs-tab" data-i="' + i + '"><span class="rs-tab-mall">' + esc(t.mall) + '</span>' +
        '<span class="rs-tab-title">' + esc(t.title || t.url) + '</span><span class="rs-tab-url">' + esc(t.url) + '</span></button>';
    }).join("");
    var b = setBody('<p class="rs-hint">상품페이지가 ' + tabs.length + '개 열려 있습니다. 가져올 상품을 고르세요(최근에 본 순서).</p>' +
      '<div class="rs-tabs">' + rows + '</div>' + acts());
    b.querySelectorAll(".rs-tab").forEach(function (btn) {
      btn.addEventListener("click", function () { readTab(tabs[Number(btn.dataset.i)], my); });
    });
  }

  /** 고른 탭을 확장 프로그램으로 읽고, 서버(AI)에 보내 확인 화면을 그린다. */
  async function readTab(tab, my) {
    var box = _box;
    setBody(status("<b>" + esc(tab.mall) + "</b> 상품페이지를 읽는 중… AI 판독까지 10~20초 걸릴 수 있습니다."));
    try {
      var page = await ask("READ", { tabId: tab.tabId });
      if (my !== _seq) return;
      if (!page.ok) throw new Error(page.kind === "old" ? "확장 프로그램을 새 버전으로 업데이트해야 합니다." : (page.error || "상품페이지를 읽지 못했습니다."));
      var r = await fetch(API_BASE_URL + EXTRACT_PATH, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, typeof _getAuthHeaders === "function" ? _getAuthHeaders() : {}),
        body: JSON.stringify({ text: page.text || "", url: page.url || tab.url || "", pageData: page.pageData || "" }),
      });
      var j = await r.json().catch(function () { return {}; });
      if (my !== _seq) return;
      if (!r.ok || !j.ok) throw new Error(j.error || ("읽기에 실패했습니다(" + r.status + ")."));
      _result = j.result;
      renderResult();
    } catch (e) {
      if (my !== _seq) return;
      var b = setBody(status(esc((e && e.message) || "읽기에 실패했습니다."), true) +
        acts('<button type="button" class="rs-btn pri" id="rsRetry">다시 찾기</button>'));
      b.querySelector("#rsRetry").addEventListener("click", function () { rfImportFromShop(box); });
    }
  }

  function channelBtn(ch) {
    if (!ch) return null;
    return Array.prototype.find.call(document.querySelectorAll('#rf_channel_btns .rchan-btn[data-group="channel"]'),
      function (b) { return b.dataset.val === ch; }) || null;
  }

  function renderResult() {
    var r = _result, body = document.getElementById("rfShopBody");
    if (!r || !body) return;
    var s = r.shipping || {};
    var shippingText = s.isFree ? ("무료배송" + (s.condition ? " (" + s.condition + ")" : ""))
      : s.fee ? ("배송비 " + money(s.fee) + (s.freeThreshold ? " · " + money(s.freeThreshold) + " 이상 무료" : ""))
      : "배송비 정보를 찾지 못함";
    var prices = (r.prices || []).map(function (p) {
      return '<label class="rs-check rs-price"><input type="radio" name="rsPrice" value="' + p.amount + '"' + (p.amount === r.basePrice ? " checked" : "") + '>' +
        '<span><b>' + money(p.amount) + "</b> " + esc(p.label) + (p.condition ? " <em>(" + esc(p.condition) + ")</em>" : "") + "</span></label>";
    }).join("");
    var opts = r.options || [];
    var hasOptions = opts.some(function (o) { return !o.isAddon; });
    var optRows = opts.map(function (o, i) {
      return "<tr><td><input type=\"checkbox\" class=\"rs-opt-pick\" data-i=\"" + i + "\"" + (o.soldOut || o.isAddon ? "" : " checked") + ' aria-label="' + esc(o.name) + ' 채우기"></td>' +
        '<td><input type="text" class="rs-in rs-opt-name" data-i="' + i + '" value="' + esc(o.name) + '">' +
        (o.soldOut ? '<span class="rs-tag">품절</span>' : "") + (o.isAddon ? '<span class="rs-tag addon">추가상품</span>' : "") + "</td>" +
        '<td class="rs-num">' + (o.price ? money(o.price) : "-") + "</td>" +
        '<td><input type="number" min="0" class="rs-in rs-opt-pay" data-i="' + i + '" data-price="' + (o.price || 0) + '" value="' + (o.suggestedPay || "") + '"></td></tr>';
    }).join("");
    var warns = (r.warnings || []).map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("");
    var chBtn = channelBtn(r.channel);
    var chRow = chBtn
      ? '<label class="rs-check"><input id="rsUseChannel" type="checkbox"' + (chBtn.classList.contains("active") || chBtn.disabled ? "" : " checked") + (chBtn.disabled ? " disabled" : "") + "> 구매채널</label>" +
        "<div><b>" + esc(r.channel) + "</b>" + (r.channelSource === "ai" ? ' <span class="rs-sub">주소가 없어 AI 가 추정했습니다</span>' : "") +
        (chBtn.classList.contains("active") ? ' <span class="rs-sub">이미 같은 채널입니다</span>' : "") + "</div>"
      : "";

    body.innerHTML =
      (warns ? '<ul class="rs-warn">' + warns + "</ul>" : "") +
      '<p class="rs-hint">읽은 값을 확인하고 채울 항목만 체크하세요. 모집인원·일건수는 직접 입력합니다. 채운 뒤 [저장]을 눌러야 저장됩니다.</p>' +
      '<div class="rs-grid">' +
        '<label class="rs-check"><input id="rsUseName" type="checkbox" checked> 상품명</label><input id="rsName" type="text" class="rs-in" value="' + esc(r.productName) + '">' +
        '<label class="rs-check"><input id="rsUseUrl" type="checkbox"' + (r.url ? " checked" : "") + '> 상품 메인 URL</label><input id="rsUrl" type="url" class="rs-in" value="' + esc(r.url) + '">' +
        chRow +
      "</div>" +
      '<section class="rs-sec"><h4>가격 · 배송</h4>' +
        (prices ? '<div class="rs-prices">' + prices + "</div>" : '<p class="rs-sub">가격을 찾지 못했습니다.</p>') +
        "<p style=\"margin:0\"><b>" + esc(shippingText) + "</b>" + (s.evidence ? ' <span class="rs-sub">원문: “' + esc(s.evidence) + "”</span>" : "") + "</p>" +
        '<label class="rs-check"><input id="rsAddShip" type="checkbox" checked> 결제금액에 배송비 포함 (무료배송 기준을 넘으면 0원)</label>' +
        '<div class="rs-pay' + (hasOptions ? " rs-muted" : "") + '"><label class="rs-check"><input id="rsUsePay" type="checkbox"' + (hasOptions ? "" : " checked") + "> 결제금액 (옵션 없음)</label>" +
        '<input id="rsPay" type="number" min="0" class="rs-in" value="' + (r.basePay || "") + '"></div>' +
      "</section>" +
      (opts.length ?
        '<section class="rs-sec"><h4>옵션 ' + opts.length + "개</h4>" +
        '<label class="rs-check"><input id="rsUseOpts" type="checkbox"' + (hasOptions ? " checked" : "") + "> 「옵션 있음」으로 바꾸고 아래 옵션 줄을 만들기</label>" +
        '<div class="rs-tablewrap"><table><thead><tr><th></th><th>1차 옵션</th><th>상품가</th><th>결제금액</th></tr></thead><tbody>' + optRows + "</tbody></table></div></section>" : "") +
      acts('<button type="button" class="rs-btn" id="rsAgain">다른 탭에서 가져오기</button><button type="button" class="rs-btn pri" id="rsApply">선택한 항목 채우기</button>');

    var box = _box;
    body.querySelector("#rsAgain").addEventListener("click", function () { rfImportFromShop(box); });
    body.querySelector("#rsApply").addEventListener("click", apply);
    var recompute = function () {
      var include = document.getElementById("rsAddShip").checked;
      var picked = body.querySelector('input[name="rsPrice"]:checked');
      var chosen = picked ? picked.value : r.basePrice;
      var pay = document.getElementById("rsPay"); if (pay) pay.value = payFor(chosen, s, include) || "";
      body.querySelectorAll(".rs-opt-pay").forEach(function (inp) { inp.value = payFor(inp.dataset.price, s, include) || ""; });
    };
    body.querySelector("#rsAddShip").addEventListener("change", recompute);
    body.querySelectorAll('input[name="rsPrice"]').forEach(function (x) { x.addEventListener("change", recompute); });
  }

  /** 칸에 값을 넣는다 — 잠긴 칸은 건너뛰고, 채운 칸에는 노란 표시(고치면 사라짐). 기존 입력 반응(input 이벤트)을 그대로 돌린다. */
  function fill(input, value) {
    if (!input || input.disabled || input.readOnly || input.classList.contains("rf-locked")) return false;
    input.value = String(value == null ? "" : value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.classList.add("rf-shop-filled");
    input.title = "상품페이지에서 채운 값입니다. 확인해 주세요.";
    input.addEventListener("input", function () { input.classList.remove("rf-shop-filled"); input.title = ""; }, { once: true });
    return true;
  }

  function apply() {
    var r = _result, box = _box;
    if (!r || !box || !box.isConnected) { close(); return; }
    var checked = function (id) { var e = document.getElementById(id); return !!(e && e.checked); };
    var val = function (id) { var e = document.getElementById(id); return e ? String(e.value || "") : ""; };
    var skipped = [];
    var extra = "";

    if (checked("rsUseName") && val("rsName").trim() && !fill(box.querySelector(".rf-gp-name"), val("rsName").trim())) skipped.push("상품명");
    var url = val("rsUrl").trim();
    if (checked("rsUseUrl") && url && !fill(box.querySelector(".rf-gp-url"), url)) skipped.push("상품 메인 URL");
    if (checked("rsUseChannel")) {
      var cb = channelBtn(r.channel);
      if (cb && !cb.disabled && typeof selectRfBtn === "function") selectRfBtn("channel", cb); else skipped.push("구매채널");
    }

    var picks = [];
    if (checked("rsUseOpts")) {
      document.querySelectorAll("#rfShopModal .rs-opt-pick").forEach(function (c) {
        if (!c.checked) return;
        var i = c.dataset.i;
        var name = String((document.querySelector('#rfShopModal .rs-opt-name[data-i="' + i + '"]') || {}).value || "").replace(/\|/g, " ").trim();
        var pay = num((document.querySelector('#rfShopModal .rs-opt-pay[data-i="' + i + '"]') || {}).value);
        if (name) picks.push({ name: name, pay: pay });
      });
    }

    if (picks.length) {
      // 「옵션 있음」으로 — 카드의 그 버튼을 그대로 누른다(옵션을 만드는 방향은 확인창이 없다)
      if (box.dataset.unit !== "option") { var ob = box.querySelector('.rf-gp-unit button[data-unit="option"]'); if (ob) ob.click(); }
      var bodyEl = box.querySelector(".rf-gp-body");
      var have = {};
      Array.prototype.forEach.call(box.querySelectorAll(".rf-opt-row .rf-opt-name"), function (n) { have[String(n.value || "").trim()] = 1; });
      var pu = String((box.querySelector(".rf-gp-url") || {}).value || "").trim();
      var pname = String((box.querySelector(".rf-gp-name") || {}).value || "");
      var dup = 0;
      // 옵션 이름이 빈 살아 있는 줄(옵션 없던 상품의 그 줄 · 저장돼 있던 줄 포함)은 지우지 않고 앞 옵션부터 채운다 —
      //   사람이 적어 둔 모집인원·일건수가 그 줄에 남고, 이름 없는 줄이 남아 저장이 막히지도 않는다(사람이 「옵션 있음」을 누르고
      //   옵션 이름을 적는 것과 같다 — 저장돼 있던 줄이면 서버가 이름 바꾸기로 받아 참여 기록이 이어진다).
      var blanks = Array.prototype.filter.call(box.querySelectorAll(".rf-opt-row"), function (row) {
        return row.dataset.status !== "closed" && !String((row.querySelector(".rf-opt-name") || {}).value || "").trim();
      });
      var reused = 0;
      picks = picks.filter(function (o) {
        if (have[o.name]) { dup++; return false; }   // 같은 이름 줄이 이미 있으면 새로 만들지 않는다(선택지 키 중복 금지)
        if (!blanks.length) return true;
        var row = blanks.shift();
        have[o.name] = 1; reused++;
        fill(row.querySelector(".rf-opt-name"), o.name);
        if (o.pay) fill(row.querySelector(".rf-opt-pay"), o.pay);
        if (pu) fill(row.querySelector(".rf-opt-url"), pu);
        return false;
      });
      // 그래도 남은 빈 줄 중 아무것도 안 적힌 새 줄만 지운다 — 저장돼 있던 줄·사람이 적어 둔 줄은 그대로(주소는 카드가 채운 값이라 셈에서 뺀다)
      blanks.forEach(function (row) {
        if (row.dataset.origKey) return;
        var filled = [".rf-opt-pay", ".rf-opt-rt", ".rf-opt-dl"].some(function (sel) {
          var v = String((row.querySelector(sel) || {}).value || "").trim(); return v && v !== "0";
        });
        if (!filled) { if (typeof _ugDrop === "function") _ugDrop(row.dataset.ig); (row.closest(".rf-unit") || row).remove(); }
      });
      picks.forEach(function (o) {
        if (have[o.name]) { dup++; return; }
        have[o.name] = 1;
        var row = _buildOptRowEl({ productName: pname, unitKind: "option", optKey: o.name, payAmount: o.pay, optionUrl: pu });
        bodyEl.appendChild(row.classList && row.classList.contains("rf-unit") ? row : (row.closest(".rf-unit") || row));
        var ro = row.classList && row.classList.contains("rf-opt-row") ? row : row.querySelector(".rf-opt-row");
        if (ro) { [".rf-opt-name", ".rf-opt-pay"].forEach(function (sel) { var e = ro.querySelector(sel); if (e && e.value) e.classList.add("rf-shop-filled"); }); }
      });
      if (dup) skipped.push("이미 있는 옵션 " + dup + "개");
      if (reused) extra = " 옵션 이름이 비어 있던 줄 " + reused + "개에 앞 옵션부터 넣었습니다(그 줄의 모집인원·일건수는 그대로).";
      if (typeof _ugAttachAll === "function") _ugAttachAll();
    } else if (checked("rsUsePay")) {
      var rows = Array.prototype.filter.call(box.querySelectorAll(".rf-opt-row"), function (x) { return x.dataset.status !== "closed"; });
      if (box.dataset.unit === "product" && rows.length) { if (!fill(rows[0].querySelector(".rf-opt-pay"), num(val("rsPay")) || "")) skipped.push("결제금액"); }
      else skipped.push("결제금액(옵션 있는 상품은 옵션 줄마다 정합니다)");
    }

    ["_markDupProductNames", "_optSummary", "renderPartCheck", "_syncPreviewFromOptRows", "_syncGroupTotals", "_rfRefreshCards"].forEach(function (fn) {
      if (typeof window[fn] === "function") { try { window[fn](); } catch (_) { /* 화면 갱신 실패는 채운 값을 되돌리지 않는다 */ } }
    });
    close();
    // 카드 안에 한 줄 남긴다(토스트는 공고 창 아래에 깔린다)
    var old = box.querySelector(".rf-shop-note"); if (old) old.remove();
    var note = document.createElement("p");
    note.className = "rf-shop-note";
    note.textContent = skipped.length
      ? "상품페이지 정보로 채웠습니다 — 건너뛴 항목: " + skipped.join(", ") + ". 노란 칸을 확인한 뒤 저장하세요."
      : "상품페이지 정보로 채웠습니다. 노란 칸을 확인한 뒤 저장하세요.";
    note.textContent += extra;
    var main = box.querySelector(".rf-card-main");
    if (main) main.parentNode.insertBefore(note, main); else box.appendChild(note);
  }

  window.rfImportFromShop = rfImportFromShop;
  window.rfShopImport = { _internals: { payFor: payFor, ask: ask, fill: fill, apply: apply, renderResult: renderResult,
    _set: function (box, result) { _box = box; _result = result; } } };
})();
