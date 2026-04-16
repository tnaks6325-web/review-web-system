const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
require('dotenv').config();

const { corsOptions }     = require('./middleware/cors.middleware');
const { errorHandler }    = require('./middleware/error.middleware');
const { rateLimiter }     = require('./middleware/rateLimit.middleware');

// 라우터
const indexRoutes    = require('./routes/index.routes');
const tabRoutes      = require('./routes/tabconfig.routes');
const reviewerRoutes = require('./routes/reviewer.routes');
const adminRoutes    = require('./routes/admin.routes');
const driveRoutes    = require('./routes/drive.routes');
const shortRoutes    = require('./routes/shortlink.routes');
const memoRoutes     = require('./routes/memo.routes');
const paymentRoutes  = require('./routes/payment.routes');
const submitRoutes   = require('./routes/submit.routes');
const diagRoutes     = require('./routes/diag.routes');

const app = express();

// ── 미들웨어 ──
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));
app.use('/api/', rateLimiter);

// ── 라우터 등록 ──
// 검색/인덱스 (Section 5)
app.use('/api/search',    indexRoutes);
app.use('/api/index',     indexRoutes);

// 탭 설정 (Section 6)
app.use('/api/tab',       tabRoutes);

// 리뷰어 관리 (Section 7)
app.use('/api/reviewer',  reviewerRoutes);

// 관리자 인증 + Staff (Section 8)
app.use('/api/admin',     adminRoutes);

// Drive 폴더 (Section 9)
app.use('/api/drive',     driveRoutes);

// 단축URL (Section 10)
app.use('/api/short',     shortRoutes);

// 메모 (Section 10)
app.use('/api/memo',      memoRoutes);

// 입금처리 (Section 11)
app.use('/api/payment',   paymentRoutes);

// 리뷰제출 + 구매양식 (Section 5/12)
app.use('/api/submit',    submitRoutes);

// 진단/디버그/뷰어/블랙리스트/캠페인/이미지 (Section 12)
app.use('/api/diag',      diagRoutes);
app.use('/api/viewer',    diagRoutes);
app.use('/api/image',     diagRoutes);
app.use('/api/blacklist', diagRoutes);

