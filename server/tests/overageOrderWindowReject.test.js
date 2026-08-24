/**
 * overageOrderWindowReject.test.js — 초과 접수(appendSlot)의 날짜 범위 게이트
 * 실행: node tests/overageOrderWindowReject.test.js
 *
 * 배경(2026-08-24 「전보미」 실측): 20건짜리 작업오더(8/20 하루치)의 준비된 슬롯이 다 찼는데도
 *   `appendSlot` 은 정원·날짜를 전혀 보지 않고 표 끝에 줄을 이어붙였다. 21번째가 8/20에
 *   결제까지 끝낸 정상 초과였다면 문제가 아니지만, 실제로는 구매일이 **8/21**(작업오더가
 *   이미 끝난 다음 날)인데도 8/20 작업표에 그대로 섞여 들어갔다.
 *
 * 고정하는 것:
 *  [1] 같은 날(오더 일정 범위 안) 초과는 여전히 받는다 — 거부하지 않는다.
 *  [2] 오더 일정이 끝난 **다음 날**로 넘어간 초과는 거부한다.
 *  [3] 여러 날짜에 걸친 오더는 그 **마지막 날**까지가 범위다(하루 정원이 아니라 오더 전체 일정).
 *  [4] fail-open — 연결된 작업오더가 없거나(참여형 전용 탭 등) 일정을 모르면(시작일 미상)
 *      또는 구매일을 못 읽으면 판정하지 않는다(막지 않는다).
 *  [5] 범위는 `worktablePlan.distributeDates` 로 다시 계산한다(표에 이미 적힌 값을 근거로
 *      삼지 않는다 — 과거 오염된 값으로 판정이 자기강화되는 것을 막는다).
 *  [6] appendSlot 호출 전에 이 게이트가 걸린다(소스 배선 확인).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log('  ✓ ' + name); };

const { _isPastOrderWindow } = require('../src/services/sheetlessOrder.service');

/** work_orders 조회만 응답하는 스텁 클라이언트. */
const stubClient = (woRows) => ({
  query: async (sql) => {
    if (/FROM work_orders w/.test(sql)) return { rows: woRows };
    throw new Error('예상치 못한 쿼리: ' + String(sql).slice(0, 60));
  },
});

