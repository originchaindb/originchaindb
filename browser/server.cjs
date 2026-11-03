const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const app = http.createServer((req, res) => {
  if (req.url === '/') { res.end('<!doctype html><title>SDK browser acceptance</title>'); return; }
  const files = { '/sdk.mjs': 'dist/index.mjs', '/scenario.mjs': 'browser/scenario.mjs' };
  if (files[req.url]) {
    res.setHeader('content-type', 'text/javascript');
    res.end(fs.readFileSync(path.join(root, files[req.url]))); return;
  }
  if (req.url === '/worker.mjs') {
    res.setHeader('content-type', 'text/javascript');
    res.end('import { exercise } from "/scenario.mjs"; exercise().then(result => postMessage({result})).catch(error => postMessage({error:error.message}));'); return;
  }
  res.writeHead(404).end();
}).listen(32170, '127.0.0.1');
const api = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', 'http://127.0.0.1:32170');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,idempotency-key');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.headers.authorization !== 'Bearer mock-browser-only') { res.writeHead(401).end(); return; }
  res.setHeader('content-type', 'application/json');
  req.resume();
  if (req.url.includes('/delayed/')) {
    const timer = setTimeout(() => res.end('[]'), 2000);
    res.on('close', () => clearTimeout(timer)); return;
  }
  if (req.url.endsWith('/sql')) {
    res.end(JSON.stringify({ kind: 'select', rows: [{ id: 'one', path: req.url,
      correlation: req.headers['x-oc-logical-request-id'] ?? null,
      attempt: req.headers['x-oc-attempt'] ?? null }] })); return;
  }
  res.writeHead(404).end('{}');
}).listen(32171, '127.0.0.1');
function close() { app.close(); api.close(); app.closeAllConnections(); api.closeAllConnections(); }
process.on('SIGTERM', close); process.on('SIGINT', close);
