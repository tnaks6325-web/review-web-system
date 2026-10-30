'use strict';
const assert = require('node:assert/strict');
const { normalizeReviewOrderSourceContract, sourceWorkLineageMatches } = require('../src/services/reviewOrderSourceContract.service');
const current = { source_review_order_id: 'ro_fake_legacy', work_series_id: '', work_round: 1, workboard_schema_version: 1 };
const source = normalizeReviewOrderSourceContract({ source_review_order_id: current.source_review_order_id, source_revision: 2, idempotency_key: 'fake:2:hash', work_series_id: current.source_review_order_id });
const original = JSON.stringify({ current, source });
assert.equal(sourceWorkLineageMatches(current, source), true, 'only empty legacy first round -> own verified source ID is equivalent');
assert.equal(JSON.stringify({ current, source }), original, 'comparison never mutates inputs');
for (const workSeriesId of ['', undefined]) {
  assert.equal(sourceWorkLineageMatches(current, { ...source, workSeriesId }), true, 'old omitted/empty sender remains supported');
}
for (const [label, row, incoming] of [
  ['foreign incoming series', current, { ...source, workSeriesId: 'ro_foreign' }],
  ['existing nonempty series', { ...current, work_series_id: 'series_existing' }, source],
  ['do not reverse-normalize a nonempty series', { ...current, work_series_id: current.source_review_order_id }, { ...source, workSeriesId: '' }],
  ['stored round two', { ...current, work_round: 2 }, source],
  ['incoming round two', current, { ...source, workRound: 2 }],
  ['both round two', { ...current, work_round: 2 }, { ...source, workRound: 2 }],
  ['stored v2', { ...current, workboard_schema_version: 2 }, source],
  ['incoming v2', current, { ...source, workboardSchemaVersion: 2 }],
  ['both v2', { ...current, workboard_schema_version: 2 }, { ...source, workboardSchemaVersion: 2 }],
  ['source identity mismatch', { ...current, source_review_order_id: 'ro_other' }, source],
  ['missing source identity', { ...current, source_review_order_id: '' }, source],
  ['empty incoming source identity', current, { ...source, sourceReviewOrderId: '', workSeriesId: 'ro_fake_legacy' }],
]) assert.equal(sourceWorkLineageMatches(row, incoming), false, label);
assert.equal(sourceWorkLineageMatches({ ...current, work_series_id: 'series_real', work_round: 2, workboard_schema_version: 2 }, { ...source, workSeriesId: 'series_real', workRound: 2, workboardSchemaVersion: 2 }), true, 'ordinary exact v2/round2 comparison remains unchanged');
console.log('sourceLegacyLineage: PASS (legacy equivalence, old sender, immutable foreign/round2/v2/identity guards, no mutation)');
