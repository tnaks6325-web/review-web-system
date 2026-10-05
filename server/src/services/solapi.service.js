'use strict';

const crypto = require('crypto');

const API_BASE = 'https://api.solapi.com';
const SEND_PATH = '/messages/v4/send-many/detail';
const LIST_PATH = '/messages/v4/list';
const BALANCE_PATH = '/cash/v1/balance';
const PRICING_PATH = '/pricing/v1/messaging?countryId=82&serviceMethod=MT';
const BILLING_CACHE_TTL_MS = 60_000;

let billingCache = null;

function _config(env = process.env) {
  return {
    apiKey: String(env.SOLAPI_API_KEY || '').trim(),
    apiSecret: String(env.SOLAPI_API_SECRET || '').trim(),
    pfId: String(env.SOLAPI_PF_ID || '').trim(),
    senderNumber: String(env.SOLAPI_SENDER_NUMBER || '').replace(/[^0-9]/g, ''),
    templateIds: {
      1: String(env.SOLAPI_REVIEW_TEMPLATE_ID_1 || '').trim(),
      2: String(env.SOLAPI_REVIEW_TEMPLATE_ID_2 || '').trim(),
      3: String(env.SOLAPI_REVIEW_TEMPLATE_ID_3 || '').trim(),
    },
  };
}

function getSolapiStatus(env = process.env) {
  const c = _config(env);
  const missing = [];
  if (!c.apiKey) missing.push('SOLAPI_API_KEY');
  if (!c.apiSecret) missing.push('SOLAPI_API_SECRET');
  if (!c.pfId) missing.push('SOLAPI_PF_ID');
  if (!c.senderNumber) missing.push('SOLAPI_SENDER_NUMBER');
  for (let i = 1; i <= 3; i++) {
    if (!c.templateIds[i]) missing.push(`SOLAPI_REVIEW_TEMPLATE_ID_${i}`);
  }
  return { configured: missing.length === 0, missing };
}

