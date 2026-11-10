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
const { normalizeCsClientMsgId } = require('../utils/csClientMsgId');   // 키 모양 단일 출처(결정 361·362) — 정규식 사본 0

const MAX_ROWS = 200;
const SEND_REASON = {
  submitted_before_send: '방금 리뷰를 제출해서 보내지 않았습니다',
  review_row_missing: '리뷰 줄을 찾지 못했습니다',
  closed_before_send: '미작성 종결된 줄입니다',
  fulfilled_before_send: '리뷰 의무가 이미 끝났습니다',
  review_not_pending_before_send: '리뷰 대기 상태가 아닙니다',
  cancelled_before_send: '주문이 취소됐습니다',
  // 결정 365 — 같은 줄을 동시에 보낸 다른 요청(다른 담당자·구버전 화면·자동 알림)이 먼저 이 회차를 잡았다(공급자 호출 0).
  sent_by_other_before_send: '다른 담당자(또는 자동 알림)가 방금 이 회차 알림톡을 보냈습니다 — 두 번 나가지 않게 이번에는 보내지 않았습니다. 창을 다시 열면 결과가 보입니다',
  reminder_busy_before_send: '같은 리뷰어에게 다른 알림톡을 보내는 중입니다 — 두 번 나가지 않게 이번에는 보내지 않았습니다. 잠시 뒤 창을 다시 열어 확인해 주세요',
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

/* ══ 다시 보내기 키(clientSendId) — 응답만 못 받은 첫 발송 뒤 다시 보내도 한 사람에게 한 번만 (결정 364 · migration 222) ══
   ★ 화면이 「같은 줄 선택·방식·내용」마다 키 하나를 만들어 다시 보낼 때마다 같은 키를 싣는다(createCsStaffDraftKey).
   ★ 서버는 받는 사람(참여 줄)마다 **공급자를 부르기 전에** 발송 기록에 '대기(pending)' 줄을 먼저 넣는다 —
     부분 유일 색인 (client_send_id, participant_id) 때문에 같은 키·같은 사람은 한 요청만 선점한다.
     선점한 요청만 공급자를 부르고, 결과로 sent / failed / unknown 을 적는다.
   ★ 다시 온 요청이 본 상태:
       sent    → 공급자를 부르지 않고 「보냄」(duplicate:true)
       failed  → 확실한 실패(공급자가 거절했다고 답함) → 같은 키로 다시 선점해 다시 보낸다
       unknown → 시간 초과·끊김(받았을 수도 있다) → **다시 보내지 않는다**(돈이 두 번 들 수 있다)
       pending → 앞선 요청이 아직 처리 중(또는 처리 중 서버가 멈춤) → 다시 보내지 않는다
   ★ 같은 키인데 내용(방식·작업·글·보낸 사람)이 다르면 409 manual_send_conflict — 아무것도 보내지 않는다.
   ★ 키가 없거나 모양이 틀리면 종전 경로 한 줄도 안 바뀜. 칸·색인이 없는 DB(42703·42P10)도 종전 경로. */
const SEND_CONFLICT = 'manual_send_conflict';
const SEND_IN_PROGRESS = 'manual_send_in_progress';
const SEND_UNKNOWN = 'manual_send_unknown';
const PENDING_STALE_MS = 2 * 60 * 1000;   // 공급자 시간 제한(12초)보다 한참 길게 — 이보다 오래된 대기 = 처리 중 멈춘 것(결과 모름)
const KEY_MSG = {
  conflict: '같은 발송 요청인데 내용이 달라 보내지 않았습니다 — 창을 닫고 다시 열어 보내 주세요',
  inProgress: '앞서 누른 발송이 아직 처리 중입니다 — 잠시 뒤 창을 다시 열어 결과를 확인해 주세요(두 번 나가지 않게 이번에는 보내지 않았습니다)',
  smsUnknown: '문자 발송 결과를 확인하지 못했습니다(이미 받았을 수 있습니다) — 두 번 나가지 않게 다시 보내지 않았습니다. 꼭 다시 보내야 하면 리뷰어에게 확인한 뒤 내용을 조금 고치거나 화면을 새로고침하고 보내 주세요',
  ataUnknown: '알림톡 발송 결과를 확인하지 못했습니다(이미 받았을 수 있습니다) — 두 번 나가지 않게 다시 보내지 않았습니다',
  claimFailed: '발송 기록을 남기지 못해 보내지 않았습니다 — 잠시 뒤 다시 보내 주세요',
};
const _SCHEMA_GAP = new Set(['42703', '42P10']);   // 칸 없음 · ON CONFLICT 에 맞는 유일 색인 없음(마이그레이션 222 전)
function _schemaGap(e) { return !!(e && _SCHEMA_GAP.has(String(e.code || ''))); }
/* 문자 공급자 오류가 「확실한 실패」인가 — HTTP 응답이 있었으면(거절) 또는 요청을 보내기도 전의 오류면 확실한 실패.
   그 밖(시간 초과·연결 끊김·응답 읽다 끊김)은 공급자가 받았을 수 있다 = 결과 모름. */
const _SMS_PRE_REQUEST = new Set(['SOLAPI_NOT_CONFIGURED', 'SOLAPI_FETCH_UNAVAILABLE', 'SMS_EMPTY', 'SMS_TOO_LONG']);
function _smsErrorUncertain(e) {
  if (e && e.status) return false;
  const c = String((e && (e.code || e.message)) || '');
  return !_SMS_PRE_REQUEST.has(c);
}
function _sendFp({ kind, sheetId, tabName, text, by }) {
  return require('crypto').createHash('sha256')
    .update(JSON.stringify([String(kind || ''), String(sheetId || ''), String(tabName || ''), String(text || '').trim(), String(by || '')]))
    .digest('hex');
}
/* ══ 같은 번호·같은 글 N분 안 다시 보내기 막기 (결정 366 · 사장님 확정 2026-11-10 · 스키마 변경 0) ══
   ★ 키(결정 364)와 무관하게 모든 수동 문자에 적용 — 새 화면(키 있음)·구버전 화면(키 없음)·다른 담당자 모두.
   ★ 같은 사람 = 받는 번호 숫자만(참여 줄·본계정/타계정과 무관) · 같은 글 = 실제로 나가는 최종 글(안내 문구 포함)을
     앞뒤 공백 자르고 공백·줄바꿈 묶음을 한 칸으로 본 것.
   ★ 막는 앞선 기록 = 창(기본 10분) 안의 sent·pending(보내는 중)·unknown(결과 모름) · 종전 경로 기록(send_state 없음)은 accepted 만.
     확실한 실패(failed · 종전 기록의 accepted=false)는 막지 않는다.
   ★ 동시에 두 요청 — 짧은 트랜잭션: 번호 advisory 잠금(lock_timeout 5초) → 창 안 기록 확인 → '대기' 줄 선점 → COMMIT
     → 공급자 호출은 잠금 밖(결정 364·365 와 같은 「선점 → 호출」 모양). 둘째는 첫째의 '대기' 줄을 보고 보내지 않는다.
   ★ 같은 키 다시 보내기는 364 결과(보냄=duplicate · 결과 모름 · 처리 중)가 우선 — 자기 키 줄이 있으면(확실한 실패 제외) 창 판정을 하지 않는다. */
const SMS_WINDOW_ENV = 'MANUAL_SMS_SAME_TEXT_WINDOW_MIN';
const SMS_WINDOW_DEFAULT_MIN = 10;
const SMS_WINDOW_MAX_MIN = 24 * 60;
const SMS_SAME_TEXT = 'manual_sms_same_text_window';
const SMS_BUSY = 'manual_sms_busy';
/** 창(분) — 환경변수(Railway Variables). 비었거나 잘못된 값 = 기본 10분(보호를 끄지 않는 쪽) · 0 = 규칙 끔 · 상한 1440. */
function smsSameTextWindowMin(env = process.env) {
  const raw = env[SMS_WINDOW_ENV];
  if (raw == null || String(raw).trim() === '') return SMS_WINDOW_DEFAULT_MIN;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return SMS_WINDOW_DEFAULT_MIN;
  return Math.min(SMS_WINDOW_MAX_MIN, Math.floor(n));
}
function smsPhoneKey(phone) { return String(phone || '').replace(/[^0-9]/g, ''); }
function smsTextKey(text) { return String(text || '').trim().replace(/\s+/g, ' '); }
/** 막혔을 때 결과 목록에 그대로 나가는 한국어(화면 수정 0 — 화면은 r.reason 을 그린다). */
function smsWindowReason({ state, ageSec, windowMin }) {
  const ago = Math.floor(Math.max(0, ageSec) / 60);
  const left = Math.max(1, Math.ceil((windowMin * 60 - Math.max(0, ageSec)) / 60));
  const when = ago < 1 ? '방금' : `${ago}분 전에`;
  const tail = `두 번 나가지 않게 이번에는 보내지 않았습니다. 꼭 다시 보내야 하면 ${left}분 뒤에 보내거나 내용을 고쳐 주세요`;
  if (state === 'pending') return `같은 번호로 같은 문자를 ${when} 보내기 시작해 아직 처리 중입니다 — ${tail}`;
  if (state === 'unknown') return `같은 번호로 같은 문자를 ${when} 보냈는데 결과를 확인하지 못했습니다(이미 받았을 수 있습니다) — ${tail}`;
  return `같은 번호로 같은 문자를 ${when} 보냈습니다 — ${tail}`;
}
const SMS_BUSY_MSG = '같은 번호로 문자를 보내는 다른 요청이 처리 중입니다 — 두 번 나가지 않게 이번에는 보내지 않았습니다. 잠시 뒤 창을 다시 열어 확인한 뒤 보내 주세요';
/** 창 안에 같은 번호·같은 글의 「보냈거나 보냈을 수 있는」 기록이 있나 — 트랜잭션 안(번호 잠금 뒤)에서만 부른다. */
async function _smsWindowHit(db, { phoneKey, text, windowMin }) {
  const { rows } = await db.query(
    `SELECT message_text AS text, send_state AS state,
            GREATEST(0, EXTRACT(EPOCH FROM (NOW() - COALESCE(send_state_at, created_at))))::float8 AS "ageSec"
       FROM manual_message_sends
      WHERE kind = 'sms'
        AND regexp_replace(target_phone, '[^0-9]', '', 'g') = $1
        AND COALESCE(send_state_at, created_at) > NOW() - make_interval(secs => $2)
        AND (send_state IN ('sent', 'pending', 'unknown') OR (send_state IS NULL AND accepted))
      ORDER BY COALESCE(send_state_at, created_at) DESC
      LIMIT 200`, [phoneKey, windowMin * 60]);
  const want = smsTextKey(text);
  const hit = rows.find(r => smsTextKey(r.text) === want);
  if (!hit) return null;
  const ageSec = Number(hit.ageSec) || 0;
  const state = hit.state === 'pending' && ageSec * 1000 >= PENDING_STALE_MS ? 'unknown' : (hit.state || 'sent');
  return { state, ageSec };
}
const _CLAIM_NOKEY_SQL = `
  INSERT INTO manual_message_sends
    (kind, sheet_id, tab_name, participant_id, order_submission_id, reviewer_name, target_phone,
     message_text, message_type, reminder_no, accepted, provider_message_id, provider_reason, sent_by, send_state, send_state_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',NOW())
  RETURNING id`;
/**
 * 문자 한 사람 선점(키 있음·없음 공용) — 번호 잠금 안에서 창 판정 후 '대기' 줄을 넣고 COMMIT.
 * → _claim 과 같은 모양 + { window:{state,ageSec} } | { lockBusy }
 * ★ 공급자 호출 전에만 부른다 · 칸·색인 없음(42703·42P10)은 그대로 던진다(호출부가 종전 경로로 접는다).
 */
async function _claimSmsTx(c) {
  const windowMin = smsSameTextWindowMin();
  const phoneKey = smsPhoneKey(c.targetPhone);
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN'); open = true;
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    if (windowMin > 0 && phoneKey) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('manual_sms_same_text'), hashtext($1))`, [phoneKey]);
      let own = null;
      if (c.key) {
        const r = await client.query(`SELECT send_state AS state FROM manual_message_sends WHERE client_send_id = $1 AND participant_id = $2 LIMIT 1`,
          [c.key, String(c.participantId)]);
        own = r.rows[0] || null;
      }
      // 같은 키 줄이 있으면(확실한 실패 제외) 364 결과가 우선 — 창 판정 없이 _claim 이 dup/결과 모름/처리 중을 돌려준다.
      if (!own || own.state === 'failed') {
        const hit = await _smsWindowHit(client, { phoneKey, text: c.text, windowMin });
        if (hit) { await client.query('ROLLBACK'); open = false; return { window: { ...hit, windowMin } }; }
      }
    }
    const out = c.key
      ? await _claim(c, client)
      : { own: (await client.query(_CLAIM_NOKEY_SQL, [c.kind, c.sheetId, c.tabName, String(c.participantId), '', c.reviewerName || '',
          c.targetPhone || '', c.text || '', '', null, false, null, '', c.by || ''])).rows[0].id, fresh: true };
    await client.query('COMMIT'); open = false;
    return out;
  } catch (e) {
    if (open) await client.query('ROLLBACK').catch(() => {});
    if (e && String(e.code || '') === '55P03') return { lockBusy: true };
    throw e;
  } finally {
    client.release();
  }
}

/** 같은 키·다른 내용이 이미 있나(요청 맨 앞 · 칸이 없으면 42703 을 던져 호출부가 종전 경로로). */
async function _keyConflict(key, fp) {
  const { rows } = await pool.query(
    `SELECT 1 FROM manual_message_sends WHERE client_send_id = $1 AND client_send_fp IS DISTINCT FROM $2 LIMIT 1`, [key, fp]);
  return rows.length > 0;
}
const _CLAIM_SQL = `
  INSERT INTO manual_message_sends
    (kind, sheet_id, tab_name, participant_id, reviewer_name, target_phone, message_text, message_type,
     accepted, provider_reason, sent_by, client_send_id, client_send_fp, send_state, send_state_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,'',$9,$10,$11,'pending',NOW())
  ON CONFLICT (client_send_id, participant_id) WHERE client_send_id IS NOT NULL DO NOTHING
  RETURNING id`;
/**
 * 한 사람 선점 — { own:id, fresh } | { dup:row } | { conflict } | { busy, stale } | { unknown } | { error }
 * ★ 공급자 호출 전에만 부른다. 칸·색인 없음(42703·42P10)은 그대로 던진다(호출부가 첫 사람에서 종전 경로로 접는다).
 * ★ db = 문자는 번호 잠금 트랜잭션의 연결(_claimSmsTx · 결정 366), 알림톡은 풀.
 */
async function _claim(c, db = pool) {
  for (let tries = 0; tries < 2; tries++) {
    const ins = await db.query(_CLAIM_SQL, [c.kind, c.sheetId, c.tabName, String(c.participantId), c.reviewerName || '',
      c.targetPhone || '', c.text || '', c.type || '', c.by || '', c.key, c.fp]);
    if (ins.rows && ins.rows[0]) return { own: ins.rows[0].id, fresh: true };
    const { rows } = await db.query(
      `SELECT id, client_send_fp AS fp, send_state AS state, send_state_at AS "stateAt", message_type AS type,
              reminder_no AS "reminderNo", target_phone AS phone
         FROM manual_message_sends WHERE client_send_id = $1 AND participant_id = $2 LIMIT 1`, [c.key, String(c.participantId)]);
    const row = rows[0];
    if (!row) continue;   // 그 사이 지워진 선점(공급자까지 안 간 알림톡) — 한 번 더 선점해 본다
    if (row.fp !== c.fp) return { conflict: true };
    if (row.state === 'sent') return { dup: row };
    if (row.state === 'failed') {
      // 확실한 실패만 다시 보낸다 — 한 문장 CAS 라 동시 재시도 중 하나만 이긴다.
      const re = await db.query(
        `UPDATE manual_message_sends SET send_state='pending', send_state_at=NOW(), sent_by=$3, provider_reason=''
          WHERE id=$1 AND client_send_fp=$2 AND send_state='failed' RETURNING id`, [row.id, c.fp, c.by || '']);
      if (re.rows && re.rows[0]) return { own: re.rows[0].id, fresh: false };
      continue;
    }
    if (row.state === 'unknown') return { unknown: true };
    const age = row.stateAt ? Date.now() - new Date(row.stateAt).getTime() : Infinity;
    return { busy: true, stale: !(age < PENDING_STALE_MS) };
  }
  return { busy: true, stale: false };
}
/** 결과 적기 — 실패해도 발송 결과는 그대로(줄은 '대기'로 남아 다시 보내기가 보내지 않는다 = 안전한 쪽). */
async function _finish(id, r) {
  try {
    await pool.query(
      `UPDATE manual_message_sends
          SET send_state=$2, send_state_at=NOW(), accepted=$3,
              message_type=COALESCE(NULLIF($4,''), message_type), provider_message_id=$5, provider_reason=$6,
              message_text=COALESCE(NULLIF($7,''), message_text), reminder_no=COALESCE($8, reminder_no),
              order_submission_id=COALESCE(NULLIF($9,''), order_submission_id),
              reviewer_name=COALESCE(NULLIF($10,''), reviewer_name), target_phone=COALESCE(NULLIF($11,''), target_phone)
        WHERE id=$1`,
      [id, r.state, !!r.accepted, r.type || '', r.messageId || null, String(r.reason || ''), r.text || '',
       r.reminderNo || null, r.orderSubmissionId ? String(r.orderSubmissionId) : '', r.reviewerName || '', r.targetPhone || '']);
  } catch (e) {
    logger.warn(`[manualMessage] 발송 결과 기록 실패(발송 결과는 유지 · 그 줄은 다시 보내지 않음): ${e.message}`);
  }
}
/** 공급자까지 안 간 선점 풀기 — 이번에 넣은 줄은 지우고(종전처럼 기록 없음), 다시 선점한 실패 줄은 실패로 되돌린다. */
async function _release(claim, reason) {
  try {
    if (claim.fresh) await pool.query(`DELETE FROM manual_message_sends WHERE id=$1 AND send_state='pending'`, [claim.own]);
    else await pool.query(`UPDATE manual_message_sends SET send_state='failed', send_state_at=NOW(), provider_reason=$2
                            WHERE id=$1 AND send_state='pending'`, [claim.own, String(reason || '')]);
  } catch (e) {
    logger.warn(`[manualMessage] 발송 선점 풀기 실패(그 줄은 잠시 '처리 중'으로 보임): ${e.message}`);
  }
}
/** 선점 못 한 사람의 결과 한 줄(공급자 호출 0). */
function _claimOutcome(c, base, kind) {
  if (c.conflict) return { ...base, sent: false, code: SEND_CONFLICT, reason: KEY_MSG.conflict };
  if (c.unknown || (c.busy && c.stale)) return { ...base, sent: false, code: SEND_UNKNOWN, reason: kind === 'sms' ? KEY_MSG.smsUnknown : KEY_MSG.ataUnknown };
  if (c.busy) return { ...base, sent: false, code: SEND_IN_PROGRESS, reason: KEY_MSG.inProgress };
  return { ...base, sent: false, reason: KEY_MSG.claimFailed };
}
/** 키 경로 입구 — { key, fp } | null(키 없음) · 같은 키·다른 내용이면 { conflict } · 칸 없으면 null(종전 경로). */
async function _keyGate({ clientSendId, kind, sheetId, tabName, text, by }) {
  const key = normalizeCsClientMsgId(clientSendId);
  if (!key) return null;
  const fp = _sendFp({ kind, sheetId, tabName, text, by });
  try {
    if (await _keyConflict(key, fp)) return { conflict: true };
  } catch (e) {
    if (_schemaGap(e)) { logger.warn(`[manualMessage] 다시 보내기 키 칸 없음(migration 222 전) — 종전 경로: ${e.code}`); return null; }
    throw e;
  }
  return { key, fp };
}
class _SchemaGapFallback extends Error {}

async function sendManualSms({ sheetId, tabName, ids, text, by, clientSendId }) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '보낼 내용을 입력하세요' };
  const full = composeSms(body);
  if (solapi.smsBytes(full) > TEXT_MAX_BYTES) return { ok: false, error: '내용이 너무 깁니다(안내 문구 포함 2000바이트까지)' };
  if (!solapi.getSolapiStatus().configured) return { ok: false, error: '문자 발송 설정이 비어 있습니다' };
  const gate = await _keyGate({ clientSendId, kind: 'sms', sheetId, tabName, text: body, by });
  if (gate && gate.conflict) return { ok: false, code: SEND_CONFLICT, error: KEY_MSG.conflict };
  // ★ 결정 366 — 키가 있든 없든 선점 경로(번호 잠금 · 같은 번호·같은 글 창 판정 · 공급자 전 '대기' 줄).
  //   키 없음(구버전 화면) = key null → 키 판정만 빠지고 창 판정·동시 보호는 같다.
  try { return await _sendManualSmsKeyed({ sheetId, tabName, ids, body, full, by, key: gate ? gate.key : null, fp: gate ? gate.fp : null }); }
  catch (e) { if (!(e instanceof _SchemaGapFallback)) throw e; logger.warn(`[manualMessage] 발송 선점 색인 없음 — 종전 경로(같은 글 막기 없음): ${e.message}`); }
  return _sendManualSmsLegacy({ sheetId, tabName, ids, body, full, by });
}

/* 문자 — 종전 경로(발송 뒤 기록). ★ 이제는 마이그레이션 222 전 DB(칸·색인 없음 · 42703/42P10)에서만 탄다 —
   그때는 같은 글 막기(결정 366)·다시 보내기 키(364)가 빠지고 보내기만 살린다. */
async function _sendManualSmsLegacy({ sheetId, tabName, ids, body, full, by }) {
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

/* 문자 — 선점 경로(키 있음 = 결정 364 · 키 없음 = key null). 받는 사람 판정·같은 번호 한 번·문의방 기록·결과 모양은
   종전 경로와 같다(+ duplicate · code).
   ★ 사람마다 「선점(번호 잠금 · 같은 글 창 판정 · 결정 366) → 공급자 → 결과 적기」. 선점 못 한 사람에게는 공급자를 부르지 않는다.
   ★ 키 없음의 결과 문구는 종전과 같다(구버전 화면 · 결과 모름도 「문자 발송 실패 — 사유」). */
async function _sendManualSmsKeyed({ sheetId, tabName, ids, body, full, by, key, fp }) {
  const { items } = await previewManualSend({ sheetId, tabName, ids, withBilling: false });
  const results = [];
  const seen = new Map();
  let calls = 0;
  for (const it of items) {
    const base = { participantId: it.participantId, rowName: it.rowName || '' };
    if (!it.sms.ok) { results.push({ ...base, sent: false, reason: it.sms.reason }); continue; }
    const phoneKey = smsPhoneKey(it.sms.phone) || it.sms.phone;
    if (seen.has(phoneKey)) { results.push({ ...base, sent: false, merged: true, reason: '같은 번호에 이미 보냈습니다(한 번만 발송)' }); continue; }
    seen.set(phoneKey, true);
    let c;
    try {
      c = await _claimSmsTx({ kind: 'sms', sheetId, tabName, participantId: it.participantId, reviewerName: it.sms.name,
        targetPhone: it.sms.phone, text: full, by, key, fp });
    } catch (e) {
      if (_schemaGap(e) && calls === 0 && !results.some(r => r.sent || r.code)) throw new _SchemaGapFallback(e.code);
      logger.warn(`[manualMessage] 문자 발송 선점 실패(보내지 않음): ${e.message}`);
      c = { error: true };
    }
    const who = { ...base, name: it.sms.name, phone: it.sms.phone };
    if (c.window) {
      results.push({ ...who, sent: false, code: SMS_SAME_TEXT, reason: smsWindowReason(c.window) });
      continue;
    }
    if (c.lockBusy) { results.push({ ...who, sent: false, code: SMS_BUSY, reason: SMS_BUSY_MSG }); continue; }
    if (c.dup) {
      results.push({ ...who, sent: true, duplicate: true, type: c.dup.type || undefined, reason: '' });
      continue;
    }
    if (!c.own) { results.push({ ...who, ..._claimOutcome(c, {}, 'sms') }); continue; }
    calls++;
    let out, state;
    try {
      out = await solapi.sendSms({ to: it.sms.phone, text: full, subject: 'IA리뷰 안내',
        customFields: { participantId: String(it.participantId), kind: 'manual_sms' } });
      state = out.accepted ? 'sent' : 'failed';
    } catch (e) {
      out = { accepted: false, reason: e.code || e.message || '발송 실패' };
      state = _smsErrorUncertain(e) ? 'unknown' : 'failed';
    }
    let roomOk = false;
    if (out.accepted) {
      try {
        const r = await csBridge.postAdminNotice({ sheetId, tabName, rowIndex: it.seq,
          reviewerName: it.sms.name || it.rowName, phone8: it.sms.phone8, message: body, by });
        roomOk = !!r;
      } catch (_) { roomOk = false; }
    }
    await _finish(c.own, { state, accepted: out.accepted, type: out.type, messageId: out.messageId,
      reason: state === 'unknown' ? `UNCERTAIN:${out.reason || ''}` : out.reason, reviewerName: it.sms.name, targetPhone: it.sms.phone });
    if (state === 'unknown' && key) {
      results.push({ ...who, sent: false, code: SEND_UNKNOWN, reason: KEY_MSG.smsUnknown });
      continue;
    }
    results.push({ ...who, sent: !!out.accepted, type: out.type,
      roomOk, reason: out.accepted ? '' : `문자 발송 실패 — ${out.reason || '사유 없음'}` });
  }
  return { ok: results.some(r => r.sent), results };
}

/* 알림톡 — 키 경로. 선점한 줄만 reminder.sendManual 에 넘긴다(회차·원장·종결 흐름은 종전 sendOne 그대로).
   ★ 이게 없으면: 첫 알림톡이 빨리 도착 확인된 뒤 다시 보내기가 **다음 회차를 바로** 보낸다(날짜 전 앞당김 허용 규칙). */
async function _sendManualAlimtalkKeyed({ sheetId, tabName, want, cps, by, key, fp }) {
  const slots = [];
  const own = new Map();   // seq → { claim, participantId, rowName, slot }
  const done = new Set();
  for (const id of want) {
    const cp = cps.find(c => c.id === id);
    if (!cp) { slots.push({ participantId: id, sent: false, reason: '표에 없는 줄입니다' }); continue; }
    if (done.has(Number(cp.seq))) { slots.push({ participantId: id, rowName: cp.rowName, sent: false, reason: '같은 줄 — 한 번만 발송' }); continue; }
    done.add(Number(cp.seq));
    let c;
    try {
      c = await _claim({ kind: 'alimtalk', sheetId, tabName, participantId: id, reviewerName: cp.rowName, by, key, fp });
    } catch (e) {
      if (_schemaGap(e) && !own.size && !slots.some(r => r.sent || r.code)) throw new _SchemaGapFallback(e.code);
      logger.warn(`[manualMessage] 알림톡 발송 선점 실패(보내지 않음): ${e.message}`);
      c = { error: true };
    }
    const base = { participantId: id, rowName: cp.rowName };
    if (c.dup) {
      slots.push({ ...base, sent: true, duplicate: true, reminderNo: c.dup.reminderNo || undefined,
        phoneTail: c.dup.phone ? String(c.dup.phone).slice(-4) : undefined, reason: '' });
      continue;
    }
    if (!c.own) { slots.push(_claimOutcome(c, base, 'alimtalk')); continue; }
    const slot = { ...base, sent: false, reason: '결과가 없습니다' };
    slots.push(slot);
    own.set(Number(cp.seq), { claim: c, slot });
  }
  let out = { ok: true, results: [] };
  if (own.size) {
    // ★ 던지면(DB 오류 등) 선점 줄은 '대기'로 둔다 — 공급자까지 갔는지 모르므로 다시 보내기가 또 보내지 않게(안전한 쪽).
    out = await reminder.sendManual({ sheetId, tabName, rowIndexes: [...own.keys()] });
  }
  const bySeq = new Map((out.results || []).map(r => [Number(r.rowIndex), r]));
  for (const [seq, o] of own) {
    const r = bySeq.get(seq) || { sent: false, reason: '결과가 없습니다' };
    const accepted = !!(r.sent && r.accepted);
    if (!r.sent) {
      await _release(o.claim, r.reason);
      Object.assign(o.slot, { sent: false, reminderNo: r.reminderNo, phoneTail: r.phoneTail, reason: SEND_REASON[r.reason] || r.reason || '보내지 못했습니다' });
      continue;
    }
    const state = accepted ? 'sent' : (r.uncertain ? 'unknown' : 'failed');
    await _finish(o.claim.own, { state, accepted, type: 'ATA', text: `리뷰미작성_${r.reminderNo}차`, reminderNo: r.reminderNo,
      orderSubmissionId: r.orderSubmissionId, reviewerName: r.reviewerName || o.slot.rowName, targetPhone: r.targetPhone,
      reason: state === 'unknown' ? `UNCERTAIN:${r.reason || ''}` : r.reason });
    if (state === 'unknown') { Object.assign(o.slot, { sent: false, reminderNo: r.reminderNo, phoneTail: r.phoneTail, code: SEND_UNKNOWN, reason: KEY_MSG.ataUnknown }); continue; }
    Object.assign(o.slot, { sent: accepted, reminderNo: r.reminderNo, phoneTail: r.phoneTail,
      reason: accepted ? '' : (SEND_REASON[r.reason] || r.reason || '보내지 못했습니다') });
  }
  return { ok: slots.some(r => r.sent), error: out.ok === false ? out.error : undefined, results: slots };
}

async function sendManualAlimtalk({ sheetId, tabName, ids, by, clientSendId }) {
  if (!solapi.getSolapiStatus().configured) return { ok: false, error: '알림톡 발송 설정이 비어 있습니다' };
  const gate = await _keyGate({ clientSendId, kind: 'alimtalk', sheetId, tabName, text: '', by });
  if (gate && gate.conflict) return { ok: false, code: SEND_CONFLICT, error: KEY_MSG.conflict };
  const want = _ids(ids);
  if (gate) {
    const cpsK = await _participants(sheetId, tabName, want);
    try { return await _sendManualAlimtalkKeyed({ sheetId, tabName, want, cps: cpsK, by, ...gate }); }
    catch (e) { if (!(e instanceof _SchemaGapFallback)) throw e; logger.warn(`[manualMessage] 발송 선점 색인 없음 — 종전 경로: ${e.message}`); }
  }
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
   ★ 한글 6자(12바이트) 이내만 인정한다 — 넘으면 단문 문안이 장문이 된다(그때는 추천 없음). */
const SHORT_MAX_BYTES = 12;   // 한글 6자 — 가장 긴 문안(74바이트)+12 = 86 ≤ 90, 줄바꿈을 2바이트로 세는 경우까지 여유
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
/* ★ 읽기 실패와 "없음"을 구분한다 — 실패를 없음으로 접으면 AI 추천이 직원이 정한 이름을 덮는다(fail-closed) */
async function _readShort(sheetId, tabName) {
  try {
    const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [_shortKey(sheetId, tabName)]);
    return { ok: true, val: rows[0] ? JSON.parse(rows[0].value) : null };
  } catch (_) { return { ok: false, val: null }; }
}
/* ★ AI 추천 저장은 직원이 정한 이름(manual)이 없을 때만 — 늦게 끝난 추천이 방금 저장된 직원 이름을 덮지 않게 */
async function _writeShort(sheetId, tabName, val, { keepManual = false } = {}) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()` +
    (keepManual ? ` WHERE COALESCE(app_settings.value::jsonb->>'source', '') <> 'manual'` : ''),
    [_shortKey(sheetId, tabName), JSON.stringify(val)]);
}
/* ★ 추천은 원문(상품명·작업 이름)의 조각으로만 이뤄져야 한다 — 2글자 이상 조각들로 이어 붙일 수 있는지 본다.
   AI 가 예시(유산균·탈취제)를 되뇌거나 지어낸 이름은 버린다. */
