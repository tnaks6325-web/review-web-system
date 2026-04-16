const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// 개발환경에서는 localhost 허용
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push(
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:8080'
  );
}

const corsOptions = {
  origin: (origin, callback) => {
    // origin이 없는 경우 (Postman, 서버간 통신)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS 차단: ${origin}`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
};

module.exports = { corsOptions };
