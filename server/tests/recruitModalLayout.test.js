/**
 * Shared recruitment editor runtime layout guard.
 *
 * Protects the approved compact-row editor from drifting back to the earlier
 * five-step or draggable-card layout.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const modal = read('frontend/js/recruit-modal.js');
const editor = read('frontend/js/index-recruit.js');

function ok(label, condition) {
  assert(condition, label);
  console.log(`  OK ${label}`);
}

function cssOf(name) {
  const start = modal.indexOf(`var ${name} = \``);
  assert(start >= 0, `${name} CSS was not found.`);
  const from = start + (`var ${name} = \``).length;
  const end = modal.indexOf('`;', from);
  assert(end > from, `${name} CSS is not closed.`);
  return modal.slice(from, end);
}

function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

ok('uses the approved compact desktop width',
  /class="modal-box rf-box"[^>]*max-width:1020px/.test(modal));
ok('uses a fixed three-step rail without layout presets',
  /class="rf-step-list"/.test(modal)
  && ['link', 'prod', 'cond'].every((key) => modal.includes(`data-rf-step="${key}"`))
  && ['fee', 'work'].every((key) => !modal.includes(`data-rf-step="${key}"`))
  && !modal.includes('onclick="RecruitModal.preset'));
ok('scrolling and clicking keep navigation in the editor viewport',
  /scrollRailToCard/.test(modal)
  && /setActiveRail/.test(modal)
  && /if \(act === 'pub' \|\| act === 'fee'\) act = 'link'/.test(modal)
  && /if \(act === 'work'\) act = 'prod'/.test(modal)
  && /body\.rf-recruit-modal-open\{overflow:hidden\}/.test(modal)
  && /document\.body\.classList\.add\("rf-recruit-modal-open"\)/.test(editor)
  && /document\.body\.classList\.remove\("rf-recruit-modal-open"\)/.test(editor)
  && /body\.scrollTo\(\{ top: Math\.max\(0, top\), behavior: 'smooth' \}\)/.test(modal));
ok('keeps automatic checks in the left rail',
  /id="rf_side_audit"/.test(modal)
  && modal.indexOf('id="rf_side_audit"') < modal.indexOf('class="rf-main"')
  && /id="rf_part_check"/.test(modal));
ok('keeps title status buttons and the legacy select in sync',
  /id="rf_status_buttons"/.test(modal)
  && /data-rf-status="draft"/.test(modal)
  && /data-rf-status="active"/.test(modal)
  && /data-rf-status="closed"/.test(modal)
  && /function syncStatusButtons/.test(modal)
  && /function setStatus/.test(modal)
  && /syncStatusButtons\(\)/.test(editor));
ok('keeps product settings in the product section',
  !modal.includes('data-sec="info"')
  && /id="rf_product_settings_slot"/.test(modal)
  && /data-product-settings/.test(modal)
  && /function placeFinalSections/.test(modal)
  && /id="rf_legacy_product_settings_slot"/.test(modal)
  && /syncProductSettings: placeFinalSections/.test(modal)
  && /RecruitModal\.syncProductSettings\(on\)/.test(editor));
ok('uses the approved 25/75 rows and 30px field rhythm',
  /\.rf-hrow\{grid-template-columns:minmax\(112px,25%\) minmax\(0,75%\)/.test(modal)
  && /\.rf-main \.rform-input\{min-height:30px/.test(modal)
  && /\.rchan-btn,#recruitModal \.rf-pm-btn,#recruitModal \.rf-status-buttons button\{min-height:29px/.test(modal));
ok('preserves option URLs, schedule, time, receipt, and guide-image controls',
  ['rf-opt-url', 'rf_skip_weekends', 'rf_free_time_toggle', 'rf_cash_receipt_required', 'rf_fee_sched_on',
    'rf_wd_inflow', 'rf_wd_review', 'rf_wd_notes', 'rf_ig_inflow', 'rf_ig_review', 'rf_ig_notes']
    .every((token) => modal.includes(token)));
ok('keeps both embedded style blocks balanced',
  ['SHELL_CSS', 'CSS'].every((name) => {
    const css = withoutComments(cssOf(name));
    return (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length;
  }));

console.log('recruitModalLayout: passed');
