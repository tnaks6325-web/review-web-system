/* 주문 취소 내력(canceled_by·deleted_at) 진단 노출 가드.
 *
 * 왜: `mirror_status='canceled'` 를 만들 수 있는 경로가 넷(관리자 주문취소 · 리뷰어
 *     비정상로그 [취소 처리] · 중복 줄 정리 · 테스트 탭 초기화)인데, **어느 API 도
 *     "누가 취소했는지"를 돌려주지 않아** 취소된 주문을 만나면 원인 추적이 막다른 길이었다
 *     (2026-08-19 위프 800건 유재휘 건 — 링크 오염과 취소 중 무엇이 먼저인지 확정 불가).
 *
 * ★★ 붙이는 곳은 **JSON 응답뿐** — 이 라우트의 CSV 는 직원이 시트에 붙여넣는 산출물이라
 *    열 구성이 바뀌면 그 작업이 어긋난다. CSV 는 `head` 배열이 칸을 정하므로 SELECT 를
 *    늘려도 영향이 없고, 이 가드가 그 배열의 **칸 수와 구성**을 고정한다.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
let n = 0;
const ok = (m, c) => { assert.ok(c, m); console.log('  ✓ ' + m); n++; };

const src = fs.readFileSync(path.join(__dirname, '../src/routes/diag.routes.js'), 'utf8');
const i = src.indexOf("router.get('/order-stuck-export'");
assert.ok(i > 0, 'order-stuck-export 라우트를 찾지 못했다');
const body = src.slice(i, src.indexOf("router.", i + 50));

ok('★ 취소 내력을 JSON 으로 내려준다(누가 취소했는지 추적 가능)',
  /os\.canceled_by AS "canceledBy"/.test(body) && /os\.deleted_at AS "deletedAt"/.test(body));

/* CSV 열 구성 고정 — 늘리거나 순서를 바꾸면 직원 붙여넣기가 어긋난다. */
const headM = /const head = \[([^\]]+)\]/.exec(body);
assert.ok(headM, 'CSV head 배열을 찾지 못했다');
const head = headM[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
ok('★ CSV 는 15칸 그대로(진단 필드가 새어 나가지 않는다)', head.length === 15);
ok('★ CSV 마지막 칸은 제출시각 — 뒤에 덧붙지 않았다', head[head.length - 1] === '제출시각(KST)');
ok('★ CSV 에 취소 내력이 없다(PII·운영 산출물 불변)',
  !head.some(h => /취소|삭제/.test(h)));

ok('진단은 읽기 전용 — 이 라우트에 쓰기 쿼리가 없다',
  !/\b(UPDATE|INSERT|DELETE)\s+order_submissions/i.test(body));

console.log(`\n✅ orderCancelProvenance: ${n}개 통과`);
