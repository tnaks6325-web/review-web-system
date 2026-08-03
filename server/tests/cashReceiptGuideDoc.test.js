/**
 * cashReceiptGuideDoc.test.js — 직원 안내서 ↔ 실제 화면 드리프트 가드.
 *
 * `frontend/docs/현금영수증_발행방법_이미지_등록_안내.html`은 직원이 그대로 따라 하는 문서다.
 * 화면의 라벨·문구가 바뀌었는데 안내서가 옛말을 하고 있으면 직원이 없는 버튼을 찾게 된다.
 * 그래서 **안내서가 가르치는 문자열이 제품 소스에 실제로 존재하는지**를 고정한다.
 * (문서를 고칠 때가 아니라 화면을 고칠 때 이 테스트가 깨져서 안내서 갱신을 상기시킨다.)
 *
 * 실행: node tests/cashReceiptGuideDoc.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const doc = readF('docs/현금영수증_발행방법_이미지_등록_안내.html');
const adm = readF('admin.html');
const wd = readF('js/campaign-workdetail.js');
const app = readF('js/index-app.js');
const sapp = readF('js/search-app.js');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── 문서 형식(기존 직원 안내서와 동일 규칙) ── */
ok('완전한 HTML 문서 — 조각이 아니라 그대로 열리는 파일',
  /^<!DOCTYPE html>/i.test(doc.trim()) && /<html lang="ko">/.test(doc) && /<\/html>\s*$/.test(doc));
ok('제목이 있다', /<title>현금영수증 발행방법 이미지 등록 안내<\/title>/.test(doc));
ok('다크모드·인쇄 대응(기존 안내서와 동일)',
  /@media \(prefers-color-scheme: dark\)/.test(doc) && /@media print/.test(doc));
ok('★ 화면 재현 목업은 라이트 고정 — 다크에서 색이 뒤집히면 "실물과 같다"가 깨진다',
  /\.shot\{[\s\S]{0,80}color-scheme:light/.test(doc));
ok('외부 리소스 의존 없음(사내망·오프라인에서도 열림)',
  !/<img[^>]+src=/i.test(doc) && !/<script/i.test(doc) && !/https?:\/\/[^"']*\.(?:css|js)/i.test(doc));

/* ── 관리자 설정 화면: 안내서가 가리키는 항목이 실제로 있는가 ── */
ok('설정탭 섹션명이 실제와 일치',
  /회사 사업자번호 \(제공정보\)/.test(doc) && /회사 사업자번호 \(제공정보\)/.test(adm));
ok('발행방법 이미지 섹션명이 실제와 일치',
  /현금영수증 발행방법 이미지/.test(doc) && /현금영수증 발행방법 이미지/.test(adm));
ok('빈 상태 문구가 실제와 일치',
  /등록된 이미지가 없습니다/.test(doc) && /등록된 이미지가 없습니다/.test(adm));
/* ★ 안내서가 가르치는 채널 칸이 실제 설정 화면에 전부 있어야 한다.
   채널을 늘리면서 안내서를 안 고치면 직원이 "칸이 두 개뿐"이라고 알고 지나간다. */
const crChans = require('../src/utils/cashReceiptChannels');
ok('안내서의 채널 칸이 서버 단일 출처와 일치(라벨·아이콘)',
  crChans.CASH_RECEIPT_CHANNELS.every(c => doc.includes(`${c.icon} ${c.label}`)));
ok('그 채널들이 실제 설정 화면에도 전부 있다',
  crChans.CASH_RECEIPT_CHANNELS.every(c => {
    const cap = c.key.charAt(0).toUpperCase() + c.key.slice(1);
    return new RegExp(`crGuideFile${cap}`).test(adm);
  }) && /clearCashReceiptGuide/.test(adm));
ok('★ "두 칸" 같은 옛 개수 표현이 남아 있지 않다(채널이 늘면 개수를 못 박지 않는다)',
  !/두 칸 모두/.test(doc) && !/이미지 2장/.test(doc));
ok('진행하지 않는 채널은 비워도 된다는 안내(문구만 나간다)',
  /비워 두셔도 됩니다/.test(doc) && /사업자번호 문구만/.test(doc));
ok('"고르면 즉시 저장"이 사실 — onchange 업로드라 별도 저장 버튼이 없다',
  /고르는 즉시 업로드·저장/.test(doc) && /onchange="uploadCashReceiptGuide/.test(adm));
ok('5MB 상한이 실제 코드와 일치',
  /5MB 이하/.test(doc) && /file\.size > 5 \* 1024 \* 1024/.test(app));
ok('등록 완료 토스트 문구가 실제와 일치',
  /발행방법 이미지가 등록되었습니다/.test(doc) && /발행방법 이미지가 등록되었습니다/.test(app));

/* ── 리뷰어 화면: 안내서가 보여준 카드가 실제 렌더러와 같은 말을 하는가 ── */
ok('리뷰어 카드 제목이 실제 렌더러와 일치',
  /🧾 현금영수증 발행 안내 \(필수\)/.test(doc) && /🧾 현금영수증 발행 안내 \(필수\)/.test(wd));
ok('본문 문구가 실제 렌더러와 일치',
  /지출증빙 현금영수증<\/b>을 선택하고/.test(doc) && /지출증빙 현금영수증<\/b>을 선택하고/.test(wd));
ok('이미지 미등록 시 문구도 실제와 일치(안내서의 "등록 전" 설명 근거)',
  /안내된 사업자번호를 입력하세요/.test(doc) && /안내된 사업자번호를 입력하세요/.test(wd));
ok('경고 문구가 실제와 일치',
  /리뷰 제출 때 발행 내역 캡처가 필요해요/.test(doc) && /리뷰 제출 때 발행 내역 캡처가 필요해요/.test(wd));

/* ── 제출 화면(2슬롯 + AI 검수): 안내서가 예고한 대로인가 ── */
ok('슬롯 라벨(리뷰·현금영수증)이 서버 판정과 일치',
  /class="slot-tt">리뷰</.test(doc) && /class="slot-tt">현금영수증</.test(doc)
  && /label: '현금영수증'/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'captureSlots.js'), 'utf8')));
ok('드롭존 안내가 실제와 일치',
  /클릭 또는 드래그 · JPG\/PNG\/WebP/.test(doc) && /클릭 또는 드래그 · JPG\/PNG\/WebP/.test(sapp));
ok('AI 경고 부가문구가 실제와 일치',
  /다시 첨부하면 교체됩니다/.test(doc) && /다시 첨부하면 교체됩니다/.test(sapp));
ok('★★ "제출을 막지 않는다"가 안내서에 명시 — fail-open 정책을 직원이 오해하지 않게',
  /제출을 막지는 않습니다/.test(doc));

/* ── 조건 안내(오적용 방지) ── */
ok('현영 탭에만 적용된다는 사실을 안내',
  /진행방식/.test(doc) && /현영/.test(doc) && /사업자현영/.test(doc));

console.log(`\n✅ cashReceiptGuideDoc: ${n}개 통과`);
