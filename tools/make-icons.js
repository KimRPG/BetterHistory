"use strict";

// Better Gesture 아이콘 생성기.
// 확장 아이콘은 PNG만 허용되므로, 겹친 페이지와 뒤로 화살표를 외부 의존성
// 없이 직접 안티앨리어싱 래스터화합니다.
//
// 좌표는 128px 아이콘을 그대로 단위로 씁니다(DESIGN = 128). 디자인 원본을
// 128px에서 재어 온 값이라, 상수를 원본과 눈으로 맞춰 볼 수 있습니다.
//
// 그림 구성 (뒤에서 앞으로):
//   1. 뒤에 겹친 장 두 개 — 오른쪽으로 밀리고 위아래로 좁아지며 옅어집니다
//   2. 앞장 — 흰 바탕에 보라 테두리
//   3. 뒤로 화살표 — 왼쪽을 가리키는 꺾쇠와 오른쪽으로 흐르는 꼬리.
//      색은 왼쪽 청록에서 오른쪽 보라로 넘어갑니다.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const DESIGN = 128;
const SAMPLES = 4;

const WHITE = [255, 255, 255];
const VIOLET_50 = [245, 243, 255];
const VIOLET_400 = [167, 139, 250];
const VIOLET_500 = [140, 92, 246];
// 앞장 테두리는 위에서 아래로 살짝 짙어집니다.
const PAGE_STROKE_TOP = [145, 95, 249];
const PAGE_STROKE_BOTTOM = [100, 75, 236];
// 화살표는 왼쪽 끝(청록)에서 오른쪽 끝(보라)으로 넘어갑니다.
const ARROW_START = [34, 211, 238];
const ARROW_END = [139, 92, 246];
const ARROW_GRADIENT = { from: 25, to: 95 };

const PAGE = { x0: 25, y0: 14, x1: 90.5, y1: 113, radius: 11, stroke: 5 };
const STACK = [
  { x0: 43, y0: 32, x1: 108.5, y1: 97, radius: 10, stroke: 4,
    color: VIOLET_500, fill: null, opacity: 0.35 },
  { x0: 36, y0: 23, x1: 101.5, y1: 106, radius: 10, stroke: 4,
    color: VIOLET_400, fill: VIOLET_50, opacity: 1 }
];

const ARROW_STROKE = 8;
const ARROW_TIP = [31, 56];
// 꺾쇠는 45°입니다. 끝점은 둥근 마감의 반지름만큼 안쪽에 둡니다.
const ARROW_HEAD = [[43, 44], ARROW_TIP, [43, 68]];
// 꼬리는 꼭짓점에서 수평으로 나가 오른쪽 끝에서 아래로 흘러내립니다.
const ARROW_TAIL = [ARROW_TIP, [66, 56], [78, 63], [90, 72.5]];
const TAIL_STEPS = 24;

// 16px에서 테두리가 1px 아래로 내려가면 통째로 사라집니다. 작은 크기에서는
// 최소 굵기를 보장하고, 화살표는 그보다 조금 더 두껍게 잡아 읽히게 합니다.
const MIN_DEVICE_STROKE = 1.15;
const MIN_DEVICE_ARROW = 1.7;

function lerp(from, to, amount) {
  const t = Math.min(1, Math.max(0, amount));
  return from.map((value, index) => value + (to[index] - value) * t);
}

// 모서리가 둥근 사각형의 부호 있는 거리입니다. 0보다 작으면 안, 크면 밖이고,
// 절댓값이 굵기의 절반보다 작으면 테두리 위입니다.
function roundedRectDistance(x, y, { x0, y0, x1, y1, radius }) {
  const halfWidth = (x1 - x0) / 2;
  const halfHeight = (y1 - y0) / 2;
  const dx = Math.abs(x - (x0 + halfWidth)) - (halfWidth - radius);
  const dy = Math.abs(y - (y0 + halfHeight)) - (halfHeight - radius);
  return (
    Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) +
    Math.min(Math.max(dx, dy), 0) -
    radius
  );
}

function segmentDistance(x, y, [x1, y1], [x2, y2]) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0
    ? 0
    : Math.min(1, Math.max(0, ((x - x1) * vx + (y - y1) * vy) / lengthSquared));
  return Math.hypot(x - (x1 + vx * t), y - (y1 + vy * t));
}

