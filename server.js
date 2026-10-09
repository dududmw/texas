const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 80;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-local-secret';
const BUY_IN = 500;
const STARTING_POINTS = 3000;
const TURN_TIMEOUT_MS = 25_000;
const db = new Database(path.join(__dirname, 'texas.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT ${STARTING_POINTS}, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER NOT NULL,
    reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS game_snapshots (
    table_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS hand_logs (
    id INTEGER PRIMARY KEY, table_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const issueToken = user => jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
const safeUser = user => ({ id: user.id, username: user.username, points: user.points });

app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[\w\u4e00-\u9fa5-]{3,20}$/.test(username) || password.length < 6) return res.status(400).json({ error: '用户名需为 3-20 位；密码至少 6 位' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users(username,password_hash,points) VALUES(?,?,?)').run(username, hash, STARTING_POINTS);
    const user = db.prepare('SELECT id,username,points FROM users WHERE id=?').get(result.lastInsertRowid);
    db.prepare('INSERT INTO wallet_transactions(user_id,amount,reason) VALUES(?,?,?)').run(user.id, STARTING_POINTS, '新账户赠送积分');
    res.json({ token: issueToken(user), user: safeUser(user) });
  } catch (error) { res.status(409).json({ error: '用户名已存在' }); }
});
app.post('/api/login', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(req.body.username || '').trim());
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) return res.status(401).json({ error: '用户名或密码错误' });
  res.json({ token: issueToken(user), user: safeUser(user) });
});
app.get('/api/me', (req, res) => {
  try { const token = req.headers.authorization?.replace('Bearer ', ''); const payload = jwt.verify(token, JWT_SECRET); const user = db.prepare('SELECT id,username,points FROM users WHERE id=?').get(payload.id); res.json({ user: safeUser(user) }); } catch { res.status(401).json({ error: '未登录' }); }
});

const suits = ['♠', '♥', '♦', '♣']; const ranks = '23456789TJQKA';
const makeDeck = () => {
  const deck = [];
  for (const rank of ranks) for (const suit of suits) deck.push({ rank, suit });
  // Fisher–Yates ensures every one of the 52! permutations has equal probability.
  // crypto.randomInt uses Node's cryptographically secure random source.
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
};
const rankValue = rank => ranks.indexOf(rank) + 2;
const combinations = (cards, n) => n === 0 ? [[]] : cards.flatMap((card, index) => combinations(cards.slice(index + 1), n - 1).map(rest => [card, ...rest]));
const scoreFive = cards => {
  const vals = cards.map(c => rankValue(c.rank)).sort((a, b) => b - a);
  const counts = [...new Map(vals.map(v => [v, vals.filter(x => x === v).length])).entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(c => c.suit === cards[0].suit);
  const unique = [...new Set(vals)].sort((a, b) => b - a); let straightHigh = 0;
  if (unique.length === 5 && unique[0] - unique[4] === 4) straightHigh = unique[0];
  if (unique.join(',') === '14,5,4,3,2') straightHigh = 5;
  const make = (kind, rest) => [kind, ...rest];
  if (flush && straightHigh) return make(8, [straightHigh]);
  if (counts[0][1] === 4) return make(7, [counts[0][0], counts[1][0]]);
  if (counts[0][1] === 3 && counts[1][1] === 2) return make(6, [counts[0][0], counts[1][0]]);
  if (flush) return make(5, vals);
  if (straightHigh) return make(4, [straightHigh]);
  if (counts[0][1] === 3) return make(3, [counts[0][0], ...counts.slice(1).map(x => x[0])]);
  if (counts[0][1] === 2 && counts[1][1] === 2) return make(2, [counts[0][0], counts[1][0], counts[2][0]]);
  if (counts[0][1] === 2) return make(1, [counts[0][0], ...counts.slice(1).map(x => x[0])]);
  return make(0, vals);
};
const bestScore = cards => combinations(cards, 5).map(scoreFive).sort(compareScore).at(-1);
const compareScore = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i += 1) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; };
const handName = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

