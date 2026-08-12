/**
 * Final runtime editor layout regression guard.
 *
 * The approved compact-row mockup must be the actual shared modal, not only a
 * standalone HTML artifact. This check protects all field IDs used by the
 * prefill/save path while asserting the approved information architecture.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const modal = fs.readFileSync(path.join(root, 'frontend', 'js', 'recruit-modal.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, 'frontend', 'workdesk.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'frontend', 'admin.html'), 'utf8');

function mustContain(fragment, message) {
  assert(modal.includes(fragment), message);
}

function mustNotContain(fragment, message) {
  assert(!modal.includes(fragment), message);
}

assert(/class="modal-box rf-box"[^>]*max-width:1020px/.test(modal),
  'The final desktop modal must use the approved 1020px width.');

mustContain('class="rf-step-list"', 'The left rail list must exist.');
['link', 'prod', 'cond'].forEach((step) => {
  mustContain(`data-rf-step="${step}"`, `The ${step} rail step must exist.`);
});
['fee', 'work'].forEach((step) => {
  mustNotContain(`data-rf-step="${step}"`, `${step} must not remain a separate rail step.`);
});
mustContain('진행상품 · 상품 정보', 'Product and product information must share one rail step.');
mustNotContain('onclick="RecruitModal.preset', 'The rail must not expose per-user layout presets.');
mustNotContain('class="rf-rhnd"', 'The rail must not render drag handles.');

mustNotContain('data-sec="info"', 'Product information must remain part of the product section.');
assert(modal.indexOf('data-sec="prod"') < modal.indexOf('id="rf_review_type"'),
  'Product settings must continue after the product rows.');
mustContain('rf-linked-subsection', 'Merged fee and work sub-sections must remain styled as continuous rows.');
mustContain("if (act === 'pub' || act === 'fee') act = 'link'", 'Fee scrolling must select the connection rail step.');
mustContain("if (act === 'work') act = 'prod'", 'Work scrolling must select the product rail step.');

mustContain('id="rf_status_buttons"', 'Status controls must remain adjacent to the title.');
['draft', 'active', 'closed'].forEach((status) => {
  mustContain(`data-rf-status="${status}"`, `The ${status} status button must remain.`);
});
mustContain('id="rf_status"', 'The legacy status field must remain for the save contract.');

mustContain('id="rf_side_audit"', 'Automatic checks must stay at the bottom of the left rail.');
assert(modal.indexOf('id="rf_side_audit"') < modal.indexOf('class="rf-main"'),
  'Automatic checks must be outside the editor content.');

['rf-opt-url', 'rf_skip_weekends', 'rf_free_time_toggle', 'rf_cash_receipt_required', 'rf_fee_sched_on',
  'rf_wd_inflow', 'rf_wd_review', 'rf_wd_notes', 'rf_ig_inflow', 'rf_ig_review', 'rf_ig_notes']
  .forEach((id) => mustContain(id, `The ${id} runtime control must remain connected.`));

['workdesk', 'admin'].forEach((surface) => {
  const html = surface === 'workdesk' ? workdesk : admin;
  assert(html.includes('js/recruit-modal.js?v=20260812-recruit-parity-v1'), `${surface} should request the parity modal asset.`);
  assert(html.includes('js/index-recruit.js?v=20260812-recruit-ui'), `${surface} should request the released controller asset.`);
});

console.log('recruitModalFinalRuntimeLayout: passed');
