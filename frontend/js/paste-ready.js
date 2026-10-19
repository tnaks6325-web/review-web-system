/* paste-ready.js — 작업보드 사진 칸 공용 부품: "지금 Ctrl+V 하면 여기에 들어간다"를 눈으로 확인시키는 장치 (결정 264 · 2026-10-20)
 *
 *  사용자 요청: "작업보드 사진칸도 Ctrl+V 를 할 수 있도록 확인할 수 있는 시각적인 장치".
 *  ① 칸을 [Ctrl+V 붙여넣기] · [끌어다 놓기] (· 이미 파일 고르기가 있던 칸만 [파일 선택]) 으로 나눈다.
 *  ② 칸 아래 상태 줄 — 초록 점 "지금 Ctrl+V 하면 여기에 들어가요" / 이 창이 아닌 곳(카톡 등)을 보고 있으면
 *     주황 점 "다른 창을 보고 있어요 — 이 창을 한 번 누른 뒤 Ctrl+V". Ctrl+V 는 브라우저 창이 앞에 있어야만 먹는다
 *     — 카톡에서 복사하고 바로 Ctrl+V 를 누르면 카톡에 붙는 일이 실제 흐름에서 가장 흔한 "안 됨"이다.
 *  ③ [Ctrl+V 붙여넣기] 칸을 누르면 클립보드 사진을 바로 읽어 넣는다(키보드 대신). 못 읽으면 이유를 말한다.
 *  ④ 사진이 들어가면 칸이 잠깐 초록으로 깜빡이며 "✓ 붙여넣었어요".
 *  ★ 넣는 길은 각 칸의 기존 함수(onFiles) 그대로 — 장수·용량·사전확인 규칙 사본 0.
 *  ★ 파일 고르기 창구를 새로 만들지 않는다 — [리뷰 대신 제출]·[캡처 교체]·[메시지 첨부]는 붙여넣기·끌어놓기 전용
 *    (결정 136·192 사용자 확정). [파일 선택]은 원래 그 창구가 있던 칸(수동 주문)에만 file 옵션으로 그린다.
 */
