#!/usr/bin/env node
/**
 * backfill-archive-folder-urls.js — 예전 ⬛ 보관 작업의 [리뷰]·[구매캡처] 폴더 주소를 되찾아
 * index_master_archive.folder_url / capture_folder_url 에 채운다 (migration 204).
 *
 * 왜: 옛 관리자 대시보드 ⬛ 마감이 tab_configs 행(폴더 주소 포함)을 지워, 보관된 작업은 작업보드에서
 *   폴더 바로가기가 꺼졌다. 폴더는 Drive 에 그대로 있다(AI_REVIEW_FOLDER → 캠페인 → 탭명 → [리뷰]/[구매캡처]).
 *
 * ★ Drive 는 **읽기만**(만들지도 옮기지도 지우지도 않는다 — ensure* 를 쓰지 않는다).
 * ★ 판정: 탭명과 **정확히 같은 이름**의 폴더 중 부모의 부모가 루트인 것. 둘 이상이면 부모(캠페인) 이름이
 *   보관 기록의 캠페인명과 같은 것(공백·슬래시 무시)만 남기고, 그래도 하나가 아니면 **건너뛴다**(남의 폴더를
 *   붙이지 않는다 — fail-closed). [리뷰]·[구매캡처] 도 이름이 정확히 하나일 때만.
 * ★ 쓰기 표면 = 보관 기록의 두 칸, **비어 있을 때만**(COALESCE) · tab_configs 행이 없는 보관 작업만.
 *
 * 실행(운영 자격이 필요하다):
 *   node scripts/backfill-archive-folder-urls.js            # 드라이런(기본 — 쓰기 0, 결과 요약만)
 *   node scripts/backfill-archive-folder-urls.js --apply    # 찾은 것만 채운다
 *   옵션: --limit=N  --tab="정확한 탭명"
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('../src/db/pool');
const drive = require('../src/services/drive.service');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const arg = (k) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const LIMIT = parseInt(arg('limit') || '0', 10) || null;
const ONLY_TAB = arg('tab');
const ROOT = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
const norm = (s) => String(s == null ? '' : s).replace(/[\s/]/g, '');
const url = (id) => `https://drive.google.com/drive/folders/${id}`;

/** 한 작업의 폴더를 찾는다. 반환 { status, review, capture, why } — 쓰기 0. */
async function locate(row) {
  const hits = (await drive.searchFolders(row.tab_name, { limit: 50 })).filter(f => f.name === row.tab_name);
  const cands = [];
  for (const f of hits) {
    const parent = f.parents && f.parents[0];
    if (!parent) continue;
    const pm = await drive.getFileParents(parent).catch(() => null);
    if (pm && (pm.parents || []).includes(ROOT)) cands.push({ id: f.id, top: pm.name });
  }
  let pick = cands;
  if (cands.length > 1) pick = cands.filter(c => norm(c.top) === norm(row.campaign_name));
  if (pick.length !== 1) return { status: cands.length ? 'ambiguous' : 'none', why: `후보 ${cands.length}` };
  const one = async (name) => {
    const kids = await drive.listFolderContents(pick[0].id, 'application/vnd.google-apps.folder');
    const m = (kids || []).filter(k => k.name === name && !k.trashed);
    return m.length === 1 ? m[0].id : null;
  };
  const review = await one('[리뷰]');
  const capture = await one('[구매캡처]');
  return { status: (review || capture) ? 'found' : 'tab_only', review, capture, top: pick[0].top };
}

async function main() {
  if (!ROOT) throw new Error('AI_REVIEW_FOLDER_ID 가 없습니다.');
  // migration 204 전이면 칸이 없다 — 드라이런은 그대로 돌고(무엇을 찾을지 미리 본다), 적용은 거부한다.
  const { rows: cols } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'index_master_archive' AND column_name = 'capture_folder_url'`);
  const hasCols = cols.length > 0;
  if (APPLY && !hasCols) throw new Error('migration 204 가 아직 적용되지 않았습니다(배포 후 다시 실행).');
  const params = [];
  let where = `NOT EXISTS (SELECT 1 FROM tab_configs t WHERE t.sheet_id = a.sheet_id AND t.tab_name = a.tab_name)`;
  if (hasCols) where += ` AND (a.folder_url IS NULL OR a.capture_folder_url IS NULL)`;
  if (ONLY_TAB) { params.push(ONLY_TAB); where += ` AND a.tab_name = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT a.sheet_id, a.tab_name, a.campaign_name FROM index_master_archive a WHERE ${where}
      ORDER BY a.archived_at DESC NULLS LAST ${LIMIT ? `LIMIT ${LIMIT}` : ''}`, params);
  const tally = {}; let wrote = 0;
  for (const row of rows) {
    let r;
    try { r = await locate(row); } catch (e) { r = { status: 'error', why: String(e.message).slice(0, 80) }; }
    tally[r.status] = (tally[r.status] || 0) + 1;
    if (r.status !== 'found') { console.log(`[${r.status}] ${row.tab_name} — ${r.why || ''}`); continue; }
    if (APPLY) {
      const u = await pool.query(
        `UPDATE index_master_archive
            SET folder_url = COALESCE(folder_url, $3), capture_folder_url = COALESCE(capture_folder_url, $4)
          WHERE sheet_id = $1 AND tab_name = $2
            AND NOT EXISTS (SELECT 1 FROM tab_configs t WHERE t.sheet_id = $1 AND t.tab_name = $2)`,
        [row.sheet_id, row.tab_name, r.review ? url(r.review) : null, r.capture ? url(r.capture) : null]);
      wrote += u.rowCount;
    }
  }
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', total: rows.length, ...tally, wrote }));
}

main().then(() => pool.end()).catch(async (e) => { console.error('실패:', e.message); try { await pool.end(); } catch (_) {} process.exit(1); });
