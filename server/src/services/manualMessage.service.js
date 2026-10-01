'use strict';
/**
 * 작업보드 수동 발송 — 문자(SMS/LMS) · 알림톡(시안 A, 사용자 확정 2026-09-30).
 *
 * ★ 받는 사람 = 리뷰어에게 메시지와 같은 판정(`csRecipient.resolveRecipients`, 로그인 본계정).
 * ★ 문자 답장 문제(발신번호가 대표 개인 휴대폰): 문자 끝에 "발신 전용 · 문의는 1:1 문의로" 안내와
 *   리뷰웹 1:1 문의 주소를 자동으로 붙이고, **같은 내용을 그 리뷰어의 1:1 문의방에도 남긴다**
 *   (csBridge.postAdminNotice 한 벌) → 리뷰어가 링크를 누르면 그 대화에서 바로 답하고,
 *   직원은 C/S 문의창구에서 본다.
 * ★ 알림톡 = 자동 알림의 **다음 회차**를 지금 보낸다(reviewReminder.sendManual — 원장·종결 흐름 공유).
 * ★ 모든 발송은 manual_message_sends 에 남긴다(기록 실패가 발송 결과를 뒤집지 않는다).
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const solapi = require('./solapi.service');
const reminder = require('./reviewReminder.service');
const { reviewerContactsForRows } = require('./reviewerContact.service');
const csBridge = require('./csBridge.service');

const MAX_ROWS = 200;
const SEND_REASON = {
  submitted_before_send: '방금 리뷰를 제출해서 보내지 않았습니다',
  review_row_missing: '리뷰 줄을 찾지 못했습니다',
  closed_before_send: '미작성 종결된 줄입니다',
  fulfilled_before_send: '리뷰 의무가 이미 끝났습니다',
  review_not_pending_before_send: '리뷰 대기 상태가 아닙니다',
  cancelled_before_send: '주문이 취소됐습니다',
};
const TEXT_MAX_BYTES = solapi.LMS_MAX_BYTES;

function homeLink(env = process.env) {
  return String(env.REVIEW_WEB_HOME_URL || 'review-web-system.pages.dev')
    .trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '') + '/#cs';
}
function smsFooter(env = process.env) {
  return `\n\n※ 발신 전용 번호라 답장을 확인할 수 없습니다. 문의는 리뷰웹 1:1 문의로 남겨 주세요.\n${homeLink(env)}`;
}
/** 리뷰웹 주소(호스트) — 본문에 이미 있으면 안내 문구를 붙이지 않는다(단문 문안 · 사용자 확정 2026-10-01). */
function homeHost(env = process.env) { return homeLink(env).replace(/\/#cs$/, ''); }
/* ★ 호스트 경계까지 본다 — `notreview-web-system.pages.dev`·`…pages.dev.example.com` 같은 비슷한 주소를
   우리 주소로 보고 안내 문구를 빼면 답할 길이 없는 문자가 나간다. 화면(_msHasLink)과 같은 정규식. */
function hasHomeLink(text, env = process.env) {
  const h = homeHost(env); if (!h) return false;
  const re = new RegExp('(^|[^A-Za-z0-9.-])' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[/?#:\\s])', 'i');
  return re.test(String(text || ''));
}
function composeSms(text, env = process.env) {
  const body = String(text || '').trim();
  return hasHomeLink(body, env) ? body : body + smsFooter(env);
}

async function _participants(sheetId, tabName, ids) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, seq, COALESCE(reviewer_name,'') AS "rowName"
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND id::text = ANY($3::text[])
        AND deleted_at IS NULL AND active = TRUE`, [sheetId, tabName, ids]);
  return rows;
}

function _ids(v) {
  return [...new Set((Array.isArray(v) ? v : []).map(x => String(x || '').trim()).filter(Boolean))].slice(0, MAX_ROWS);
}

/** 미리보기 — 쓰기 0건(알림톡 도착 확인 갱신만 예외: reconcileAccepted). */
async function previewManualSend({ sheetId, tabName, ids, withBilling = true }) {
  const want = _ids(ids);
  if (!sheetId || !tabName || !want.length) return { items: [] };
  const cps = await _participants(sheetId, tabName, want);
  const bySeq = new Map(cps.map(c => [Number(c.seq), c]));
  const { items: contacts } = await reviewerContactsForRows({ sheetId, tabName, participantIds: cps.map(c => c.id) });
  const contactBy = new Map(contacts.map(c => [String(c.participantId), c]));
  let ata = { byRow: new Map(), error: '' };
  try {
    ata = await reminder.manualPreview({ sheetId, tabName, rowIndexes: [...bySeq.keys()] });
  } catch (e) {
    ata.error = '알림톡 대상을 확인하지 못했습니다';
    logger.warn(`[manualMessage] 알림톡 미리보기 실패: ${e.message}`);
  }
  const items = want.map(id => {
    const cp = cps.find(c => c.id === id);
    if (!cp) return { participantId: id, missing: true, sms: { ok: false, reason: '표에 없는 줄입니다' }, ata: { ok: false, reason: '표에 없는 줄입니다' } };
    const c = contactBy.get(id) || {};
    const sms = c.ok && c.phoneFull
      ? { ok: true, name: c.name, phone: c.phoneFull, phone8: c.phone8, isSub: !!c.isSub }
      : { ok: false, reason: c.ok ? '전체 번호를 특정할 수 없습니다(같은 뒤 8자리 번호가 여럿)' : (c.reason || '받는 사람을 찾지 못했습니다') };
    const a = ata.byRow.get(Number(cp.seq));
    const atap = ata.error ? { ok: false, reason: ata.error }
      : !a ? { ok: false, reason: '리뷰 미제출 상태의 구매 기록을 찾지 못했습니다' }
      : { ok: a.ok, reminderNo: a.reminderNo, deadline: a.deadline, phoneTail: a.phoneTail, reason: a.reason };
    return { participantId: id, seq: cp.seq, rowName: cp.rowName, sms, ata: atap };
  });
  // 건당 비용·잔액 — 확인창이 정확한 금액을 말하게. 조회 실패는 null(화면이 "확인 못 함"이라고 말한다).
  let billing = null;
  // ★ 실제 발송 경로(withBilling:false)는 단가를 다시 조회하지 않는다 — 단가 서버가 느려도 발송이 기다리지 않게.
  if (withBilling) try {
    const b = await solapi.getAccountBilling();
    if (b && b.available) billing = { prices: b.prices || null, spendable: b.spendable, checkedAt: b.checkedAt };
  } catch (e) { logger.warn(`[manualMessage] 단가 조회 실패: ${e.message}`); }
  return { items, footer: smsFooter(), homeLink: homeLink(), homeHost: homeHost(), providerConfigured: solapi.getSolapiStatus().configured, billing };
}

async function _log(row) {
  try {
    await pool.query(
      `INSERT INTO manual_message_sends
         (kind, sheet_id, tab_name, participant_id, order_submission_id, reviewer_name, target_phone,
          message_text, message_type, reminder_no, accepted, provider_message_id, provider_reason, sent_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [row.kind, row.sheetId, row.tabName, row.participantId || '', row.orderSubmissionId || '',
       row.reviewerName || '', row.targetPhone || '', row.text || '', row.type || '',
       row.reminderNo || null, !!row.accepted, row.messageId || null, row.reason || '', row.by || '']);
  } catch (e) {
    logger.warn(`[manualMessage] 발송 기록 실패(발송 결과는 유지): ${e.message}`);
  }
}

async function sendManualSms({ sheetId, tabName, ids, text, by }) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '보낼 내용을 입력하세요' };
  const full = composeSms(body);
  if (solapi.smsBytes(full) > TEXT_MAX_BYTES) return { ok: false, error: '내용이 너무 깁니다(안내 문구 포함 2000바이트까지)' };
  if (!solapi.getSolapiStatus().configured) return { ok: false, error: '문자 발송 설정이 비어 있습니다' };
  const { items } = await previewManualSend({ sheetId, tabName, ids, withBilling: false });
  const results = [];
  const seen = new Map();
  for (const it of items) {
    const base = { participantId: it.participantId, rowName: it.rowName || '' };
    if (!it.sms.ok) { results.push({ ...base, sent: false, reason: it.sms.reason }); continue; }
    if (seen.has(it.sms.phone)) { results.push({ ...base, sent: false, merged: true, reason: '같은 번호에 이미 보냈습니다(한 번만 발송)' }); continue; }
    seen.set(it.sms.phone, true);
    let out;
    try {
      out = await solapi.sendSms({ to: it.sms.phone, text: full, subject: 'IA리뷰 안내',
        customFields: { participantId: String(it.participantId), kind: 'manual_sms' } });
    } catch (e) {
      out = { accepted: false, reason: e.code || e.message || '발송 실패' };
    }
    // 같은 내용을 1:1 문의방에도 남긴다(리뷰어가 링크로 들어와 바로 답할 수 있게). 실패해도 문자 결과는 유지.
    let roomOk = false;
    if (out.accepted) {
      try {
        const r = await csBridge.postAdminNotice({ sheetId, tabName, rowIndex: it.seq,
          reviewerName: it.sms.name || it.rowName, phone8: it.sms.phone8, message: body, by });
        roomOk = !!r;
      } catch (_) { roomOk = false; }
    }
    await _log({ kind: 'sms', sheetId, tabName, participantId: it.participantId, reviewerName: it.sms.name,
      targetPhone: it.sms.phone, text: full, type: out.type, accepted: out.accepted,
      messageId: out.messageId, reason: out.reason, by });
    results.push({ ...base, name: it.sms.name, phone: it.sms.phone, sent: !!out.accepted, type: out.type,
      roomOk, reason: out.accepted ? '' : `문자 발송 실패 — ${out.reason || '사유 없음'}` });
  }
  return { ok: results.some(r => r.sent), results };
}

