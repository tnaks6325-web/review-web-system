# Spec: 이체 결과 자동 반영

## Objective

이체 서식 다운로드로 생성된 회차에 결과 파일을 드래그해 업로드하면, 회차의 미처리 항목과 결과 파일 행을 계좌번호·금액으로 대조한다. 정확 매칭 비율이 90% 이상이고 결과 파일에 회차 밖 행이 없으며 같은 파일이 이미 반영되지 않았을 때만 자동으로 입금·작업보드 입금일을 반영한다. 그 밖의 경우에는 결과를 보여 주되 반영하지 않는다.

## Commands

- `node tests/paymentResultApply.test.js`
- `node tests/paymentBatch.test.js`
- `node tests/trackBPaymentFilters.test.js`

## Project Structure

- `server/src/services/paymentResult.service.js`: 결과 파일 분석·자동 반영 판정
- `server/src/routes/trackB.routes.js`: 관리자 전용 결과 업로드 API
- `frontend/workdesk.html`: 회차 결과 드래그 업로드와 결과 안내
- `server/tests/paymentResultApply.test.js`: 결과 반영 회귀 테스트

## Code Style

기존 `ResultError` 코드와 서비스 경계를 사용한다. 클라이언트는 파일·매칭 결과를 신뢰하지 않고 서버의 `autoApplied` 결과만 표시한다.

## Testing Strategy

자동 반영 가능/불가 경계(90%, 회차 밖 행, 이미 반영된 동일 SHA-256)를 서비스 테스트로 검증하고, UI는 드롭 영역과 별도 반영 버튼 제거를 정적 회귀 테스트로 검증한다.

## Boundaries

- Always: admin/master 권한, 12MB·형식 제한, 서버 재해석·재매칭, `pending` 조건을 유지한다.
- Ask first: 새 파일 저장소·권한 체계·외부 연동은 추가하지 않는다.
- Never: 교차 회차의 동일 계좌·금액만으로 중복을 막지 않으며, 자동 반영 기준 미달 파일을 반영하지 않는다.

## Success Criteria

- 결과 파일은 드래그해서 회차에 업로드할 수 있다.
- 정확 매칭률 90% 이상인 결과는 별도 버튼 없이 자동 반영된다.
- 회차 밖 결과 행 또는 이미 반영된 동일 파일은 자동 반영하지 않고 경고한다.
- 자동 반영은 기존 입금 기록·작업보드 날짜 기록·멱등성 보호를 재사용한다.
