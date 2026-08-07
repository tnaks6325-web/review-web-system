/* ══════════════════════════════════════════════════════════════
   작업오더 상세 렌더러 (공유 모듈)

   원래 index-app.js(관리자 대시보드) 안에만 있던 작업오더 상세 본문 렌더와
   그 부속(URL 링크화 · 첨부 이미지 임베드 · 이미지 라이트박스 · 섹션 추출 ·
   작업담당 닉네임 매핑)을 **모듈로 뺐다**.
   리뷰웹시스템[3버전]에서도 같은 상세를 펼쳐 보여야 하는데, 사본을 만들면
   "관리자 화면엔 이미지가 뜨는데 작업보드엔 URL만 뜬다" 같은 드리프트가 난다
   (모집공고 모달을 공유 모듈로 뺀 것과 같은 규율).

   ★ 함수명·본문은 한 글자도 바꾸지 않았다 — index-app.js 의 호출부 4곳과
     onclick/onerror 문자열(woImageModal · _woImgError), 회귀가드가 이름으로 묶여 있다.
   ★ escHtml 은 호스트(index-app.js)에 있던 전역이라, 없는 화면(리뷰웹시스템[3버전])을 위해
     모듈이 같은 구현을 자체 보유한다 — 있으면 호스트 것을 그대로 쓴다(동작 불변).

   사용: <script src="js/work-order-detail.js"></script> 를 index-app.js **앞에** 로드.
   ══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* escHtml — 호스트(index-app.js)의 것을 쓰되 **호출 시점에** 찾는다.
     ★ 로드 시점에 캡처하면 안 된다: 이 모듈은 index-app.js **앞에** 로드되므로
       그때는 window.escHtml 이 아직 없어 늘 폴백이 잡힌다. 폴백이 원본과 한 글자라도
       다르면(예: null 처리, 작은따옴표 이스케이프) 관리자 화면 출력이 조용히 달라진다.
     ★ 폴백은 index-app.js 의 escHtml 과 **동일 구현**(String(s) · & < > " 만). */
  function _escFallback(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escHtml(s) {
    var h = (typeof window !== "undefined") && window.escHtml;
    return (typeof h === "function" && h !== escHtml) ? h(s) : _escFallback(s);
  }

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
      // ★★ 옵션 **없는** 상품의 줄은 인트라넷이 "- 결제금액 22,000원 / 5명 / 소계 …" 로 만든다 —
      //   첫 '/'-조각이 곧 금액 표현이라 그대로 라벨로 쓰면
      //   "상품명 결제금액 22,000원 - 결제금액 22,000원" 오염 문장이 나오고(2026-08-07 우레온 실측),
      //   그 문장이 발행 표로 넘어가 **상품명 조각이 옵션명으로 승격**되는 사고의 재료가 된다.
      //   → 금액·건수 표현을 걷어낸 뒤 남는 글자가 있을 때만 옵션명으로 인정한다.
      let optLabel = opt.split("/")[0]
        .replace(/결제금액\s*[\d,]+\s*원?/g, "")
        .replace(/소계\s*[\d,]+\s*원?/g, "")
        .replace(/^[\s\-–·|]+|[\s\-–·|]+$/g, "")
        .trim();
      if (/^옵션\s*없음$/.test(optLabel)) optLabel = "";   // "옵션 없음" 생략
      if (/^[\d,]+\s*[명건원]?$/.test(optLabel)) optLabel = "";  // 숫자만 남은 조각(건수·금액 잔여) = 옵션명 아님
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
  // 구조 첨부(090) — 유입 원문·리뷰가이드 원문에 이미 있는 URL(토큰)은 제외 = 이중 표기 없음
  const structDetailImgs = _woReviewImgHtml(_woGuideImages(o).join("\n"), String(o.inflow_guide || "") + String(o.review_guide || ""));
  const rg = _woPickSections(o.review_guide, ["리뷰등록 가이드", "리뷰가이드", "리뷰 가이드"]);
  const sn = _woPickSections(o.special_notes, ["특이사항"]);
  const txtR = t => _woLinkify(t).replace(/\n/g, "<br>");   // 텍스트(줄바꿈 보존)
  const urlR = t => _woLinkHtml(t);                          // 단일 URL
  const guideR = t => _woGuideHtml(t);                       // 가이드(이미지 임베드)
  return [
    // 담당AE = 인트라넷 표기 실명 우선, 없으면 제출 계정. 작업담당은 매핑 닉네임을 병기(065).
    _woKv("담당AE", o.manager_name || o.created_by),
    _woKv("작업담당", _woManagerLabel(o.work_manager)),
    // 계약건(088) — 인트라넷 리뷰오더 등록에서 고른 계약. 접수하면 이 계약이 정산에 자동 연결된다.
    //   ★ 값이 없는 과거 오더는 줄 자체가 안 나온다(_woKv 가 빈 값을 버림) = 종전 화면 그대로.
    _woKv("계약건", o.contract_number),
    _woSection("상품·옵션", prodText, txtR),
    _woKv("모집인원", o.recruit_count ? Number(o.recruit_count).toLocaleString() + "명" : ""),
    _woKv("일일진행건수", o.daily_count_text || o.daily_count),
    _woKv("구매시간대", o.purchase_time),
    _woKv("유입방식", _INFLOW_LABEL[o.inflow_type] || o.inflow_keyword || ""),
    _woKv("배송유형", o.delivery_type),
    _woKv("택배대행", o.courier_proxy ? "예" : ""),
    _woKv("리뷰타입", o.review_type),
    _woKv("물건비", o.goods_cost_type),
    _woSection("상품확인용URL", o.product_url, urlR),
    _woSection("작업시트탭URL", o.work_sheet_url, urlR),
    rg ? _woSection("리뷰가이드", rg, txtR) : "",
    sn ? _woSection("특이사항", sn, txtR) : "",
    o.inflow_type === "link"
      ? _woKv("유입방법", "링크유입")
      : (guide ? _woSection("유입가이드", guide, guideR)
               : (structDetailImgs ? _woSection("유입가이드", "첨부 이미지", txtR) : "")),
    // 구조 첨부(guide_images, 090) — 텍스트 안 URL 과 토큰 중복 제거라 과도기(양쪽 전송)엔 빈 값 = 종전 화면 그대로.
    //   인트라넷이 텍스트 블록을 끊는 시점부터 이 블록이 이미지를 담당한다.
    o.inflow_type === "link" ? "" : structDetailImgs,
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

/* ══════════════════════════════════════════════════════════════
   작업오더 상태 표기·전이 + 모집공고 프리필 (공유 단일 출처)

   ★ 관리자 대시보드(index-app.js)와 리뷰웹시스템[3버전](workdesk.html)가 **같은 표·같은
     프리필 조립**을 쓴다. 사본을 두면 한 화면에서만 상태 이름이 바뀌거나
     "관리자에서 만든 공고와 작업보드에서 만든 공고의 프리필이 다르다"로 갈라진다
     (작업오더 상세 렌더러를 이 모듈로 뺀 것과 같은 규율).
   ★ 상태 라벨은 **비개발자가 읽는 말**이다 — 영문 상태값(submitted/reviewing…)을
     화면에 노출하지 않는다. 전이도 서버 ORDER_TRANSITIONS 와 같은 표만 제시한다.
   ══════════════════════════════════════════════════════════════ */
const WO_LABELS = {
  submitted:'접수대기', reviewing:'접수완료', await_chatroom:'채팅방대기',
  published:'공고발행', done:'완료', rejected:'반려', revision:'보완요청',
};
/* 상태 변경 버튼 아래 한 줄 설명 — "이걸 누르면 무슨 일이 일어나는가"를 한국어로.
   ★ 접수(탭 등록)는 [접수하기] 버튼이 한다. 여기서 '접수완료'로 바꾸는 것은 **표시만** 바꾸는 것이라
     그 사실을 문장에 그대로 적는다(수동 전이로 탭이 등록됐다고 착각하면 리뷰어 검색이 안 열린다). */
const WO_STATUS_HINTS = {
  submitted:      'AE가 제출한 상태로 되돌립니다.',
  reviewing:      '접수완료로 표시합니다. (시트·탭 등록은 [접수하기] 버튼이 합니다)',
  await_chatroom: '카톡 팀채팅방이 만들어지길 기다리는 상태로 둡니다.',
  published:      '모집공고를 발행한 상태로 표시합니다. (카톡 팀채팅방URL 필요)',
  done:           '이 작업을 종료 처리합니다. 되돌릴 수 없습니다.',
  rejected:       '반려합니다. 사유를 적으면 AE에게 전달됩니다.',
  revision:       'AE에게 보완을 요청합니다. 사유를 적으면 그대로 전달됩니다.',
};
const WO_COLORS = {
  submitted:['#e8f1fe','#1b64da'], reviewing:['#DBEAFE','#1E40AF'],
  await_chatroom:['#FEF3C7','#92400E'], published:['#e8f1fe','#1b64da'],
  done:['#D1FAE5','#065F46'], rejected:['#FEE2E2','#991B1B'], revision:['#FFEDD5','#9A3412'],
};

const WO_TRANSITIONS = {
  submitted:      ['reviewing', 'rejected', 'revision'],
  reviewing:      ['await_chatroom', 'rejected', 'revision'],
  await_chatroom: ['published', 'reviewing', 'rejected'],
  published:      ['done'],
  done:           [],
  rejected:       ['reviewing'],
  revision:       ['reviewing'],
};

const WO_DELIVERY_MAP = { '실배송':'실배송', '빈박스':'빈택배' };

/* ★ 구매채널 = 상품 URL의 **호스트**로 판정한다.
   쿼리스트링까지 보면 `coupang.com/...?src=naver_ad` 같은 광고 링크를 네이버로 오판한다.
   채널은 현금영수증 발행방법 이미지·리뷰어 안내를 가르는 값이라 오판 비용이 크다.
   판정되지 않으면 빈 값 = 관리자가 직접 선택(틀린 값보다 빈 값). */
const WO_CHANNEL_HOSTS = [
  { re: /(^|\.)coupang\.com$|coupangcdn\.com$/i, val: '쿠팡' },
  { re: /(^|\.)naver\.com$|(^|\.)naver\.me$/i,   val: '네이버' },
  { re: /(^|\.)oliveyoung\.co\.kr$/i,            val: '올리브영' },
  /* ★ 카카오는 `makers.kakao.com` 만 잡는다 — `kakao.com` 전체를 잡으면
     톡스토어·선물하기 등 진행 방식이 다른 서비스까지 '카카오메이커스'로 오판한다. */
  { re: /(^|\.)makers\.kakao\.com$/i,            val: '카카오메이커스' },
];
function _woChannelFromUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  let host = '';
  try { host = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname; } catch (_) { return ''; }
  const hit = WO_CHANNEL_HOSTS.find(h => h.re.test(host));
  return hit ? hit.val : '';
}
/** 작업오더에서 채널 추정 — 상품 URL 우선, 없으면 유입가이드의 첫 링크 */
function _woChannel(o) {
  return _woChannelFromUrl(o.product_url)
      || _woChannelFromUrl((typeof _woGuideUrls === "function" ? _woGuideUrls(o.inflow_guide)[0] : "") || "");
}

/** 작업오더 product_options_json → 캠페인 옵션표 행 [{optKey,payAmount,recruitTotal,dailyLimit}].
 *  옵션 2개 이상일 때만 반환(단일=옵션 없는 상품). 정원·하루건수는 오더에 없어 0(관리자 입력). */
function _woOptionRows(o) {
  let arr = null;
  try { const p = JSON.parse(o.product_options_json || "[]"); if (Array.isArray(p) && p.length) arr = p; } catch (_) {}
  if (!arr) return [];
  const clean = s => String(s || "").replace(/\|/g, "").trim();
  const rows = [];
  for (const prod of arr) {
    const name = clean(prod.name);
    const opts = Array.isArray(prod.options) ? prod.options : [];
    const basePay = Number(prod.base && prod.base.pay) || 0;
    if (opts.length) {
      for (const op of opts) {
        const lab = clean(op.label);
        // "옵션 없음"류는 옵션명이 아니라 '옵션이 없다'는 서술 — 옵션 없는 상품 행으로 떨군다.
        const isNone = !lab || /^(옵션\s*없음|없음|단일(상품)?|해당\s*없음)$/.test(lab);
        rows.push({
          productName: name,
          // ★ 옵션명에 상품명을 붙이지 않는다 — opt_key 는 시트 옵션열에 그대로 기입되므로
          //   상품명이 섞이면 리뷰형태(텍스트/포토리뷰) 칸이 상품명으로 덮이는 사고가 난다.
          optKey: isNone ? "" : lab,
          payAmount: Number(op.pay) || basePay,
          // ★ 옵션별 건수가 오면 옵션 정원으로 프리필(인트라넷 구조 신호) — 없으면 0(관리자 입력).
          //   하루건수는 오더에 옵션 단위로 없어 종전대로 관리자가 정한다.
          recruitTotal: Math.max(0, Number(op.count) || 0), dailyLimit: 0,
        });
      }
    } else if (name) {
      // ★ 옵션이 없는 상품 — 상품명을 옵션명으로 승격시키지 않는다(상품명 칸으로만 간다).
      rows.push({ productName: name, optKey: "", payAmount: basePay, recruitTotal: 0, dailyLimit: 0 });
    }
  }
  // 서로 다른 상품에 같은 옵션명이 있을 때만 상품명을 붙여 구분(옵션명은 공고 안에서 유일해야 한다).
  const dup = new Map();
  rows.forEach(r => { if (r.optKey) dup.set(r.optKey, (dup.get(r.optKey) || 0) + 1); });
  rows.forEach(r => {
    if (r.optKey && dup.get(r.optKey) > 1 && r.productName) r.optKey = clean(r.productName + " " + r.optKey);
  });
  // 옵션이 1개뿐이면 옵션 없는 단일상품 취급(옵션 기능은 2개 이상일 때 opt-in)
  //  → 종전대로 빈 배열을 돌려 텍스트 분해 경로(parseProductLinesToRows)로 넘긴다(동작 불변).
  return rows.filter(r => r.optKey).length >= 2 ? rows : [];
}

// 평문 유입가이드 → 리뷰어 노출용 HTML: 첨부 이미지 URL(guide-image 프록시·Drive)을 실제 <img>로,
// 일반 URL은 <a>로. 이미지가 하나도 없으면 ""(기존 평문 경로 유지 — 동작 불변).
// "[유입가이드 첨부 이미지]" 헤더·"N. 파일명 (…저장됨)" 메타 라인은 _woCleanGuide로 제거.
// 서버 sanitize(allowedTags img/a…)와 campaign.html의 .wd-body img 스타일에 맞춘 무스타일 태그만 생성.
function _woPlainGuideToHtml(raw) {
  const cleaned = (typeof _woCleanGuide === "function") ? _woCleanGuide(raw) : String(raw || "");
  if (!cleaned.trim()) return "";
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const parts = cleaned.split(/(https?:\/\/[^\s<]+)/g);
  let html = "", hasImg = false;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const url = parts[i];
      const isProxy = /\/api\/order\/guide-image\/[-\w]{20,}/.test(url);
      const id = (typeof _driveId === "function") ? _driveId(url) : "";
      if (isProxy) { html += `<img src="${esc(url)}" alt="유입가이드 이미지">`; hasImg = true; }
      else if (id) { html += `<img src="https://drive.google.com/thumbnail?id=${id}&sz=w1600" alt="유입가이드 이미지">`; hasImg = true; }
      else html += `<a href="${esc(url)}">${esc(url)}</a>`;
    } else {
      html += esc(parts[i]).replace(/\n/g, "<br>");
    }
  }
  return hasImg ? html : "";
}

