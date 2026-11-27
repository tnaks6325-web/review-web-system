/**
 * 계산서 미발행 → 인트라넷 계산서 발행 창 (결정 428 · 사용자 확정 2026-11-25)
 *   - 내부 직원 · 계약 매칭 · 조회 성공 · 미발행이면 [계산서] 칸을 누를 수 있고, 누르면 인트라넷 발행 입구가 새 탭으로 열린다.
 *   - 견적서가 없어도 누른다(인트라넷이 발행 직후 같은 내용으로 견적서를 만들어 붙인다) — 설명으로 알린다.
 *   - 일부 발행은 종전처럼 발행 이력 카드 + 카드 아래 [인트라넷에서 이어서 발행].
 *   - 업체(광고주) 화면 · 계약 없음 · 조회 실패 · 발행 완료 · 이상한 salesId 는 주소를 만들지 않는다.
 * 실행: node tests/settlementInvoiceIssueLink.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WD = fs.readFileSync(process.env.WD_FILE || path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓ ' + m); };
function grab(name) {
  const m = new RegExp('\\n(?:async )?function ' + name + '\\s*\\(').exec(WD);
  if (!m) return '';
  const st = WD.indexOf('{', m.index + name.length + 10);
  let d = 0, i = st;
  for (; i < WD.length; i++) { const c = WD[i]; if (c === '{') d++; else if (c === '}') { d--; if (!d) break; } }
  return WD.slice(m.index, i + 1) + '\n';
}

const opened = [], docs = [];
const box = {
  STATE: { role: 'staff', settle: null },
  esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  window: { open: (u, t, f) => opened.push({ u, t, f }) },
  confirms: [], confirmAnswer: true, confirm: (m) => { box.confirms.push(m); return box.confirmAnswer; },
  awDocOpen: (ev, kind) => docs.push(kind), openSettlementPayment: () => {}, _openSettlementPaymentFor: () => {}, _homeSetlCtx: () => null,
};
vm.createContext(box);
vm.runInContext(['_setlPayState', '_awMD', '_manWon', '_shareBadge', '_wonFmt', 'setlSummaryHtml', '_setlIssueInvoiceUrl', '_setlInvoiceIssueOpen', 'openSettlementDocument', '_idocIssueMore'].map(grab).join(''), box);

const NOINV = { linked: true, salesId: 'sal_ABC-1', quote: { quoteNumber: 'Q-1', quoteDate: '2026-11-10' }, invoice: { status: 'not_issued' }, totalCost: 5000000, paidAmount: 0 };
const invBtn = h => (h.match(/<button[^>]*onclick="openSettlementDocument\(event,'invoice'\)"[^>]*>/) || [''])[0];

console.log('A. 버튼');
let b = invBtn(box.setlSummaryHtml(NOINV));
ok(b && !/disabled/.test(b) && /class="tp3doc[^"]* issue"/.test(b), '★ 미발행 계약의 [계산서] 칸은 누를 수 있다(흰 칸 issue — 회색 비활성 아님)');
ok(/인트라넷에서 세금계산서 발행 창을 엽니다/.test(b), '설명: 인트라넷 발행 창을 연다 · 발행은 직접');
b = invBtn(box.setlSummaryHtml({ ...NOINV, quote: null }));
ok(!/disabled/.test(b) && /견적서 없음 — 발행하면 같은 내용으로 견적서가 자동 생성됩니다/.test(b), '★ 견적서가 없어도 누를 수 있고, 자동 생성된다고 알린다');
ok(/disabled/.test(invBtn(box.setlSummaryHtml({ ...NOINV, proxyDown: true, invoice: null }))) === false
  && !/ issue"/.test(invBtn(box.setlSummaryHtml({ ...NOINV, proxyDown: true, invoice: null }))), '조회 실패는 종전 주황 「확인 필요」(발행 입구 아님)');
ok(/disabled/.test(invBtn(box.setlSummaryHtml({ linked: false }))), '계약이 없으면 종전처럼 회색');
ok(!/ issue"/.test(invBtn(box.setlSummaryHtml({ ...NOINV, invoice: { status: 'issued', date: '2026-11-20' } }))), '발행 완료는 종전 파란 칸(발행 입구 아님)');
box.STATE.role = 'advertiser';
ok(/disabled/.test(invBtn(box.setlSummaryHtml(NOINV))) && !/ issue"/.test(invBtn(box.setlSummaryHtml(NOINV))), '★ 업체(광고주) 화면에는 발행 입구를 열지 않는다(종전 회색)');
box.STATE.role = 'staff';

console.log('B. 주소');
ok(box._setlIssueInvoiceUrl(NOINV) === 'https://inadd-system.pages.dev/?issue_invoice=sal_ABC-1', '주소 = 두 저장소 약속 그대로(?issue_invoice=<salesId>)');
ok(box._setlIssueInvoiceUrl({ ...NOINV, salesId: 'x"><script>' }) === '' && box._setlIssueInvoiceUrl({ ...NOINV, salesId: '' }) === '', '이상한·빈 salesId 는 주소를 만들지 않는다');
ok(box._setlIssueInvoiceUrl({ ...NOINV, hidden: true }) === '', '정산 비공개(hidden)는 주소 없음');

console.log('C. 누르기');
box.STATE.settle = { data: NOINV, tab: { tabName: 'T' } };
const ev = { stopPropagation() {}, preventDefault() {}, target: { closest: () => null } };
box.openSettlementDocument(ev, 'invoice');
ok(opened.length === 1 && opened[0].u === 'https://inadd-system.pages.dev/?issue_invoice=sal_ABC-1' && opened[0].t === '_blank' && /noopener/.test(opened[0].f || ''),
  '★ 미발행 [계산서] 를 누르면 인트라넷 발행 입구가 새 탭으로 열린다(noopener)');
ok(docs.length === 0, '미발행이면 빈 발행 이력 카드를 띄우지 않는다');
ok(box.confirms.length === 0, '견적서가 있으면 묻지 않고 바로 연다');
box.STATE.settle = { data: { ...NOINV, quote: null }, tab: { tabName: 'T' } };
box.confirmAnswer = false;
box.openSettlementDocument(ev, 'invoice');
ok(box.confirms.length === 1 && /견적서가 없습니다[\s\S]*자동으로 만들어져 계약에 연결됩니다/.test(box.confirms[0]) && opened.length === 1 && docs.length === 0,
  '★ 견적서가 없으면 「자동으로 만들어진다」고 먼저 묻고, 취소하면 아무것도 열지 않는다(휴대폰엔 마우스 설명이 없다)');
box.confirmAnswer = true;
box.openSettlementDocument(ev, 'invoice');
ok(opened.length === 2, '확인하면 인트라넷 발행 창을 연다');
opened.pop();
const PART = { ...NOINV, invoice: { status: 'partial', issuedAmount: 2000000, targetAmount: 5000000 } };
box.STATE.settle = { data: PART, tab: { tabName: 'T' } };
box.openSettlementDocument(ev, 'invoice');
ok(opened.length === 1 && docs.join() === 'invoice', '일부 발행은 종전처럼 발행 이력 카드를 연다');
ok(/href="https:\/\/inadd-system\.pages\.dev\/\?issue_invoice=sal_ABC-1"[^>]*target="_blank"[^>]*rel="noopener">인트라넷에서 이어서 발행/.test(box._idocIssueMore(PART)),
  '일부 발행 카드 아래 [인트라넷에서 이어서 발행]');
ok(box._idocIssueMore(NOINV) === '' && box._idocIssueMore({ ...NOINV, invoice: { status: 'issued' } }) === '', '미발행·발행 완료 카드에는 그 줄을 붙이지 않는다');
box.STATE.settle = { data: { ...NOINV, invoice: { status: 'issued' } }, tab: { tabName: 'T' } };
box.openSettlementDocument(ev, 'invoice');
ok(opened.length === 1 && docs.length === 2, '발행 완료는 종전처럼 발행 이력 카드');

console.log(`\nsettlementInvoiceIssueLink: ${pass} passed`);
