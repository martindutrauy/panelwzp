import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.join(__dirname, 'dist');

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';

const contentTypeByExt = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8'
};

const safeResolve = (urlPath) => {
    const decoded = decodeURIComponent(urlPath.split('?')[0] || '/');
    const clean = decoded.replace(/\\/g, '/');
    const rel = clean.startsWith('/') ? clean.slice(1) : clean;
    const joined = path.join(distDir, rel);
    const normalized = path.normalize(joined);
    if (!normalized.startsWith(distDir)) return null;
    return normalized;
};

const sendFile = (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = contentTypeByExt[ext] || 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    if (ext !== '.html') {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
        res.setHeader('Cache-Control', 'no-cache');
    }
    fs.createReadStream(filePath).pipe(res);
};

const server = http.createServer((req, res) => {
    try {
        const method = (req.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
            res.statusCode = 405;
            res.end('Method Not Allowed');
            return;
        }

        const targetPath = safeResolve(req.url || '/');
        if (!targetPath) {
            res.statusCode = 400;
            res.end('Bad Request');
            return;
        }

        let filePath = targetPath;
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            filePath = path.join(filePath, 'index.html');
        }

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            sendFile(res, filePath);
            return;
        }

        const spaIndex = path.join(distDir, 'index.html');
        if (fs.existsSync(spaIndex)) {
            sendFile(res, spaIndex);
            return;
        }

        res.statusCode = 404;
        res.end('Not Found');
    } catch {
        res.statusCode = 500;
        res.end('Internal Server Error');
    }
});

server.listen(port, host, () => {
    console.log(`Frontend running on http://${host}:${port}`);
});

