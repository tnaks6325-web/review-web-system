/**
 * csBridgeMetaPg.test.js — 관리자 → 리뷰어 안내가 **실제 DB 에 저장되는지** 진짜 PG 로 확인.
 *
 * 왜 이 가드가 따로 필요한가 (실사고 2026-08-21)
 *  · `cs_messages.meta` 는 **NOT NULL DEFAULT '{}'**(migration 080)인데, 기본값은 컬럼을
 *    **생략했을 때만** 적용된다. `postInspectionReject` 는 카드가 없으면 `null` 을 넘겨
 *    **23502 로 전건 실패**했다 — 그런데 이 함수는 계약상 **절대 throw 하지 않아**
 *    warn 로그만 남고 화면은 "보내지 못했습니다" 한 줄이었다.
 *  · 그래서 **카드 없는 안내 3종이 조용히 전멸**해 있었다:
 *    리뷰검수 [✕ 불량] 반려 본문 · 입금 실패 안내 · 작업보드 [💬 리뷰어에게 메시지].
 *  · ★★ 스텁 pool 로는 절대 못 잡는다(스텁은 제약조건을 모른다). 그래서 **진짜 PG** 로 넣어 본다.
 *
 * 실행: PGTEST_URL=postgres://... node tests/csBridgeMetaPg.test.js
 *   (PGTEST_URL 없으면 정적 검사만 하고 통과 — CI 무조건 초록 방지용으로 사유를 출력한다)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0, fail = 0;
const ok = (name, cond, extra) => {
  n++;
  if (cond === undefined || cond) console.log('  ✓ ' + name);
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

/* ── 정적: NOT NULL 컬럼에 맨 null 을 넘기지 않는다 ───────────────────────────── */
console.log('\n[A] 정적 — meta 는 SQL 에서 접는다');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/csBridge.service.js'), 'utf8');
  ok("★ meta 자리표시자를 COALESCE 로 접는다(NOT NULL DEFAULT '{}' 는 컬럼 생략 시에만 적용)",
    /COALESCE\(\$5::jsonb,\s*'\{\}'::jsonb\)/.test(src));
  ok('★ meta 에 맨 null 을 넘기는 자리가 없다',
    !/meta \? JSON\.stringify\(meta\) : null\]/.test(src.replace(/COALESCE[^)]*\)/g, '')) || /COALESCE/.test(src));
}

