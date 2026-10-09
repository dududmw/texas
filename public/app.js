const $ = id => document.getElementById(id);
let token = localStorage.token;
let ws;
let table;
let user;
let heartbeatTimer;
let reconnectTimer;
let reconnectAttempts = 0;
let lastHeartbeatAck = 0;
let musicContext;
let musicTimer;
let musicEnabled = false;
let musicStep = 0;
let musicMaster;

const card = value => {
  if (!value) return '';
  const rank = value.rank === 'T' ? '10' : value.rank;
  const red = value.suit === '♥' || value.suit === '♦';
  return `<span class="playing-card ${red ? 'red' : ''}"><b>${rank}</b><i>${value.suit}</i></span>`;
};

async function request(url, data) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}

function auth() {
  $('auth').hidden = true;
  $('game').hidden = false;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    reconnectAttempts = 0;
    lastHeartbeatAck = Date.now();
    heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastHeartbeatAck > 45_000) return ws.close();
      send({ type: 'heartbeat' });
    }, 15_000);
    send({ type: 'resume' });
  };
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'heartbeat_ack') { lastHeartbeatAck = Date.now(); return; }
    if (message.type === 'kicked') { alert(message.reason); return; }
    if (message.type === 'error') return alert(message.error);
    if (message.type === 'state') { table = message.table; render(); }
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    clearInterval(heartbeatTimer);
    if (!token) return;
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 10_000);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(auth, delay);
  };
  fetch('/api/me', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(result => {
    user = result.user;
    $('account').textContent = `${user.username} · ${user.points} 积分`;
    if (table) render();
  });
}

function send(message) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...message, tableId: 'main' })); }
function doAction(action, amount) { send({ type: 'action', action, amount }); }
function quickRaise(amount) { const input = $('raise'); if (input) input.value = amount; doAction('raise', amount); }

// A quiet, minor-key lounge loop: it deliberately leaves space for the table action.
const musicBars = [
  { bass: 55.0, chord: [164.81, 196, 246.94, 293.66], melody: [659.25, 587.33, 493.88] },
  { bass: 49.0, chord: [146.83, 174.61, 220, 261.63], melody: [587.33, 523.25, 440] },
  { bass: 41.2, chord: [123.47, 146.83, 196, 233.08], melody: [493.88, 440, 392] },
  { bass: 43.65, chord: [130.81, 164.81, 207.65, 246.94], melody: [523.25, 493.88, 440] },
];

function playTone(frequency, start, duration, volume, type = 'triangle') {
  const oscillator = musicContext.createOscillator();
  const gain = musicContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.025);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(musicMaster);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

function playMusicPhrase() {
  if (!musicEnabled || !musicContext) return;
  const bar = musicBars[musicStep % musicBars.length];
  const now = musicContext.currentTime + 0.04;
  const beat = 0.625; // 96 BPM, relaxed enough not to distract during a hand.

  // Upright-bass pulse and muted seventh chords.
  [0, 1.5, 2, 3.5].forEach((offset, index) => playTone(bar.bass * (index === 3 ? 1.5 : 1), now + offset * beat, beat * 0.72, 0.036, 'sine'));
  [0.35, 2.35].forEach(offset => bar.chord.forEach((note, index) => playTone(note, now + offset * beat, beat * 1.25, 0.011 - index * 0.001, 'triangle')));

  // A sparse high-register reply keeps the loop from sounding like a notification.
  bar.melody.forEach((note, index) => playTone(note, now + (1 + index * 0.88) * beat, beat * 0.52, 0.008, 'sine'));
  musicStep += 1;
}
async function toggleMusic() {
  if (!musicContext) {
    musicContext = new AudioContext();
    musicMaster = musicContext.createGain();
    musicMaster.gain.value = 0.72;
    musicMaster.connect(musicContext.destination);
  }
  musicEnabled = !musicEnabled;
  if (musicEnabled) {
    await musicContext.resume();
    playMusicPhrase();
    musicTimer = setInterval(playMusicPhrase, 2500);
    $('music').textContent = '♫ 氛围音乐：开';
  } else {
    clearInterval(musicTimer);
    await musicContext.suspend();
    $('music').textContent = '♫ 氛围音乐：关';
  }
}

function updateCountdown() {
  if (!table?.turnDeadline) return;
  const seconds = Math.max(0, Math.ceil((table.turnDeadline - Date.now()) / 1000));
  const timer = $('turn-clock');
  if (timer) { timer.textContent = `${seconds}s`; timer.classList.toggle('urgent', seconds <= 8); }
}

