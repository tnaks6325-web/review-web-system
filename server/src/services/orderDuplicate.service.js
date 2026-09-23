// 구매양식 당일 중복 차단: 표시 형식만 다른 같은 제출을 같은 값으로 비교한다.
// 이 규칙은 제출 전에만 쓰며, 원장에 남은 과거 데이터는 변경하지 않는다.

function _text(value) { return String(value == null ? '' : value).replace(/\s+/gu, ''); }
function _digits(value) { return String(value == null ? '' : value).replace(/\D/g, ''); }

function normalizeSameDayOrder(order = {}) {
  return {
    orderer: _text(order.orderer),
    recipient: _text(order.recipient),
    userId: _text(order.userId ?? order.user_id),
    phone: _digits(order.phone),
    address: _text(order.address),
    bank: _text(order.bank),
    account: _digits(order.account),
    depositor: _text(order.depositor),
    price: _digits(order.price),
    dateStr: _text(order.dateStr ?? order.date_str),
    orderNum: _digits(order.orderNum ?? order.order_num),
    memo: _text(order.memo),
    selectedOptKey: _text(order.selectedOptKey ?? order.selected_opt_key),
    blogUrl: _text(order.blogUrl ?? order.blog_url),
  };
}

function isSameDayOrderDuplicate(left, right) {
  const a = normalizeSameDayOrder(left);
  const b = normalizeSameDayOrder(right);
  return Object.keys(a).every(key => a[key] === b[key]);
}

function sameDayDuplicateLockKey({ sheetId, tabName, campaignId, orderData } = {}) {
  return `same-day-order:${campaignId || `${sheetId || ''}\t${tabName || ''}`}:${JSON.stringify(normalizeSameDayOrder(orderData))}`;
}

// 동일 요청 두 건이 동시에 들어와도 orderLedger 트랜잭션 안의 advisory lock 뒤에서 이 조회를 한다.
async function findSameDayDuplicateInTx(client, { sheetId, tabName, campaignId, orderData } = {}) {
  const v = normalizeSameDayOrder(orderData);
  const params = [String(sheetId || ''), String(tabName || '')];
  const param = value => { params.push(value); return `$${params.length}`; };
  const scope = campaignId
    ? ` AND EXISTS (
          SELECT 1 FROM campaign_applications ca
           WHERE ca.campaign_id = ${param(String(campaignId))}
             AND (ca.order_submission_id = os.id OR ca.late_order_id = os.id)
        )`
    : '';
  const equal = (sql, value) => `${sql} = ${param(value)}`;
  const where = [
    `os.sheet_id = $1`,
    `os.tab_name = $2`,
    `os.deleted_at IS NULL`,
    `(os.submitted_at AT TIME ZONE 'Asia/Seoul')::date = (NOW() AT TIME ZONE 'Asia/Seoul')::date`,
    equal(`regexp_replace(COALESCE(os.orderer,''), '\\s+', '', 'g')`, v.orderer),
    equal(`regexp_replace(COALESCE(os.recipient,''), '\\s+', '', 'g')`, v.recipient),
    equal(`regexp_replace(COALESCE(os.user_id,''), '\\s+', '', 'g')`, v.userId),
    equal(`regexp_replace(COALESCE(os.phone,''), '\\D', '', 'g')`, v.phone),
    equal(`regexp_replace(COALESCE(os.address,''), '\\s+', '', 'g')`, v.address),
    equal(`regexp_replace(COALESCE(os.bank,''), '\\s+', '', 'g')`, v.bank),
    equal(`regexp_replace(COALESCE(os.account,''), '\\D', '', 'g')`, v.account),
    equal(`regexp_replace(COALESCE(os.depositor,''), '\\s+', '', 'g')`, v.depositor),
    equal(`regexp_replace(COALESCE(os.price,''), '\\D', '', 'g')`, v.price),
    equal(`regexp_replace(COALESCE(os.date_str,''), '\\s+', '', 'g')`, v.dateStr),
    equal(`regexp_replace(COALESCE(os.order_num,''), '\\D', '', 'g')`, v.orderNum),
    equal(`regexp_replace(COALESCE(os.memo,''), '\\s+', '', 'g')`, v.memo),
    equal(`regexp_replace(COALESCE(os.selected_opt_key,''), '\\s+', '', 'g')`, v.selectedOptKey),
    equal(`regexp_replace(COALESCE(os.blog_url,''), '\\s+', '', 'g')`, v.blogUrl),
  ];
  const { rows } = await client.query(
    `SELECT os.id FROM order_submissions os WHERE ${where.join(' AND ')}${scope}
      ORDER BY os.submitted_at DESC LIMIT 1`,
    params,
  );
  return rows[0] || null;
}

// ★★ 날짜를 넘는 같은 구매 차단(무시트 경로 전용, 2026-08-19).
//   시트 경로에는 `sheet_row_claims` 의 `(sheet_id,tab_name,dedup_key)` 유니크가 최종 수렴점으로 남아
//   있지만, 무시트 경로는 그 계층을 건너뛴다(`skipSheetMirror`). 그래서 "어제 낸 것과 같은 주문이
//   오늘 다시" 들어오면 새 주문원장 행 → 새 작업보드 줄이 됐다.
//   ★ 판정 키를 **전 필드 완전일치가 아니라 4개**(주문번호·연락처·수취인·결제금액)로 잡는 이유:
//     메모·옵션 표기 한 글자 차이로 뚫리면 막는 의미가 없다. 반대로 이 4개가 같은데 다른 구매인
//     경우는 실무상 없다.
//   ★ 주문번호가 6자리 미만(비번호 쿠팡 등)이면 판정하지 않는다 — 모르면 막지 않는다(fail-open).
async function findEquivalentOrderInTx(client, { sheetId, tabName, campaignId, orderData } = {}) {
  const v = normalizeSameDayOrder(orderData);
  if (!v.orderNum || v.orderNum.length < 6) return null;
  const params = [String(sheetId || ''), String(tabName || '')];
  const param = value => { params.push(value); return `$${params.length}`; };
  const scope = campaignId
    ? ` AND EXISTS (
          SELECT 1 FROM campaign_applications ca
           WHERE ca.campaign_id = ${param(String(campaignId))}
             AND (ca.order_submission_id = os.id OR ca.late_order_id = os.id)
        )`
    : '';
  const equal = (sql, value) => `${sql} = ${param(value)}`;
  const where = [
    `os.sheet_id = $1`,
    `os.tab_name = $2`,
    `os.deleted_at IS NULL`,
    equal(`regexp_replace(COALESCE(os.order_num,''), '\\D', '', 'g')`, v.orderNum),
    equal(`regexp_replace(COALESCE(os.phone,''), '\\D', '', 'g')`, v.phone),
    equal(`regexp_replace(COALESCE(os.recipient,''), '\\s+', '', 'g')`, v.recipient),
    equal(`regexp_replace(COALESCE(os.price,''), '\\D', '', 'g')`, v.price),
  ];
  const { rows } = await client.query(
    `SELECT os.id FROM order_submissions os WHERE ${where.join(' AND ')}${scope}
      ORDER BY os.submitted_at DESC LIMIT 1`,
    params,
  );
  return rows[0] || null;
}

module.exports = {
  findEquivalentOrderInTx,
  normalizeSameDayOrder,
  isSameDayOrderDuplicate,
  sameDayDuplicateLockKey,
  findSameDayDuplicateInTx,
};