const tables = new Map();
const defaultTable = { id: 'main', name: '新手牌桌', smallBlind: 10, bigBlind: 20, maxPlayers: 8, players: [], spectators: new Set(), phase: 'waiting', board: [], pot: 0, dealer: -1, turn: -1, deck: [], turnTimer: null, turnDeadline: null, message: '等待至少两位玩家入座' };
tables.set(defaultTable.id, defaultTable);
const persist = table => { const { turnTimer, ...snapshot } = table; db.prepare('INSERT INTO game_snapshots(table_id,snapshot,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(table_id) DO UPDATE SET snapshot=excluded.snapshot,updated_at=CURRENT_TIMESTAMP').run(table.id, JSON.stringify({ ...snapshot, spectators: undefined, deck: undefined, players: table.players.map(({ socket, ...player }) => player) })); };
const publicTable = (table, userId) => { const { turnTimer, ...state } = table; return { ...state, deck: undefined, spectators: undefined, players: table.players.map(({ socket, cards, ...p }) => ({ ...p, cards: (p.userId === userId && p.inHand) || (table.phase === 'waiting' && table.board.length === 5) ? cards : undefined })) }; };
const broadcast = table => { persist(table); for (const client of [...table.players, ...table.spectators]) if (client.socket?.readyState === 1) client.socket.send(JSON.stringify({ type: 'state', table: publicTable(table, client.userId) })); };
const activePlayers = table => table.players.filter(p => p.inHand && !p.folded);
const nextIndex = (table, from, predicate) => { for (let i = 1; i <= table.players.length; i += 1) { const index = (from + i) % table.players.length; if (predicate(table.players[index])) return index; } return -1; };
const logHand = (table, event) => db.prepare('INSERT INTO hand_logs(table_id,payload) VALUES(?,?)').run(table.id, JSON.stringify({ event, phase: table.phase, pot: table.pot, at: new Date().toISOString() }));
const clearTurnTimer = table => { if (table.turnTimer) clearTimeout(table.turnTimer); table.turnTimer = null; table.turnDeadline = null; };
function scheduleTurnTimer(table) {
  clearTurnTimer(table);
  const player = table.players[table.turn];
  if (table.phase === 'waiting' || !player) return;
  table.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
  table.turnTimer = setTimeout(() => {
    const current = table.players[table.turn];
    if (!current || current.userId !== player.userId) return;
    const maxBet = Math.max(...activePlayers(table).map(p => p.roundBet));
    const action = maxBet === current.roundBet ? 'check' : 'fold';
    table.message = `${current.username} 超时，已自动${action === 'check' ? '过牌' : '弃牌'}`;
    try { act(table, current.userId, action); } catch (error) { console.error('Timed out action failed', error); }
  }, TURN_TIMEOUT_MS);
}
function postBlinds(table) {
  const seated = table.players.filter(p => p.stack > 0); table.dealer = nextIndex(table, table.dealer, p => seated.includes(p));
  const sb = nextIndex(table, table.dealer, p => seated.includes(p)); const bb = nextIndex(table, sb, p => seated.includes(p));
  [[sb, table.smallBlind], [bb, table.bigBlind]].forEach(([index, amount]) => { const p = table.players[index]; const bet = Math.min(p.stack, amount); p.stack -= bet; p.roundBet = bet; p.totalBet = bet; table.pot += bet; });
  table.turn = nextIndex(table, bb, p => p.inHand && !p.folded && p.stack > 0);
}
function startHand(table) {
  if (table.phase !== 'waiting' || table.players.filter(p => p.stack > 0).length < 2) throw new Error('至少两位有积分的玩家才能开始');
  table.deck = makeDeck(); table.board = []; table.pot = 0; table.phase = 'preflop'; table.message = '翻牌前下注';
  table.players.forEach(p => Object.assign(p, { cards: [table.deck.pop(), table.deck.pop()], inHand: p.stack > 0, folded: false, roundBet: 0, totalBet: 0, acted: false }));
  postBlinds(table); scheduleTurnTimer(table); logHand(table, 'start'); broadcast(table);
}
function revealNext(table) {
  table.players.forEach(p => { p.roundBet = 0; p.acted = false; });
  if (table.phase === 'preflop') { table.board.push(table.deck.pop(), table.deck.pop(), table.deck.pop()); table.phase = 'flop'; table.message = '翻牌圈'; }
  else if (table.phase === 'flop') { table.board.push(table.deck.pop()); table.phase = 'turn'; table.message = '转牌圈'; }
  else if (table.phase === 'turn') { table.board.push(table.deck.pop()); table.phase = 'river'; table.message = '河牌圈'; }
  else return showdown(table);
  table.turn = nextIndex(table, table.dealer, p => p.inHand && !p.folded && p.stack > 0);
  if (table.turn < 0) revealNext(table); else { scheduleTurnTimer(table); broadcast(table); }
}
function showdown(table) {
  clearTurnTimer(table);
  const contenders = activePlayers(table); const scored = contenders.map(p => ({ p, score: bestScore([...p.cards, ...table.board]) })); const high = scored.map(x => x.score).sort(compareScore).at(-1); const winners = scored.filter(x => compareScore(x.score, high) === 0).map(x => x.p);
  const share = Math.floor(table.pot / winners.length); winners.forEach(p => { p.stack += share; }); const remainder = table.pot - share * winners.length; if (remainder) winners[0].stack += remainder;
  table.message = `${winners.map(p => p.username).join('、')} 获胜（${handName[high[0]]}），赢得 ${table.pot} 积分`;
  table.phase = 'waiting'; table.turn = -1; logHand(table, { winners: winners.map(p => p.username), score: handName[high[0]] }); broadcast(table);
}
function settleIfNeeded(table) {
  const alive = activePlayers(table); if (alive.length === 0) { clearTurnTimer(table); table.phase = 'waiting'; table.turn = -1; table.message = '牌局因所有玩家离桌而结束'; table.pot = 0; broadcast(table); return true; }
  if (alive.length === 1) { clearTurnTimer(table); alive[0].stack += table.pot; table.message = `${alive[0].username} 获胜，赢得 ${table.pot} 积分`; table.phase = 'waiting'; table.turn = -1; logHand(table, 'all folded'); broadcast(table); return true; }
  const pending = alive.some(p => p.stack > 0 && (!p.acted || p.roundBet !== Math.max(...alive.map(x => x.roundBet)))); if (!pending) { revealNext(table); return true; } return false;
}
function act(table, userId, action, amount) {
  if (table.phase === 'waiting') { if (action === 'start') return startHand(table); throw new Error('当前未在牌局中'); }
  const player = table.players[table.turn]; if (!player || player.userId !== userId) throw new Error('还没轮到你');
  const maxBet = Math.max(...activePlayers(table).map(p => p.roundBet)); const call = maxBet - player.roundBet;
  if (action === 'fold') player.folded = true;
  else if (action === 'check') { if (call !== 0) throw new Error('当前不能过牌'); }
  else if (action === 'call') { const paid = Math.min(call, player.stack); player.stack -= paid; player.roundBet += paid; player.totalBet += paid; table.pot += paid; }
  else if (action === 'raise') { const target = Number(amount); const allInTarget = player.roundBet + player.stack; if (!Number.isInteger(target) || target <= maxBet || target - player.roundBet > player.stack || (target < maxBet + table.bigBlind && target !== allInTarget)) throw new Error(`加注额无效，最低加至 ${maxBet + table.bigBlind}`); const paid = target - player.roundBet; player.stack -= paid; player.roundBet = target; player.totalBet += paid; table.pot += paid; table.players.forEach(p => { if (p !== player && p.inHand && !p.folded) p.acted = false; }); }
  else if (action === 'allin') { const paid = player.stack; player.stack = 0; player.roundBet += paid; player.totalBet += paid; table.pot += paid; if (player.roundBet > maxBet) table.players.forEach(p => { if (p !== player && p.inHand && !p.folded) p.acted = false; }); }
  else throw new Error('未知操作');
  clearTurnTimer(table);
  player.acted = true; logHand(table, { user: player.username, action, amount });
  if (!settleIfNeeded(table)) { table.turn = nextIndex(table, table.turn, p => p.inHand && !p.folded && p.stack > 0); scheduleTurnTimer(table); broadcast(table); }
}
function leaveTable(table, player) {
  const leavingIndex = table.players.indexOf(player);
  const wasTurn = leavingIndex === table.turn;
  if (wasTurn) clearTurnTimer(table);
  if (table.phase !== 'waiting' && player.inHand && !player.folded) player.folded = true;
  db.transaction(() => { db.prepare('UPDATE users SET points=points+? WHERE id=?').run(player.stack, player.userId); db.prepare('INSERT INTO wallet_transactions(user_id,amount,reason) VALUES(?,?,?)').run(player.userId, player.stack, '离桌返还筹码'); })();
  table.players = table.players.filter(p => p !== player);
  if (leavingIndex < table.turn) table.turn -= 1;
  if (wasTurn && table.phase !== 'waiting') table.turn = nextIndex(table, leavingIndex - 1, p => p.inHand && !p.folded && p.stack > 0);
}

