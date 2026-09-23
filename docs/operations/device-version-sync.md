# 노트북·데스크톱 버전 맞추기

두 컴퓨터의 기준은 각자 폴더의 `main`이 아니라 GitHub의 `origin/main`이다. 이 명령은 저장소에 남은 오래된 추적 정보에 기대지 않고 GitHub의 `main`을 직접 다시 받은 뒤, 현재 작업이 최신 기준에서 얼마나 앞·뒤인지와 저장되지 않은 변경이 있는지를 같은 형식으로 보여 준다.

```powershell
.\scripts\sync-status.ps1
```

`state`가 `aligned`이면 이 컴퓨터의 `main`은 공통 기준과 같다. `main_out_of_date`면 저장되지 않은 변경이 없는지 확인한 뒤 아래 명령으로만 갱신한다.

```powershell
git switch main
git pull --ff-only origin main
```

`feature_branch_current`는 오류가 아니다. 이 기능 작업은 최신 공통 기준에서 시작했다는 뜻이다. `feature_branch_out_of_date`면 병합 전에 `origin/main`을 기준으로 다시 맞춘다. `local_changes`일 때는 자동 갱신하지 않는다. 먼저 커밋하거나 안전하게 보관한다.

자동 검사에서 최신 기준을 포함하는지만 확인하려면 아래처럼 사용한다. 저장되지 않은 변경이 있거나 공통 기준보다 뒤처지면 종료 코드 2로 끝난다.

```powershell
.\scripts\sync-status.ps1 -Strict
```