// review_guide의 [유입가이드 첨부 이미지] 등에 섞여온 첨부 이미지(guide-image 프록시·Drive)만 <img> HTML로.
// existingHtml에 이미 있는 URL은 스킵(중복 방지). 텍스트는 무시 — 이미지만 유입가이드로 승격.
function _woReviewImgHtml(raw, existingHtml) {
  const urls = (typeof _woGuideUrls === "function") ? _woGuideUrls(raw) : [];
  const seen = String(existingHtml || "");
  let out = ""; const used = {};
  for (const u of urls) {
    let src = "", tok = "";
    const pm = String(u).match(/\/api\/order\/guide-image\/([-\w]{20,})/);
    // 호스트는 신뢰 베이스(API_BASE_URL)로 재구성 — 매칭 URL의 임의 호스트를 그대로 쓰지 않음(Drive 분기와 동일)
    if (pm) { tok = pm[1]; src = (typeof API_BASE_URL !== "undefined" ? API_BASE_URL : "") + "/api/order/guide-image/" + tok; }
    else { const id = (typeof _driveId === "function") ? _driveId(u) : null; if (id) { src = "https://drive.google.com/thumbnail?id=" + id + "&sz=w1600"; tok = id; } }
    if (!src || !tok) continue;
    // 파일ID 토큰 기준 중복 제거(교차 오리진 프록시 URL 이중노출 방지)
    if (used[tok] || seen.indexOf(tok) >= 0) continue;
    used[tok] = 1;
    const esc = String(src).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    out += `<img src="${esc}" alt="유입가이드 이미지">`;
  }
  return out;
}

