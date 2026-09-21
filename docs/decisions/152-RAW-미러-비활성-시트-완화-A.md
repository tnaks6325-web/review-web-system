# RAW 미러 비활성 시트 완화 (A)
- RAW미러의 유일 소비처는 주문 행배정(claimRow/loadRawTabContext/reconcile)이고 `smartBuild`(리뷰 인덱스)는 시트를 직접 읽어 RAW미러에 의존하지 않음. `RAW_MIRROR_INACTIVE_RELAX=1`(기본 OFF)이면 `INACTIVE_EVERY`(6) 사이클 중 5번은 "최근 `INACTIVE_DAYS`(30)일 내 주문 있는 활성 시트"만 미러, 비활성은 연기(6번째는 전체). 비활성 시트에 주문 오면 `_triggerSheetMirrorOnce`가 즉시 자동미러(자가치유). 요약에 `deferredInactive`.
