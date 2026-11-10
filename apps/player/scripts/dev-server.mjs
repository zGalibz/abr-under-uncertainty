import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const dist = path.join(appRoot, 'dist'); const port = Number(process.env.PORT || 4173);
if (!existsSync(path.join(dist, 'index.html'))) throw new Error('Build first with npm run build.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json' };
createServer((request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname; const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(dist, relative); if (!file.startsWith(`${dist}${path.sep}`) || !existsSync(file)) { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`Player available at http://127.0.0.1:${port}`));
