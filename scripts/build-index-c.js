/* index.html → index-c.html 변환 (시안 C 테마 + 모집공고 카드/행 전환 + 카드 재디자인)
   - 기존 마크업/ID/onclick 핸들러를 보존하고, 스타일 오버레이 + 모집공고 카드 재디자인 + 토글만 덧입힌다.
   - 각 치환이 실제로 일어났는지 검증(실패 시 throw)한다. */
const fs = require('fs');
const path = require('path');
const BT = String.fromCharCode(96); // 백틱

const FE  = path.join(__dirname, '..', 'frontend');
const SRC = path.join(FE, 'index.html');
const OUT = path.join(FE, 'index-c.html');
let html = fs.readFileSync(SRC, 'utf8');
const RC_TPL = fs.readFileSync(path.join(__dirname, 'rc-card.tpl'), 'utf8').replace(/\n$/, '');

function must(cond, msg){ if(!cond){ throw new Error('변환 실패: ' + msg); } }
function replaceOne(from, to, label){
  const i = html.indexOf(from);
  must(i !== -1, label + ' (앵커 없음)');
  must(html.indexOf(from, i + from.length) === -1, label + ' (앵커 중복)');
  html = html.slice(0, i) + to + html.slice(i + from.length);
}
function replaceAll(from, to, expected, label){
  const parts = html.split(from);
  must(parts.length - 1 === expected, `${label} (기대 ${expected}건, 실제 ${parts.length-1}건)`);
  html = parts.join(to);
}

