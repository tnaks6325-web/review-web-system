/**
 * 구매양식 단축링크(short_links) 발급 — 단일 출처
 *
 * 리뷰어에게 보내는 「구매양식 링크」(`<API>/r/<code>` → search.html?r=<code>) 의 코드를 만들거나 되찾는다.
 * - 호출처: POST /api/short/create(옛 경로 · GAS 호환) · POST /api/trackb/form-link(리뷰웹시스템[3버전] 버튼, 결정 268)
 * - ★ 같은 (s|g|t|d|round) 조합이면 **기존 코드를 재사용**한다(GAS 원본 규칙). 그래서 옛 대시보드에서 만든 링크가 있는
 *   작업은 작업보드 버튼에서도 같은 링크가 다시 나온다 — 리뷰어에게 이미 보낸 링크와 갈리지 않는다.
 * - 되찾기(/resolve)·OG(/og/:code) 는 shortlink.routes.js 가 그대로 맡는다.
 */
const pool = require('../db/pool');

// 혼동문자 제외 영숫자 (GAS 원본 동일)
const SHORT_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const SHORT_CODE_LEN = 6;

function generateShortCode() {
  let code = '';
  for (let i = 0; i < SHORT_CODE_LEN; i++) {
    code += SHORT_CHARS.charAt(Math.floor(Math.random() * SHORT_CHARS.length));
  }
  return code;
}

/**
 * @returns {Promise<{ok:true, code:string, reused:boolean} | {ok:false, error:string}>}
 */
async function ensureShortLink({ s, g, t, d, round, options } = {}) {
  if (!s || !t) return { ok: false, error: 's(sheetId)와 t(tabName)은 필수입니다.' };
  const rd = round || '';

  // 옵션 리스트 처리
  let finalOptions = options || [];
  if (typeof finalOptions === 'string') {
    try { finalOptions = JSON.parse(finalOptions); } catch (_) { finalOptions = []; }
  }
  if (!Array.isArray(finalOptions)) finalOptions = [];

  // composite key: 동일 파라미터 조합 재사용 (round 포함)
  const compositeKey = `${s}|${g || ''}|${t}|${d || ''}|${rd}`;

  // ★ 같은 조합을 동시에 두 번 요청해도(버튼 연타·두 사람 동시) 코드는 하나만 생긴다 — composite_key 는 유니크 인덱스가
  //   없어서(기존 데이터 그대로 둠) 조합별 트랜잭션 잠금으로 "조회 → 없으면 만들기"를 한 줄로 세운다(결정 268 · Codex P2).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['short_links:' + compositeKey]);

    const { rows: existing } = await client.query(
      'SELECT code, option_list FROM short_links WHERE composite_key = $1 LIMIT 1',
      [compositeKey]
    );

    if (existing.length > 0) {
      const existCode = existing[0].code;
      // optionList가 변경됐으면 업데이트
      if (finalOptions.length > 0) {
        const currentOptions = existing[0].option_list || [];
        if (JSON.stringify(currentOptions) !== JSON.stringify(finalOptions)) {
          await client.query(
            'UPDATE short_links SET option_list = $1 WHERE code = $2',
            [JSON.stringify(finalOptions), existCode]
          );
        }
      }
      // round가 변경됐으면 업데이트
      if (rd) {
        await client.query(
          'UPDATE short_links SET round = $1 WHERE code = $2',
          [rd, existCode]
        );
      }
      await client.query('COMMIT');
      return { ok: true, code: existCode, reused: true };
    }

    // 새 코드 생성 (중복 방지 루프) — 코드 충돌은 SAVEPOINT 로 그 INSERT 만 되돌리고 다시 뽑는다
    for (let attempts = 0; attempts < 10; attempts++) {
      const code = generateShortCode();
      await client.query('SAVEPOINT sl_ins');
      try {
        await client.query(
          `INSERT INTO short_links (code, sheet_id, gid, tab_name, display_name, option_list, composite_key, round)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [code, s, g || '', t, d || '', finalOptions.length > 0 ? JSON.stringify(finalOptions) : null, compositeKey, rd]
        );
        await client.query('COMMIT');
        return { ok: true, code, reused: false };
      } catch (err) {
        if (err.code === '23505') { await client.query('ROLLBACK TO SAVEPOINT sl_ins'); continue; } // unique violation
        throw err;
      }
    }
    await client.query('ROLLBACK');
    return { ok: false, error: '단축 코드 생성 실패' };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 작업보드의 작업 하나 → 구매양식 단축링크. 재료는 **서버가 tab_configs 에서** 읽는다(화면이 보낸 gid·이름을 믿지 않는다).
 * 옛 대시보드 copyShortLink 와 같은 값(s=sheet_id · g=tab_gid · t=tab_name · d=display_name · 차수 없음)을 넣어
 * 같은 composite key 가 나오게 한다.
 * @returns {Promise<{ok:true, code, reused} | {ok:false, code:number, error}>}
 */
async function ensureTabFormLink({ sheetId, tabName } = {}) {
  const s = String(sheetId || '').trim();
  const t = String(tabName || '').trim();
  if (!s || !t) return { ok: false, code: 400, error: '작업 정보가 없습니다.' };
  const { rows } = await pool.query(
    `SELECT sheet_id, tab_name, tab_gid, display_name FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`,
    [s, t]
  );
  if (!rows.length) return { ok: false, code: 404, error: '작업을 찾을 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.' };
  const r = rows[0];
  const out = await ensureShortLink({ s: r.sheet_id, g: r.tab_gid || '', t: r.tab_name, d: r.display_name || '' });
  if (!out.ok) return { ok: false, code: 500, error: out.error };
  return out;
}

module.exports = { ensureShortLink, ensureTabFormLink, generateShortCode, SHORT_CHARS, SHORT_CODE_LEN };
