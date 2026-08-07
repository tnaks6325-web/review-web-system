/**
 * campaignLinkedTabAutofill.test.js — 작업오더 작업시트탭 → 공고 연결 탭 자동 연동 회귀가드.
 *
 * 증상: 오더에 작업시트탭URL이 있는데 공고가 "⚠ 시트 탭 미연결 · 게시할 수 없습니다"로 막힘.
 *   작업시트탭URL은 AE 제출 **필수**라 오더엔 항상 값이 있으므로, 공고가 비어 있는 건
 *   폼에서 못 고른 것뿐이다 → 서버가 저장 시점에 채운다.
 *
 * ★ 완화 금지 불변식
 *   ① **비어 있을 때만** 채운다 — 관리자가 고른 탭을 절대 덮지 않는다.
 *   ② 보정 실패는 저장을 막지 않는다(fail-soft).
 *   ③ 게이트 판정 **전에** 보정한다 — 안 그러면 "탭 미연결"로 게시가 계속 막힌다.
 *
 * 실행: node tests/campaignLinkedTabAutofill.test.js
 *   (선택) 마이그레이션 실검증: PGTEST_URL=postgres://... node tests/campaignLinkedTabAutofill.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const rt = readS('routes/campaign.routes.js');
const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '067_campaign_linked_tab_backfill.sql'), 'utf8');
// 프리필 조립(_woCampaignPrefill)은 공유 모듈(js/work-order-detail.js)로 이관 —
// 리뷰웹시스템[3버전]의 작업오더 탭이 같은 함수를 쓴다(사본 금지). 두 파일을 합쳐서 본다.
const app = readF('js/index-app.js') + '\n' + readF('js/work-order-detail.js');
const rec = readF('js/index-recruit.js');

/* ═══ 서버 보정 헬퍼 ═══ */
ok('작업오더에서 연결 탭을 해석하는 헬퍼가 있다', /async function _linkedTabFromWorkOrder\(/.test(rt));
ok('접수 확정값(linked_tab_*)을 우선 사용',
  /if \(o\.linked_tab_sheet_id && o\.linked_tab_name\)/.test(rt));
ok('★ 미접수 오더는 work_sheet_url 의 시트ID·gid로 tab_configs 역조회',
  /\\\/spreadsheets\\\/d\\\/\(\[a-zA-Z0-9-_\]\+\)/.test(rt)
  && /SELECT tab_name FROM tab_configs WHERE sheet_id = \$1 AND tab_gid = \$2/.test(rt));
ok('등록 안 된 탭이면 추측하지 않고 그대로 둔다',
  /if \(!tc\.length\) return null;/.test(rt));
ok('★ 조회 실패는 null — 보정 실패가 저장을 막지 않는다(fail-soft)',
  /작업오더 연결탭 조회 실패\(무시\)/.test(rt));

/* ═══ 생성 라우트 ═══ */
ok('★ 생성 시 게이트 판정 전에 보정한다(순서가 뒤면 게시가 계속 막힘)',
  /연결탭 자동 보정\(생성\)[\s\S]{0,400}_participationActivationErrors\(\{/.test(rt));
ok('생성 게이트가 보정값을 본다',
  /linked_sheet_id: lSheet, linked_tab_gid: lGid, window_start, window_end, daily_limit/.test(rt));
ok('생성 INSERT에 보정값이 들어간다', /lSheet \|\| '',\s*\n\s*lTab \|\| '',\s*\n\s*lGid \|\| '',/.test(rt));
ok('★ 본문에 값이 있으면 보정하지 않는다(관리자 선택 우선)',
  /if \(!lSheet \|\| !lTab\) \{/.test(rt));

/* ═══ 수정 라우트 ═══ */
ok('수정 시에도 보정한다(기존 공고는 열어서 저장하면 복구)',
  /연결탭 자동 보정\(수정\)/.test(rt));
ok('★ DB에 이미 연결돼 있으면 건드리지 않는다',
  /if \(c0 && !c0\.linked_sheet_id && !c0\.linked_tab_name\)/.test(rt));
ok('정방향 링크가 없으면 역방향(linked_campaign_id)으로도 찾는다',
  /SELECT id FROM work_orders\s*\n\s*WHERE linked_campaign_id = \$1 AND deleted_at IS NULL/.test(rt));
ok('수정 게이트·UPDATE 모두 보정값 사용',
  /linked_sheet_id: pick\(lSheet, cur\[0\]\.linked_sheet_id\)/.test(rt)
  && /lSheet, lTab, lGid,\s*\/\/ ★ 자동 보정값/.test(rt));

/* ═══ 마이그레이션(기존 공고 백필) ═══ */
ok('★ 완전히 비어 있는 공고만 채운다',
  /COALESCE\(cc\.linked_sheet_id, ''\) = ''/.test(mig) && /COALESCE\(cc\.linked_tab_name, ''\) = ''/.test(mig));
ok('오더에 연결탭이 확정된 것만 출처로 쓴다(추측 금지)',
  /COALESCE\(w\.linked_tab_sheet_id, ''\) <> ''/.test(mig));
ok('삭제된 오더 제외', /w\.deleted_at IS NULL/.test(mig));
ok('★ 공고당 1건만 결정적으로 선택(2차 오더 대비)',
  /DISTINCT ON \(cc\.id\)/.test(mig) && /source_work_order_id, ''\) = w\.id\) DESC/.test(mig));
ok('정·역 양방향 링크를 모두 본다',
  /NULLIF\(cc\.source_work_order_id, ''\) = w\.id OR NULLIF\(w\.linked_campaign_id, ''\) = cc\.id/.test(mig));

/* ═══ 프론트 ═══ */
ok('프리필이 작업시트탭URL도 함께 넘긴다', /work_sheet_url:\s+o\.work_sheet_url \|\| ""/.test(app));
ok('★ 미접수 오더는 URL에서 시트ID·gid를 뽑아 목록과 대조',
  /if \(!sid && prefill\.work_sheet_url\)/.test(rec));
ok('목록에 없는 탭은 여전히 선택하지 않는다(잘못된 탭 연결 방지)',
  /* ⚠ 패턴 갱신(2026-08-07): 사유 안내가 붙어 `return false` → `return _miss(tabName)` 이 됐다.
     검사 의미는 불변 — **선택하지 않는다**(_miss 는 안내만 기록하고 false 를 돌려준다). */
  /if \(!_recruitTabList\.some\(t => t\.sheetId === sid && t\.tabName === tabName\)\) return _miss\(tabName\);/.test(rec)
  && /const _miss = [\s\S]{0,300}?return false;/.test(rec)
  && !/const _miss = [\s\S]{0,300}?_restoreLinkedTab/.test(rec));

/* ═══ 마이그레이션 실검증(PostgreSQL 있을 때) ═══ */
(async () => {
  if (!process.env.PGTEST_URL) {
    console.log('  · PGTEST_URL 미설정 — 마이그레이션 실행 검증은 건너뜀');
    console.log(`\n✅ campaignLinkedTabAutofill: ${n}개 통과`);
    return;
  }
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.PGTEST_URL });
  await c.connect();
  try {
    await c.query(`CREATE TEMP TABLE recruit_campaigns (id text primary key, linked_sheet_id text default '',
      linked_tab_name text default '', linked_tab_gid text default '', source_work_order_id text default '')`);
    await c.query(`CREATE TEMP TABLE work_orders (id text primary key, linked_tab_sheet_id text default '',
      linked_tab_name text default '', linked_tab_gid text default '', linked_campaign_id text default '',
      deleted_at timestamptz, created_at timestamptz default now())`);
    await c.query(`INSERT INTO recruit_campaigns VALUES
      ('cA','','','','wo1'), ('cB','','','',''), ('cC','KEEP','KEEPTAB','999','wo3'), ('cD','','','','wo4')`);
    await c.query(`INSERT INTO work_orders VALUES
      ('wo1','S_A','탭A','111','cA',NULL,now()),
      ('wo2','S_B','탭B','222','cB',NULL,now()),
      ('wo3','OTHER','OTHERTAB','333','cC',NULL,now()),
      ('wo4','','','','cD',NULL,now())`);
    const sql = mig.replace(/^--.*$/gm, '');
    await c.query(sql);
    await c.query(sql);   // 멱등성
    const { rows } = await c.query(`SELECT id, linked_sheet_id, linked_tab_name FROM recruit_campaigns ORDER BY id`);
    const m = Object.fromEntries(rows.map(r => [r.id, r.linked_sheet_id + '/' + r.linked_tab_name]));
    ok('정방향 링크 공고가 채워진다', m.cA === 'S_A/탭A');
    ok('역방향 링크만 있는 옛 공고도 채워진다', m.cB === 'S_B/탭B');
    ok('★★ 이미 연결된 공고는 그대로(덮어쓰기 없음)', m.cC === 'KEEP/KEEPTAB');
    ok('미접수 오더 공고는 빈 값 유지(없는 값을 지어내지 않는다)', m.cD === '/');
    ok('재실행해도 결과 동일(멱등)', true);
  } finally {
    await c.end();
  }
  console.log(`\n✅ campaignLinkedTabAutofill: ${n}개 통과`);
})();
