# 전역 Ctrl/Cmd+Z 사양

- 입력 필드에서는 브라우저 기본 실행취소를 유지한다.
- 그 밖의 화면에서는 이전 히스토리로 이동한다.
- 작업보드에서는 저장 완료된 일반 시트 셀 편집을 먼저 되돌린다.
- 여러 칸 붙여넣기는 하나의 실행취소 단위다.
- 삭제·입금·제출·파일 이동·커스텀 열·셀 색상은 이 범위에서 제외한다.
- 저장 중이거나 실패한 변경은 실행취소 기록에 넣지 않는다.
- Ctrl/Cmd+Shift+Z 재실행은 이번 범위에 포함하지 않는다.

검증: `node server/tests/globalCtrlZ.test.js`, `node server/tests/gridCellRangeEdit.test.js`, `node server/tests/workdeskHistoryNav.test.js`
