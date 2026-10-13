/* Fish Dot: a cozy two-player paper-folding game.
   Online play goes through Supabase Realtime (broadcast + presence). Every message
   carries the whole game state, so a phone that missed something simply catches up. */
(() => {
  'use strict';

  // ---------- Config ----------
  const SUPABASE_URL = 'https://juuolfpbmoynjvkcanzg.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_aSgcYzOHbFaJUtCAXbWCGw_D9X6hhJ7'; // public key, safe in the browser
  const CHANNEL_PREFIX = 'fishdot-v3-';
  const STATE_VER = 3; // bump when the board or rules change, so old games and old phones don't mix
  // This build's number, taken from "game.js?v=N" in index.html; version.json holds the deployed one.
  const BUILD = Number((/[?&]v=(\d+)/.exec((document.currentScript && document.currentScript.src) || '') || [])[1]) || 0;

  const W = 200, H = 100, MID = 100; // paper units: a wide 2:1 sheet with the fold line at x = 100
  const FISH_COUNT = 10;
  const FISH_W = 12, FISH_H = 7.2; // same 150:90 shape as the fish drawing
  const DOT_R = 1.5;
  const HIT_TOL = 0.8; // the print must really touch the fish: about half the dot over its outline
  const T_FOLD = 380; // ms for each quarter of the fold
  const SEAT_COLORS = ['#7c3aed', '#ec4899'];
  const FISH_COLORS = ['#ff922b', '#4dabf7', '#20c997', '#fcc419', '#94d82d', '#3bc9db', '#f76707', '#1c7ed6', '#40c057', '#15aabf'];

  const YUM_BIG = ['OMG! Yum yum! 😋', 'Yummy yummy! 🤤', 'Oh yum! 😍', 'YUM YUM YUM! 😋'];
  const YUM_SMALL = ['Tasty tasty fish! 🐟', 'Fish is soooo yum! 🐟', 'So tasty! OMG! 🐟', 'Delicious fishy! 🐟'];
  const YUM_SAY = ['Yum yum! Tasty tasty fish!', 'Oh my god! Yummy yummy!', 'Mmm! Fish is so yum!'];
  const ATE_SMALL = ['Oh no! 😱', 'Grrr… eat one back! 😤', 'Your turn. Get the next one! 💪'];
  const MISS_ME = ['Oops! Missed 😅', 'So close! 🙈', 'No fish there 😅'];

  // ---------- Helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
  const round2 = (n) => Math.round(n * 100) / 100;
  const safe = (fn) => { try { fn(); } catch (e) { console.error('fishdot:', e); } };
  const clip = (str, n) => Array.from(str).slice(0, n).join(''); // never cuts an emoji in half

  function randId(len) {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    return Array.from(buf, (v) => abc[v % abc.length]).join('');
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  const store = {
    get(k) { try { return localStorage.getItem('fishdot.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('fishdot.' + k, v); } catch (e) { /* private mode: no saving */ } },
  };

  const me = { id: store.get('id') || randId(12), name: clip(store.get('name') || '', 14) };
  store.set('id', me.id);

  // ---------- Fish + rules ----------
  function makeFish() {
    const EDGE = 8.5; // keeps a tilted fish fully on the paper and off the fold line
    const span = MID - 2 * EDGE; // usable width on each side of the fold
    for (let attempt = 0; attempt < 80; attempt++) {
      const minGap = 15 - attempt * 0.08;
      const fish = [];
      for (let i = 0; i < FISH_COUNT; i++) {
        for (let t = 0; t < 300; t++) {
          // Anywhere on the whole sheet, either side of the fold.
          const u = rand(0, 2 * span);
          const x = u < span ? EDGE + u : MID + EDGE + (u - span);
          const y = rand(7.5, H - 7.5);
          if (fish.every((f) => Math.hypot(f.x - x, f.y - y) > minGap)) {
            fish.push({ x: round2(x), y: round2(y), r: Math.round(rand(-30, 30)), s: round2(rand(0.9, 1.1)), fl: Math.random() < 0.5 ? 1 : 0, ci: 0, e: -1 });
            break;
          }
        }
      }
      const onLeft = fish.filter((f) => f.x < MID).length;
      // Random split, but never an empty or nearly empty half.
      if (fish.length === FISH_COUNT && onLeft >= 3 && onLeft <= FISH_COUNT - 3) {
        const colors = shuffle(FISH_COLORS.map((_, i) => i));
        fish.forEach((f, i) => { f.ci = colors[i % colors.length]; });
        return fish;
      }
    }
    // Never expected, but keep the game playable: two neat columns.
    return Array.from({ length: FISH_COUNT }, (_, i) => ({
      x: i % 2 ? 150 : 50, y: 10 + Math.floor(i / 2) * 20, r: 0, s: 1, fl: i % 2, ci: i % FISH_COLORS.length, e: -1,
    }));
  }

  // The fish's real outline, in the fish drawing's own units (150 x 90 box, centre at 0,0):
  // the oval body (with its outline stroke) plus the tail fan.
  const BODY = { cx: -13, rx: 52, ry: 32 };
  const TAIL = { cx: 55, r: 22 };

  // Which uneaten fish does a print at (px, py) land on? -1 for none.
  function findHit(fish, px, py) {
    let best = -1, bestD = Infinity;
    fish.forEach((f, i) => {
      if (f.e !== -1) return;
      const k = (FISH_W * f.s) / 150; // paper units per drawing unit
      const a = (f.r * Math.PI) / 180;
      const dx = px - f.x, dy = py - f.y;
      let lx = (dx * Math.cos(a) + dy * Math.sin(a)) / k; // undo the tilt
      const ly = (-dx * Math.sin(a) + dy * Math.cos(a)) / k;
      if (f.fl) lx = -lx; // undo the left/right flip
      const tol = HIT_TOL / k;
      const body = ((lx - BODY.cx) / (BODY.rx + tol)) ** 2 + (ly / (BODY.ry + tol)) ** 2;
      const tail = ((lx - TAIL.cx) ** 2 + ly ** 2) / (TAIL.r + tol) ** 2;
      const d = Math.min(body, tail);
      if (d <= 1 && d < bestD) { best = i; bestD = d; }
    });
    return best;
  }

  const seatOf = (s, id) => (s ? s.players.findIndex((p) => p.id === id) : -1);
  const nameOf = (s, seat) => clip((s && s.players[seat] && s.players[seat].name) || (seat === 0 ? 'Player 1' : 'Player 2'), 14);
  const scoreOf = (s, seat) => (s ? s.fish.filter((f) => f.e === seat).length : 0);
  const bump = (s) => { s.version += 1; s.stamp = randId(8); };

  // Newer version wins; on a tie the higher stamp wins, so both phones agree.
  function isNewer(a, b) {
    if (!b) return true;
    if (a.version !== b.version) return a.version > b.version;
    return a.stamp > b.stamp;
  }

  function newGame(code) {
    return {
      ver: STATE_VER, room: code, version: 1, stamp: randId(8), phase: 'waiting', round: 1,
      players: [{ id: me.id, name: me.name }], fish: makeFish(), moves: [], turn: 0, first: 0,
    };
  }

  function validState(s, code) {
    try {
      if (!s || typeof s !== 'object' || s.ver !== STATE_VER || s.room !== (code || room)) return false;
      if (!Number.isInteger(s.version) || typeof s.stamp !== 'string' || !Number.isInteger(s.round)) return false;
      if (!['waiting', 'playing', 'over'].includes(s.phase) || (s.turn !== 0 && s.turn !== 1)) return false;
      if (!Array.isArray(s.players) || s.players.length < 1 || s.players.length > 2) return false;
      if (!s.players.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string')) return false;
      if (!Array.isArray(s.fish) || s.fish.length !== FISH_COUNT) return false;
      if (!s.fish.every((f) => f && isNum(f.x) && isNum(f.y) && isNum(f.r) && isNum(f.s) && f.s > 0.5 && f.s < 2 &&
        Number.isInteger(f.ci) && f.ci >= 0 && (f.e === -1 || f.e === 0 || f.e === 1))) return false;
      if (!Array.isArray(s.moves) || s.moves.length > 500) return false;
      return s.moves.every((m) => m && isNum(m.x) && isNum(m.y) && (m.by === 0 || m.by === 1) &&
        Number.isInteger(m.hit) && m.hit >= -1 && m.hit < FISH_COUNT);
    } catch (e) {
      return false;
    }
  }

  // ---------- DOM ----------
  const paper = $('#paper');
  const halfL = $('#halfL'), halfR = $('#halfR');
  const layerL = $('#layerL'), layerR = $('#layerR');
  const layerOf = (side) => (side === 'L' ? layerL : layerR);
  const sideOf = (x) => (x < MID ? 'L' : 'R');
  document.documentElement.style.setProperty('--fold', T_FOLD + 'ms');

  // ---------- Game + network state ----------
  let room = null; // current room code
  let state = null; // latest known game state (the truth)
  let view = null; // what the screen shows; lags behind `state` while a move animates
  let pending = null; // newer state that arrived mid-animation
  let busy = false; // a move animation is running
  let session = 0; // bumps on entering/leaving a room so stale animations stop
  let peekOver = false; // game-over card hidden to look at the paper
  let overFx = ''; // round whose win effects already played
  let enteredAt = 0;
  const demo = { fish: makeFish(), moves: [] };

  let sb = null, channel = null, connected = false, connFails = 0;
  let connLostAt = 0; // when the live connection last dropped; short blips are ridden out
  let online = new Set(), presenceReady = false;
  let lastSeen = new Map(); // player id -> last time we heard a message from them
  let ticks = 0;
  const debugLog = []; // recent connection events, readable via window.fishdot.log
  const dlog = (...parts) => {
    debugLog.push(new Date().toISOString().slice(11, 23) + ' ' + parts.join(' '));
    if (debugLog.length > 80) debugLog.shift();
  };

  // ---------- Board rendering ----------
  function place(el, side, x, y, w, h) {
    const lx = side === 'L' ? x : x - MID;
    el.style.left = ((lx - w / 2) / MID) * 100 + '%';
    el.style.top = ((y - h / 2) / H) * 100 + '%';
    el.style.width = (w / MID) * 100 + '%';
    el.style.height = (h / H) * 100 + '%';
  }

  function fishSVG(color, rot, flip) {
    const ink = '#3b2414';
    return '<svg viewBox="0 0 150 90" aria-hidden="true"><g transform="rotate(' + rot + ' 75 45)' + (flip ? ' translate(150 0) scale(-1 1)' : '') + '">' +
      '<path d="M104 45 L146 15 Q135 45 146 75 Z" fill="' + color + '" stroke="' + ink + '" stroke-width="4" stroke-linejoin="round"/>' +
      '<path d="M50 20 Q68 -2 92 19 Z" fill="' + color + '" stroke="' + ink + '" stroke-width="4" stroke-linejoin="round"/>' +
      '<path d="M64 70 Q76 87 88 70 Z" fill="' + color + '" stroke="' + ink + '" stroke-width="3.5" stroke-linejoin="round"/>' +
      '<ellipse cx="62" cy="45" rx="50" ry="30" fill="' + color + '" stroke="' + ink + '" stroke-width="4"/>' +
      '<ellipse cx="68" cy="58" rx="26" ry="9" fill="#fff" opacity=".28"/>' +
      '<path d="M54 24 Q64 45 54 66" fill="none" stroke="' + ink + '" stroke-opacity=".4" stroke-width="3.5" stroke-linecap="round"/>' +
      '<path d="M76 32 q6 5 0 10 M90 32 q6 5 0 10 M83 46 q6 5 0 10" fill="none" stroke="' + ink + '" stroke-opacity=".25" stroke-width="3" stroke-linecap="round"/>' +
      '<circle cx="33" cy="38" r="9.5" fill="#fff" stroke="' + ink + '" stroke-width="3"/>' +
      '<circle cx="31" cy="39" r="5" fill="' + ink + '"/>' +
      '<circle cx="29" cy="36.5" r="1.8" fill="#fff"/>' +
      '<circle cx="42" cy="55" r="5" fill="#ff7aa2" opacity=".55"/>' +
      '<path d="M15 50 Q21 56 27 51" fill="none" stroke="' + ink + '" stroke-width="3" stroke-linecap="round"/>' +
      '</g></svg>';
  }

  function crossEl(color, animate) {
    const el = document.createElement('div');
    el.className = 'cross' + (animate ? ' draw' : '');
    el.innerHTML = '<svg viewBox="0 0 150 90" aria-hidden="true"><path d="M20 10 L130 80"/><path d="M130 10 L20 80"/></svg>';
    el.querySelectorAll('path').forEach((p) => p.setAttribute('stroke', color));
    return el;
  }

  function fishEl(f, i) {
    const el = document.createElement('div');
    el.className = 'fish' + (f.e >= 0 ? ' eaten' : '');
    el.dataset.i = String(i);
    place(el, sideOf(f.x), f.x, f.y, FISH_W * f.s, FISH_H * f.s);
    el.innerHTML = fishSVG(FISH_COLORS[f.ci % FISH_COLORS.length], Math.round(f.r), !!f.fl);
    if (f.e >= 0) el.appendChild(crossEl(SEAT_COLORS[f.e], false));
    return el;
  }

  function spotEl(side, x, y, color, kind, old, anim) {
    const el = document.createElement('div');
    el.className = kind + (old ? ' old' : '') + (anim ? ' anim' : '');
    place(el, side, x, y, DOT_R * 2, DOT_R * 2);
    el.style.setProperty('--c', color);
    return el;
  }

  let builtFor = null; // the state the board was last drawn from, so a move can skip a redraw

  function buildBoard(s, fadeAll) {
    builtFor = fadeAll ? null : s;
    layerL.textContent = '';
    layerR.textContent = '';
    if (!s) return;
    s.fish.forEach((f, i) => layerOf(sideOf(f.x)).appendChild(fishEl(f, i)));
    s.moves.forEach((m, i) => {
      const old = fadeAll || i < s.moves.length - 1;
      const color = SEAT_COLORS[m.by];
      const side = sideOf(m.x), other = side === 'L' ? 'R' : 'L';
      layerOf(side).appendChild(spotEl(side, m.x, m.y, color, 'dot', old, false));
      layerOf(other).appendChild(spotEl(other, W - m.x, m.y, color, 'print', old, false));
    });
  }

  function fitPaper() {
    const t = $('#table');
    const w = Math.floor(Math.max(160, Math.min(t.clientWidth - 16, ((t.clientHeight - 12) * W) / H, 1100)));
    paper.style.width = w + 'px';
    paper.style.height = Math.round((w * H) / W) + 'px';
    paper.style.perspective = Math.round(w * 2.2) + 'px'; // same fold depth at any size
  }

  // ---------- UI rendering ----------
  // Presence is the main signal; recent messages back it up if presence hiccups.
  const recentlySeen = (id) => Date.now() - (lastSeen.get(id) || 0) < 12000;
  // Connected, or dropped only a moment ago (moves still go out over plain HTTP meanwhile).
  const linkOk = () => connected || (connLostAt > 0 && Date.now() - connLostAt < 6000);

  function isOnline(s, seat) {
    const p = s && s.players[seat];
    if (!p) return false;
    return p.id === me.id ? linkOk() : online.has(p.id) || recentlySeen(p.id);
  }

  function canTap() {
    const s = state;
    if (!room || !s || busy || !linkOk() || s.phase !== 'playing' || s.players.length < 2) return false;
    const mine = seatOf(s, me.id);
    return mine >= 0 && s.turn === mine && isOnline(s, 1 - mine);
  }

  function renderPlayers() {
    const s = view;
    for (const seat of [0, 1]) {
      const card = $('#p' + seat);
      const p = s && s.players[seat];
      const playing = !!s && s.phase === 'playing' && s.players.length === 2;
      const isTurn = playing && s.turn === seat;
      const on = !!p && isOnline(s, seat);
      let meta;
      if (!p) meta = 'not joined yet';
      else if (isTurn) meta = p.id === me.id ? 'your turn!' : 'thinking… 🤔';
      else if (p.id === me.id) meta = 'you';
      else meta = on ? 'online' : 'offline 💤';
      card.querySelector('.avatar-letter').textContent = p ? (Array.from(p.name.trim())[0] || '?').toUpperCase() : '?';
      card.querySelector('.pname').textContent = p ? nameOf(s, seat) : 'Waiting…';
      card.querySelector('.pmeta').textContent = meta;
      card.classList.toggle('turn', isTurn);
      card.classList.toggle('online', on);
      card.classList.toggle('empty', !p);
      const b = card.querySelector('.pscore b');
      const sc = String(scoreOf(s, seat));
      const key = room + ':' + (s ? s.round : 0);
      if (b.textContent !== sc) {
        const grew = b.dataset.key === key && Number(sc) > Number(b.textContent);
        b.textContent = sc;
        if (grew) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
      }
      b.dataset.key = key;
    }
  }

  function updateStatus() {
    const el = $('#status');
    const s = view;
    let text = '', cls = 'status';
    if (room) {
      const mine = seatOf(s, me.id), opp = 1 - mine;
      if (!s) text = connected ? 'Looking for the game… 🔎' : 'Connecting… 📶';
      else if (busy && view !== state) text = 'Folding the paper… 🤞';
      else if (!linkOk()) text = connFails > 1 ? "Can't reach the game server… retrying 📶" : 'Connecting… 📶';
      else if (mine < 0) text = 'Pick your seat 👀';
      else if (s.phase === 'waiting') text = 'Waiting for your partner to join… 💌';
      else if (s.phase === 'over') text = peekOver ? 'Game over! Tap here for results 🏁' : 'Game over! 🏁';
      else if (!isOnline(s, opp)) text = nameOf(s, opp) + ' is offline 💤 waiting…';
      else if (s.turn === mine) { text = 'Your turn! Tap the paper 💅'; cls += ' myturn'; }
      else text = nameOf(s, opp) + "'s turn… 🤔";
    }
    el.textContent = text;
    el.className = cls;
    paper.classList.toggle('can-tap', canTap());
  }

  function updateOverlays() {
    const s = view;
    const inRoom = !!room;
    const mine = seatOf(s, me.id);
    const looking = inRoom && (!s || (mine < 0 && s.players.length >= 2 && !presenceReady));
    document.body.classList.toggle('home', !inRoom);
    // On a phone held upright this shows the "turn sideways" card (CSS decides by orientation).
    document.body.classList.toggle('in-play', inRoom && !!s && mine >= 0 && s.phase === 'playing');
    $('#home').hidden = inRoom;
    $('#looking').hidden = !looking;
    $('#lobby').hidden = !(inRoom && s && s.phase === 'waiting' && mine >= 0);
    $('#seat').hidden = !(inRoom && s && mine < 0 && s.players.length >= 2 && presenceReady);
    $('#over').hidden = !(inRoom && s && s.phase === 'over' && mine >= 0 && !busy && !peekOver);
    if (looking) fillLooking();
    if (!$('#lobby').hidden) fillLobby();
    if (!$('#seat').hidden) fillSeats();
    if (!$('#over').hidden) fillOver();
  }

  function refreshUI() {
    renderPlayers();
    updateStatus();
    updateOverlays();
  }

  function renderAll() {
    if (!busy) {
      view = state;
      buildBoard(room && state ? state : demo, false);
    }
    refreshUI();
  }

  function fillLooking() {
    $('#lookCode').textContent = room;
    let hint;
    if (!connected) hint = connFails > 1 ? "Can't reach the game server. Check your internet 📶" : 'Connecting to the game server… 📶';
    else if (Date.now() - enteredAt > 5000) hint = 'Make sure your partner has the game open, and the code is right 🙂';
    else hint = "Asking your partner's phone…";
    $('#lookHint').textContent = hint;
  }

  function fillLobby() {
    $('#lobbyCode').textContent = room;
    $('#shareBtn').hidden = !navigator.share;
  }

  function fillSeats() {
    const s = view;
    const box = $('#seatBtns');
    const sig = [0, 1].map((seat) => nameOf(s, seat) + (isOnline(s, seat) ? '+' : '-')).join('|');
    if (box.dataset.sig === sig) return; // unchanged: don't rebuild under a finger
    box.dataset.sig = sig;
    $('#seatNames').textContent = nameOf(s, 0) + ' & ' + nameOf(s, 1);
    box.textContent = '';
    for (const seat of [0, 1]) {
      const b = document.createElement('button');
      b.className = 'btn ' + (seat === 0 ? 'purple' : 'pink');
      b.textContent = "I'm " + nameOf(s, seat);
      if (isOnline(s, seat)) {
        const sm = document.createElement('small');
        sm.textContent = 'playing on another phone right now';
        b.appendChild(sm);
        b.disabled = true;
      }
      b.addEventListener('click', () => takeSeat(seat));
      box.appendChild(b);
    }
  }

  function fillOver() {
    const s = view, mine = seatOf(s, me.id);
    const a = scoreOf(s, 0), b = scoreOf(s, 1);
    const winner = a === b ? -1 : a > b ? 0 : 1;
    let title, sub, icon = '🏆', speech;
    if (winner < 0) {
      title = "It's a tie! 🤝"; sub = 'Same number of fish. Perfect match 💕'; icon = '🤝'; speech = "It's a tie!";
    } else if (winner === mine) {
      title = 'Winner winner\nfish dinner! 🐟🍽️'; sub = 'You win, ' + nameOf(s, winner) + '! 🏆';
      speech = 'Winner winner, fish dinner!';
    } else {
      title = 'Winner winner\nfish dinner! 🐟🍽️'; sub = nameOf(s, winner) + ' wins! Rematch? 😜'; icon = '🐟';
      speech = nameOf(s, winner) + ' wins! Winner winner, fish dinner!';
    }
    $('#overIcon').textContent = icon;
    $('#overTitle').textContent = title;
    $('#overTitle').style.color = winner < 0 ? '' : SEAT_COLORS[winner];
    $('#overSub').textContent = sub;
    const box = $('#finalScores');
    box.textContent = '';
    for (const seat of [0, 1]) {
      const d = document.createElement('div');
      d.className = 'fs';
      d.style.setProperty('--pc', SEAT_COLORS[seat]);
      const n = document.createElement('div');
      n.className = 'n';
      n.textContent = scoreOf(s, seat) + ' 🐟';
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = nameOf(s, seat);
      d.append(n, nm);
      box.appendChild(d);
    }
    const key = room + ':' + s.round;
    if (overFx !== key) {
      overFx = key;
      Sound.win();
      burst(['🎉', '🏆', '🐟', '✨', '💖', '🥳'], 30, null);
      Sound.say(speech, 300);
    }
  }

  // ---------- Banner, toast, particles ----------
  let bannerT1 = 0, bannerT2 = 0, toastT = 0;

  function showBanner(big, small, color, ms) {
    const b = $('#banner');
    clearTimeout(bannerT1);
    clearTimeout(bannerT2);
    b.querySelector('.big').textContent = big;
    b.querySelector('.small').textContent = small;
    b.style.setProperty('--bc', color);
    b.classList.remove('out');
    b.hidden = false;
    const card = b.querySelector('.bcard');
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';
    bannerT1 = setTimeout(() => {
      b.classList.add('out');
      bannerT2 = setTimeout(() => { b.hidden = true; b.classList.remove('out'); }, 300);
    }, ms);
  }

  function hideBanner() {
    clearTimeout(bannerT1);
    clearTimeout(bannerT2);
    $('#banner').hidden = true;
  }

  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    t.style.animation = 'none';
    void t.offsetWidth;
    t.style.animation = '';
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, 2000);
  }

  function burst(emojis, n, origin) {
    const ox = origin ? origin.x : innerWidth / 2;
    const oy = origin ? origin.y : innerHeight / 2;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      p.textContent = pick(emojis);
      const ang = rand(0, Math.PI * 2), dist = rand(90, 230);
      p.style.setProperty('--x', ox + 'px');
      p.style.setProperty('--y', oy + 'px');
      p.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(ang) * dist - 70 + 'px');
      p.style.setProperty('--rot', rand(-180, 180) + 'deg');
      p.style.fontSize = rand(20, 36) + 'px';
      p.style.animationDelay = rand(0, 0.15) + 's';
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 1800);
    }
  }

  // ---------- Sound (all synthesized, no files) ----------
  const Sound = (() => {
    let ctx = null, out = null, noiseBuf = null, primed = false;
    let muted = store.get('muted') === '1';

    function ac() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch (e) { return null; }
        out = ctx.createGain();
        out.gain.value = 0.85;
        out.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function noise(c) {
      if (!noiseBuf) {
        const len = Math.floor(c.sampleRate);
        noiseBuf = c.createBuffer(1, len, c.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      return noiseBuf;
    }

    function envelope(g, t0, peak, a, d) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    }

    function tone(c, o) {
      const t0 = c.currentTime + (o.t || 0), a = o.a || 0.01, d = o.d || 0.2;
      const osc = c.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f0, t0);
      if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + a + d);
      const g = c.createGain();
      envelope(g, t0, o.peak || 0.2, a, d);
      osc.connect(g);
      g.connect(out);
      osc.start(t0);
      osc.stop(t0 + a + d + 0.05);
    }

    function hiss(c, o) {
      const t0 = c.currentTime + (o.t || 0), a = o.a || 0.01, d = o.d || 0.2;
      const src = c.createBufferSource();
      src.buffer = noise(c);
      const f = c.createBiquadFilter();
      f.type = o.filter || 'bandpass';
      f.Q.value = o.q || 0.8;
      f.frequency.setValueAtTime(o.f0 || 1000, t0);
      if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t0 + a + d);
      const g = c.createGain();
      envelope(g, t0, o.peak || 0.2, a, d);
      src.connect(f);
      f.connect(g);
      g.connect(out);
      src.start(t0, Math.random() * 0.3);
      src.stop(t0 + a + d + 0.05);
    }

    // A sound must never break the game.
    const play = (fn) => () => { if (muted) return; try { const c = ac(); if (c) fn(c); } catch (e) { /* ignore */ } };

    function pickVoice() {
      const en = (window.speechSynthesis.getVoices() || []).filter((v) => /^en/i.test(v.lang));
      return en.find((v) => /en[-_]IN/i.test(v.lang)) ||
        en.find((v) => /female|samantha|zira|victoria|karen|moira|tessa|google us english/i.test(v.name)) || en[0] || null;
    }

    return {
      paper: play((c) => {
        hiss(c, { filter: 'bandpass', f0: 500, f1: 2600, q: 0.7, peak: 0.35, a: 0.09, d: 0.38 });
        hiss(c, { filter: 'highpass', f0: 3000, f1: 5200, q: 0.5, peak: 0.07, a: 0.03, d: 0.3 });
        for (let i = 0; i < 6; i++) {
          hiss(c, { t: 0.04 + i * 0.055 + Math.random() * 0.03, filter: 'highpass', f0: 2200, q: 0.6, peak: 0.1 + Math.random() * 0.14, a: 0.003, d: 0.03 });
        }
      }),
      thump: play((c) => {
        tone(c, { f0: 150, f1: 55, peak: 0.55, a: 0.005, d: 0.18 });
        hiss(c, { filter: 'lowpass', f0: 900, f1: 250, q: 0.5, peak: 0.25, a: 0.003, d: 0.09 });
      }),
      drop: play((c) => {
        tone(c, { f0: 1100, f1: 380, peak: 0.25, a: 0.004, d: 0.11 });
        tone(c, { t: 0.06, f0: 720, f1: 520, peak: 0.08, a: 0.004, d: 0.06 });
      }),
      yum: play((c) => {
        for (let i = 0; i < 3; i++) {
          const t = i * 0.17;
          tone(c, { t, type: 'triangle', f0: 270, f1: 150, peak: 0.45, a: 0.01, d: 0.1 });
          hiss(c, { t, filter: 'lowpass', f0: 1500, f1: 500, q: 0.6, peak: 0.25, a: 0.005, d: 0.08 });
        }
        [659, 880, 1047, 1319].forEach((f, i) => tone(c, { t: 0.55 + i * 0.09, f0: f, peak: 0.18, a: 0.01, d: 0.3 }));
      }),
      aww: play((c) => {
        tone(c, { type: 'triangle', f0: 523, f1: 494, peak: 0.25, a: 0.02, d: 0.22 });
        tone(c, { t: 0.26, type: 'triangle', f0: 440, f1: 330, peak: 0.25, a: 0.02, d: 0.42 });
      }),
      miss: play((c) => {
        tone(c, { type: 'triangle', f0: 392, f1: 330, peak: 0.28, a: 0.01, d: 0.2 });
        tone(c, { t: 0.24, type: 'triangle', f0: 311, f1: 233, peak: 0.28, a: 0.01, d: 0.38 });
      }),
      win: play((c) => {
        [523, 659, 784, 1047].forEach((f, i) => tone(c, { t: i * 0.13, type: 'triangle', f0: f, peak: 0.24, a: 0.01, d: 0.3 }));
        [523, 659, 784].forEach((f) => tone(c, { t: 0.6, f0: f, peak: 0.12, a: 0.02, d: 0.9 }));
      }),
      start: play((c) => {
        [784, 988, 1175].forEach((f, i) => tone(c, { t: i * 0.09, f0: f, peak: 0.15, a: 0.01, d: 0.16 }));
      }),
      say(text, delay) {
        if (muted || !('speechSynthesis' in window)) return;
        setTimeout(() => {
          if (muted) return;
          try {
            const synth = window.speechSynthesis;
            const u = new SpeechSynthesisUtterance(text);
            u.rate = 1.05;
            u.pitch = 1.3;
            const v = pickVoice();
            if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
            if (synth.speaking || synth.pending) {
              synth.cancel();
              setTimeout(() => synth.speak(u), 120);
            } else {
              synth.speak(u);
            }
          } catch (e) { /* no voice on this device */ }
        }, delay || 0);
      },
      // Phones only allow sound after a tap, so call this from a click.
      unlock() {
        const c = ac();
        if (c) {
          try {
            const s = c.createBufferSource();
            s.buffer = c.createBuffer(1, 1, 22050);
            s.connect(c.destination);
            s.start(0);
          } catch (e) { /* ignore */ }
        }
        if (!primed && 'speechSynthesis' in window) {
          primed = true;
          try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } catch (e) { /* ignore */ }
        }
      },
      resume() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
      isMuted: () => muted,
      setMuted(m) {
        muted = m;
        store.set('muted', m ? '1' : '0');
        if (m && 'speechSynthesis' in window) { try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
      },
    };
  })();

  // ---------- Moves + fold animation ----------
  const clearTurns = (half) => { if (half.getAnimations) half.getAnimations().forEach((a) => a.cancel()); };

  function resetFold() {
    paper.classList.remove('folding', 'fold-L', 'fold-R', 'press');
    for (const h of [halfL, halfR]) {
      clearTurns(h);
      h.classList.remove('lifting', 'shaded', 'show-back');
    }
  }

  // Swing a half around the fold line; resolves once it has really arrived, so the
  // front/back swap stays exact even on a slow phone. Browsers pause animations in a
  // hidden tab, so a time limit keeps the game from freezing there.
  function turnHalf(half, from, to, easing) {
    const anim = half.animate(
      [{ transform: 'rotateY(' + from + 'deg)' }, { transform: 'rotateY(' + to + 'deg)' }],
      { duration: T_FOLD, easing, fill: 'forwards' },
    );
    return Promise.race([anim.finished.catch(() => {}), wait(T_FOLD + 800)]);
  }

  // Fold the half holding the dot over the other half, press, then open again.
  async function fold(side, sess, atFolded) {
    const half = side === 'L' ? halfL : halfR;
    const other = side === 'L' ? halfR : halfL;
    const dir = side === 'L' ? 1 : -1; // either way the half lifts toward you
    paper.classList.add('folding', 'fold-' + side);
    half.classList.add('lifting');
    other.classList.add('shaded');
    Sound.paper();
    await turnHalf(half, 0, 90 * dir, 'ease-in');
    if (sess !== session) return;
    half.classList.add('show-back'); // edge-on right now, so the swap can't be seen
    await turnHalf(half, 90 * dir, 180 * dir, 'ease-out');
    if (sess !== session) return;
    Sound.thump();
    paper.classList.add('press');
    atFolded();
    await wait(450);
    if (sess !== session) return;
    paper.classList.remove('press', 'fold-' + side);
    other.classList.remove('shaded');
    Sound.paper();
    await turnHalf(half, 180 * dir, 90 * dir, 'ease-in');
    if (sess !== session) return;
    half.classList.remove('show-back');
    await turnHalf(half, 90 * dir, 0, 'ease-out');
    if (sess !== session) return;
    clearTurns(half);
    half.classList.remove('lifting');
    paper.classList.remove('folding');
  }

  async function playMove(prev, next) {
    const sess = session;
    busy = true;
    view = prev;
    const mv = next.moves[next.moves.length - 1];
    const color = SEAT_COLORS[mv.by];
    const side = sideOf(mv.x), other = side === 'L' ? 'R' : 'L';
    try {
      // The board usually already shows `prev`; then just fade the old dots instead of redrawing.
      if (builtFor === prev) paper.querySelectorAll('.dot, .print').forEach((el) => el.classList.add('old'));
      else buildBoard(prev, true);
      refreshUI();
      layerOf(side).appendChild(spotEl(side, mv.x, mv.y, color, 'dot', false, true));
      Sound.drop();
      await wait(550);
      if (sess !== session) return;
      await fold(side, sess, () => layerOf(other).appendChild(spotEl(other, W - mv.x, mv.y, color, 'print', false, true)));
      if (sess !== session) return;
      await wait(200);
      if (sess !== session) return;

      view = next;
      const mine = mv.by === seatOf(next, me.id);
      const who = nameOf(next, mv.by);
      if (mv.hit >= 0) {
        const fe = paper.querySelector('.fish[data-i="' + mv.hit + '"]');
        let origin = null;
        if (fe) {
          fe.classList.add('eaten', 'chomp');
          fe.appendChild(crossEl(color, true));
          const r = fe.getBoundingClientRect();
          origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        refreshUI();
        if (mine) {
          Sound.yum();
          showBanner(pick(YUM_BIG), pick(YUM_SMALL), color, 2100);
          burst(['🐟', '😋', '✨', '💖', '🤤', '🫧'], 16, origin);
          Sound.say(pick(YUM_SAY), 450);
        } else {
          Sound.aww();
          showBanner(who + ' ate a fish! 🐟', next.phase === 'over' ? 'That was the last fish!' : pick(ATE_SMALL), color, 2100);
          Sound.say(who + ' ate a fish!', 350);
        }
        await wait(2300);
      } else {
        refreshUI();
        Sound.miss();
        toast(mine ? pick(MISS_ME) : who + ' missed! 😜 Your turn');
        await wait(900);
      }
    } catch (e) {
      console.error('fishdot:', e);
    } finally {
      if (sess === session) busy = false;
    }
    if (sess !== session) return;
    renderAll();
    afterState(prev);
    if (pending) {
      const p = pending;
      pending = null;
      receiveState(p);
    }
  }

  function makeMove(x, y) {
    const prev = state;
    const mine = seatOf(prev, me.id);
    if (Math.abs(x - MID) < 0.8) x = x < MID ? MID - 0.8 : MID + 0.8; // not exactly on the fold
    x = round2(clamp(x, 0.5, W - 0.5));
    y = round2(clamp(y, 0.5, H - 0.5));
    const hit = findHit(prev.fish, W - x, y); // the print lands at the mirror spot
    const next = clone(prev);
    next.moves.push({ by: mine, x, y, hit });
    if (hit >= 0) next.fish[hit].e = mine;
    next.turn = 1 - mine;
    if (next.fish.every((f) => f.e !== -1)) next.phase = 'over';
    bump(next);
    state = next;
    saveState();
    sendState();
    playMove(prev, next);
  }

  // ---------- State changes ----------
  function saveState() {
    if (room && state) store.set('state.' + room, JSON.stringify(state));
  }

  function loadState(code) {
    try {
      const s = JSON.parse(store.get('state.' + code) || 'null');
      return validState(s, code) ? s : null;
    } catch (e) {
      return null;
    }
  }

  function commitLocal(next) {
    bump(next);
    const prev = state;
    state = next;
    saveState();
    renderAll();
    afterState(prev);
    sendState();
  }

  function receiveState(incoming) {
    if (!validState(incoming) || !isNewer(incoming, state)) return;
    if (busy) {
      if (!pending || isNewer(incoming, pending)) pending = incoming;
      return;
    }
    const prev = state;
    state = incoming;
    saveState();
    if (prev && canAnimate(prev, incoming)) playMove(prev, incoming);
    else { renderAll(); afterState(prev); }
  }

  const canAnimate = (a, b) => !document.hidden && a.phase === 'playing' && a.round === b.round && b.moves.length === a.moves.length + 1;

  function afterState(prev) {
    const s = state;
    if (!s) return;
    if (prev && prev.round !== s.round) peekOver = false;
    const mine = seatOf(s, me.id);
    const started = s.phase === 'playing' && s.moves.length === 0 && (!prev || prev.phase !== 'playing' || prev.round !== s.round);
    if (started && mine >= 0) {
      Sound.start();
      showBanner(s.round > 1 ? 'New game! 🐟' : "Let's play! 🐟", s.turn === mine ? 'You go first! 💅' : nameOf(s, s.turn) + ' goes first!', SEAT_COLORS[s.turn], 2000);
    }
    checkSeat();
  }

  function checkSeat() {
    const s = state;
    if (!room || !s || busy) return;
    const mine = seatOf(s, me.id);
    if (mine >= 0) {
      if (me.name && s.players[mine].name !== me.name) {
        const next = clone(s);
        next.players[mine].name = me.name;
        commitLocal(next);
      }
      return;
    }
    if (s.players.length < 2) { claimSeat(); return; }
    if (!presenceReady) return;
    // Same name, other device offline: that's you on a new phone or browser.
    const same = s.players.findIndex((p, seat) => p.name.trim().toLowerCase() === me.name.trim().toLowerCase() && !isOnline(s, seat));
    if (same >= 0) takeSeat(same);
  }

  function claimSeat() {
    const next = clone(state);
    next.players.push({ id: me.id, name: me.name || 'Player 2' });
    if (next.phase === 'waiting' && next.players.length === 2) {
      next.phase = 'playing';
      next.first = Math.random() < 0.5 ? 0 : 1; // coin flip
      next.turn = next.first;
    }
    commitLocal(next);
  }

  function takeSeat(seat) {
    if (!state || !state.players[seat]) return;
    const next = clone(state);
    next.players[seat] = { id: me.id, name: me.name || next.players[seat].name };
    commitLocal(next);
  }

  function newRound() {
    if (!state || state.players.length < 2 || busy) return;
    const next = clone(state);
    const a = scoreOf(next, 0), b = scoreOf(next, 1);
    next.first = a === b ? 1 - (next.first === 1 ? 1 : 0) : a < b ? 0 : 1; // loser starts
    next.turn = next.first;
    next.round += 1;
    next.fish = makeFish();
    next.moves = [];
    next.phase = 'playing';
    peekOver = false;
    commitLocal(next);
  }

  // ---------- Network ----------
  async function getClient() {
    if (sb) return sb;
    for (let i = 0; i < 100 && !(window.supabase && window.supabase.createClient); i++) await wait(100);
    if (!(window.supabase && window.supabase.createClient)) return null;
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      // A quicker heartbeat notices a dead connection (e.g. after the phone slept) sooner.
      realtime: { params: { eventsPerSecond: 20 }, heartbeatIntervalMs: 10000 },
    });
    return sb;
  }

  async function connect(code) {
    const sess = session;
    const client = await getClient();
    if (sess !== session) return;
    if (!client) {
      connFails = 9;
      refreshUI();
      toast("Couldn't load the game server. Check your internet and reload 🙏");
      return;
    }
    const ch = client.channel(CHANNEL_PREFIX + code, {
      config: { broadcast: { self: false, ack: true }, presence: { key: me.id } },
    });
    channel = ch;
    ch.on('broadcast', { event: 'hello' }, (msg) => { if (channel === ch) safe(() => onHello(msg.payload)); })
      .on('broadcast', { event: 'state' }, (msg) => { if (channel === ch) safe(() => onStateMsg(msg.payload)); })
      .on('broadcast', { event: 'ver' }, (msg) => { if (channel === ch) safe(() => onVer(msg.payload)); })
      .on('presence', { event: 'sync' }, () => { if (channel === ch) safe(onPresence); })
      .subscribe((status, err) => {
        dlog('channel', status, err ? String(err.message || err) : '', channel === ch ? '' : '(stale)');
        if (channel !== ch) return;
        if (status === 'SUBSCRIBED') {
          connected = true;
          connLostAt = 0;
          connFails = 0;
          ch.track({ id: me.id, name: me.name }).catch(() => {});
          sendHello();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (connected) connLostAt = Date.now();
          connected = false;
          connFails += 1;
        }
        refreshUI();
      });
  }

  async function send(event, payload, tries) {
    const ch = channel;
    for (let i = 0; i < tries; i++) {
      if (!ch || channel !== ch) return false;
      try {
        if ((await ch.send({ type: 'broadcast', event, payload })) === 'ok') return true;
      } catch (e) { /* retry below */ }
      await wait(700 * (i + 1));
    }
    return false;
  }

  const sendHello = () => send('hello', { from: me.id, state }, 2);
  const sendState = () => { if (state) send('state', { from: me.id, state }, 4); };

  function heard(id) {
    if (typeof id !== 'string' || id === me.id) return;
    const wasOnline = recentlySeen(id) || online.has(id);
    lastSeen.set(id, Date.now());
    if (!wasOnline) refreshUI();
  }

  function onHello(p) {
    if (!p || p.from === me.id) return;
    heard(p.from);
    const theirs = p.state && validState(p.state) ? p.state : null;
    if (theirs) receiveState(theirs);
    if (state && (!theirs || isNewer(state, theirs))) sendState();
  }

  function onStateMsg(p) {
    if (!p || p.from === me.id) return;
    heard(p.from);
    if (p.state) receiveState(p.state);
  }

  function onVer(p) {
    if (!p || p.from === me.id) return;
    heard(p.from);
    if (!Number.isInteger(p.version) || typeof p.stamp !== 'string') return;
    const theirs = { version: p.version, stamp: p.stamp };
    if (!state || isNewer(theirs, state)) sendHello();
    else if (isNewer(state, theirs)) sendState();
  }

  function onPresence() {
    const ids = new Set();
    for (const [key, metas] of Object.entries(channel.presenceState())) {
      ids.add(key);
      if (Array.isArray(metas)) metas.forEach((m) => { if (m && typeof m.id === 'string') ids.add(m.id); });
    }
    online = ids;
    presenceReady = true;
    refreshUI();
    checkSeat();
  }

  function syncTick() {
    if (!room || !channel) return;
    refreshUI(); // lets stale "online" marks expire
    if (!connected) return;
    ticks += 1;
    if (ticks % 6 === 0) channel.track({ id: me.id, name: me.name }).catch(() => {}); // heal a lost presence
    if (!state) sendHello();
    else send('ver', { from: me.id, version: state.version, stamp: state.stamp }, 1);
  }

  // ---------- Rooms ----------
  function genCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = new Uint32Array(4);
    crypto.getRandomValues(buf);
    return 'FISH-' + Array.from(buf, (v) => abc[v % abc.length]).join('');
  }

  function parseRoom(str) {
    if (!str) return null;
    let c = String(str).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length === 8 && c.startsWith('FISH')) c = c.slice(4);
    return /^[A-Z0-9]{4}$/.test(c) ? 'FISH-' + c : null;
  }

  function leaveRoom() {
    session += 1;
    const ch = channel;
    channel = null;
    if (ch && sb) sb.removeChannel(ch).catch(() => {});
    connected = false;
    connLostAt = 0;
    connFails = 0;
    online = new Set();
    lastSeen = new Map();
    presenceReady = false;
    room = null;
    state = null;
    view = null;
    pending = null;
    busy = false;
    peekOver = false;
    resetFold();
    hideBanner();
  }

  function enterRoom(code, fresh) {
    leaveRoom();
    room = code;
    enteredAt = Date.now();
    store.set('last', code);
    try { history.replaceState(null, '', location.pathname + '?room=' + code); } catch (e) { /* ignore */ }
    state = fresh || loadState(code);
    if (fresh) saveState();
    renderAll();
    afterState(null);
    connect(code);
  }

  function goHome() {
    leaveRoom();
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    renderAll();
    showHome(null);
  }

  function showHome(linkCode) {
    $('#nameInput').value = me.name;
    $('#homeErr').textContent = '';
    $('#joinFromLink').hidden = !linkCode;
    $('#mainActions').hidden = !!linkCode;
    if (linkCode) {
      $('#linkCode').textContent = linkCode;
      const saved = loadState(linkCode);
      $('#joinLinkBtn').textContent = saved && seatOf(saved, me.id) >= 0 ? '▶ Continue game' : 'Join Game';
      $('#joinLinkBtn').dataset.code = linkCode;
    }
    const last = store.get('last');
    const saved = last ? loadState(last) : null;
    const cont = $('#continueBtn');
    const mine = seatOf(saved, me.id);
    cont.hidden = !saved || mine < 0;
    if (!cont.hidden) {
      cont.textContent = saved.players.length === 2 ? '▶ Continue game with ' + nameOf(saved, 1 - mine) : '▶ Continue game ' + last;
      cont.dataset.code = last;
    }
  }

  function requireName() {
    const name = clip($('#nameInput').value.trim().replace(/\s+/g, ' '), 14);
    if (!name) {
      $('#homeErr').textContent = 'Type your name first 🙂';
      $('#nameInput').focus();
      return false;
    }
    me.name = name;
    store.set('name', name);
    return true;
  }

  // ---------- Updates ----------
  // When a newer version is published, offer a one-tap refresh so both phones play the same game.
  let updateOffered = false;
  async function checkForUpdate() {
    if (!BUILD || updateOffered) return;
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const v = (await r.json()).v;
      if (Number.isInteger(v) && v > BUILD) {
        updateOffered = true;
        $('#update').hidden = false;
      }
    } catch (e) { /* offline: try again later */ }
  }

  // ---------- Sharing ----------
  const shareLink = () => location.origin + location.pathname + '?room=' + room;

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ---------- Events ----------
  paper.addEventListener('click', (ev) => {
    if (!room || !state) return;
    if (!canTap()) {
      const mine = seatOf(state, me.id);
      if (busy || mine < 0 || state.phase !== 'playing' || state.players.length < 2) return;
      if (!linkOk()) toast('Reconnecting… one sec 📶');
      else if (!isOnline(state, 1 - mine)) toast(nameOf(state, 1 - mine) + ' is offline. Wait a moment 💤');
      else if (state.turn !== mine) toast("It's " + nameOf(state, 1 - mine) + "'s turn 😉");
      return;
    }
    const r = paper.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = ((ev.clientX - r.left) / r.width) * W;
    const y = ((ev.clientY - r.top) / r.height) * H;
    if (x < 0 || x > W || y < 0 || y > H) return;
    Sound.unlock();
    makeMove(x, y);
  });

  $('#createBtn').addEventListener('click', () => {
    if (!requireName()) return;
    Sound.unlock();
    const code = genCode();
    enterRoom(code, newGame(code));
  });

  $('#joinLinkBtn').addEventListener('click', (ev) => {
    if (!requireName()) return;
    Sound.unlock();
    enterRoom(ev.currentTarget.dataset.code);
  });

  $('#continueBtn').addEventListener('click', (ev) => {
    if (!requireName()) return;
    Sound.unlock();
    enterRoom(ev.currentTarget.dataset.code);
  });

  function joinByCode() {
    const code = parseRoom($('#codeInput').value);
    if (!code) {
      $('#homeErr').textContent = 'That code looks wrong. It looks like FISH-AB12 🙂';
      return;
    }
    if (!requireName()) return;
    Sound.unlock();
    enterRoom(code);
  }

  $('#joinCodeBtn').addEventListener('click', joinByCode);
  $('#codeInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') joinByCode(); });
  $('#nameInput').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (!$('#joinFromLink').hidden) $('#joinLinkBtn').click();
    else $('#createBtn').click();
  });

  $('#notThisGame').addEventListener('click', () => {
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    showHome(null);
  });

  $('#homeBtn').addEventListener('click', goHome);
  $('#lookBack').addEventListener('click', goHome);
  $('#seatBack').addEventListener('click', goHome);

  $('#muteBtn').addEventListener('click', () => {
    const m = !Sound.isMuted();
    Sound.setMuted(m);
    $('#muteBtn').textContent = m ? '🔇' : '🔊';
    if (!m) { Sound.unlock(); Sound.start(); }
  });

  $('#waBtn').addEventListener('click', () => {
    const text = "Let's play Fish Dot! 🐟 Join my game: " + shareLink();
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  });

  $('#copyBtn').addEventListener('click', async () => {
    if (await copyText(shareLink())) toast('Link copied! 📋 Send it to your partner');
    else toast('Copy failed. The code is ' + room);
  });

  $('#shareBtn').addEventListener('click', () => {
    navigator.share({ title: 'Fish Dot 🐟', text: "Let's play Fish Dot! 🐟", url: shareLink() }).catch(() => {});
  });

  $('#againBtn').addEventListener('click', newRound);
  $('#overPeek').addEventListener('click', () => { peekOver = true; refreshUI(); });
  $('#status').addEventListener('click', () => { if (peekOver) { peekOver = false; refreshUI(); } });

  $('#update').addEventListener('click', () => {
    // A fresh query string skips any cached copy of the page.
    location.replace(location.pathname + (room ? '?room=' + encodeURIComponent(room) + '&' : '?') + 'u=' + Date.now());
  });

  document.addEventListener('pointerdown', () => Sound.resume(), { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    checkForUpdate();
    if (room && channel && connected) sendHello();
  });
  window.addEventListener('unhandledrejection', (e) => console.warn('fishdot:', e.reason));

  if (window.ResizeObserver) new ResizeObserver(fitPaper).observe($('#table'));
  window.addEventListener('resize', fitPaper);

  // Read-only peek for debugging in the console.
  window.fishdot = {
    get state() { return state; },
    get connected() { return connected; },
    get online() { return [...online]; },
    get presence() { return channel ? channel.presenceState() : null; },
    get log() { return debugLog.slice(); },
    get socket() { return sb && sb.realtime ? sb.realtime.connectionState() : null; },
    build: BUILD,
  };

  // ---------- Boot ----------
  fitPaper();
  $('#muteBtn').textContent = Sound.isMuted() ? '🔇' : '🔊';
  renderAll();
  showHome(parseRoom(new URLSearchParams(location.search).get('room')));
  setInterval(syncTick, 5000);
  setTimeout(checkForUpdate, 4000);
  setInterval(checkForUpdate, 10 * 60 * 1000);
})();
