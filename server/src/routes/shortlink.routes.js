const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// 혼동문자 제외 영숫자 (GAS 원본 동일)
const SHORT_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const SHORT_CODE_LEN = 6;

function generateShortCode() {
  let code = '';
  for (let i = 0; i < SHORT_CODE_LEN; i++) {
    code += SHORT_CHARS.charAt(Math.floor(Math.random() * SHORT_CHARS.length));
  }
  return code;
}

// ═══════════════════════════════════════════════════════════
// POST /api/short/create — 단축URL 생성 (GAS: createShort)
// GAS 호환: 동일 파라미터 조합이면 기존 코드 재사용
// ═══════════════════════════════════════════════════════════
router.post('/create', async (req, res, next) => {
  try {
    const { s, g, t, d, options, optionList } = req.body;
    if (!s || !t) return res.json({ error: 's(sheetId)와 t(tabName)은 필수입니다.' });

    // 옵션 리스트 처리
    let finalOptions = options || optionList || [];
    if (typeof finalOptions === 'string') {
      try { finalOptions = JSON.parse(finalOptions); } catch (_) { finalOptions = []; }
    }

    // composite key: 동일 파라미터 조합 재사용
    const compositeKey = `${s}|${g || ''}|${t}|${d || ''}`;

    // 기존 코드 확인
    const { rows: existing } = await pool.query(
      'SELECT code, option_list FROM short_links WHERE composite_key = $1 LIMIT 1',
      [compositeKey]
    );

    if (existing.length > 0) {
      const existCode = existing[0].code;
      // optionList가 변경됐으면 업데이트
      if (finalOptions.length > 0) {
        const currentOptions = existing[0].option_list || [];
        if (JSON.stringify(currentOptions) !== JSON.stringify(finalOptions)) {
          await pool.query(
            'UPDATE short_links SET option_list = $1 WHERE code = $2',
            [JSON.stringify(finalOptions), existCode]
          );
        }
      }
      return res.json({ success: true, code: existCode, shortUrl: existCode, reused: true });
    }

    // 새 코드 생성 (중복 방지 루프)
    let code, attempts = 0;
    while (attempts < 10) {
      code = generateShortCode();
      try {
        await pool.query(
          `INSERT INTO short_links (code, sheet_id, gid, tab_name, display_name, option_list, composite_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [code, s, g || '', t, d || '', finalOptions.length > 0 ? JSON.stringify(finalOptions) : null, compositeKey]
        );
        break;
      } catch (err) {
        if (err.code === '23505') { // unique violation
          attempts++;
          continue;
        }
        throw err;
      }
    }

    if (attempts >= 10) {
      return res.json({ error: '단축 코드 생성 실패' });
    }

    res.json({ success: true, code, shortUrl: code, reused: false });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/short/resolve — 단축URL 해석 (GAS: resolveShort)
// ═══════════════════════════════════════════════════════════
router.get('/resolve', async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code) return res.json({ error: 'code가 없습니다.' });

    const { rows } = await pool.query(
      `SELECT sheet_id AS s, gid AS g, tab_name AS t, display_name AS d, option_list AS "optionList"
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
      optionList: row.optionList || [],
    });
  } catch (err) {
    next(err);
  }
});

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

    // User-Agent로 크롤러 판별 (카카오톡, 페이스북, 트위터, 슬랙, 디스코드 등)
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const isCrawler = /kakaotalk|facebookexternalhit|twitterbot|slackbot|discordbot|linkedinbot|googlebot|yandex|bingbot|daumoa|naver|wget|curl|python|bot|crawler|spider|preview/i.test(ua);

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
