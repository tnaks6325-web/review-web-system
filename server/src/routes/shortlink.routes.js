const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');

// (POST /api/short/create — 옛 관리자 대시보드의 구매양식 단축링크 생성 — 는 2026-10-22 제거 · 결정 270.
//  코드 생성·재사용 규칙은 services/shortLink.service.js 한 곳이고, 작업보드 [🔗 구매양식 링크](POST /api/trackb/form-link)가 쓴다 — 결정 268.)

// ═══════════════════════════════════════════════════════════
// GET /api/short/resolve — 단축URL 해석 (GAS: resolveShort)
// ═══════════════════════════════════════════════════════════
router.get('/resolve', async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code) return res.json({ error: 'code가 없습니다.' });

    const { rows } = await pool.query(
      `SELECT sheet_id AS s, gid AS g, tab_name AS t, display_name AS d, option_list AS "optionList", round AS rd
       FROM short_links WHERE code = $1`,
      [code]
    );

    if (rows.length === 0) return res.json({ error: '유효하지 않은 코드입니다.' });

    const row = rows[0];
    res.json({
      success: true,
      s: row.s,
      g: row.g,
      t: row.t,
      d: row.d,
      rd: row.rd || '',
      optionList: row.optionList || [],
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/short/update-round(단축링크 차수 사후 변경 — 화면 없음) 은 2026-10-04 제거 — 결정 186 96번(호출 0 · 9/2 이후 0 · authMiddleware 뿐).

// ═══════════════════════════════════════════════════════════
// GET /api/short/og/:code — 카카오톡/SNS 크롤러용 동적 OG 메타태그 HTML
// 일반 브라우저 → 프론트엔드로 리다이렉트
// ═══════════════════════════════════════════════════════════
router.get('/og/:code', async (req, res, next) => {
  try {
    const { code } = req.params;
    if (!code) return res.status(400).send('code 필요');

    // DB에서 단축링크 정보 조회
    const { rows } = await pool.query(
      `SELECT sheet_id AS s, gid AS g, tab_name AS t, display_name AS d, option_list AS "optionList"
       FROM short_links WHERE code = $1`,
      [code]
    );

    // 프론트엔드 URL (Cloudflare Pages)
    const FRONTEND_BASE = process.env.FRONTEND_URL || 'https://review-web-system.pages.dev';
    const frontendUrl = `${FRONTEND_BASE}/search.html?r=${encodeURIComponent(code)}`;

    if (rows.length === 0) {
      // 유효하지 않은 코드 → 기본 OG로 리다이렉트
      return res.redirect(302, frontendUrl);
    }

    const row = rows[0];

    // User-Agent로 크롤러 판별
    // ★ 카카오톡 인앱 브라우저(KAKAOTALK + Safari/Chrome)는 크롤러가 아님!
    //   - OG 크롤러: "facebookexternalhit", "Twitterbot", "kakaotalk-scrap" 등 (브라우저 엔진 없음)
    //   - 인앱 브라우저: "KAKAOTALK 2610620" + "AppleWebKit" + "Safari" (실제 사용자)
    const ua = (req.headers['user-agent'] || '');
    const uaLower = ua.toLowerCase();
    
    // 카카오톡 인앱 브라우저 감지: KAKAOTALK이 포함되지만 Safari/Chrome도 포함
    const isKakaoInApp = /kakaotalk/i.test(ua) && /safari|chrome|applewebkit/i.test(ua);
    
    // 순수 크롤러만 판별 (카카오톡 인앱 브라우저 제외)
    const isCrawler = !isKakaoInApp && /facebookexternalhit|twitterbot|slackbot|discordbot|linkedinbot|googlebot|yandex|bingbot|daumoa|naver.*bot|wget|curl|python-requests|bot\/|crawler|spider|preview|kakaotalk-scrap/i.test(ua);

    if (!isCrawler) {
      // 일반 브라우저 → 프론트엔드로 리다이렉트
      return res.redirect(302, frontendUrl);
    }

    // 크롤러 → 동적 OG 메타태그 HTML 반환
    const displayName = row.d || row.t || '구매양식 제출';
    const ogTitle = `${displayName}`;
    const ogDescription = '아래 링크를 클릭하여 구매양식을 제출해주세요.';
    const ogUrl = `${req.protocol}://${req.get('host')}/r/${code}`;

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(ogTitle)}</title>
  <meta property="og:title" content="${escapeHtml(ogTitle)}"/>
  <meta property="og:description" content="${escapeHtml(ogDescription)}"/>
  <meta property="og:type" content="website"/>
  <meta property="og:url" content="${escapeHtml(ogUrl)}"/>
  <meta name="twitter:card" content="summary"/>
  <meta name="twitter:title" content="${escapeHtml(ogTitle)}"/>
  <meta name="twitter:description" content="${escapeHtml(ogDescription)}"/>
</head>
<body>
  <p>리다이렉트 중...</p>
  <script>window.location.href="${frontendUrl.replace(/"/g, '\\"')}";</script>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// HTML 이스케이프 헬퍼
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = router;