// guide_images(090 · 칸=칸 매핑 2단계) — 첨부 이미지 URL 배열. DB 는 JSON 문자열, 화면 전달은 배열일 수
// 있어 양쪽 다 받는다. 파싱 실패·비배열은 [](= 종전 텍스트 블록 승격 경로 폴백, 가산적).
function _woGuideImages(o) {
  try {
    const v = o && o.guide_images;
    if (!v) return [];
    const arr = Array.isArray(v) ? v : JSON.parse(String(v));
    return Array.isArray(arr) ? arr.filter(u => typeof u === "string" && u.trim()) : [];
  } catch (_) { return []; }
}

// 발행 프리필용 유입가이드 HTML: inflow_guide 본문(이미지 포함) + 구조 첨부(guide_images, 090)
// + review_guide에 섞여온 첨부 이미지 승격. 셋 다 **파일ID 토큰 기준 중복 제거**라 인트라넷이
// 텍스트 블록과 배열을 함께 보내는 과도기에도 같은 이미지가 두 번 그려지지 않는다.
// 이미지가 하나도 없고 평문 유입가이드면 "" 반환(호출부가 wd_inflow_text 평문 경로 사용 = 기존 동작).
function _woBuildInflowHtml(o) {
  if (o.inflow_type === "link") return "";
  let base = "";
  if (o.inflow_guide) {
    base = /<[a-z][^>]*>/i.test(o.inflow_guide) ? o.inflow_guide
         : (typeof _woPlainGuideToHtml === "function" ? _woPlainGuideToHtml(o.inflow_guide) : "");
  }
  const structImgs = _woReviewImgHtml(_woGuideImages(o).join("\n"), base);
  const imgs = structImgs + _woReviewImgHtml(o.review_guide, base + structImgs);
  if (!imgs) return base;   // 승격할 이미지 없음 → base 그대로(빈 문자열이면 평문 경로)
  // 이미지는 있는데 base가 비면(평문 inflow_guide·이미지 없음) 그 텍스트를 escape해 함께 보존
  if (!base && o.inflow_guide && !/<[a-z][^>]*>/i.test(o.inflow_guide)) {
    const cleaned = (typeof _woCleanGuide === "function") ? _woCleanGuide(o.inflow_guide) : String(o.inflow_guide || "");
    if (cleaned) base = cleaned.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  }
  return base + imgs;
}