function createAuthorization(apiKey, apiSecret, { date, salt } = {}) {
  const requestDate = date || new Date().toISOString();
  const requestSalt = salt || crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', apiSecret)
    .update(requestDate + requestSalt)
    .digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${requestDate}, salt=${requestSalt}, signature=${signature}`;
}

async function _request(path, { method = 'GET', body, fetchImpl = global.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('SOLAPI_FETCH_UNAVAILABLE');
  const c = _config();
  const status = getSolapiStatus();
  if (!status.configured) {
    const err = new Error(`SOLAPI_NOT_CONFIGURED:${status.missing.join(',')}`);
    err.code = 'SOLAPI_NOT_CONFIGURED';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(API_BASE + path, {
      method,
      headers: {
        Authorization: createAuthorization(c.apiKey, c.apiSecret),
        'Content-Type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_) { payload = { message: raw.slice(0, 500) }; }
    if (!response.ok) {
      const err = new Error(`SOLAPI_HTTP_${response.status}:${payload.errorCode || payload.message || 'request_failed'}`);
      err.code = payload.errorCode || `SOLAPI_HTTP_${response.status}`;
      err.status = response.status;
      throw err;
    }
    return payload;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const timeout = new Error('SOLAPI_REQUEST_TIMEOUT');
      timeout.code = 'SOLAPI_REQUEST_TIMEOUT';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function _firstResult(payload) {
  const accepted = Array.isArray(payload && payload.messageList) ? payload.messageList[0] : null;
  if (accepted) return { ...accepted, accepted: String(accepted.statusCode || '') === '2000' };
  const failed = Array.isArray(payload && payload.failedMessageList) ? payload.failedMessageList[0] : null;
  if (failed) return { ...failed, accepted: false };
  return { accepted: false, statusCode: '', statusMessage: 'SOLAPI_EMPTY_RESULT' };
}

async function sendReviewAlimTalk({ to, reminderNo, variables, customFields = {} }, opts = {}) {
  const c = _config();
  const templateId = c.templateIds[reminderNo];
  if (!templateId) throw new Error(`SOLAPI_TEMPLATE_NOT_CONFIGURED:${reminderNo}`);
  const payload = await _request(SEND_PATH, {
    method: 'POST',
    fetchImpl: opts.fetchImpl,
    body: {
      messages: [{
        to: String(to || '').replace(/[^0-9]/g, ''),
        from: c.senderNumber,
        type: 'ATA',
        kakaoOptions: {
          pfId: c.pfId,
          templateId,
          disableSms: true,
          variables,
        },
        customFields,
      }],
      strict: true,
      allowDuplicates: false,
      showMessageList: true,
    },
  });
  const result = _firstResult(payload);
  return {
    accepted: result.accepted,
    messageId: result.messageId || null,
    groupId: (payload.groupInfo && payload.groupInfo.groupId) || result.groupId || null,
    statusCode: String(result.statusCode || ''),
    reason: String(result.statusMessage || result.reason || ''),
    templateId,
  };
}

/* 문자 바이트 수 — 통신사 기준(한글 등 비ASCII 2바이트). 90바이트 초과는 장문(LMS). */
function smsBytes(text) {
  let n = 0;
  for (const ch of String(text || '')) n += ch.charCodeAt(0) > 127 ? 2 : 1;
  return n;
}
const SMS_MAX_BYTES = 90;
const LMS_MAX_BYTES = 2000;

/**
 * 담당자 직접 입력 문자(SMS/LMS). 발신번호는 알림톡과 같은 등록 번호(SOLAPI_SENDER_NUMBER).
 * ★ 길이로 종류를 정한다(90바이트 이하 SMS · 초과 LMS · 2000바이트 초과는 호출 전에 거부).
 */
async function sendSms({ to, text, subject = '', customFields = {} }, opts = {}) {
  const c = _config();
  const body = String(text || '');
  const bytes = smsBytes(body);
  if (!body.trim()) throw new Error('SMS_EMPTY');
  if (bytes > LMS_MAX_BYTES) throw new Error('SMS_TOO_LONG');
  const type = bytes > SMS_MAX_BYTES ? 'LMS' : 'SMS';
  const msg = { to: String(to || '').replace(/[^0-9]/g, ''), from: c.senderNumber, type, text: body, customFields };
  if (type === 'LMS') msg.subject = String(subject || '안내').slice(0, 20);
  const payload = await _request(SEND_PATH, {
    method: 'POST',
    fetchImpl: opts.fetchImpl,
    body: { messages: [msg], strict: true, allowDuplicates: false, showMessageList: true },
  });
  const result = _firstResult(payload);
  return {
    accepted: result.accepted,
    messageId: result.messageId || null,
    statusCode: String(result.statusCode || ''),
    reason: String(result.statusMessage || result.reason || ''),
    type,
  };
}

async function getMessageStatus(messageId, opts = {}) {
  const qs = new URLSearchParams({
    criteria: 'messageId',
    cond: 'eq',
    value: String(messageId),
    limit: '1',
  });
  const payload = await _request(`${LIST_PATH}?${qs.toString()}`, { fetchImpl: opts.fetchImpl });
  const map = payload && payload.messageList && typeof payload.messageList === 'object'
    ? payload.messageList : {};
  const item = map[messageId] || Object.values(map)[0] || null;
  if (!item) return { found: false, complete: false, success: false };
  const code = String(item.statusCode || '');
  return {
    found: true,
    complete: item.status === 'COMPLETE',
    success: item.status === 'COMPLETE' && code === '4000',
    status: item.status || '',
    statusCode: code,
    reason: String(item.reason || ''),
    dateReceived: item.dateReceived || null,
    dateUpdated: item.dateUpdated || null,
  };
}

function _finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function getAccountBilling(opts = {}) {
  const now = Date.now();
  const canUseCache = !opts.fetchImpl;
  if (canUseCache && billingCache && now - billingCache.cachedAt < BILLING_CACHE_TTL_MS) {
    return billingCache.value;
  }

  const [cash, pricing] = await Promise.all([
    _request(BALANCE_PATH, { fetchImpl: opts.fetchImpl }),
    _request(PRICING_PATH, { fetchImpl: opts.fetchImpl }),
  ]);
  const balance = _finiteNumber(cash.balance);
  const point = _finiteNumber(cash.point);
  const unitPrice = _finiteNumber(pricing.ata);
  if (balance == null || point == null || unitPrice == null) {
    const err = new Error('SOLAPI_BILLING_RESPONSE_INVALID');
    err.code = 'SOLAPI_BILLING_RESPONSE_INVALID';
    throw err;
  }

  const value = {
    available: true,
    balance,
    point,
    spendable: balance + point,
    unitPrice,
    unitPriceVatIncluded: Math.round(unitPrice * 1.1 * 100) / 100,
    // 담당자 수동 발송 확인창용 종류별 단가(부가세 별도 · 포함). 값이 없으면 null(모르는 값을 0으로 꾸미지 않는다).
    prices: ['ata', 'sms', 'lms'].reduce((o, k) => {
      const v = _finiteNumber(pricing[k]);
      o[k] = v == null ? null : { unit: v, vat: Math.round(v * 1.1 * 100) / 100 };
      return o;
    }, {}),
    autoRecharge: Number(cash.autoRecharge) > 0,
    checkedAt: new Date(now).toISOString(),
  };
  if (canUseCache) billingCache = { cachedAt: now, value };
  return value;
}

module.exports = {
  getSolapiStatus,
  createAuthorization,
  sendReviewAlimTalk,
  sendSms,
  smsBytes,
  SMS_MAX_BYTES,
  LMS_MAX_BYTES,
  getMessageStatus,
  getAccountBilling,
  _config,
  _firstResult,
};
