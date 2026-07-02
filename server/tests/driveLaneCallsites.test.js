/**
 * driveLaneCallsites — Drive API 호출처의 lane 이관/팬텀 제거 소스 계약 (R4/이관 누락 방지)
 * 실행: node tests/driveLaneCallsites.test.js
 * 주의: 'driveThrottledCall('은 대문자 T라 소문자 /throttledCall\(/ 패턴에 매칭되지 않는다(오탐 없음).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

const smart = read('services/smartBuild.service.js');
assert.ok(!/throttledCall\(\(\)\s*=>\s*getSheetModifiedTime/.test(smart), 'smartBuild: modifiedTime이 시트 lane에 잔존');
assert.ok(/driveThrottledCall\(\(\)\s*=>\s*getSheetModifiedTime/.test(smart), 'smartBuild: driveThrottledCall 이관 확인');
assert.ok(/driveThrottledCall\(\(\)\s*=>\s*shareSheetWithServiceAccount/.test(smart), 'smartBuild: share도 drive lane');

const raw = read('services/rawMirror.service.js');
assert.ok(!/await\s+throttledMap\(/.test(raw), 'rawMirror: 팬텀 throttledMap 잔존');
assert.ok(/concurrentMap\(/.test(raw), 'rawMirror: concurrentMap 교체 확인');
assert.ok(/driveThrottledCall\(\(\)\s*=>\s*getSheetModifiedTime/.test(raw), 'rawMirror: modifiedTime drive lane');

const ib = read('services/indexBuilder.service.js');
assert.ok(!/await\s+throttledMap\(/.test(ib), 'indexBuilder: 팬텀 throttledMap 잔존');
assert.ok(/concurrentMap\(/.test(ib), 'indexBuilder: concurrentMap 교체 확인');
assert.ok(!/await\s+getSheetModifiedTime\(/.test(ib), 'checkDirtySheets: 맨 호출 잔존(R4 — 무제한 버스트)');
assert.ok(/driveThrottledCall\(\(\)\s*=>\s*getSheetModifiedTime/.test(ib), 'indexBuilder: drive lane 래핑 확인');

const scan = read('services/indexScan.service.js');
assert.ok(!/await\s+throttledMap\(/.test(scan), 'indexScan: 팬텀 throttledMap 잔존');
assert.ok(/concurrentMap\(/.test(scan), 'indexScan: concurrentMap 교체 확인');

console.log('✅ driveLaneCallsites 전체 통과');