/* 리뷰가이드 프리필용 메타 줄 스트립(4칸 정리 개선 ② — docs/design-campaign-field-cleanup.html):
   구조 필드가 이미 담당하는 값(유입 라벨·첨부 이미지 메타·상품번호·옵션:결제금액)이
   리뷰가이드 텍스트에 남아 리뷰어 화면에 이중 표기되던 것을 걷어낸다.
   ★ 줄 단위 · 패턴이 확실한 것만 지운다 — 본문 문장을 지우는 오탐이, 메타를 놓치는 것보다 나쁘다.
     (문장 속 '결제금액'·'상품번호를 확인' 같은 서술은 콜론·라벨 형식이 아니라 안 걸린다) */
function _woStripReviewMeta(raw) {
  if (!raw || !String(raw).trim()) return "";
  return String(raw).split(/\r?\n/)
    .filter(ln => !/^\s*\[(유입방식|유입가이드|링크유입)\]/.test(ln))                          // 유입 라벨 줄(전문 폴백 케이스)
    .filter(ln => !/^\s*\[[^\]]*첨부\s*이미지\]\s*$/.test(ln))                                 // [유입가이드 첨부 이미지]
    .filter(ln => !/^\s*\d+\.\s.*\((?:[^)]*(?:저장됨|업로드))[^)]*\)\s*$/.test(ln))            // 1. 파일명.png (29KB, Drive 저장됨)
    .filter(ln => !/^\s*https?:\/\/\S*(?:guide-image\/|drive\.google\.com)\S*\s*$/i.test(ln))  // 첨부 저장 주소 단독 줄
    .filter(ln => !/^\s*(?:쿠팡\s*)?상품번호\s*[:：]/.test(ln))                                // 쿠팡상품번호: …
    .filter(ln => !/^\s*▶\s*옵션\s*[:：]\s*결제금액\s*◀/.test(ln))                            // ▶옵션:결제금액◀…
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 작업오더의 첫 상품명·결제금액 → 공고 상품정보 기본값 (자동수집 실패해도 폼에 기본 표시)
function _woFirstProductInfo(o) {
  // 1) 구조화 JSON 우선
  try {
    const p = JSON.parse(o.product_options_json || "[]");
    if (Array.isArray(p) && p.length) {
      const prod = p[0] || {};
      const name = (prod.name || "").trim();
      const opts = Array.isArray(prod.options) ? prod.options : [];
      const pay = opts.length ? (Number(opts[0] && opts[0].pay) || 0) : (Number(prod.base && prod.base.pay) || 0);
      if (name || pay) return { name, price: pay ? pay.toLocaleString("ko-KR") + "원" : "" };
    }
  } catch (_) {}
  // 2) product_option 텍스트 폴백: "1. 상품명" 줄 + 첫 "결제금액 N원"
  const cleaned = (typeof _woCleanProductOption === "function")
    ? (_woCleanProductOption(o.product_option, o.product_url) || "")
    : String(o.product_option || "");
  const nm = cleaned.match(/^\s*\d+\.\s*(.+)$/m);
  const name = (nm ? nm[1] : (cleaned.split(/\r?\n/).map(s => s.trim()).find(s => s && !/^[-•]/.test(s)) || "")).trim();
  const pm = cleaned.match(/결제금액\s*([\d,]+)\s*원/);
  return { name, price: pm ? pm[1] + "원" : "" };
}

/* ★ 접수 가능 상태 = 서버 order.routes 의 ACCEPT_ELIGIBLE 과 같은 표.
   여기 없는 상태 = **이미 접수된 것**(접수 시 reviewing 으로 넘어간다) →
   화면은 [접수하기] 대신 [✓ 접수완료]를 비활성으로 보여 눌러도 아무 일 없는 버튼을 없앤다. */
const WO_ACCEPT_ELIGIBLE = ['submitted', 'revision', 'rejected'];
function _woAcceptable(o) { return WO_ACCEPT_ELIGIBLE.indexOf(String((o && o.status) || 'submitted')) >= 0; }
function _woAccepted(o) { return !_woAcceptable(o); }


/* ══════════════════════════════════════════════════════════════
   작업오더 → 모집공고 발행폼 프리필 조립 (단일 출처)
   ★ 어떤 칸이 자동으로 차는지는 문서 `frontend/docs/작업오더-모집공고_자동반영_와이어프레임.html`
     와 회귀가드(tests/woCampaignMapDoc.test.js)가 함께 고정한다.
   ══════════════════════════════════════════════════════════════ */
