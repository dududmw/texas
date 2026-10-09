const $ = id => document.getElementById(id);
let token = localStorage.token;
let ws;
let table;
let user;

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
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'error') return alert(message.error);
    if (message.type === 'state') { table = message.table; render(); }
  };
  ws.onclose = () => setTimeout(() => token && auth(), 1500);
  fetch('/api/me', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(result => {
    user = result.user;
    $('account').textContent = `${user.username} · ${user.points} 积分`;
    if (table) render();
  });
}

function send(message) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...message, tableId: 'main' })); }
function doAction(action, amount) { send({ type: 'action', action, amount }); }
function quickRaise(amount) { const input = $('raise'); if (input) input.value = amount; doAction('raise', amount); }

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
  const turnPlayer = table.players[table.turn];
  $('table-info').textContent = `${table.players.length}/${table.maxPlayers} 人在桌 · ${table.phase}`;
  $('message').textContent = table.message;
  $('pot').textContent = `底池 ${table.pot}`;
  $('board').innerHTML = table.board.length ? table.board.map(card).join('') : '<span class="empty-board">公共牌将在翻牌圈出现</span>';
  $('turn-status').innerHTML = turnPlayer ? `<span class="turn-label">${turnPlayer.username} 正在思考</span><strong id="turn-clock"></strong>` : '<span class="turn-label">等待发牌</span>';
  $('players').innerHTML = table.players.map((player, index) => `<article class="player ${table.turn === index ? 'turn' : ''} ${player.folded ? 'folded' : ''}"><div class="avatar">${player.username.slice(0, 1).toUpperCase()}</div><div><b>${player.username}</b>${table.dealer === index ? '<span class="dealer">D</span>' : ''}<div class="stack">● ${player.stack}</div><small>${player.folded ? '已弃牌' : player.inHand ? `本轮 ${player.roundBet}` : '等待中'}</small></div></article>`).join('');
  $('self').innerHTML = me ? `<div><span>你的筹码</span><b class="my-stack">${me.stack}</b></div><div class="cards hand">${(me.cards || []).map(card).join('') || '<span>等待发牌</span>'}</div>` : '<span>入座后即可看到你的手牌</span>';
  $('actions').innerHTML = actionControls(me);
  updateCountdown();
}

['login', 'register'].forEach(kind => { $(kind).onclick = async () => { try { const result = await request(`/api/${kind}`, { username: $('username').value, password: $('password').value }); token = localStorage.token = result.token; user = result.user; auth(); } catch (error) { $('auth-error').textContent = error.message; } }; });
$('join').onclick = () => send({ type: 'join' });
$('spectate').onclick = () => send({ type: 'spectate' });
$('logout').onclick = () => { localStorage.removeItem('token'); token = null; ws?.close(); location.reload(); };
setInterval(updateCountdown, 250);
if (token) auth();
