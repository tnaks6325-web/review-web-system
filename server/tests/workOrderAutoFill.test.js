/**
 * workOrderAutoFill.test.js — 작업오더 → 모집공고 자동 채움(065) 회귀가드.
 *
 * 추가한 자동화 3가지:
 *   ① 연결 탭   — 접수 때 확정된 (sheetId, gid, tabName). work_sheet_url 은 제출 필수라 항상 있다.
 *   ② 구매채널   — 상품 URL의 **호스트**로 판정(naver/coupang/oliveyoung).
 *   ③ 담당자     — 작업담당(박세희→만두 · 박은비→망고 · 랜덤→직접결정).
 *
 * ★★ 공통 규율: 확신이 없으면 **빈 값**. 틀린 채널·틀린 담당자가 자동으로 박히는 것이
 *   빈 칸보다 나쁘다(채널은 현금영수증 안내를, 담당자는 정산·문의 창구를 가른다).
 * ★ 서버(utils/workManager.js)와 프론트(index-app.js) 매핑이 어긋나면
 *   "탭 담당자는 만두인데 공고 담당자는 빈칸"이 된다 → 두 사본의 일치를 고정한다.
 *
 * 실행: node tests/workOrderAutoFill.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ═══ ③ 작업담당 매핑(서버 순수함수) ═══ */
const wm = require('../src/utils/workManager');

ok('박세희 → 만두', wm.mapWorkManager('박세희') === '만두');
ok('박은비 → 망고', wm.mapWorkManager('박은비') === '망고');
ok('★ 랜덤은 자동 배정하지 않는다(빈 값 = 관리자가 결정)', wm.mapWorkManager('랜덤') === '');
ok('랜덤 판별', wm.isUndecidedWorkManager('랜덤') && !wm.isUndecidedWorkManager('박세희'));
ok('★ 모르는 이름도 빈 값(임의 해석 금지)', wm.mapWorkManager('홍길동') === '');
ok('빈 값·null 안전', wm.mapWorkManager('') === '' && wm.mapWorkManager(null) === '');
ok('공백·괄호 표기 흔들림 흡수', wm.mapWorkManager('박 세희') === '만두' && wm.mapWorkManager('박은비(망고)') === '망고');
ok('닉네임으로 와도 인정(인트라넷이 나중에 닉네임을 보내도 동작)', wm.mapWorkManager('만두') === '만두');
ok('표시 라벨 — 실명 + 닉네임 병기', wm.workManagerLabel('박세희') === '박세희 (만두)');
ok('표시 라벨 — 랜덤은 직접결정', wm.workManagerLabel('랜덤') === '랜덤 (직접결정)');
ok('표시 라벨 — 미매핑은 원문만', wm.workManagerLabel('홍길동') === '홍길동');

/* 인트라넷 payload 수용(표준키 + 별칭 + 본문 폴백) */
ok('표준키 work_manager', wm.pickWorkManager({ work_manager: '박세희' }) === '박세희');
ok('별칭 수용(worker / 작업담당)',
  wm.pickWorkManager({ worker: '박은비' }) === '박은비'
  && wm.pickWorkManager({ '작업담당': '랜덤' }) === '랜덤');
ok('구조화 필드가 없으면 본문 "작업담당 : X" 에서 찾는다',
  wm.pickWorkManager({ special_notes: '▶ 담당AE : 이만수\n▶ 작업담당 : 박세희' }) === '박세희');
ok('어디에도 없으면 빈 값', wm.pickWorkManager({ title: '7월 진행' }) === '');

/* ═══ ② 구매채널 판정(프론트 순수함수를 실제로 실행) ═══ */
const appSrc = readF('js/index-app.js');
const chanSrc = appSrc.slice(appSrc.indexOf('const WO_CHANNEL_HOSTS'), appSrc.indexOf('/** 작업오더에서 채널 추정'));
const _chan = new Function(chanSrc + '\n return _woChannelFromUrl;')();

ok('쿠팡 상품 URL → 쿠팡', _chan('https://www.coupang.com/vp/products/123') === '쿠팡');
ok('네이버 스마트스토어 → 네이버', _chan('https://smartstore.naver.com/abc/products/1') === '네이버');
ok('올리브영 → 올리브영', _chan('https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=A1') === '올리브영');
ok('★★ 광고 파라미터에 속지 않는다 — 호스트만 본다',
  _chan('https://www.coupang.com/vp/products/1?src=naver_ad&utm=oliveyoung') === '쿠팡');
