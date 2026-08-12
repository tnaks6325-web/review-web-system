# Spec: Review-web work-order and recruitment-modal mockup parity

## Objective

Replace the live **작업오더** and **모집공고 수정** runtime presentations with the approved desktop mockups. The result must be a real interactive UI, not a static mockup or iframe, while preserving work-order reception and recruitment-notice data flow.

The approved visual references are:

- `frontend/mockups/work-order-unification-wireframe.html`
- `frontend/mockups/recruit-popup-compact-rows.html`

## Assumptions

1. The supplied reference mockups are the binding desktop visual standard; responsive fallback may stack responsibly below desktop widths.
2. Existing work-order and recruitment payloads, data synchronization, and IDs are retained unless a separate data contract needs approval.
3. A mismatch in text, order, row height, column width, color, placement, or state transition is a defect.

## Commands

```powershell
npm test
npm run build
npm run dev
```

## Project structure

- `frontend/js/index-app.js` — work-order list and card rendering.
- `frontend/js/work-order-detail.js` — work-order administration detail UI.
- `frontend/js/recruit-modal.js` — recruitment modal markup and UI behavior.
- `frontend/js/index-recruit.js` — work-order-to-recruitment data synchronization and modal open/save flow.
- `frontend/mockups/` — committed visual reference HTML.
- `test/` or `tests/` — source contract/regression tests.

## Code style

Use scoped parity selectors and preserve existing IDs and public functions used by the current synchronization code.

```js
function setRecruitSection(sectionId) {
  document.querySelectorAll('[data-recruit-section]').forEach((section) => {
    section.classList.toggle('is-active', section.id === sectionId);
  });
}
```

## Functional and visual acceptance criteria

### Work order

- The runtime list/detail uses the approved work-order layout, state labels, controls, and compact information hierarchy.
- Received data remains visible without manual re-entry; actions maintain existing permissions and transitions.

### Recruitment edit modal

- The modal matches the approved compact three-column layout: 164px left navigation, central 25%/75% row form, 238px preview, and fixed action footer.
- Navigation contains the approved groupings: 연결·기본, 진행상품·상품 정보, 모집 조건; the auto-check result lives below the left navigation rather than as a navigation step.
- All existing operational fields remain available, including title/state, source and inflow type, assignee, purchase and delivery settings, cash receipt, review payout/bank/period settings, chat room, start/weekend/multi-account rules, product main URL and option URL, review type/badges, thumbnail URL guidance, and three guide/image attachments.
- Existing interactions remain real: option mode, mixed review composition, time setting/free-time toggle, 10-minute time entry choices, cash receipt, badge conditions, preview refresh, image attachment, validation, save/cancel, and scroll-following section state.

### Parity rules

- Desktop text, content order, labels, column ratios, row heights, component widths, borders, colors, selected/disabled/hover/focus states, and scrolling behavior match the committed reference HTML.
- The previous legacy v2 card layout must not be visible after the replacement.
- Keyboard focus and error/loading/disabled states remain accessible and legible.

## Testing strategy

- Add a failing source-contract test before each behavior slice.
- Run focused contract tests, then the project tests and production build after every slice.
- Verify the modal in a signed-in browser with a desktop screenshot and no console errors, using a representative linked work order.
- Verify the work-order-to-recruitment handoff does not lose or overwrite values.

## Boundaries

- **Always:** retain business IDs, data mappings, save behavior, and public notice restrictions; add a regression test; visually inspect desktop UI.
- **Ask first:** endpoint/database/migration changes, new packages, deployment configuration, permission changes, or a data mapping that lacks an authoritative source.
- **Never:** embed a static mockup as live UI, remove tests, silently drop a legacy field, commit secrets, or claim 1:1 parity without a runtime browser comparison.

## Plan and tasks

- [ ] Add approved work-order and recruitment mockups to this branch.
  - Verify: local browser open and `git diff --check`.
- [ ] Move work-order runtime rendering into the approved visual hierarchy.
  - Verify: focused contract test, build, screenshot.
- [ ] Replace recruitment modal shell and compact row system while retaining current field IDs.
  - Verify: focused contract test, browser interaction sweep, screenshot.
- [ ] Map every existing field and interaction to the compact sections.
  - Verify: save/reopen and work-order-to-recruit modal handoff checks.
- [ ] Run full regression and release-readiness verification.
  - Verify: `npm test`, `npm run build`, signed-in browser with zero console errors.

## Open questions

None for visual replacement. A separate approval is needed only if an approved visual field has no existing source data or requires a new API/database contract.
