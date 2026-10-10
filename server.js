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
const BUY_IN = 1000;
const REBUY_MAX_AMOUNT = 2000;
const STARTING_POINTS = 6000;
const TURN_TIMEOUT_MS = 25_000;
const RESULT_DISPLAY_MS = 10_000;
const RECONNECT_GRACE_MS = 60_000;
const WS_HEARTBEAT_MS = 30_000;
const EMOTES = new Set(['😏', '😂', '🤔', '🔥', '💀', '😎', '🤡', '😭', '😡', '👀', '🙏', '😴', '🎯', '👏', '🍀', '🎲']);
const VOICE_LINES = new Set(['fold', 'calm', 'shove', 'call']);
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
const currentHandName = cards => {
  if (cards.length >= 5) return handName[bestScore(cards)[0]];
  const counts = [...new Map(cards.map(card => [card.rank, cards.filter(other => other.rank === card.rank).length])).values()].sort((a, b) => b - a);
  if (counts[0] === 4) return '四条';
  if (counts[0] === 3) return '三条';
  if (counts[0] === 2 && counts[1] === 2) return '两对';
  if (counts[0] === 2) return '一对';
  return '高牌';
};

const tables = new Map();
const defaultTable = { id: 'main', name: '新手牌桌', smallBlind: 10, bigBlind: 20, maxPlayers: 8, players: [], spectators: new Set(), phase: 'waiting', board: [], pot: 0, dealer: -1, turn: -1, deck: [], turnTimer: null, turnDeadline: null, resultTimer: null, resultDeadline: null, showdownPlayerIds: [], chatMessages: [], message: '等待至少两位玩家入座' };
tables.set(defaultTable.id, defaultTable);
const persist = table => { const { turnTimer, resultTimer, ...snapshot } = table; db.prepare('INSERT INTO game_snapshots(table_id,snapshot,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(table_id) DO UPDATE SET snapshot=excluded.snapshot,updated_at=CURRENT_TIMESTAMP').run(table.id, JSON.stringify({ ...snapshot, spectators: undefined, players: table.players.map(({ socket, reconnectTimer, ...player }) => player) })); };
const publicTable = (table, userId) => {
  const { turnTimer, resultTimer, ...state } = table;
  return {
    ...state,
    deck: undefined,
    spectators: undefined,
    // A different blind or a pending call is not a side pot yet.  Only expose
    // the breakdown after every live player has completed this betting round.
    potBreakdown: hasPendingBettingAction(table) ? [] : calculatePots(table).map(({ amount }) => ({ amount })),
    players: table.players.map(({ socket, reconnectTimer, cards, handName: revealedHandName, lastChatAt, lastEmoteAt, lastVoiceAt, ...p }) => {
      const isSelf = p.userId === userId && p.inHand;
      const isShowdown = table.showdownPlayerIds?.includes(p.userId);
      return { ...p, cards: isSelf || isShowdown ? cards : undefined, handName: isShowdown ? revealedHandName : isSelf && table.phase !== 'waiting' ? currentHandName([...cards, ...table.board]) : undefined };
    }),
  };
};
const broadcast = table => { persist(table); for (const client of [...table.players, ...table.spectators]) if (client.socket?.readyState === 1) client.socket.send(JSON.stringify({ type: 'state', table: publicTable(table, client.userId) })); };
const activePlayers = table => table.players.filter(p => p.inHand && !p.folded);
function sendChat(table, userId, content) {
  const participant = table.players.find(player => player.userId === userId) || [...table.spectators].find(spectator => spectator.userId === userId);
  if (!participant) throw new Error('入座或旁观后才能聊天');
  const text = Array.from(String(content || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 120).join('');
  if (!text) throw new Error('请输入聊天内容');
  const now = Date.now();
  if (now - (participant.lastChatAt || 0) < 800) return;
  participant.lastChatAt = now;
  table.chatMessages = [...(table.chatMessages || []), { userId, username: participant.username, text, at: now }].slice(-100);
  broadcast(table);
}
function sendEmote(table, userId, emote) {
  const player = table.players.find(item => item.userId === userId);
  if (!player) throw new Error('入座后才能发送表情');
  if (!EMOTES.has(emote)) throw new Error('不支持的表情');
  const now = Date.now();
  if (now - (player.lastEmoteAt || 0) < 2_000) return;
  player.lastEmoteAt = now;
  const message = JSON.stringify({ type: 'emote', userId, emote, expiresAt: now + 3_000 });
  for (const client of [...table.players, ...table.spectators]) if (client.socket?.readyState === 1) client.socket.send(message);
}
function sendVoice(table, userId, voice) {
  const player = table.players.find(item => item.userId === userId);
  if (!player) throw new Error('入座后才能发送语音');
  if (!VOICE_LINES.has(voice)) throw new Error('不支持的语音');
  const now = Date.now();
  if (now - (player.lastVoiceAt || 0) < 3_000) return;
  player.lastVoiceAt = now;
  const message = JSON.stringify({ type: 'voice', userId, voice });
  for (const client of [...table.players, ...table.spectators]) if (client.socket?.readyState === 1) client.socket.send(message);
}
function hasPendingBettingAction(table) {
  const alive = activePlayers(table);
  if (!alive.length) return false;
  const maxBet = Math.max(...alive.map(player => player.roundBet));
  return alive.some(player => player.stack > 0 && (!player.acted || player.roundBet !== maxBet));
}
function calculatePots(table) {
  const levels = [...new Set(table.players.map(player => player.totalBet || 0).filter(Boolean))].sort((a, b) => a - b);
  let previous = 0;
  const tiers = levels.map(level => {
    const contributors = table.players.filter(player => (player.totalBet || 0) >= level);
    const amount = (level - previous) * contributors.length;
    previous = level;
    return { amount, eligibleUserIds: contributors.filter(player => player.inHand && !player.folded).map(player => player.userId) };
  }).filter(pot => pot.amount > 0);
  return tiers.reduce((pots, tier) => {
    const previousPot = pots.at(-1);
    if (previousPot && previousPot.eligibleUserIds.join(',') === tier.eligibleUserIds.join(',')) previousPot.amount += tier.amount;
    else pots.push(tier);
    return pots;
  }, []);
}
const nextIndex = (table, from, predicate) => { for (let i = 1; i <= table.players.length; i += 1) { const index = (from + i) % table.players.length; if (predicate(table.players[index])) return index; } return -1; };
const logHand = (table, event) => db.prepare('INSERT INTO hand_logs(table_id,payload) VALUES(?,?)').run(table.id, JSON.stringify({ event, phase: table.phase, pot: table.pot, at: new Date().toISOString() }));
const clearTurnTimer = table => { if (table.turnTimer) clearTimeout(table.turnTimer); table.turnTimer = null; table.turnDeadline = null; };
function scheduleResultCompletion(table) {
  if (table.resultTimer) clearTimeout(table.resultTimer);
  const delay = Math.max(0, (table.resultDeadline || Date.now()) - Date.now());
  table.resultTimer = setTimeout(() => {
    table.resultTimer = null;
    table.resultDeadline = null;
    table.showdownPlayerIds = [];
    table.players.forEach(player => { player.handName = null; });
    removeQueuedLeavers(table);
    broadcast(table);
  }, delay);
}
function beginResultDisplay(table) {
  table.resultDeadline = Date.now() + RESULT_DISPLAY_MS;
  scheduleResultCompletion(table);
}
const restorePlayerConnection = (player, socket) => {
  if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
  player.reconnectTimer = null;
  player.disconnectedAt = null;
  player.socket = socket;
};
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
    try { act(table, current.userId, action, undefined, { timedOut: true }); } catch (error) { console.error('Timed out action failed', error); }
  }, TURN_TIMEOUT_MS);
}
function postBlinds(table) {
  const seated = table.players.filter(p => p.stack > 0); table.dealer = nextIndex(table, table.dealer, p => seated.includes(p));
  const sb = nextIndex(table, table.dealer, p => seated.includes(p)); const bb = nextIndex(table, sb, p => seated.includes(p));
  [[sb, table.smallBlind], [bb, table.bigBlind]].forEach(([index, amount]) => { const p = table.players[index]; const bet = Math.min(p.stack, amount); p.stack -= bet; p.roundBet = bet; p.totalBet = bet; table.pot += bet; });
  table.turn = nextIndex(table, bb, p => p.inHand && !p.folded && p.stack > 0);
}
function startHand(table) {
  const kickedPlayers = table.players.filter(player => player.timeoutStreak >= 3);
  kickedPlayers.forEach(player => {
    if (player.socket?.readyState === 1) {
      player.socket.send(JSON.stringify({ type: 'kicked', reason: '连续 3 次操作超时，已在新一局开始前离桌' }));
    }
    leaveTable(table, player);
  });
  if (table.phase !== 'waiting' || table.players.filter(p => p.stack > 0).length < 2) {
    if (kickedPlayers.length) broadcast(table);
    throw new Error('至少两位有积分的玩家才能开始');
  }
  if (table.resultDeadline) throw new Error('正在展示上一局结果，请稍候');
  table.deck = makeDeck(); table.board = []; table.pot = 0; table.phase = 'preflop'; table.resultDeadline = null; table.showdownPlayerIds = []; table.message = '翻牌前下注';
  table.players.forEach(p => Object.assign(p, { cards: [table.deck.pop(), table.deck.pop()], inHand: p.stack > 0, folded: false, roundBet: 0, totalBet: 0, acted: false, handName: null }));
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
  const contenders = activePlayers(table);
  const scored = contenders.map(p => ({ p, score: bestScore([...p.cards, ...table.board]) }));
  scored.forEach(({ p, score }) => { p.handName = handName[score[0]]; });
  const scoreByUserId = new Map(scored.map(item => [item.p.userId, item]));
  const payoutSummary = calculatePots(table).map((pot, index) => {
    const eligible = pot.eligibleUserIds.map(userId => scoreByUserId.get(userId)).filter(Boolean);
    const high = eligible.map(item => item.score).sort(compareScore).at(-1);
    const winners = eligible.filter(item => compareScore(item.score, high) === 0).map(item => item.p);
    const share = Math.floor(pot.amount / winners.length);
    winners.forEach(player => { player.stack += share; });
    const remainder = pot.amount - share * winners.length;
    const orderFromDealer = [...winners].sort((a, b) => (table.players.indexOf(a) - table.dealer - 1 + table.players.length) % table.players.length - (table.players.indexOf(b) - table.dealer - 1 + table.players.length) % table.players.length);
    orderFromDealer.slice(0, remainder).forEach(player => { player.stack += 1; });
    return `${index ? `边池 ${index}` : '主池'} ${pot.amount}：${winners.map(player => player.username).join('、')}（${handName[high[0]]}）`;
  });
  table.message = payoutSummary.join('；');
  table.showdownPlayerIds = contenders.map(p => p.userId);
  table.phase = 'waiting'; table.turn = -1; beginResultDisplay(table); logHand(table, { pots: payoutSummary }); broadcast(table);
}
function settleIfNeeded(table) {
  const alive = activePlayers(table); if (alive.length === 0) { clearTurnTimer(table); table.phase = 'waiting'; table.turn = -1; table.message = '牌局因所有玩家离桌而结束'; table.pot = 0; beginResultDisplay(table); broadcast(table); return true; }
  if (alive.length === 1) { clearTurnTimer(table); alive[0].stack += table.pot; table.message = `${alive[0].username} 获胜，赢得 ${table.pot} 积分`; table.phase = 'waiting'; table.turn = -1; beginResultDisplay(table); logHand(table, 'all folded'); broadcast(table); return true; }
  if (!hasPendingBettingAction(table)) { revealNext(table); return true; } return false;
}
function act(table, userId, action, amount, options = {}) {
  if (action === 'rebuy') {
    const player = table.players.find(item => item.userId === userId);
    if (!player) throw new Error('你尚未入座');
    if (table.phase !== 'waiting') throw new Error('请在本局结算后补充筹码');
    if (player.stack >= 200) throw new Error('桌上筹码低于 200 时才可补充');
    const requestedAmount = Number(amount);
    if (!Number.isInteger(requestedAmount) || requestedAmount < 1 || requestedAmount > REBUY_MAX_AMOUNT) throw new Error(`补充数额须为 1 至 ${REBUY_MAX_AMOUNT}`);
    const added = db.transaction(() => {
      const account = db.prepare('SELECT points FROM users WHERE id=?').get(userId);
      if (account.points < requestedAmount) throw new Error('账户积分不足');
      db.prepare('UPDATE users SET points=points-? WHERE id=?').run(requestedAmount, userId);
      db.prepare('INSERT INTO wallet_transactions(user_id,amount,reason) VALUES(?,?,?)').run(userId, -requestedAmount, '低筹码补充');
      return { amountToAdd: requestedAmount, points: account.points - requestedAmount };
    })();
    player.stack += added.amountToAdd;
    if (player.socket?.readyState === 1) player.socket.send(JSON.stringify({ type: 'balance', points: added.points }));
    if (!table.resultDeadline) table.message = `${player.username} 补充了 ${added.amountToAdd} 筹码`;
    return broadcast(table);
  }
  if (action === 'leave_after_hand') {
    const player = table.players.find(p => p.userId === userId);
    if (!player) throw new Error('你尚未入座');
    if (table.phase === 'waiting' && !table.resultDeadline) {
      if (player.socket?.readyState === 1) player.socket.send(JSON.stringify({ type: 'left_table' }));
      leaveTable(table, player);
      return broadcast(table);
    }
    player.leaveAfterHand = true;
    if (!table.resultDeadline) table.message = `${player.username} 将在本局结束后下桌`;
    logHand(table, { user: player.username, action });
    return broadcast(table);
  }
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
  player.timeoutStreak = options.timedOut ? (player.timeoutStreak || 0) + 1 : 0;
  player.acted = true; logHand(table, { user: player.username, action, amount });
  if (!settleIfNeeded(table)) { table.turn = nextIndex(table, table.turn, p => p.inHand && !p.folded && p.stack > 0); scheduleTurnTimer(table); broadcast(table); }
}
function leaveTable(table, player) {
  const leavingIndex = table.players.indexOf(player);
  const wasTurn = leavingIndex === table.turn;
  if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
  if (wasTurn) clearTurnTimer(table);
  if (table.phase !== 'waiting' && player.inHand && !player.folded) player.folded = true;
  db.transaction(() => { db.prepare('UPDATE users SET points=points+? WHERE id=?').run(player.stack, player.userId); db.prepare('INSERT INTO wallet_transactions(user_id,amount,reason) VALUES(?,?,?)').run(player.userId, player.stack, '离桌返还筹码'); })();
  table.players = table.players.filter(p => p !== player);
  if (leavingIndex < table.turn) table.turn -= 1;
  if (wasTurn && table.phase !== 'waiting') table.turn = nextIndex(table, leavingIndex - 1, p => p.inHand && !p.folded && p.stack > 0);
}
function removeQueuedLeavers(table) {
  table.players.filter(player => player.leaveAfterHand).forEach(player => {
    if (player.socket?.readyState === 1) player.socket.send(JSON.stringify({ type: 'left_table' }));
    leaveTable(table, player);
  });
}
function scheduleReconnectExpiry(table, player) {
  if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
  player.reconnectTimer = setTimeout(() => {
    if (player.socket || !table.players.includes(player)) return;
    leaveTable(table, player);
    if (table.phase !== 'waiting' && !settleIfNeeded(table)) scheduleTurnTimer(table);
    broadcast(table);
  }, RECONNECT_GRACE_MS);
}
function holdSeatForReconnect(table, player, socket) {
  if (player.socket !== socket) return;
  player.socket = null;
  player.disconnectedAt = Date.now();
  scheduleReconnectExpiry(table, player);
  broadcast(table);
}
function restoreTableFromDatabase(table) {
  const row = db.prepare('SELECT snapshot FROM game_snapshots WHERE table_id=?').get(table.id);
  if (!row) return;
  try {
    const saved = JSON.parse(row.snapshot);
    if (!Array.isArray(saved.players) || !Array.isArray(saved.deck)) return;
    Object.assign(table, saved, {
      spectators: new Set(),
      turnTimer: null,
      turnDeadline: null,
      resultTimer: null,
      players: saved.players.map(player => ({ ...player, socket: null, reconnectTimer: null, disconnectedAt: Date.now() })),
    });
    table.players.forEach(player => scheduleReconnectExpiry(table, player));
    if (table.resultDeadline) scheduleResultCompletion(table);
    if (table.phase !== 'waiting') scheduleTurnTimer(table);
  } catch (error) { console.error('Failed to restore saved table', error); }
}
restoreTableFromDatabase(defaultTable);

