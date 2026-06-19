/**
 * gen-icons.mjs — PWA 아이콘 생성 (일회성 빌드 스크립트, 런타임 의존성 아님)
 *
 * 사용법:
 *   1) 원본 로고를 frontend/icons/iacrew-source.png 로 둔다 (정사각, 가능하면 1024px+).
 *      (없으면 frontend/icons/iacrew-source.svg 를 폴백으로 사용)
 *   2) npm i sharp   (임시 설치, 커밋하지 않음)
 *   3) node scripts/gen-icons.mjs
 *
 * 출력(커밋 대상): frontend/icons/{icon-192,icon-512,maskable-512,apple-touch-icon-180}.png
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_DIR = path.resolve(__dirname, '../frontend/icons');

const pngSrc = path.join(ICON_DIR, 'iacrew-source.png');
const svgSrc = path.join(ICON_DIR, 'iacrew-source.svg');
const SRC = existsSync(pngSrc) ? pngSrc : (existsSync(svgSrc) ? svgSrc : null);

if (!SRC) {
  console.error('❌ 원본 없음: frontend/icons/iacrew-source.png (또는 .svg) 를 먼저 두세요.');
  process.exit(1);
}
console.log('source =', path.relative(process.cwd(), SRC));

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

async function plain(size, out) {
  await sharp(SRC, { density: 384 })
    .resize(size, size, { fit: 'contain', background: WHITE })
    .flatten({ background: WHITE })
    .png()
    .toFile(path.join(ICON_DIR, out));
  console.log('✓', out);
}

// maskable: 안전영역(80%) 확보 — 로고를 중앙 80%에 흰 배경으로 패딩
async function maskable(size, out) {
  const inner = Math.round(size * 0.8);
  const pad = Math.round((size - inner) / 2);
  const logo = await sharp(SRC, { density: 384 })
    .resize(inner, inner, { fit: 'contain', background: WHITE })
    .flatten({ background: WHITE })
    .png()
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: WHITE } })
    .composite([{ input: logo, top: pad, left: pad }])
    .png()
    .toFile(path.join(ICON_DIR, out));
  console.log('✓', out);
}

await plain(192, 'icon-192.png');
await plain(512, 'icon-512.png');
await plain(180, 'apple-touch-icon-180.png');
await maskable(512, 'maskable-512.png');
console.log('done.');
