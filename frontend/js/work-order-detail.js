/* ══════════════════════════════════════════════════════════════
   작업오더 상세 렌더러 (공유 모듈)

   원래 index-app.js(관리자 대시보드) 안에만 있던 작업오더 상세 본문 렌더와
   그 부속(URL 링크화 · 첨부 이미지 임베드 · 이미지 라이트박스 · 섹션 추출 ·
   작업담당 닉네임 매핑)을 **모듈로 뺐다**.
   통합 작업대에서도 같은 상세를 펼쳐 보여야 하는데, 사본을 만들면
   "관리자 화면엔 이미지가 뜨는데 작업대엔 URL만 뜬다" 같은 드리프트가 난다
   (모집공고 모달을 공유 모듈로 뺀 것과 같은 규율).

   ★ 함수명·본문은 한 글자도 바꾸지 않았다 — index-app.js 의 호출부 4곳과
     onclick/onerror 문자열(woImageModal · _woImgError), 회귀가드가 이름으로 묶여 있다.
   ★ escHtml 은 호스트(index-app.js)에 있던 전역이라, 없는 화면(통합 작업대)을 위해
     모듈이 같은 구현을 자체 보유한다 — 있으면 호스트 것을 그대로 쓴다(동작 불변).

   사용: <script src="js/work-order-detail.js"></script> 를 index-app.js **앞에** 로드.
   ══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // 호스트에 escHtml 이 있으면 그것을, 없으면 같은 구현을 쓴다(통합 작업대).
  //   ★ 전역을 덮어쓰지 않는다 — 호스트의 다른 코드가 쓰는 함수를 바꾸지 않기 위해.
  var escHtml = (typeof window !== "undefined" && typeof window.escHtml === "function")
    ? window.escHtml
    : function (s) {
        return String(s == null ? "" : s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      };

// 텍스트 escape 후 http(s) URL만 링크화 (javascript: 등 차단)
function _woLinkify(text) {
  return escHtml(String(text == null ? "" : text))
    .replace(/(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#1b64da;word-break:break-all">$1</a>');
}

// Drive URL에서 fileId 추출 (/file/d/ID, ?id=ID, /d/ID)
function _driveId(url) {
  const s = String(url);
  const m = s.match(/\/file\/d\/([-\w]{20,})/) || s.match(/[?&]id=([-\w]{20,})/) || s.match(/\/d\/([-\w]{20,})/);
  return m ? m[1] : null;
}

// 이미지 라이트박스(화면 내 팝업) — 화면맞춤으로 열고 [원본크기보기] 토글 제공
function woImageModal(url) {
  let ov = document.getElementById("woImgModal");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "woImgModal";
    ov.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.82);display:none;align-items:center;justify-content:center;padding:24px;cursor:zoom-out;overflow:auto";
    ov.innerHTML =
      '<button id="woImgOrig" style="position:fixed;top:14px;right:60px;z-index:2;background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:8px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)">원본크기보기</button>'
      + '<span id="woImgClose" style="position:fixed;top:9px;right:18px;z-index:2;color:#fff;font-size:32px;line-height:1;cursor:pointer">&times;</span>'
      + '<img id="woImgModalImg" style="border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.5);display:block;margin:auto">'
      + '<div id="woImgModalErr" style="display:none;color:#fff;font-size:14px;text-align:center;max-width:90vw;word-break:break-all"></div>';
    document.body.appendChild(ov);
    const im = ov.querySelector("#woImgModalImg");
    const er = ov.querySelector("#woImgModalErr");
    const btn = ov.querySelector("#woImgOrig");
    const fit = () => {
      im.style.maxWidth = "92vw"; im.style.maxHeight = "88vh"; im.style.width = "auto"; im.style.height = "auto"; im.style.cursor = "zoom-in";
      ov.style.alignItems = "center"; ov.style.justifyContent = "center"; ov.scrollTop = 0;
      btn.textContent = "원본크기보기"; ov._orig = false;
    };
    const orig = () => {
      im.style.maxWidth = "none"; im.style.maxHeight = "none"; im.style.cursor = "zoom-out";
      ov.style.alignItems = "flex-start"; ov.style.justifyContent = "flex-start";
      btn.textContent = "화면맞춤"; ov._orig = true;
    };
    ov._fit = fit; ov._toggle = () => { ov._orig ? fit() : orig(); };
    ov.addEventListener("click", () => { ov.style.display = "none"; });
    btn.addEventListener("click", e => { e.stopPropagation(); ov._toggle(); });
    ov.querySelector("#woImgClose").addEventListener("click", e => { e.stopPropagation(); ov.style.display = "none"; });
    im.addEventListener("click", e => { e.stopPropagation(); ov._toggle(); });
    er.addEventListener("click", e => e.stopPropagation());
    im.addEventListener("error", () => {
      im.style.display = "none"; btn.style.display = "none";
      const u = ov._lastUrl || im.src;
      const dbg = u + (u.indexOf("?") >= 0 ? "&" : "?") + "debug=1";
      er.innerHTML = "이미지를 불러올 수 없습니다.<br><span style='font-size:12px;opacity:.7'>" + u + "</span><br>"
        + "<a href='" + dbg + "' target='_blank' rel='noopener' style='color:#93c5fd'>🔧 진단 정보 보기</a>";
      er.style.display = "block";
    });
    im.addEventListener("load", () => { im.style.display = "block"; btn.style.display = "block"; er.style.display = "none"; });
    document.addEventListener("keydown", e => { if (e.key === "Escape") ov.style.display = "none"; });
  }
  ov._lastUrl = url;
  ov.querySelector("#woImgModalErr").style.display = "none";
  const im = ov.querySelector("#woImgModalImg");
  ov._fit();                       // 항상 화면맞춤으로 시작
  im.style.display = "block";
  im.src = url;
  ov.style.display = "flex";
}

// 이미지 로드 실패 시 → 팝업으로 여는 링크로 대체
function _woImgError(img) {
  const a = document.createElement("a");
  a.href = "#"; a.textContent = "📎 첨부 이미지 보기";
  a.style.cssText = "color:#1b64da;cursor:pointer";
  const u = img.dataset.openurl || img.src;
  a.addEventListener("click", e => { e.preventDefault(); woImageModal(u); });
  img.replaceWith(a);
}

// 팝업으로 열리는 이미지 태그 (카드 내 미리보기 크기 제한)
function _woImgTag(src, openUrl) {
  return `<img src="${escHtml(src)}" data-openurl="${escHtml(openUrl || src)}" style="max-width:min(100%,360px);max-height:240px;width:auto;height:auto;border-radius:8px;margin:4px 0;cursor:zoom-in;border:1px solid #E5E7EB" loading="lazy" title="클릭하면 크게 보기" onclick="woImageModal(this.dataset.openurl||this.src)" onerror="_woImgError(this)">`;
}

// 평문 → 안전 HTML: 줄바꿈 보존, URL 링크화, Drive 파일 URL은 이미지로 자동 임베드
function _woTextToHtml(text) {
  const parts = String(text == null ? "" : text).split(/(https?:\/\/[^\s<]+)/g);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const url = parts[i];
      const isProxy = /\/api\/order\/guide-image\/[-\w]{20,}/.test(url);
      const id = _driveId(url);
      if (isProxy) {
        html += _woImgTag(url, url);
      } else if (id) {
        html += _woImgTag(`https://drive.google.com/thumbnail?id=${id}&sz=w1600`, url);
      } else {
        html += `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:#1b64da;word-break:break-all">${escHtml(url)}</a>`;
      }
    } else {
      html += escHtml(parts[i]).replace(/\n/g, "<br>");
    }
  }
  return html;
}

// 유입가이드 본문 안전 렌더 — 평문(Drive URL 자동 임베드) / HTML(<img>) 양쪽 처리
function _woGuideHtml(raw) {
  if (!raw) return "";
  // HTML 태그가 없으면 평문으로 보고 Drive URL을 이미지로 임베드
  if (!/<[a-z][\s\S]*?>/i.test(raw)) return _woTextToHtml(raw);
  const tmp = document.createElement("div");
  tmp.innerHTML = raw;
  tmp.querySelectorAll("script,style,iframe,object,embed,link").forEach(n => n.remove());
  tmp.querySelectorAll("*").forEach(el => {
    [...el.attributes].forEach(a => {
      const n = a.name.toLowerCase();
      if (n.startsWith("on")) el.removeAttribute(a.name);
      if ((n === "href" || n === "src") && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
    });
  });
  tmp.querySelectorAll("img").forEach(img => {
    img.style.maxWidth = "min(100%,360px)";
    img.style.maxHeight = "240px";
    img.style.width = "auto";
    img.style.height = "auto";
    img.style.borderRadius = "8px";
    img.style.margin = "4px 0";
    img.style.border = "1px solid #E5E7EB";
    img.style.cursor = "zoom-in";
    img.loading = "lazy";
    img.title = "클릭하면 크게 보기";
    // 새 탭 대신 팝업으로 열기 (부모 <a> 링크는 무력화)
    img.setAttribute("onclick", "woImageModal(this.src);return false;");
    const a = img.closest("a");
    if (a) { a.removeAttribute("target"); a.setAttribute("href", "javascript:void(0)"); }
  });
  return tmp.innerHTML;
}

const _INFLOW_LABEL = { guide: "유입가이드", link: "링크유입" };

// 인트라넷이 review_guide/special_notes에 [헤더] 섹션으로 모든 항목을 중복 포함시켜 보내므로,
// 개별 필드로 이미 표시되는 섹션은 버리고 지정한 라벨의 섹션 내용만 추출한다.
// 섹션 헤더가 전혀 없으면(우리 키트/스태프의 평문) 원문 그대로 반환.
function _woPickSections(raw, keepLabels) {
  const text = String(raw == null ? "" : raw);
  if (!text.trim()) return "";
  if (!/\[[^\]]+\]/.test(text)) return text.trim();
  const norm = s => s.replace(/\s/g, "");
  const keep = keepLabels.map(norm);
  const lines = text.split(/\r?\n/);
  const out = [];
  let take = false, buf = [];
  const flush = () => { const c = buf.join("\n").trim(); if (take && c) out.push(c); buf = []; };
  for (const ln of lines) {
    const m = ln.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
    if (m) {
      flush();
      take = keep.some(k => norm(m[1]).includes(k));
      buf = m[2] ? [m[2]] : [];
    } else {
      buf.push(ln);
    }
  }
  flush();
  return out.join("\n\n").trim();
}

// ── 카톡 ▶형식 렌더 (팀채팅방 게시 가독성) ──
function _woLinkHtml(url) {
  const u = (url == null) ? "" : String(url).trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u)
    ? `<a href="${escHtml(u)}" target="_blank" rel="noopener noreferrer" style="color:#1b64da;word-break:break-all">${escHtml(u)}</a>`
    : escHtml(u);
}

// 한 줄 항목:  ▶ 라벨 : 값
function _woKv(label, val) {
  if (val == null || val === "") return "";
  return `<div style="font-size:.8rem;color:#1F2937;margin:2px 0;line-height:1.65;word-break:break-word"><span style="color:#3182f6;font-weight:700">▶</span> <b>${escHtml(label)}</b> : ${escHtml(String(val))}</div>`;
}

// 멀티라인 섹션:  ▶ 라벨 ◀  (다음 줄에 내용)
// 멀티라인/단일라인 자동: 1줄이면 '▶ 라벨 : 값', 2줄+면 '▶ 라벨 :' 후 줄바꿈
function _woSection(label, rawText, renderFn) {
  const txt = (rawText == null ? "" : String(rawText)).replace(/\s+$/, "");
  if (!txt.trim()) return "";
  const multi = /\n/.test(txt.trim());
  const inner = renderFn(txt);
  const lab = `<span style="color:#3182f6;font-weight:700">▶</span> <b>${escHtml(label)}</b> :`;
  if (!multi) {
    return `<div style="font-size:.8rem;color:#1F2937;margin:2px 0;line-height:1.65;word-break:break-word">${lab} ${inner}</div>`;
  }
  return `<div style="margin-top:4px"><div style="font-size:.8rem;color:#1F2937;line-height:1.6">${lab}</div><div style="font-size:.79rem;color:#374151;margin-top:1px;line-height:1.6;word-break:break-word">${inner}</div></div>`;
}

// 유입가이드 본문 정리: "[유입가이드 첨부 이미지]" 헤더, "1. xxx.png (..저장됨)" 파일정보 라인 제거
function _woCleanGuide(raw) {
  if (!raw || !String(raw).trim()) return "";
  return String(raw).split(/\r?\n/)
    .filter(ln => !/^\s*\[유입가이드\s*첨부\s*이미지\]\s*$/.test(ln))
    .filter(ln => !/^\s*\d+\.\s.*\(.*저장됨\)\s*$/.test(ln))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
}

function _woProductLines(o) {
  const lines = [];
  // 1) 구조화 JSON 우선
  let arr = null;
  try { const p = JSON.parse(o.product_options_json || "[]"); if (Array.isArray(p) && p.length) arr = p; } catch (_) {}
  if (arr) {
    for (const prod of arr) {
      const name = (prod.name || "").trim();
      const opts = Array.isArray(prod.options) ? prod.options : [];
      if (opts.length) {
        for (const op of opts) {
          const lab = (op.label || "").trim();
          const pay = Number(op.pay) || 0;
          lines.push(`${name}${lab ? " " + lab : ""}${pay ? " - 결제금액 " + pay.toLocaleString() + "원" : ""}`.trim());
        }
      } else {
        const pay = Number(prod.base && prod.base.pay) || 0;
        lines.push(`${name}${pay ? " - 결제금액 " + pay.toLocaleString() + "원" : ""}`.trim());
      }
    }
  } else {
    // 2) product_option 텍스트 파싱: "1. 상품명" + "- [옵션] / 결제금액 N원"
    const cleaned = _woCleanProductOption(o.product_option, o.product_url);
    if (!cleaned) return "";
    let curName = "", curHadOpt = false;
    const flushNameOnly = () => { if (curName && !curHadOpt) lines.push(curName); };
    for (const raw of cleaned.split(/\r?\n/)) {
      const t = raw.trim();
      if (!t) continue;
      const mName = t.match(/^\d+\.\s*(.+)$/);            // "1. 멀티비타민"
      if (mName) { flushNameOnly(); curName = mName[1].trim(); curHadOpt = false; continue; }
      const opt = t.replace(/^[-•]\s*/, "");              // "옵션 없음 / 결제금액 26,900원"
      const payM = opt.match(/결제금액\s*([\d,]+)\s*원/);
      const pay = payM ? payM[1] : "";
      let optLabel = opt.split("/")[0].trim();
      if (/^옵션\s*없음$/.test(optLabel)) optLabel = "";   // "옵션 없음" 생략
      lines.push(`${curName}${optLabel ? " " + optLabel : ""}${pay ? " - 결제금액 " + pay + "원" : ""}`.trim());
      curHadOpt = true;
    }
    flushNameOnly();
  }
  const clean = lines.filter(Boolean);
  if (!clean.length) return "";
  // 링크유입이면 상품 순서대로 유입링크를 같은 줄에 붙임
  let withUrl = clean;
  if (o.inflow_type === "link") {
    const urls = _woGuideUrls(o.inflow_guide);
    withUrl = clean.map((l, i) => urls[i] ? `${l} ${urls[i]}` : l);
  }
  if (withUrl.length === 1) return withUrl[0];               // 1개 → 인라인
  return withUrl.map((l, i) => `${i + 1}.${l}`).join("\n");  // 2개+ → 번호+줄바꿈
}