const server = http.createServer(app); const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (socket, request) => {
  let user; try { user = jwt.verify(new URL(request.url, 'http://localhost').searchParams.get('token'), JWT_SECRET); } catch { socket.close(1008, '认证失败'); return; }
  socket.user = user; socket.send(JSON.stringify({ type: 'tables', tables: [...tables.values()].map(t => ({ id: t.id, name: t.name, players: t.players.length, maxPlayers: t.maxPlayers, phase: t.phase })) }));
  socket.on('message', raw => { try {
    const message = JSON.parse(raw); const table = tables.get(message.tableId || 'main'); if (!table) throw new Error('牌桌不存在');
    if (message.type === 'join') {
      if (table.players.some(p => p.userId === user.id)) return broadcast(table); if (table.players.length >= table.maxPlayers) throw new Error('牌桌已满');
      const account = db.prepare('SELECT points FROM users WHERE id=?').get(user.id); if (account.points < BUY_IN) throw new Error(`积分不足，入桌需要 ${BUY_IN} 积分`);
      db.transaction(() => { db.prepare('UPDATE users SET points=points-? WHERE id=?').run(BUY_IN, user.id); db.prepare('INSERT INTO wallet_transactions(user_id,amount,reason) VALUES(?,?,?)').run(user.id, -BUY_IN, '进入牌桌买入'); })();
      table.players.push({ userId: user.id, username: user.username, stack: BUY_IN, socket, inHand: false, folded: false, roundBet: 0, totalBet: 0, cards: [] }); broadcast(table);
    } else if (message.type === 'spectate') { table.spectators.add({ userId: user.id, username: user.username, socket }); broadcast(table); }
    else if (message.type === 'action') act(table, user.id, message.action, message.amount);
  } catch (error) { socket.send(JSON.stringify({ type: 'error', error: error.message || '操作失败' })); } });
  socket.on('close', () => tables.forEach(table => { const player = table.players.find(p => p.userId === user.id); if (player) { leaveTable(table, player); if (table.phase !== 'waiting' && !settleIfNeeded(table)) scheduleTurnTimer(table); broadcast(table); } for (const spectator of table.spectators) if (spectator.socket === socket) table.spectators.delete(spectator); }));
});
server.listen(PORT, () => console.log(`Texas Hold'em is running at http://localhost:${PORT}`));