ok('★★ 유사 도메인 사칭 차단(coupang.com.evil.kr)', _chan('https://coupang.com.evil.kr/x') === '');
ok('모르는 쇼핑몰은 빈 값(관리자가 직접 선택)', _chan('https://www.11st.co.kr/products/1') === '');
ok('빈 값·깨진 URL 안전', _chan('') === '' && _chan('그냥 텍스트') === '');
ok('스킴 없이 와도 판정', _chan('smartstore.naver.com/abc') === '네이버');

/* ═══ 서버 ↔ 프론트 매핑 일치(사본 드리프트 차단) ═══ */
const wmSrc = readS('utils/workManager.js');
ok('★ 프론트 매핑표가 서버와 같다(박세희→만두 · 박은비→망고)',
  /WO_MANAGER_MAP = \{ '박세희': '만두', '박은비': '망고' \}/.test(appSrc)
  && /'박세희': '만두'/.test(wmSrc) && /'박은비': '망고'/.test(wmSrc));
ok('★ 랜덤 목록도 같다',
  /WO_MANAGER_UNDECIDED = \['랜덤', '랜덤배정', '미정'\]/.test(appSrc)
  && /UNDECIDED = \['랜덤', '랜덤배정', '미정'\]/.test(wmSrc));

/* ═══ 서버 배선 ═══ */
const ord = readS('routes/order.routes.js');
ok('인트라넷·AE 양쪽에서 work_manager 를 받는다',
  /'goods_cost_type', 'work_manager'/.test(ord) && /'work_manager',\s+\/\/ 작업담당/.test(ord));
ok('신규 오더 INSERT 에 work_manager 포함(별칭·본문 폴백 경유)',
  /manager_name, work_manager, status, created_by/.test(ord) && /pickWorkManager\(b\)/.test(ord));
ok('컬럼 자동생성 안전장치(마이그레이션 실패 대비)',
  /ADD COLUMN IF NOT EXISTS work_manager/.test(ord));
ok('마이그레이션 065 존재',
  fs.existsSync(path.join(__dirname, '..', 'migrations', '065_work_order_work_manager.sql')));
ok('★ 접수 시 탭 담당자는 매핑된 닉네임 — 담당AE 실명을 넣지 않는다',
  /mapWorkManager\(o\.work_manager\), \(o\.purchase_time/.test(ord)
  && !/\(o\.title \|\| ''\), \(o\.manager_name \|\| ''\), \(o\.purchase_time/.test(ord));

/* ═══ 프론트 배선 ═══ */
const rec = readF('js/index-recruit.js');
const adm = readF('admin.html');
const siand = readF('admin-siand.html');

ok('프리필에 채널·담당자·연결탭이 실린다',
  /channel:\s+_woChannel\(o\)/.test(appSrc) && /manager:\s+_woManagerNick\(o\.work_manager\)/.test(appSrc)
  && /linked_sheet_id: o\.linked_tab_sheet_id/.test(appSrc) && /linked_tab_gid:\s+o\.linked_tab_gid/.test(appSrc));
ok('프리필이 채널·담당자 버튼을 실제로 선택한다',
  /if \(prefill\.channel\) _rfPickBtn\("channel", prefill\.channel\)/.test(rec)
  && /if \(prefill\.manager\) _rfPickBtn\("manager", prefill\.manager\)/.test(rec));
ok('★ 값이 없으면 건드리지 않는다(랜덤·판정불가 = 기존처럼 빈 칸)',
  /if \(prefill\.channel\)/.test(rec) && /if \(prefill\.manager\)/.test(rec));
ok('연결 탭은 gid 우선 재매칭(리네임된 탭도 찾음)',
  /String\(t\.tabGid \|\| ""\) === gid/.test(rec));
ok('★ 목록에 없는 탭은 선택하지 않는다(잘못된 탭 연결 방지)',
  /if \(!_recruitTabList\.some\(t => t\.sheetId === sid && t\.tabName === tabName\)\) return false;/.test(rec));
ok('올리브영 채널 버튼(관리자 화면 2종)',
  /data-val="올리브영"/.test(adm) && /data-val="올리브영"/.test(siand));
ok('버튼 없는 채널은 직접입력으로 흡수(값 유실 방지)',
  /selectRfBtn\("channel", custom\);[\s\S]{0,120}ci\.value = val;/.test(rec));
ok('작업오더 카드에 담당AE·작업담당 표시',
  /_woKv\("담당AE", o\.manager_name \|\| o\.created_by\)/.test(appSrc)
  && /_woKv\("작업담당", _woManagerLabel\(o\.work_manager\)\)/.test(appSrc));

console.log(`\n✅ workOrderAutoFill: ${n}개 통과`);