// 작업오더 상세 본문 (카드/간편보기 공용) — 카톡 ▶형식
function _woDetailHtml(o) {
  const prodText = _woProductLines(o);
  const guide = _woCleanGuide(o.inflow_guide);
  const rg = _woPickSections(o.review_guide, ["리뷰등록 가이드", "리뷰가이드", "리뷰 가이드"]);
  const sn = _woPickSections(o.special_notes, ["특이사항"]);
  const txtR = t => _woLinkify(t).replace(/\n/g, "<br>");   // 텍스트(줄바꿈 보존)
  const urlR = t => _woLinkHtml(t);                          // 단일 URL
  const guideR = t => _woGuideHtml(t);                       // 가이드(이미지 임베드)
  return [
    // 담당AE = 인트라넷 표기 실명 우선, 없으면 제출 계정. 작업담당은 매핑 닉네임을 병기(065).
    _woKv("담당AE", o.manager_name || o.created_by),
    _woKv("작업담당", _woManagerLabel(o.work_manager)),
    _woSection("상품·옵션", prodText, txtR),
    _woKv("모집인원", o.recruit_count ? Number(o.recruit_count).toLocaleString() + "명" : ""),
    _woKv("일일진행건수", o.daily_count_text || o.daily_count),
    _woKv("구매시간대", o.purchase_time),
    _woKv("유입방식", _INFLOW_LABEL[o.inflow_type] || o.inflow_keyword || ""),
    _woKv("배송유형", o.delivery_type),
    _woKv("택배대행", o.courier_proxy ? "예" : ""),
    _woKv("리뷰유형", o.review_type),
    _woKv("물건비", o.goods_cost_type),
    _woSection("상품확인용URL", o.product_url, urlR),
    _woSection("작업시트탭URL", o.work_sheet_url, urlR),
    rg ? _woSection("리뷰가이드", rg, txtR) : "",
    sn ? _woSection("특이사항", sn, txtR) : "",
    o.inflow_type === "link"
      ? _woKv("유입방법", "링크유입")
      : (guide ? _woSection("유입가이드", guide, guideR) : ""),
  ].join("");
}

