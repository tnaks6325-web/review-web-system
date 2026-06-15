# DB 백업·복구 가이드 (외부 독립 백업)

## 왜 이 백업이 필요한가

Railway 네이티브 백업(스냅샷·PITR)은 **백업이 원본 DB와 같은 인프라(Railway=AWS) 안에 저장**된다.
Railway 계정 잠김, 프로젝트/서비스 실수 삭제, Railway 측 대형 장애 시 원본과 백업이 함께 사라질 수 있다.
이 가이드의 백업은 **Railway 바깥(Cloudflare R2)** 에 일일 덤프를 보관하여 그 시나리오에서도 복구를 보장한다.

```
Railway Postgres ──(매일 03:00 KST, GitHub Actions pg_dump)──▶ Cloudflare R2 (30일 보관)
                                                                    │
                              매월 1일 04:00 KST ◀──────────────────┘
                              임시 Postgres에 실제 복원 → 검증 (복구 리허설)
```

| 워크플로우 | 파일 | 주기 | 역할 |
|---|---|---|---|
| DB Backup | `.github/workflows/db-backup.yml` | 매일 03:00 KST | pg_dump → 무결성 검증 → R2 업로드 → 30일 초과분 삭제 |
| DB Restore Rehearsal | `.github/workflows/db-restore-test.yml` | 매월 1일 04:00 KST | R2 최신 덤프 → 임시 Postgres 복원 → 핵심 테이블 검증 |

둘 다 Actions 탭에서 **Run workflow**로 수동 실행 가능.

---

## 1. 최초 설정 (1회)

### 1-1. Cloudflare R2 버킷 생성

1. Cloudflare 대시보드 → R2 → **Create bucket** (예: `review-system-backups`)
2. R2 → **Manage R2 API Tokens** → **Create API Token**
   - 권한: **Object Read & Write**, 해당 버킷으로 한정
   - 발급된 Access Key ID / Secret Access Key를 기록

### 1-2. Railway Postgres 공개 접속 URL 확보

GitHub Actions 러너는 Railway 내부망(`postgres.railway.internal`)에 접근할 수 없다.
**반드시 Public Networking 주소를 사용**할 것:

- Railway → Postgres 서비스 → **Settings → Networking → Public Networking** 활성화
- **Connect** 탭의 공개 접속 문자열 사용 (형식: `postgresql://postgres:비밀번호@xxxx.proxy.rlwy.net:포트/railway`)
- 신규 배포라면 `DATABASE_PUBLIC_URL` 변수가 이미 있을 수 있음 — 그 값을 그대로 사용

### 1-3. GitHub Secrets 등록

GitHub 레포 → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | 값 |
|---|---|
| `BACKUP_DATABASE_URL` | 위 1-2의 공개 접속 URL (`*.proxy.rlwy.net`) |
| `R2_ACCOUNT_ID` | Cloudflare 계정 ID (R2 페이지 우측에 표시) |
| `R2_ACCESS_KEY_ID` | 1-1에서 발급한 Access Key |
| `R2_SECRET_ACCESS_KEY` | 1-1에서 발급한 Secret Key |
| `R2_BUCKET` | 버킷 이름 (예: `review-system-backups`) |

### 1-4. 동작 확인

1. Actions → **DB Backup (pg_dump → R2)** → Run workflow → 성공 확인
2. Actions → **DB Restore Rehearsal** → Run workflow → 성공 확인
   (이 두 번째 실행이 끝나야 "복구되는 백업"이 확보된 것)

### 1-5. (권장) 백업 전용 읽기 계정

`BACKUP_DATABASE_URL`에 기본 postgres 계정 대신 읽기 전용 계정을 쓰면 유출 시 피해가 줄어든다:

```sql
CREATE USER backup_reader WITH PASSWORD '강한비밀번호';
GRANT CONNECT ON DATABASE railway TO backup_reader;
GRANT USAGE ON SCHEMA public TO backup_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO backup_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO backup_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO backup_reader;
```

---

## 2. 실제 장애 시 복구 런북

> 전제: Railway가 통째로 사라진 최악의 경우. 부분 장애(테이블 실수 삭제 등)는
> Railway 네이티브 백업/PITR이 더 빠르므로 그쪽을 먼저 시도.

1. **새 Postgres 준비** — Railway 새 프로젝트(또는 다른 프로바이더)에 Postgres 생성.
   현재 운영 DB는 **PostgreSQL 18** — 복구 대상도 18 이상 사용.
2. **최신 덤프 다운로드** — Cloudflare R2 대시보드에서 `db/` 아래 최신
   `review-system-*.dump` 다운로드 (또는 `aws s3 cp --endpoint-url https://<계정ID>.r2.cloudflarestorage.com ...`)
3. **복원**:
   ```bash
   pg_restore --no-owner --no-privileges --exit-on-error \
     --dbname "새_DATABASE_URL" review-system-YYYYMMDD-HHMMSS.dump
   ```
