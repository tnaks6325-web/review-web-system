const express = require('express');
const router = express.Router();
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { logger } = require('../utils/logger');

// ── 메타 태그 content 추출 (property/name 둘 다, 속성 순서 무관) ──
function _meta(html, keys) {
  for (const k of keys) {
    let m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + k + '["\'][^>]*?content=["\']([^"\']*)["\']', 'i'));
    if (m && m[1]) return m[1];
    m = html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*?(?:property|name)=["\']' + k + '["\']', 'i'));
    if (m && m[1]) return m[1];
  }
  return '';
}

// ── JSON-LD 블록 파싱 ──
function _jsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1].trim())); } catch (_) { /* skip */ }
  }
  return out;
}
// JSON-LD 트리에서 Product 노드 찾기 (@graph 포함)
function _findProduct(nodes) {
  const stack = [...nodes];
  let guard = 0;
  while (stack.length && guard++ < 5000) {
    const n = stack.shift();
    if (!n || typeof n !== 'object') continue;
    if (Array.isArray(n)) { stack.push(...n); continue; }
    const t = n['@type'];
    if (t && (t === 'Product' || (Array.isArray(t) && t.includes('Product')))) return n;
    if (n['@graph']) stack.push(...[].concat(n['@graph']));
    for (const k in n) { if (n[k] && typeof n[k] === 'object') stack.push(n[k]); }
  }
  return null;
}

function _mallOf(host) {
  if (/oliveyoung/i.test(host)) return '올리브영';
  if (/coupang/i.test(host)) return '쿠팡';
  if (/makers\.kakao|kakao/i.test(host)) return '카카오메이커스';
  if (/naver/i.test(host)) return '네이버';
  return host || '기타';
}
function _priceText(p) {
  if (p == null) return '';
  const s = String(p).replace(/[^\d]/g, '');
  return s ? Number(s).toLocaleString('ko-KR') + '원' : '';
}

// POST /api/product/preview  body:{ url } → { ok, mall, thumbnail, name, price }
router.post('/preview', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const url = ((req.body && req.body.url) || '').toString().trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: '유효한 URL이 아닙니다.' });
    let host = '';
    try { host = new URL(url).hostname; } catch (_) {}
    const mall = _mallOf(host);

    let html = '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!resp.ok) {
        return res.json({ ok: false, mall, error: 'HTTP ' + resp.status,
          hint: (resp.status === 403 || resp.status === 429)
            ? `${mall} 접근이 차단되었습니다(봇 차단). 썸네일/상품명/가격을 수동 입력하세요.`
            : `${mall} 페이지를 불러오지 못했습니다(HTTP ${resp.status}).` });
      }
      html = await resp.text();
    } catch (e) {
      logger.warn(`[product] preview fetch 실패: ${e.message}`);
      return res.json({ ok: false, mall, error: e.message, hint: `${mall} 페이지 로드 실패. 수동 입력하세요.` });
    }

    // 1) JSON-LD Product 우선
    let name = '', image = '', price = '';
    const prod = _findProduct(_jsonLd(html));
    if (prod) {
      name = prod.name || '';
      const img = prod.image;
      image = Array.isArray(img) ? (img[0] && (img[0].url || img[0])) : (img && (img.url || img)) || '';
      const offers = [].concat(prod.offers || []).filter(Boolean);
      for (const of of offers) {
        if (of.price != null) { price = of.price; break; }
        if (of.priceSpecification && of.priceSpecification.price != null) { price = of.priceSpecification.price; break; }
      }
    }
    // 2) OG/meta 폴백
    if (!image) image = _meta(html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
    if (!name) name = _meta(html, ['og:title', 'twitter:title']);
    if (!price) price = _meta(html, ['product:price:amount', 'og:price:amount', 'product:sale_price:amount']);

    name = name ? name.replace(/\s+/g, ' ').trim() : '';
    const ok = !!(image || name || price);
    res.json({
      ok, mall,
      thumbnail: image || '',
      name: name || '',
      price: _priceText(price),
      priceRaw: price != null ? String(price) : '',
      hint: ok ? undefined : (mall === '쿠팡'
        ? '쿠팡은 봇 차단으로 자동 수집이 어렵습니다. 수동 입력하세요.'
        : '상품 정보를 찾지 못했습니다. 수동 입력하세요.'),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
