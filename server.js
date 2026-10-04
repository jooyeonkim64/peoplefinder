/* =====================================================================
   People Finder 서버
   - Node.js 기본 모듈만 사용해요. (npm install 필요 없음)
   - 화면:   index.html, core.js, data/sample-data.json (저장소 맨 바깥)
   - 저장소: storage/db.json  ← 가입자, 프로필, 메시지, 피드백, 새 키워드
   실행: npm start  →  http://localhost:3000
   ===================================================================== */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./core.js');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'storage', 'db.json');
const SAMPLE_FILE = path.join(ROOT, 'data', 'sample-data.json');
const MAX_BODY = 100 * 1024;

/* ---------- 파일 DB ---------- */
function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db || !Array.isArray(db.users)) throw new Error('형식이 올바르지 않아요');
    return db;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 파일이 깨졌으면 지우지 않고 옆에 백업해 둔 뒤 새로 시작
      const backup = DB_FILE.replace(/\.json$/, `.broken-${Date.now()}.json`);
      try { fs.copyFileSync(DB_FILE, backup); console.warn(`[저장소] db.json을 읽지 못해 ${path.basename(backup)}로 백업하고 새로 만들어요.`); } catch (_) {}
    }
    return core.emptyDb();
  }
}
// 임시 파일에 쓴 뒤 이름을 바꿔서, 저장 도중 꺼져도 파일이 깨지지 않게 함
function saveDb(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const db = loadDb();
{
  const sample = JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8'));
  const fresh = !fs.existsSync(DB_FILE);
  if (core.syncSamples(db, sample, Date.now()) || fresh) saveDb(db);
}

/* ---------- 보안 도우미 ---------- */
const ctxBase = {
  newToken: () => crypto.randomBytes(32).toString('base64url'),
  hashToken: t => crypto.createHash('sha256').update(String(t)).digest('hex'),
  hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
  },
  verifyPassword(pw, stored) {
    const [scheme, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const a = Buffer.from(hash, 'hex');
    const b = crypto.scryptSync(pw, salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
};

/* ---------- API: POST /api  { action, ...값 }  (Authorization: Bearer 토큰) ---------- */
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('요청이 너무 커요.'), { status: 413, code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function handleApi(req, res) {
  if (req.method === 'GET' && req.url.startsWith('/api/health')) return sendJson(res, 200, { ok: true, mode: 'server' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST로 요청해주세요.' });
  try {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { if (e.status) throw e; return sendJson(res, 400, { error: '요청 형식이 올바르지 않아요.', code: 'BAD_JSON' }); }
    const auth = req.headers.authorization || '';
    body.token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    // Node는 한 번에 한 요청씩 처리하므로, 읽기 → 처리 → 파일 저장이 섞이지 않아요.
    const out = core.handle(db, body, Object.assign({ now: Date.now() }, ctxBase));
    if (out.changed) saveDb(db);
    sendJson(res, 200, out.data);
  } catch (e) {
    if (e.status) return sendJson(res, e.status, { error: e.message, code: e.code });
    console.error('[API 오류]', e);
    sendJson(res, 500, { error: '서버에서 문제가 생겼어요. 잠시 후 다시 시도해주세요.', code: 'SERVER_ERROR' });
  }
}

/* ---------- 정적 파일: 아래 목록에 있는 파일만 공개 (storage/, server.js 등은 공개하지 않음) ---------- */
const PUBLIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/core.js': 'core.js',
  '/data/sample-data.json': 'data/sample-data.json'
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function serveStatic(req, res) {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://x').pathname; } catch (e) { res.writeHead(400); return res.end(); }
  const rel = PUBLIC_FILES[urlPath];
  if (!rel) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('찾을 수 없어요.'); }
  const file = path.join(ROOT, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('찾을 수 없어요.'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

http.createServer((req, res) => {
  if (req.url === '/api' || req.url.startsWith('/api/') || req.url.startsWith('/api?')) return handleApi(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`People Finder 실행 중 → http://localhost:${PORT}`);
  console.log(`저장소 파일: ${path.relative(ROOT, DB_FILE)}  (가입자 ${db.users.filter(u => u.sampleId == null).length}명, 메시지 ${db.messages.length}개)`);
});