// 이어진 선분들까지의 최단 거리입니다. 최솟값을 쓰므로 이음매와 끝이 저절로
// 둥글게 마감됩니다.
function polylineDistance(x, y, points) {
  let closest = Infinity;
  for (let index = 0; index < points.length - 1; index += 1) {
    closest = Math.min(
      closest,
      segmentDistance(x, y, points[index], points[index + 1])
    );
  }
  return closest;
}

function flattenCubic([p0, p1, p2, p3], steps) {
  const points = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    points.push([0, 1].map((axis) =>
      u * u * u * p0[axis] +
      3 * u * u * t * p1[axis] +
      3 * u * t * t * p2[axis] +
      t * t * t * p3[axis]
    ));
  }
  return points;
}

const ARROW_PATH = [ARROW_HEAD, flattenCubic(ARROW_TAIL, TAIL_STEPS)];

function coverage(insideTest) {
  let hits = 0;
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      if (insideTest((sx + 0.5) / SAMPLES, (sy + 0.5) / SAMPLES)) hits += 1;
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

// 뒤에 있는 색 위에 앞의 색을 얹습니다. 알파를 미리 곱하지 않은 값으로
// 들고 다니므로 결과 알파로 다시 나눠 줍니다.
function over(under, color, alpha) {
  if (alpha <= 0) return under;

  const outAlpha = alpha + under.alpha * (1 - alpha);
  if (outAlpha <= 0) return { color: [0, 0, 0], alpha: 0 };

  return {
    color: color.map((value, index) =>
      (value * alpha + under.color[index] * under.alpha * (1 - alpha)) / outAlpha
    ),
    alpha: outAlpha
  };
}

function renderIcon(size) {
  const scale = DESIGN / size;
  // 작은 크기에서 선이 사라지지 않도록 굵기에 하한을 둡니다.
  const minStroke = MIN_DEVICE_STROKE * scale;
  const minArrow = MIN_DEVICE_ARROW * scale;
  const rows = [];

  for (let py = 0; py < size; py += 1) {
    const row = Buffer.alloc(1 + size * 4);

    for (let px = 0; px < size; px += 1) {
      const at = (offsetX, offsetY) => [
        (px + offsetX) * scale,
        (py + offsetY) * scale
      ];
      const cover = (test) => coverage((ox, oy) => test(...at(ox, oy)));

      let pixel = { color: [0, 0, 0], alpha: 0 };

      for (const page of STACK) {
        const stroke = Math.max(page.stroke, minStroke);
        if (page.fill) {
          pixel = over(
            pixel,
            page.fill,
            cover((x, y) => roundedRectDistance(x, y, page) <= 0) * page.opacity
          );
        }
        pixel = over(
          pixel,
          page.color,
          cover((x, y) =>
            Math.abs(roundedRectDistance(x, y, page)) <= stroke / 2
          ) * page.opacity
        );
      }

      pixel = over(
        pixel,
        WHITE,
        cover((x, y) => roundedRectDistance(x, y, PAGE) <= 0)
      );

      const pageStroke = Math.max(PAGE.stroke, minStroke);
      const [, centerY] = at(0.5, 0.5);
      pixel = over(
        pixel,
        lerp(
          PAGE_STROKE_TOP,
          PAGE_STROKE_BOTTOM,
          (centerY - PAGE.y0) / (PAGE.y1 - PAGE.y0)
        ),
        cover((x, y) => Math.abs(roundedRectDistance(x, y, PAGE)) <= pageStroke / 2)
      );

      const arrowStroke = Math.max(ARROW_STROKE, minArrow);
      const [centerX] = at(0.5, 0.5);
      pixel = over(
        pixel,
        lerp(
          ARROW_START,
          ARROW_END,
          (centerX - ARROW_GRADIENT.from) /
            (ARROW_GRADIENT.to - ARROW_GRADIENT.from)
        ),
        cover((x, y) =>
          ARROW_PATH.some((points) =>
            polylineDistance(x, y, points) <= arrowStroke / 2
          )
        )
      );

      const offset = 1 + px * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        row[offset + channel] = Math.round(
          Math.min(255, Math.max(0, pixel.color[channel]))
        );
      }
      row[offset + 3] = Math.round(pixel.alpha * 255);
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
