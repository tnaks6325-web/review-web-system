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

// POST /api/short/create — 단축URL 생성 (GAS: createShort)
router.post('/create', async (req, res, next) => {
  try {
    const { s, g, t, d, options } = req.body;

    // 중복 방지 루프
    let code, attempts = 0;
    while (attempts < 10) {
      code = generateShortCode();
      try {
        await pool.query(
          `INSERT INTO short_links (code, sheet_id, gid, tab_name, display_name, option_list)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [code, s, g, t, d, options ? JSON.stringify(options) : null]
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

    res.json({ code, shortUrl: `${code}` });
  } catch (err) {
    next(err);
  }
});

// GET /api/short/resolve — 단축URL 해석 (GAS: resolveShort)
router.get('/resolve', async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code) return res.json({ error: 'code 파라미터 필요' });

    const { rows } = await pool.query(
      `SELECT sheet_id AS s, gid AS g, tab_name AS t, display_name AS d, option_list AS options
       FROM short_links WHERE code = $1`,
      [code]
    );

    if (rows.length === 0) return res.json({ error: 'not found' });

    const row = rows[0];
    res.json({
      s: row.s,
      g: row.g,
      t: row.t,
      d: row.d,
      options: row.options,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