/* ── 1) 시안 C 테마 오버레이 (<style>) 를 </head> 앞에 삽입 ── */
const THEME = `
  <style id="sianC">
  /* ===== 시안 C 테마 오버레이 (index.html 위에 덧입힘) ===== */
  :root{ --bg:#F4F5F8; --card:#fff; --border:#EFEFF3; --t1:#191F28; --t2:#5B6472; --t3:#A8AEBA; --radius:16px; }
  body{ letter-spacing:-.01em; }
  /* 헤더: 그라데이션 → 미니멀 화이트 */
  .home-header{ background:#fff !important; box-shadow:none !important; border-bottom:1px solid #EFEFF3; }
  .home-header-icon{ background:linear-gradient(135deg,#5046E4,#7C3AED); }
  .home-header-text h1{ color:var(--t1) !important; font-weight:800; font-size:1.22rem; letter-spacing:-.02em; }
  .home-header-text p{ color:var(--t3) !important; }
  .home-header-actions button, .home-header-actions a{ background:#F1F2F6 !important; border:none !important; color:var(--t2) !important; font-weight:700; }
  /* 카드 공통: 플랫 + 얇은 보더 */
  .login-card,.profile-card,.sub-account-card,.rc-card,.result-card,.result-group-card{
    border:1px solid #EFEFF3 !important; box-shadow:0 1px 6px rgba(17,24,40,.04) !important; border-radius:16px !important; }
  .login-card{ padding:26px 22px; }
  .login-card h2{ color:var(--t1); }
  .login-input{ border-radius:12px !important; background:#F7F8FB; }
  .login-btn{ border-radius:13px; font-weight:800; }
  .login-state-bar{ border:1px solid #EFEFF3 !important; box-shadow:0 1px 6px rgba(17,24,40,.04) !important; border-radius:16px !important; }
  /* 탭: 인셋 세그먼트 컨트롤 */
  .tab-nav{ background:#ECEDF2 !important; border:none !important; box-shadow:none !important; padding:4px; border-radius:13px; }
  .tab-btn{ color:var(--t2); font-weight:700; }
  .tab-btn:hover{ background:transparent; color:var(--t1); }
  .tab-btn.active{ background:#fff !important; color:#5046E4 !important; box-shadow:0 1px 5px rgba(17,24,40,.12) !important; }
  /* 섹션 타이틀 */
  .home-section-title,.results-title{ font-size:.98rem; color:var(--t1); font-weight:800; }
  .results-badge{ background:#F2F1FE; color:#5046E4; }

  /* ===== 모집공고 카드/행 전환 토글 ===== */
  .rc-title-row{ justify-content:space-between; }
  .rc-viewtoggle{ display:inline-flex; background:#ECEDF2; border-radius:11px; padding:3px; gap:2px; flex-shrink:0; }
  .rc-viewtoggle button{ width:36px; height:30px; border:none; background:none; border-radius:9px; color:var(--t3); font-size:.9rem; cursor:pointer; transition:.15s; display:grid; place-items:center; }
  .rc-viewtoggle button.on{ background:#fff; color:#5046E4; box-shadow:0 1px 4px rgba(17,24,40,.12); }

  /* ===== 모집공고 카드 재디자인 (시안 C) ===== */
  .rc-card{ padding:14px 16px !important; }
  .rc-row{ display:flex; gap:12px; align-items:flex-start; }
  .rc-thumb{ flex:0 0 56px; width:56px; height:56px; border-radius:14px; background:#F1F2F6; display:grid; place-items:center; position:relative; }
  .rc-thumb-emoji{ font-size:1.55rem; line-height:1; }
  .rc-thumb-ch{ position:absolute; left:-5px; top:-5px; font-size:.55rem; font-weight:800; color:#fff; background:#5046E4; padding:1px 6px; border-radius:7px; white-space:nowrap; }
  .rc-body{ flex:1; min-width:0; }
  .rc-card-top{ display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:6px !important; }
  .rc-channel{ background:#5046E4; color:#fff; font-size:.62rem; font-weight:800; padding:2px 7px; border-radius:6px; }
  .rc-status{ font-size:.62rem; font-weight:800; padding:2px 7px; border-radius:6px; background:#E7F8F0; color:#0E7A4B; }
  .rc-status.rc-status-full{ background:#F1F2F6; color:#A8AEBA; }
  .rc-manager{ margin-left:auto; font-size:.7rem; color:#A8AEBA; font-weight:600; }
  .rc-title{ font-size:.95rem; font-weight:700; color:#191F28; line-height:1.35; flex:none; }
  .rc-badges{ margin-top:6px !important; margin-bottom:0 !important; }
  .rc-meta{ margin-top:7px !important; margin-bottom:0 !important; gap:7px 12px !important; }
  .rc-fee{ color:#5046E4 !important; font-weight:800; }
  .rc-fee i{ color:#5046E4 !important; }
  .rc-notes{ margin-top:10px !important; margin-bottom:0 !important; background:#F7F8FB !important; border-left:none !important; color:#8A92A0 !important; border-radius:10px !important; padding:10px 12px !important; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .rc-apply-btn{ margin-top:12px; padding:12px !important; border-radius:12px !important; }
  /* 채널 색상 */
  .rc-card[data-ch="네이버"] .rc-channel, .rc-card[data-ch="네이버"] .rc-thumb-ch{ background:#03C75A; }
  .rc-card[data-ch="쿠팡"] .rc-channel, .rc-card[data-ch="쿠팡"] .rc-thumb-ch{ background:#E5392B; }
  .rc-card[data-ch="G마켓"] .rc-channel, .rc-card[data-ch="G마켓"] .rc-thumb-ch{ background:#1BA641; }
  .rc-card[data-ch="스마트스토어"] .rc-channel, .rc-card[data-ch="스마트스토어"] .rc-thumb-ch{ background:#03C75A; }
  .rc-card[data-ch="11번가"] .rc-channel, .rc-card[data-ch="11번가"] .rc-thumb-ch{ background:#FF0038; }

  /* 행(row) 뷰 */
  .rc-list.rc-view-row .rc-card{ margin-bottom:10px !important; }
  /* 카드(card) 2단 뷰 */
  .rc-list.rc-view-card{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .rc-list.rc-view-card .rc-card{ margin-bottom:0 !important; padding:10px !important; display:flex; flex-direction:column; }
  .rc-list.rc-view-card .rc-row{ flex-direction:column; gap:8px; }
  .rc-list.rc-view-card .rc-thumb{ width:100%; height:78px; flex:none; border-radius:12px; }
  .rc-list.rc-view-card .rc-title{ font-size:.84rem; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .rc-list.rc-view-card .rc-manager{ margin-left:0; }
  .rc-list.rc-view-card .rc-badges{ display:none; }
  .rc-list.rc-view-card .rc-notes{ display:none; }
  .rc-list.rc-view-card .rc-meta{ font-size:.7rem; }
  .rc-list.rc-view-card .rc-apply-btn{ padding:9px !important; font-size:.78rem; margin-top:auto; }
  .rc-list.rc-view-card .rc-form-fields{ flex-direction:column; }
  @media(max-width:380px){ .rc-list.rc-view-card{ grid-template-columns:1fr; } }

  /* 프리뷰 식별 배지 (이게 보이면 새 빌드가 로드된 것) */
  .cpv-ribbon{ position:fixed; right:10px; bottom:10px; z-index:99999; background:#5046E4; color:#fff; font-size:.72rem; font-weight:800; padding:7px 12px; border-radius:20px; box-shadow:0 4px 14px rgba(80,70,228,.45); }
  </style>
</head>`;
replaceOne('  </style>\n</head>', THEME, '테마 오버레이 삽입');

