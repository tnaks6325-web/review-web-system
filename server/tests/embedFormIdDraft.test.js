'use strict';
// 구매양식 입력값 초안은 칸 아이디(id)로 저장·복원한다 — 칸 순서·위치가 바뀌어도 값이 엉뚱한 칸에 들어가지 않는다.
// 옛 위치 배열 초안은 화면 배치 번호(_EMBED_FORM_LAYOUT)가 1이고 칸 개수가 같을 때만 한 번 옮긴다.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');
function fn(name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, name);
  const ends = ['\nfunction ', '\nasync function ', '\n/**', '\nconst '].map(x => source.indexOf(x, start + 1)).filter(x => x >= 0);
  return source.slice(start, Math.min(...ends));
}
function constLine(name) {
  const m = source.match(new RegExp('^const ' + name + ' = [^\\n]+$', 'm'));
  assert(m, name);
  return m[0].replace(/^const /, 'var ');
}

function makeField(id, type = 'text', value = '') { return { id, type, value, checked: false }; }
function harness(fieldsInOrder, search = '') {
  const store = new Map();
  const scr = { querySelectorAll: () => fieldsInOrder };
  const ctx = {
    _EMBED_CTX: { app: 'APP1' }, _BATCH: null, location: { search },
    URLSearchParams,
    sessionStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    document: { getElementById: id => (id === 'screenOrderForm' ? scr : null) },
    JSON, Object, Array,
  };
  vm.createContext(ctx);
  vm.runInContext([constLine('_EMBED_FORM_KEY'), constLine('_EMBED_FORM_LAYOUT'), constLine('_EMBED_FORM_ID_KEY'),
    fn('_embedFormFields'), fn('_embedSaveForm'), fn('_embedFillField'), fn('_embedRestoreForm')].join('\n'), ctx);
  return { ctx, store };
}

// 1) 저장은 아이디 키에 {아이디: 값}. 파일 칸·아이디 없는 칸은 빠진다. 옛 위치 키는 지운다.
{
  const order = [makeField('oc_0_orderNumber', 'text', 'A-1'), makeField('oc_0_price', 'text', '10,000'),
    makeField('', 'text', '이름없음'), makeField('oc_0_file', 'file', 'x.jpg'), makeField('oc_0_saveIdChk', 'checkbox')];
  order[4].checked = true;
  const { ctx, store } = harness(order);
  store.set('embedForm_APP1', JSON.stringify(['old']));
  ctx._embedSaveForm();
  assert.equal(store.has('embedForm_APP1'), false, '옛 위치 초안은 지운다');
  const saved = JSON.parse(store.get('embedForm_APP1:id'));
  assert.equal(saved.layout, 1);
  assert.deepEqual(saved.fields, { oc_0_orderNumber: 'A-1', oc_0_price: '10,000', oc_0_saveIdChk: '1' });
  console.log('PASS 아이디 기준 저장 / 파일·아이디 없는 칸 제외 / 옛 위치 초안 정리');
}

// 2) 칸 순서가 바뀌어도 같은 칸에 돌아간다. 이미 값이 있는 칸은 덮어쓰지 않는다.
{
  const before = [makeField('oc_0_price', 'text', '10,000'), makeField('of_account', 'text', '111-22'), makeField('oc_0_memo', 'textarea', '메모')];
  const a = harness(before); a.ctx._embedSaveForm();
  const after = [makeField('of_account'), makeField('oc_0_memo', 'textarea', '이미 씀'), makeField('oc_0_price')];   // 순서가 바뀐 새 화면
  const b = harness(after); b.store.set('embedForm_APP1:id', a.store.get('embedForm_APP1:id'));
  b.ctx._embedRestoreForm();
  assert.equal(after[0].value, '111-22', '계좌 칸에는 계좌');
  assert.equal(after[2].value, '10,000', '결제금액 칸에는 결제금액');
  assert.equal(after[1].value, '이미 씀', '이미 값 있는 칸은 그대로');
  console.log('PASS 칸 순서가 바뀌어도 같은 칸으로 복원 / 기존 값 미덮어씀');
}