const server = http.createServer(app); const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (socket, request) => {
  let user; try { user = jwt.verify(new URL(request.url, 'http://localhost').searchParams.get('token'), JWT_SECRET); } catch { socket.close(1008, '认证失败'); return; }
  socket.user = user;
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  let restored = false;
  tables.forEach(table => {
    const player = table.players.find(item => item.userId === user.id);
    if (player) {
      restorePlayerConnection(player, socket);
      restored = true;
      broadcast(table);
    }
  });
  socket.send(JSON.stringify({ type: 'tables', tables: [...tables.values()].map(t => ({ id: t.id, name: t.name, players: t.players.length, maxPlayers: t.maxPlayers, phase: t.phase })) }));
  if (restored) socket.send(JSON.stringify({ type: 'reconnected' }));
  socket.on('message', raw => { try {
    const message = JSON.parse(raw);
    if (message.type === 'heartbeat') {
      socket.send(JSON.stringify({ type: 'heartbeat_ack', at: Date.now() }));
      return;
    }
    const table = tables.get(message.tableId || 'main'); if (!table) throw new Error('牌桌不存在');
    if (message.type === 'resume') {
      const existingPlayer = table.players.find(p => p.userId === user.id);
      if (existingPlayer) restorePlayerConnection(existingPlayer, socket);
      socket.send(JSON.stringify({ type: 'state', table: publicTable(table, user.id) }));
      if (existingPlayer) broadcast(table);
    } else if (message.type === 'join') {
      const existingPlayer = table.players.find(p => p.userId === user.id);
      if (existingPlayer) { restorePlayerConnection(existingPlayer, socket); return broadcast(table); }
      if (table.players.length >= table.maxPlayers) throw new Error('牌桌已满');
      const account = db.prepare('SELECT points FROM users WHERE id=?').get(user.id); if (account.points < BUY_IN) throw new Error(`积分不足，入桌需要 ${BUY_IN} 积分`);
      db.transaction(() => { db.prepare('UPDATE users SET points=points-? WHERE id=?').run(BUY_IN, user.id); db.prepare('INSERT INTO wallet_transactions(user_id,amount,reason) VALUES(?,?,?)').run(user.id, -BUY_IN, '进入牌桌买入'); })();
      table.players.push({ userId: user.id, username: user.username, stack: BUY_IN, socket, reconnectTimer: null, disconnectedAt: null, timeoutStreak: 0, lastEmoteAt: 0, lastVoiceAt: 0, inHand: false, folded: false, roundBet: 0, totalBet: 0, cards: [] }); broadcast(table);
    } else if (message.type === 'spectate') { table.spectators.add({ userId: user.id, username: user.username, socket }); broadcast(table); }
    else if (message.type === 'chat') sendChat(table, user.id, message.text);
    else if (message.type === 'emote') sendEmote(table, user.id, message.emote);
    else if (message.type === 'voice') sendVoice(table, user.id, message.voice);
    else if (message.type === 'action') act(table, user.id, message.action, message.amount);
  } catch (error) { socket.send(JSON.stringify({ type: 'error', error: error.message || '操作失败' })); } });
  socket.on('close', () => tables.forEach(table => { const player = table.players.find(p => p.userId === user.id); if (player) holdSeatForReconnect(table, player, socket); for (const spectator of table.spectators) if (spectator.socket === socket) table.spectators.delete(spectator); }));
});
const wsHeartbeat = setInterval(() => {
  wss.clients.forEach(socket => {
    if (socket.readyState !== 1) return;
    if (socket.isAlive === false) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  });
}, WS_HEARTBEAT_MS);
server.on('close', () => clearInterval(wsHeartbeat));
server.listen(PORT, () => console.log(`Texas Hold'em is running at http://localhost:${PORT}`));