/* ── 1-b) 프리뷰 식별 배지 마크업 삽입 (캐시 확인용) ── */
replaceOne(
  '<body>\n\n<!-- ═══ 비로그인 상태 ═══ -->',
  '<body>\n<div class="cpv-ribbon">시안 C 프리뷰 v3</div>\n\n<!-- ═══ 비로그인 상태 ═══ -->',
  '프리뷰 배지 삽입'
);

/* ── 2) 모집공고 섹션 타이틀에 카드/행 전환 토글 추가 (2곳) ── */
const TITLE_FROM = `      <div class="home-section-title">
        <i class="fas fa-bullhorn" style="color:var(--p)"></i> 모집공고
      </div>`;
const TITLE_TO = `      <div class="home-section-title rc-title-row">
        <span><i class="fas fa-bullhorn" style="color:var(--p)"></i> 모집공고</span>
        <span class="rc-viewtoggle">
          <button type="button" class="rc-vt-list" title="행으로 보기" onclick="setRecruitView('row')"><i class="fas fa-list"></i></button>
          <button type="button" class="rc-vt-card" title="카드로 보기" onclick="setRecruitView('card')"><i class="fas fa-table-cells-large"></i></button>
        </span>
      </div>`;
replaceAll(TITLE_FROM, TITLE_TO, 2, '모집공고 타이틀 토글');

/* ── 3) 모집공고 리스트 컨테이너에 rc-list 클래스 부여 (2곳) ── */
replaceOne('<div id="recruitPreviewList">', '<div id="recruitPreviewList" class="rc-list">', 'recruitPreviewList 클래스');
replaceOne('<div id="recruitPreviewList2">', '<div id="recruitPreviewList2" class="rc-list">', 'recruitPreviewList2 클래스');

/* ── 4) 모집공고 카드 템플릿 교체 (썸네일·채널칩·재디자인) ── */
const RET_START = '          return ' + BT + '\n';
const RET_END   = '            </div>' + BT + ';\n        }).join("");';
const sI = html.indexOf(RET_START);
const eI = html.indexOf(RET_END);
must(sI !== -1, '카드 템플릿 시작 앵커 없음');
must(eI !== -1 && eI > sI, '카드 템플릿 종료 앵커 없음');
must(html.indexOf(RET_START, sI + RET_START.length) === -1, '카드 템플릿 시작 앵커 중복');
html = html.slice(0, sI) + RC_TPL + html.slice(eI + RET_END.length);

/* ── 5) DOMContentLoaded 에서 뷰 상태 적용 호출 추가 ── */
replaceOne('  initPage();\n  loadRecruitPreview();\n', '  initPage();\n  loadRecruitPreview();\n  applyRecruitView();\n', 'DOMContentLoaded 훅');

/* ── 6) 뷰 전환 JS 를 마지막 인라인 스크립트 끝에 삽입 ── */
const JS_FROM = `  } catch(e) {
    showToast('신청 오류: ' + e.message);
  }
}
</script>`;
const JS_TO = `  } catch(e) {
    showToast('신청 오류: ' + e.message);
  }
}

/* ═══ 모집공고 카드/행 뷰 전환 (선호 형태 localStorage 저장) ═══ */
function setRecruitView(v){
  localStorage.setItem('inad_recruit_view', v === 'card' ? 'card' : 'row');
  applyRecruitView();
}
function applyRecruitView(){
  const v = localStorage.getItem('inad_recruit_view') || 'row';
  document.querySelectorAll('.rc-list').forEach(el => {
    el.classList.toggle('rc-view-card', v === 'card');
    el.classList.toggle('rc-view-row',  v !== 'card');
  });
  document.querySelectorAll('.rc-vt-card').forEach(b => b.classList.toggle('on', v === 'card'));
  document.querySelectorAll('.rc-vt-list').forEach(b => b.classList.toggle('on', v !== 'card'));
}
</script>`;
replaceOne(JS_FROM, JS_TO, '뷰 전환 JS 삽입');

fs.writeFileSync(OUT, html, 'utf8');
console.log('✓ index-c.html 생성 완료:', OUT, '(' + html.length + ' bytes)');