function _woCampaignPrefill(o) {
  o = o || {};
  const _pi = (typeof _woFirstProductInfo === "function") ? _woFirstProductInfo(o) : { name: "", price: "" };
  // 유입가이드 HTML(본문 + review_guide에 섞여온 첨부 이미지 승격) — 아래 wd_inflow_html/text 분기에 공용
  const _wdInflowHtml = (typeof _woBuildInflowHtml === "function") ? _woBuildInflowHtml(o) : "";
  const prefill = {
    // ★ 공고 제목 = 상품명 우선(리뷰어 노출용 — 업체명·건수·배송유형 미노출), 없으면 오더 제목 폴백. 관리자 자유 수정 가능.
    title:         _pi.name || o.title || "",
    time_range:    o.purchase_time || "",
    max_slots:     o.recruit_count || 0,
    chat_url:      o.chat_room_url || "",
    delivery_type: WO_DELIVERY_MAP[o.delivery_type] || "",
    // ★ 087: 리뷰타입 — 인트라넷 발주 폼의 값이 그대로 온다(`포토` · `구매확정` ·
    //   `혼합(포토 10건, 텍스트 20건, …)`). 표준 key 변환은 발행 폼이 하고 저장 시 서버가 다시 정규화한다.
    //   ★ 여기서 미리 변환하지 않는 이유 = 이 모듈은 상세 표시도 겸해 **원문**을 그대로 보여줘야 한다.
    review_type:   o.review_type || "",
    product_url:   o.product_url || "",
    // ★ 상품정보 기본값 = 작업오더 입력 상품명·결제금액 (자동수집 성공 시 그 값으로 덮어씀)
    product_name:  _pi.name || "",
    price:         _pi.price || "",
    // ★ 유의사항(notes)은 프리필하지 않는다(4칸 정리 개선 ① — docs/design-campaign-field-cleanup.html 원인 1).
    //   공고 카드에 **참여 전 모두에게 공개**되는 칸인데 종전엔 "유입방식: ○○" + review_guide 원문 전체를
    //   붙여 넣어 상품번호·옵션:결제금액·내부 섹션 라벨까지 노출됐다(실측: 장수돌침대 공고).
    //   유입방식은 inflowType(구조 필드)이 이미 담당 — 공개용 안내는 관리자가 직접 쓴다.
    notes:         "",
    // ★ 086: 이체은행은 **값을 강제하지 않고 [자동]으로 둔다** — 서버가 이 오더의 물건비
    //   수취방식에서 파생하므로, 값을 박아두면 나중에 오더가 정정돼도 안 따라간다.
    //   여기서는 화면 안내 문구에 판정 근거만 보여준다.
    goods_cost_type: o.goods_cost_type || "",
    // ★ M3: 참여형 자동 프리필 — 작업오더 세부내용을 발행 폼 스냅샷으로 복사
    participation:  true,
    // ★ 062: 작업오더 시작일 → 발행폼 시작일 프리필(시작일 전 게시 시 "오픈 예정" 카운트다운)
    start_date:     (o.start_date || "").slice(0, 10),
    daily_limit:    o.daily_count || (String(o.daily_count_text || "").match(/\d+/) || [])[0] || "",  // 인트라넷 text형("일 10건") 폴백
    recruit_total:  o.recruit_count || 0,
    purchase_time:  o.purchase_time || "",
    wd_product:     (typeof _woProductLines === "function" ? (_woProductLines(o) || "") : "") || (o.product_option || ""),
    // ★ 리뷰 #2: inflow_guide는 HTML(에디터)·평문(인트라넷/레거시) 두 형태 실존 —
    //   태그가 실제로 있을 때만 raw HTML 경로(이미지 보존), 평문은 escape 경로(개행·'<옵션>' 안전)
    //   ★ 평문이라도 첨부 이미지 URL(guide-image/Drive)이 있으면 <img>로 변환해 raw 경로로 —
    //     + review_guide의 [유입가이드 첨부 이미지]에 섞여온 이미지도 유입가이드로 승격(_woBuildInflowHtml)
    wd_inflow_html: _wdInflowHtml,
    wd_inflow_text: o.inflow_type === "link"
      ? "링크유입 — 아래 [상품 페이지 열기] 버튼으로 진입해 구매를 진행하세요."
      : ((!_wdInflowHtml && o.inflow_guide && !/<[a-z][^>]*>/i.test(o.inflow_guide)) ? o.inflow_guide : ""),
    // ★ 리뷰가이드는 [리뷰등록 가이드] 섹션만 스냅샷 + 메타 줄 스트립(4칸 정리 개선 ②) —
    //   [라벨]이 하나도 없어 전문 폴백될 때도 첨부 파일명·저장 URL·상품번호·▶옵션:결제금액◀ 줄은
    //   걷어낸다(구조 필드가 이미 보여주는 값 — 리뷰어 화면 이중 표기의 원인 2·4).
    wd_review:      _woStripReviewMeta(typeof _woPickSections === "function"
                      ? _woPickSections(o.review_guide, ["리뷰등록 가이드", "리뷰가이드", "리뷰 가이드"])
                      : (o.review_guide || "")),
    wd_notes:       o.special_notes || "",
    // ★ 상품 페이지 열기 버튼용 랜딩 — 링크유입일 때만(비링크는 product_url 폴백 제거 = 유입가이드형에 버튼 안 뜸)
    landing_url:    o.inflow_type === "link"
                      ? (((typeof _woGuideUrls === "function" ? _woGuideUrls(o.inflow_guide)[0] : "") || "") || o.product_url || "")
                      : "",
    // 🧩 상품 옵션 프리필(061): product_options_json → 옵션표(2개 이상일 때만). 정원·하루는 관리자가 입력.
    options:        (typeof _woOptionRows === "function") ? _woOptionRows(o) : [],
    // ★ 065: 구매채널 = 상품 URL 호스트 판정 / 담당자 = 작업담당 매핑(랜덤이면 빈 값=직접결정)
    channel:        _woChannel(o),
    manager:        _woManagerNick(o.work_manager),
    // ★ 접수 시 확정된 연결 탭 — work_sheet_url 은 제출 필수라 접수된 오더는 항상 값이 있다.
    //   탭이 리네임됐을 수 있으므로 gid 도 함께 넘겨 프론트가 gid 우선으로 재매칭한다.
    linked_sheet_id: o.linked_tab_sheet_id || "",
    linked_tab_name: o.linked_tab_name || "",
    linked_tab_gid:  o.linked_tab_gid || "",
    // ★ 미접수 오더 폴백 — 접수 전이라 linked_tab_*가 비어도 URL의 시트ID·gid로 찾아본다
    //   (같은 탭이 앞선 오더로 이미 등록돼 있으면 여기서 잡힌다)
    work_sheet_url:  o.work_sheet_url || "",
  };
  return prefill;
}

