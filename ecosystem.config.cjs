module.exports = {
  apps: [
    {
      name: 'review-system-api',
      cwd: './server',
      script: 'index.js',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        JWT_SECRET: 'dev-secret-key-for-local-testing-only-32',
        MASTER_ADMIN_NAME: 'master',
        MASTER_ADMIN_PW: '931118',
        BASE_SHEET_ID: '1YW2KgPo-fvwBUS1nuzWTutqE_n2RVAnHPXXYVn4o2i4',
        ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:5500,http://127.0.0.1:5500',
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
    }
  ]
};
