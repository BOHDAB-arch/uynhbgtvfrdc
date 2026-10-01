// Deadpool Tap — сервер: перевірка Telegram initData, збереження прогресу, топ гравців
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@libsql/client');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DEV = process.env.DEV === '1';
const PORT = process.env.PORT || 3000;

// === Turso (хмарний SQLite) ===
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// === Ініціалізація таблиці ===
(async () => {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS players(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
      gems INTEGER NOT NULL DEFAULT 0, k INTEGER NOT NULL DEFAULT 0,
      tap_lvl INTEGER NOT NULL DEFAULT 1, inc_lvl INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL
    );
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_total ON players(total DESC);`);
})().catch(console.error);

/* ---- перевірка підпису Telegram initData ---- */
function auth(req) {
  const h = req.headers.authorization || '';
  const raw = h.startsWith('tma ') ? h.slice(4) : '';
  if (!raw) {
    if (DEV) return { id: 1, first_name: 'Dev', username: 'dev_user' };
    return null;
  }
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  if (!hash || !BOT_TOKEN) return null;
  p.delete('hash');
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}
const displayName = u => u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Гравець';
const toState = r => ({ score: r.score, total: r.total, gems: r.gems, k: r.k, tapLvl: r.tap_lvl, incLvl: r.inc_lvl, t: r.updated });

// === Отримати або створити гравця ===
async function ensure(u) {
  const res = await db.execute({ sql: 'SELECT * FROM players WHERE id=?', args: [u.id] });
  if (res.rows.length === 0) {
    await db.execute({
      sql: 'INSERT INTO players(id,name,updated) VALUES(?,?,?)',
      args: [u.id, displayName(u), Date.now()]
    });
    const res2 = await db.execute({ sql: 'SELECT * FROM players WHERE id=?', args: [u.id] });
    return res2.rows[0];
  }
  const r = res.rows[0];
  if (r.name !== displayName(u)) {
    await db.execute({ sql: 'UPDATE players SET name=? WHERE id=?', args: [displayName(u), u.id] });
  }
  return r;
}

const app = express();
app.use(express.json({ limit: '5kb' }));
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': process.env.ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const needAuth = (req, res, next) => {
  const u = auth(req);
  if (!u) return res.status(401).json({ error: 'auth' });
  req.u = u;
  next();
};

app.get('/api/me', needAuth, async (req, res) => {
  const r = await ensure(req.u);
  res.json({ state: toState(r) });
});

app.post('/api/sync', needAuth, async (req, res) => {
  const old = await ensure(req.u);
  const b = req.body || {};
  const n = {};
  for (const f of ['score', 'total', 'gems', 'k', 'tapLvl', 'incLvl']) {
    n[f] = Number.isFinite(b[f]) ? Math.floor(b[f]) : NaN;
    if (!(n[f] >= 0)) return res.status(400).json({ error: 'bad' });
  }
  const dt = Math.max(1, (Date.now() - old.updated) / 1000);
  const perHour = n.incLvl * 100;
  const allowed = dt * (n.tapLvl * 20 + perHour / 3600) + 3 * perHour + 100 * n.tapLvl;
  const ok = n.total >= old.total && n.total - old.total <= allowed && n.score <= n.total
          && n.tapLvl >= 1 && n.tapLvl <= 500 && n.incLvl <= 500;
  if (!ok) return res.json({ ok: false, state: toState(old) });

  await db.execute({
    sql: `UPDATE players SET score=?,total=?,gems=?,k=?,tap_lvl=?,inc_lvl=?,updated=? WHERE id=?`,
    args: [n.score, n.total, n.gems, n.k, n.tapLvl, n.incLvl, Date.now(), req.u.id]
  });
  res.json({ ok: true });
});

app.get('/api/leaderboard', needAuth, async (req, res) => {
  const me = await ensure(req.u);
  const topRes = await db.execute('SELECT id,name,total FROM players ORDER BY total DESC, id ASC LIMIT 50');
  const rankRes = await db.execute({
    sql: 'SELECT COUNT(*)+1 AS r FROM players WHERE total > ?',
    args: [me.total]
  });
  res.json({ top: topRes.rows, me: { rank: rankRes.rows[0].r, total: me.total } });
});

// === Статичні файли ===
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname)); // на випадок, якщо index.html у корені

// === Запуск ===
app.listen(PORT, '0.0.0.0', () => console.log('Server on :' + PORT));