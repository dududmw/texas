const $ = id => document.getElementById(id);
const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
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
let wasSeated = false;
let seatLobby = false;
let emotePickerOpen = false;
let voicePickerOpen = false;
let leaderboardOpen = false;
let leaderboardPlayers = [];
const activeEmotes = new Map();
const activeVoices = new Map();
const voiceFiles = { fold: '不要了', calm: '冷静', shove: '推了', call: '跟了' };

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

function showSeatLobby() {
  seatLobby = true;
  wasSeated = false;
  if (table) {
    table = { ...table, players: table.players.filter(player => player.userId !== user.id) };
    render();
  }
  fetch('/api/me', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(result => {
    if (!result.user) return;
    user = result.user;
    $('account').textContent = `${user.username} · ${user.points} 积分`;
  });
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
    if (message.type === 'kicked') { showSeatLobby(); alert(message.reason); return; }
    if (message.type === 'left_table') { showSeatLobby(); return; }
    if (message.type === 'error') return alert(message.error);
    if (message.type === 'balance') {
      user = { ...user, points: message.points };
      $('account').textContent = `${user.username} · ${user.points} 积分`;
      return;
    }
    if (message.type === 'emote') {
      const shownEmote = { ...message, expiresAt: Date.now() + 3_000 };
      activeEmotes.set(message.userId, shownEmote);
      render();
      setTimeout(() => {
        if (activeEmotes.get(message.userId)?.expiresAt !== shownEmote.expiresAt) return;
        activeEmotes.delete(message.userId);
        render();
      }, 3_000);
      return;
    }
    if (message.type === 'voice') {
      const filename = voiceFiles[message.voice];
      if (filename) {
        const shownVoice = { text: filename, expiresAt: Date.now() + 3_000 };
        activeVoices.set(message.userId, shownVoice);
        render();
        setTimeout(() => {
          if (activeVoices.get(message.userId)?.expiresAt !== shownVoice.expiresAt) return;
          activeVoices.delete(message.userId);
          render();
        }, 3_000);
        const audio = new Audio(`/audio/${encodeURIComponent(filename)}.mp3`);
        audio.volume = 0.8;
        void audio.play().catch(() => {});
      }
      return;
    }
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
function quickRebuy() { const amount = Math.min(1000, Math.max(0, user?.points || 0)); if (amount) { const input = $('rebuy'); if (input) input.value = amount; doAction('rebuy', amount); } }
function renderLeaderboard() {
  const modal = $('leaderboard-modal');
  if (!modal) return;
  modal.hidden = !leaderboardOpen;
  if (!leaderboardOpen) return;
  $('leaderboard-list').innerHTML = leaderboardPlayers.length ? leaderboardPlayers.map((player, index) => `<li class="leaderboard-row ${player.id === user?.id ? 'is-self' : ''}"><span class="rank">${index + 1}</span><b>${escapeHtml(player.username)}</b><strong title="总筹码">${player.totalChips}</strong></li>`).join('') : '<li class="leaderboard-empty">暂无玩家数据</li>';
}
async function refreshLeaderboard() {
  try {
    const response = await fetch('/api/leaderboard');
    if (!response.ok) throw Error('排行榜加载失败');
    leaderboardPlayers = (await response.json()).players || [];
    renderLeaderboard();
  } catch { leaderboardPlayers = []; renderLeaderboard(); }
}
function toggleLeaderboard() { leaderboardOpen = !leaderboardOpen; renderLeaderboard(); if (leaderboardOpen) void refreshLeaderboard(); }
function closeLeaderboard() { leaderboardOpen = false; renderLeaderboard(); }
function sendChat() { const input = $('chat-input'); const text = input?.value.trim(); if (!text) return; send({ type: 'chat', text }); input.value = ''; }
function toggleEmotePicker() { emotePickerOpen = !emotePickerOpen; render(); }
function sendEmote(emote) { emotePickerOpen = false; send({ type: 'emote', emote }); render(); }
function toggleVoicePicker() { voicePickerOpen = !voicePickerOpen; render(); }
function sendVoice(voice) { voicePickerOpen = false; send({ type: 'voice', voice }); render(); }

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
    musicMaster.gain.value = 1.3;
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
  if (!table) return;
  if (table.resultDeadline) {
    const resultTimer = $('result-clock');
    if (resultTimer) resultTimer.textContent = `${Math.max(0, Math.ceil((table.resultDeadline - Date.now()) / 1000))} 秒后可开始下一局`;
  }
  if (!table.turnDeadline) return;
  const seconds = Math.max(0, Math.ceil((table.turnDeadline - Date.now()) / 1000));
  const timer = $('turn-clock');
  if (timer) { timer.textContent = `${seconds}s`; timer.classList.toggle('urgent', seconds <= 8); }
}

function actionControls(me) {
  const emoteChoices = [['😏', '得意'], ['😂', '大笑'], ['🤔', '思考'], ['🔥', '火力全开'], ['💀', '翻车'], ['😎', '淡定'], ['🤡', '小丑'], ['😭', '哭了'], ['😡', '生气'], ['👀', '围观'], ['🙏', '拜托'], ['😴', '困了'], ['🎯', '命中'], ['👏', '鼓掌'], ['🍀', '好运'], ['🎲', '骰子']];
  const voiceChoices = [['fold', '不要了'], ['calm', '冷静'], ['shove', '推了'], ['call', '跟了']];
  const resultOpen = Boolean(table.resultDeadline && table.resultDeadline > Date.now());
  const waiting = table.phase === 'waiting';
  const isMine = me && table.turn >= 0 && table.players[table.turn]?.userId === user.id;
  const maxBet = Math.max(0, ...table.players.filter(player => player.inHand && !player.folded).map(player => player.roundBet));
  const call = me ? Math.max(0, maxBet - me.roundBet) : 0;
  const minRaise = maxBet + table.bigBlind;
  const stack = me?.stack ?? 0;
  const canAct = Boolean(isMine && !resultOpen);
  const canRaise = canAct && stack > call;
  const canRebuy = Boolean(me && waiting && stack < 200 && user.points > 0);
  const canStart = Boolean(me && waiting && !resultOpen && table.players.filter(player => player.stack > 0).length >= 2);
  const canShowdown = Boolean(me?.cards?.length && table.showdownOpen && resultOpen && !table.showdownPlayerIds?.includes(user.id));
  const canCommunicate = Boolean(me);
  const disabled = allowed => allowed ? '' : ' disabled aria-disabled="true"';
  const maxRaise = (me?.roundBet ?? 0) + stack;
  const raiseTarget = amount => Math.min(maxRaise, Math.max(minRaise, Math.floor(amount)));
  const bigBlindRaise = multiplier => raiseTarget(maxBet + table.bigBlind * multiplier);
  const potSize = Math.max(table.pot, table.bigBlind);
  const potRaise = multiplier => raiseTarget(maxBet + potSize * multiplier);
  const emotes = `<div class="emote-picker"><button class="secondary" onclick="toggleEmotePicker()" aria-expanded="${emotePickerOpen}"${disabled(canCommunicate)}>😀 表情</button>${emotePickerOpen && canCommunicate ? `<div class="emote-popup" role="dialog" aria-label="选择表情">${emoteChoices.map(([emote, label]) => `<button onclick="sendEmote('${emote}')" title="${label}" aria-label="${label}">${emote}</button>`).join('')}</div>` : ''}</div>`;
  const voices = `<div class="voice-picker"><button class="secondary" onclick="toggleVoicePicker()" aria-expanded="${voicePickerOpen}"${disabled(canCommunicate)}>🔊 语音</button>${voicePickerOpen && canCommunicate ? `<div class="voice-popup" role="dialog" aria-label="选择语音">${voiceChoices.map(([voice, label]) => `<button onclick="sendVoice('${voice}')">${label}</button>`).join('')}</div>` : ''}</div>`;
  return `<section class="in-game-actions control-zone ${canAct ? 'is-active' : ''}" aria-label="局内操作"><div class="operation-grid"><button class="start-action" onclick="doAction('start')"${disabled(canStart)}>开始</button><button onclick="doAction('showdown')"${disabled(canShowdown)}>摊牌</button>${emotes}${voices}<button onclick="doAction('fold')"${disabled(canAct)}>弃牌</button><button onclick="doAction('check')"${disabled(canAct && call === 0)}>过牌</button><button onclick="doAction('call')"${disabled(canAct && call > 0)}>跟注 ${call}</button><button onclick="doAction('allin')"${disabled(canAct && stack > 0)}>All in</button><button onclick="quickRaise(${bigBlindRaise(1)})"${disabled(canRaise)}>1BB</button><button onclick="quickRaise(${bigBlindRaise(2)})"${disabled(canRaise)}>2BB</button><button onclick="quickRaise(${bigBlindRaise(3)})"${disabled(canRaise)}>3BB</button><button onclick="quickRaise(${bigBlindRaise(5)})"${disabled(canRaise)}>5BB</button><button onclick="quickRaise(${potRaise(.5)})"${disabled(canRaise)}>半池</button><button onclick="quickRaise(${potRaise(1)})"${disabled(canRaise)}>满池</button><button onclick="quickRaise(${potRaise(2)})"${disabled(canRaise)}>2 倍底池</button><button onclick="quickRaise(${potRaise(3)})"${disabled(canRaise)}>3 倍底池</button><label class="raise-input">加注到<input id="raise" type="number" min="${minRaise}" max="${maxRaise}" value="${minRaise}"${disabled(canRaise)}></label><button onclick="doAction('raise', +$('raise').value)"${disabled(canRaise)}>加注</button><label class="rebuy-input">补码到<input id="rebuy" type="number" min="1" max="2000" value="1000"${disabled(canRebuy)}></label><button onclick="doAction('rebuy', +$('rebuy').value)"${disabled(canRebuy)}>补码</button><button onclick="quickRebuy()"${disabled(canRebuy)}>快速补码</button></div></section>`;
}

function render() {
  if (!table || !user) return;
  const me = table.players.find(player => player.userId === user.id);
  if (me) { wasSeated = true; seatLobby = false; }
  else if (wasSeated) {
    wasSeated = false;
    seatLobby = true;
    fetch('/api/me', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(result => {
      if (!result.user) return;
      user = result.user;
      $('account').textContent = `${user.username} · ${user.points} 积分`;
    });
  }
  const myIndex = table.players.findIndex(player => player.userId === user.id);
  const seatLayouts = {
    1: [4], 2: [4, 0], 3: [4, 2, 6], 4: [4, 2, 0, 6],
    5: [4, 3, 1, 7, 5], 6: [4, 3, 2, 0, 6, 5],
    7: [4, 3, 2, 1, 7, 6, 5], 8: [4, 3, 2, 1, 0, 7, 6, 5],
  };
  const playersToRender = table.players;
  const turnPlayer = table.players[table.turn];
  $('table-info').textContent = `${table.players.length}/${table.maxPlayers} 人在桌 · ${table.phase}`;
  $('join').disabled = Boolean(me);
  $('join').textContent = me ? '已入座（刷新可恢复）' : '入座（1000 积分）';
  $('leave').hidden = !me;
  $('leave').disabled = Boolean(me?.leaveAfterHand);
  $('leave').textContent = me?.leaveAfterHand ? '已预约：本局结束后下桌' : '本局结束后下桌';
  $('seat-status').textContent = seatLobby ? '你已离桌，请重新入座后继续游戏。' : '';
  $('game-area').hidden = seatLobby;
  $('message').textContent = table.message;
  const potLabels = table.potBreakdown?.length ? table.potBreakdown.map((pot, index) => `${index ? `边池 ${index}` : '主池'} ${pot.amount}`).join(' · ') : `底池 ${table.pot}`;
  $('pot').textContent = potLabels;
  const chatHistory = $('chat-history');
  chatHistory.innerHTML = (table.chatMessages || []).map(message => `<div class="chat-message"><b>${escapeHtml(message.username)}</b><span>${escapeHtml(message.text)}</span></div>`).join('') || '<span class="chat-empty">还没有聊天消息</span>';
  chatHistory.scrollTop = chatHistory.scrollHeight;
  $('board').innerHTML = table.board.length ? table.board.map(card).join('') : '<span class="empty-board">公共牌将在翻牌圈出现</span>';
  $('turn-status').innerHTML = table.resultDeadline ? '<span class="turn-label" id="result-clock"></span>' : turnPlayer ? '' : '<span class="turn-label">等待发牌</span>';
  const occupiedSeats = new Set();
  const playerCards = playersToRender.map((player, index) => {
    const relativeIndex = myIndex < 0 ? index : (index - myIndex + playersToRender.length) % playersToRender.length;
    const seat = seatLayouts[playersToRender.length][relativeIndex];
    occupiedSeats.add(seat);
    const seatRole = [table.dealer === index ? '庄' : '', player.blind === 'small' ? '小' : '', player.blind === 'big' ? '大' : ''].filter(Boolean).join(' · ');
    const playerStatus = player.previewStatus || [player.disconnectedAt ? '重连中' : player.leaveAfterHand ? '本局结束后下桌' : player.folded ? '已弃牌' : player.inHand ? '在局中' : '等待中', player.timeoutStreak ? `超时 ${player.timeoutStreak}/3` : ''].filter(Boolean).join(' · ');
    const isShowdown = Boolean(player.cards?.length && table.showdownPlayerIds?.includes(player.userId));
    const showdownCards = isShowdown ? `<div class="showdown-cards" aria-label="${player.username} 的摊牌">${player.cards.map(card).join('')}</div>` : '';
    const emote = activeEmotes.get(player.userId)?.emote;
    const voice = activeVoices.get(player.userId)?.text;
    return `<article class="player seat-${seat} ${table.turn === index ? 'turn' : ''} ${player.folded ? 'folded' : ''} ${player.disconnectedAt ? 'offline' : ''} ${isShowdown ? 'showdown' : ''}" data-seat="${seat + 1}">${table.turn === index ? '<strong class="seat-timer" id="turn-clock"></strong>' : ''}${emote ? `<span class="emote-bubble" aria-label="${player.username} 发送表情">${emote}</span>` : ''}${voice ? `<span class="voice-bubble" aria-label="${player.username} 发送语音">${voice}</span>` : ''}<div class="player-summary"><b class="player-name" title="${player.username}">${player.username}</b><span class="seat-role" title="${seatRole}">${seatRole}</span><div class="player-stat stack" title="总筹码：${player.stack}"><b>${player.stack}</b></div><div class="player-stat round-bet" title="本轮筹码：${player.roundBet}"><b>${player.roundBet}</b></div><span class="player-status" title="${playerStatus}">${playerStatus}</span><span class="player-hand-strength" title="${player.handName || '未揭晓'}">${player.handName || '未揭晓'}</span></div>${showdownCards}</article>`;
  }).join('');
  const emptySeats = Array.from({ length: 8 }, (_, seat) => occupiedSeats.has(seat) ? '' : `<div class="empty-seat seat-${seat}" aria-label="${seat + 1} 号空座位">${seat + 1}</div>`).join('');
  $('players').innerHTML = `${emptySeats}${playerCards}`;
  const playerInfo = me ? `<div><span>你的筹码</span><b class="my-stack">${me.stack}</b>${me.handName ? `<div class="hand-strength">牌力：${me.handName}</div>` : ''}</div><div class="cards hand">${(me.cards || []).map(card).join('') || '<span>等待发牌</span>'}</div>` : '<span>入座后即可看到你的手牌</span>';
  $('self').innerHTML = `<div class="info-content">${playerInfo}</div>`;
  $('actions').innerHTML = actionControls(me);
  renderLeaderboard();
  if (leaderboardOpen) void refreshLeaderboard();
  updateCountdown();
}

['login', 'register'].forEach(kind => { $(kind).onclick = async () => { try { const result = await request(`/api/${kind}`, { username: $('username').value, password: $('password').value }); token = localStorage.token = result.token; user = result.user; auth(); } catch (error) { $('auth-error').textContent = error.message; } }; });
$('join').onclick = () => { seatLobby = false; send({ type: 'join' }); };
$('leave').onclick = () => send({ type: 'action', action: 'leave_after_hand' });
$('spectate').onclick = () => { seatLobby = false; send({ type: 'spectate' }); };
$('leaderboard').onclick = toggleLeaderboard;
$('leaderboard-close').onclick = closeLeaderboard;
$('leaderboard-modal').onclick = event => { if (event.target === $('leaderboard-modal')) closeLeaderboard(); };
$('leaderboard-modal').onkeydown = event => { if (event.key === 'Escape') closeLeaderboard(); };
$('chat-send').onclick = sendChat;
$('chat-input').onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); sendChat(); } };
$('music').onclick = () => { void toggleMusic(); };
$('logout').onclick = () => { localStorage.removeItem('token'); token = null; clearInterval(heartbeatTimer); clearTimeout(reconnectTimer); ws?.close(); location.reload(); };
setInterval(updateCountdown, 250);
if (token) auth();
