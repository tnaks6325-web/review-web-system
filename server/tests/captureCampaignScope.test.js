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
  console.log('\n── A. 두 좌표를 함께 본다 ──');
  {
    seen = []; plan = { rules: [
      ['FROM review_submissions', []],
      ['FROM review_index', []],
      ['FROM tab_configs', [{ gid: '1443853889' }]],
      // 탭 좌표 주문(옛 외부모집분)
      ["FROM order_submissions os WHERE os.sheet_id", [{ sheet_row: 100, capture_file_id: 'FILE_TAB', capture_uploaded_at: null }]],
      // 공고 좌표 주문(참여형)
      ['JOIN recruit_campaigns rc', [
        { sheet_row: 118, capture_file_id: 'FILE_CAMP', capture_uploaded_at: null },
        { sheet_row: 100, capture_file_id: 'FILE_TAB', capture_uploaded_at: null },   // 같은 파일 재등장
      ]],
    ] };
    const out = await svc.reviewImagesForTab({ sheetId: 'S', tabName: 'T' });
    t('① 탭 좌표 주문의 캡처는 종전대로 실린다(무회귀)',
      (out['100'] || []).some(f => f.fileId === 'FILE_TAB' && f.slot === 'order_capture'));
    t('② 공고 좌표 주문의 캡처도 같은 sheet_row 로 실린다(신고 재현 지점)',
      (out['118'] || []).some(f => f.fileId === 'FILE_CAMP' && f.slot === 'order_capture'));
    t('④ 같은 파일이 두 번 실리지 않는다', (out['100'] || []).filter(f => f.fileId === 'FILE_TAB').length === 1);

    const campQ = seen.find(q => /JOIN recruit_campaigns rc/.test(q.sql));
    t('③ gid 는 서버가 tab_configs 에서 다시 구해 넘긴다(화면 값 불신)',
      seen.some(q => /FROM tab_configs WHERE sheet_id/.test(q.sql)) && campQ && campQ.params[2] === '1443853889');
    t('③ 공고 매칭 = 이름 → gid 폴백 · 빈 gid 는 절을 켜지 않는다',
      /rc\.linked_tab_name = \$2 OR \(\$3 <> '' AND rc\.linked_tab_gid = \$3\)/.test(campQ.sql));
    t("★ 좌표는 'campaign:'||id 로 결합한다(submit.routes 규칙과 같은 모양)",
      /os\.sheet_id = 'campaign:' \|\| rc\.id AND os\.tab_name = 'campaign:' \|\| rc\.id/.test(campQ.sql));
    t('★ 삭제된 주문·줄 없는 주문·캡처 없는 주문은 제외', /os\.deleted_at IS NULL/.test(campQ.sql)
      && /os\.sheet_row IS NOT NULL AND os\.capture_file_id IS NOT NULL/.test(campQ.sql));
    t('★★ 링크(order_submission_id)로 붙이지 않는다 — 오염 사례가 문서화된 값이다',
      !/order_submission_id/.test(campQ.sql));
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
    const i = SRC.indexOf('async function reviewImagesForTab(');
    const body = SRC.slice(i, SRC.indexOf('\n}', i) + 2);
    t('★ 조회 3종(원장·대표 이미지·탭 좌표 주문)은 그대로 남아 있다',
      /FROM review_submissions/.test(body) && /FROM review_index/.test(body)
      && /FROM order_submissions\s+WHERE sheet_id=\$1 AND tab_name=\$2/.test(body));
    t('★ 공고 좌표 조회가 그 함수 안에 있다(다른 곳에 사본을 두지 않는다)',
      /JOIN recruit_campaigns rc/.test(body)
      && (SRC.match(/os\.sheet_id = 'campaign:' \|\| rc\.id/g) || []).length === 1);
  }

  console.log(`\n✅ captureCampaignScope: ${pass} cases passed`);
  process.exit(0);
})();
