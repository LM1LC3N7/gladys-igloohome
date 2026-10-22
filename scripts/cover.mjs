// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-indigo gradient, a
// padlock (shackle, body, keyhole), the waves of a bridge beside it and two
// discs for the buttons (lock, unlock) under it. Plain Node (zlib), no
// dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [18, 20, 38];
const INDIGO = [70, 72, 160];
const WHITE = [255, 255, 255];
const GREEN = [120, 220, 140];
const AMBER = [255, 196, 84];

/** Distance to the border of a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function pixel(x, y) {
  let color = mix(DARK, INDIGO, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  // The shackle: the upper half of a ring, and its two legs.
  const ring = Math.abs(Math.hypot(x - 400, y - 170) - 70);
  if (y <= 170) {
    color = mix(color, WHITE, smooth(12, ring));
  } else if (y < 230) {
    color = mix(color, WHITE, smooth(12, Math.min(Math.abs(x - 330), Math.abs(x - 470))));
  }
  // The body and its keyhole.
  const body = roundedBox(x, y, 400, 300, 120, 90, 22);
  if (body < 0) {
    color = mix(color, WHITE, 0.92);
    const hole = Math.min(Math.hypot(x - 400, y - 285) - 18, roundedBox(x, y, 400, 320, 8, 30, 4));
    color = mix(color, DARK, smooth(0, hole));
  }
  color = mix(color, WHITE, smooth(2, Math.abs(body)));
  // The waves of the bridge, on the right.
  for (const radius of [30, 55, 80]) {
    const d = Math.abs(Math.hypot(x - 560, y - 160) - radius);
    if (x > 560 && y < 160 && x - 560 > 160 - y - 10) {
      color = mix(color, GREEN, smooth(5, d) * 0.85);
    }
  }
  // Two buttons: lock, unlock.
  [
    [330, 460, GREEN],
    [470, 460, AMBER],
  ].forEach(([px, py, accent]) => {
    const d = Math.hypot(x - px, y - py);
    color = mix(color, accent, smooth(30, d) * 0.92);
    color = mix(color, DARK, smooth(11, d) * 0.7);
  });
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