function derivedFromSource(name, source) {
  const n = String(name || ''), src = String(source || '').replace(/\s+/g, '').toLowerCase();
  if (!n || !src) return false;
  const low = n.toLowerCase(), ok = new Array(low.length + 1).fill(false); ok[0] = true;
  for (let i = 0; i < low.length; i++) {
    if (!ok[i]) continue;
    for (let j = i + 2; j <= low.length; j++) if (src.includes(low.slice(i, j))) ok[j] = true;
  }
  return ok[low.length];
}
async function productShortName({ sheetId, tabName, productName, taskName, suggest }) {
  if (!sheetId || !tabName) return { name: '', source: 'none' };
  const rd = await _readShort(sheetId, tabName);
  if (!rd.ok) return { name: '', source: 'none' };
  const saved = rd.val;
  if (saved && saved.source === 'manual' && normalizeShortName(saved.name)) return { name: saved.name, source: 'manual' };
  const task = String(taskName || '').trim().slice(0, 120);
  const from = [_cleanProductSource(productName), task].filter(Boolean).join(' | ');
  if (!from) return { name: '', source: 'none' };
  if (saved && saved.source === 'ai' && saved.from === from && normalizeShortName(saved.name)) return { name: saved.name, source: 'ai' };
  const ask = suggest || require('./gemini.service').suggestShortProductName;
  const name = normalizeShortName(await ask(_cleanProductSource(productName), task));
  if (!name || !derivedFromSource(name, from)) return { name: '', source: 'none' };
  try { await _writeShort(sheetId, tabName, { name, source: 'ai', from, at: new Date().toISOString() }, { keepManual: true }); }
  catch (e) { logger.warn(`[manualMessage] 추천 상품명 저장 실패(추천은 유지): ${e.message}`); }
  return { name, source: 'ai' };
}
async function saveShortName({ sheetId, tabName, name, by }) {
  const n = normalizeShortName(name);
  if (!sheetId || !tabName || !n) return { ok: false, error: '상품명은 한글 6자(12바이트) 이내로 넣어 주세요' };
  await _writeShort(sheetId, tabName, { name: n, source: 'manual', by: String(by || ''), at: new Date().toISOString() });
  return { ok: true, name: n };
}

module.exports = { SMS_SAME_TEXT, SMS_BUSY, SMS_WINDOW_ENV, SMS_WINDOW_DEFAULT_MIN, smsSameTextWindowMin, smsWindowReason, smsTextKey, smsPhoneKey, SMS_BUSY_MSG, SEND_CONFLICT, SEND_IN_PROGRESS, SEND_UNKNOWN, PENDING_STALE_MS, productShortName, saveShortName, normalizeShortName, derivedFromSource, cleanProductSource: _cleanProductSource, SHORT_MAX_BYTES, previewManualSend, sendManualSms, sendManualAlimtalk, composeSms, smsFooter, homeLink, homeHost, hasHomeLink, MAX_ROWS };
