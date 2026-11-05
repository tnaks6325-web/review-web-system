'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const foundation = () => require('../src/utils/dualChannel');

function product() {
  return {
    name: '같은 상품', product_mode: 'none', options: [],
    base: { pay: 19800, count: 7, daily: 2 },
    channels: {
      coupang: { url: 'https://short.example/c', pay: 9900, inflow_type: 'link', guide: { text: '', images: [] } },
      naver: { url: 'https://short.example/n', pay: 9900, inflow_type: 'guide', guide: { text: '검색 안내', images: [] } },
    },
    extra: { preserve: true },
  };
}

function rejects(list, message) {
  const { normalizeChannelProductList, DualChannelError } = foundation();
  assert.throws(() => normalizeChannelProductList(list), error => {
    assert.ok(error instanceof DualChannelError);
    assert.equal(error.name, 'DualChannelError');
    assert.equal(error.code, 'invalid_dual_channel');
    assert.match(error.message, /[가-힣]/);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function invalidCase(name, change, message) {
  test(name, () => {
    const p = product();
    change(p);
    rejects([p], message);
  });
}

for (const [naver, coupang, total] of [[9900, 9900, 19800], [9000, 10000, 19000], [0, 0, 0], [100000000, 0, 100000000]]) {
  test(`금액 숫자 정규화와 합계 검증: ${naver}+${coupang}=${total}`, () => {
    const p = product();
    p.channels.naver.pay = ` ${naver} `;
    p.channels.coupang.pay = coupang;
    p.base.pay = ` ${total} `;
    p.base.count = ' 0007 ';
    const [result] = foundation().normalizeChannelProductList([p]);
    assert.equal(result.channels.naver.pay, naver);
    assert.equal(result.channels.coupang.pay, coupang);
    assert.equal(result.base.pay, total);
    assert.equal(result.base.count, 7);
    assert.equal(result.base.daily, 2);
  });
}

test('인원 상한도 두 배로 만들지 않고 보존한다', () => {
  const p = product();
  p.base.count = '100000';
  assert.equal(foundation().normalizeChannelProductList([p])[0].base.count, 100000);
});

for (const path of ['naver', 'coupang', 'base']) {
  for (const [name, value] of [
    ['누락값', undefined], ['null', null], ['true', true], ['false', false],
    ['빈문자열', ''], ['공백', '  '], ['소수숫자', 1.5], ['소수문자열', '1.0'],
    ['음수숫자', -1], ['음수문자열', '-1'], ['지수문자열', '1e3'],
    ['16진문자열', '0x10'], ['양수부호', '+1'], ['쉼표', '9,900'],
    ['숫자안공백', '9 900'], ['안전범위초과', 9007199254740992],
    ['안전범위초과문자열', '9007199254740993'], ['상한초과', 100000001],
    ['NaN', NaN], ['무한대', Infinity], ['객체', {}], ['배열', [9900]], ['BigInt', 9900n],
  ]) invalidCase(`${path} 결제금액 거부: ${name}`, p => {
    (path === 'base' ? p.base : p.channels[path]).pay = value;
  }, /금액/);
  invalidCase(`${path} 결제금액 키 누락`, p => {
    delete (path === 'base' ? p.base : p.channels[path]).pay;
  }, /금액/);
}

for (const [name, value] of [
  ['누락값', undefined], ['null', null], ['true', true], ['false', false],
  ['빈문자열', ''], ['공백', ' '], ['0명', 0], ['0명문자열', '0'],
  ['음수', -1], ['소수', 1.5], ['소수문자열', '1.0'], ['지수문자열', '1e3'],
  ['상한초과', 100001], ['안전범위초과', '9007199254740993'], ['NaN', NaN],
  ['무한대', Infinity], ['객체', {}], ['배열', [7]], ['양수부호', '+7'],
]) invalidCase(`모집인원 거부: ${name}`, p => { p.base.count = value; }, /인원/);

invalidCase('합계가 다르면 자동 수정 대신 거부한다', p => { p.base.pay = 9900; }, /합계/);

test('합계 오류가 발생해도 원본 금액과 인원은 바꾸지 않는다', () => {
  const p = product();
  p.base.pay = '9900';
  p.base.count = '7';
  const before = JSON.stringify(p);
  rejects([p], /합계/);
  assert.equal(JSON.stringify(p), before);
});

for (const path of ['naver', 'coupang']) {
  for (const [name, value] of [
    ['누락값', undefined], ['null', null], ['숫자', 1], ['객체', {}], ['배열', []],
    ['빈문자열', ''], ['공백', ' \n '], ['자바스크립트', 'javascript:alert(1)'],
    ['data', 'data:text/html,hello'], ['ftp', 'ftp://example.test/p'], ['file', 'file:///etc/hosts'],
    ['상대경로', '/item/1'], ['프로토콜상대', '//example.test/p'], ['호스트누락', 'https://'],
    ['잘못된호스트', 'https://bad host/p'], ['슬래시누락', 'https:/example.test/p'],
    ['사용자명', 'https://user@example.test/p'], ['비밀번호', 'https://:pass@example.test/p'],
    ['사용자명비밀번호', 'https://user:pass@example.test/p'], ['인코딩된자격', 'https://u%40x:p@example.test/p'],
    ['2049자', 'https://example.test/' + 'x'.repeat(2049 - 'https://example.test/'.length)],
  ]) invalidCase(`${path} 상품 주소 거부: ${name}`, p => { p.channels[path].url = value; }, /주소/);
  invalidCase(`${path} 상품 주소 키 누락`, p => { delete p.channels[path].url; }, /주소/);
}

test('단축 주소와 http를 허용하며 앞뒤만 trim하고 URL href로 바꾸지 않는다', () => {
  const p = product();
  p.channels.naver.url = '  HTTPS://Short.Example:443/a%2fb?q=%2f#Part  ';
  p.channels.coupang.url = '\nhttp://localhost:8080/short\t';
  const [result] = foundation().normalizeChannelProductList([p]);
  assert.equal(result.channels.naver.url, 'HTTPS://Short.Example:443/a%2fb?q=%2f#Part');
  assert.equal(result.channels.coupang.url, 'http://localhost:8080/short');
  assert.equal(p.channels.naver.url, '  HTTPS://Short.Example:443/a%2fb?q=%2f#Part  ');
});

for (const channel of ['naver', 'coupang']) {
  for (const field of ['url', 'image']) {
    test(`${channel} ${field} 내부 제어문자를 거부하고 원본과 오류 비노출을 지킨다`, () => {
      for (const code of [10, 9, 13, ...[...Array(32).keys()].filter(n => ![10, 9, 13].includes(n)), 127]) {
        const p = product();
        const url = 'https://shop.example/private-url-marker' + String.fromCharCode(code) + 'item';
        if (field === 'url') p.channels[channel].url = url;
        else p.channels[channel].guide.images = [url];
        const before = JSON.stringify(p);
        assert.throws(() => foundation().normalizeChannelProductList([p]), error => {
          assert.equal(error.code, 'invalid_dual_channel');
          assert.match(error.message, /주소/);
          assert.ok(!error.message.includes(url));
          assert.doesNotMatch(error.message, /private-url-marker/);
          return true;
        }, `control ${code}`);
        assert.equal(JSON.stringify(p), before);
      }
    });
  }
}

test('인코딩된 제어문자 철자는 실제 제어문자와 구분하며 사진도 앞뒤만 trim한다', () => {
  const p = product();
  const url = 'HTTPS://Short.Example:443/a%0Ab%09c%00d%7f?q=%2f#Part';
  for (const channel of Object.values(p.channels)) {
    channel.url = '\n\t ' + url + ' \r\n';
    channel.guide.images = ['\n\t ' + url + ' \r\n'];
  }
  const before = JSON.stringify(p);
  const [result] = foundation().normalizeChannelProductList([p]);
  for (const channel of Object.values(result.channels)) {
    assert.equal(channel.url, url);
    assert.deepEqual(channel.guide.images, [url]);
  }
  assert.equal(JSON.stringify(p), before);
});

test('상품 주소는 trim 뒤 정확히 2048자까지 허용한다', () => {
  const p = product();
  const url = 'https://example.test/' + 'x'.repeat(2048 - 'https://example.test/'.length);
  assert.equal(url.length, 2048);
  p.channels.naver.url = ` ${url} `;
  assert.equal(foundation().normalizeChannelProductList([p])[0].channels.naver.url, url);
});

test('가이드·링크 혼합은 구매처별 안내를 따로 보존하고 생략한 링크 안내만 채운다', () => {
  const p = product();
  const text = '  첫 줄\r\n\n둘째 줄 \t ';
  p.channels.naver.guide = { text, images: [' https://Img.Example:443/a%2fb '] };
  delete p.channels.coupang.guide;
  const [result] = foundation().normalizeChannelProductList([p]);
  assert.equal(result.channels.naver.guide.text, text);
  assert.deepEqual(result.channels.naver.guide.images, ['https://Img.Example:443/a%2fb']);
  assert.deepEqual(result.channels.coupang.guide, { text: '', images: [] });
  assert.equal(Object.hasOwn(p.channels.coupang, 'guide'), false);
});

test('가이드유입은 글 없이 사진만 있어도 허용하며 네 장과 순서를 보존한다', () => {
  const p = product();
  p.channels.naver.guide = { text: ' \n ', images: [
    'https://img.test/4', 'http://img.test/3', 'https://img.test/3', 'https://img.test/1',
  ] };
  assert.deepEqual(foundation().normalizeChannelProductList([p])[0].channels.naver.guide, p.channels.naver.guide);
});

test('링크유입 두 곳은 가이드 생략과 빈 가이드를 모두 허용한다', () => {
  const p = product();
  p.channels.naver.inflow_type = 'link';
  delete p.channels.naver.guide;
  const [result] = foundation().normalizeChannelProductList([p]);
  assert.deepEqual(result.channels.naver.guide, { text: '', images: [] });
  assert.deepEqual(result.channels.coupang.guide, { text: '', images: [] });
  assert.notStrictEqual(result.channels.naver.guide, result.channels.coupang.guide);
});

test('null-prototype 가이드도 새 안내 객체와 사진 배열로 복사한다', () => {
  const p = product();
  p.channels.naver.guide = Object.assign(Object.create(null), { text: '안내', images: ['https://img.test/a'] });
  const [result] = foundation().normalizeChannelProductList([p]);
  assert.equal(result.channels.naver.guide.text, '안내');
  assert.notStrictEqual(result.channels.naver.guide, p.channels.naver.guide);
  assert.notStrictEqual(result.channels.naver.guide.images, p.channels.naver.guide.images);
});

for (const mode of ['guide', 'link']) {
  for (const [name, value] of [
    ['null', null], ['undefined', undefined], ['배열', []], ['문자열', '안내'], ['날짜', new Date(0)],
    ['빈객체', {}], ['text누락', { images: [] }], ['images누락', { text: '안내' }],
    ['text숫자', { text: 1, images: [] }], ['textNull', { text: null, images: [] }],
    ['imagesNull', { text: '안내', images: null }], ['images문자열', { text: '안내', images: 'https://img.test/a' }],
    ['images객체', { text: '안내', images: {} }],
    ['알수없는키', { text: '안내', images: [], html: '<b>안내</b>' }],
    ['사용자정의프로토타입', Object.assign(Object.create({}), { text: '안내', images: [] })],
  ]) invalidCase(`${mode} 제공한 가이드 거부: ${name}`, p => {
    p.channels.naver.inflow_type = mode;
    p.channels.naver.guide = value;
  }, /가이드/);
}

for (const [name, value] of [
  ['다섯장', Array.from({ length: 5 }, (_, i) => `https://img.test/${i}`)],
  ['null사진', [null]], ['숫자사진', [1]], ['객체사진', [{}]], ['빈사진', ['']],
  ['공백사진', ['  ']], ['상대주소', ['/img.png']], ['javascript사진', ['javascript:alert(1)']],
  ['data사진', ['data:image/png;base64,AAAA']], ['ftp사진', ['ftp://img.test/a']],
  ['사용자명사진', ['https://u@img.test/a']], ['비밀번호사진', ['https://:p@img.test/a']],
  ['잘못된호스트사진', ['https://bad host/a']], ['성긴배열', new Array(1)],
]) invalidCase(`가이드 사진 거부: ${name}`, p => { p.channels.naver.guide.images = value; }, /가이드/);

invalidCase('가이드유입 안내가 없으면 거부한다', p => { delete p.channels.naver.guide; }, /가이드/);
invalidCase('가이드유입 공백 글과 빈 사진은 거부한다', p => {
  p.channels.naver.guide = { text: ' \t\r\n ', images: [] };
}, /가이드/);
invalidCase('쿠팡도 가이드유입이면 자기 안내가 필수다', p => {
  p.channels.coupang.inflow_type = 'guide';
}, /쿠팡.*가이드/);

test('성공 시에도 얼린 입력의 금액·글·배열·그 밖의 값을 바꾸지 않는다', () => {
  const p = product();
  p.name = '  같은 상품  ';
  p.base.pay = '19800';
  p.base.count = '7';
  p.channels.naver.pay = '9900';
  p.channels.naver.guide.images = [' https://img.test/a '];
  const input = [p];
  const before = JSON.stringify(input);
  const freeze = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  freeze(input);
  const [result] = foundation().normalizeChannelProductList(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.name, p.name);
  assert.equal(result.base.daily, p.base.daily);
  assert.deepEqual(result.extra, p.extra);
  result.channels.naver.guide.images.push('https://img.test/b');
  assert.deepEqual(p.channels.naver.guide.images, [' https://img.test/a ']);
});

test('사진 주소 오류는 무한대 같은 내부값이나 입력한 로그인 정보를 노출하지 않는다', () => {
  const p = product();
  p.channels.naver.guide.images = ['https://private-user:private-pass@img.test/a'];
  assert.throws(() => foundation().normalizeChannelProductList([p]), error => {
    assert.match(error.message, /네이버.*가이드.*주소/);
    assert.doesNotMatch(error.message, /Infinity|private-user|private-pass/);
    return true;
  });
});

test('단일 상품을 새 객체로 만들고 구매처 순서는 네이버·쿠팡으로 고정한다', () => {
  const { normalizeChannelProductList } = foundation();
  const p = product();
  const input = [p];
  const result = normalizeChannelProductList(input);
  assert.notStrictEqual(result, input);
  assert.notStrictEqual(result[0], p);
  assert.notStrictEqual(result[0].base, p.base);
  assert.notStrictEqual(result[0].channels, p.channels);
  assert.deepEqual(Object.keys(result[0].channels), ['naver', 'coupang']);
  assert.deepEqual(result[0], { ...p, channels: { naver: p.channels.naver, coupang: p.channels.coupang } });
  assert.equal(result[0].base.count, 7, '사람 수를 두 배로 만들지 않는다');
});

test('구매처 설정이 있으면 상품은 정확히 한 개여야 한다', () => {
  rejects([product(), { name: '다른 상품' }], /상품/);
  rejects([product(), product()], /상품/);
});

test('정규화는 JSON 문자열이 아니라 이미 파싱한 배열만 받는다', () => {
  for (const value of [null, undefined, {}, '[]', JSON.stringify([product()])]) rejects(value, /배열/);
});

test('상속된 구매처 설정은 기존 상품에 새 기능을 켜지 않는다', () => {
  const list = [Object.assign(Object.create({ channels: null }), { name: '옛 상품' })];
  assert.strictEqual(foundation().normalizeChannelProductList(list), list);
});

for (const [name, change] of [
  ['상품명 누락', p => { delete p.name; }],
  ['빈 상품명', p => { p.name = ' \n '; }],
  ['숫자 상품명', p => { p.name = 1; }],
  ['옵션 방식 누락', p => { delete p.product_mode; }],
  ['옵션 있는 방식', p => { p.product_mode = 'opt'; }],
  ['옵션 방식 오타', p => { p.product_mode = 'None'; }],
  ['옵션 목록 누락', p => { delete p.options; }],
  ['옵션 목록 null', p => { p.options = null; }],
  ['옵션 목록 객체', p => { p.options = {}; }],
  ['옵션 한 개', p => { p.options = [{ label: '색상' }]; }],
  ['수량 단계 null도 거부', p => { p.qty_tiers = null; }],
  ['빈 수량 단계도 거부', p => { p.qty_tiers = { rows: [] }; }],
  ['수량 단계 undefined도 거부', p => { p.qty_tiers = undefined; }],
  ['여러 수량 단계 거부', p => { p.qty_tiers = { rows: [{ qty: 1 }, { qty: 2 }] }; }],
  ['마감된 상품', p => { p.closed = true; }],
  ['기본값 누락', p => { delete p.base; }],
  ['기본값 null', p => { p.base = null; }],
  ['기본값 배열', p => { p.base = []; }],
  ['기본값 날짜', p => { p.base = new Date(0); }],
  ['구매처 null', p => { p.channels = null; }],
  ['구매처 undefined', p => { p.channels = undefined; }],
  ['구매처 배열', p => { p.channels = []; }],
  ['구매처 날짜', p => { p.channels = new Date(0); }],
  ['구매처 문자열', p => { p.channels = 'naver,coupang'; }],
  ['구매처 하나 누락', p => { delete p.channels.coupang; }],
  ['구매처 세 개', p => { p.channels.other = p.channels.naver; }],
  ['구매처 이름 오타', p => { p.channels.cupang = p.channels.coupang; delete p.channels.coupang; }],
  ['구매처 사용자 정의 프로토타입', p => { p.channels = Object.assign(Object.create({}), p.channels); }],
  ['네이버 설정 null', p => { p.channels.naver = null; }],
  ['네이버 설정 배열', p => { p.channels.naver = []; }],
  ['네이버 설정 날짜', p => { p.channels.naver = new Date(0); }],
  ['쿠팡 설정 잘못된 자료형', p => { p.channels.coupang = true; }],
  ['구매처 설정 오타 키', p => { p.channels.naver.inflowType = 'link'; }],
  ['구매처 숨은 알 수 없는 키', p => { Object.defineProperty(p.channels, 'other', { value: {} }); }],
  ['구매처 설정 Symbol 키', p => { p.channels.naver[Symbol('extra')] = true; }],
  ['상품 전체 유입방식 폴백 금지', p => { p.inflow_type = 'guide'; delete p.channels.naver.inflow_type; }],
  ['빈 유입방식', p => { p.channels.naver.inflow_type = ''; }],
  ['유입방식 오타', p => { p.channels.naver.inflow_type = 'Guide'; }],
  ['유입방식 공백 허용 안함', p => { p.channels.naver.inflow_type = ' link '; }],
]) invalidCase(name, change);

test('구매처와 구매처 설정은 null-prototype JSON형 객체도 허용한다', () => {
  const p = product();
  p.channels = Object.assign(Object.create(null), p.channels);
  p.channels.naver = Object.assign(Object.create(null), p.channels.naver);
  assert.equal(foundation().normalizeChannelProductList([p])[0].channels.naver.pay, 9900);
});

test('원문 감지는 배열의 최상위 상품 own channels 키만 본다', () => {
  const { rawHasDualChannels } = foundation();
  for (const raw of [[{ channels: null }], '[{"channels":null}]', [{ channels: undefined }],
    [null, { channels: false }], [{ channels: {} }]]) {
    assert.equal(rawHasDualChannels(raw), true);
  }
  for (const raw of [undefined, null, '', false, 1, {}, 'bad json', '{}', 'null',
    '[{"channels":', [], '[{"meta":{"channels":{}}}]',
    [Object.create({ channels: {} })], [[{ channels: {} }]], [1, 'channels', null]]) {
    assert.equal(rawHasDualChannels(raw), false);
  }
});

test('구매처 키 없는 기존 배열은 같은 참조와 원문 그대로 보존한다', () => {
  const { normalizeChannelProductList } = foundation();
  const raw = '[ { "name": " 옛 상품 ", "base": {"pay":" 9900 "}, "options": [] } ]';
  const list = JSON.parse(raw);
  const before = JSON.stringify(list);
  assert.strictEqual(normalizeChannelProductList(list), list);
  assert.equal(JSON.stringify(list), before);
  assert.equal(list[0].base.pay, ' 9900 ');
  assert.equal(list[0].name, ' 옛 상품 ');
  for (const legacy of [[], [null, 1, 'old', { meta: { channels: null } }]]) {
    assert.strictEqual(normalizeChannelProductList(legacy), legacy);
  }
});
