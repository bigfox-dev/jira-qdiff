#!/usr/bin/env node
/**
 * Generates icons/icon{16,48,128}.png without any image dependency.
 * Run: node tools/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'icons');

const BLUE = [12, 102, 228, 255];
const RED = [255, 86, 48, 255];
const GREEN = [54, 179, 126, 255];

/** Signed-distance coverage of a rounded rectangle, 4x4 supersampled. */
function roundedRectCoverage(px, py, x, y, w, h, r) {
    let hits = 0;
    for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
            const cx = px + (sx + 0.5) / 4;
            const cy = py + (sy + 0.5) / 4;
            const dx = Math.max(x + r - cx, 0, cx - (x + w - r));
            const dy = Math.max(y + r - cy, 0, cy - (y + h - r));
            const inside =
                cx >= x && cx <= x + w && cy >= y && cy <= y + h &&
                Math.hypot(dx, dy) <= r;
            if (inside) hits++;
        }
    }
    return hits / 16;
}

function blend(dst, offset, colour, alpha) {
    if (alpha <= 0) return;
    const srcA = (colour[3] / 255) * alpha;
    const dstA = dst[offset + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) return;
    for (let c = 0; c < 3; c++) {
        const src = colour[c] / 255;
        const cur = dst[offset + c] / 255;
        dst[offset + c] = Math.round(((src * srcA + cur * dstA * (1 - srcA)) / outA) * 255);
    }
    dst[offset + 3] = Math.round(outA * 255);
}

function drawIcon(size) {
    const pixels = new Uint8Array(size * size * 4);

    const bg = { x: 0, y: 0, w: size, h: size, r: size * 0.22 };
    const pad = size * 0.17;
    const gap = Math.max(1, size * 0.07);
    const barW = (size - pad * 2 - gap) / 2;
    const barH = size - pad * 2;
    const barR = Math.max(0.6, size * 0.06);

    const left = { x: pad, y: pad, w: barW, h: barH, r: barR };
    const right = { x: pad + barW + gap, y: pad, w: barW, h: barH, r: barR };

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * 4;
            blend(pixels, offset, BLUE, roundedRectCoverage(x, y, bg.x, bg.y, bg.w, bg.h, bg.r));
            blend(pixels, offset, RED, roundedRectCoverage(x, y, left.x, left.y, left.w, left.h, left.r));
            blend(pixels, offset, GREEN, roundedRectCoverage(x, y, right.x, right.y, right.w, right.h, right.r));
        }
    }
    return pixels;
}

function crc32(buf) {
    let table = crc32.table;
    if (!table) {
        table = crc32.table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c;
        }
    }
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0; // filter: none
        Buffer.from(pixels.buffer, y * size * 4, size * 4)
            .copy(raw, y * (size * 4 + 1) + 1);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // colour type RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
    const file = path.join(OUT_DIR, `icon${size}.png`);
    fs.writeFileSync(file, encodePng(drawIcon(size), size));
    console.log('wrote', path.relative(process.cwd(), file));
}
