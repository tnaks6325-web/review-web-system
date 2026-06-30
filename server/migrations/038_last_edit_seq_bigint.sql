-- 038: order_submissions.last_edit_seq를 INTEGER → BIGINT로 확장
-- 버그(E2E 발견): order-edit의 editSeq = Date.now()(epoch ms, ~1.78조)가 INTEGER 최대(약 21.4억)를
--   초과해, order_update 큐 분기의 `UPDATE ... last_edit_seq = GREATEST(last_edit_seq, $editSeq)`가
--   "integer out of range"로 throw → 시트엔 편집이 반영되지만 큐항목은 failed로 처리되고
--   editSeq 단조가드(stale 편집 무시, R5)가 무력화(last_edit_seq가 0에 고정)됐다.
-- BIGINT로 넓혀 epoch ms를 담는다. 폭은 확장만 하므로 비파괴(기존 값 보존). 재실행 무해.
ALTER TABLE order_submissions ALTER COLUMN last_edit_seq TYPE BIGINT;
