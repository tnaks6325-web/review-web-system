/* ============================================================
 * 직원 화면 — 「INADD 리뷰오더 상품정보 가져오기」 확장 프로그램 필수 설치 (사용자 결정 2026-10-13)
 *
 * 인트라넷 리뷰오더와 같은 규칙(차단 + 예외):
 *   · PC 크롬·웨일·엣지: 확장 프로그램이 없으면 화면을 가리고 설치 안내.
 *   · 휴대폰·사파리·파이어폭스: 막지 않고 안내 문구만.
 *   · 리뷰어·광고주 화면은 대상이 아니다 — 호출하는 쪽이 isStaff 로 알려 준다(광고주 역할은 false).
 *
 * 설치 여부: 확장 1.0.4 의 externally_connectable PING(버전만 답함). 1.0.3 은 답하지 않는다.
 * ★ PRODUCT_READER_REQUIRED — 1.0.4 웹스토어 게시 확인 뒤 2026-10-14 true 로 켰다(1.0.3 은 PING 에 답하지 않는다).
 * ★ 즉시 끄기: 이 값을 false 로 되돌려 배포(프론트 자동 배포 ~20초).
 * ============================================================ */
(function () {
  var PRODUCT_READER_REQUIRED = true;   // 2026-10-14 켬 — 확장 1.0.4 웹스토어 게시 확인(업데이트 서버 version=1.0.4)
  var EXTENSION_ID = 'hlhphdglgkacdbbknpfmaoklcbinnaoe';
  var STORE_URL = 'https://chromewebstore.google.com/detail/' + EXTENSION_ID;
  var GUIDE_URL = 'https://inadd-system.pages.dev/static/product-reader-install-guide.html';
  var PING_TIMEOUT_MS = 2500;

  function browserKind(ua) {
    ua = ua || (navigator.userAgent || '');
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile';
    if (/Firefox|FxiOS/i.test(ua) || !/Chrome\//.test(ua)) return 'unsupported';
    return 'supported';
  }

  /** 설치돼 있으면 버전 문자열, 없으면 ''. 확장이 없으면 페이지에 chrome.runtime 자체가 없거나 연결 오류가 난다. */
  function pingExtension() {
    return new Promise(function (resolve) {
      var rt = window.chrome && window.chrome.runtime;
      if (!rt || typeof rt.sendMessage !== 'function') return resolve('');
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(''); } }, PING_TIMEOUT_MS);
      try {
        rt.sendMessage(EXTENSION_ID, { type: 'PING' }, function (res) {
          if (done) return;
          done = true; clearTimeout(timer);
          void (rt.lastError);   // 미설치면 lastError — 읽어서 콘솔 경고를 막는다
          resolve(res && res.ok ? String(res.version || '1') : '');
        });
      } catch (_) { done = true; clearTimeout(timer); resolve(''); }
    });
  }

  function el(tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (text) n.textContent = text;
    return n;
  }

  function showNote() {
    if (document.getElementById('product-reader-gate')) return;
    var note = el('div', 'position:fixed;left:16px;right:16px;bottom:16px;z-index:9998;max-width:640px;margin:0 auto;padding:12px 16px;border-radius:12px;background:#fff7e6;color:#9a5b00;font:13px/1.6 "Apple SD Gothic Neo","Malgun Gothic",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.12)',
      '직원용 확장 프로그램 「INADD 리뷰오더 상품정보 가져오기」는 PC의 크롬·웨일·엣지에서 설치합니다. 가능하면 PC 크롬이나 웨일로 접속해 주세요.');
    note.id = 'product-reader-gate';
    document.body.appendChild(note);
  }

  function showGate() {
    if (document.getElementById('product-reader-gate')) return;
    var wrap = el('div', 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:72px 16px 24px;background:rgba(241,245,251,.96);backdrop-filter:blur(3px);overflow:auto');
    wrap.id = 'product-reader-gate';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'product-reader-gate-title');
    var card = el('div', 'width:min(520px,100%);display:flex;flex-direction:column;align-items:center;gap:12px;padding:28px 26px;border:1px solid #dbe5f3;border-radius:16px;background:#fff;box-shadow:0 20px 60px rgba(23,34,55,.16);text-align:center;color:#172237;font-family:"Apple SD Gothic Neo","Malgun Gothic",sans-serif');
    var h = el('h2', 'margin:0;font-size:18px;font-weight:800;line-height:1.4', '직원 화면을 쓰려면 확장 프로그램 설치가 필요합니다');
    h.id = 'product-reader-gate-title';
    var p = el('p', 'margin:0;font-size:13px;line-height:1.7;color:#4f6079', '리뷰오더·리뷰웹 업무를 하는 직원은 「INADD 리뷰오더 상품정보 가져오기」를 설치해야 합니다. 설치는 1분이면 끝납니다.');
    var actions = el('div', 'display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:4px');
    var a1 = el('a', 'display:inline-flex;align-items:center;min-height:38px;padding:8px 16px;border-radius:9px;background:#2469d8;color:#fff;font-size:13px;font-weight:800;text-decoration:none', '웹스토어에서 설치하기');
    a1.href = STORE_URL; a1.target = '_blank'; a1.rel = 'noopener';
    var a2 = el('a', 'display:inline-flex;align-items:center;min-height:38px;padding:8px 16px;border-radius:9px;border:1px solid #a9c6f9;background:#f5f9ff;color:#2469d8;font-size:13px;font-weight:800;text-decoration:none', '설치 가이드 보기(사진)');
    a2.href = GUIDE_URL; a2.target = '_blank'; a2.rel = 'noopener';
    actions.appendChild(a1); actions.appendChild(a2);
    var reload = el('button', 'border:0;background:transparent;color:#2469d8;font-size:12.5px;font-weight:700;text-decoration:underline;cursor:pointer', '설치했어요 · 새로고침');
    reload.type = 'button';
    reload.addEventListener('click', function () { location.reload(); });
    var sub = el('p', 'margin:0;font-size:11.5px;color:#7a879b', '설치한 뒤 이 화면을 새로고침하면 인식됩니다. 크롬·웨일·엣지 모두 같은 웹스토어에서 설치합니다.');
    // 1.0.3 설치자는 PING 에 답하지 않는다 — 브라우저 자동 업데이트(1.0.4) 전까지 이 화면이 보일 수 있어 안내한다.
    var old = el('p', 'margin:0;font-size:11.5px;color:#7a879b', '이미 설치했는데 계속 보이면 확장 프로그램이 아직 새 버전으로 바뀌지 않은 것입니다. 브라우저를 완전히 껐다 켠 뒤 다시 열어 주세요.');
    card.appendChild(h); card.appendChild(p); card.appendChild(actions); card.appendChild(reload); card.appendChild(sub); card.appendChild(old);
    wrap.appendChild(card);
    document.body.appendChild(wrap);
  }

  /** 시험 전용 주소는 잠그지 않는다 — Railway PR 미리보기(확장 externally_connectable 밖이라 설치자도 PING 불가)와
   *  내 컴퓨터 서버. 여기는 가짜 데이터로 화면을 확인하는 곳이지 직원 업무 화면이 아니다(PR #1633 리뷰). */
  function isTestHost(host) {
    host = String(host || '');
    return /^test-review-wdb-web-review-web-system-pr-\d+\.up\.railway\.app$/.test(host) || host === 'localhost' || host === '127.0.0.1';
  }

  /** 직원 화면 진입 때 부른다. opts.isStaff 가 true 일 때만 검사한다(리뷰어·광고주 제외). */
  window.productReaderGate = async function (opts) {
    if (!PRODUCT_READER_REQUIRED || !opts || !opts.isStaff) return;
    if (isTestHost(location.hostname)) return;
    var kind = browserKind();
    if (kind !== 'supported') { showNote(); return; }
    var version = await pingExtension();
    if (!version) showGate();
  };
  window.productReaderGate._internals = { browserKind: browserKind, isTestHost: isTestHost, pingExtension: pingExtension, EXTENSION_ID: EXTENSION_ID, isRequired: function () { return PRODUCT_READER_REQUIRED; } };
})();