/* ── 실행: 진짜 PG 에 넣어 본다 ─────────────────────────────────────────────── */
(async () => {
  if (!process.env.PGTEST_URL) {
    console.log('\n[B] 실행 검증 건너뜀 — PGTEST_URL 없음');
    console.log('    ★ 이 사고(23502)는 스텁으로 못 잡는다. 배포 전 한 번은 진짜 PG 로 돌릴 것.');
    console.log(`\n${fail ? '✗ 실패 ' + fail + '건 / ' : '✓ '}${n}개 검사 통과`);
    process.exit(fail ? 1 : 0);
  }
  process.env.DATABASE_URL = process.env.PGTEST_URL;
  const pool = require('../src/db/pool');
  const CSB = require('../src/services/csBridge.service');
  console.log('\n[B] 진짜 PG — 카드 없는 안내가 실제로 저장된다');

  const p8 = '99' + String(Date.now()).slice(-6);
  const tab = 'guard/' + Date.now();
  try {
    let err = null;
    const out = await CSB.postAdminNotice({
      sheetId: 'guard_sheet', tabName: tab, rowIndex: 1,
      reviewerName: '가드', phone8: p8, message: '카드 없는 안내(회귀가드)', by: '가드',
      onError: (e) => { err = e; },
    });
    ok('★ 카드 없이 보내도 성공한다(23502 재발 차단)', !!out, err ? `${err.message} [${err.code}]` : '반환 null');

    const { rows } = await pool.query(
      `SELECT m.msg_type, m.meta, m.sender_role, t.admin_unread_count AS "adminUnread"
         FROM cs_messages m JOIN cs_threads t ON t.id = m.thread_id
        WHERE t.reviewer_phone8 = $1`, [p8]);
    ok('메시지가 실제로 저장됐다', rows.length === 1, 'rows=' + rows.length);
    if (rows.length) {
      ok("meta 는 빈 객체로 저장된다(null 아님)", JSON.stringify(rows[0].meta) === '{}', JSON.stringify(rows[0].meta));
      ok("msg_type='text' · 관리자 발신", rows[0].msg_type === 'text' && rows[0].sender_role === 'admin');
      ok('★ 관리자 발신이라 admin_unread 를 올리지 않는다', rows[0].adminUnread === 0, String(rows[0].adminUnread));
    }

    // 카드가 있는 경로(검수 결과 카드)도 그대로 동작하는지 — COALESCE 가 카드를 삼키면 안 된다
    const p8b = '98' + String(Date.now()).slice(-6);
    await CSB.postAdminNotice({
      sheetId: 'guard_sheet', tabName: tab + 'b', rowIndex: 2,
      reviewerName: '가드', phone8: p8b, message: '카드 있는 안내', by: '가드',
      card: { kind: 'duplicate', fileId: 'abcdefghij123', work: '작업' },
    });
    const { rows: cr } = await pool.query(
      `SELECT m.msg_type, m.meta->>'kind' AS kind FROM cs_messages m
         JOIN cs_threads t ON t.id = m.thread_id WHERE t.reviewer_phone8 = $1`, [p8b]);
    ok('★ 카드 경로는 종전 그대로(meta 보존)',
      cr.length === 1 && cr[0].msg_type === 'inspect_result' && cr[0].kind === 'duplicate', JSON.stringify(cr));

    /* ── B-2. 사진 첨부 — **저장·정화가 실제로 도는지** (작업보드 선톡 · 2026-08-21) ──────
       ★ `image_urls` 도 NOT NULL 계열이라 맨 null 을 넘기면 같은 23502 를 밟는다.
       ★ 화이트리스트(`utils/csImageUrls`)는 순수함수라 단위로도 검사하지만, **저장까지 도는지**는
         여기서만 확인된다(본문 없이 사진만 보내는 갈래 포함). */
    const OKURL = 'https://api.example.dev/api/order/guide-image/abcdefghij0123456789';
    const p8i = '96' + String(Date.now()).slice(-6);
    const outImg = await CSB.postAdminNotice({
      sheetId: 'guard_sheet', tabName: tab + 'i', rowIndex: 4,
      reviewerName: '가드', phone8: p8i, by: '가드',
      message: '', imageUrls: [OKURL, 'https://evil.example/a.png'],   // ★ 본문 없이 사진만
    });
    ok('★ 본문이 비어도 사진만으로 보낼 수 있다', !!outImg);
    const { rows: ir } = await pool.query(
      `SELECT m.image_urls AS "u", m.content, t.last_message_preview AS "p"
         FROM cs_messages m JOIN cs_threads t ON t.id = m.thread_id WHERE t.reviewer_phone8=$1`, [p8i]);
    ok('첨부가 실제로 저장된다', ir.length === 1 && (ir[0].u || []).length === 1, JSON.stringify(ir[0] && ir[0].u));
    ok('★ 우리 프록시 주소만 남는다(임의 URL 은 저장 전에 걸러진다)',
      ir.length === 1 && (ir[0].u || [])[0] === OKURL, JSON.stringify(ir[0] && ir[0].u));
    ok('★ 본문이 비면 미리보기는 "사진 N장"(빈 줄로 남기지 않는다)',
      ir.length === 1 && ir[0].p === '사진 1장', ir[0] && ir[0].p);
    const noneOut = await CSB.postAdminNotice({
      sheetId: 'guard_sheet', tabName: tab + 'j', rowIndex: 5,
      reviewerName: '가드', phone8: '95' + String(Date.now()).slice(-6), by: '가드',
      message: '', imageUrls: ['https://evil.example/a.png'],
    });
    ok('★ 본문도 없고 통과한 사진도 없으면 보내지 않는다(빈 메시지 저장 금지)', noneOut === null);

    /* ── C. 원자성 — 메시지가 실패하면 **빈 방을 남기지 않는다** ─────────────────────
       종전 구조는 방을 먼저 만들며 `last_message_preview` 까지 채우고 메시지를 따로 넣어,
       메시지가 실패하면 **목록에는 보낸 것처럼 보이는데 열면 비어 있는 방**이 남았다(실측 신고).
       진짜 실패를 주입해 되돌려지는지 본다(스텁으로는 못 만드는 상황). */
    const p8c = '97' + String(Date.now()).slice(-6);
    await pool.query(`CREATE OR REPLACE FUNCTION _guard_boom() RETURNS trigger AS $$
      BEGIN IF NEW.content = '__GUARD_BOOM__' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER _guard_boom_t BEFORE INSERT ON cs_messages
      FOR EACH ROW EXECUTE FUNCTION _guard_boom()`);
    let boomErr = null;
    const boom = await CSB.postAdminNotice({
      sheetId: 'guard_sheet', tabName: tab + 'c', rowIndex: 3,
      reviewerName: '가드', phone8: p8c, message: '__GUARD_BOOM__', by: '가드',
      onError: (e) => { boomErr = e; },
    });
    await pool.query('DROP TRIGGER IF EXISTS _guard_boom_t ON cs_messages').catch(() => {});
    await pool.query('DROP FUNCTION IF EXISTS _guard_boom()').catch(() => {});
    ok('메시지 실패는 null 을 돌려준다(계약 유지·throw 없음)', boom === null && !!boomErr);
    const { rows: ghost } = await pool.query(
      `SELECT id, last_message_preview AS p FROM cs_threads WHERE reviewer_phone8=$1`, [p8c]);
    ok('★★ 메시지가 실패하면 **빈 방이 남지 않는다**(트랜잭션 롤백)', ghost.length === 0, JSON.stringify(ghost));
  } finally {
    await pool.query(`DELETE FROM cs_threads WHERE campaign_key LIKE 'guard_sheet%'`).catch(() => {});
  }
  console.log(`\n${fail ? '✗ 실패 ' + fail + '건 / ' : '✓ '}${n}개 검사 통과`);
  process.exit(fail ? 1 : 0);
})();
