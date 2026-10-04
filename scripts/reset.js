// 저장소를 처음 상태(샘플 동료만 있는 상태)로 되돌려요.  실행: npm run reset
const fs = require('node:fs');
const path = require('node:path');
const core = require('../core.js');

const ROOT = path.join(__dirname, '..');
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'storage', 'db.json');
const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sample-data.json'), 'utf8'));

const db = core.emptyDb();
core.syncSamples(db, sample, Date.now());
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
console.log(`저장소를 초기화했어요: ${path.relative(ROOT, DB_FILE)} (샘플 동료 ${db.users.length}명)`);
