/**
 * 택배발송대행 작업은 관리자가 작업유형을 따로 설정하지 않았어도
 * 작업보드에 송장 입력 열이 반드시 있어야 한다.
 * 실행: node tests/courierProxyWorktablePlan.test.js
 */
const assert = require('assert');
const { buildWorktablePlan } = require('../src/utils/worktablePlan');

const template = {
  core: ['번호', '구매일자', '수취인', '연락처', '주소'],
  channels: {},
  workTypes: [],
};

const workOrder = {
  recruit_count: 1,
  daily_count: 1,
  start_date: '2026-08-12',
  delivery_type: '택배발송대행',
};

function trackingColumns(plan) {
  return plan.columns.filter((column) => /택배\s*송장\s*(?:번호)?/.test(column.name));
}

// RED: 현재 구현은 템플릿 작업유형이 비어 있으면 이 열을 만들지 않는다.
{
  const plan = buildWorktablePlan({
    workOrder: { ...workOrder, courier_proxy: true },
    template,
  });
  const columns = trackingColumns(plan);
  assert.strictEqual(columns.length, 1, '택배발송대행은 송장 열을 자동으로 하나 만든다');
  assert.strictEqual(columns[0].name, '택배송장번호', '자동 열은 표준 송장번호 헤더를 쓴다');
  assert.strictEqual(columns[0].origin, 'system', '자동 열의 출처를 작업유형과 구분한다');
}

{
  const plan = buildWorktablePlan({ workOrder, template });
  assert.strictEqual(trackingColumns(plan).length, 1, '전송 Boolean이 누락된 구 데이터도 배송유형으로 보완한다');
}

{
  const plan = buildWorktablePlan({
    workOrder: { ...workOrder, courier_proxy: false, delivery_type: '실배송' },
    template,
  });
  assert.strictEqual(trackingColumns(plan).length, 0, '택배발송대행이 아닌 작업에는 송장 열을 임의로 만들지 않는다');
}

{
  const plan = buildWorktablePlan({
    workOrder: { ...workOrder, courier_proxy: true },
    template: { ...template, core: [...template.core, '택배송장'] },
  });
  assert.strictEqual(trackingColumns(plan).length, 1, '기존 템플릿 송장 열과 중복 생성하지 않는다');
}

console.log('courierProxyWorktablePlan: 4 passed');
