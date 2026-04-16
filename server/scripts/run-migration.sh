#!/bin/bash
# ═══════════════════════════════════════════════════════════
# 리뷰웹시스템 — 데이터 마이그레이션 실행 스크립트
# 
# 사전 요구:
#   1. DATABASE_URL 환경변수 설정
#   2. GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY 설정
#   3. BASE_SHEET_ID 설정
#
# 실행 순서:
#   1. PostgreSQL DDL (테이블 생성)
#   2. 세부목록 → tab_configs 마이그레이션
#   3. 인애드명단 → reviewers 마이그레이션
#   4. 인덱스 전체 재빌드 (POST /api/index/build)
#   5. 관리자 계정 시드 (선택)
# ═══════════════════════════════════════════════════════════

set -e

echo "═══════════════════════════════════════════"
echo "  리뷰웹시스템 데이터 마이그레이션 v2.0"
echo "═══════════════════════════════════════════"

# 환경변수 확인
if [ -z "$DATABASE_URL" ]; then
  echo "❌ DATABASE_URL이 설정되지 않았습니다."
  echo "   export DATABASE_URL=postgresql://user:password@host:5432/review_system"
  exit 1
fi

echo "✅ DATABASE_URL: ${DATABASE_URL:0:30}..."
echo ""

# Step 1: DDL 실행
echo "═══ Step 1: PostgreSQL 테이블 생성 ═══"
cd "$(dirname "$0")/.."
node src/db/migrate.js
echo ""

# Step 2: 세부목록 마이그레이션
echo "═══ Step 2: 세부목록 → tab_configs ═══"
if [ -z "$BASE_SHEET_ID" ]; then
  echo "⚠️  BASE_SHEET_ID 미설정 — 세부목록 마이그레이션 스킵"
else
  node scripts/migrate-detail.js
fi
echo ""

# Step 3: 리뷰어 마이그레이션
echo "═══ Step 3: 인애드명단 → reviewers ═══"
if [ -z "$BASE_SHEET_ID" ]; then
  echo "⚠️  BASE_SHEET_ID 미설정 — 리뷰어 마이그레이션 스킵"
else
  node scripts/migrate-reviewers.js
fi
echo ""

# Step 4: 인덱스 재빌드 (서버가 실행 중이어야 함)
echo "═══ Step 4: 인덱스 전체 재빌드 ═══"
echo "⚠️  서버가 실행 중일 때 아래 명령으로 재빌드:"
echo "   curl -X POST http://localhost:3000/api/index/build \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -H 'Authorization: Bearer <your-jwt-token>' \\"
echo "     -d '{\"forceFullRebuild\": true}'"
echo ""

# Step 5: 초기 관리자 계정 시드 (선택)
echo "═══ Step 5: 초기 관리자 계정 (선택) ═══"
echo "마스터 계정은 환경변수로 관리됩니다:"
echo "  MASTER_ADMIN_NAME=master"
echo "  MASTER_ADMIN_PW=931118"
echo ""
echo "추가 관리자를 DB에 직접 시드하려면:"
echo "  node -e \"const b=require('bcryptjs');b.hash('931118',10).then(h=>console.log('INSERT INTO admin_users (username,pw_hash,role) VALUES (\\'박세희\\',\\''+h+'\\',\\'admin\\');'))\""
echo ""

echo "═══════════════════════════════════════════"
echo "  마이그레이션 완료"
echo "═══════════════════════════════════════════"
