// ═══════════════════════════════════════════════════════════
// 작업탭 등록 단일경로 정책 (TAB_REGISTRATION_MODE)
//   'order'  (기본): 신규 시트/탭 등록 = 작업오더 접수(POST /api/order/accept)만.
//                    스마트빌드·전체빌드·동기화의 자동 신규등록, 관리자 수동
//                    등록(작업시트추가/새 시트생성 즉시등록) 모두 차단.
//   'manual' : + 관리자 수동 등록(add-tab/add-campaign, 새 시트생성 즉시등록) 허용.
//   'auto'   : 레거시 전체 허용(자동발견 포함) — 롤백용.
// 예외(모드 무관): 아카이브 복구, DB 재구축(재해복구 syncTabListToDB{allowNewTabs:true}),
//   탭명·gid 교정(sync-tab-names/리네임)은 "복원·교정"이라 항상 동작.
// ═══════════════════════════════════════════════════════════

const VALID_MODES = ['order', 'manual', 'auto'];

/** 현재 등록 모드 ('order' | 'manual' | 'auto') — 미설정/오타는 'order' */
function getTabRegistrationMode() {
  const raw = String(process.env.TAB_REGISTRATION_MODE || '').trim().toLowerCase();
  return VALID_MODES.includes(raw) ? raw : 'order';
}

/** 자동 신규등록(스마트빌드/전체빌드/동기화) 허용 여부 */
function allowAutoRegister() {
  return getTabRegistrationMode() === 'auto';
}

/** 관리자 수동 신규등록(작업시트추가/새 시트생성 즉시등록) 허용 여부 */
function allowManualRegister() {
  return getTabRegistrationMode() !== 'order';
}

const REGISTER_GUIDE_MSG = '신규 탭 등록은 작업오더 접수로만 가능합니다. (작업 오더 탭 → 접수하기)';

module.exports = {
  getTabRegistrationMode,
  allowAutoRegister,
  allowManualRegister,
  REGISTER_GUIDE_MSG,
};
