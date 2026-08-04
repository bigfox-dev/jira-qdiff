#!/usr/bin/env node
/**
 * Builds the loadable extension folders for both browsers.
 *
 *   node tools/build.js              -> dist/chrome/ and dist/firefox/
 *   node tools/build.js firefox      -> only that target
 *   node tools/build.js --zip        -> also dist/<target>-<version>.zip
 *
 * The repository root stays the single source of truth: manifest.json is the
 * Chrome manifest, and the Firefox one is derived from it by the patch below,
 * so the two can never drift apart.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** Files copied verbatim into every target. */
const PAYLOAD = [
    'background.js', 'common', 'content', 'popup', 'viewer', 'icons', 'LICENSE'
];

/** Firefox add-on id. Change it if you publish under your own account. */
const GECKO_ID = 'jira-diff-highlighter@onprem';

const TARGETS = {
    chrome: {
        // Chrome uses the root manifest as-is.
        patch: (manifest) => manifest
    },
    firefox: {
        patch: (manifest) => {
            // Firefox MV3 has no service worker; background runs as an event page.
            manifest.background = { scripts: ['background.js'] };
            // Required for a stable id (storage.sync needs one) and to keep the
            // add-on off engines that lack optional_host_permissions / scripting.
            manifest.browser_specific_settings = {
                gecko: { id: GECKO_ID, strict_min_version: '128.0' }
            };
            return manifest;
        }
    }
};

/* ---------------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------------- */

function rmrf(target) {
    fs.rmSync(target, { recursive: true, force: true });
}

function copyInto(source, destination, collected, prefix) {
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(source).sort()) {
            copyInto(
                path.join(source, entry),
                path.join(destination, entry),
                collected,
                prefix ? `${prefix}/${entry}` : entry
            );
        }
        return;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    collected.push(prefix);
}

/** Fail loudly if the manifest points at something we did not ship. */
function verifyReferences(manifest, outDir) {
    const referenced = new Set();
    const walk = (value) => {
        if (typeof value === 'string') {
            if (/\.(js|css|html|png|svg|json)$/i.test(value)) referenced.add(value);
        } else if (Array.isArray(value)) {
            value.forEach(walk);
        } else if (value && typeof value === 'object') {
            Object.values(value).forEach(walk);
        }
    };
    walk(manifest);

    const missing = [...referenced].filter((rel) => !fs.existsSync(path.join(outDir, rel)));
    if (missing.length) {
        throw new Error(`manifest references missing files: ${missing.join(', ')}`);
    }
    return referenced;
}

/* ---------------------------------------------------------------------- *
 * Minimal ZIP writer (deflate, no dependencies)
 * ---------------------------------------------------------------------- */

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

function dosTime(date) {
    const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
    const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
    return { time, day };
}

function writeZip(sourceDir, entries, zipPath) {
    const stamp = dosTime(new Date());
    const locals = [];
    const central = [];
    let offset = 0;

    for (const name of entries) {
        const raw = fs.readFileSync(path.join(sourceDir, name));
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
        const sum = crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);          // version needed
        local.writeUInt16LE(0, 6);           // flags
        local.writeUInt16LE(8, 8);           // method: deflate
        local.writeUInt16LE(stamp.time, 10);
        local.writeUInt16LE(stamp.day, 12);
        local.writeUInt32LE(sum, 14);
        local.writeUInt32LE(deflated.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);          // extra length
        locals.push(local, nameBuf, deflated);

        const dir = Buffer.alloc(46);
        dir.writeUInt32LE(0x02014b50, 0);
        dir.writeUInt16LE(20, 4);            // version made by
        dir.writeUInt16LE(20, 6);            // version needed
        dir.writeUInt16LE(0, 8);
        dir.writeUInt16LE(8, 10);
        dir.writeUInt16LE(stamp.time, 12);
        dir.writeUInt16LE(stamp.day, 14);
        dir.writeUInt32LE(sum, 16);
        dir.writeUInt32LE(deflated.length, 20);
        dir.writeUInt32LE(raw.length, 24);
        dir.writeUInt16LE(nameBuf.length, 28);
        dir.writeUInt16LE(0, 30);            // extra
        dir.writeUInt16LE(0, 32);            // comment
        dir.writeUInt16LE(0, 34);            // disk number
        dir.writeUInt16LE(0, 36);            // internal attrs
        dir.writeUInt32LE(0, 38);            // external attrs
        dir.writeUInt32LE(offset, 42);
        central.push(dir, nameBuf);

        offset += local.length + nameBuf.length + deflated.length;
    }

    const centralBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    fs.writeFileSync(zipPath, Buffer.concat([...locals, centralBuf, end]));
    return fs.statSync(zipPath).size;
}

/* ---------------------------------------------------------------------- *
 * Build
 * ---------------------------------------------------------------------- */

function build(target, { zip }) {
    const config = TARGETS[target];
    if (!config) throw new Error(`unknown target "${target}"`);

    const outDir = path.join(DIST, target);
    rmrf(outDir);
    fs.mkdirSync(outDir, { recursive: true });

    const entries = [];
    for (const item of PAYLOAD) {
        const source = path.join(ROOT, item);
        if (!fs.existsSync(source)) throw new Error(`missing payload: ${item}`);
        copyInto(source, path.join(outDir, item), entries, item);
    }

    const manifest = config.patch(JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')));
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 4) + '\n');
    entries.push('manifest.json');
    entries.sort();

    verifyReferences(manifest, outDir);

    let line = `${target.padEnd(8)} -> ${path.relative(ROOT, outDir)} (${entries.length} files)`;
    if (zip) {
        const zipPath = path.join(DIST, `${target}-${manifest.version}.zip`);
        const size = writeZip(outDir, entries, zipPath);
        line += `, ${path.relative(ROOT, zipPath)} (${(size / 1024).toFixed(1)} kB)`;
    }
    console.log(line);
}

const args = process.argv.slice(2);
const zip = args.includes('--zip');
const requested = args.filter((a) => !a.startsWith('--'));
const targets = requested.length ? requested : Object.keys(TARGETS);

for (const target of targets) build(target, { zip });
