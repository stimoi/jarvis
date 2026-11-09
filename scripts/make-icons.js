// Génère les icônes PNG (PWA + appli de bureau) sans dépendance : rasterisation + PNG (zlib) à la main.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');
fs.mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
const BG = [4, 8, 15, 255];
const CYAN = [25, 211, 255, 255];

function icon({ maskable }) {
  return (u, v) => {
    const dx = u - 0.5, dy = v - 0.5;
    const d = Math.hypot(dx, dy);
    const k = maskable ? 0.78 : 1; // zone de sécurité pour les icônes "maskable"
    // coins arrondis pour l'icône normale
    if (!maskable) {
      const rx = Math.max(Math.abs(dx) - (0.5 - 0.22), 0), ry = Math.max(Math.abs(dy) - (0.5 - 0.22), 0);
      if (Math.hypot(rx, ry) > 0.22) return [0, 0, 0, 0];
    }
    let px = BG;
    const r = d / k;
    const band = (c, w) => Math.max(0, 1 - Math.abs(r - c) / w);
    const ang = Math.atan2(dy, dx);
    const dash = Math.sin(ang * 22) > -0.2 ? 1 : 0.15;
    px = mix(px, CYAN, band(0.383, 0.012) * 0.75 * dash);
    px = mix(px, [14, 127, 160, 255], band(0.273, 0.008) * 0.9);
    if (r < 0.165) {
      const t = 1 - Math.hypot(dx / k + 0.06, dy / k + 0.06) / 0.2;
      px = mix(px, CYAN, Math.min(1, Math.max(0.25, r < 0.165 ? 1 - r / 0.2 : 0)));
      if (t > 0.45) px = mix(px, [255, 255, 255, 255], Math.min(1, (t - 0.45) * 1.8));
    } else if (r < 0.26) px = mix(px, CYAN, Math.max(0, (0.26 - r) / 0.095) * 0.12);
    return px;
  };
}

// icon.ico (Windows) : conteneur ICO avec images PNG 256/64/32 px
{
  const sizes = [256, 64, 32];
  const imgs = sizes.map((s) => png(s, icon({ maskable: false })));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(offset, 12);
    offset += imgs[i].length;
    return e;
  });
  fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([head, ...dir, ...imgs]));
}
fs.writeFileSync(path.join(out, 'icon-192.png'), png(192, icon({ maskable: false })));
fs.writeFileSync(path.join(out, 'icon-512.png'), png(512, icon({ maskable: false })));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), png(512, icon({ maskable: true })));
console.log('Icônes générées dans', out);
