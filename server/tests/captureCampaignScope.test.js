/**
 * captureCampaignScope.test.js — 작업보드 구매 캡처가 **공고 좌표 주문**도 찾는다.
 * 실행: node tests/captureCampaignScope.test.js
 *
 * 실사고(2026-08-23 「0807(올리브영)블랑카우 바디로션 100건」):
 *   8/19 이후 제출한 9명의 구매 캡처가 전부 "미제출"로 보였다. 파일은 Drive 에 있고 주문에도
 *   연결돼 있었다(캡처 링크 감사 0건 · 리뷰어 보완 목록 0건) — **조회 좌표가 달랐을 뿐**이다.
 *   공고(참여형)를 거쳐 제출한 주문은 원장 좌표가 `campaign:<공고ID>` 인데
 *   (submit.routes `_resolveCampaignOrderScope`), 미리보기는 탭 좌표로만 조회했다.
 *
 * 고정하는 불변식:
 *   ① 탭 좌표 조회는 종전 그대로(무회귀)
 *   ② 공고 좌표 주문도 **같은 sheet_row** 로 합류한다 — 링크(order_submission_id)로 붙이지 않는다
 *   ③ 공고 매칭은 이름 → gid 폴백 · **빈 gid 는 절을 켜지 않는다** · gid 는 서버가 다시 구한다
 *   ④ 같은 파일은 두 번 실리지 않는다 · fail-soft
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(root, 'server/src/services/trackB.service.js'), 'utf8');
let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };
/* ⚠ 정적 검사는 **그 함수 본문으로 잘라서** 본다 — 같은 SQL 문장이 파일 안 다른 곳에도 있어
   (tab_gid 재조회는 2곳) 파일 전체로 보면 이 함수의 회귀를 놓친다(변이시험 실측). */
const FN = (() => { const i = SRC.indexOf('async function reviewImagesForTab('); return SRC.slice(i, SRC.indexOf('\n}', i) + 2); })();

/* 스텁 pool 로 실제 실행 */
const poolPath = require.resolve('../src/db/pool');
let seen = [];
let plan = {};
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: {
    query: async (sql, params) => {
      seen.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      for (const [re, rows] of plan.rules || []) if (new RegExp(re).test(sql)) return { rows };
      return { rows: [] };
    },
    connect: async () => { throw new Error('no connect'); },
  },
};
const svc = require('../src/services/trackB.service');

(async () => {
  console.log('\n── A. 두 좌표를 함께 보고, 이 줄 사람의 주문만 싣는다(2026-09-30 규칙) ──');
  {
    seen = []; plan = { rules: [
      ['FROM review_submissions', []],
      ['FROM review_index', []],
      ['FROM tab_configs', [{ gid: '1443853889' }]],
      ['FROM campaign_participants cp', [
        { seq: 100, reviewer_name: '가나다', table_order_num: '1000000001' },
        { seq: 118, reviewer_name: '라마바', table_order_num: '1180000001' },
        // ★ 운영 실측 재현: 줄 200 의 사람은 '사아자', 줄 번호 200 을 가리키는 주문은 '차카타'
        { seq: 200, reviewer_name: '사아자', table_order_num: '2000000002' },
        { seq: 201, reviewer_name: '차카타', table_order_num: '2000000001' },
      ]],
      ['FROM order_submissions os', [
        { id: 'o100', sheet_row: 100, capture_file_id: 'FILE_TAB_ONLY', order_num: '1000000001', recipient: '가나다' },
        { id: 'o118', sheet_row: 118, capture_file_id: 'FILE_CAMP', order_num: '1180000001', recipient: '라마바' },
        { id: 'o200', sheet_row: 200, capture_file_id: 'FILE_WRONG', order_num: '2000000001', recipient: '차카타' },
      ]],
    ] };
    const out = await svc.reviewImagesForTab({ sheetId: 'S', tabName: 'T' });
    t('① 탭 좌표 주문의 캡처는 그 줄 사람이면 실린다(무회귀)',
      (out['100'] || []).some(f => f.fileId === 'FILE_TAB_ONLY' && f.slot === 'order_capture'));
    t('② 공고 좌표 주문의 캡처도 실린다', (out['118'] || []).some(f => f.fileId === 'FILE_CAMP'));
    t('★★ 줄 번호가 남의 주문을 가리키면 그 줄에 싣지 않는다(57줄 중 36줄 실사고)',
      !(out['200'] || []).some(f => f.fileId === 'FILE_WRONG'));
    t('★★ 그 주문은 주문번호가 맞는 진짜 주인 줄에 실린다',
      (out['201'] || []).some(f => f.fileId === 'FILE_WRONG'));
    const oq = seen.find(q => /FROM order_submissions os/.test(q.sql));
    t('③ gid 는 서버가 tab_configs 에서 다시 구해 넘긴다(화면 값 불신)',
      /SELECT COALESCE\(tab_gid, ''\) AS gid, capture_slots, income_type\s+FROM tab_configs WHERE sheet_id=\$1 AND tab_name=\$2/.test(FN)
      && oq && oq.params[2] === '1443853889');
    t('③ 공고 매칭 = 이름 → gid 폴백 · 빈 gid 는 절을 켜지 않는다',
      /rc\.linked_tab_name = \$2 OR \(\$3 <> '' AND rc\.linked_tab_gid = \$3\)/.test(oq.sql));
    t("★ 좌표는 'campaign:'||id 로 결합한다(submit.routes 규칙과 같은 모양)",
      /os\.sheet_id = 'campaign:' \|\| rc\.id AND os\.tab_name = 'campaign:' \|\| rc\.id/.test(oq.sql));
    t('★ 삭제된 주문·캡처 없는 주문은 제외', /os\.deleted_at IS NULL AND os\.capture_file_id IS NOT NULL/.test(oq.sql));
  }

  console.log('\n── B. fail-soft ──');
  {
    seen = []; plan = { rules: [
      ['FROM review_index', [{ row_index: 5, review_file_id: 'R5', review_file_at: null }]],
    ] };   // 나머지 조회는 빈 결과(공고 조회 실패와 같은 효과)
    const out = await svc.reviewImagesForTab({ sheetId: 'S', tabName: 'T' });
    t('★ 공고 조회가 비어도 나머지는 그대로 나간다', (out['5'] || []).some(f => f.fileId === 'R5'));
  }

  console.log('\n── C. 배선 ──');
  {
    const body = FN;
    t('★ 조회(원장·대표 이미지·주문)는 그대로 남아 있다',
      /FROM review_submissions/.test(body) && /FROM review_index/.test(body) && /FROM order_submissions os/.test(body));
    t('★★ 줄→주문 판정은 단일 출처(rowOrderMatch)를 쓴다 — 구매캡처 교체와 같은 함수',
      /rowOrderMatch'\)\.matchRowsToOrders/.test(body)
      && /require\('\.\.\/utils\/rowOrderMatch'\)/.test(fs.readFileSync(path.join(root, 'server/src/services/purchaseCaptureReplace.service.js'), 'utf8')));
    t('★ 공고 좌표 조회가 그 함수 안에 있다(다른 곳에 사본을 두지 않는다)',
      (SRC.match(/os\.sheet_id = 'campaign:' \|\| rc\.id/g) || []).length === 1);
  }

  console.log(`\n✅ captureCampaignScope: ${pass} cases passed`);
  process.exit(0);
})();