/* ══════════════════════════════════════════════════════════════
   작업오더 관리자 수정 모달 — 관리자 대시보드·리뷰웹시스템[3버전] 공용 한 벌.
   (시안: frontend/docs/작업오더_관리자수정_와이어프레임.html · 2026-08-05 확정)

   · 호스트가 opts.save(fields) 로 자기 API 경로를 주입한다(admin=orderAdminEdit /
     workdesk=/api/trackb/work-orders/edit) — 모달 사본을 두면 두 화면이 갈라진다.
   · 바뀐 필드만 전송(PATCH). 빈 값은 "변경 없음"(서버도 같은 규칙).
   · 편집 불가 3종(상태·계약건·작업시트탭URL)은 읽기 전용 표시만.
   · ★ 오더 값은 외부(인트라넷·AE) 문자열 — 전부 .value / textContent 로만 주입한다
     (innerHTML 보간 금지, M1 실측 XSS 규율). */
function woAdminEditModal(order, opts) {
  var o = order || {}, save = (opts || {}).save, onSaved = (opts || {}).onSaved;
  var old = document.getElementById("woAdminEditModal");
  if (old) old.remove();

  var initial = {};   // field → 초기값(문자열) — 저장 시 diff 의 기준
  var readers = {};   // field → 현재 화면 값을 읽는 함수

  function mk(tag, css, parent) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (parent) parent.appendChild(n);
    return n;
  }
  function card(parent, title) {
    var c = mk("div", "border:1px solid #E5E7EB;border-radius:10px;margin-bottom:14px", parent);
    var h = mk("div", "font-size:12px;font-weight:800;color:#4B5563;background:#F3F4F6;padding:7px 12px;border-radius:10px 10px 0 0", c);
    h.textContent = title;
    return mk("div", "padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:10px 14px", c);
  }
  function label(parent, text) {
    var w = mk("label", "display:block;font-size:12px", parent);
    var l = mk("span", "display:block;font-size:11px;font-weight:700;color:#6B7280;margin-bottom:3px", w);
    l.textContent = text;
    return w;
  }
  function field(parent, f, text, opts2) {
    opts2 = opts2 || {};
    var w = label(parent, text);
    if (opts2.full) w.style.gridColumn = "1 / -1";
    var cur = o[f] == null ? "" : String(o[f]);
    if (f === "start_date") cur = cur.slice(0, 10);
    var inp;
    if (opts2.area) {
      inp = mk("textarea", "width:100%;border:1.5px solid #D1D5DB;border-radius:7px;padding:7px 10px;font-size:12.5px;min-height:64px;font-family:inherit;box-sizing:border-box", w);
    } else {
      inp = mk("input", "width:100%;border:1.5px solid #D1D5DB;border-radius:7px;padding:7px 10px;font-size:12.5px;box-sizing:border-box", w);
      inp.type = opts2.type || "text";
    }
    inp.value = cur;   // ★ 보간 금지 — 프로퍼티 대입만
    initial[f] = cur;
    readers[f] = function () { return inp.value; };
    if (opts2.hint) {
      var h = mk("div", "font-size:10.5px;color:" + (opts2.warn ? "#B45309" : "#9CA3AF") + ";margin-top:3px", w);
      h.textContent = opts2.hint;
    }
    return inp;
  }
  function pills(parent, f, text, values, opts2) {
    opts2 = opts2 || {};
    var w = label(parent, text);
    if (opts2.full) w.style.gridColumn = "1 / -1";
    var cur = o[f] == null ? "" : String(o[f]);
    if (f === "courier_proxy") cur = (o[f] === true || o[f] === "true") ? "true" : "false";
    var list = values.slice();
    // 현재 값이 목록 밖(레거시 표기)이면 지우지 않고 알약으로 함께 보여준다
    if (cur && !list.some(function (v) { return v.v === cur; })) list.push({ v: cur, l: cur });
    var row = mk("div", "display:flex;gap:6px;flex-wrap:wrap", w);
    var sel = cur;
    var btns = [];
    list.forEach(function (it) {
      var b = mk("button", "", row);
      b.type = "button";
      b.textContent = it.l;
      b.addEventListener("click", function () { sel = it.v; paint(); });
      btns.push({ b: b, v: it.v });
    });
    function paint() {
      btns.forEach(function (x) {
        x.b.style.cssText = "font-size:11.5px;font-weight:700;padding:5px 11px;border-radius:20px;cursor:pointer;border:1.5px solid " +
          (x.v === sel ? "#4F46E5;background:#4F46E5;color:#fff" : "#D1D5DB;background:#fff;color:#6B7280");
      });
    }
    paint();
    initial[f] = cur;
    readers[f] = function () { return sel; };
    if (opts2.hint) {
      var h = mk("div", "font-size:10.5px;color:#9CA3AF;margin-top:3px", w);
      h.textContent = opts2.hint;
    }
  }
  function roField(parent, text, value, full) {
    var w = label(parent, text);
    if (full) w.style.gridColumn = "1 / -1";
    var v = mk("div", "border:1.5px solid #E5E7EB;border-radius:7px;padding:7px 10px;font-size:12px;background:#F3F4F6;color:#9CA3AF;word-break:break-all", w);
    v.textContent = value || "—";
  }

  var ov = mk("div", "position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:18px");
  ov.id = "woAdminEditModal";
  var box = mk("div", "background:#fff;border-radius:13px;max-width:740px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.25);overflow:hidden", ov);

  var head = mk("div", "display:flex;justify-content:space-between;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid #E5E7EB;background:#F9FAFB", box);
  var ht = mk("b", "font-size:14.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", head);
  ht.textContent = "✏ 작업오더 관리자 수정 — " + (o.title || "");
  var xBtn = mk("button", "border:0;background:none;font-size:20px;color:#9CA3AF;cursor:pointer;flex:none", head);
  xBtn.type = "button"; xBtn.textContent = "✕";
  xBtn.addEventListener("click", function () { ov.remove(); });

  var body = mk("div", "padding:16px 18px;overflow-y:auto", box);

  var c1 = card(body, "📌 기본 정보");
  field(c1, "title", "작업명 *", { full: true, hint: "⚠ 접수된 오더의 작업명을 바꿔도 이미 등록된 시트 탭 이름은 바뀌지 않습니다.", warn: true });
  field(c1, "start_date", "시작일", { type: "date" });
  field(c1, "purchase_time", "구매시간대");
  field(c1, "manager_name", "담당AE");
  pills(c1, "work_manager", "작업담당", [
    { v: "박세희", l: "박세희(만두)" }, { v: "박은비", l: "박은비(망고)" }, { v: "랜덤", l: "랜덤" },
  ]);

  var c2 = card(body, "📦 진행 조건");
  field(c2, "recruit_count", "총 모집건수", { type: "number" });
  field(c2, "daily_count", "일일 진행건수", { type: "number" });
  pills(c2, "delivery_type", "배송유형", [{ v: "실배송", l: "실배송" }, { v: "빈박스", l: "빈박스" }]);
  pills(c2, "courier_proxy", "택배대행", [{ v: "true", l: "예" }, { v: "false", l: "아니오" }]);
  pills(c2, "review_type", "리뷰타입", [
    { v: "포토", l: "포토" }, { v: "텍스트", l: "텍스트" }, { v: "구매확정", l: "구매확정" },
    { v: "별점", l: "별점" }, { v: "혼합", l: "혼합" },
  ]);
  pills(c2, "goods_cost_type", "물건비", [{ v: "현금", l: "현금" }, { v: "계산서", l: "계산서" }],
    { hint: "입금관리의 은행 자동분류(하나/케이뱅크)가 이 값을 따라갑니다." });

  var c3 = card(body, "🛍 상품 · 유입");
  field(c3, "product_url", "상품확인용 URL", { full: true });
  field(c3, "product_option", "상품 · 옵션 · 결제금액", { full: true, area: true });
  field(c3, "pay_amount", "결제금액(원)", { type: "number" });
  pills(c3, "inflow_type", "유입방식", [{ v: "guide", l: "가이드유입" }, { v: "link", l: "링크유입" }]);
  field(c3, "inflow_keyword", "유입 키워드", { full: true });
  field(c3, "inflow_guide", "유입가이드", { full: true, area: true, hint: "⚠ 내용을 수정하지 않으면 원본(첨부 이미지 포함)이 그대로 보존됩니다.", warn: true });

  var c4 = card(body, "📝 가이드 · 특이사항");
  field(c4, "review_guide", "리뷰등록 가이드", { full: true, area: true });
  field(c4, "special_notes", "특이사항", { full: true, area: true });

  var c5 = card(body, "🔒 수정할 수 없는 항목");
  var stLabel = (typeof WO_LABELS === "object" && WO_LABELS[o.status]) ? WO_LABELS[o.status] : (o.status || "");
  roField(c5, "상태", stLabel + " — 상태는 [상태 변경] 버튼이 담당");
  roField(c5, "계약건", o.contract_number || o.sales_id ? String(o.contract_number || o.sales_id) + " — 인트라넷 발주에서 확정" : "(없음)");
  roField(c5, "작업시트탭URL", (o.work_sheet_url || "(없음)") + " — 접수·작업표 생성이 관리", true);

  var foot = mk("div", "display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #E5E7EB;background:#F9FAFB;flex-wrap:wrap", box);
  var note = mk("span", "font-size:11.5px;color:#15803D;font-weight:600", foot);
  note.textContent = "✅ 저장하면 인트라넷 \"보낸 오더\" 카드에도 자동 반영됩니다 (수정 알림 메모 전송)";
  var btnRow = mk("span", "display:flex;gap:8px", foot);
  var cancelBtn = mk("button", "font-size:12.5px;font-weight:700;padding:8px 16px;border-radius:8px;border:1.5px solid #D1D5DB;background:#fff;color:#374151;cursor:pointer", btnRow);
  cancelBtn.type = "button"; cancelBtn.textContent = "취소";
  cancelBtn.addEventListener("click", function () { ov.remove(); });
  var saveBtn = mk("button", "font-size:12.5px;font-weight:700;padding:8px 18px;border-radius:8px;border:1.5px solid #4F46E5;background:#4F46E5;color:#fff;cursor:pointer", btnRow);
  saveBtn.type = "button"; saveBtn.textContent = "저장";
  saveBtn.addEventListener("click", function () {
    // 바뀐 필드만 전송 — 빈 값은 "변경 없음"(서버와 같은 규칙이라 안 보내는 게 정직하다)
    var fields = {};
    var n = 0;
    for (var f in readers) {
      if (!Object.prototype.hasOwnProperty.call(readers, f)) continue;
      var v = readers[f]();
      if (v === initial[f]) continue;
      if (String(v).trim() === "") continue;   // 지움이 아니라 변경 없음
      fields[f] = v;
      n++;
    }
    if (!n) { alert("변경된 내용이 없습니다."); return; }
    if (typeof save !== "function") { alert("저장 경로가 연결되지 않았습니다."); return; }
    saveBtn.disabled = true; saveBtn.textContent = "저장 중…";
    Promise.resolve(save(fields)).then(function (r) {
      if (r && r.ok) {
        ov.remove();
        if (typeof onSaved === "function") onSaved(r);
      } else {
        saveBtn.disabled = false; saveBtn.textContent = "저장";
        alert("저장 실패: " + ((r && r.error) || "서버 오류"));
      }
    }).catch(function (e) {
      saveBtn.disabled = false; saveBtn.textContent = "저장";
      alert("저장 실패: " + e.message);
    });
  });

  ov.addEventListener("click", function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}

