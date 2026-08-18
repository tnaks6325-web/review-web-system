-- 결과 파일마다 행 번호는 1부터 시작하므로 중복 방지 범위도 업로드 단위여야 한다.
ALTER TABLE payment_account_mismatch_reconciliations
  DROP CONSTRAINT IF EXISTS payment_account_mismatch_reconciliations_batch_id_result_seq_key;
ALTER TABLE payment_account_mismatch_reconciliations
  ADD CONSTRAINT payment_account_mismatch_reconciliations_upload_id_result_seq_key UNIQUE (upload_id, result_seq);