async function sendManualAlimtalk({ sheetId, tabName, ids, by }) {
  if (!solapi.getSolapiStatus().configured) return { ok: false, error: '알림톡 발송 설정이 비어 있습니다' };
  const want = _ids(ids);
  const cps = await _participants(sheetId, tabName, want);
  const seqs = [...new Set(cps.map(c => Number(c.seq)))];
  const out = await reminder.sendManual({ sheetId, tabName, rowIndexes: seqs });
  const bySeq = new Map((out.results || []).map(r => [Number(r.rowIndex), r]));
  const results = [];
  const done = new Set();
  for (const id of want) {
    const cp = cps.find(c => c.id === id);
    if (!cp) { results.push({ participantId: id, sent: false, reason: '표에 없는 줄입니다' }); continue; }
    const r = bySeq.get(Number(cp.seq)) || { sent: false, reason: '결과가 없습니다' };
    if (done.has(Number(cp.seq))) { results.push({ participantId: id, rowName: cp.rowName, sent: false, reason: '같은 줄 — 한 번만 발송' }); continue; }
    done.add(Number(cp.seq));
    const accepted = !!(r.sent && r.accepted);
    if (r.sent) {
      await _log({ kind: 'alimtalk', sheetId, tabName, participantId: id, orderSubmissionId: r.orderSubmissionId,
        reviewerName: r.reviewerName || cp.rowName, targetPhone: r.targetPhone, text: `리뷰미작성_${r.reminderNo}차`,
        type: 'ATA', reminderNo: r.reminderNo, accepted, reason: r.reason, by });
    }
    results.push({ participantId: id, rowName: cp.rowName, sent: accepted, reminderNo: r.reminderNo,
      phoneTail: r.phoneTail, reason: accepted ? '' : (SEND_REASON[r.reason] || r.reason || '보내지 못했습니다') });
  }
  return { ok: results.some(r => r.sent), error: out.ok === false ? out.error : undefined, results };
}

