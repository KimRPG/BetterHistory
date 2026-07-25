"use strict";

// GestureBackHistory 아이콘 생성기.
// 확장 아이콘은 PNG만 허용되므로, 참조 로고(파란 라운드 타일 + 양방향 화살표)를
// 측정한 비율대로 직접 안티앨리어싱 래스터화합니다. (외부 의존성 없음)
//
// 참조 이미지 측정값 (84x84 타일 기준 → 24x24 디자인 공간):
//   모서리 반경 22/84  -> 6.2
//   획 두께     5/84   -> 1.55
//   글리프 폭   33/84  -> 9.43 (양쪽 캡 포함)
//   화살촉 각도 45°
//   타일 색     #3661e3(위) → #2f55d7(아래) 세로 그라디언트

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const TILE_TOP_COLOR = [54, 97, 227];
const TILE_BOTTOM_COLOR = [47, 85, 215];
const GLYPH_COLOR = [255, 255, 255];
const DESIGN = 24;
const RADIUS = 6.2;
const STROKE = 1.55;
// 16px에서 획이 1px 아래로 내려가면 흐려지므로 최소 굵기를 보장합니다.
const MIN_DEVICE_STROKE = 1.3;
const SAMPLES = 4;
// 참조 비율(글리프 39%)은 큰 앱 아이콘용이라 툴바 크기에서는 화살표가 너무
// 작게 읽힙니다. 48·128은 참조 그대로 두고 작은 크기만 광학 보정합니다.
const GLYPH_SCALE = { 16: 1.4, 32: 1.22 };

const CENTER = DESIGN / 2;
const HALF_SPAN = 3.94; // 축 끝점(꺾쇠 꼭짓점)까지의 거리
const ARM = 2.37; // 꺾쇠 팔의 가로·세로 이동량 (45°)

const SEGMENTS = [
  // 가로 축
  [CENTER - HALF_SPAN, CENTER, CENTER + HALF_SPAN, CENTER],
  // 왼쪽 꺾쇠
  [CENTER - HALF_SPAN + ARM, CENTER - ARM, CENTER - HALF_SPAN, CENTER],
  [CENTER - HALF_SPAN, CENTER, CENTER - HALF_SPAN + ARM, CENTER + ARM],
  // 오른쪽 꺾쇠
  [CENTER + HALF_SPAN - ARM, CENTER - ARM, CENTER + HALF_SPAN, CENTER],
  [CENTER + HALF_SPAN, CENTER, CENTER + HALF_SPAN - ARM, CENTER + ARM]
];

function roundedRectDistance(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  return (
    Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) +
    Math.min(Math.max(dx, dy), 0) -
    radius
  );
}

function segmentDistance(x, y, [x1, y1, x2, y2]) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0
    ? 0
    : Math.min(1, Math.max(0, ((x - x1) * vx + (y - y1) * vy) / lengthSquared));
  return Math.hypot(x - (x1 + vx * t), y - (y1 + vy * t));
}

function coverage(insideTest) {
  let hits = 0;
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      if (insideTest((sx + 0.5) / SAMPLES, (sy + 0.5) / SAMPLES)) hits += 1;
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

function renderIcon(size) {
  const scale = DESIGN / size;
  const glyphScale = GLYPH_SCALE[size] ?? 1;
  const segments = SEGMENTS.map((segment) =>
    segment.map((value) => CENTER + (value - CENTER) * glyphScale)
  );
  const stroke = Math.max(
    STROKE * glyphScale,
    (MIN_DEVICE_STROKE * DESIGN) / size
  );
  const rows = [];

  for (let py = 0; py < size; py += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px += 1) {
      const toDesign = (offsetX, offsetY) => [
        (px + offsetX) * scale,
        (py + offsetY) * scale
      ];

      const tileAlpha = coverage((ox, oy) => {
        const [x, y] = toDesign(ox, oy);
        return roundedRectDistance(x, y, DESIGN, RADIUS) <= 0;
      });
      const glyphAlpha = coverage((ox, oy) => {
        const [x, y] = toDesign(ox, oy);
        return segments.some(
          (segment) => segmentDistance(x, y, segment) <= stroke / 2
        );
      });

      const gradient = (py + 0.5) / size;
      const alpha = glyphAlpha + tileAlpha * (1 - glyphAlpha);
      const offset = 1 + px * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        const tileChannel =
          TILE_TOP_COLOR[channel] +
          (TILE_BOTTOM_COLOR[channel] - TILE_TOP_COLOR[channel]) * gradient;
        const mixed = alpha === 0
          ? 0
          : (GLYPH_COLOR[channel] * glyphAlpha +
            tileChannel * tileAlpha * (1 - glyphAlpha)) / alpha;
        row[offset + channel] = Math.round(Math.min(255, Math.max(0, mixed)));
      }
      row[offset + 3] = Math.round(alpha * 255);
    }
    rows.push(row);
  }

  return encodePng(size, Buffer.concat(rows));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const outputDir = process.argv[2];
fs.mkdirSync(outputDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outputDir, `icon${size}.png`);
  fs.writeFileSync(file, renderIcon(size));
  console.log(`${file} (${fs.statSync(file).size} bytes)`);
}
