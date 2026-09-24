#!/usr/bin/env node
/*
 * 명의 카드(migration 166) 테스트 서버 시험용 가짜 리뷰어 넣기 — 결정 기록 175.
 *
 * 운영에서 실제로 본 유형을 흉내 낸 **가짜** 리뷰어만 넣는다(실제 사람 정보 0).
 *   가족이 같은 번호 · 같은 이름 다른 번호(주소 없는 칸) · 완전 중복(값 같음/다름) · 다른 리뷰어와 겹치는 번호 · 문자열로 저장된 목록
 *
 * ★ 운영 보호(fail-closed): --test-only 플래그가 없거나, 리뷰어가 100명을 넘는 DB 면 아무것도 쓰지 않는다
 *   (운영은 3천 명 이상). 가짜 리뷰어는 이름이 "시험"으로 시작하고 번호가 010-0000-xxxx 대역이다.
 *   --clean 은 그 가짜 리뷰어(와 CASCADE 로 그 카드)만 지운다.
 *
 * 사용: DATABASE_URL=... node scripts/seed-identity-card-scenarios.js --test-only [--clean]
 */
const { Pool } = require('pg');

const FAKE = [
  { id: 'a0000000-0000-4000-8000-000000000001', name: '시험본인가', phone: '010-0000-0001', address: '시험시 가로 1',
    subs: [
      { name: '시험가족', phone: '010-0000-0001', address: '시험시 가로 1' },                       // 가족 · 본인과 같은 번호
      { name: '시험둘명', phone: '010-0000-0002', address: '' },                                    // 주소 없음(오늘 사고의 참여 칸)
      { name: '시험다른', phone: '010-0000-0002', address: '시험시 다로 3' },                       // 위와 같은 번호 · 다른 이름
      { name: '시험둘명', phone: '010-0000-0003', address: '시험시 라로 4', bankName: '국민', bankAccount: '000111' }, // 같은 이름 · 다른 번호
      { name: '시험 둘명', phone: '01000000002', address: '시험시 마로 5' },                        // 둘명(0002)과 완전 중복 → 빈 주소 채움
    ] },
  { id: 'a0000000-0000-4000-8000-000000000002', name: '시험본인나', phone: '010-0000-0010', address: '시험시 바로 6',
    subs: [
      { name: '시험중복', phone: '010-0000-0011', address: '시험시 사로 7' },
      { name: '시험중복', phone: '010-0000-0011', address: '시험시 아로 8' },                       // 완전 중복인데 주소가 다름 → 사람 확인
      { name: '시험겹침', phone: '010-0000-0002', address: '시험시 자로 9' },                       // 다른 리뷰어와 겹치는 번호
    ] },
  { id: 'a0000000-0000-4000-8000-000000000003', name: '시험본인다', phone: '010-0000-0020', address: '',
    subs: [], subsAsString: true },
];

(async () => {
  const args = new Set(process.argv.slice(2));
  if (!args.has('--test-only')) { console.error('거부: --test-only 플래그가 필요합니다.'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('거부: DATABASE_URL 이 없습니다.'); process.exit(2); }
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
  try {
    const { rows: [{ n }] } = await db.query('SELECT COUNT(*)::int AS n FROM reviewers');
    const fakeIds = FAKE.map((f) => f.id);
    const { rows: [{ fake }] } = await db.query('SELECT COUNT(*)::int AS fake FROM reviewers WHERE id = ANY($1::uuid[])', [fakeIds]);
    if (n - fake > 100) { console.error(`거부: 리뷰어가 ${n}명입니다 — 운영 데이터베이스일 수 있어 아무것도 쓰지 않습니다.`); process.exit(3); }
    await db.query('DELETE FROM reviewers WHERE id = ANY($1::uuid[])', [fakeIds]);
    if (args.has('--clean')) { console.log(`정리 완료: 가짜 리뷰어 ${fake}명 삭제`); return; }
    for (const f of FAKE) {
      const subs = f.subsAsString ? JSON.stringify(JSON.stringify(f.subs)) : JSON.stringify(f.subs);
      await db.query(
        `INSERT INTO reviewers (id, name, phone, address, status, sub_accounts) VALUES ($1,$2,$3,$4,'active',$5::jsonb)`,
        [f.id, f.name, f.phone, f.address, subs]);
    }
    console.log(`가짜 리뷰어 ${FAKE.length}명 넣음 (기존 리뷰어 ${n - fake}명은 그대로)`);
  } finally {
    await db.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
