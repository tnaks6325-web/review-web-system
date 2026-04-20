// 공지 배너: localStorage에 저장된 공지 읽기 (관리자가 index.html에서 설정)
function _loadNoticeBanner() {
  try {
    const notice = localStorage.getItem("rapp_notice");
    if (!notice) return;
    const obj = JSON.parse(notice);
    if (!obj || !obj.text || !obj.active) return;
    // 만료 체크 (expires: timestamp ms)
    if (obj.expires && Date.now() > obj.expires) {
      localStorage.removeItem("rapp_notice");
      return;
    }
    const banner = document.getElementById("noticeBanner");
    const textEl = document.getElementById("noticeBannerText");
    if (banner && textEl) {
      textEl.textContent = obj.text;
      banner.style.display = "block";
      // 배너 색상 설정
      if (obj.type === "urgent") {
        banner.style.background = "#FEE2E2";
        banner.style.borderBottomColor = "#FCA5A5";
        banner.style.color = "#991B1B";
        banner.querySelector("i").style.color = "#DC2626";
      } else if (obj.type === "info") {
        banner.style.background = "#EFF6FF";
        banner.style.borderBottomColor = "#BFDBFE";
        banner.style.color = "#1E40AF";
        banner.querySelector("i").style.color = "#3B82F6";
      }
    }
  } catch(_) {}
}
