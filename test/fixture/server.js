// Small web app used to test Test Studio itself. Start with `node test/fixture/server.js [port]`.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'site');
const AG_GRID = path.join(__dirname, '..', '..', 'node_modules', 'ag-grid-community');
const AG_GRID_36 = path.join(__dirname, '..', '..', 'node_modules', 'ag-grid-community-36');
const AG_GRID_ENTERPRISE = path.join(__dirname, '..', '..', 'node_modules', 'ag-grid-enterprise');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function start(port = 0) {
  let flakyHits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/flaky-status') {
      // Fails on every odd request so a test passes only on retry.
      flakyHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: flakyHits % 2 === 0 }));
      return;
    }
    let root = ROOT;
    let rel = url.pathname === '/' ? '/login.html' : url.pathname;
    if (rel.startsWith('/vendor/ag-grid/')) {
      root = AG_GRID;
      rel = rel.slice('/vendor/ag-grid'.length);
    }
    if (rel.startsWith('/vendor/ag-grid-36/')) {
      root = AG_GRID_36;
      rel = rel.slice('/vendor/ag-grid-36'.length);
    }
    if (rel.startsWith('/vendor/ag-grid-enterprise/')) {
      root = AG_GRID_ENTERPRISE;
      rel = rel.slice('/vendor/ag-grid-enterprise'.length);
    }
    if (rel === '/vendor/ag-grid-license.js') {
      // The AG Grid Enterprise licence comes from the environment and is never written to disk.
      // Without it the grid still works, with a watermark and a licence message in the console.
      const key = process.env.AG_GRID_LICENSE_KEY || '';
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(key ? 'agGrid.LicenseManager.setLicenseKey(' + JSON.stringify(key) + ');\n' : '');
      return;
    }
    const file = path.join(root, path.normalize(rel));
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (require.main === module) {
  start(Number(process.argv[2]) || 4173).then((s) => console.log('Fixture app on http://127.0.0.1:' + s.address().port));
}

module.exports = { start };