// ── 임시 마이그레이션 엔드포인트 (배포 후 DDL 실행용) ──
app.post('/api/admin/run-migrate', async (req, res) => {
  try {
    // master 인증 확인
    const { masterPw } = req.body;
    if (masterPw !== process.env.MASTER_ADMIN_PW) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const pool = require('./db/pool');
    const fs = require('fs');
    const path = require('path');

    const migrationsDir = path.resolve(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const results = [];
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      try {
        await pool.query(sql);
        results.push({ file, status: 'ok' });
      } catch (err) {
        results.push({ file, status: 'error', message: err.message });
      }
    }

    // 테이블 수 확인
    const tableCount = await pool.query(
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
    );

    res.json({
      success: true,
      migrations: results,
      tableCount: parseInt(tableCount.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 임시 데이터 마이그레이션 엔드포인트 (Sheets → DB) ──
app.post('/api/admin/run-data-migrate', async (req, res) => {
  try {
    const { masterPw, type } = req.body;
    if (masterPw !== process.env.MASTER_ADMIN_PW) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const pool = require('./db/pool');
    const { readSheet } = require('./services/sheets.service');
    const BASE_SHEET_ID = process.env.BASE_SHEET_ID;

    if (type === 'detail') {
      // 세부목록 → tab_configs
      const values = await readSheet(BASE_SHEET_ID, '세부목록!A:U');
      if (!values || values.length < 2) {
        return res.json({ success: true, message: '세부목록 데이터 없음', inserted: 0 });
      }
      const header = values[0].map(h => String(h || '').trim());
      const dataRows = values.slice(1);
      let inserted = 0, skipped = 0, errors = [];

      for (const row of dataRows) {
        const tabName = getCol(row, header, 'tab_name');
        if (!tabName) { skipped++; continue; }
        const sheetUrl = getCol(row, header, 'sheet_url');
        const sheetId = extractSheetId(sheetUrl);
        if (!sheetId) { skipped++; continue; }

        try {
          await pool.query(`
            INSERT INTO tab_configs (
              sheet_id, tab_name, sheet_url, manager, time_range, taekhap,
              review_type, payment_type, display_name, force_done, folder_url,
              is_bulk, capture_folder_url, is_closed, delivery_type, round,
              nc_mode, deposit_name, transfer_bank, income_type, campaign_name
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
            ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
              manager = EXCLUDED.manager, time_range = EXCLUDED.time_range, updated_at = NOW()
          `, [
            sheetId, tabName, sheetUrl,
            getCol(row, header, 'manager'), getCol(row, header, 'time_range'),
            toBool(getCol(row, header, 'taekhap')), getCol(row, header, 'review_type'),
            getCol(row, header, 'payment_type'), getCol(row, header, 'display_name'),
            toBool(getCol(row, header, 'force_done')), getCol(row, header, 'folder_url'),
            toBool(getCol(row, header, 'is_bulk')), getCol(row, header, 'capture_folder_url'),
            toBool(getCol(row, header, 'is_closed')), getCol(row, header, 'delivery_type'),
            getCol(row, header, 'round'), toBool(getCol(row, header, 'nc_mode')),
            getCol(row, header, 'deposit_name'), getCol(row, header, 'transfer_bank'),
            getCol(row, header, 'income_type'), getCol(row, header, 'campaign_name'),
          ]);
          inserted++;
        } catch (err) {
          errors.push({ tabName, error: err.message });
        }
      }
      return res.json({ success: true, type: 'detail', inserted, skipped, errors });

    } else if (type === 'reviewers') {
      // 인애드명단 → reviewers
      const values = await readSheet(BASE_SHEET_ID, '인애드명단!A:I');
      if (!values || values.length < 2) {
        return res.json({ success: true, message: '리뷰어 데이터 없음', inserted: 0 });
      }
      const header = values[0].map(h => String(h || '').trim());
      const dataRows = values.slice(1);
      let inserted = 0, errors = [];

      for (const row of dataRows) {
        const name = String(row[header.indexOf('이름')] || '').trim();
        const phone = String(row[header.indexOf('전화번호')] || '').replace(/[^0-9]/g, '');
        if (!name || phone.length !== 11) continue;

        const consent = String(row[header.indexOf('동의여부')] || '').toLowerCase() !== 'false';
        const status = String(row[header.indexOf('상태')] || 'active').trim() || 'active';
        const incomeType = String(row[header.indexOf('소득명의')] || '').trim();
        let subAccts = [];
        try { subAccts = JSON.parse(row[header.indexOf('sub_accounts')] || '[]'); } catch {}

        try {
          await pool.query(`
            INSERT INTO reviewers (name, phone, consent, status, income_type, sub_accounts)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status
          `, [name, phone, consent, status, incomeType, JSON.stringify(subAccts)]);
          inserted++;
        } catch (err) {
          errors.push({ name, error: err.message });
        }
      }
      return res.json({ success: true, type: 'reviewers', inserted, errors });

    } else {
      return res.status(400).json({ error: 'type 필수: "detail" 또는 "reviewers"' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getCol(row, header, key) {
  const idx = header.indexOf(key);
  return idx >= 0 ? String(row[idx] || '').trim() : '';
}
function toBool(val) {
  return ['TRUE','true','1','yes'].includes(String(val || '').trim());
}
function extractSheetId(url) {
  const m = (url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── 헬스체크 ──
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  let dbTime = null;
  try {
    const pool = require('./db/pool');
    const result = await pool.query('SELECT NOW() AS now');
    dbStatus = 'connected';
    dbTime = result.rows[0]?.now;
  } catch (err) {
    dbStatus = `error: ${err.message}`;
  }

  const googleStatus = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? 'configured' : 'not_configured';

  res.json({
    ok: true,
    ts: Date.now(),
    env: process.env.NODE_ENV || 'development',
    db: dbStatus,
    dbTime,
    google: googleStatus,
    version: '2.0.0',
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    routes: {
      search: '/api/search?query=',
      index: '/api/index/status',
      tab: '/api/tab/config',
      reviewer: '/api/reviewer/*',
      admin: '/api/admin/login',
      drive: '/api/drive/*',
      short: '/api/short/*',
      memo: '/api/memo',
      payment: '/api/payment/targets',
      submit: '/api/submit/*',
      diag: '/api/diag/*',
    }
  });
});

// ── 글로벌 에러 핸들러 ──
app.use(errorHandler);

module.exports = app;
