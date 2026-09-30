'use strict';

const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'production';

const app = require('../src/app');
const server = app.listen(0, '127.0.0.1', () => {
  const request = http.request({
    host: '127.0.0.1',
    port: server.address().port,
    path: '/api/reviewer/profile/secure',
    method: 'OPTIONS',
    headers: {
      Origin: 'https://main.review-web-system.pages.dev',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-reviewer-token',
    },
  }, (response) => {
    try {
      const allowHeaders = String(response.headers['access-control-allow-headers'] || '').toLowerCase();
      assert.strictEqual(response.statusCode, 204, 'CORS preflight must succeed');
      assert.strictEqual(
        response.headers['access-control-allow-origin'],
        'https://main.review-web-system.pages.dev',
        'Cloudflare Pages origin must be echoed'
      );
      assert.match(allowHeaders, /(^|,)x-reviewer-token(,|$)/, 'reviewer token header must be allowed');
      console.log('✅ reviewerCorsPreflight: X-Reviewer-Token preflight 허용 통과');
    } catch (error) {
      console.error('❌ ' + error.message);
      process.exitCode = 1;
    } finally {
      response.resume();
      server.close(() => process.exit(process.exitCode || 0));
    }
  });

  request.on('error', (error) => {
    console.error('❌ ' + error.message);
    process.exitCode = 1;
    server.close(() => process.exit(1));
  });
  request.end();
});
