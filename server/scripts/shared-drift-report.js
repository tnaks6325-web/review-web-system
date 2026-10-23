#!/usr/bin/env node
/**
 * 양방향 동기화 대조 보고서(읽기 전용) — 작업오더 ↔ 모집공고 공유 칸이 같은가.
 *   DATABASE_URL=... node scripts/shared-drift-report.js [--json]
 * ★ 읽기 전용 트랜잭션에서만 돈다(`default_transaction_read_only`) — 운영 DB 에 붙여도 쓰기가 불가능하다.
 */
'use strict';
const { Client } = require('pg');
const { buildSharedDriftReport } = require('../src/services/sharedDriftReport.service');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL 이 필요합니다.'); process.exit(2); }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '20s'");
    await client.query('BEGIN READ ONLY');
    const report = await buildSharedDriftReport(client);
    await client.query('ROLLBACK');
    if (process.argv.includes('--json')) { console.log(JSON.stringify(report)); return; }
    console.log('대조 시각', report.generatedAt);
    console.log('같음', report.counts.same, '· 다름', report.counts.diff,
      '· 마감 공고(대상 아님)', report.counts.excluded_archived, '· 공고 없음', report.counts.no_campaign);
    for (const [k, n] of Object.entries(report.fieldCounts).sort((a, b) => b[1] - a[1])) console.log('  ', k, n);
    for (const r of report.rows.filter(x => x.state === 'diff')) {
      console.log('-', r.title, '|', r.diffs.map(d => `${d.field}: 오더 ${d.order || '(빈 값)'} / 공고 ${d.campaign || '(빈 값)'}`).join(' · '));
    }
  } finally {
    await client.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