(async () => {
  console.log('\n[1] 같은 날 초과 — 막지 않는다');
  {
    const wo = [{ recruit_count: 20, daily_count: 20, start_date: '2026-08-20',
                   skip_weekends: false, holidays: null }];
    ok('구매일 "8/20"(오더 당일) = 통과', !(await _isPastOrderWindow(stubClient(wo), {
      sheetId: 'S1', tabName: 'T1', dateStr: '8/20',
    })));
    ok('구매일 "8 / 20 (목)"(시트 표기 그대로) = 통과', !(await _isPastOrderWindow(stubClient(wo), {
      sheetId: 'S1', tabName: 'T1', dateStr: '8 / 20 (목)',
    })));
  }

  console.log('\n[2] 다음 날로 넘어간 초과 — 거부한다');
  {
    const wo = [{ recruit_count: 20, daily_count: 20, start_date: '2026-08-20',
                   skip_weekends: false, holidays: null }];
    ok('구매일 "8/21"(오더 다음 날) = 거부', await _isPastOrderWindow(stubClient(wo), {
      sheetId: 'S1', tabName: 'T1', dateStr: '8/21',
    }));
    ok('구매일 "2026-08-25"(며칠 뒤) = 거부', await _isPastOrderWindow(stubClient(wo), {
      sheetId: 'S1', tabName: 'T1', dateStr: '2026-08-25',
    }));
  }

  console.log('\n[3] 여러 날짜에 걸친 오더 — 범위는 마지막 날까지');
  {
    // 40건 / 일 20건 / 8·19 시작 / 주말 제외 안 함 → 8/19, 8/20 두 날.
    const wo = [{ recruit_count: 40, daily_count: 20, start_date: '2026-08-19',
                   skip_weekends: false, holidays: null }];
    ok('오더 범위 안(마지막 날 8/20)은 통과', !(await _isPastOrderWindow(stubClient(wo), {
      sheetId: 'S1', tabName: 'T1', dateStr: '8/20',
    })));
    ok('오더 범위를 넘은 8/21은 거부', await _isPastOrderWindow(stubClient(wo), {
      sheetId: 'S1', tabName: 'T1', dateStr: '8/21',
    }));
  }

  console.log('\n[4] fail-open — 모르면 막지 않는다');
  {
    ok('연결된 작업오더가 없으면 통과(참여형 전용 탭 등)', !(await _isPastOrderWindow(stubClient([]), {
      sheetId: 'S1', tabName: 'T1', dateStr: '8/21',
    })));
    const noStart = [{ recruit_count: 20, daily_count: 20, start_date: null,
                        skip_weekends: false, holidays: null }];
    ok('시작일 미상(일정 계산 불가)이면 통과', !(await _isPastOrderWindow(stubClient(noStart), {
      sheetId: 'S1', tabName: 'T1', dateStr: '8/21',
    })));
    const wo = [{ recruit_count: 20, daily_count: 20, start_date: '2026-08-20',
                  skip_weekends: false, holidays: null }];
    ok('구매일 빈 값은 조회조차 없이 통과', !(await _isPastOrderWindow(stubClient(wo), {
      sheetId: 'S1', tabName: 'T1', dateStr: '',
    })));
    ok('구매일을 못 읽는 값(쓰레기)이면 통과', !(await _isPastOrderWindow(stubClient(wo), {
      sheetId: 'S1', tabName: 'T1', dateStr: '알수없음',
    })));
    const throwing = { query: async () => { throw new Error('boom'); } };
    ok('조회 자체가 실패해도 통과(fail-open)', !(await _isPastOrderWindow(throwing, {
      sheetId: 'S1', tabName: 'T1', dateStr: '8/21',
    })));
  }

  console.log('\n[5] 판정 재료 — distributeDates 재사용(사본 금지) · 표 값 미신뢰');
  {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'sheetlessOrder.service.js'), 'utf8');
    ok('worktablePlan.distributeDates 로 범위를 다시 계산한다',
      /require\('\.\.\/utils\/worktablePlan'\)/.test(src) && /distributeDates\(/.test(src));
    ok('작업오더 조회는 workOrderForTabSql 단일 출처', /require\('\.\.\/utils\/workOrderLink'\)/.test(src));
    ok('구매일 파싱은 koreanDate.parseDateColumn 단일 출처(사본 금지)',
      /require\('\.\.\/utils\/koreanDate'\)/.test(src) && /parseDateColumn\(/.test(src));
  }

  console.log('\n[6] 배선 — appendSlot 이전에 게이트가 걸린다');
  {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'sheetlessOrder.service.js'), 'utf8');
    const gateIdx = src.indexOf('_isPastOrderWindow(client, { sheetId, tabName, dateStr: orderData.dateStr })');
    const appendIdx = src.indexOf("require('./participants.service').appendSlot(client,");
    ok('게이트 호출이 존재한다', gateIdx > 0);
    ok('게이트가 appendSlot 호출보다 먼저 나온다', gateIdx > 0 && appendIdx > gateIdx);
    ok('거부 시 이유 코드를 명시한다(조용한 실패 금지)', /overage_past_order_window/.test(src));
    ok('거부 시 롤백한다(줄을 만들지 않는다)',
      /await client\.query\('ROLLBACK'\);\s*\n\s*logger\.warn\(`\[sheetlessOrder\] 모집 일정 이후/.test(src));
  }

  console.log(`\n총 ${passed}개 통과\n`);
  process.exit(0);
})().catch((e) => { console.error('실패:', e.message); process.exit(1); });
