const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const home = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const route = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'reviewEdit.routes.js'), 'utf8');

function ok(name, condition) {
  assert.ok(condition, name);
  console.log('✓', name);
}

console.log('\n리뷰어 구매캡처 조회 + 6버튼 배치');

const briefStart = route.indexOf("router.get('/participation-brief'");
const briefEnd = route.indexOf("router.post('/order-cancel'", briefStart);
const brief = route.slice(briefStart, briefEnd);

ok('행 소유권 검증 뒤에만 구매캡처를 조회한다',
  brief.indexOf('_verifyRowOwnership') >= 0 &&
  brief.indexOf('_verifyRowOwnership') < brief.indexOf('SELECT os.capture_file_id'));
ok('구매캡처는 현재 참여 행의 order_submission_id 앵커로만 연결한다',
  /JOIN order_submissions os\s+ON os\.id = cp\.order_submission_id/.test(brief) &&
  /cp\.deleted_at IS NULL/.test(brief) && /os\.deleted_at IS NULL/.test(brief));
ok('연결된 파일이 있을 때만 purchaseCapture를 응답한다',
  /COALESCE\(os\.capture_file_id, ''\) <> ''/.test(brief) &&
  /purchaseCapture,\s*\/\/ ★ 강한 행 소유권/.test(brief));

ok('참여중 버튼 그리드는 정확히 같은 폭의 2열이다',
  /\.part-info-grid\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/.test(home));
ok('320px대에서도 2열을 유지하며 버튼만 축소한다',
  /@media \(max-width:360px\)[\s\S]*?\.part-info-grid \{ gap:7px; \}/.test(home));

const renderStart = home.indexOf('function _partInfoRenderBtns(');
const renderEnd = home.indexOf('function _partInfoToggleSubmitPicker', renderStart);
const render = home.slice(renderStart, renderEnd);
['상품바로가기', '팀채팅방', '리뷰제출하기', '1:1문의하기', '구매캡처보기', '주문취소']
  .forEach((label) => ok('버튼 포함: ' + label, render.includes(label)));
ok('버튼 출력 순서는 요청한 2열×3행 순서다',
  /productBtn \+ chatBtn \+ submitBtn \+ csGridBtn \+ captureBtn \+ cancelGridBtn/.test(render));
ok('캡처가 없으면 구매캡처보기 버튼을 비활성화한다',
  /class="part-info-btn capture" disabled/.test(render));
ok('다건 리뷰 제출은 기존처럼 참여 건을 하나씩 선택한다',
  /_partInfoSubmit\(' \+ i \+ '\)/.test(render) && /이 참여 건만 리뷰 제출/.test(render));
ok('제출완료 현금영수증 버튼은 대기 항목이 있을 때만 보인다',
  /if \(submitItems\.length === 1\)[\s\S]*?현금영수증 제출하기/.test(render));
ok('제출완료 건에는 주문취소를 되살리지 않는다',
  /if \(done\)[\s\S]*?box\.innerHTML = html;\s*return;/.test(render) &&
  !render.slice(render.indexOf('if (done)'), render.indexOf('const productBtn')).includes('_partInfoCancelBtnHtml'));

ok('구매캡처 버튼은 기존 Drive 이미지 프록시를 사용한다',
  /function _partInfoOpenCapture\(\)/.test(home) &&
  /_reEditImgUrl\(_partInfoCaptureFileId\)/.test(home));
ok('구매캡처 모달을 닫으면 참여상품 정보 시트로 돌아간다',
  /function _partInfoCloseCapture\(\)[\s\S]*?partInfoOvl[\s\S]*?overflow = part/.test(home));

console.log('\n모든 구매캡처 조회/버튼 배치 가드 통과');