// 3) 옛 위치 초안: 배치 1 + 칸 개수가 같을 때만 위치대로 옮기고, 아이디 초안으로 바꿔 둔다.
{
  const els = [makeField('oc_0_orderNumber'), makeField('oc_0_price'), makeField('oc_0_saveIdChk', 'checkbox')];
  const { ctx, store } = harness(els);
  store.set('embedForm_APP1', JSON.stringify(['A-9', '9,900', '1']));
  ctx._embedRestoreForm();
  assert.equal(els[0].value, 'A-9'); assert.equal(els[1].value, '9,900'); assert.equal(els[2].checked, true);
  assert.equal(store.has('embedForm_APP1'), false, '옛 초안은 한 번만');
  assert.deepEqual(JSON.parse(store.get('embedForm_APP1:id')).fields, { oc_0_orderNumber: 'A-9', oc_0_price: '9,900', oc_0_saveIdChk: '1' });
  console.log('PASS 옛 위치 초안은 같은 배치일 때 한 번 옮겨 아이디 초안으로');
}
{
  const els = [makeField('oc_0_orderNumber'), makeField('oc_0_price')];
  const { ctx, store } = harness(els);
  store.set('embedForm_APP1', JSON.stringify(['A-9', '9,900', '1']));   // 칸 개수 다름 = 위치 어긋남
  ctx._embedRestoreForm();
  assert.equal(els[0].value, ''); assert.equal(els[1].value, '');
  assert.equal(store.has('embedForm_APP1'), false, '어긋난 옛 초안은 버린다');
  console.log('PASS 칸 개수가 다른 옛 위치 초안은 넣지 않고 버린다');
}

// 4) 배치 번호를 올리면 옛 위치 초안은 읽지 않는다 — 칸 배치를 바꾸는 변경이 지켜야 할 약속.
{
  const els = [makeField('oc_0_orderNumber'), makeField('oc_0_price')];
  const { ctx, store } = harness(els);
  vm.runInContext('_EMBED_FORM_LAYOUT = 2;', ctx);
  store.set('embedForm_APP1', JSON.stringify(['A-9', '9,900']));
  ctx._embedRestoreForm();
  assert.equal(els[0].value, ''); assert.equal(els[1].value, '');
  console.log('PASS 배치 번호를 올리면 옛 위치 초안은 버린다');
}

// 5) 동시진행(dual=1)·배치·미리보기는 종전대로 이 초안을 쓰지 않는다.
{
  const els = [makeField('oc_0_price', 'text', '1')];
  const d = harness(els, '?dual=1'); d.ctx._embedSaveForm(); assert.equal(d.store.size, 0, '동시진행은 저장 안 함');
  const bt = harness(els); bt.ctx._BATCH = { holds: [] }; bt.ctx._embedSaveForm(); assert.equal(bt.store.size, 0, '배치는 저장 안 함');
  const pv = harness(els); pv.ctx._EMBED_CTX = { app: 'APP1', preview: true };
  vm.runInContext([constLine('_EMBED_FORM_KEY'), constLine('_EMBED_FORM_ID_KEY')].join('\n'), pv.ctx);
  pv.ctx._embedSaveForm(); assert.equal(pv.store.size, 0, '미리보기는 저장 안 함');
  console.log('PASS 동시진행·배치·미리보기는 이 초안을 쓰지 않음');
}

// 6) 제출 완료 때 두 초안을 함께 지운다(새 아이디 초안이 남아 다음 주문에 되살아나지 않게).
assert(/sessionStorage\.removeItem\(_EMBED_FORM_KEY\); if \(_EMBED_FORM_ID_KEY\) sessionStorage\.removeItem\(_EMBED_FORM_ID_KEY\);/.test(source), '제출 완료 시 아이디 초안도 지움');
console.log('PASS 제출 완료 시 옛·새 초안 모두 정리');
