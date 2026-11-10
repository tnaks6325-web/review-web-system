/**
 * 1:1문의 다시 보내기 키(clientMsgId) — 단일 출처(결정 361 · 362 · migration 221).
 *
 * 화면이 쓴 글 하나마다 키를 만들어, 같은 글을 다시 보낼 때마다 같은 키를 싣는다.
 * 서버는 (문의방, 키) 로 한 번만 저장한다(부분 유일 색인 uq_cs_messages_thread_client_msg).
 *
 * ★ 키 모양 = `^[A-Za-z0-9_-]{16,100}$`. 틀리면 '' (= 키 없음 → 종전 경로, 구버전 화면과 같다).
 * ★ 직원(관리자·AE) 쪽 저장 값은 `staff:` 를 앞에 붙인다(결정 362).
 *   리뷰어 키 모양에는 `:` 가 들어갈 수 없으므로 두 쪽 키는 **만드는 방식만으로 절대 겹치지 않는다**
 *   — 같은 문의방 안에서 리뷰어 키와 직원 키가 우연히(또는 일부러) 같아도 서로의 메시지를
 *   「이미 저장됨」으로 돌려주지 않는다. 화면이 보내는 키 모양은 두 쪽이 같다(서버만 접두를 붙인다).
 */
const CS_CLIENT_MSG_ID_RE = /^[A-Za-z0-9_-]{16,100}$/;
const STAFF_KEY_PREFIX = 'staff:';

function normalizeCsClientMsgId(v) {
  const s = (v == null ? '' : v).toString().trim();
  return CS_CLIENT_MSG_ID_RE.test(s) ? s : '';
}

/** 직원 쪽 저장 키 — 모양이 틀리면 ''(키 없음). */
function staffCsClientMsgKey(v) {
  const k = normalizeCsClientMsgId(v);
  return k ? STAFF_KEY_PREFIX + k : '';
}

/** 저장된 메시지와 이번 요청의 글·사진이 같은가(같은 키·다른 내용 = 409 판정의 근거). */
function sameCsPayload(row, content, imageUrls) {
  const urls = Array.isArray(row && row.imageUrls) ? row.imageUrls : [];
  return String((row && row.content) || '') === String(content || '')
    && JSON.stringify(urls) === JSON.stringify(Array.isArray(imageUrls) ? imageUrls : []);
}

/** 직원 쪽: 같은 키로 저장된 메시지가 「이 직원이 보낸 같은 글」인가.
 *  역할(admin)·보낸 사람(로그인명)·글 종류(text)·글·사진이 모두 같아야 한다 — 하나라도 다르면 409. */
function sameStaffCsMessage(row, { senderName, content, imageUrls }) {
  return !!row
    && row.senderRole === 'admin'
    && String(row.senderName || '') === String(senderName || '')
    && String(row.msgType || 'text') === 'text'
    && sameCsPayload(row, content, imageUrls);
}

/** (문의방, 저장 키) 로 찾기 — 역할을 거르지 않고 찾은 뒤 위 비교로 판정한다(겹치면 409, 조용히 새로 넣지 않음). */
const CS_FIND_STAFF_BY_KEY_SQL =
  `SELECT id, sender_role AS "senderRole", sender_name AS "senderName", content,
          image_urls AS "imageUrls", msg_type AS "msgType", created_at AS "createdAt"
     FROM cs_messages
    WHERE thread_id = $1 AND client_msg_id = $2
    LIMIT 1`;

const CS_CLIENT_MSG_CONFLICT = 'cs_client_msg_conflict';

module.exports = {
  CS_CLIENT_MSG_ID_RE,
  STAFF_KEY_PREFIX,
  CS_CLIENT_MSG_CONFLICT,
  CS_FIND_STAFF_BY_KEY_SQL,
  normalizeCsClientMsgId,
  staffCsClientMsgKey,
  sameCsPayload,
  sameStaffCsMessage,
};
