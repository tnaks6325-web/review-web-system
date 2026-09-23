const trackBService = require('../services/trackB.service');

/**
 * 탭 설정 쓰기 권한.
 *
 * master/admin 은 전체 탭, staff 는 담당 업체에 연결된 탭만 수정할 수 있다.
 * 광고주 등 외부 역할은 앞단 internalOnlyMiddleware 와 별개로 여기서도 닫는다.
 * Track B 프록시가 원본 라우트의 마지막 핸들러만 위임하던 과거 구조에서도
 * 같은 범위를 적용할 수 있도록 독립 미들웨어로 둔다.
 */
async function tabConfigWriteScopeMiddleware(req, res, next) {
  try {
    const role = req.admin && req.admin.role;
    if (role === 'master' || role === 'admin') return next();
    if (role !== 'staff') {
      return res.status(403).json({ error: '내부 담당자 권한이 필요합니다.' });
    }

    const sheetId = String((req.body && req.body.sheetId) || '').trim();
    const tabName = String((req.body && req.body.tabName) || '').trim();
    if (!sheetId || !tabName) return next(); // 실제 핸들러의 기존 입력 오류 응답 유지

    const allowed = await trackBService.canAccessTab({
      role: 'staff',
      staffName: (req.admin && req.admin.name) || '',
      sheetId,
      tabName,
    });
    if (!allowed) {
      return res.status(403).json({ error: '담당 탭만 수정할 수 있습니다.' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { tabConfigWriteScopeMiddleware };
