/**
 * driveLaneCallsites — Drive API 호출처의 lane 이관/팬텀 제거 소스 계약 (R4/이관 누락 방지)
 * 실행: node tests/driveLaneCallsites.test.js
 * 주의: 'driveThrottledCall('은 대문자 T라 소문자 /throttledCall\(/ 패턴에 매칭되지 않는다(오탐 없음).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

// (smartBuild.service 는 2026-10-22 삭제 — 결정 273. 되살아나면 아래 부재 단언이 잡는다.)
assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src', 'services', 'smartBuild.service.js')), 'smartBuild.service 가 되살아났다(결정 273)');

const raw = read('services/rawMirror.service.js');
assert.ok(!/await\s+throttledMap\(/.test(raw), 'rawMirror: 팬텀 throttledMap 잔존');
assert.ok(!/await\s+getSheetModifiedTime\(/.test(raw), 'rawMirror: modifiedTime 맨 호출 잔존(R4 — 무제한 버스트)');
assert.ok(/driveThrottledCall\(\(\)\s*=>\s*getSheetModifiedTime/.test(raw), 'rawMirror: modifiedTime drive lane');
// (전체 미러 mirrorAllSheets 의 concurrentMap 단언은 함수째 삭제로 대상이 사라졌다 — 결정 273)

const ib = read('services/indexBuilder.service.js');
assert.ok(!/await\s+throttledMap\(/.test(ib), 'indexBuilder: 팬텀 throttledMap 잔존');
assert.ok(!/await\s+getSheetModifiedTime\(/.test(ib), 'indexBuilder: modifiedTime 맨 호출 잔존(R4 — 무제한 버스트)');
assert.ok(/driveThrottledCall\(\(\)\s*=>\s*getSheetModifiedTime/.test(ib), 'indexBuilder: drive lane 래핑 확인');
// (buildIndexSmart 의 concurrentMap · checkDirtySheets 단언은 함수째 삭제로 대상이 사라졌다 — 결정 273)

// (indexScan.service 는 결정 186 80번에서 제거)

console.log('✅ driveLaneCallsites 전체 통과');
