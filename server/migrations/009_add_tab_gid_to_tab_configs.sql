-- ═══════════════════════════════════════════════════════════
-- Migration 009: tab_configs에 tab_gid 컬럼 추가
-- 
-- 목적: 마스터시트 스캔 시 수집한 tab_gid를 DB에 저장하여
--       대시보드에서 정확한 탭 URL(sheet_url#gid=xxx)을 구성할 수 있도록 함
-- 
-- 기존: index_master에만 tab_gid 존재 → 인덱스 빌드된 탭만 gid 보유
-- 변경: tab_configs에도 tab_gid 추가 → 모든 탭이 gid 보유 가능
-- ═══════════════════════════════════════════════════════════

ALTER TABLE tab_configs ADD COLUMN IF NOT EXISTS tab_gid TEXT;
