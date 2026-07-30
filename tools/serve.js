#!/usr/bin/env node
/**
 * Tiny static server for the offline fixture (test/fixture.html).
 * Sends no-cache headers so edits show up on reload.
 *
 * Run: node tools/serve.js   ->   http://localhost:4173/test/fixture.html
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const target = path.join(ROOT, url === '/' ? '/test/fixture.html' : url);

    if (!target.startsWith(ROOT)) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    fs.readFile(target, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream',
            'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        res.end(data);
    });
}).listen(PORT, () => {
    console.log(`fixture: http://localhost:${PORT}/test/fixture.html`);
});
