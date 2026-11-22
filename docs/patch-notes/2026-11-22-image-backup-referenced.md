# 2026-11-22 작업별 사진 백업 — 「참조 사진」 모드 (결정 368)

## 적용 대상
- 리뷰웹 서버 백업 처리기·야간 백업 묶음·운영 CLI(`server/src/services/imageBackup*.js`, `server/src/jobs/cron.js`, `server/scripts/image-backup.js`), migration 226.
- 비공개 백업 Worker 범위 검사(`backup-worker/src/storage.js`, `wrangler.jsonc` 변수 선언).
- 리뷰 제출 경로·화면·Drive 원본·업무 원장·기존 사본은 변경 없음.

## 배경
- 2026-11-22 전체 독립 감사(사본 62,147개·불일치 0·바이트 표본 복원 28개·모든 층 포함) 통과 뒤 옛 `drive-backup.yml` 중지. 독립 전체 바이트 전수 감사는 미검증.
- 범위 대조: 리뷰 시스템이 쓰는 사진 중 백업 안 된 것 — Drive 삭제 2,058·휴지통 20·**살아 있지만 승인 폴더 밖 2,865**(내 드라이브 맨 위 1,578·다른 맨 위 폴더 약 1,273·공유 폴더 14). 그 업로드 작업은 8회 뒤 blocked 가 되어 스캔 발행도 막았다.

## 변경
- 새 설정 `IMAGE_BACKUP_REFERENCED_ROOT_IDS`(서버·Worker, 기본 `[]` = 꺼짐 = 종전과 동일). 폴더 스캔 대상이 아니다. 승인/제외 root 와 겹치면 설정 오류.
- 승인 폴더에서 못 찾은 사진만: 리뷰 시스템 칸에 그 번호가 실제로 있고, 맨 위 폴더가 참조 root 이면 기존 규칙 그대로 사본을 만든다(rootId = 맨 위 폴더). 이체결과·제외 폴더·크기/형식/버전 규칙 동일, 승인 폴더 관찰이 항상 우선.
- 빈틈 찾기: 밤마다 300건까지, 백업 작업이 하나도 없는 참조 사진을 넣는다(멱등). 수동 `node server/scripts/image-backup.js gaps --limit N`(최대 5000). 삭제된 사진은 즉시, 범위 밖은 8회 뒤 superseded 로 끝나 발행을 막지 않는다.
- migration 226: `image_backup_outbox(file_id)` 가산 색인 + 빈틈 찾기 진도 한 줄 표 `image_backup_referenced_cursor`(시간 예산이 끊겨도 다음 호출이 이어서, 마지막 표 뒤 처음으로, 동시 호출은 조건부 갱신).
- 이미 백업된 참조 사진도 한 달에 한 번 다시 관찰(경로·이름·버전 변경 추적). 그대로면 새로 올리지 않고 끝, 바뀌었으면 새 사본(옛 사본 유지).
- Worker: 참조 root 도 허용, 변수 없음 = `[]`, 형식 오류 = 전부 거절, 참조 root 사슬에 승인 root 가 끼면 거절.

## 검증
- 서버 새 시험 `imageBackupReferenced.test.js` 14건 RED → GREEN, 크론·배선 시험 갱신 RED → GREEN, 기존 백업 시험 전부 통과, 서버 전체 시험 통과(커밋 기록 참조).
- PR #1855 리뷰 보강 `imageBackupReferencedSweep.test.js` RED(4건) → GREEN(5건).
- Worker unit 29/29, 실제 로컬 workerd 19/19(참조 root 저장·manifest part 허용·모르는 root 거절 — 수정 전 RED).
- 실제 Worker + 서버 결합(`imageBackupReferencedWire.cjs`): 빈틈 찾기 → 처리 → 발행(`not_observed`) → 독립 전체 복원 2/2. 수정 전 Worker 로는 RED.
- 실제 임시 PostgreSQL(`imageBackupNativePg.cjs referenced`): 색인 사용·6만 줄 중 1,000 빈틈을 600+400+0 으로·1초 제한 안.
- 운영 데이터·Drive·R2 접근 없음(로컬 전용). 운영 반영·실제 참조 root 번호 설정은 후속.

## 롤백
- 서버 `IMAGE_BACKUP_REFERENCED_ROOT_IDS` 를 비우면 종전 동작. ★ 이미 참조 사본이 발행됐으면 Worker 값은 남긴다(빼면 다음 발행이 옛 목록 재검증에서 멈춤).
- 코드 revert 는 사본·작업 행을 지우지 않는다. 색인 226 은 보존해도 무해(DROP 불필요).
