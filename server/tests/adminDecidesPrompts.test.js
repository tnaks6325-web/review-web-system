'use strict';
/* 결정 378(사용자 확정 2026-11-16 "김수만이 마스터야" → A "관리자 등급 전체가 마스터처럼"):
 * 리뷰웹 관리자(admin) 등급은 어제 부족 인원 팝업 · 정규 일정 끝(순차진행·Q&A 추가 모집) 팝업을 마스터처럼 모든 공고에 대해 보고 정한다.
 *  - 인트라넷 SSO 는 master 를 발급하지 않는다(최고 admin) — 마스터만 예외로 두면 사장님 계정도 막다른 길이 된다.
 *  - staff(일반 직원)는 종전 그대로: 공고 담당자 · 오더를 보낸 AE 만.
 *  - 판정은 campaignShortage.canDecideAll 하나(사본 금지) — 목록 2곳 · 반영 2곳이 같은 함수를 쓴다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'services');
const shortageSrc = fs.readFileSync(path.join(SRC, 'campaignShortage.service.js'), 'utf8');
const seqSrc = fs.readFileSync(path.join(SRC, 'campaignSequentialEnd.service.js'), 'utf8');
const cdpSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'campaign-daily-plan.js'), 'utf8');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log('  ✓ ' + name); };

console.log('\n[결정 378 · 관리자 등급 = 팝업을 마스터처럼]');
const svc = require('../src/services/campaignShortage.service');
ok('canDecideAll 이 있다(단일 출처)', typeof svc.canDecideAll === 'function');
ok('마스터 = 모든 공고', svc.canDecideAll({ role: 'master', name: 'x' }) === true);
ok('관리자(인트라넷 SSO admin) = 모든 공고', svc.canDecideAll({ role: 'admin', name: '김수만', via: 'intranet' }) === true);
ok('일반 직원(staff) = 아님(종전 받는 사람 규칙)', svc.canDecideAll({ role: 'staff', name: '박은비' }) === false);
ok('업체·없음 = 아님', svc.canDecideAll({ role: 'advertiser' }) === false && svc.canDecideAll(null) === false && svc.canDecideAll({}) === false);

// 소비처 4곳 — 부족 인원 목록·반영, 정규 일정 끝 목록(Q&A·순차진행)이 모두 같은 함수
const shortList = /!opts\.skipRecipient && !canDecideAll\(admin\) && !isRecipient\(admin && admin\.name, c, wos\.get\(c\.id\)\)/;
ok('부족 인원 목록 — 관리자는 받는 사람 검사를 건너뛴다', shortList.test(shortageSrc));
ok('부족 인원 반영 — 관리자는 not_recipient 로 막지 않는다', /if \(!opts\.skipRecipient && !canDecideAll\(admin\)\) \{/.test(shortageSrc));
ok('정규 일정 끝(Q&A) 목록 — canDecideAll', /!opts\.skipRecipient && !canDecideAll\(admin\)\s*\n?\s*&& !isRecipient\(admin && admin\.name, \{ manager: it\.manager \}/.test(seqSrc));
ok('정규 일정 끝(순차진행) 목록 — canDecideAll', /!opts\.skipRecipient && !canDecideAll\(admin\) && !isRecipient\(admin && admin\.name, c,/.test(seqSrc));
ok('정규 일정 끝 서비스에 마스터 사본 판정이 남지 않는다', !/admin\.role === 'master'/.test(seqSrc));
ok('조절 창 안내 문구 — 마스터 → 관리자', !/마스터가 정합니다/.test(cdpSrc) && /공고 담당자·오더를 보낸 사람·관리자가 정합니다/.test(cdpSrc));

console.log(`\n${passed}개 통과`);