(function () {
  'use strict';
  if (window.PasteReady) return;

  const CSS = `
.prz{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;border-radius:inherit}
.prz-cell{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:10px 6px;margin:0;border:0;
  background:transparent;font:inherit;color:var(--t1,#0f172a);text-align:center;min-width:0}
.prz-cell+.prz-cell{border-left:1.5px dashed var(--line,#cbd5e1)}
button.prz-cell,label.prz-cell{cursor:pointer;border-radius:0 !important}
button.prz-cell:active,label.prz-cell:active{transform:none}
button.prz-cell:hover,label.prz-cell:hover{background:#eff6ff;color:#1d4ed8}
button.prz-cell:focus-visible{outline:2px solid #2563eb;outline-offset:-3px}
.prz-cell b{font-size:12px;font-weight:800}
.prz-sub{font-size:10.5px;color:var(--faint,#94a3b8);font-weight:500}
.prz-ic{font-size:17px;line-height:1}
.prz-keys{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:#1d4ed8;font-weight:800}
.prz-keys kbd{display:inline-block;min-width:22px;padding:2px 5px;border:1px solid #93c5fd;border-bottom-width:2.5px;border-radius:5px;
  background:#fff;font:800 11px/1.2 inherit;color:#1d4ed8;box-shadow:0 1px 0 rgba(37,99,235,.15)}
.prz-paste{background:#eff6ff}
.prz-state{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:6px;font-size:11px;font-weight:700;color:#15803d}
.prz-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.55);animation:przPulse 1.6s ease-out infinite;flex:none}
@keyframes przPulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}80%,100%{box-shadow:0 0 0 7px rgba(34,197,94,0)}}
.prz-off{display:none}
html.prz-blur .prz-state{color:#b45309}
html.prz-blur .prz-dot{background:#f59e0b;animation:none}
html.prz-blur .prz-on{display:none}
html.prz-blur .prz-off{display:inline}
/* 준비된 칸 = 실선 파란 테두리 + 고리 */
.prz-host{border-style:solid !important;border-color:#60a5fa !important;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
html.prz-blur .prz-host{border-color:#fbbf24 !important;box-shadow:0 0 0 3px rgba(245,158,11,.14)}
.prz-host.over,.prz-host.drag-over{border-color:#2563eb !important;background:#eff6ff !important}
.prz-host.over .prz-drop,.prz-host.drag-over .prz-drop{background:#dbeafe;color:#1d4ed8}
.prz-host.prz-got{border-color:#16a34a !important;box-shadow:0 0 0 4px rgba(22,163,74,.22) !important;transition:box-shadow .2s}
.prz-host.prz-got .prz-on::after{content:" · ✓ 붙여넣었어요"}
/* 사진이 들어간 뒤 = 한 줄짜리 막대 */
.prz.compact .prz-cell{flex-direction:row;gap:6px;padding:6px 4px}
.prz.compact .prz-sub,.prz.compact .prz-ic{display:none}
.prz.compact .prz-keys kbd{min-width:18px;padding:1px 4px;font-size:10px}
.prz.compact+.prz-state{margin-top:4px}
`;
  function injectCss() {
    if (document.getElementById('przCss')) return;
    const s = document.createElement('style'); s.id = 'przCss'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* 창이 앞에 있는지 — blur 직후엔 hasFocus 가 아직 true 일 수 있어 한 박자 뒤에 잰다.
     같은 문서 안 iframe 으로 포커스가 옮겨가도 hasFocus() 는 true 라 "다른 창"으로 오판하지 않는다. */
  function syncFocus() {
    const blurred = !(document.hasFocus && document.hasFocus());
    document.documentElement.classList.toggle('prz-blur', blurred);
  }
  let watching = false;
  function watchFocus() {
    if (watching) return; watching = true;
    window.addEventListener('blur', () => setTimeout(syncFocus, 0));
    window.addEventListener('focus', () => setTimeout(syncFocus, 0));
    document.addEventListener('visibilitychange', () => setTimeout(syncFocus, 0));
    syncFocus();
  }

  /**
   * @param {object} [o]
   * @param {boolean} [o.compact]  사진이 이미 있을 때(한 줄 막대)
   * @param {string}  [o.dropSub]  [끌어다 놓기] 아래 작은 글씨(예: "최대 5장")
   * @param {{onchange:string, multiple?:boolean}} [o.file]  원래 파일 고르기가 있던 칸만 — [파일 선택] 칸을 그린다
   */
  function html(o) {
    o = o || {};
    injectCss(); watchFocus();
    const file = o.file
      ? `<label class="prz-cell prz-file"><span class="prz-ic">📁</span><b>파일 선택</b><span class="prz-sub">내 PC에서</span>`
        + `<input type="file" accept="image/*"${o.file.multiple ? ' multiple' : ''} hidden onchange="${o.file.onchange}"></label>`
      : '';
    return `<div class="prz${o.compact ? ' compact' : ''}">`
      + `<button type="button" class="prz-cell prz-paste" data-prz="paste" title="눌러도 붙여넣어져요">`
      + `<span class="prz-keys"><kbd>Ctrl</kbd>+<kbd>V</kbd></span><b>붙여넣기</b><span class="prz-sub">누르거나 키보드로</span></button>`
      + `<div class="prz-cell prz-drop"><span class="prz-ic">📥</span><b>끌어다 놓기</b><span class="prz-sub">${o.dropSub || '사진을 여기로'}</span></div>`
      + file
      + `</div>`
      + `<div class="prz-state" aria-live="polite"><span class="prz-dot"></span>`
      + `<span class="prz-on">지금 <b>Ctrl+V</b> 하면 여기에 들어가요</span>`
      + `<span class="prz-off">다른 창을 보고 있어요 — 이 창을 한 번 누른 뒤 <b>Ctrl+V</b></span></div>`;
  }

  /** 클립보드 사진 읽기. 성공 = {files:[File]} · 실패 = {files:[], msg} (조용히 실패하지 않는다) */
  async function readClipboard() {
    const KEY = '키보드에서 Ctrl+V 를 눌러주세요.';
    if (!(navigator.clipboard && navigator.clipboard.read)) return { files: [], msg: '이 브라우저는 눌러서 붙여넣기를 못 해요. ' + KEY };
    let items;
    try { items = await navigator.clipboard.read(); }
    catch (_) { return { files: [], msg: '브라우저가 클립보드 읽기를 막았어요. ' + KEY }; }
    const files = [];
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    for (const it of items || []) {
      const ty = (it.types || []).find(t => t.startsWith('image/'));
      if (!ty) continue;
      try {
        const blob = await it.getType(ty);
        const ext = (ty.split('/')[1] || 'png').replace('jpeg', 'jpg');
        files.push(new File([blob], `붙여넣기_${stamp}${files.length ? '_' + (files.length + 1) : ''}.${ext}`, { type: ty }));
      } catch (_) { /* 한 장 실패는 건너뛴다 */ }
    }
    if (!files.length) return { files: [], msg: '클립보드에 사진이 없어요. 먼저 캡처(또는 카톡에서 사진 복사)한 뒤 다시 눌러주세요.' };
    return { files };
  }

  /** 칸이 사진을 받았다는 표시(초록 깜빡임) */
  function flash(host) {
    if (!host) return;
    host.classList.add('prz-got');
    clearTimeout(host._przT);
    host._przT = setTimeout(() => host.classList.remove('prz-got'), 1400);
  }

  /**
   * 칸에 연결한다 — 그릴 때마다 부른다(칸 DOM 을 다시 만드는 화면이 있어서).
   * @param {HTMLElement} host  사진 칸(테두리 있는 상자)
   * @param {(files:File[])=>void} onFiles  그 칸의 기존 받는 함수
   * @param {(msg:string)=>void} [notify]   안내 표시(없으면 alert 대신 콘솔)
   */
  function bind(host, onFiles, notify) {
    if (!host) return;
    host.classList.add('prz-host');
    const btn = host.querySelector('[data-prz="paste"]');
    if (btn && !btn._przBound) {
      btn._przBound = true;
      btn.addEventListener('click', async ev => {
        ev.preventDefault(); ev.stopPropagation();
        const r = await readClipboard();
        if (r.files.length) onFiles(r.files);
        else if (r.msg) (notify || (m => console.warn(m)))(r.msg);
      });
    }
  }

  window.PasteReady = { html, bind, flash, readClipboard, _syncFocus: syncFocus };
})();
