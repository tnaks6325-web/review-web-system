'use strict';

const BANNER_WIDTH = 1080;
const BANNER_HEIGHT = 240;
const IMAGE_URL_RE = /^https?:\/\/[^\s"'<>]+\/api\/order\/guide-image\/[-\w]{20,}$/i;

function normalizeImageUrl(value) {
  const url = String(value || '').trim();
  return IMAGE_URL_RE.test(url) ? url : '';
}

function normalizeClickUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return '';
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return '';
    return url.href;
  } catch (_) { return ''; }
}

function normalizeStoredBanner(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (_) { raw = {}; }
  }
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    active: raw.active === true,
    imageUrl: normalizeImageUrl(raw.imageUrl),
    clickUrl: normalizeClickUrl(raw.clickUrl),
    width: BANNER_WIDTH,
    height: BANNER_HEIGHT,
  };
}

function validateBannerInput(body) {
  const raw = body || {};
  const imageUrl = normalizeImageUrl(raw.imageUrl);
  const clickUrl = normalizeClickUrl(raw.clickUrl);
  const active = raw.active === true || raw.active === 'true' || raw.active === 1;
  if (raw.imageUrl && !imageUrl) return { ok: false, error: '배너 이미지는 이 시스템에서 업로드한 이미지여야 합니다.' };
  if (raw.clickUrl && !clickUrl) return { ok: false, error: '클릭 URL은 http 또는 https 주소만 사용할 수 있습니다.' };
  if (active && (!imageUrl || !clickUrl)) return { ok: false, error: '활성화하려면 배너 이미지와 클릭 URL을 모두 설정해 주세요.' };
  return { ok: true, banner: { active, imageUrl, clickUrl, width: BANNER_WIDTH, height: BANNER_HEIGHT } };
}

function toPublicBanner(banner) {
  const value = normalizeStoredBanner(banner);
  return value.active && value.imageUrl && value.clickUrl ? value : null;
}

module.exports = { BANNER_WIDTH, BANNER_HEIGHT, normalizeStoredBanner, validateBannerInput, toPublicBanner };
