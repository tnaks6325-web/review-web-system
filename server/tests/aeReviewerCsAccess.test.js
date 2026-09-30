const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const csRoutes = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'cs.routes.js'), 'utf8');
const trackBRoutes = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'trackB.routes.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, 'frontend', 'workdesk.html'), 'utf8');

assert.match(csRoutes, /role === 'master' \|\| role === 'admin' \|\| role === 'staff'/);
assert.match(csRoutes, /router\.use\(authMiddleware, internalMiddleware\)/);

for (const [method, route] of [
  ['get', 'threads'], ['get', 'unread-count'], ['get', 'messages'], ['get', 'order-context'],
  ['post', 'reply'], ['post', 'upload'], ['post', 'status'], ['post', 'memo'],
]) {
  assert.match(trackBRoutes, new RegExp(`router\\.${method}\\('/cs/${route}', authMiddleware, internalMiddleware`));
}

assert.match(workdesk, /if\(isAdmin \|\| isStaff\) _csStartBadgePoll\(\);/);
assert.match(workdesk, /const isInternal = _isInternalRole\(\);[\s\S]{0,500}if\(isInternal\)/);
assert.match(workdesk, /답장은 내 C\/S 문의창구/);
assert.doesNotMatch(workdesk, /답장은 관리자\(master\/admin\)/);

console.log('AE reviewer C/S access checks passed');