/* ══ 문안용 짧은 상품 이름 — 시스템이 추천하고(AI), 직원이 고쳐 보내면 그 이름을 기억한다 ══
   ★ 작업마다 app_settings 한 키(`sms_short_name:<시트>||<탭>`) — 동시 저장이 서로를 지우지 않게 키를 나눈다.
   ★ 직원이 정한 이름(manual)이 언제나 이긴다 · AI 추천은 원래 상품명이 바뀌면 다시 만든다.
   ★ 한글 5자(10바이트) 이내만 인정한다 — 넘으면 단문 문안이 장문이 된다(그때는 추천 없음). */
const SHORT_MAX_BYTES = 10;
function _shortKey(sheetId, tabName) { return `sms_short_name:${sheetId}||${tabName}`; }
function normalizeShortName(v) {
  const s = String(v || '').replace(/["'“”‘’\[\]()<>{}]/g, '').replace(/\s+/g, '').trim();
  if (!s || /https?:|○|\.(com|kr|net)/i.test(s)) return '';
  const b = solapi.smsBytes(s);
  return b >= 2 && b <= SHORT_MAX_BYTES ? s : '';
}
function _cleanProductSource(v) {
  return String(v || '').replace(/^\s*\[상품\/옵션\/금액\]\s*/, '').replace(/^\s*\d{1,3}\.\s+/, '')
    .split('\n')[0].replace(/\s*\(?\s*https?:\/\/\S*/gi, '').trim().slice(0, 200);
}
async function _readShort(sheetId, tabName) {
  try {
    const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [_shortKey(sheetId, tabName)]);
    return rows[0] ? JSON.parse(rows[0].value) : null;
  } catch (_) { return null; }
}
async function _writeShort(sheetId, tabName, val) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [_shortKey(sheetId, tabName), JSON.stringify(val)]);
}
async function productShortName({ sheetId, tabName, productName, suggest }) {
  if (!sheetId || !tabName) return { name: '', source: 'none' };
  const saved = await _readShort(sheetId, tabName);
  if (saved && saved.source === 'manual' && normalizeShortName(saved.name)) return { name: saved.name, source: 'manual' };
  const from = _cleanProductSource(productName);
  if (!from) return { name: '', source: 'none' };
  if (saved && saved.source === 'ai' && saved.from === from && normalizeShortName(saved.name)) return { name: saved.name, source: 'ai' };
  const ask = suggest || require('./gemini.service').suggestShortProductName;
  const name = normalizeShortName(await ask(from));
  if (!name) return { name: '', source: 'none' };
  try { await _writeShort(sheetId, tabName, { name, source: 'ai', from, at: new Date().toISOString() }); }
  catch (e) { logger.warn(`[manualMessage] 추천 상품명 저장 실패(추천은 유지): ${e.message}`); }
  return { name, source: 'ai' };
}
async function saveShortName({ sheetId, tabName, name, by }) {
  const n = normalizeShortName(name);
  if (!sheetId || !tabName || !n) return { ok: false, error: '상품명은 한글 5자(10바이트) 이내로 넣어 주세요' };
  await _writeShort(sheetId, tabName, { name: n, source: 'manual', by: String(by || ''), at: new Date().toISOString() });
  return { ok: true, name: n };
}

module.exports = { productShortName, saveShortName, normalizeShortName, SHORT_MAX_BYTES, previewManualSend, sendManualSms, sendManualAlimtalk, composeSms, smsFooter, homeLink, homeHost, hasHomeLink, MAX_ROWS };
