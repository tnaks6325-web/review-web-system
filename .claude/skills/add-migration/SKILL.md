---
name: add-migration
description: Write a database migration for review-web-system that is safe under BOTH migration runners. Migrations must be idempotent because npm run migrate re-runs every .sql every time, while the server startup runner applies only new files. Use whenever you add/alter a table, column, index, or constraint.
---

# 마이그레이션 작성 절차 (review-web-system)

## 왜 idempotent가 필수인가 — 러너가 2개

- **서버 기동 시** (`server/index.js`의 `runMigrations()`): `_migrations` 테이블로 적용 이력을 추적해 **새 파일만** 실행. `already exists`/`duplicate` 류 에러는 무해 처리하고 적용 완료로 기록.
- **수동** (`npm run migrate` → `server/src/db/migrate.js`): **이력을 무시하고 매번 전체 .sql을 재실행**. 여기서 에러가 나면 throw하고 중단.

→ 두 경로 모두에서 안전하려면 **재실행해도 에러 없이 같은 결과**여야 합니다.

## 파일 위치·이름

- 위치: `server/migrations/`
- 이름: `NNN_설명.sql` (3자리 zero-padded). 적용 순서는 **파일명 알파벳 정렬**입니다.
- ⚠️ **번호 충돌 주의**: 현재 `025_` 접두사 파일이 둘 있습니다(`025_fix_sub_accounts_double_encoding.sql`, `025_participation_links.sql`). 새 파일은 **다음 빈 번호(026~)**를 쓰고, 정렬 순서가 의존성과 맞는지(선행 마이그레이션 뒤에 오는지) 확인하세요.

## idempotent 패턴 (이것만 사용)

```sql
-- 테이블
CREATE TABLE IF NOT EXISTS my_table (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 컬럼 추가
ALTER TABLE my_table ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_my_table_created ON my_table(created_at DESC);

-- 시드/초기행
INSERT INTO my_table (id) VALUES (...) ON CONFLICT DO NOTHING;
```

피해야 할 비-idempotent 구문(재실행 시 실패):
- `CREATE TABLE`(IF NOT EXISTS 없이), `ALTER TABLE ... ADD COLUMN`(IF NOT EXISTS 없이)
- `CREATE INDEX`(IF NOT EXISTS 없이), 무조건 `INSERT`(ON CONFLICT 없이)
- `ADD CONSTRAINT` / `CREATE TYPE` 등 IF NOT EXISTS를 직접 못 쓰는 구문은 `DO $$ ... IF NOT EXISTS (...) THEN ... END $$;` 가드 또는 카탈로그(`information_schema`/`pg_*`) 체크로 감싸세요.

## 데이터 백필 시

- 부분 적용/재실행을 고려해 **WHERE 조건으로 이미 처리된 행을 건너뛰도록** 작성(예: `WHERE col IS NULL`).
- 대량 백필은 가능한 한 단일 UPDATE로, 부작용 없이 재실행 가능하게.

## 코드 측 안전장치 관례

일부 라우트는 마이그레이션 누락에 대비해 런타임에 `CREATE TABLE IF NOT EXISTS`로 테이블을 보강합니다(예: `order.routes.js`의 `_ensureTables()`). 새 테이블이 핵심 경로라면 이 패턴을 참고하되, **정식 마이그레이션 파일이 단일 진실 소스**입니다. 둘을 둔다면 스키마를 일치시키세요.

## 검증

```bash
cd server
npm run migrate     # 로컬 DB에 전체 재실행 — 에러 없이 통과해야 함
npm run migrate     # ★ 한 번 더 — 재실행해도 에러 없어야 idempotent 확인
```

체크리스트:
- [ ] 파일명 번호가 다음 빈 번호이고 정렬 순서가 맞다
- [ ] 모든 DDL이 `IF NOT EXISTS`/`ON CONFLICT`/가드로 보호된다
- [ ] `npm run migrate`를 연속 2회 돌려도 에러 없음
- [ ] 이 스키마를 쓰는 코드(라우트/서비스)도 함께 추가/수정됨