4. **검증** — 핵심 테이블 행 수 확인:
   ```sql
   SELECT 'reviewers' t, count(*) FROM reviewers
   UNION ALL SELECT 'review_index', count(*) FROM review_index
   UNION ALL SELECT 'tab_configs', count(*) FROM tab_configs
   UNION ALL SELECT 'work_orders', count(*) FROM work_orders;
   ```
5. **앱 연결 전환** — API 서비스의 `DATABASE_URL`을 새 DB로 교체 → 재배포 →
   `/health` 확인.
6. **유실 구간 인지** — 마지막 백업(03:00 KST) 이후 데이터는 이 백업에 없음.
   sync_queue 기반 Google Sheets 사본과 대조하여 수동 보정.

---

## 3. 업로드 파일 백업 (Google Drive → R2)

사용자 업로드 이미지(구매캡처/리뷰)는 DB가 아니라 **Google Drive**에 저장된다
(`drive.service.js`, OAuth refresh token으로 사용자 계정 스토리지 사용).
Drive 폴더 실수 삭제·OAuth 토큰/계정 사고 시 유실되므로, DB와 동일하게
**같은 R2 버킷의 `drive/` prefix**로 매일 독립 복사한다.

| 워크플로우 | 파일 | 주기 | 방식 |
|---|---|---|---|
| Drive Files Backup | `.github/workflows/drive-backup.yml` | 매일 03:30 KST | rclone `copy`(additive) — Drive 삭제분도 R2엔 보존 |

### 3-1. 추가 설정 (1회) — GitHub Secrets 4개

DB 백업용 R2 시크릿(`R2_*`)은 그대로 재사용하고, Drive 접근용으로 아래를 추가한다.
세 OAuth 값은 **Railway 환경변수에 이미 있는 동일 값**을 그대로 복사:

| Secret | 값 |
|---|---|
| `DRIVE_OAUTH_CLIENT_ID` | Railway의 `DRIVE_OAUTH_CLIENT_ID` |
| `DRIVE_OAUTH_CLIENT_SECRET` | Railway의 `DRIVE_OAUTH_CLIENT_SECRET` |
| `DRIVE_OAUTH_REFRESH_TOKEN` | Railway의 `DRIVE_OAUTH_REFRESH_TOKEN` |
| `DRIVE_BACKUP_FOLDER_ID` | 백업할 루트 폴더 ID (아래 참고) |

**`DRIVE_BACKUP_FOLDER_ID` 정하는 법**: 운영에서 `AI_REVIEW_FOLDER_ID`가 설정돼
있으면 그 값을, 비어 있으면 `DRIVE_ROOT_FOLDER_ID`(`1afBtCDYs-A-LenIKhsiKJWvkuFmUYV8d`)를
쓴다. Google Drive에서 그 루트 폴더를 열었을 때 URL의 `/folders/` 뒤 문자열이 폴더 ID다.
(두 루트가 모두 쓰이고 있다면 둘을 모두 포함하는 공통 상위 폴더 ID를 지정.)

### 3-2. 동작 확인

Actions → **Drive Files Backup** → Run workflow → 성공 시 R2 버킷 `drive/` 아래에
Drive와 동일한 폴더 구조로 파일이 복사된다. Summary 탭에 총 용량/파일 수가 찍힌다.

### 3-3. 복구 방법

특정 파일/폴더를 되돌릴 때 (rclone 설정은 워크플로우 env와 동일하게 구성):

```bash
# R2 → Drive 전체 복원
rclone copy "r2:<버킷>/drive" gdrive:
# 또는 로컬로 내려받기
rclone copy "r2:<버킷>/drive" ./drive-restore
```

> 참고: DB 덤프와 달리 이미지 파일은 구조 검증이 불필요해 별도 복구 리허설
> 워크플로우는 두지 않았다. 무결성은 rclone의 size/해시 비교로 충분.

---

## 4. 한계와 후속 과제

- **RPO 최대 24시간**: 일일 백업이므로 마지막 덤프 이후 데이터는 유실된다.
  → Railway **PITR(Pro, 옵트인)** 을 함께 켤 것. 일상 사고(테이블 실수 삭제)는 PITR이 1차 수단,
  이 외부 백업은 Railway 자체가 무너졌을 때의 최후 수단. 보완재 관계.
- **복구 리허설은 자동화되어 있지만**, 실제 장애 대응(런북 2번)을 사람 손으로
  처음부터 끝까지 1회 수행해보는 것을 권장 — 소요 시간을 측정해 둘 것.
- **Drive 백업은 단방향 additive**: 같은 경로 파일이 *수정*되면 R2 사본도 덮어쓴다
  (리뷰 이미지는 write-once라 실무상 문제 없음). 버전 이력이 필요해지면
  rclone `--backup-dir`로 세대 보관을 추가할 수 있다.