function actionControls(me) {
  if (table.phase === 'waiting' && me) return '<button class="primary" onclick="doAction(\'start\')">发牌开始下一局</button>';
  const isMine = me && table.turn >= 0 && table.players[table.turn]?.userId === user.id;
  if (!isMine) return '<span class="waiting-action">等待其他玩家操作…</span>';
  const maxBet = Math.max(...table.players.filter(player => player.inHand && !player.folded).map(player => player.roundBet));
  const call = maxBet - me.roundBet;
  const minRaise = maxBet + table.bigBlind;
  const twoBigBlinds = maxBet + table.bigBlind * 2;
  const potRaise = Math.min(me.roundBet + me.stack, maxBet + Math.max(table.pot, table.bigBlind));
  const canRaise = me.stack > call;
  return `<div class="main-actions"><button class="danger" onclick="doAction('fold')">弃牌</button>${call === 0 ? '<button onclick="doAction(\'check\')">过牌</button>' : `<button onclick="doAction('call')">跟注 ${call}</button>`}<button class="all-in" onclick="doAction('allin')">全下 ${me.stack}</button></div>${canRaise ? `<div class="raise-actions"><button class="secondary" onclick="quickRaise(${minRaise})">最小加注 ${minRaise}</button><button class="secondary" onclick="quickRaise(${Math.min(me.roundBet + me.stack, twoBigBlinds)})">+2BB</button><button class="secondary" onclick="quickRaise(${potRaise})">底池加注</button><label>总下注<input id="raise" type="number" min="${minRaise}" max="${me.roundBet + me.stack}" value="${minRaise}"></label><button onclick="doAction('raise', +$('raise').value)">确认加注</button></div>` : ''}`;
}

function render() {
  if (!table || !user) return;
  const me = table.players.find(player => player.userId === user.id);
  const myIndex = table.players.findIndex(player => player.userId === user.id);
  const seatLayouts = {
    1: [4], 2: [4, 0], 3: [4, 2, 6], 4: [4, 2, 0, 6],
    5: [4, 3, 1, 7, 5], 6: [4, 3, 2, 0, 6, 5],
    7: [4, 3, 2, 1, 7, 6, 5], 8: [4, 3, 2, 1, 0, 7, 6, 5],
  };
  const turnPlayer = table.players[table.turn];
  $('table-info').textContent = `${table.players.length}/${table.maxPlayers} 人在桌 · ${table.phase}`;
  $('join').disabled = Boolean(me);
  $('join').textContent = me ? '已入座（刷新可恢复）' : '入座（500 积分）';
  $('message').textContent = table.message;
  $('pot').textContent = `底池 ${table.pot}`;
  $('board').innerHTML = table.board.length ? table.board.map(card).join('') : '<span class="empty-board">公共牌将在翻牌圈出现</span>';
  $('turn-status').innerHTML = turnPlayer ? '' : '<span class="turn-label">等待发牌</span>';
  $('players').innerHTML = table.players.map((player, index) => {
    const relativeIndex = myIndex < 0 ? index : (index - myIndex + table.players.length) % table.players.length;
    const seat = seatLayouts[table.players.length][relativeIndex];
    const timeoutInfo = player.timeoutStreak ? `超时 ${player.timeoutStreak}/3 · ` : '';
    const status = player.disconnectedAt ? '重连中（保留座位）' : player.folded ? '已弃牌' : player.inHand ? `本轮 ${player.roundBet}` : '等待中';
    return `<article class="player seat-${seat} ${table.turn === index ? 'turn' : ''} ${player.folded ? 'folded' : ''} ${player.disconnectedAt ? 'offline' : ''}">${table.turn === index ? '<strong class="seat-timer" id="turn-clock"></strong>' : ''}<div class="avatar">${player.username.slice(0, 1).toUpperCase()}</div><div><b>${player.username}</b>${table.dealer === index ? '<span class="dealer">D</span>' : ''}<div class="stack">● ${player.stack}</div><small>${timeoutInfo}${status}</small></div></article>`;
  }).join('');
  $('self').innerHTML = me ? `<div><span>你的筹码</span><b class="my-stack">${me.stack}</b></div><div class="cards hand">${(me.cards || []).map(card).join('') || '<span>等待发牌</span>'}</div>` : '<span>入座后即可看到你的手牌</span>';
  $('actions').innerHTML = actionControls(me);
  updateCountdown();
}

['login', 'register'].forEach(kind => { $(kind).onclick = async () => { try { const result = await request(`/api/${kind}`, { username: $('username').value, password: $('password').value }); token = localStorage.token = result.token; user = result.user; auth(); } catch (error) { $('auth-error').textContent = error.message; } }; });
$('join').onclick = () => send({ type: 'join' });
$('spectate').onclick = () => send({ type: 'spectate' });
$('music').onclick = () => { void toggleMusic(); };
$('logout').onclick = () => { localStorage.removeItem('token'); token = null; clearInterval(heartbeatTimer); clearTimeout(reconnectTimer); ws?.close(); location.reload(); };
setInterval(updateCountdown, 250);
if (token) auth();
