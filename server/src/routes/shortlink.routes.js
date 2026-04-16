const express = require('express');
const router = express.Router();
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

// ═══════════════════════════════════════════════════════════
// POST /api/short/create — 단축URL 생성 (GAS: createShort)
// GAS 호환: 동일 파라미터 조합이면 기존 코드 재사용
// ═══════════════════════════════════════════════════════════
router.post('/create', async (req, res, next) => {
  try {
    const { s, g, t, d, options, optionList } = req.body;
    if (!s || !t) return res.json({ error: 's(sheetId)와 t(tabName)은 필수입니다.' });

    // 옵션 리스트 처리
    let finalOptions = options || optionList || [];
    if (typeof finalOptions === 'string') {
      try { finalOptions = JSON.parse(finalOptions); } catch (_) { finalOptions = []; }
    }

    // composite key: 동일 파라미터 조합 재사용
    const compositeKey = `${s}|${g || ''}|${t}|${d || ''}`;

    // 기존 코드 확인
    const { rows: existing } = await pool.query(
      'SELECT code, option_list FROM short_links WHERE composite_key = $1 LIMIT 1',
      [compositeKey]
    );

    if (existing.length > 0) {
      const existCode = existing[0].code;
      // optionList가 변경됐으면 업데이트
      if (finalOptions.length > 0) {
        const currentOptions = existing[0].option_list || [];
        if (JSON.stringify(currentOptions) !== JSON.stringify(finalOptions)) {
          await pool.query(
            'UPDATE short_links SET option_list = $1 WHERE code = $2',
            [JSON.stringify(finalOptions), existCode]
          );
        }
      }
      return res.json({ success: true, code: existCode, shortUrl: existCode, reused: true });
    }

    // 새 코드 생성 (중복 방지 루프)
    let code, attempts = 0;
    while (attempts < 10) {
      code = generateShortCode();
      try {
        await pool.query(
          `INSERT INTO short_links (code, sheet_id, gid, tab_name, display_name, option_list, composite_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [code, s, g || '', t, d || '', finalOptions.length > 0 ? JSON.stringify(finalOptions) : null, compositeKey]
        );
        break;
      } catch (err) {
        if (err.code === '23505') { // unique violation
          attempts++;
          continue;
        }
        throw err;
      }
    }

    if (attempts >= 10) {
      return res.json({ error: '단축 코드 생성 실패' });
    }

    res.json({ success: true, code, shortUrl: code, reused: false });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/short/resolve — 단축URL 해석 (GAS: resolveShort)
// ═══════════════════════════════════════════════════════════
router.get('/resolve', async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code) return res.json({ error: 'code가 없습니다.' });

    const { rows } = await pool.query(
      `SELECT sheet_id AS s, gid AS g, tab_name AS t, display_name AS d, option_list AS "optionList"
       FROM short_links WHERE code = $1`,
      [code]
    );

    if (rows.length === 0) return res.json({ error: '유효하지 않은 코드입니다.' });

    const row = rows[0];
    res.json({
      success: true,
      s: row.s,
      g: row.g,
      t: row.t,
      d: row.d,
      optionList: row.optionList || [],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
