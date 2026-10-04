#!/usr/bin/env node
/**
 * graphify(저장소 지도) 보조 — HTML 화면 파일 안에 직접 쓴 <script> 코드를 뽑아
 * graphify-inline/<원래경로>.js 로 저장한다. graphify 는 .html 속 코드를 읽지 않아서
 * workdesk.html(리뷰웹시스템[3버전]) 같은 핵심 화면이 지도에서 통째로 빠지기 때문이다.
 *
 * - 원본 HTML 은 읽기만 한다(수정 0).
 * - 코드 아닌 줄은 빈 줄로 채워 **줄 번호가 원본 HTML 과 같다** — 지도에서 본 줄 번호로 원본을 바로 찾는다.
 * - src 로 불러오는 스크립트·JSON·템플릿 블록은 건너뛴다.
 * - 결과 폴더 graphify-inline/ 은 git 에 올리지 않는다(git 전역 제외 목록에 등록).
 *
 * 사용: node scripts/graphify/extract-inline.js [저장소 루트]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const OUT = path.join(ROOT, 'graphify-inline');
// 지도에 넣을 화면 파일 — frontend 바로 아래 HTML 만(docs/ 의 시안·안내서는 제외)
const SRC_DIRS = ['frontend'];
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

function scriptType(attrs) {
  const m = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
  return m ? m[1].toLowerCase() : '';
}

function extract(html) {
  const lines = html.split('\n').map(() => '');
  let found = 0;
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs) || !JS_TYPES.has(scriptType(attrs))) continue;
    const body = m[2];
    if (!body.trim()) continue;
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    const startLine = html.slice(0, bodyStart).split('\n').length - 1;
    const startCol = bodyStart - (html.lastIndexOf('\n', bodyStart - 1) + 1);
    const bodyLines = body.split('\n');
    bodyLines.forEach((l, i) => {
      // 첫 줄은 <script> 태그 뒤 위치만큼 공백으로 밀어 열 번호도 맞춘다
      const text = i === 0 ? ' '.repeat(startCol) + l : l;
      lines[startLine + i] = lines[startLine + i] ? lines[startLine + i] + ' ' + text.trim() : text;
    });
    found++;
  }
  return { code: lines.join('\n'), found };
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  let files = 0, blocks = 0;
  for (const dir of SRC_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.html')) continue;
      const { code, found } = extract(fs.readFileSync(path.join(abs, name), 'utf8'));
      if (!found) continue;
      const dest = path.join(OUT, dir, name + '.js');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, code);
      files++; blocks += found;
    }
  }
  console.log(`[graphify-inline] 화면 파일 ${files}개에서 코드 블록 ${blocks}개를 뽑았습니다 → ${path.relative(ROOT, OUT)}/`);
}

if (require.main === module) main();
module.exports = { extract };
