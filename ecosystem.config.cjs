module.exports = {
  apps: [
    {
      name: 'review-system-api',
      cwd: './server',
      script: 'index.js',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        DATABASE_URL: 'postgresql://reviewuser:reviewpass123@localhost:5432/review_system',
        JWT_SECRET: 'dev-secret-key-for-local-testing-only-32',
        JWT_EXPIRES_IN: '8h',
        MASTER_ADMIN_NAME: 'master',
        MASTER_ADMIN_PW: '931118',
        // [REMOVED] BASE_SHEET_ID — 베이스시트 의존성 제거 완료 (DB가 원본)
        ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:5500,http://127.0.0.1:5500,https://review-web-system.pages.dev',
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
    }
  ]
};
