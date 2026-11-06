/* ══════════════════════════════════════════════════════════════
   외부모집 구매양식 — 관리자 수동제출 (공용 모달)

   카톡으로 모집한 외부 리뷰어의 슬래시양식을 붙여넣어 시스템에 정식 제출한다.
   기존에는 관리자가 구글시트에 직접 수기 입력했고, 그게 "유령 written"(DB=성공/시트=없음)
   사고의 유발 조건이자 모집 정원 누락·리뷰어 미등록의 원인이었다.

   진입점 2곳이 이 모듈 하나를 쓴다(사본을 두면 화면마다 규칙이 어긋난다):
     ① 작업보드(workdesk) 탭 단위(openExternalManualOrder)   ② 참여형 관제 패널(#ccMoBtn)
   리뷰어 홈(index.html)은 이 모듈을 싣지 않아 칩이 없다(의도 — campaign-cards.js moChip 주석: 옛 입구
   /api/manual-order 는 결정 186 에서 제거됐고 모듈은 /api/trackb/manual-order 로 재기준하는 화면만 싣는다).
   칩 코드는 window.ManualOrder 가 있을 때만 + 진짜 admin_token 보유자에게만 그린다(스코프 토큰 403 막다른 길 금지).

   ★ 결정 347(2026-11-06 사용자 확정) — 한 화면 표:
     · 한 줄 = 한 사람 = 입력칸 하나(슬래시양식 한 줄). 맨 아래엔 늘 빈 줄 하나.
       여러 줄을 한 번에 붙여넣으면 첫 줄은 그 줄, 나머지는 아래 새 줄에 한 줄씩(빈 줄 무시).
     · 붙여넣으면(또는 입력 후 잠깐 멈춤·칸 벗어남) 그 줄을 바로 서버 미리보기로 나눈다 — [다음] 단계 없음.
       파서는 서버 하나(server/src/utils/slashForm.js) — 화면에 사본을 두지 않는다.
     · 구매캡처는 줄마다 — 그 줄을 고른 채 Ctrl+V · 그 줄에 끌어다 놓기 · 파일 선택, 어느 길이든 그 줄에만 붙는다.
       (예전 공용 보관함 + 이름으로 자동 배정은 없앴다 — 오배정의 뿌리였다. 결정 345 참고)
     · 캡처에서 읽은 수취인이 그 줄 수취인과 다르면 「이름이 다릅니다(캡처: OOO)」 경고만(제출은 막지 않음).
     · 모양은 맥 시트(창 범위 CSS — 선택자는 전부 #moOvl 로 시작, 다른 화면에 새지 않는다).
     · 표 칸은 COLS 목록 하나에서 그린다 — 후속 칸(리뷰어 고르기 · 네이버/쿠팡 동시진행 칸)은 항목만 더하면 된다.

   사용: ManualOrder.open({ sheetId, tabName, gid, campaignId, title, onSubmitted })
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

  /* ★★ 경로는 호스트가 재기준한다(`window.MANUAL_ORDER_API` — CAMPAIGN_ADMIN_API·CS_API_BASE 와 같은 장치).
     리뷰웹시스템[3버전]은 인트라넷 SSO 토큰(via:'intranet')을 쓰는데 그 토큰은 authMiddleware 에서
     `/api/trackb/*` 로만 도달 가능하다 → `/api/manual-order/...` 하드코딩이면 미리보기·제출이
     403("인트라넷 연동 계정은 …Track B…에서만")으로 죽고 화면엔 '나누기 실패'로만 보인다.
     전역 미설정 = 종전 경로(관리자 대시보드·리뷰어 홈 동작 불변). 이미지 업로드/추출(/api/image/*)은
     무인증 라우트라 재기준하지 않는다. */
  function _moBase() {
    var b = window.MANUAL_ORDER_API;
    return (typeof b === 'string' && b) ? b.replace(/\/$/, '') : '/api/manual-order';
  }

  async function api(path, opts) {
    const o = Object.assign({ headers: {} }, opts || {});
    o.headers['Authorization'] = 'Bearer ' + tok();
    if (o.body) o.headers['Content-Type'] = 'application/json';
    const r = await fetch(_api() + path, o);
    return r.json();
  }
  function _toast(m) {
    try { if (typeof window.toast === 'function') { window.toast(m); return; } } catch (_) {}
    try { console.info('[ManualOrder] ' + m); } catch (_) {}
  }
  const sleep = ms => new Promise(res => setTimeout(res, ms));

  let CTX = null;      // { sheetId, tabName, gid, campaignId, title, view:'table'|'result', apps, retry }
  let ROWS = [];       // 한 줄 = 한 사람 — 글(text) + 서버가 나눈 결과(fields…) + 그 줄의 캡처
  let OPTS = [];       // ★ 결정 211: 작업보드 경로에서 고를 상품(선택지) 목록 — 서버 preview 가 연결 공고에서 싣는다
  let BUSY = false;
  let ACTIVE = null;   // 지금 고른 줄(Ctrl+V 사진이 들어갈 줄) — 줄 객체 자체(순서 번호 X: 줄을 지우면 번호가 밀린다)
  let SEQ = 0;         // 줄 고유 번호(칸 id) — 번호로 찾으면 줄을 지울 때 엉뚱한 칸에 커서가 간다
  let IME = false;     // 한글 조합 중에는 표를 다시 그리지 않는다(조합이 깨진다)
  let PAINT_LATER = false;
  const DIRTY = new Set();        // 다시 나눠야 할 줄
  let CLS_TIMER = null;
  let CLS_RUN = null;
  const CLASSIFY_DELAY_MS = 500;  // 입력을 멈추고 이만큼 지나면 나눈다(붙여넣기·칸 벗어남은 즉시)
  const MAX_ROWS = 50;            // 서버 미리보기·제출 한 번 상한(MAX_LINES)과 같다 — 오붙여넣기 수백 건 방지
  const CAPTURE_WAIT_MS = 25000;  // 제출이 캡처 줄이기·판독을 기다리는 상한(결정 236)

  function newRow(text) {
    return { uid: ++SEQ, text: String(text || ''), ver: 0, done: 0, parsing: false, netErr: '',
      ok: false, fields: {}, errors: [], warnings: [], repairs: [], missing: [], aiRepaired: false, raw: '',
      capture: null, capJob: null, capBusy: false, extract: null, extractPending: null,
      applications: [], targetApplicationId: '', optKey: '', optFullAck: false, productWarn: null };
  }
  const _blank = r => !String((r && r.text) || '').trim();
  const _oneLine = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const _filled = () => ROWS.filter(r => !_blank(r));
  /** 맨 아래에 늘 빈 줄 하나(사진만 붙은 빈 줄은 빈 줄로 치지 않는다) */
  function ensureTail() {
    const last = ROWS[ROWS.length - 1];
    if (!last || !_blank(last) || last.capture || last.capBusy) ROWS.push(newRow(''));
  }

  // ── 스타일(1회 주입) — ★ 선택자는 전부 #moOvl 로 시작(창 범위 · 다른 화면에 새지 않는다) ──────────
  //    색은 맨 위 #moOvl 변수에서만 정한다(맥 규칙: 직접 적은 색 금지 — 리뷰웹엔 ui-tokens.css 가 없어 창 범위 변수로 둔다).
  function styles() {
    if (document.getElementById('mo-style')) return;
    const st = document.createElement('style');
    st.id = 'mo-style';
    st.textContent = `
#moOvl{--mo-accent:#007aff;--mo-accent-bg:#e9f2ff;--mo-accent-ring:rgba(0,122,255,.35);
  --mo-text:#1d1d1f;--mo-text-2:#6e6e73;--mo-line:rgba(0,0,0,.14);--mo-line-2:rgba(0,0,0,.08);
  --mo-bg:#ffffff;--mo-head:#f5f5f7;--mo-fill:#f2f2f7;--mo-hover:rgba(0,0,0,.035);
  --mo-red:#d70015;--mo-red-bg:#fff3f2;--mo-orange:#b25000;--mo-orange-bg:rgba(255,149,0,.10);
  --mo-green:#1f7a35;--mo-green-bg:rgba(52,199,89,.10);--mo-scrim:rgba(0,0,0,.22);--mo-on-accent:#ffffff;
  --mo-sheet-shadow:0 0 0 0.5px rgba(0,0,0,.18),0 22px 60px rgba(0,0,0,.28);
  --mo-btn-shadow:0 0 0 0.5px rgba(0,0,0,.18),0 0.5px 1.5px rgba(0,0,0,.12);
  position:fixed;inset:0;background:var(--mo-scrim);z-index:100001;display:flex;align-items:center;justify-content:center;padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,'Pretendard','Apple SD Gothic Neo','Noto Sans KR',sans-serif;font-size:13px;color:var(--mo-text);
  -webkit-font-smoothing:antialiased}
#moOvl *{box-sizing:border-box}   /* 줄 배경색은 불투명 — 옆으로 밀 때 고정 칸(번호·양식·확인) 뒤 글자가 비치지 않게 */
#moOvl .mo-box{background:var(--mo-bg);border-radius:12px;width:1400px;max-width:100%;max-height:100%;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--mo-sheet-shadow)}
#moOvl .mo-box.narrow{width:760px}
#moOvl .mo-hd{display:flex;align-items:center;gap:10px;padding:14px 16px 12px;border-bottom:0.5px solid var(--mo-line)}
#moOvl .mo-hd .ttl{font-size:17px;font-weight:700;letter-spacing:-.2px;white-space:nowrap}
#moOvl .mo-hd .sub{font-size:12px;color:var(--mo-text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#moOvl .mo-hd .sp{flex:1}
#moOvl .mo-x{width:22px;height:22px;border-radius:50%;border:0;padding:0;background:var(--mo-fill);color:var(--mo-text-2);cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex:none}
#moOvl .mo-x:hover{color:var(--mo-text)}
#moOvl .mo-bar{display:flex;align-items:center;gap:14px;padding:0 16px;height:36px;border-bottom:0.5px solid var(--mo-line-2);font-size:12px;color:var(--mo-text-2);white-space:nowrap;overflow-x:auto}
#moOvl .mo-bar .n{font-variant-numeric:tabular-nums;font-weight:600;color:var(--mo-text)}
#moOvl .mo-bar .e .n{color:var(--mo-red)} #moOvl .mo-bar .w .n{color:var(--mo-orange)} #moOvl .mo-bar .g .n{color:var(--mo-green)}
#moOvl .mo-bar .sp{flex:1}
#moOvl .mo-bar kbd{font:600 11px/1 inherit;padding:2px 5px;border-radius:4px;background:var(--mo-fill);box-shadow:var(--mo-btn-shadow);color:var(--mo-text)}
#moOvl .mo-bd{overflow:auto;flex:1;min-height:0;background:var(--mo-bg)}
#moOvl .mo-ft{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:0.5px solid var(--mo-line)}
#moOvl .mo-ft .sp{flex:1}
#moOvl .mo-btn{font:inherit;font-size:13px;font-weight:600;height:28px;line-height:28px;padding:0 14px;border-radius:6px;border:0;cursor:pointer;
  background:var(--mo-bg);color:var(--mo-text);box-shadow:var(--mo-btn-shadow);white-space:nowrap;margin:0}
#moOvl .mo-btn:hover{background:var(--mo-head)}
#moOvl .mo-btn.pri{background:var(--mo-accent);color:var(--mo-on-accent);box-shadow:none}
#moOvl .mo-btn.pri:disabled{opacity:.4;cursor:default}
#moOvl .mo-tip{font-size:12px;font-weight:600;color:var(--mo-red);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#moOvl .mo-guide{padding:10px 16px 14px;font-size:12px;line-height:1.7;color:var(--mo-text-2)}
#moOvl .mo-guide b{color:var(--mo-text);font-weight:600}
/* 표 — 줄 28px 한 줄 · 머리 31px 회색 · 머리카락 선 */
#moOvl .mo-tw{overflow:visible}   /* 가로·세로 밀기는 .mo-bd 하나가 맡는다(머리 줄·앞 두 칸 고정이 같은 기준을 쓰게) */
#moOvl .mo-tbl{border-collapse:separate;border-spacing:0;table-layout:fixed;width:100%;font-size:13px;margin:0;
  border:0;border-radius:0;background:var(--mo-bg);overflow:visible}   /* 작업보드 전역 table{overflow:hidden;border…} 무효화 — 남으면 머리 줄·앞뒤 칸 고정이 안 된다 */
#moOvl .mo-tbl th{position:sticky;top:0;z-index:2;height:31px;padding:0 4px;background:var(--mo-head);color:var(--mo-text-2);font-size:12px;font-weight:600;
  text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:0;box-shadow:inset 0 -0.5px 0 var(--mo-line)}
#moOvl .mo-tbl td{height:28px;padding:0 4px;border:0;box-shadow:inset 0 -0.5px 0 var(--mo-line-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;background:var(--mo-bg)}
#moOvl .mo-tbl th.r,#moOvl .mo-tbl td.r{text-align:right}
#moOvl .mo-tbl th.stk,#moOvl .mo-tbl td.stk{position:sticky;left:0;z-index:1}
#moOvl .mo-tbl th.stk{z-index:3}
#moOvl .mo-tbl th.stk2,#moOvl .mo-tbl td.stk2{position:sticky;left:30px;z-index:1;box-shadow:inset -0.5px 0 0 var(--mo-line),inset 0 -0.5px 0 var(--mo-line-2)}
#moOvl .mo-tbl th.stk2{z-index:3}
#moOvl .mo-tbl th.stkr,#moOvl .mo-tbl td.stkr{position:sticky;right:0;z-index:1;box-shadow:inset 0.5px 0 0 var(--mo-line),inset 0 -0.5px 0 var(--mo-line-2)}
#moOvl .mo-tbl th.stkr{z-index:3}
#moOvl .mo-tbl tr:hover td{background:var(--mo-head)}
#moOvl .mo-tbl tr.sel td{background:var(--mo-accent-bg)}
#moOvl .mo-tbl td.no{color:var(--mo-text-2);font-size:12px;font-variant-numeric:tabular-nums;text-align:right;padding-right:6px}
#moOvl .mo-tbl tr.sel td.no{box-shadow:inset 3px 0 0 var(--mo-accent),inset 0 -0.5px 0 var(--mo-line-2)}
#moOvl .mo-tbl tr.bad td.no{color:var(--mo-red);box-shadow:inset 3px 0 0 var(--mo-red),inset 0 -0.5px 0 var(--mo-line-2)}
#moOvl .mo-tbl tr.fix td.no{color:var(--mo-orange);box-shadow:inset 3px 0 0 var(--mo-orange),inset 0 -0.5px 0 var(--mo-line-2)}
#moOvl .mo-tbl tr.sel.bad td.no,#moOvl .mo-tbl tr.sel.fix td.no{box-shadow:inset 3px 0 0 var(--mo-accent),inset 0 -0.5px 0 var(--mo-line-2)}
#moOvl .mo-tbl tr.bad td{background:var(--mo-red-bg)}
#moOvl .mo-tbl tr.bad.sel td{background:var(--mo-accent-bg)}
#moOvl .mo-in{display:block;width:100%;height:27px;margin:0;padding:0 3px;font:inherit;font-size:13px;color:var(--mo-text);background:transparent;
  border:0;border-radius:4px;box-shadow:none;outline:none;min-width:0}
#moOvl .mo-in:hover{background:var(--mo-hover)}
#moOvl .mo-in:focus{background:var(--mo-bg);box-shadow:0 0 0 2px var(--mo-accent-ring)}
#moOvl .mo-in.raw{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px}
#moOvl .mo-in.raw::placeholder{color:var(--mo-text-2)}
#moOvl .mo-in.num{text-align:right;font-variant-numeric:tabular-nums}
#moOvl .mo-in.fixv{color:var(--mo-orange)}
#moOvl .mo-miss{color:var(--mo-red);font-size:12px}
#moOvl .mo-tag{display:inline-block;margin-left:3px;padding:0 4px;height:16px;line-height:16px;border-radius:3px;font-size:11px;font-weight:600;background:var(--mo-fill);color:var(--mo-text-2);vertical-align:1px}
#moOvl .mo-cellf{display:flex;align-items:center;gap:2px;min-width:0}
#moOvl .mo-cellf .mo-in{flex:1}
#moOvl .mo-sel{display:block;width:100%;height:24px;margin:0;padding:0 4px;font:inherit;font-size:12px;color:var(--mo-text);background:var(--mo-bg);
  border:0;border-radius:5px;box-shadow:var(--mo-btn-shadow);min-width:0}
#moOvl .mo-sel.need{box-shadow:0 0 0 1px var(--mo-red);color:var(--mo-red)}
#moOvl .mo-cellf .mo-sel{flex:1 1 auto;min-width:96px}   /* 초과 확인 체크가 옆에 붙어도 고르는 칸이 찌그러지지 않게 */
#moOvl .mo-ack{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--mo-orange);cursor:pointer;white-space:nowrap;flex:none}
#moOvl .mo-ack input{margin:0}
#moOvl .mo-auto{font-size:12px;color:var(--mo-text-2)}
/* 캡처 칸 — 작은 미리보기 + 빼기 · 비었으면 받는 자리 */
#moOvl .mo-cap{display:flex;align-items:center;gap:4px;height:24px;border-radius:5px;padding:0 4px;outline:none;cursor:pointer;color:var(--mo-text-2);font-size:12px}
#moOvl .mo-cap.empty{box-shadow:inset 0 0 0 0.5px var(--mo-line)}
#moOvl .mo-cap:focus,#moOvl .mo-cap.over,#moOvl tr.over .mo-cap{box-shadow:0 0 0 2px var(--mo-accent-ring);color:var(--mo-accent)}
#moOvl .mo-cap img{width:30px;height:20px;object-fit:cover;border-radius:3px;display:block;box-shadow:0 0 0 0.5px var(--mo-line)}
#moOvl .mo-cap .k{white-space:nowrap}
#moOvl .mo-ib{width:24px;height:24px;border:0;border-radius:5px;padding:0;background:transparent;color:var(--mo-text-2);cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex:none;margin:0}
#moOvl .mo-ib:hover{background:var(--mo-hover);color:var(--mo-text)}
#moOvl .mo-ib.del:hover{color:var(--mo-red)}
#moOvl label.mo-ib input{display:none}
/* 확인 칸 — 한 줄(전체 문구는 마우스 올림) */
#moOvl .mo-stw{display:flex;align-items:center;gap:2px;min-width:0}
#moOvl .mo-stw>div{flex:1;min-width:0}
#moOvl .mo-st{display:flex;align-items:center;gap:5px;font-size:12px;min-width:0}
#moOvl .mo-st span.t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#moOvl .mo-st.e{color:var(--mo-red)} #moOvl .mo-st.w{color:var(--mo-orange)} #moOvl .mo-st.g{color:var(--mo-green)} #moOvl .mo-st.m{color:var(--mo-text-2)}
#moOvl .mo-st .more{flex:none;font-size:11px;font-weight:600;padding:0 4px;border-radius:3px;background:var(--mo-fill);color:var(--mo-text-2)}
/* 결과 */
#moOvl .mo-res{display:flex;gap:10px;align-items:flex-start;padding:9px 16px;border-bottom:0.5px solid var(--mo-line-2)}
#moOvl .mo-res .ci{flex:none;font-size:15px;line-height:18px}
#moOvl .mo-res.ok .ci{color:var(--mo-green)} #moOvl .mo-res.no .ci{color:var(--mo-red)}
#moOvl .mo-res .t{font-size:13px;font-weight:600;line-height:18px}
#moOvl .mo-res .s{font-size:12px;color:var(--mo-text-2);line-height:1.55}
#moOvl .mo-res .w{font-size:12px;color:var(--mo-orange);line-height:1.55}
#moOvl .mo-sum{display:flex;gap:14px;padding:0 16px;height:36px;align-items:center;font-size:12px;color:var(--mo-text-2);border-bottom:0.5px solid var(--mo-line)}
/* 휴대폰 — 아래에서 올라오는 시트 · 표는 옆으로 밀기 · 입력 36px(글자 16px, 확대 방지) · 주요 단추 44px */
@media screen and (max-width:768px){
  #moOvl{align-items:flex-end;padding:0}
  #moOvl .mo-box,#moOvl .mo-box.narrow{width:100%;max-height:94vh;border-radius:12px 12px 0 0}
  #moOvl .mo-hd{padding:12px 14px 10px}
  #moOvl .mo-x{width:32px;height:32px;font-size:14px}
  #moOvl .mo-tbl td{height:44px}
  #moOvl .mo-in{height:36px;font-size:16px}
  #moOvl .mo-in.raw{font-size:16px}
  #moOvl .mo-sel{height:32px;font-size:16px}
  #moOvl .mo-ib{width:32px;height:32px;font-size:14px}
  #moOvl .mo-cap{height:32px}
  #moOvl .mo-ft{padding:10px 14px calc(10px + env(safe-area-inset-bottom))}
  #moOvl .mo-btn{height:44px;line-height:44px;font-size:15px;padding:0 16px}
  #moOvl .mo-ft .mo-tip{display:none}
  #moOvl .mo-bar .hint{display:none}
  #moOvl col.mo-c-opt.ack{width:236px !important}   /* 초과 확인 줄이 있으면 상품 칸을 넓힌다(표는 옆으로 밀기 · 한 줄 유지) */
  #moOvl .mo-ack input{width:20px;height:20px}
  #moOvl .mo-tbl th.stk2,#moOvl .mo-tbl td.stk2,#moOvl .mo-tbl th.stkr,#moOvl .mo-tbl td.stkr{position:static;box-shadow:inset 0 -0.5px 0 var(--mo-line-2)}
}
`;
    document.head.appendChild(st);
  }

  // ── 열기 ───────────────────────────────────────────────────
  function open(ctx) {
    if (!tok()) { alert('관리자 로그인이 필요합니다.'); return; }
    styles();
    CTX = Object.assign({ sheetId: '', tabName: '', gid: '', campaignId: null, title: '' }, ctx || {});
    if (!CTX.sheetId || !CTX.tabName) { alert('연결된 작업(시트·탭) 정보가 없어 수동제출을 열 수 없습니다.'); return; }
    // ★ 새로 열면 줄·캡처를 비운다(다른 탭 캡처 혼입 금지)
    ROWS = []; OPTS = []; ACTIVE = null; DIRTY.clear(); clearTimeout(CLS_TIMER); CLS_TIMER = null; BUSY = false;
    IME = false; PAINT_LATER = false;
    CTX.view = 'table'; CTX.apps = null;
    ROWS.push(newRow(''));
    let ovl = document.getElementById('moOvl');
    if (!ovl) {
      ovl = document.createElement('div');
      ovl.id = 'moOvl'; ovl.className = 'mo-ovl';
      // 뒤 배경을 눌러 닫는 것은 아무것도 안 넣었을 때만 — 붙여 둔 10줄이 실수로 사라지지 않게
      ovl.addEventListener('click', e => { if (e.target === ovl && (!CTX || CTX.view === 'result' || !_filled().length)) close(); });
      ovl.addEventListener('compositionstart', _onCompStart, true);
      ovl.addEventListener('compositionend', _onCompEnd, true);
      document.body.appendChild(ovl);
    }
    ovl.style.display = 'flex';
    renderPreview();
    setTimeout(() => { const t = ROWS[0] && document.getElementById('moRaw-' + ROWS[0].uid); if (t) t.focus(); }, 40);
  }
  function close(ask) {
    if (ask && CTX && CTX.view === 'table' && _filled().length && !confirm('입력한 줄이 사라집니다. 닫을까요?')) return;
    const o = document.getElementById('moOvl');
    if (o) o.remove();
    CTX = null; ROWS = []; ACTIVE = null; DIRTY.clear(); clearTimeout(CLS_TIMER); CLS_TIMER = null; BUSY = false;
  }

  function shell(bodyHtml, footHtml, opt) {
    const o = document.getElementById('moOvl');
    if (!o) return;
    const bar = (opt && opt.bar) || '';
    const html = `<div class="mo-box${opt && opt.narrow ? ' narrow' : ''}" role="dialog" aria-modal="true" aria-label="외부모집 수동제출">
      <div class="mo-hd">
        <span class="ttl">외부모집 수동제출</span>
        <span class="sub">${esc(CTX.title || CTX.tabName)}${CTX.campaignId ? ' · 참여형(정원 차감)' : ''}</span>
        <span class="sp"></span>
        <button type="button" class="mo-x" title="닫기" aria-label="닫기" onclick="ManualOrder.close(true)"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
      ${bar}
      <div class="mo-bd" id="moBd">${bodyHtml}</div>
      <div class="mo-ft">${footHtml}</div>
    </div>`;
    if (opt && opt.keepEl && _morphKeep(o, html, opt.keepEl)) return true;
    o.innerHTML = html;
    return false;
  }
  /** 다시 그리되 **입력 중인 칸(DOM 요소)은 그대로 둔다** — 그 칸의 조상 줄기만 남기고 나머지(옆 칸·다른 줄·머리·바닥)는
   *  새 것으로 바꾼다. 포커스·커서·입력기 상태가 그 요소에 붙어 있어, 요소를 새로 만들면 조합 경계(끝→다음 글자 시작)에서
   *  글자가 깨지거나 포커스가 튄다(실브라우저 검증 2026-11-06). 구조가 달라 못 하면 false → 종전처럼 통째로 그린다. */
  function _morphKeep(o, html, keepEl) {
    try {
      if (!keepEl || !keepEl.id || typeof o.contains !== 'function' || !o.contains(keepEl)) return false;
      const tpl = document.createElement('div');
      tpl.innerHTML = html;
      const nk = tpl.querySelector('[id="' + keepEl.id + '"]');
      if (!nk || nk.tagName !== keepEl.tagName || nk.type !== keepEl.type) return false;
      const oc = [], nc = [];
      for (let e = keepEl; e && e !== o; e = e.parentNode) oc.unshift(e);
      for (let e = nk; e && e !== tpl; e = e.parentNode) nc.unshift(e);
      if (oc.length !== nc.length || oc.some((e, k) => e.tagName !== nc[k].tagName)) return false;
      let op = o, np = tpl;
      for (let d = 0; d < oc.length; d++) {
        const a = oc[d], b = nc[d];
        const kids = Array.from(np.childNodes);
        const at = kids.indexOf(b);
        Array.from(op.childNodes).forEach(n => { if (n !== a) op.removeChild(n); });
        kids.slice(0, at).forEach(n => op.insertBefore(n, a));
        kids.slice(at + 1).forEach(n => op.appendChild(n));
        Array.from(a.attributes).forEach(x => { if (!b.hasAttribute(x.name)) a.removeAttribute(x.name); });
        Array.from(b.attributes).forEach(x => { if (a.getAttribute(x.name) !== x.value) a.setAttribute(x.name, x.value); });
        op = a; np = b;
      }
      return true;
    } catch (_) { return false; }
  }

  // ── 줄 입력 · 붙여넣기 ─────────────────────────────────────
  /** 한 줄 칸에 글을 쓸 때 — 잠깐 멈추면 나눈다(붙여넣기 직후는 즉시). 표는 다시 그리지 않는다(입력 중 커서 유지). */
  function rowInput(i, val, ev) {
    const row = ROWS[i]; if (!row) return;
    // ★ 조합 판정이 글 저장보다 먼저다 — 조합 중 글을 먼저 저장하면 compositionend 때 '같은 글'로 보여
    //   조기 반환되고, 한글만 고친 줄이 다시 나뉘지 않는다(실브라우저 검증 2026-11-06).
    if (ev && ev.isComposing) return;          // 한글 조합 중 — 조합이 끝나면(창 루트 compositionend) 다시 온다
    const v = String(val == null ? '' : val).replace(/[\r\n]+/g, ' ');
    if (v === row.text && !row.pasteNow) return;
    row.text = v; row.ver++; row.productWarn = null;
    const now = !!row.pasteNow; row.pasteNow = false;
    const wasTail = ROWS[ROWS.length - 1] === row;
    if (wasTail && !_blank(row)) { ensureTail(); paint(); }   // 맨 아래 빈 줄을 쓰기 시작하면 새 빈 줄
    markDirty(row, now);
  }
  function ime(on, i, val) {
    IME = !!on;
    if (IME) { clearTimeout(CLS_TIMER); CLS_TIMER = null; return; }   // 조합 중엔 분류를 쉰다(끝나면 다시 건다)
    if (typeof i === 'number') rowInput(i, val);
    if (DIRTY.size && !CLS_TIMER) markDirty(null, false);           // 조합 시작 때 멈춘 분류 타이머 재시작
    if (PAINT_LATER) { PAINT_LATER = false; paint(); }
  }
  /* ★ 조합 시작·끝은 **창 루트에 캡처 단계로** 묶는다 — 인라인 oncompositionstart/oncompositionend 속성은
     Chromium·WebKit 이 지원하지 않아('oncompositionstart' in HTMLElement.prototype === false) 한 번도 안 불렸고,
     그래서 0.5초 분류 타이머가 조합 도중 표를 다시 그려 '김민수'가 '김미민민ㅅ수'로 깨졌다(실브라우저 검증 2026-11-06). */
  function _imeTarget(ev) {
    const id = String((ev && ev.target && ev.target.id) || '');
    const m = /^moRaw-(\d+)$/.exec(id);
    if (!m) return null;
    const i = ROWS.findIndex(r => String(r.uid) === m[1]);
    return i < 0 ? null : i;
  }
  function _onCompStart() { ime(1); }
  function _onCompEnd(ev) {
    const i = _imeTarget(ev);
    if (i == null) ime(0); else ime(0, i, ev.target.value);
  }
  /** 칸을 벗어나면 바로 나눈다 · 비운 중간 줄(캡처도 없음)은 치운다 */
  function rowBlur(i) {
    const row = ROWS[i]; if (!row) return;
    if (!_blank(row) && (row.ver !== row.done || row.netErr)) markDirty(row, true);   // 나누기 실패 줄은 칸을 벗어날 때 다시 시도
    if (_blank(row) && !row.capture && !row.capBusy && ROWS[ROWS.length - 1] !== row) {
      setTimeout(() => {
        const k = ROWS.indexOf(row);
        if (k < 0 || !_blank(row) || row.capture || row.capBusy || k === ROWS.length - 1) return;
        ROWS.splice(k, 1); DIRTY.delete(row); if (ACTIVE === row) ACTIVE = null;
        paint();
      }, 0);
    }
  }
  /** 줄 칸에 붙여넣기 — 사진이면 그 줄 캡처, 여러 줄 글이면 첫 줄은 이 줄 · 나머지는 아래 새 줄(빈 줄 무시) */
  function rowPaste(ev, i) {
    const row = ROWS[i]; if (!row) return;
    const cd = ev && ev.clipboardData;
    const imgs = _imagesFrom(cd);
    if (imgs.length) { ev.preventDefault(); select(row); takeImages(row, imgs); return; }
    const t = cd && typeof cd.getData === 'function' ? (cd.getData('text/plain') || cd.getData('text') || '') : '';
    const lines = String(t).split(/\r?\n/).filter(s => s.trim());
    if (lines.length <= 1) { row.pasteNow = true; return; }   // 한 줄 = 그대로 붙고, 이어지는 입력 이벤트에서 바로 나눈다
    ev.preventDefault();
    const el = ev.target || {};
    const v = row.text;
    const s = typeof el.selectionStart === 'number' ? el.selectionStart : v.length;
    const e = typeof el.selectionEnd === 'number' ? el.selectionEnd : v.length;
    pasteLines(i, lines, _blank(row) ? null : [s, e]);
  }
  /** 여러 줄을 i 번 줄부터 나눠 넣는다(rowPaste 와 시험이 같은 길을 쓴다) */
  function pasteLines(i, lines, range) {
    const row = ROWS[i]; if (!row) return;
    lines = (lines || []).map(_oneLine).filter(Boolean);
    if (!lines.length) return;
    const room = MAX_ROWS - _filled().length + (_blank(row) ? 0 : 1);   // 이 줄이 이미 차 있으면 첫 줄이 그 자리를 쓴다
    if (lines.length > room) {
      alert(`한 번에 최대 ${MAX_ROWS}건까지 처리합니다. ${lines.length - Math.max(room, 0)}건은 넣지 않았습니다.`);
      lines = lines.slice(0, Math.max(room, 0));
      if (!lines.length) return;
    }
    const v = row.text;
    row.text = range ? _oneLine(v.slice(0, range[0]) + lines[0] + v.slice(range[1])) : lines[0];
    row.ver++; row.productWarn = null;
    const added = lines.slice(1).map(l => newRow(l));
    ROWS.splice(i + 1, 0, ...added);
    [row].concat(added).forEach(r => { r.ver++; DIRTY.add(r); });
    ensureTail();
    ACTIVE = ROWS[ROWS.length - 1];
    paint();
    const tail = document.getElementById('moRaw-' + ROWS[ROWS.length - 1].uid);
    if (tail) tail.focus();
    markDirty(null, true);
  }

  // ── 바로 나누기 — 서버 미리보기를 바뀐 줄 묶음으로 부른다(파서 단일 출처) ──────────
  function markDirty(row, now) {
    if (row) DIRTY.add(row);
    clearTimeout(CLS_TIMER);
    CLS_TIMER = setTimeout(() => { flush(); }, now ? 0 : CLASSIFY_DELAY_MS);
  }
  /** 밀린 나누기를 지금 끝낸다 — 제출 전·시험에서 기다린다. 동시에 두 번 보내지 않는다(차례로). */
  async function flush() {
    clearTimeout(CLS_TIMER); CLS_TIMER = null;
    while (CLS_RUN) await CLS_RUN;
    if (!CTX || !DIRTY.size) return;
    const batch = ROWS.filter(r => DIRTY.has(r));
    DIRTY.clear();
    CLS_RUN = classify(batch).finally(() => { CLS_RUN = null; });
    await CLS_RUN;
    if (DIRTY.size) return flush();
  }
  function _resetParse(row) {
    Object.assign(row, { ok: false, fields: {}, errors: [], warnings: [], repairs: [], missing: [], aiRepaired: false, raw: '', netErr: '', parsing: false });
    row.done = row.ver;
  }
  async function classify(batch) {
    batch.filter(_blank).forEach(_resetParse);
    const todo = batch.filter(r => !_blank(r));
    if (!todo.length) { paint(); return; }
    todo.forEach(r => { r.parsing = true; });
    paint();
    for (let k = 0; k < todo.length; k += MAX_ROWS) {
      const part = todo.slice(k, k + MAX_ROWS);
      const vers = part.map(r => r.ver);
      const text = part.map(r => _oneLine(r.text)).join('\n');
      let r;
      try {
        r = await api(_moBase() + '/preview', { method: 'POST',
          body: JSON.stringify({ text, sheetId: CTX.sheetId, tabName: CTX.tabName, campaignId: CTX.campaignId || null }) });
      } catch (e) { r = { ok: false, error: (e && e.message) ? e.message : '서버에 연결하지 못했습니다' }; }
      if (!CTX) return;   // 기다리는 사이 창을 닫았다
      if (!r || !r.ok) {
        // 나누기 실패 — 값을 지어내지 않는다. 그 줄에 이유를 남기고, 칸을 벗어나거나 고치면 다시 나눈다.
        part.forEach((row, j) => { row.parsing = false; if (row.ver !== vers[j]) return; row.netErr = '나누기 실패: ' + ((r && r.error) || '오류'); row.ok = false; row.done = row.ver; });
        continue;
      }
      // ★ 결정 211: 공고 화면 경로(campaignId)는 신청 선택이 옵션을 정하므로 상품 칸을 띄우지 않는다. 남은 자리는 늘 최신 응답으로.
      OPTS = (!CTX.campaignId && Array.isArray(r.optionChoices)) ? r.optionChoices.filter(o => o && o.optKey) : [];
      const items = Array.isArray(r.items) ? r.items : [];
      part.forEach((row, j) => {
        row.parsing = false;
        if (row.ver !== vers[j] || ROWS.indexOf(row) < 0) return;   // 그사이 고쳤다·지웠다 — 고친 글로 다시 나눈다
        _applyItem(row, items[j]);
      });
      if (r.repairedCount) console.info('[ManualOrder] 자동보정 ' + r.repairedCount + '건');
    }
    if (OPTS.length === 1) ROWS.forEach(x => { if (!x.optKey) x.optKey = OPTS[0].optKey; });
    await loadApplicationCandidates(todo);
    paint();
  }
  function _applyItem(row, it) {
    row.netErr = '';
    row.done = row.ver;
    if (!it) { Object.assign(row, { ok: false, fields: {}, errors: ['나누기 결과가 없습니다 — 칸을 고쳐 다시 붙여넣어 주세요'], warnings: [], repairs: [], missing: [] }); return; }
    row.ok = !!it.ok;
    row.fields = Object.assign({}, it.fields || {});
    row.errors = (it.errors || []).slice();
    row.warnings = (it.warnings || []).slice();
    row.repairs = (it.repairs || []).slice();
    row.missing = (it.missing || []).slice();
    row.aiRepaired = !!it.aiRepaired;
    row.raw = it.raw || row.text;
    row.productWarn = null;
    if (row.extract && row.extract.orderNumber && !row.fields.orderNum) row.fields.orderNum = row.extract.orderNumber;
  }

  // ── 상품(선택지) 고르기 (결정 211) ─────────────────────────
  // 옵션 단위는 같은 상품의 옵션끼리 상품명이 같다 — 옵션 이름(optKey)으로 보여야 구분된다(Codex 리뷰).
  const _optName = o => (o && (o.unitKind === 'option' ? o.optKey : (o.productName || o.optKey))) || '';
  const _optOf = it => OPTS.find(o => o.optKey === it.optKey) || null;
  /** 이 줄이 고른 상품의 남은 자리를 넘는가 — 위에서부터 같은 상품을 고른 정상 줄 수로 센다(서버와 같은 순서·같은 셈). */
  function _optOver(it) {
    const o = _optOf(it);
    if (!o || o.remaining == null) return false;
    let n = 0;
    for (const r of ROWS) { if (r.ok && r.optKey === o.optKey) n++; if (r === it) break; }
    return n > o.remaining;
  }
  /** 이 줄이 상품 때문에 제출이 막히는가: 'need'(안 고름) | 'ack'(남은 자리 초과 확인 전) | '' */
  function optBlock(it) {
    if (!OPTS.length) return '';
    if (!_optOf(it)) return 'need';
    if (_optOver(it) && !it.optFullAck) return 'ack';
    return '';
  }
  // 나눈 뒤 다시 고치지 않은(ver === done) 정상 줄만 — 나누는 중인 줄을 옛 값으로 보내지 않는다
  /** 참여형: 확정할 기존 신청이 있는데 안 골랐는가 — 서버(manualOrder.service ⓪-2 application_selection_required:
   *  같은 공고·같은 연락처 끝 8자리·applied/expired/cancelled 신청이 있고 선택이 없으면 그 줄 거절)와 같은 조건.
   *  후보(applications)는 loadApplicationCandidates 가 같은 상태 목록으로 거른다. 후보 조회 실패 = 빈 목록 = 막지 않음(서버가 최종 판정). */
  const appBlock = it => !!(CTX && CTX.campaignId && (it.applications || []).length && !it.targetApplicationId);
  const submittable = it => !!it.ok && !_blank(it) && it.ver === it.done && !it.parsing && !optBlock(it) && !appBlock(it);
  function optLabel(o) {
    const left = o.remaining == null ? '정원 없음' : (o.status === 'soldout' ? `마감(${o.used}/${o.recruitTotal})` : '남은 ' + o.remaining);
    const today = (o.status !== 'soldout' && o.todayRemaining != null && (o.remaining == null || o.todayRemaining < o.remaining))
      ? ' · 오늘 ' + o.todayRemaining : '';
    return _optName(o) + ' · ' + left + today + (o.status === 'paused' ? ' · 품절로 일시 멈춤' : '');   // ★ 결정 229: 안내만(고르는 것은 막지 않는다)
  }
  /** 결정 236 ⑤ — 상품 확인에 걸린 이유(제출을 취소한 뒤). 상품·결제금액·연락처를 고치면 사라진다. */
  function _productWarnList(it) {
    return (it.productWarn || []).map(m => '상품 확인: ' + m);
  }
  /** 상품 칸 — 한 줄짜리(펼쳐서 고르는 목록 · 남은 자리 초과면 확인 체크). 자세한 문구는 마우스 올림 + 확인 칸. */
  function optCell(it, i) {
    if (!OPTS.length) return '';
    if (_blank(it) || !it.ok) return '<td></td>';
    const o = _optOf(it);
    let ack = '';
    if (o && _optOver(it)) {
      const why = (o.remaining > 0
        ? `이 상품은 남은 자리가 ${o.remaining}개라 이 줄부터 정원을 넘습니다`
        : `이미 찬 상품입니다(${o.used}/${o.recruitTotal})`) + ' — 이미 산 주문이라 확인 후 등록합니다';
      // 글자는 두 자(「초과」) — PC 상품 칸 156px 안에서 고르는 칸 최소 폭(96px)을 지킨다 · 전체 이유는 마우스 올림 + 확인 칸
      ack = `<label class="mo-ack" title="${esc(why)}"><input type="checkbox" id="moAck-${it.uid}" aria-label="${i + 1}번 줄 남은 자리 초과 확인" ${it.optFullAck ? 'checked' : ''}
        onchange="ManualOrder.ackOption(${i},this.checked)">초과</label>`;
    }
    if (OPTS.length === 1) return `<td><div class="mo-cellf"><span class="mo-auto" title="상품이 하나라 자동으로 고릅니다">자동</span>&nbsp;<span class="t">${esc(_optName(OPTS[0]))}</span>${ack ? '&nbsp;' + ack : ''}</div></td>`;
    return `<td><div class="mo-cellf">
      <select class="mo-sel${o ? '' : ' need'}" id="moOpt-${it.uid}" aria-label="${i + 1}번 줄 상품" onchange="ManualOrder.pickOption(${i},this.value)">
        <option value="">상품 선택 필수</option>${OPTS.map(x => `<option value="${esc(x.optKey)}" ${it.optKey === x.optKey ? 'selected' : ''}>${esc(optLabel(x))}</option>`).join('')}
      </select>${ack}</div></td>`;
  }
  function pickOption(i, key) {
    const it = ROWS[i]; if (!it) return;
    it.optKey = key || ''; it.optFullAck = false; it.productWarn = null;
    renderPreview();
    const el = document.getElementById('moOpt-' + it.uid); if (el) el.focus();
  }
  function ackOption(i, on) {
    const it = ROWS[i]; if (!it) return;
    it.optFullAck = !!on;
    renderPreview();
    const el = document.getElementById('moAck-' + it.uid); if (el) el.focus();
  }
  function syncSubmitBtn() {
    const btn = document.getElementById('moSubmit');
    if (!btn) return;
    const n = ROWS.filter(submittable).length;
    if (!BUSY) { btn.disabled = !n; btn.textContent = n + '건 제출'; }
    const need = ROWS.filter(r => r.ok && !_blank(r) && optBlock(r) === 'need').length;
    const ack = ROWS.filter(r => r.ok && !_blank(r) && optBlock(r) === 'ack').length;
    const appNeed = ROWS.filter(r => r.ok && !_blank(r) && appBlock(r)).length;
    const busy = ROWS.filter(r => !_blank(r) && (r.parsing || r.ver !== r.done)).length;
    const tip = document.getElementById('moOptTip');
    if (tip) tip.textContent = need ? `상품을 고르지 않은 줄 ${need}개는 제출되지 않습니다` : appNeed ? `참여 신청을 고르지 않은 줄 ${appNeed}개는 제출되지 않습니다` : ack ? `남은 자리를 넘는 줄 ${ack}개는 확인 체크가 필요합니다` : busy ? `나누는 중인 줄 ${busy}개` : '';
  }

  // ── 줄 확인 문구(빨강 = 고쳐야 제출 · 주황 = 확인만) ──────────────────────
  /** 캡처에서 읽은 수취인이 그 줄 수취인과 다른가 — 다르면 캡처 이름, 같거나 모르면 ''. 마스킹(김*수)은 같은 길이·보이는 글자 일치면 같은 사람. */
  function capNameMismatch(it) {
    const ex = it && it.extract;
    const nm0 = it && it.fields && it.fields.recipient;
    if (!ex || !ex.recipient || !nm0) return '';
    const norm = s => String(s || '').replace(/\s+/g, '');
    const MASK = /[*＊●○]/;
    const cap = norm(ex.recipient), nm = norm(nm0);
    if (!MASK.test(cap)) return cap === nm ? '' : String(ex.recipient);
    const a = Array.from(cap), b = Array.from(nm);
    const hit = a.length === b.length && a.some(c => !MASK.test(c)) && a.every((c, k) => MASK.test(c) || c === b[k]);
    return hit ? '' : String(ex.recipient);
  }
  /** 줄의 확인 문구 목록 — [{k:'e'|'w'|'g'|'m', t}] (첫 줄이 칸에 보이고, 전체는 마우스 올림) */
  function rowNotes(it) {
    if (_blank(it)) return it.capture ? [{ k: 'm', t: '양식을 붙여넣으면 이 캡처와 함께 제출됩니다' }] : [];
    if (it.parsing || it.ver !== it.done) return [{ k: 'm', t: '나누는 중…' }];
    const out = [];
    if (it.netErr) out.push({ k: 'e', t: it.netErr });
    (it.errors || []).forEach(m => out.push({ k: 'e', t: m }));
    if (it.ok) {
      const ob = optBlock(it);
      if (ob === 'need') out.push({ k: 'e', t: '상품을 골라야 제출할 수 있습니다' });
      else if (ob === 'ack') out.push({ k: 'w', t: '고른 상품의 남은 자리를 넘습니다 — 상품 칸 「초과」 체크' });
      else if (OPTS.length && _optOf(it) && _optOf(it).todayRemaining === 0) out.push({ k: 'w', t: '오늘 몫은 찼지만 총 정원은 남아 있습니다 — 그대로 등록됩니다' });
      _productWarnList(it).forEach(t => out.push({ k: 'e', t }));
      const lbl = it.aiRepaired ? 'AI 보정' : (it.repairs || []).length ? '자동보정' : '';
      (it.warnings || []).forEach(m => out.push({ k: 'w', t: (lbl && !/^AI가/.test(m) ? lbl + ': ' : '') + m }));
      const capNm = capNameMismatch(it);
      if (capNm) out.push({ k: 'w', t: `이름이 다릅니다(캡처: ${capNm})` });
      if (appBlock(it)) out.push({ k: 'e', t: '기존 신청이 있어 확정할 신청을 골라야 제출할 수 있습니다' });
    }
    if (!out.length) out.push({ k: 'g', t: it.capture ? '정상 · 캡처 있음' : '정상' });
    return out;
  }
  function stCellInner(it) {
    const notes = rowNotes(it);
    if (!notes.length) return '';
    const top = notes.find(n => n.k === 'e') || notes.find(n => n.k === 'w') || notes[0];
    const ic = { e: 'fa-circle-xmark', w: 'fa-triangle-exclamation', g: 'fa-circle-check', m: top.t === '나누는 중…' ? 'fa-spinner fa-spin' : 'fa-circle-info' }[top.k];
    const all = notes.map(n => n.t).join('\n');
    return `<div class="mo-st ${top.k}" title="${esc(all)}"><i class="fa-solid ${ic}" aria-hidden="true"></i><span class="t">${esc(top.t)}</span>${notes.length > 1 ? `<span class="more">+${notes.length - 1}</span>` : ''}</div>`;
  }
  function rowClass(it) {
    const c = [];
    if (it === ACTIVE) c.push('sel');
    if (!_blank(it) && it.ver === it.done && !it.parsing) {
      // 상품 안 고름은 줄 전체를 빨갛게 칠하지 않는다(10줄을 붙이자마자 표 전체가 빨개진다) — 상품 칸 테두리 + 확인 칸 빨간 글자로 충분
      if (!it.ok || it.netErr || (it.productWarn || []).length) c.push('bad');
      else if ((it.repairs || []).length || it.aiRepaired || capNameMismatch(it)) c.push('fix');
    }
    return c.join(' ');
  }

  // ── 표 칸 목록(열 하나 = 항목 하나) ─────────────────────────────
  //    ★ 후속 칸(① 줄마다 리뷰어 「자동/기존 검색 고르기/새로 등록」 ② 동시진행이면 네이버·쿠팡 각각 주문번호·금액·캡처)은
  //      이 목록에 항목을 더하면 된다 — 머리·줄·폭 합계가 모두 여기서 나온다.
  const FIELD_OF_LABEL = { '리뷰어': 'reviewerName', '수취인': 'recipient', '아이디': 'userId', '전화번호': 'phone', '주소': 'address',
    '은행': 'bank', '계좌번호': 'account', '예금주': 'depositor', '결제금액': 'price' };
  function fieldCell(key, opt) {
    return (it, i) => {
      if (_blank(it)) return '<td></td>';
      const f = it.fields || {};
      const v = f[key];
      if ((v == null || v === '') && (it.missing || []).some(l => FIELD_OF_LABEL[l] === key)) {
        return `<td title="양식에서 이 칸을 찾지 못했습니다"><span class="mo-miss">없음</span></td>`;
      }
      if (!it.ok && !Object.keys(f).length) return '<td></td>';
      const shown = key === 'price' && v != null && v !== '' ? Number(v).toLocaleString('ko-KR') : (v == null ? '' : v);
      const extra = key === 'reviewerName' && f.isSubAccount ? '<span class="mo-tag" title="리뷰어와 수취인이 달라 타계정 참여로 처리합니다">타계정</span>' : '';
      const cls = 'mo-in' + (opt && opt.num ? ' num' : '');
      const inp = `<input class="${cls}" id="moF-${it.uid}-${key}" value="${esc(shown)}" title="${esc(shown)}" aria-label="${i + 1}번 줄 ${esc(opt && opt.label || key)}"
        oninput="ManualOrder.edit(${i},'${key}',this.value)" onfocus="ManualOrder.selectRow(${i})" onkeydown="ManualOrder.keyNav(event,${i})">`;
      return `<td${opt && opt.num ? ' class="r"' : ''}>${extra ? `<div class="mo-cellf">${inp}${extra}</div>` : inp}</td>`;
    };
  }
  function rawCell(it, i) {
    const tail = ROWS[ROWS.length - 1] === it;
    const ph = tail ? (i === 0 ? '여기에 카톡 구매양식을 붙여넣으세요 — 여러 줄이면 줄마다 나뉩니다' : '다음 사람 양식 붙여넣기') : '';
    return `<td class="stk2"><input class="mo-in raw" id="moRaw-${it.uid}" value="${esc(it.text)}" title="${esc(it.text)}" placeholder="${esc(ph)}"
      aria-label="${i + 1}번 줄 구매양식" autocomplete="off" spellcheck="false"
      oninput="ManualOrder.rowInput(${i},this.value,event)" onpaste="ManualOrder.rowPaste(event,${i})" onblur="ManualOrder.rowBlur(${i})"
      onfocus="ManualOrder.selectRow(${i})" onkeydown="ManualOrder.keyNav(event,${i})"></td>`;
  }
  function capCell(it, i) {
    // 붙여넣기가 안 먹는 브라우저(파이어폭스 등)를 위한 파일 선택 폴백 — 첨부 경로가 하나뿐이면 막힌다
    const pick = `<label class="mo-ib" title="${i + 1}번 줄에 캡처 파일 선택" aria-label="${i + 1}번 줄에 캡처 파일 선택"><i class="fa-solid fa-paperclip" aria-hidden="true"></i><input type="file" accept="image/*"
        onchange="ManualOrder.onFile(event,${i})"></label>`;
    if (it.capBusy) return `<td><div class="mo-cap"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span class="k">줄이는 중</span></div></td>`;
    if (it.capture) {
      const reading = !!it.extractPending;
      const thumb = 'data:' + it.capture.mime + ';base64,' + it.capture.base64;
      return `<td><div class="mo-cellf"><div class="mo-cap" id="moCap-${it.uid}" tabindex="0" title="${reading ? '캡처 읽는 중' : '이 줄의 구매캡처 — 눌러 고른 뒤 Ctrl+V 하면 바뀝니다'}"
          onpaste="ManualOrder.onPaste(event,${i})" onfocus="ManualOrder.selectRow(${i})"><img src="${thumb}" alt="${i + 1}번 줄 캡처">${reading ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>' : ''}</div>
        <button type="button" class="mo-ib" title="캡처 빼기" aria-label="${i + 1}번 줄 캡처 빼기" onclick="ManualOrder.uncap(${i})"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div></td>`;
    }
    return `<td><div class="mo-cellf"><div class="mo-cap empty" id="moCap-${it.uid}" tabindex="0" title="이 줄을 고른 뒤 Ctrl+V · 끌어다 놓기 · 클립 단추"
        onpaste="ManualOrder.onPaste(event,${i})" onfocus="ManualOrder.selectRow(${i})"><i class="fa-regular fa-image" aria-hidden="true"></i><span class="k">Ctrl+V</span></div>${pick}</div></td>`;
  }
  function appCell(it, i) {
    if (_blank(it) || !it.ok) return '<td></td>';
    const apps = Array.isArray(it.applications) ? it.applications : [];
    if (!apps.length) return '<td><span class="mo-auto">기존 신청 없음</span></td>';
    return `<td><select class="mo-sel${it.targetApplicationId ? '' : ' need'}" aria-label="${i + 1}번 줄 참여 신청" onchange="ManualOrder.pickApplication(${i},this.value)">
          <option value="">신청 선택 필수</option>${apps.map(a => `<option value="${esc(a.id)}" ${String(it.targetApplicationId) === String(a.id) ? 'selected' : ''}>#${esc(a.id)} · ${esc(a.applicant_name || '')} · ${esc(a.status)} · ${esc(a.applied_at || '')}</option>`).join('')}
        </select></td>`;
  }
  function cols() {
    const L = [
      { k: 'no', label: '', w: 30, cls: 'stk r', cell: (it, i) => `<td class="no stk">${i + 1}</td>` },
      { k: 'raw', label: '구매양식 (한 줄 = 한 사람)', w: 156, cls: 'stk2', title: '리뷰어/수취인/아이디/전화번호/주소/은행/계좌번호/예금주/결제금액', cell: rawCell },
      { k: 'reviewerName', label: '리뷰어', w: 96, cell: fieldCell('reviewerName', { label: '리뷰어' }) },
      { k: 'recipient', label: '수취인', w: 62, cell: fieldCell('recipient', { label: '수취인' }) },
      { k: 'userId', label: '아이디', w: 74, cell: fieldCell('userId', { label: '아이디' }) },
      { k: 'phone', label: '연락처', w: 118, cell: fieldCell('phone', { label: '연락처' }) },
      { k: 'address', label: '주소', w: 104, cell: fieldCell('address', { label: '주소' }) },
      { k: 'bank', label: '은행', w: 66, cell: fieldCell('bank', { label: '은행' }) },
      { k: 'account', label: '계좌번호', w: 128, cell: fieldCell('account', { label: '계좌번호' }) },
      { k: 'depositor', label: '예금주', w: 58, cell: fieldCell('depositor', { label: '예금주' }) },
      { k: 'price', label: '금액', w: 76, cls: 'r', cell: fieldCell('price', { label: '금액', num: true }) },
    ];
    // ★ 칸 합은 PC 1440(상자 1392px) 안에 든다(작업보드 1368 · 참여형 1372 — 주소는 늘 길어 잘림 + 마우스 올림이라 주소 칸에서 덜었다) — 넘으면 구매캡처 클립 단추가 오른쪽 고정 칸(확인)에 가린다
    if (OPTS.length) {
      const anyAck = ROWS.some(r => r.ok && !_blank(r) && _optOf(r) && _optOver(r));
      L.push({ k: 'opt', label: '상품(옵션)', w: 156, colCls: 'mo-c-opt' + (anyAck ? ' ack' : ''), cell: optCell });
    }
    if (CTX && CTX.campaignId) L.push({ k: 'app', label: '참여 신청', w: 160, cell: appCell });
    L.push({ k: 'cap', label: '구매캡처', w: 88, cell: capCell });
    // 확인 칸은 오른쪽에 고정(표를 옆으로 밀어도 늘 보인다) — 줄 삭제 단추도 이 칸 끝에
    L.push({ k: 'st', label: '확인', w: 168, cls: 'stkr', cell: (it, i) => {
      const del = (ROWS.length === 1 || (ROWS[ROWS.length - 1] === it && _blank(it) && !it.capture)) ? ''
        : `<button type="button" class="mo-ib del" title="${i + 1}번 줄 삭제" aria-label="${i + 1}번 줄 삭제" onclick="ManualOrder.delRow(${i})"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>`;
      return `<td class="stkr"><div class="mo-stw"><div id="moSt-${it.uid}">${stCellInner(it)}</div>${del}</div></td>`;
    } });
    return L;
  }

  function rowHtml(it, i, C) {
    return `<tr id="moR-${it.uid}" class="${rowClass(it)}" onmousedown="ManualOrder.selectRow(${i})"
      ondragover="event.preventDefault();this.classList.add('over')" ondragleave="this.classList.remove('over')" ondrop="ManualOrder.onDrop(event,${i})">
      ${C.map(c => c.cell(it, i)).join('')}</tr>`;
  }

  /** 표 화면(한 화면 — 붙여넣기 · 나뉜 결과 · 캡처 · 상품 · 제출). 다시 그려도 커서·선택 범위를 되살린다. */
  function renderPreview() {
    if (!CTX) return;
    CTX.view = 'table';
    const ae = document.activeElement;
    const keep = ae && ae.id && /^mo(Raw|F|Opt|Ack|Cap)-/.test(ae.id)
      ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
    // 글자 칸(양식·나뉜 값)에 포커스가 있으면 그 요소를 살린 채 다시 그린다(_morphKeep)
    const keepEl = keep && ae.tagName === 'INPUT' && /^mo(Raw|F)-/.test(ae.id) ? ae : null;
    const bd0 = document.getElementById('moBd');
    const scroll = bd0 ? { t: bd0.scrollTop, l: bd0.scrollLeft } : null;
    const filled = _filled();
    const done = filled.filter(r => r.ver === r.done && !r.parsing);
    const okN = done.filter(r => r.ok && !r.netErr).length;
    const badN = done.length - okN;
    const fixN = done.filter(r => (r.repairs || []).length || r.aiRepaired).length;
    const capN = filled.filter(r => r.capture).length;
    const nameN = done.filter(r => capNameMismatch(r)).length;
    const C = cols();
    const total = C.reduce((s, c) => s + c.w, 0);
    const bar = `<div class="mo-bar" role="status">
        <span class="g"><span class="n">${okN}</span> 정상</span>
        <span class="e"><span class="n">${badN}</span> 오류</span>
        <span class="w" title="슬래시(/)가 빠진 자리를 시스템이 찾아 나눈 줄 — 값이 맞는지 꼭 확인하세요">자동보정 <span class="n">${fixN}</span>건</span>
        <span>캡처 <span class="n">${capN}</span>/<span class="n">${filled.length}</span></span>
        ${nameN ? `<span class="w">이름 다름 <span class="n">${nameN}</span></span>` : ''}
        <span class="sp"></span>
        <span class="hint">줄을 누르고 <kbd>Ctrl</kbd>+<kbd>V</kbd> 하면 그 줄에 캡처가 붙습니다</span>
      </div>`;
    shell(`
      <div class="mo-tw">
        <table class="mo-tbl" style="min-width:${total}px">
          <colgroup>${C.map(c => `<col${c.colCls ? ` class="${c.colCls}"` : ''} style="width:${c.w}px">`).join('')}</colgroup>
          <thead><tr>${C.map(c => `<th class="${c.cls || ''}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
          <tbody>${ROWS.map((it, i) => rowHtml(it, i, C)).join('')}</tbody>
        </table>
      </div>
      <div class="mo-guide">
        순서: <b>리뷰어 / 수취인 / 아이디 / 전화번호 / 주소 / 은행 / 계좌번호 / 예금주 / 결제금액</b> — 여러 줄을 한 번에 붙여넣으면 줄마다 나뉘고, 붙이는 즉시 옆 칸에 나뉜 값이 보입니다<br>
        주소에 슬래시(/)가 있어도 앞뒤 칸이 밀리지 않게 자동으로 주소로 합칩니다 · 리뷰어와 수취인이 다르면 <b>타계정 참여</b>로 처리합니다<br>
        <b>주황</b> = 슬래시가 빠진 자리를 시스템이 찾아 나눈 줄(자동보정 · AI 보정) — 값이 맞는지 꼭 확인하세요 · <b>빨강</b> = 고쳐야 제출됩니다 · 나뉜 칸을 눌러 바로 고칠 수 있습니다<br>
        구매캡처는 <b>줄마다</b> 붙입니다 — 그 줄을 누르고 Ctrl+V · 그 줄에 끌어다 놓기 · 클립 단추. 캡처 속 수취인 이름이 그 줄과 다르면 경고만 띄웁니다${CTX.campaignId ? `<br>
        참여형 공고에서 기존 신청이 보이면 <b>확정할 신청을 반드시 선택</b>하세요. 전화번호만으로 새 신청을 자동 확정하지 않습니다` : ''}${OPTS.length >= 2 ? `<br>
        이 작업은 상품이 ${OPTS.length}개입니다 — <b>줄마다 상품을 골라야</b> 제출됩니다. 고른 상품이 작업표 「상품」 칸과 그 상품의 사용 수에 그대로 들어갑니다 ·
        이미 찬 상품은 막지 않고 <b>확인 체크</b>를 받습니다 — 이미 구매가 끝난 건이라 기록이 비는 것보다 낫기 때문입니다` : ''}
      </div>`,
      `<button type="button" class="mo-btn" onclick="ManualOrder.close(true)">닫기</button><span class="sp"></span>
       <span class="mo-tip" id="moOptTip" role="status"></span>
       <button type="button" class="mo-btn pri" id="moSubmit" ${okN ? '' : 'disabled'} onclick="ManualOrder.submit()">${okN}건 제출</button>`,
      { bar, keepEl });
    if (scroll) {
      const bd = document.getElementById('moBd'); if (bd) bd.scrollTop = scroll.t;
      if (bd) bd.scrollLeft = scroll.l;
    }
    if (keep && !(keepEl && keepEl.isConnected && document.activeElement === keepEl)) {
      const el = document.getElementById(keep.id);
      if (el) { el.focus(); try { if (keep.s != null && el.setSelectionRange) el.setSelectionRange(keep.s, keep.e); } catch (_) {} }
    }
    syncSubmitBtn();
  }
  /** 표를 다시 그린다 — 한글 조합 중이면 조합이 끝난 뒤로 미룬다 · 결과 화면이면 건드리지 않는다 */
  function paint() {
    if (!CTX || CTX.view !== 'table') return;
    if (IME) { PAINT_LATER = true; return; }
    renderPreview();
  }

  /** 줄 고르기 — Ctrl+V 사진이 들어갈 줄. 표를 다시 그리지 않고 표시만 옮긴다(입력 중 커서 유지). */
  function selectRow(i) { const row = ROWS[i]; if (row) select(row); }
  function select(row) {
    if (ACTIVE === row) return;
    const prev = ACTIVE; ACTIVE = row;
    [prev, row].forEach(r => {
      if (!r) return;
      const tr = document.getElementById('moR-' + r.uid);
      if (tr && tr.classList) tr.classList.toggle('sel', r === ACTIVE);
    });
  }
  /** 위·아래 화살표·Enter 로 같은 칸의 위아래 줄로 */
  function keyNav(ev, i) {
    if (!ev || ev.isComposing) return;
    const d = ev.key === 'ArrowDown' || ev.key === 'Enter' ? 1 : ev.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    const to = ROWS[i + d]; if (!to) return;
    const id = (ev.target && ev.target.id) || '';
    const m = /^mo(Raw|F)-\d+(-\w+)?$/.exec(id); if (!m) return;
    const el = document.getElementById(m[1] === 'Raw' ? 'moRaw-' + to.uid : 'moF-' + to.uid + m[2]);
    if (el) { ev.preventDefault(); el.focus(); }
  }
  function delRow(i) {
    const row = ROWS[i]; if (!row) return;
    ROWS.splice(i, 1); DIRTY.delete(row);
    if (ACTIVE === row) ACTIVE = null;
    if (!ROWS.length) ROWS.push(newRow(''));
    ensureTail();
    paint();
  }

  /** 제출 결과 화면의 [계속 입력] — 결정 345 ①⑩: 접수된 줄은 다시 넣지 않는다(이중 등록 방지).
   *  실패·미제출 줄만 표에 남긴다 — 캡처는 그 줄 자신의 것이라 다른 사람에게 옮겨 붙지 않는다. */
  function again() {
    const keep = ((CTX && CTX.retry) || []).filter(r => r && !_blank(r));
    ROWS = keep; ACTIVE = null; DIRTY.clear();
    if (CTX) CTX.retry = null;
    ensureTail();
    renderPreview();
  }
  /** 한 줄을 9칸 슬래시양식으로 되돌린다(고친 값 유지). 나누기 실패 줄은 원문(raw)이 있으면 원문 그대로. */
  function _lineOf(r) {
    if (r && r.ok === false && r.raw) return String(r.raw);
    const f = (r && r.fields) || {};
    return ['reviewerName', 'recipient', 'userId', 'phone', 'address', 'bank', 'account', 'depositor', 'price']
      .map(k => String(f[k] == null ? '' : f[k]).replace(/\n/g, ' ')).join('/');
  }

  async function loadApplicationCandidates(rows) {
    if (!CTX || !CTX.campaignId) return;
    rows = (rows || ROWS).filter(r => r && r.ok && r.fields);
    if (!rows.length) return;
    if (!CTX.apps) {
      try {
        // ★ 결정 345 ⑪: 경로는 호스트가 재기준한다(`window.CAMPAIGN_ADMIN_API` — campaign-cards 와 같은 장치).
        //   인트라넷 로그인(리뷰웹시스템[3버전])은 /api/trackb/campaigns 로만 닿는다 — 같은 핸들러라 응답 모양이 같다.
        const cb = (typeof window.CAMPAIGN_ADMIN_API === 'string' && window.CAMPAIGN_ADMIN_API) ? window.CAMPAIGN_ADMIN_API.replace(/\/$/, '') : '/api/campaign/admin';
        const r = await api(cb + '/' + encodeURIComponent(CTX.campaignId) + '/applications');
        if (!CTX) return;
        CTX.apps = r && r.ok && Array.isArray(r.data) ? r.data : null;
      } catch (_) { return; }
    }
    const data = CTX.apps || [];
    const p8 = v => String(v || '').replace(/\D/g, '').slice(-8);
    rows.forEach(row => {
      const key = p8(row.fields && row.fields.phone);
      row.applications = key ? data.filter(a => String(a.phone8 || '') === key && ['applied', 'expired', 'cancelled'].includes(a.status)) : [];
      if (row.targetApplicationId && !row.applications.some(a => String(a.id) === String(row.targetApplicationId))) row.targetApplicationId = '';
    });
  }

  function pickApplication(i, id) {
    const row = ROWS[i]; if (row) { row.targetApplicationId = id || ''; row.productWarn = null; }
    _refreshRow(row);
  }

  const REQUIRED = ['reviewerName', 'recipient', 'phone', 'address', 'bank', 'account', 'depositor', 'price'];

  /** 한 줄의 표시(색·확인 칸·제출 단추)만 맞춘다 — 표를 다시 그리지 않는다(입력 중 커서 유지) */
  function _refreshRow(it) {
    if (!it) return;
    const tr = document.getElementById('moR-' + it.uid);
    if (tr) tr.className = rowClass(it);
    const st = document.getElementById('moSt-' + it.uid);
    if (st) st.innerHTML = stCellInner(it);
    syncSubmitBtn();
  }

  // 나뉜 칸 인라인 수정 — 값만 바꾸고 표는 다시 그리지 않는다(입력 중 포커스 유실 방지).
  // 양식 칸(한 줄 글)도 고친 값으로 맞춘다(다시 나누지는 않는다 — 사람이 고친 값을 서버가 되돌리지 않게).
  function edit(i, key, val) {
    const it = ROWS[i]; if (!it) return;
    if (key === 'price' || key === 'phone') it.productWarn = null;
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
    it.netErr = '';
    it.missing = [];
    // 고친 줄에 옛 오류 문구가 남아 있으면 "아직 오류"로 읽힌다 → 확인 칸을 함께 갱신(상품 확인 이유는 금액·연락처를 고치면 지운다 — 결정 236).
    // ★ 자동보정·AI 보정 표시는 지우지 않는다(조용한 수정 금지 — 다른 칸을 고쳤다고 보정 사실이 사라지면 안 된다).
    // 양식 글을 고친 값으로 — 다시 나누지 않도록 '나눈 판'을 같이 올린다
    it.raw = '';
    it.text = _lineOf(it); it.ver++; it.done = it.ver;
    DIRTY.delete(it);
    const raw = document.getElementById('moRaw-' + it.uid);
    if (raw) { raw.value = it.text; raw.title = it.text; }
    _refreshRow(it);
  }

  // ── 줄별 캡처 — 고른 줄 · 그 줄 칸 · 그 줄에 끌어다 놓기 · 파일 선택, 어느 길이든 그 줄에만 ───────
  function _imagesFrom(cd) {
    const out = [];
    for (const it of ((cd && cd.items) || [])) {
      if (it.type && it.type.indexOf('image/') === 0) { const f = it.getAsFile(); if (f) out.push(f); }
    }
    if (!out.length && cd && cd.files) for (const f of Array.from(cd.files)) if (f && f.type && f.type.indexOf('image/') === 0) out.push(f);
    return out;
  }
  /** 한 줄에 사진을 넣는 길은 이 한 곳 — 한 줄 = 캡처 한 장(여러 장이면 첫 장만, 나머지는 버리고 알린다) */
  function takeImages(row, files) {
    const imgs = Array.from(files || []).filter(f => f && f.type && f.type.indexOf('image/') === 0);
    if (!imgs.length || !row || ROWS.indexOf(row) < 0) return;
    if (imgs.length > 1) _toast('한 줄에 캡처 한 장 — 첫 장만 ' + (ROWS.indexOf(row) + 1) + '번 줄에 붙였습니다');
    attach(row, imgs[0]);
  }
  function onPaste(ev, i) {
    const imgs = _imagesFrom(ev.clipboardData);
    if (!imgs.length) return;
    ev.preventDefault();
    const row = ROWS[i]; if (!row) return;
    select(row);
    takeImages(row, imgs);
  }
  function onFile(ev, i) {
    const files = (ev.target && ev.target.files) || [];
    const row = ROWS[i];
    if (row) { select(row); takeImages(row, files); }
    try { ev.target.value = ''; } catch (_) {}
  }
  function onDrop(ev, i) {
    ev.preventDefault();
    try { if (ev.currentTarget && ev.currentTarget.classList) ev.currentTarget.classList.remove('over'); } catch (_) {}
    const row = ROWS[i]; if (!row) return;
    select(row);
    takeImages(row, (ev.dataTransfer && ev.dataTransfer.files) || []);
  }
  function uncap(i) {
    const row = ROWS[i]; if (!row) return;
    row.capture = null; row.extract = null; row.extractPending = null; row.productWarn = null;
    paint();
  }
  /* ★ 표가 떠 있으면 칸을 따로 누르지 않아도 Ctrl+V 사진은 **고른 줄**로 — 고른 줄이 없으면 받지 않고 알린다(아무 줄에나 붙이지 않는다).
     칸·글자칸이 이미 처리했으면(defaultPrevented) 건너뛴다 · 사진이 없으면 가로채지 않는다(글자 붙여넣기 그대로). */
  document.addEventListener('paste', ev => {
    if (ev.defaultPrevented) return;
    if (!CTX || CTX.view !== 'table' || !document.getElementById('moOvl')) return;
    const imgs = _imagesFrom(ev.clipboardData);
    if (!imgs.length) return;
    ev.preventDefault();
    const row = ACTIVE && ROWS.indexOf(ACTIVE) >= 0 ? ACTIVE : null;
    if (!row) { _toast('캡처를 붙일 줄을 먼저 눌러 고르세요'); return; }
    takeImages(row, imgs);
  });

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

  /** 줄에 붙은 캡처를 AI 로 읽는다 — 진행 중이면 그 약속을 그대로 돌려준다(제출이 기다릴 수 있게 · 결정 236 Codex 리뷰).
   *  실패해도 첨부는 유지(슬래시양식이 정본). */
  function readCapture(row) {
    if (!row || !row.capture) return Promise.resolve();
    if (row.extract) return Promise.resolve();
    if (row.extractPending) return row.extractPending;
    const cap = row.capture;
    row.extractPending = (async () => {
      try {
        const r = await api('/api/image/image-extract', { method: 'POST', body: JSON.stringify({ imageBase64: cap.base64, mimeType: cap.mime }) });
        if (r && r.ok && row.capture === cap) row.extract = r;
      } catch (_) { /* 추출 실패는 무시 */ }
      finally { if (row.capture === cap) row.extractPending = null; }
    })();
    return row.extractPending;
  }
  /** 제출 전에 캡처 줄이기·판독이 끝나기를 기다린다 — 판독 전에 보내면 캡처 글자 근거가 빠진 채 접수된다(결정 236).
   *  최대 25초(넘으면 판독 없이 보낸다 = 종전). */
  async function awaitCaptureReads(rows) {
    const shrinking = ROWS.filter(r => r && r.capJob).map(r => r.capJob);
    if (shrinking.length) await Promise.race([Promise.all(shrinking), sleep(CAPTURE_WAIT_MS)]);
    const jobs = rows.filter(r => r && r.capture && !r.extract).map(readCapture);
    if (!jobs.length) return;
    await Promise.race([Promise.all(jobs), sleep(CAPTURE_WAIT_MS)]);
  }
  /** 이 줄에만 캡처를 붙인다(i = 줄 번호 또는 줄 객체). 사진을 줄이는 동안 줄을 지우면 버린다. */
  function attach(i, file) {
    const row = typeof i === 'number' ? ROWS[i] : i; if (!row) return;
    row.capBusy = true;
    paint();
    const job = (async () => {
      const shrunk = await shrink(file);
      if (row.capJob === job) { row.capBusy = false; row.capJob = null; }
      if (ROWS.indexOf(row) < 0 || !CTX) return;   // 그사이 줄을 지웠거나 창을 닫았다
      if (!shrunk || !shrunk.base64) { alert('이미지를 읽지 못했습니다.'); paint(); return; }
      const b64 = shrunk.base64;
      row.capture = { base64: b64, mime: shrunk.mime };
      row.productWarn = null;   // 캡처가 바뀌면 상품 확인 이유도 다시 판정한다(결정 236)
      row.extract = null; row.extractPending = null;
      ensureTail();
      paint();
      // 캡처에서 수취인·주문번호 등 자동 인식(실패해도 첨부는 유지) — 이름이 다르면 경고만(제출은 막지 않는다)
      const p = readCapture(row);
      paint();
      await p;
      if (row.extract && row.capture && row.capture.base64 === b64) {
        if (row.extract.orderNumber && row.fields && !row.fields.orderNum) row.fields.orderNum = row.extract.orderNumber;
      }
      paint();
    })();
    row.capJob = job;
    return job;
  }

  // ── 제출 ──────────────────────────────────────────────────
  async function submit() {
    if (BUSY) return;
    await flush();   // 막 붙여넣은 줄이 아직 나뉘는 중이면 끝까지 기다린다(옛 값으로 보내지 않는다)
    if (!CTX) return;
    const targets = ROWS.map((r, i) => ({ r, i })).filter(x => submittable(x.r));
    if (!targets.length) return;
    if (!confirm(`${targets.length}건을 제출합니다.\n리뷰어 자동 등록${CTX.campaignId ? ' · 모집 정원 차감' : ''}이 함께 진행됩니다.`)) return;
    BUSY = true;
    const btn = document.getElementById('moSubmit');
    if (btn) { btn.disabled = true; btn.textContent = '캡처 읽는 중…'; }
    await awaitCaptureReads(targets.map(x => x.r));
    if (btn) btn.textContent = '제출 중…';

    // ★ 오늘 정원 초과는 **막지 않고 확인만 받는다**(사용자 확정 2026-08-19). 서버가 배치를
    //   시작하기 전에 판정해 `needConfirm`으로 되돌리므로, 이 시점까지 **쓰기는 0건**이다.
    //   확인하면 `allowOverDaily`로 재전송한다.
    // subset = 다시 보낼 targets 인덱스 목록(없으면 전체) · force = 중복 경고 확인 후 재시도
    const post = (allowOverDaily, allowRepurchase, subset, force) => api(_moBase() + '/submit', {
      method: 'POST',
      body: JSON.stringify({
        sheetId: CTX.sheetId, tabName: CTX.tabName, gid: CTX.gid || '',
        campaignId: CTX.campaignId || null,
        allowOverDaily: allowOverDaily === true,
        allowRepurchase: allowRepurchase === true,
        force: force === true,
        optionAware: OPTS.length > 0,   // ★ 결정 211: 서버가 "안 고름·마감 미확인"을 막는 것은 이 화면에서 온 요청만
        productCheck: true,              // ★ 결정 236 ⑤: 상품 확인(결제금액·캡처·참여 신청) — 이 화면에서 온 요청만
        allowProductMismatch: _productOk,
        items: (subset ? subset.map(i => targets[i]) : targets)
          .map(x => ({ fields: x.r.fields, optionKey: x.r.optKey || x.r.fields.optionKey || '', optionFullAck: x.r.optFullAck === true,
                       targetApplicationId: x.r.targetApplicationId || null,
                       captureName: (x.r.extract && x.r.extract.productName) || '',
                       captureOption: (x.r.extract && typeof x.r.extract.productOption === 'string') ? x.r.extract.productOption : '' })),
      }),
    });

    let out;
    let _repurchaseOk = false;
    let _overDailyOk = false;
    let _productOk = false;
    try {
      out = await post(false, false);
      // ★ 확인 단계(재참여 → 오늘 몫 → 상품 확인)는 서버가 요청마다 다시 판정한다 — 확인 뒤 다시 보낸 응답이
      //   앞 단계를 새로 돌려줄 수 있다(창이 열린 사이 정원·재참여 상태가 바뀜). 그래서 돌아온 needConfirm 을
      //   **순서와 무관하게 반복 처리**한다. 같은 단계를 두 번 확인하지는 않는다(무한 반복 방지 · Codex 리뷰).
      for (let _gate = 0; out && out.needConfirm && _gate < 6; _gate++) {
        if (out.needConfirm === 'repurchase_window' && !_repurchaseOk) {
          const list = (out.blocked || []).map(b => {
            const d = b.availableFrom ? new Date(b.availableFrom).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short' }) : '?';
            return `· ${b.name || '(이름없음)'} — ${d} 이후 재참여 가능`;
          }).join('\n');
          const okGo = confirm(
            `${(out.blocked || []).length}건이 최근 며칠 안에 이 작업에 이미 참여한 연락처예요.\n\n${list}\n\n`
            + `다른 사람인데 번호만 같은 경우가 아니라면 [취소]하고 확인해주세요.\n`
            + `[확인] 그대로 강제 접수합니다.\n`
            + `[취소] 아무것도 접수되지 않았습니다.`);
          if (!okGo) {
            BUSY = false;
            if (btn) { btn.disabled = false; btn.textContent = targets.length + '건 제출'; }
            return;   // 서버는 아직 아무것도 쓰지 않았다
          }
          _repurchaseOk = true;
        } else if (out.needConfirm === 'over_daily' && !_overDailyOk) {
          const q = out.quota || {};
          // ★ 외부모집은 **이미 구매가 끝난 건의 사후 등록**이다 — 취소해도 구매가 되돌아가지
          //   않고 기록만 빠진다. 그래서 "진행할까요?"(취소가 안전해 보이는 질문)가 아니라
          //   "초과로 기록됩니다"(고지) + 취소의 실제 의미를 문장으로 말한다(사용자 지적 2026-08-19).
          const okGo = confirm(
            `오늘 모집인원을 넘겨 기록됩니다.\n\n`
            + `· 오늘 정원 ${q.quota}명 중 ${q.todayCount}명 접수됨 (남은 자리 ${q.remaining}명)\n`
            + `· 지금 접수 ${q.want}건 → ${q.over}명 초과\n\n`
            + `이미 구매가 끝난 건이라 접수를 미뤄도 구매는 취소되지 않습니다.\n`
            + `[확인] 초과 상태로 그대로 기록합니다.\n`
            + `[취소] 이 건은 시스템에 남지 않습니다 — 나중에 다시 접수해야 합니다.`);
          if (!okGo) {
            BUSY = false;
            if (btn) { btn.disabled = false; btn.textContent = targets.length + '건 제출'; }
            return;   // 서버는 아직 아무것도 쓰지 않았다
          }
          _overDailyOk = true;
        } else if (out.needConfirm === 'product_check' && !_productOk) {
          // ★ 결정 236 ⑤: 고른 상품과 다른 상품을 산 것으로 보이는 줄 — 서버가 **쓰기 0건**으로 되돌린다.
          //   (가) 확인하면 그대로 접수하고 담당자 확인 기록을 남긴다 · 취소하면 그 줄에 이유를 붙여 표로 돌아간다(상품을 고쳐 다시 제출).
          const flagged = out.flagged || [];
          const list = flagged.map(f => `· ${f.name || '(이름없음)'}${f.chosen ? ` — 고른 상품 「${f.chosen}」` : ''}\n   ${(f.notes || []).join('\n   ')}`).join('\n');
          // 신청 기록만 걸린 줄뿐이면 "다른 상품을 샀다"고 단정하지 않는다(코드리뷰)
          const onlyApp = flagged.every(f => Array.isArray(f.kinds) && f.kinds.length && f.kinds.every(k => k === 'application'));
          const okGo = confirm(
            (onlyApp ? `${flagged.length}건은 방금 다른 상품·공고로 참여 신청한 연락처예요. 넣으려는 상품이 맞는지 확인해 주세요.`
                     : `${flagged.length}건이 고른 상품과 다른 상품을 산 것으로 보여요.`)
            + `\n\n${list}\n\n`
            + `[확인] 확인했고 그대로 접수합니다(담당자 확인 기록이 남습니다).\n`
            + `[취소] 아무것도 접수되지 않았습니다 — 표에서 상품을 고친 뒤 다시 제출하세요.`);
          if (!okGo) {
            for (const f of flagged) {
              const t = targets[f.index];
              if (t && t.r) t.r.productWarn = (f.notes || []).slice();
            }
            BUSY = false;
            renderPreview();
            return;   // 서버는 아직 아무것도 쓰지 않았다
          }
          _productOk = true;
        } else break;
        out = await post(_overDailyOk, _repurchaseOk);
      }
      // ★ 같은 구매로 보이는 건(24시간 내 같은 연락처 · 같은 주문번호·연락처 — 결정 193)은 서버가 **그 건만**
      //   접수하지 않고 되돌린다(나머지는 이미 접수됨). 다른 구매가 맞는 경우가 있어 막다른 길로 두지 않고,
      //   확인을 받은 뒤 **그 건들만** force 로 다시 보낸다. 결과는 원래 자리(index)에 덮어쓴다.
      // ★ 결정 345 ⑨: 같은 연락처가 묶음에 두 줄이면 뒤 줄은 24시간 중복(또는 건별 재참여 기간)으로 돌아온다. 다시 보낼 때 재참여 기간
      //   확인도 함께 넘긴다 — 안 넘기면 서버 사전 판정이 방금 접수된 앞 줄 때문에 다시 막아 "강제 등록 가능" 안내가 막다른 길이 된다.
      const dups = (out && out.ok && Array.isArray(out.results)) ? out.results.filter(r => r && !r.ok && (r.duplicate || r.repurchaseBlocked)) : [];
      if (dups.length) {
        const list = dups.map(r => `· ${r.name || '(이름없음)'} — ${r.error || ''}`).join('\n');
        const okGo = confirm(
          `${dups.length}건이 이미 접수된 구매와 겹치거나 최근 참여한 연락처라 접수하지 않았어요(나머지는 접수됨).\n\n${list}\n\n`
          + `같은 구매를 두 번 등록하면 한 구매가 두 명으로 세어져 모집이 일찍 마감됩니다.\n`
          + `[확인] 다른 구매가 맞으니 따로 접수합니다(재참여 기간 확인도 함께 넘깁니다).\n`
          + `[취소] 이 건들은 접수하지 않습니다.`);
        if (okGo) {
          const idxs = dups.map(r => r.index);
          try {
            const out2 = await post(_overDailyOk, true, idxs, true);
            if (out2 && out2.ok && Array.isArray(out2.results)) {
              for (const r2 of out2.results) {
                const orig = idxs[r2.index];
                r2.index = orig;
                const pos = out.results.findIndex(r => r && r.index === orig);
                if (pos >= 0) out.results[pos] = r2;
              }
              out.okCount = out.results.filter(r => r && r.ok).length;
              out.failCount = out.results.length - out.okCount;
            } else {
              alert('다시 접수 실패: ' + ((out2 && (out2.error || out2.needConfirm)) || '오류') + '\n(처음 접수된 건은 그대로입니다)'
                + (out2 && out2.needConfirm === 'product_check' ? '\n상품 확인이 필요한 건입니다 — 그 줄만 다시 붙여넣어 제출하면 확인창이 뜹니다.' : ''));
            }
          } catch (e) { alert('다시 접수 실패: ' + e.message + '\n(처음 접수된 건은 그대로입니다)'); }
        }
      }
    } catch (e) { out = { ok: false, error: e.message }; }

    if (!out || !out.ok) {
      BUSY = false;
      if (btn) { btn.disabled = false; btn.textContent = targets.length + '건 제출'; }
      // ★ 결정 344: 동시진행 작업 등 서버가 막은 이유는 서버 문구 그대로 보여준다
      alert('제출 실패: ' + ((out && out.error) || '오류'));
      return;
    }

    // ★ 결정 345 ①⑩: 실패·미제출 줄만 [계속 입력]이 표에 남긴다(접수된 줄을 다시 내 이중 등록하지 않게).
    //   캡처는 줄마다 붙어 있으므로 성공한 사람의 캡처는 그 줄과 함께 사라진다(다음 사람 주문에 또 올라가지 않는다).
    {
      const okRows = new Set();
      (out.results || []).forEach((res, k) => {
        if (!res || !res.ok) return;
        const t = typeof res.index === 'number' ? targets[res.index] : targets[k];
        if (t) okRows.add(t.r);
      });
      CTX.retry = ROWS.filter(r => !okRows.has(r) && !_blank(r));
    }
    // ★ 결정 345 ⑧: 작업보드는 캡처 업로드를 기다리지 않고 바로 다시 불러온다(줄은 이미 기록됐다).
    let _refreshed = false;
    try { if ((Number(out.okCount) || 0) > 0 && typeof CTX.onSubmitted === 'function') { _refreshed = true; CTX.onSubmitted(out); } } catch (_) {}

    // 성공 건의 캡처를 주문에 연결(기존 업로드 경로 재사용 — 신규 저장소 0)
    for (let k = 0; k < (out.results || []).length; k++) {
      const res = out.results[k];
      const t = (res && typeof res.index === 'number') ? targets[res.index] : targets[k];
      const src = t && t.r;
      if (!res || !res.ok || !src || !src.capture || !res.orderSubmissionId) continue;
      const capSession = res.captureSession || {};
      if (!capSession.id || !capSession.token) {
        res.captureAttached = false;
        (res.warnings = res.warnings || []).push('구매캡쳐 제출 세션을 발급받지 못했습니다');
        continue;
      }
      try {
        const up = await api('/api/image/image-upload', {
          method: 'POST',
          body: JSON.stringify({
            imageBase64: src.capture.base64, mimeType: src.capture.mime,
            fileName: (src.fields.recipient || '주문캡처') + '.' + (src.capture.mime === 'image/png' ? 'png' : 'jpg'),
            tabName: CTX.tabName, sheetId: CTX.sheetId, displayName: CTX.title || '',
            orderSubmissionId: res.orderSubmissionId,
            captureSessionId: capSession.id,
            captureSessionToken: capSession.token,
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
    renderResult(out, _refreshed);
  }

  function renderResult(out, refreshed) {
    if (!CTX) return;
    CTX.view = 'result';
    const rows = (out.results || []).map(r => {
      if (r.ok) {
        const bits = [];
        if (r.reviewerRegistered) bits.push(r.linkedOwner ? `‘${esc(r.linkedOwner)}’ 리뷰어의 타계정으로 등록` : '리뷰어 자동 등록됨');
        if (r.quotaCounted) bits.push('모집인원 1명 차감');
        if (r.captureAttached) bits.push('구매캡쳐 첨부됨');
        // ★ 결정 345 ⑦: 무시트 작업표에 바로 적혔으면 서버가 줄 번호를 준다 — "자동복구 대기"로 잘못 말하지 않는다
        bits.push(r.worktableRow ? `작업표 ${Number(r.worktableRow)}번 줄에 기록됨` : r.queued ? '시트 기록 예약됨' : '시트 기록은 자동복구 대기');
        const warn = (r.warnings || []).length
          ? `<div class="w"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${(r.warnings || []).map(esc).join(' · ')}</div>` : '';
        return `<div class="mo-res ok"><span class="ci"><i class="fa-solid fa-circle-check" aria-hidden="true"></i></span><div>
          <div class="t">${esc(r.name || '')} — 접수 완료</div>
          <div class="s">${bits.join(' · ')}</div>${warn}</div></div>`;
      }
      return `<div class="mo-res no"><span class="ci"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i></span><div>
        <div class="t">${esc(r.name || '')} — 실패</div>
        <div class="s">${esc(r.error || '알 수 없는 오류')}</div></div></div>`;
    }).join('');
    shell(`
        ${rows}
        ${out.failCount ? '<div class="mo-guide">[계속 입력]을 누르면 실패한 줄만 표에 다시 남습니다 — 원인을 고쳐 다시 제출하세요. 성공한 건은 이미 접수되어 다시 넣으면 중복됩니다.</div>' : ''}`,
      `<span class="sp"></span>
       <button type="button" class="mo-btn" onclick="ManualOrder.again()">계속 입력</button>
       <button type="button" class="mo-btn pri" onclick="ManualOrder.close()">완료</button>`,
      { narrow: true, bar: `<div class="mo-sum" role="status"><span>제출 결과</span><span>성공 <b>${Number(out.okCount) || 0}</b>건</span>${out.failCount ? `<span>실패 <b>${Number(out.failCount)}</b>건</span>` : ''}</div>` });
    // 목록/관제가 열려 있으면 갱신(있을 때만 — 없는 화면에서 조용히 무시)
    try { if (typeof loadTabDashboard === 'function') loadTabDashboard(); } catch (_) {}
    try { if (CTX && CTX.campaignId && typeof _loadCampControl === 'function') _loadCampControl(CTX.campaignId); } catch (_) {}
    // 캡처가 붙었으면 한 번 더(작업표의 캡처 칸) — 업로드 전에 이미 한 번 불렀다(⑧)
    try { if ((!refreshed || (out.results || []).some(r => r && r.captureAttached)) && (Number(out.okCount) || 0) > 0 && typeof CTX.onSubmitted === 'function') CTX.onSubmitted(out); } catch (_) {}
  }

  window.ManualOrder = {
    open, close, submit, again, edit, pickApplication, pickOption, ackOption,
    rowInput, rowPaste, rowBlur, pasteLines, flush, ime, selectRow, keyNav, delRow,   // 한 줄 = 한 사람 표
    onPaste, onFile, onDrop, uncap,                                                    // 줄별 캡처 첨부
  };
})();