/* ══════════════════════════════════════════════════════════════
   접수 실패(gid 미발견) 탭 교정 팝업 — 관리자 대시보드·리뷰웹시스템[3버전] 공용.

   서버 /admin/accept 가 "gid=… 탭을 찾을 수 없음" 404 에 availableTabs(그 시트의
   실제 탭 목록)를 실어 주면, 사람이 올바른 탭을 골라 body.gid 로 재접수한다.
   ★ 자동 이름매칭 폴백은 두지 않는다 — 고르는 것은 항상 사람("잘못된 탭 연결이
     빈칸보다 나쁨" 규율). 서버는 고른 gid 로 work_sheet_url 까지 교정한다.
   ★ 탭명은 시트에서 온 외부 문자열 — onclick 문자열 보간 금지, DOM 생성 +
     addEventListener 로만 배선한다(M1 실측 XSS 규율). */
function woAcceptTabPicker(resp, onPick) {
  var tabs = (resp && resp.availableTabs) || [];
  var old = document.getElementById("woTabPickModal");
  if (old) old.remove();
  var ov = document.createElement("div");
  ov.id = "woTabPickModal";
  ov.style.cssText = "position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px";
  var box = document.createElement("div");
  box.style.cssText = "background:#fff;border-radius:12px;max-width:480px;width:100%;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.3);overflow:hidden";
  var head = document.createElement("div");
  head.style.cssText = "padding:16px 18px 12px;border-bottom:1px solid #E5E7EB";
  var h = document.createElement("div");
  h.textContent = "⚠ 시트에 없는 탭 주소(gid=" + String(resp && resp.urlGid || "?") + ")";
  h.style.cssText = "font-size:15px;font-weight:700;color:#B91C1C;margin-bottom:6px";
  var p = document.createElement("div");
  p.textContent = "작업시트탭URL의 gid가 이 시트에 없습니다(탭을 지웠다 다시 만들면 gid가 바뀝니다). 아래에서 올바른 탭을 고르면 URL을 교정해 접수합니다.";
  p.style.cssText = "font-size:12.5px;color:#6B7280;line-height:1.5";
  head.appendChild(h); head.appendChild(p);
  var list = document.createElement("div");
  list.style.cssText = "overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:6px";
  tabs.forEach(function (t) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = (t.title || "(이름 없음)") + (t.hidden ? "  (숨김 탭)" : "");
    b.title = "gid=" + String(t.gid || "");
    b.style.cssText = "text-align:left;padding:10px 12px;border:1.5px solid #D1D5DB;border-radius:8px;background:#F9FAFB;font-size:13.5px;cursor:pointer";
    b.addEventListener("mouseenter", function () { b.style.background = "#EEF2FF"; b.style.borderColor = "#6366F1"; });
    b.addEventListener("mouseleave", function () { b.style.background = "#F9FAFB"; b.style.borderColor = "#D1D5DB"; });
    b.addEventListener("click", function () {
      if (!confirm('"' + (t.title || "") + '" 탭으로 접수할까요?\n\n작업오더의 시트탭URL도 이 탭 주소로 교정됩니다.')) return;
      ov.remove();
      if (typeof onPick === "function") onPick(String(t.gid || ""), t);
    });
    list.appendChild(b);
  });
  if (!tabs.length) {
    var empty = document.createElement("div");
    empty.textContent = "이 시트에서 탭 목록을 가져오지 못했습니다. 시트에서 올바른 탭 주소를 복사해 작업시트탭URL을 수정해주세요.";
    empty.style.cssText = "font-size:13px;color:#6B7280;padding:14px";
    list.appendChild(empty);
  }
  var foot = document.createElement("div");
  foot.style.cssText = "padding:10px 14px;border-top:1px solid #E5E7EB;text-align:right";
  var cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "취소";
  cancel.style.cssText = "padding:8px 16px;border:1.5px solid #D1D5DB;border-radius:8px;background:#fff;font-size:13px;cursor:pointer";
  cancel.addEventListener("click", function () { ov.remove(); });
  foot.appendChild(cancel);
  box.appendChild(head); box.appendChild(list); box.appendChild(foot);
  ov.appendChild(box);
  ov.addEventListener("click", function (e) { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}

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
    // ── 상태 표기·전이 + 발행 프리필(관리자 대시보드 ↔ 리뷰웹시스템[3버전] 공용) ──
    WO_LABELS: WO_LABELS, WO_STATUS_HINTS: WO_STATUS_HINTS, WO_COLORS: WO_COLORS,
    WO_TRANSITIONS: WO_TRANSITIONS, WO_ACCEPT_ELIGIBLE: WO_ACCEPT_ELIGIBLE,
    _woAcceptable: _woAcceptable, _woAccepted: _woAccepted,
    WO_DELIVERY_MAP: WO_DELIVERY_MAP, WO_CHANNEL_HOSTS: WO_CHANNEL_HOSTS,
    _woChannelFromUrl: _woChannelFromUrl, _woChannel: _woChannel,
    _woPlainGuideToHtml: _woPlainGuideToHtml, _woReviewImgHtml: _woReviewImgHtml,
    _woBuildInflowHtml: _woBuildInflowHtml, _woFirstProductInfo: _woFirstProductInfo,
    _woStripReviewMeta: _woStripReviewMeta, _woGuideImages: _woGuideImages,
    _woOptionRows: _woOptionRows, _woCampaignPrefill: _woCampaignPrefill,
    woAcceptTabPicker: woAcceptTabPicker,
    woAdminEditModal: woAdminEditModal,
  };
  for (var k in EXPORTS) if (Object.prototype.hasOwnProperty.call(EXPORTS, k)) window[k] = EXPORTS[k];
  window.WorkOrderDetail = EXPORTS;
})();