const WO_MANAGER_MAP = { '박세희': '만두', '박은비': '망고' };

const WO_MANAGER_UNDECIDED = ['랜덤', '랜덤배정', '미정'];

function _woManagerNick(raw) {
  const v = _woNormName(raw);
  if (!v) return "";
  for (const [name, nick] of Object.entries(WO_MANAGER_MAP)) if (v.includes(name)) return nick;
  for (const nick of Object.values(WO_MANAGER_MAP)) if (v.includes(nick)) return nick;
  return "";
}

function _woManagerUndecided(raw) {
  const v = _woNormName(raw);
  return !!v && WO_MANAGER_UNDECIDED.some(u => v.includes(u));
}

/** 표시용: '박세희 (만두)' · '랜덤 (직접결정)' */
function _woManagerLabel(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (_woManagerUndecided(v)) return v + " (직접결정)";
  const nick = _woManagerNick(v);
  return nick ? v + " (" + nick + ")" : v;
}

// 상품·옵션 요약에서 아래 개별 필드와 중복되는 값 제거:
//  - [합계]/합계 라인(모집인원·총구입비), 구분선
//  - 상품 URL(= 상품확인용URL 필드와 중복) 및 바레 URL
function _woCleanProductOption(raw, productUrl) {
  if (!raw || !String(raw).trim()) return "";
  const pu = (productUrl || "").trim();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = [];
  for (let ln of String(raw).split(/\r?\n/)) {
    const t = ln.trim();
    if (/^\[?\s*합계/.test(t)) continue;            // [합계]/합계 라인 제거
    if (/^소계\s*[:：]/.test(t)) continue;           // 독립 '소계:' 라인 제거(키트 형식)
    if (/^\[\s*상품/.test(t)) continue;              // [상품/옵션/건수] 헤더 제거(상위 라벨과 중복)
    if (/^[─—\-]{3,}$/.test(t)) continue;            // 구분선 제거
    ln = ln.replace(/\(\s*https?:\/\/[^)]*\)/g, "");  // (http URL) 제거
    if (pu) ln = ln.replace(new RegExp("\\(\\s*" + esc(pu) + "\\s*\\)", "g"), ""); // (상품URL) 제거
    ln = ln.replace(/\s*https?:\/\/\S+/g, "");        // 바레 URL 제거
    // 건수(N명/N건)·소계·라인합계 제거 — 옵션명+결제금액만 남김 (모집인원/총구입비는 아래 필드와 중복)
    ln = ln.replace(/\s*\/\s*소계\s*[\d,]+\s*원/g, "")
           .replace(/\s*\/\s*\d[\d,]*\s*[명건]/g, "")
           .replace(/\s*[×x]\s*\d[\d,]*\s*[명건]/g, "")
           .replace(/\s*=\s*[\d,]+\s*원/g, "")
           .replace(/\s*\/\s*$/, "");
    ln = ln.replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/, "");
    out.push(ln);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// inflow_guide 등에서 http(s) URL을 순서대로 추출
function _woGuideUrls(raw) {
  const urls = [];
  const re = /https?:\/\/[^\s<]+/g;
  let m;
  while ((m = re.exec(String(raw == null ? "" : raw)))) urls.push(m[0]);
  return urls;
}

function _woNormName(v) { return String(v || "").replace(/\s+/g, "").replace(/[()（）[\]]/g, ""); }
  // 전역 공개 — index-app.js 의 기존 호출부와 onclick/onerror 문자열이 이름 그대로 쓴다.
  //   (모듈 안에서 선언만 하면 admin 화면의 기존 호출이 전부 깨진다)
  var EXPORTS = {
    _woLinkify: _woLinkify, _driveId: _driveId, woImageModal: woImageModal,
    _woImgError: _woImgError, _woImgTag: _woImgTag, _woTextToHtml: _woTextToHtml,
    _woGuideHtml: _woGuideHtml, _woPickSections: _woPickSections, _woLinkHtml: _woLinkHtml,
    _woKv: _woKv, _woSection: _woSection, _woCleanGuide: _woCleanGuide,
    _woProductLines: _woProductLines, _woDetailHtml: _woDetailHtml,
    _woManagerNick: _woManagerNick, _woManagerUndecided: _woManagerUndecided,
    _woManagerLabel: _woManagerLabel,
    _woCleanProductOption: _woCleanProductOption, _woGuideUrls: _woGuideUrls, _woNormName: _woNormName,
    _INFLOW_LABEL: _INFLOW_LABEL, WO_MANAGER_MAP: WO_MANAGER_MAP,
    WO_MANAGER_UNDECIDED: WO_MANAGER_UNDECIDED,
  };
  for (var k in EXPORTS) if (Object.prototype.hasOwnProperty.call(EXPORTS, k)) window[k] = EXPORTS[k];
  window.WorkOrderDetail = EXPORTS;
})();
