'use strict';

const { GUIDE_IMG_MAX } = require('./guideCanon');
const DUAL_CHANNEL_NOT_READY = Object.freeze({ code: 'dual_channel_not_ready',
  error: '네이버·쿠팡 동시진행은 준비 중입니다. 아직 접수하거나 모집을 시작할 수 없습니다.' });

const own = (node, key) => node !== null && typeof node === 'object'
  && Object.prototype.hasOwnProperty.call(node, key);

class DualChannelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DualChannelError';
    this.code = 'invalid_dual_channel';
  }
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function allowedKeys(value, keys, label) {
  if (!plainObject(value) || Reflect.ownKeys(value).some(k => !keys.includes(k))) {
    throw new DualChannelError(`${label} 형식 또는 항목 이름이 올바르지 않습니다.`);
  }
}

function integer(value, label, min, max) {
  const parsed = typeof value === 'string' && /^[0-9]+$/.test(value.trim())
    ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new DualChannelError(`${label}은 ${min}~${max} 범위의 정수여야 합니다.`);
  }
  return parsed;
}

/** Validate with URL, but preserve the supplied spelling for shared comparisons. */
function httpUrl(value, label, max = Infinity) {
  if (typeof value !== 'string') throw new DualChannelError(`${label} 주소는 문자열이어야 합니다.`);
  const trimmed = value.trim();
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw new DualChannelError(`${label} 주소가 올바르지 않습니다.`);
  let parsed;
  try { parsed = new URL(trimmed); } catch (_) {
    throw new DualChannelError(`${label} 주소가 올바르지 않습니다.`);
  }
  if (!/^https?:\/\//i.test(trimmed) || !['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname || parsed.username || parsed.password || trimmed.length > max) {
    const limit = Number.isFinite(max) ? ` (${max}자 이하)` : '';
    throw new DualChannelError(`${label} 주소는 로그인 정보가 없는 http/https 주소여야 합니다${limit}.`);
  }
  return trimmed;
}

function normalizeGuide(channel, label) {
  if (!own(channel, 'guide') && channel.inflow_type === 'link') return { text: '', images: [] };
  const guide = channel.guide;
  allowedKeys(guide, ['text', 'images'], `${label} 가이드`);
  if (typeof guide.text !== 'string' || !Array.isArray(guide.images) || guide.images.length > GUIDE_IMG_MAX) {
    throw new DualChannelError(`${label} 가이드는 문자열 글과 최대 ${GUIDE_IMG_MAX}장의 사진 목록이 필요합니다.`);
  }
  const images = Array.from(guide.images, image => httpUrl(image, `${label} 가이드 사진`));
  if (channel.inflow_type === 'guide' && !guide.text.trim() && images.length === 0) {
    throw new DualChannelError(`${label} 가이드유입에는 안내 글 또는 사진이 필요합니다.`);
  }
  return { text: guide.text, images };
}

function normalizeChannel(value, label) {
  allowedKeys(value, ['url', 'pay', 'inflow_type', 'guide'], `${label} 구매처 설정`);
  if (value.inflow_type !== 'guide' && value.inflow_type !== 'link') {
    throw new DualChannelError(`${label} 유입방식은 guide 또는 link로 직접 지정해야 합니다.`);
  }
  return {
    ...value,
    url: httpUrl(value.url, `${label} 상품`, 2048),
    pay: integer(value.pay, `${label} 결제금액`, 0, 100000000),
    guide: normalizeGuide(value, label),
  };
}

/** Presence only: malformed JSON remains the caller's validation concern. */
function rawHasDualChannels(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch (_) { return false; }
  }
  return Array.isArray(list) && list.some(p => !Array.isArray(p) && own(p, 'channels'));
}

/** 공고 편집 입력의 존재 판정. 깨진 설정도 지워 버리고 일반 공고로 저장하지 않는다. */
function campaignHasDualChannels(campaign) {
  const c = campaign || {};
  if (c.channel === '네이버+쿠팡' || c.channel_custom === '네이버+쿠팡') return true;
  let wd = c.work_detail;
  if (typeof wd === 'string') { try { wd = JSON.parse(wd); } catch (_) { wd = null; } }
  return own(wd, 'dualChannelProduct') || rawHasDualChannels(c.options)
    || rawHasDualChannels(c.product_options_json);
}

/** 동시진행이라고 명시한 자리에는 일반 상품·빈 값을 대신 넣을 수 없다. */
function normalizeDualChannelProduct(product) {
  if (!plainObject(product) || !own(product, 'channels')) {
    throw new DualChannelError('동시진행 상품에는 두 구매처 설정이 필요합니다.');
  }
  return normalizeChannelProductList([product])[0];
}

/** No channels key means no rewrite, including legacy names, numbers and spacing. */
function normalizeChannelProductList(list) {
  if (!Array.isArray(list)) throw new DualChannelError('상품 원본은 배열이어야 합니다.');
  if (!rawHasDualChannels(list)) return list;
  if (list.length !== 1) throw new DualChannelError('동시진행은 상품 정확히 1개만 지원합니다.');
  const p = list[0];
  // 발행·금액 소비처는 구분자 | 를 제거한다. 그 뒤 비는 이름도 미리 거부한다.
  if (typeof p.name !== 'string' || !p.name.replace(/\|/g, '').trim() || p.name.trim().length > 200) {
    throw new DualChannelError('상품명은 구분자만 있지 않은 200자 이하 문자열이어야 합니다.');
  }
  if (p.product_mode !== 'none' || !Array.isArray(p.options) || p.options.length !== 0) {
    throw new DualChannelError('동시진행은 옵션 없음 방식과 빈 옵션 목록이 필요합니다.');
  }
  if (own(p, 'qty_tiers')) throw new DualChannelError('동시진행은 구매수량 단계를 지원하지 않습니다.');
  if (p.closed === true) throw new DualChannelError('마감된 상품에는 동시진행을 설정할 수 없습니다.');
  if (!plainObject(p.base)) throw new DualChannelError('상품 기본값 객체가 필요합니다.');
  allowedKeys(p.channels, ['naver', 'coupang'], '구매처 목록');
  if (!own(p.channels, 'naver') || !own(p.channels, 'coupang')) {
    throw new DualChannelError('구매처는 네이버와 쿠팡 두 곳 모두 필요합니다.');
  }
  const channels = {
    naver: normalizeChannel(p.channels.naver, '네이버'),
    coupang: normalizeChannel(p.channels.coupang, '쿠팡'),
  };
  const pay = integer(p.base.pay, '상품 기본 결제금액', 0, 100000000);
  const count = integer(p.base.count, '상품 모집인원', 1, 100000);
  if (pay !== channels.naver.pay + channels.coupang.pay) {
    throw new DualChannelError('상품 기본 결제금액은 네이버와 쿠팡 결제금액의 합계와 같아야 합니다.');
  }
  return [{
    ...p,
    base: { ...p.base, pay, count },
    channels,
  }];
}

module.exports = { DualChannelError, normalizeChannelProductList, normalizeDualChannelProduct, rawHasDualChannels, campaignHasDualChannels, DUAL_CHANNEL_NOT_READY };
