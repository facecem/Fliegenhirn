// Fliegenhirn DJ - verbindet Hirn-Simulation (Worker), DJ-Audio und 3D-Buehne.
// Hirn -> Pult: die 8 Ausgangskanaele (absteigende Neuronen, links = Deck 1, rechts = Deck 2) entscheiden,
// WANN gemixt wird, MIT WELCHER Technik und welche Regler zwischendurch gedreht werden.
// Das Taktraster (Beatmatch, Einsatz auf der Eins) uebernimmt die Pult-Automatik, damit es nach Musik klingt.
import * as A from './audio.js';
import { createScene } from './scene.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => x < a ? a : x > b ? b : x;
const CH = ['low', 'mid', 'high', 'fader'];
const NAME = { low: 'Bass', mid: 'Mitten', high: 'Höhen', fader: 'Fader' };

const deckUI = [];
let N = 0, E = 0, conBuf = null, neuBuf = null, xy = null;
let worker = null, scene3d = null, decks = [], playlist = [], plNext = 0, live = 0, paused = false, running = false;
let trans = null, ramps = [], urge = 0, liveSince = 0, gestureCool = 0, lastBeat = -1, forceMix = false, flash = 0;
const focus = [{ name: null, until: 0 }, { name: null, until: 0 }], jogUntil = [0, 0];
const fast = new Float32Array(8), slow = new Float32Array(8), vr = new Float32Array(8).fill(1), z = new Float32Array(8);
const sideZ = [0, 0], sig = new Float32Array(8);   // sig = Hirn-Kanaele durch die Matrix der aktuellen Variante
let lastTick = { n: 0, cost: 0 }, spikeRate = 0, recent = [], clsSm = new Float32Array(8);

// ------------------------------------------------------- Evolution ----
// Das Hirn selbst bleibt der echte Scan. Was sich entwickelt, ist die Fliege drumherum: welche Ausgangs-
// neuronen welchen Regler bewegen (Matrix W), wie ungeduldig sie mixt, welche Techniken sie mag, wie erregbar
// ihr Hirn ist. Mehrere Varianten wechseln sich pro Uebergang ab; Daumen hoch/runter ist ihre Fitness.
const EVO_KEY = 'fliegenhirn-dj-evo-v1', POP = 6;
const gauss = () => { let u = 0; for (let i = 0; i < 4; i++) u += Math.random(); return (u - 2) * 1.73; };
function baseGenome() { const W = new Array(64).fill(0); for (let i = 0; i < 8; i++) W[i * 9] = 1; return { W, urge: 1, lead: 1, gTh: 1.1, len: 0, spin: 0, tech: [0, 0, 0, 0], gain: 1, fit: 0, votes: 0, id: 1, parent: 0 }; }
function mutate(g, s = 1) {
  const c = JSON.parse(JSON.stringify(g)); c.fit = 0; c.votes = 0; c.parent = g.id; c.id = evo.nextId++;
  for (let i = 0; i < 64; i++) if (Math.random() < 0.15) c.W[i] = clamp(c.W[i] + gauss() * 0.45 * s, -1.5, 1.5);
  c.urge = clamp(c.urge * Math.exp(gauss() * 0.35 * s), 0.4, 3); c.lead = clamp(c.lead * Math.exp(gauss() * 0.35 * s), 0.2, 4);
  c.gTh = clamp(c.gTh + gauss() * 0.25 * s, 0.5, 2.5); c.len = clamp(c.len + gauss() * 0.6 * s, -1.6, 1.6); c.spin = clamp(c.spin + gauss() * 0.6 * s, -1.6, 1.6);
  c.tech = c.tech.map(t => clamp(t + gauss() * 0.6 * s, -2, 2)); c.gain = clamp(c.gain + gauss() * 0.04 * s, 0.88, 1.12);
  return c;
}
function freshEvo() { const e = { gen: 1, cur: 0, nextId: 2, pop: [baseGenome()] }; evo = e; while (e.pop.length < POP) e.pop.push(mutate(e.pop[0])); return e; }
function loadEvo() { try { const e = JSON.parse(localStorage.getItem(EVO_KEY)); if (e && e.pop && e.pop.length === POP && e.pop[0].W.length === 64) return e; } catch (err) { } return freshEvo(); }
function saveEvo() { try { localStorage.setItem(EVO_KEY, JSON.stringify(evo)); } catch (err) { } }
let evo = null; evo = loadEvo();
const G = () => evo.pop[evo.cur];
const fitStr = (g) => (g.fit > 0 ? '+' : '') + g.fit;
function bestOther() { let b = null; for (const g of evo.pop) if (g !== G() && (!b || g.fit > b.fit)) b = g; return b; }
let lastTech = null, lastPair = null;
function vote(v) {
  if (!running) return;
  if (mode === 'plan') {
    if (!lastTech) { say(live, 'Noch nichts zu bewerten'); return; }
    fetch('vote?tech=' + lastTech + '&v=' + v, { method: 'POST' }).catch(() => { });
    if (lastPair) fetch('rate?a=' + encodeURIComponent(lastPair[0]) + '&b=' + encodeURIComponent(lastPair[1]) + '&tech=' + lastTech + '&v=' + v, { method: 'POST' }).catch(() => { });
    say(live, v > 0 ? 'Gemerkt: öfter' : 'Gemerkt: seltener'); return;
  }
  const g = G(); g.fit += v; g.votes++;
  if (v > 0) {            // Daumen hoch: ein leicht veraendertes Kind ersetzt die schwaechste andere Variante
    let w = -1; for (let i = 0; i < POP; i++) if (i !== evo.cur && (w < 0 || evo.pop[i].fit < evo.pop[w].fit)) w = i;
    if (evo.pop[w].fit <= 0) evo.pop[w] = mutate(g, 0.6);
    log(live, 'Daumen hoch → Variante ' + (evo.cur + 1) + ' jetzt ' + fitStr(g) + ', bekommt Nachwuchs');
  } else if (g.fit <= -2) {  // zweimal durchgefallen: stirbt aus, ein Kind der besten anderen uebernimmt sofort
    const p = bestOther(); evo.pop[evo.cur] = mutate(p, 1);
    log(live, 'Daumen runter → Variante ' + (evo.cur + 1) + ' stirbt aus, Kind der besten (' + fitStr(p) + ') übernimmt');
  } else log(live, 'Daumen runter → Variante ' + (evo.cur + 1) + ' jetzt ' + fitStr(g));
  saveEvo();
}
function evoNext() {          // nach jedem Uebergang ist die naechste Variante dran; nach einer Runde wird ausgesiebt
  evo.cur = (evo.cur + 1) % POP;
  if (evo.cur === 0 && evo.pop.some(g => g.votes > 0)) {
    const s = [...evo.pop].sort((a, b) => b.fit - a.fit), keep = s.slice(0, 3);
    evo.pop = keep.concat(keep.map((p, i) => mutate(i === 2 ? keep[0] : p, 1)));
    for (const g of keep) { g.fit = Math.trunc(g.fit / 2); g.votes = 0; }
    evo.gen++; log(live, 'Generation ' + evo.gen + ': die 3 besten bleiben, 3 mutierte Kinder kommen dazu');
  }
  saveEvo();
}

// ------------------------------------------------------------ Laden ----
async function fetchBin(url, onp) {
  const r = await fetch(url); if (!r.ok) throw new Error(url + ' fehlt (' + r.status + ')');
  const total = +r.headers.get('content-length') || 0, rd = r.body.getReader(), chunks = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); got += value.length; onp(total ? got / total : 0); }
  const out = new Uint8Array(got); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out.buffer;
}
(async function boot() {
  buildDeckPanels();
  const bar = document.querySelector('#prog i'), b = $('bStart');
  try {
    const meta = await (await fetch('meta.json')).json(); N = meta.N; E = meta.E;
    neuBuf = await fetchBin('neurons.bin', () => { });
    conBuf = await fetchBin('connectome.bin', (p) => { bar.style.width = (p * 100).toFixed(1) + '%'; });
    xy = new Float32Array(neuBuf.slice(0, N * 8));
    bar.style.width = '100%'; b.textContent = 'Start';
    drawBrainBase();
    try { folderSongs = await (await fetch('songs.json')).json(); } catch (err) { folderSongs = []; }
    try { const v = localStorage.getItem('fliegenhirn-dj-pace'); if (v && [...$('pace').options].some(o => o.value === v)) $('pace').value = v; } catch (err) { }
    $('paceRow').hidden = !folderSongs.length;
    if (new URLSearchParams(location.search).has('show')) { try { const sd = await (await fetch('show.json')).json(); if (folderSongs.some(s => s.key === sd.a) && folderSongs.some(s => s.key === sd.b)) showData = sd; } catch (err) { } }
    if (showData) { $('paceRow').hidden = true; b.textContent = 'Ikkimel-Übergang'; b.disabled = false; return; }
    if (CHECK) { runChecks(); return; }
    await loadPlan(); b.disabled = false;
    $('pace').onchange = async () => { try { localStorage.setItem('fliegenhirn-dj-pace', $('pace').value); } catch (err) { } b.disabled = true; await loadPlan(); b.disabled = false; };
  } catch (err) {
    b.textContent = 'Connectome nicht gefunden';
    document.querySelector('#gate small').textContent = 'Fehler: ' + err.message + ' – bitte über start.bat öffnen (die Seite braucht einen lokalen Server) und vorher build_connectome.py laufen lassen.';
  }
})();
// Set-Plan holen; der Server analysiert dabei neue Songs und plant neu, wenn sich Songs oder Takt geaendert haben
async function loadPlan() {
  const b = $('bStart'); plan = null;
  if (!folderSongs.length) return;
  b.textContent = 'Plane ' + folderSongs.length + ' Songs …';
  try { const p = await (await fetch('plan.json?play=' + $('pace').value)).json(); if (p.songs.length > 1 && folderSongs.every(s => p.songs.some(q => q.key === s.key))) plan = p; } catch (err) { }
  b.textContent = 'Start · ' + folderSongs.length + ' Songs';
  if (!plan) document.querySelector('#gate small').textContent = 'Kein Plan – das Hirn mixt spontan.';
}

$('bStart').onclick = async () => {
  const b = $('bStart'); b.disabled = true; b.textContent = 'Lade …';
  A.initAudio(REC && showData ? 0.3 + (showData.aDrop - showData.aStart) + 84 * showData.spbA + 0.4 : 0);
  await new Promise(r => setTimeout(r, 30));
  if (plan) {
    plan.songs.forEach((ps, i) => { const f = folderSongs.find(s => s.key === ps.key); const en = fileEntry(ps.name, ps.key, () => fetch(f.url).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }));
      en.oi = i; en.info = { bpm: ps.bpm, phase: ps.beats[ps.phi] % (60 / ps.bpm), grid: ps.stable ? 9 : 0 }; playlist.push(en); });
    setMode('plan');
  } else if (folderSongs.length) for (const s of folderSongs) { const get = () => fetch(s.url).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }); const en = fileEntry(s.name, s.key, get); en.scan = get; playlist.push(en); }
  else for (let k = 0; k < A.DEMO_COUNT; k++) playlist.push(demoEntry(k));
  decks = [new A.Deck(0), new A.Deck(1)];
  scene3d = createScene($('view'), [deckUI[0].cv, deckUI[1].cv]);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) scene3d.orbit.autoRotate = false;
  worker = new Worker('brain.worker.js');
  worker.onmessage = onBrain;
  worker.postMessage({ type: 'init', con: conBuf, neu: neuBuf, N, E }, [conBuf]);
  if (showData && REC) { $('gate').remove(); running = true; offlineRender(); return; }
  if (showData) { await runShow(); $('gate').remove(); $('bPlay').disabled = false; running = true; requestAnimationFrame(frame); return; }
  await loadDeck(0); loadDeck(1); if (!plan) scanTempos();
  const t0 = decks[0].track;
  decks[0].goal.fader = 1; decks[0].play(A.ctx.currentTime + 0.15, 1); live = 0; liveSince = A.ctx.currentTime;
  $('gate').remove(); $('bPlay').disabled = false; $('bMix').disabled = false; running = true; setMode(mode);
  log(0, 'Deck 1 läuft: „' + t0.name + '“. Das Hirn hört jetzt zu.');
  requestAnimationFrame(frame);
};

$('bPlay').onclick = () => { paused = !paused; $('bPlay').textContent = paused ? 'Weiter' : 'Pause'; if (paused) A.ctx.suspend(); else A.ctx.resume(); worker.postMessage({ type: 'run', on: !paused }); };
$('bMix').onclick = () => { forceMix = true; };
function setMode(m) {
  mode = m; const pl = m === 'plan';
  $('bMode').textContent = pl ? 'Plan' : 'Spontan'; $('bEvo').hidden = pl; $('bMode').hidden = !plan;
  $('bUp').disabled = $('bDown').disabled = !running; $('bList').hidden = !plan; $('bMix').textContent = pl ? 'Skip' : 'Mix';
}
$('bMode').onclick = () => { if (!plan || trans) return; setMode(mode === 'plan' ? 'hirn' : 'plan'); if (mode === 'plan') { const en = decks[live].entry; planNext = en && en.oi !== undefined ? en.oi + 1 : 0; const B = decks[1 - live], old = B.entry; const o = upNext; upNext = null; release(o); B.entry = null; release(old); loadDeck(1 - live); } log(live, mode === 'plan' ? 'Die Fliege folgt wieder dem Set-Plan' : 'Ab jetzt entscheidet das Hirn spontan'); };
$('bUp').onclick = () => vote(1); $('bDown').onclick = () => vote(-1);
$('bEvo').onclick = () => { if (confirm('Evolution zurücksetzen?')) { freshEvo(); saveEvo(); if (running) log(live, 'Evolution zurückgesetzt'); } };
$('sVol').oninput = (e) => { if (A.master) A.master.gain.value = +e.target.value; };
$('files').onchange = async (e) => {
  if (!A.ctx) { alert('Bitte zuerst starten, dann Songs laden.'); return; }
  let first = -1;
  for (const f of e.target.files) {
    const en = fileEntry(f.name.replace(/\.[^.]+$/, ''), f.name + '|' + f.size, () => f.arrayBuffer()); en.played = Math.min(0, ...playlist.map(p => p.played)) - 1;
    if (first < 0) first = playlist.length; playlist.push(en);
  }
  if (first >= 0) { if (mode === 'plan') setMode('hirn'); log(live, (playlist.length - first) + ' Songs dazugeladen (nicht im Set-Plan) – das Hirn entscheidet jetzt spontan'); const o = upNext; upNext = playlist[first]; release(o); const B = decks[1 - live]; if (!trans && !B.playing) { const old = B.entry; B.entry = null; release(old); loadDeck(1 - live); } }
  e.target.value = '';
};



// ------------------------------------------------------ Video-Modus ----
// ?video  : Hochformat 1080x1920 fuer TikTok - nur Fliege, Neuronen und Decks, alles auf EINER Leinwand (#out).
// ?rec    : nimmt den Showcase dabei als MP4 auf und legt ihn ueber den lokalen Server in dj/video/ ab.
const Q = new URLSearchParams(location.search), VIDEO = Q.has('video') || Q.has('rec'), REC = Q.has('rec');
if (VIDEO) document.body.classList.add('video');
let punch = 0, camT = 0, showDrop = 0;
const ACC = ['#f0b860', '#5fd6c0'];
function vText(g, txt, x, y, font, color, align = 'left', maxW = 0) {
  g.font = font; g.fillStyle = color; g.textAlign = align;
  if (maxW && g.measureText(txt).width > maxW) { while (txt.length > 3 && g.measureText(txt + '…').width > maxW) txt = txt.slice(0, -1); txt += '…'; }
  g.fillText(txt, x, y);
}
function drawVideo() {
  const o = $('out'), g = o.getContext('2d'), W = 1080, F = 'system-ui, "Segoe UI", sans-serif';
  g.fillStyle = '#090a0e'; g.fillRect(0, 0, W, 1920);
  const gl = $('view').querySelector('canvas'); if (gl && gl.width) g.drawImage(gl, 0, 0, W, 1150);
  const fade = g.createLinearGradient(0, 1060, 0, 1150); fade.addColorStop(0, 'rgba(9,10,14,0)'); fade.addColorStop(1, '#090a0e'); g.fillStyle = fade; g.fillRect(0, 1060, W, 90);
  // Neuronen
  g.fillStyle = '#10131a'; g.fillRect(0, 1150, W, 770); g.fillStyle = '#1c212c'; g.fillRect(0, 1150, W, 2); g.fillRect(0, 1500, W, 2); g.fillRect(539, 1150, 2, 770);
  vText(g, 'NEURAL ACTIVITY', 28, 1194, '700 22px ' + F, '#c9cedb'); vText(g, '139.255 Neuronen', 512, 1194, '600 19px ' + F, '#8d95a6', 'right');
  const bc = $('brainC'); if (bc.width) g.drawImage(bc, 20, 1212, 500, 262);
  vText(g, 'SPIKE RASTER', 568, 1194, '700 22px ' + F, '#c9cedb');
  const rc = $('rasterC'); if (rc.width) g.drawImage(rc, 568, 1212, 484, 228);
  vText(g, lastTick.n.toLocaleString('de-DE') + ' spikes / 20 ms', 568, 1478, '700 22px ' + F, '#e8c873');
  // Decks
  for (let d = 0; d < 2; d++) {
    const D = decks[d], t = D.track, x = d * 540 + 28, w = 484, c = ACC[d]; if (!t) continue;
    const p = D.pos(), m = Math.floor(p / 60), s = p - m * 60;
    vText(g, 'DECK ' + (d + 1), x, 1546, '700 22px ' + F, c); vText(g, ST[D.state] || '', x + w, 1546, '600 19px ' + F, '#8d95a6', 'right');
    vText(g, t.name, x, 1590, '700 31px ' + F, '#e9ecf3', 'left', w);
    vText(g, m + ':' + (s < 10 ? '0' : '') + s.toFixed(2), x, 1624, '500 21px ' + F, '#8d95a6'); vText(g, (t.bpm * D.rate).toFixed(1) + ' BPM', x + w, 1624, '500 21px ' + F, '#8d95a6', 'right');
    g.drawImage(deckUI[d].cv, x, 1640, w, 86);
    vText(g, 'FADER', x, 1766, '700 18px ' + F, '#8d95a6'); vText(g, Math.round(D.knob.fader * 100) + '%', x + w, 1766, '700 21px ' + F, c, 'right');
    g.fillStyle = '#232936'; g.fillRect(x + 78, 1757, w - 150, 6); g.fillStyle = c; g.fillRect(x + 78, 1757, (w - 150) * D.knob.fader, 6); g.fillRect(x + 78 + (w - 150) * D.knob.fader - 4, 1749, 8, 22);
    ['low', 'mid', 'high'].forEach((k, i) => {
      const cx = x + w * (i + 0.5) / 3, cy = 1822, r = 26, v = D.knob[k], a0 = Math.PI * 0.75, a1 = a0 + Math.PI * 1.5 * v;
      g.lineWidth = 6; g.lineCap = 'round'; g.strokeStyle = '#232936'; g.beginPath(); g.arc(cx, cy, r, a0, a0 + Math.PI * 1.5); g.stroke();
      g.strokeStyle = c; g.beginPath(); g.arc(cx, cy, r, a0, Math.max(a0 + 0.01, a1)); g.stroke();
      g.lineWidth = 4; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a1) * (r - 8), cy + Math.sin(a1) * (r - 8)); g.stroke();
      vText(g, k.toUpperCase(), cx, 1876, '700 17px ' + F, '#8d95a6', 'center'); vText(g, A.dbLabel(v), cx, 1902, '600 20px ' + F, '#e9ecf3', 'center');
    });
  }
}
// Kamerafahrt fuers Video: langsamer Schwenk, vor dem Drop naeher ran, beim Drop ein Ruck nach hinten
function videoCam(dt) {
  camT += dt; punch *= Math.exp(-dt * 3.5);
  const now = A.ctx.currentTime, toDrop = showDrop ? showDrop - now : 99, build = clamp(1 - toDrop / 6) * (toDrop > 0 ? 1 : 0);
  const az = 0.62 * Math.sin(camT * 0.16 - 0.9), el = 0.33 + 0.05 * Math.sin(camT * 0.11), r = 5.1 - 0.8 * build + 1.2 * punch;
  const cam = scene3d.orbit.object, T = scene3d.orbit.target;
  cam.position.set(T.x + r * Math.sin(az) * Math.cos(el), T.y + r * Math.sin(el), T.z + r * Math.cos(az) * Math.cos(el));
}
// Aufnahme (?rec): OFFLINE, Bild fuer Bild. Die Audio-Uhr ist ein OfflineAudioContext, der alle 1/30 s anhaelt;
// in jeder Pause rechnet das Hirn genau 33 ms weiter, die Szene wird gezeichnet und das Bild an den H.264-Encoder
// gegeben. Nichts laeuft in Echtzeit, also kann nichts ruckeln - egal wie langsam der Rechner gerade ist.
// Ergebnis: dj/video/NAME.h264 + .wav + .json; mux_video.py baut daraus das MP4.
let venc = null, recN = 0, brainWait = null, brainReady = null, simAcc = 0;
const vChunks = [], vTs = [], brainIsReady = new Promise(r => { brainReady = r; });
const clockMs = () => REC && A.ctx ? A.ctx.currentTime * 1000 : performance.now();
const post = (name, body) => fetch('save?name=' + name, { method: 'POST', body });
const brainSteps = (n) => new Promise(r => { brainWait = r; worker.postMessage({ type: 'steps', n }); });
function wav(buf) {
  const n = buf.length, L = buf.getChannelData(0), R = buf.getChannelData(1), out = new DataView(new ArrayBuffer(44 + n * 4)), w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); w(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true);
  out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * 4, true);
  for (let i = 0, o = 44; i < n; i++, o += 4) { out.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true); out.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
  return out.buffer;
}
async function offlineRender() {
  const ctx = A.ctx, F = 30, len = ctx.length / ctx.sampleRate, total = Math.floor(len * F);
  try {
    document.title = 'Hirn wacht auf …';
    await brainIsReady;
    worker.postMessage({ type: 'stim', jl: 120, jr: 120, flash: 0, gain: +$('sGain').value, noise: +$('sNoise').value });
    await brainSteps(600);                                   // 12 s Hirnzeit Vorlauf, damit das Netz wach ist
    await runShow();
    venc = new VideoEncoder({ output: (c) => { const u = new Uint8Array(c.byteLength); c.copyTo(u); vChunks.push(u); vTs.push(c.timestamp); }, error: (e) => { window.__rec = 'Fehler Encoder: ' + e.message; } });
    venc.configure({ codec: 'avc1.640028', width: 1080, height: 1920, bitrate: 18e6, framerate: F, hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' } });
    let k = 1;
    const next = () => {
      if (k >= total) return;
      ctx.suspend(k / F).then(async () => {
        simAcc += 1000 / F; const n = Math.floor(simAcc / 20); simAcc -= n * 20; if (n) await brainSteps(n);
        frame(k / F * 1000);
        const vf = new VideoFrame($('out'), { timestamp: Math.round(k / F * 1e6) }); venc.encode(vf, { keyFrame: recN % 60 === 0 }); vf.close(); recN++;
        while (venc.encodeQueueSize > 2) await new Promise(r => venc.addEventListener('dequeue', r, { once: true }));
        if (k % 30 === 0) document.title = 'Rendere ' + Math.round(k / total * 100) + ' %';
        k++; next(); ctx.resume();
      });
    };
    next();
    const audio = await ctx.startRendering();
    await venc.flush(); venc.close();
    document.title = 'Speichere …';
    const rs = await Promise.all([post('fliege-ikkimel.h264', new Blob(vChunks)), post('fliege-ikkimel.wav', wav(audio)), post('fliege-ikkimel.json', JSON.stringify({ ts: vTs, frames: recN, dropped: 0 }))]);
    window.__rec = rs.every(r => r.ok) ? 'ok ' + recN + ' Bilder' : 'Fehler beim Speichern';
  } catch (err) { window.__rec = 'Fehler ' + err.message; }
  document.title = 'Aufnahme: ' + window.__rec;
}

// --------------------------------------------------------- Showcase ----
// Ein von Hand entworfener, auf die Millisekunde vermessener Uebergang (make_show.py -> show.json):
// KETA-Intro ueber dem vollen BIKINI-Teil, Hochpass-Fahrt, Loop-Roll 1 -> 1/2 -> 1/4 -> 1/8, halber Schlag Luft, Drop.
let showData = null;
async function runShow() {
  const sd = showData;
  const mk = (key, spb, grid0) => { const f = folderSongs.find(s => s.key === key); const en = fileEntry(f.name.split(' (')[0], key, () => fetch(f.url).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })); en.info = { bpm: 60 / spb, phase: grid0 % spb, grid: 9 }; return en; };
  const ea = mk(sd.a, sd.spbA, sd.aDrop), eb = mk(sd.b, sd.spbB, sd.bDrop);
  const [ta, tb] = await Promise.all([ensure(ea), ensure(eb)]);
  const Da = decks[0], Db = decks[1]; Da.entry = ea; Db.entry = eb;
  Da.load(ta, sd.aStart); Db.load(tb, sd.bStart);
  mode = 'show'; live = 0;
  const spb = sd.spbA, t0 = A.ctx.currentTime + 0.3, tDrop = t0 + (sd.aDrop - sd.aStart), tB = tDrop - (sd.bDrop - sd.bStart) / sd.rate;
  showDrop = tDrop; if (VIDEO) { scene3d.orbit.autoRotate = false; scene3d.orbit.enableDamping = false; scene3d.orbit.target.set(0, 0.95, -0.35); }
  Da.trim.gain.value = sd.trimA || 1; Db.trim.gain.value = sd.trimB || 1; A.master.gain.value = 0.72;
  Da.goal.fader = Da.knob.fader = 1; Da.play(t0, 1);
  Object.assign(Db.goal, { low: 0, mid: 0.5, high: 0.4, fader: 0 }); Object.assign(Db.knob, Db.goal);
  Db.play(tB, sd.rate); Db.state = 'QUEUED';
  const S = [], at = (beat, fn) => S.push({ at: beat, fn }), tRoll = tDrop - 8 * spb, tCut = tDrop - 0.5 * spb;
  at(-(tDrop - tB) / spb, () => { Db.state = 'PLAYING'; ramp(1, 'fader', 0.9, 8); ramp(1, 'high', 0.5, 8); log(1, 'KETA-Intro kommt ohne Bass dazu · beatgematcht (' + ((sd.rate - 1) * 100).toFixed(1) + ' %)'); });
  at(-16, () => { ramp(0, 'low', 0.28, 8); Da.sweep(30, 220, A.ctx.currentTime, tRoll); log(0, 'BIKINI wird ausgedünnt (Hochpass-Fahrt)'); });
  at(-10, () => { Da.roll(tRoll, sd.aDrop - 8 * sd.spbA, spb, [[1, 4], [0.5, 4], [0.25, 4], [0.125, 4]]); Da.sweep(220, 1000, tRoll, tCut); A.riser(tRoll, tCut, 0.42); });
  at(-8, () => { Da.offset = sd.aDrop - 8 * sd.spbA; Da.playing = false; Da.src = null; Da.state = 'ROLL'; Da.spin = 0.5; jogUntil[0] = tDrop; ramp(0, 'low', 0.05, 7); log(0, 'Loop-Roll: 1 → ½ → ¼ → ⅛ Schlag, Riser dreht hoch'); });
  at(-0.5, () => { Da.goal.fader = Da.knob.fader = 0; Da.spin = 0; focus[0] = { name: 'fader', until: A.ctx.currentTime + 0.5 }; });
  at(-0.2, () => { Db.goal.low = Db.knob.low = 0.5; Db.goal.fader = Db.knob.fader = 1; });   // KETA ist hier fast still - man hoert das Oeffnen nicht
  at(0, () => { live = 1; flash = 1; punch = 1; focus[1] = { name: 'low', until: A.ctx.currentTime + 0.8 }; log(1, 'DROP · KETA UND KRAWALL mit vollem Bass'); });
  at(4, () => { Da.sweepOff(); Da.state = 'CUED'; ramp(0, 'low', 0.5, 2); ramp(0, 'mid', 0.5, 2, 2); });
  at(72, () => { A.master.gain.setTargetAtTime(0, A.ctx.currentTime, spb * 2); log(1, 'Ende der Vorschau – Seite neu laden zum Wiederholen'); });
  at(84, () => { decks[1].stop(); trans = null; });
  S.sort((p, q) => p.at - q.at);
  trans = { T0: tDrop, spb, S, i: 0 };
  $('bMode').hidden = true; $('bMix').disabled = true;
  log(0, 'Showcase: BIKINI GRELL → KETA UND KRAWALL');
}

// ------------------------------------------------- Uebergangs-Vorschau ----
// Liste aller geplanten Uebergaenge: anhoeren (springt 8 s davor), bewerten, Ein-/Ausstieg taktweise verschieben.
// Bewertungen und Verschiebungen gehen an den Planer (ratings.json / overrides.json) und wirken beim Neu-Planen.
const THUMB = (d) => '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (d > 0
  ? '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>'
  : '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>') + '</svg>';
const esc = (t) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shortName = (t) => t.replace(/\s*[\(\[].*$/, '').slice(0, 44);
const mmss = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
const nudges = {};
function buildList() {
  const L = $('list'); if (!plan) { L.innerHTML = ''; return; }
  const n = plan.songs.length, nm = plan.names || {};
  L.innerHTML = '<div class="lh"><b>Übergänge</b><button data-a="check" title="Stumm durchrechnen und messen">Prüfen</button><button data-a="replan" title="Daumen und Verschiebungen übernehmen">Neu planen</button><button data-a="close" aria-label="Liste schließen">×</button></div>'
    + plan.tr.map((t, i) => {
      const Sa = plan.songs[i], Sb = plan.songs[(i + 1) % n], m = t.measured, flag = (t.warn || []).concat(m ? m.warn.concat(m.note || []) : []);
      return '<div class="li" data-i="' + i + '"><div class="lt"><span>' + (i + 1) + '</span>' + esc(shortName(Sa.name)) + ' <i>→</i> ' + esc(shortName(Sb.name)) + '</div>'
        + '<div class="ls">' + (nm[t.tech] || t.tech) + (t.sync ? '' : ' · ohne Beatmatch') + ' · ' + mmss(Sa.tExit) + ' → ' + mmss(Sb.tEntry) + (m ? '' : ' · ungeprüft') + (flag.length ? ' · <em>' + esc(flag.join(', ')) + '</em>' : '') + ' <span class="ch"></span></div>'
        + '<div class="lb"><button data-a="play" class="pl">Anhören</button><button data-a="up" aria-label="Daumen hoch">' + THUMB(1) + '</button><button data-a="down" aria-label="Daumen runter">' + THUMB(-1) + '</button>'
        + '<span>A raus</span><button data-a="out-" aria-label="Ausstieg einen Takt früher">−</button><button data-a="out+" aria-label="Ausstieg einen Takt später">+</button>'
        + '<span>B rein</span><button data-a="in-" aria-label="Einstieg einen Takt früher">−</button><button data-a="in+" aria-label="Einstieg einen Takt später">+</button></div></div>';
    }).join('');
}
function listMark(i) { document.querySelectorAll('#list .li').forEach(el => el.classList.toggle('now', +el.dataset.i === i)); }
$('bList').onclick = () => { const L = $('list'); if (L.hidden) buildList(); L.hidden = !L.hidden; };
$('list').onclick = async (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const act = btn.dataset.a, row = btn.closest('.li');
  if (act === 'close') { $('list').hidden = true; return; }
  if (act === 'replan') { location.reload(); return; }
  if (act === 'check') { location.href = '?check=1'; return; }
  if (!row) return;
  const i = +row.dataset.i, n = plan.songs.length, t = plan.tr[i], Sa = plan.songs[i], Sb = plan.songs[(i + 1) % n];
  if (act === 'play') { jumpTo(i); return; }
  if (act === 'up' || act === 'down') {
    const v = act === 'up' ? 1 : -1;
    fetch('rate?a=' + encodeURIComponent(Sa.key) + '&b=' + encodeURIComponent(Sb.key) + '&tech=' + t.tech + '&v=' + v, { method: 'POST' }).catch(() => { });
    row.querySelectorAll('[data-a="up"],[data-a="down"]').forEach(b => b.classList.remove('on')); btn.classList.add('on');
    row.querySelector('.ch').textContent = '· gemerkt';
    return;
  }
  const isIn = act.startsWith('in'), S = isIn ? Sb : Sa, k = (isIn ? 'in' : 'out') + S.key, d = act.endsWith('+') ? 1 : -1;
  nudges[k] = (nudges[k] || 0) + d;
  const sec = (isIn ? S.tEntry : S.tExit) + nudges[k] * 4 * 60 / S.bpm;
  fetch('override?name=' + encodeURIComponent(S.name) + '&' + (isIn ? 'einstieg' : 'ausstieg') + '=' + sec.toFixed(3), { method: 'POST' }).catch(() => { });
  row.querySelector('.ch').textContent = '· ' + (isIn ? 'B rein ' : 'A raus ') + (nudges[k] > 0 ? '+' : '') + nudges[k] + ' Takt';
};
// Springt im laufenden Set direkt vor den Uebergang i
async function jumpTo(i) {
  if (!running) { say(0, 'Erst starten'); return; }
  if (trans) { say(live, 'Übergang läuft noch'); return; }
  if (mode !== 'plan') setMode('plan');
  const a = live, b = 1 - live;
  ramps.length = 0; forceMix = false;
  for (const D of decks) { D.stop(); D.sweepOff(); D.fader.gain.cancelScheduledValues(0); Object.assign(D.goal, { low: 0.5, mid: 0.5, high: 0.5, fader: 0 }); Object.assign(D.knob, D.goal); const o = D.entry; D.entry = null; D.track = null; release(o); }
  const o = upNext; upNext = null; release(o);
  planNext = i;
  log(a, 'Vorschau: lade Übergang ' + (i + 1) + ' …');
  await loadDeck(a);
  const Da = decks[a], tr = plan.tr[i];
  if (!Da.track) return;
  Da.offset = Math.max(Da.offset, tr.aOut - 8); Da.goal.fader = Da.knob.fader = 1; Da.play(A.ctx.currentTime + 0.1, 1); live = a; liveSince = A.ctx.currentTime; lastBeat = -1;
  loadDeck(b); listMark(i);
}

// ------------------------------------------------- Hoerprobe (?check) ----
// Rechnet jeden geplanten Uebergang STUMM als Audio durch (OfflineAudioContext, dieselbe Deck-Kette und dieselbe
// Logik wie live) und misst das Ergebnis: Pegel davor/danach, Loecher im Aufbau, Einschlag des Drops, Uebersteuerung.
// Die Messwerte gehen an den Planer (check.json); durchgefallene Techniken ersetzt er beim naechsten Planen.
const CHECK = new URLSearchParams(location.search).has('check');
let checking = false, lastDrop = 0;
function measure(buf, t0, tDrop, dry, dryT) {
  const L = buf.getChannelData(0), R = buf.getChannelData(1), sr = buf.sampleRate, w = Math.floor(sr / 4), nW = Math.floor(buf.length / w), db = [];
  let peak = 0, clip = 0;
  for (let j = 0; j < nW; j++) {
    let s = 0; for (let i = j * w, e = i + w; i < e; i++) { const m = (L[i] + R[i]) / 2; s += m * m; const p = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (p > peak) peak = p; if (p >= 0.999) clip++; }
    db.push(10 * Math.log10(s / w + 1e-12));
  }
  const win = (a, b) => db.slice(Math.max(0, Math.floor(a * 4)), Math.max(0, Math.ceil(b * 4))), med = (x) => { const y = [...x].sort((p, q) => p - q); return y.length ? y[y.length >> 1] : -99; };
  const pre = med(win(Math.max(0.5, t0 - 6), t0 - 0.25)), post = med(win(tDrop + 0.5, tDrop + 6)), during = win(t0, tDrop - 0.75);
  let hole = 0, run = 0; for (const v of during) { run = v < pre - 10 ? run + 0.25 : 0; if (run > hole) hole = run; }
  const hit = med(win(tDrop, tDrop + 0.5)) - post;                  // ist der erste halbe Takt nach dem Drop schon voll da?
  const r = { pre: +pre.toFixed(1), post: +post.toFixed(1), jump: +(post - pre).toFixed(1), dip: +(Math.min(...during, pre) - pre).toFixed(1), hole: +hole.toFixed(2), hit: +hit.toFixed(1), peak: +peak.toFixed(2), warn: [] };
  // Wie setzt der Hoehepunkt im ORIGINAL von B ein? Nur was schlechter ist als das, liegt an der Technik.
  const d0 = dry.getChannelData(0), dsr = dry.sampleRate, drms = (a, b) => { let s = 0, c = 0; for (let i = Math.max(0, Math.floor(a * dsr)), e = Math.min(d0.length, Math.floor(b * dsr)); i < e; i++) { s += d0[i] * d0[i]; c++; } return 10 * Math.log10(s / Math.max(1, c) + 1e-12); };
  const later = []; for (let t = dryT + 0.5; t < dryT + 6; t += 0.25) later.push(drms(t, t + 0.25));
  r.ownHit = +(drms(dryT, dryT + 0.5) - med(later)).toFixed(1); r.note = [];
  // warn = liegt an der Technik (der Planer nimmt dann eine andere); note = liegt an den Songs selbst
  if (r.hit < r.ownHit - 2.5) r.warn.push('Drop setzt ' + (r.ownHit - r.hit).toFixed(0) + ' dB schwächer ein als im Original');
  if (r.hole > 1.5) r.warn.push('Loch von ' + r.hole.toFixed(1) + ' s im Aufbau');
  if (clip > 200) r.warn.push('übersteuert');
  if (r.jump < -5) r.note.push('danach ' + (-r.jump).toFixed(0) + ' dB leiser');
  if (r.jump > 5) r.note.push('danach ' + r.jump.toFixed(0) + ' dB lauter');
  return r;
}
async function runChecks() {
  const b = $('bStart'), note = document.querySelector('#gate small');
  checking = true; mode = 'plan'; b.disabled = true; $('paceRow').hidden = true;
  let done = 0, bad = 0;
  for (let pass = 0; pass < 3; pass++) {                     // nach jedem Durchgang plant der Server neu; geaenderte Uebergaenge werden nachgeprueft
    await loadPlan(); b.disabled = true;
    if (!plan) { note.textContent = 'Kein Set-Plan vorhanden.'; return; }
    const n = plan.songs.length, todo = plan.tr.map((t, i) => i).filter(i => !plan.tr[i].measured);
    if (!todo.length) break;
    const ents = plan.songs.map((ps, i) => { const f = folderSongs.find(s => s.key === ps.key); const en = fileEntry(ps.name, ps.key, () => fetch(f.url).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })); en.oi = i; en.info = { bpm: ps.bpm, phase: ps.beats[ps.phi] % (60 / ps.bpm), grid: 9 }; return en; });
    for (const i of todo) {
      const tr = plan.tr[i], ea = ents[i], eb = ents[(i + 1) % n], nm = (plan.names || {})[tr.tech] || tr.tech;
      b.textContent = 'Prüfe ' + (i + 1) + '/' + n + ' …'; document.title = b.textContent;
      try {
        const lead = Math.min(8, tr.aOut), len = lead + tr.beats * tr.spb * 1.2 + 9;
        A.initAudio(len); decks = [new A.Deck(0), new A.Deck(1)];
        const [ta, tb] = await Promise.all([ensure(ea), ensure(eb)]);
        const Da = decks[0], Db = decks[1]; Da.entry = ea; Db.entry = eb;
        Da.trim.gain.value = plan.songs[i].trim || 1; Db.trim.gain.value = plan.songs[(i + 1) % n].trim || 1;
        Da.load(ta, tr.aOut - lead); Db.load(tb, tr.bIn);
        live = 0; trans = null; ramps.length = 0; lastBeat = -1; lastDrop = 0; forceMix = false;
        Da.goal.fader = Da.knob.fader = 1; Da.play(0.05, 1);
        const ctx = A.ctx, F = 30, total = Math.floor(len * F); let k = 1;
        const next = () => { if (k >= total) return; ctx.suspend(k / F).then(() => { try { if (decks[live].track) djLogic(1 / F); } catch (err) { } k++; next(); ctx.resume(); }); };
        next();
        const buf = await ctx.startRendering();
        const m = lastDrop ? measure(buf, 0.05 + lead, lastDrop, tb.buffer, tr.bDrop) : { warn: ['Übergang wurde nicht ausgelöst'], note: [] };
        if (m.warn.length) bad++;
        await fetch('check?a=' + encodeURIComponent(ea.key) + '&b=' + encodeURIComponent(eb.key) + '&tech=' + tr.tech, { method: 'POST', body: JSON.stringify(m) });
      } catch (err) { await fetch('check?a=' + encodeURIComponent(ea.key) + '&b=' + encodeURIComponent(eb.key) + '&tech=' + tr.tech, { method: 'POST', body: JSON.stringify({ warn: ['Prüfung fehlgeschlagen: ' + err.message] }) }).catch(() => { }); bad++; }
      ea.track = null; ea.promise = null; done++;            // Speicher freigeben; B wird beim naechsten Uebergang wieder gebraucht
    }
  }
  b.textContent = done + ' geprüft' + (bad ? ', ' + bad + ' auffällig' : ', alles gut'); document.title = 'Geprüft: ' + b.textContent; window.__check = b.textContent;

  if (!new URLSearchParams(location.search).has('stay')) setTimeout(() => { location.href = './'; }, 2500);
}

// ---------------------------------------------------------- Playlist ----
// Ein Song wird erst dekodiert, wenn ein Deck ihn braucht (ein dekodierter Song belegt ~100 MB),
// und wieder freigegeben, sobald er vom Deck fliegt. BPM und Beat-Raster merkt sich der Browser.
const BPM_KEY = 'fliegenhirn-dj-bpm-v3';
let bpmCache = {}; try { bpmCache = JSON.parse(localStorage.getItem(BPM_KEY)) || {}; } catch (err) { }
let folderSongs = [], upNext = null, plan = null, mode = 'hirn', planNext = 0, planFirst = true, planLeft = 0;
function fileEntry(name, key, getData) {
  const en = { name, key, info: bpmCache[key] || null, track: null, promise: null, played: 0, bad: false };
  en.make = async () => {
    const buf = await A.decode(await getData());
    if (!en.info) { en.info = await A.analyzeAsync(buf); bpmCache[key] = en.info; try { localStorage.setItem(BPM_KEY, JSON.stringify(bpmCache)); } catch (err) { } }
    return new A.Track(name, buf, en.info);
  };
  return en;
}
function demoEntry(k) { const en = { name: 'Demo ' + (k + 1), key: null, info: { bpm: 140, phase: 0 }, track: null, promise: null, played: 0, bad: false }; en.make = async () => { const t = A.makeDemo(k); en.name = t.name; return t; }; return en; }
function ensure(en) {
  if (!en.promise) en.promise = en.make().then((t) => { en.track = t; return t; }, (err) => { en.promise = null; en.bad = true; throw err; });
  return en.promise;
}
function release(en) { if (en && en !== upNext && !decks.some(d => d.entry === en)) { en.track = null; en.promise = null; } }
const isSolid = (info) => !info || info.grid === undefined || info.grid >= 2.5;
function tempoDist(a, b) { let r = a / b; while (r < 0.75) r *= 2; while (r > 1.5) r /= 2; return Math.abs(Math.log(r)); }
// Naechster Song: erst alle einmal, dabei moeglichst nah am laufenden Tempo
function pickNext() {
  if (mode === 'plan') { for (let i = 0; i < playlist.length; i++) { const en = playlist[planNext++ % plan.songs.length]; if (!en.bad && !decks.some(d => d.entry === en)) return en; } return null; }
  const free = playlist.filter(en => !en.bad && en !== upNext && !decks.some(d => d.entry === en));
  if (!free.length) return null;
  const least = Math.min(...free.map(en => en.played)), pool = free.filter(en => en.played === least);
  const L = decks[live] && decks[live].track, ref = L ? L.bpm * decks[live].rate : 0;
  const far = (en) => en.info ? tempoDist(ref, en.info.bpm) + (isSolid(en.info) ? 0 : 0.12) : 0.2;
  if (ref) pool.sort((p, q) => far(p) - far(q));
  else pool.sort(() => Math.random() - 0.5);
  return pool[ref ? 0 : Math.floor(Math.random() * pool.length)];
}
async function loadDeck(d) {
  const D = decks[d], en = (upNext && !upNext.bad) ? upNext : pickNext(); upNext = null;
  if (!en) return;
  D.stop(); D.entry = en; D.track = null; D.state = 'LADEN'; D.pending = en.name; en.played++;
  let t; try { t = await ensure(en); } catch (err) { say(d, 'Nicht ladbar: ' + en.name); D.entry = null; return loadDeck(d); }
  if (D.entry !== en) return;
  let cue = t.nextCue();
  D.trim.gain.value = 1;
  if (mode === 'plan' && en.oi !== undefined) { const n = plan.songs.length; cue = plan.tr[(en.oi + n - 1) % n].bIn; D.trim.gain.value = plan.songs[en.oi].trim || 1; }   // Einstieg = Beginn des Aufbaus vor dem Hoehepunkt; Pegel angeglichen
  D.load(t, cue); jogUntil[d] = A.ctx.currentTime + 1.5;
  log(d, 'Deck ' + (d + 1) + ' geladen: „' + t.name + '“ · ' + t.bpm.toFixed(1) + ' BPM, wartet am Cue-Punkt');
  upNext = pickNext(); if (upNext) ensure(upNext).catch(() => { });
}
// Im Hintergrund die Tempi aller Songs bestimmen, damit die Fliege passend auswaehlen kann
async function scanTempos() {
  for (const en of playlist) {
    if (en.info || !en.scan) continue;
    await new Promise(r => setTimeout(r, 2500));
    if (en.info || en.promise) continue;
    try { const buf = await A.decode(await en.scan()); en.info = await A.analyzeAsync(buf); bpmCache[en.key] = en.info; localStorage.setItem(BPM_KEY, JSON.stringify(bpmCache)); } catch (err) { }
  }
}

// ------------------------------------------------------- Hirn-Pakete ----
function onBrain(e) {
  const m = e.data;
  if (m.type === 'ready') { if (REC) brainReady(); else worker.postMessage({ type: 'run', on: true }); return; }
  if (m.type === 'done') { const r = brainWait; brainWait = null; if (r) r(); return; }
  lastTick = m; spikeRate += (m.n - spikeRate) * 0.2;
  recent.push({ sp: m.spikes, t: clockMs() }); if (recent.length > 24) recent.shift();
  for (let k = 0; k < 8; k++) {
    const x = m.ch[k]; fast[k] += (x - fast[k]) * 0.07; slow[k] += (x - slow[k]) * 0.004;
    const d = x - slow[k]; vr[k] += (d * d - vr[k]) * 0.004; z[k] = (fast[k] - slow[k]) / Math.sqrt(vr[k] / 6 + 0.03);
    clsSm[k] += (m.byCls[k] - clsSm[k]) * 0.1;
  }
  const W = G().W; for (let j = 0; j < 8; j++) { let a = 0; for (let k = 0; k < 8; k++) a += W[j * 8 + k] * z[k]; sig[j] = a; }
  sideZ[0] = (sig[0] + sig[1] + sig[2] + sig[3]) / 4; sideZ[1] = (sig[4] + sig[5] + sig[6] + sig[7]) / 4;
  drawRaster(m);
  $('spk').textContent = m.n.toLocaleString('de-DE') + ' spikes / 20 ms';
}

// ------------------------------------------------------ Pult-Logik ----
function ramp(d, name, to, beats = 0, delay = 0) { const now = A.ctx.currentTime, spb = spbLive(); ramps.push({ d, name, to, t0: now + delay * spb, t1: now + (delay + beats) * spb, from: null }); }
function spbLive() { const D = decks[live]; return D.track.beat / D.rate; }
function log() { }                                        // ausfuehrliche Ablauf-Meldungen sind abgeschaltet
function say(d, text) { const el = document.createElement('div'); el.className = 'd' + d; el.textContent = text; const L = $('log'); L.appendChild(el); while (L.children.length > 2) L.firstChild.remove(); setTimeout(() => el.remove(), 9000); }

function startTransition(why, p) {
  const Ad = decks[live], Bd = decks[1 - live], a = live, b = 1 - live;
  if (trans || !Bd.track || Bd.playing) return;
  const now = A.ctx.currentTime, spb = p ? p.spb / Ad.rate : spbLive();
  const bp = (Ad.pos() - Ad.track.phase) / Ad.track.beat, nextBar = Math.ceil((bp + 0.6) / 4) * 4, T0 = p ? p.T0 : now + (nextBar - bp) * spb;
  let rate = p ? p.rate * Ad.rate : (Ad.track.bpm * Ad.rate) / Bd.track.bpm; while (rate < 0.75) rate *= 2; while (rate > 1.5) rate /= 2;
  // Beatmatch nur, wenn beide Raster verlaesslich sind und das Tempo hoechstens 8 % auseinanderliegt
  const synced = p ? p.sync : Ad.track.solid && Bd.track.solid && rate > 0.92 && rate < 1.08; if (!synced) rate = 1;
  const gn = G(); let ti = 0; for (let k = 1; k < 4; k++) if (sig[b * 4 + k] + gn.tech[k] > sig[b * 4 + ti] + gn.tech[ti]) ti = k;
  const wild = sig[a * 4 + 3] + gn.spin > 1.3;                       // Backspin nur noch, wenn das Hirn richtig draengt
  const tech = p ? p.tech : synced ? ['bass', 'eq', 'sweep', 'echo'][ti] : wild ? 'cut' : (ti === 1 || ti === 2) ? 'fade' : 'echo';
  const mood = sideZ[0] + sideZ[1] + gn.len;
  const n = p ? p.beats : tech === 'cut' ? 4 : !synced ? 8 : mood > 1.2 ? 8 : mood > -0.6 ? 16 : 32;
  let end = !p && synced && wild ? 'spin' : 'fade', endAt = n, startB = 0;
  const S = [];
  const at = (beat, fn) => S.push({ at: beat, fn });
  const swap = () => { ramp(a, 'low', 0, 0.5); ramp(b, 'low', 0.5, 0.5); log(b, 'Bass-Tausch: Deck ' + (a + 1) + ' Bass raus, Deck ' + (b + 1) + ' Bass rein'); };
  const echoOut = (beat) => {                                          // letzter Schlag haengt als Echo nach, Deck ist zu
    at(beat - 1, () => { Ad.echo(true, spb); log(a, 'Echo-Out auf Deck ' + (a + 1)); });
    at(beat, () => { Ad.goal.fader = Ad.knob.fader = 0; focus[a] = { name: 'fader', until: A.ctx.currentTime + 0.6 }; });
    at(beat + 0.15, () => Ad.echo(false, spb));
  };
  Object.assign(Bd.goal, { low: 0.5, mid: 0.5, high: 0.5, fader: 0 }); Object.assign(Bd.knob, Bd.goal);
  // Bausteine fuer die geplanten Techniken
  const quietB = () => { Bd.goal.low = Bd.knob.low = 0; Bd.goal.high = Bd.knob.high = 0.4; };                 // B laeuft ohne Bass mit
  const riseB = () => { ramp(b, 'fader', 0.9, Math.max(1, Math.min(8, n - 1))); ramp(b, 'high', 0.5, 8); };
  const openB = () => { Bd.goal.low = Bd.knob.low = 0.5; Bd.goal.fader = Bd.knob.fader = 1; };                // kurz vor dem Drop: Bass rein, Fader auf
  const closeA = () => { Ad.goal.fader = Ad.knob.fader = 0; Ad.spin = 0; focus[a] = { name: 'fader', until: A.ctx.currentTime + 0.5 }; };
  const dropMsg = (txt) => () => { flash = 1; punch = 1; focus[b] = { name: 'low', until: A.ctx.currentTime + 0.8 }; log(b, 'DROP · „' + Bd.track.name + '“ ' + txt); };
  const chop = (c0) => { for (let k = 0; k < 8; k++) { at(c0 + k * 0.5 + 0.25, () => { Ad.goal.fader = Ad.knob.fader = 0; focus[a] = { name: 'fader', until: A.ctx.currentTime + 0.4 }; }); if (k < 7) at(c0 + (k + 1) * 0.5, () => { Ad.goal.fader = Ad.knob.fader = 1; }); } };
  if (p && tech === 'drop') {      // Hoehepunkt zu Hoehepunkt: B-Aufbau laeuft ohne Bass unter A, A stottert im Loop-Roll hoch, B-Drop sitzt auf A's Ende
    const rb = Math.min(p.roll || 8, n), tRoll = T0 + (n - rb) * spb, tCut = T0 + (n - 0.5) * spb, pos = p.aOut + (n - rb) * p.spb;
    const parts = rb >= 8 ? [[1, 4], [0.5, 4], [0.25, 4], [0.125, 4]] : [[0.5, 4], [0.25, 4], [0.125, 4]];
    const bInAt = p.late ? Math.max(0, n - rb - 4) : 0, sw = Math.max(0, n - rb - 8);
    Bd.goal.low = Bd.knob.low = 0; Bd.goal.high = Bd.knob.high = 0.4;
    at(bInAt, () => { ramp(b, 'fader', 0.9, Math.max(1, Math.min(8, n - bInAt - 1))); ramp(b, 'high', 0.5, 8); });
    at(sw, () => { ramp(a, 'low', 0.28, Math.max(1, n - rb - sw)); if (tRoll - A.ctx.currentTime > 0.1) Ad.sweep(30, 220, A.ctx.currentTime, tRoll); });
    at(n - rb - 2, () => { Ad.roll(tRoll, pos, spb, parts); Ad.sweep(220, 1000, tRoll, tCut); A.riser(tRoll, tCut, 0.42); });
    at(n - rb, () => { Ad.offset = pos; Ad.playing = false; Ad.src = null; Ad.state = 'ROLL'; Ad.spin = 0.5; jogUntil[a] = T0 + n * spb; ramp(a, 'low', 0.05, Math.max(1, rb - 1)); log(a, 'Loop-Roll auf Deck ' + (a + 1) + ', Riser dreht hoch'); });
    at(n - 0.5, () => { Ad.goal.fader = Ad.knob.fader = 0; Ad.spin = 0; focus[a] = { name: 'fader', until: A.ctx.currentTime + 0.5 }; });
    at(n - 0.2, () => { Bd.goal.low = Bd.knob.low = 0.5; Bd.goal.fader = Bd.knob.fader = 1; });
    at(n, () => { flash = 1; punch = 1; focus[b] = { name: 'low', until: A.ctx.currentTime + 0.8 }; log(b, 'DROP · „' + Bd.track.name + '“ mit vollem Bass'); });
    end = 'none'; endAt = n + 0.3;
  } else if (p && tech === 'rolldrop') {   // Tempi passen nicht: A stottert allein hoch, B faellt genau mit seinem Hoehepunkt hinein
    const tCut = T0 + 7.5 * spb;
    startB = 8;
    at(-2, () => { Ad.roll(T0, p.aOut, spb, [[1, 4], [0.5, 4], [0.25, 4], [0.125, 4]]); Ad.sweep(30, 1000, T0, tCut); A.riser(T0, tCut, 0.42); });
    at(0, () => { Ad.offset = p.aOut; Ad.playing = false; Ad.src = null; Ad.state = 'ROLL'; Ad.spin = 0.5; jogUntil[a] = T0 + 8 * spb; ramp(a, 'low', 0.05, 7); log(a, 'Loop-Roll auf Deck ' + (a + 1) + ', Riser dreht hoch'); });
    at(7.5, () => { Ad.goal.fader = Ad.knob.fader = 0; Ad.spin = 0; Bd.goal.fader = Bd.knob.fader = 1; });
    at(8, () => { flash = 1; punch = 1; log(b, 'DROP · „' + Bd.track.name + '“ setzt mit seinem Höhepunkt ein'); });
    end = 'none'; endAt = 8.3;
  } else if (p && tech === 'filterdrop') {   // ohne Beatmatch: A wird weggefiltert, Riser, B faellt mit seinem Hoehepunkt hinein
    const tCut = T0 + 7.5 * spb; startB = 8;
    at(0, () => { ramp(a, 'low', 0.1, 6); Ad.sweep(30, 2400, Math.max(A.ctx.currentTime, T0), tCut); A.riser(T0, tCut, 0.42); log(a, 'Filter-Fahrt auf Deck ' + (a + 1) + ', Riser dreht hoch'); });
    at(7.5, () => { closeA(); Bd.goal.fader = Bd.knob.fader = 1; });
    at(8, dropMsg('setzt mit seinem Höhepunkt ein')); end = 'none'; endAt = 8.3;
  } else if (p && tech === 'chopdrop') {     // ohne Beatmatch: A wird im Takt zerhackt, dann faellt B hinein
    startB = 8;
    at(0, () => { ramp(a, 'low', 0.25, 4); A.riser(T0 + 4 * spb, T0 + 7.75 * spb, 0.42); log(a, 'Fader-Chop auf Deck ' + (a + 1)); });
    chop(4);
    at(7.8, () => { Bd.goal.fader = Bd.knob.fader = 1; });
    at(8, dropMsg('setzt mit seinem Höhepunkt ein')); end = 'none'; endAt = 8.3;
  } else if (p && synced && tech === 'cut') {   // B nur die letzten 8 Schlaege leise darunter, dann harter Schnitt auf die Eins
    const s0 = Math.max(0, n - 8); quietB();
    at(s0, () => { ramp(b, 'fader', 0.7, Math.max(1, n - s0 - 1)); ramp(b, 'high', 0.5, 4); });
    at(n - 0.2, openB); at(n - 0.06, closeA);
    at(n, dropMsg('· Schnitt auf die Eins')); end = 'none'; endAt = n + 0.3;
  } else if (p && synced && tech === 'filter') { // A wird ueber die ganze Ueberlappung immer duenner gefiltert, B waechst darunter
    const tCut = T0 + (n - 0.5) * spb; quietB();
    at(0, () => { riseB(); ramp(a, 'low', 0.1, n * 0.7); Ad.sweep(30, 2400, Math.max(A.ctx.currentTime, T0), tCut); A.riser(T0 + Math.max(0, n - 8) * spb, tCut, 0.4); log(a, 'Filter-Fahrt auf Deck ' + (a + 1)); });
    at(n - 0.5, closeA); at(n - 0.2, openB);
    at(n, dropMsg('mit vollem Bass')); end = 'none'; endAt = n + 0.3;
  } else if (p && synced && tech === 'echo') {   // B blendet beatgenau ein, A's letzter Schlag haengt als Echo ueber dem Drop
    quietB(); at(0, riseB); at(n / 2, () => ramp(a, 'low', 0.2, Math.max(1, n / 2 - 1)));
    echoOut(n); at(n - 0.2, openB);
    at(n, dropMsg('mit vollem Bass')); end = 'none'; endAt = n + 6;
  } else if (p && synced && tech === 'chop') {   // A wird in den letzten 4 Schlaegen im Takt zerhackt
    const c0 = Math.max(0, n - 4); quietB(); at(0, riseB);
    at(Math.max(0, n - 8), () => ramp(a, 'low', 0.25, 4));
    at(c0 - 1, () => { A.riser(T0 + c0 * spb, T0 + (n - 0.25) * spb, 0.4); log(a, 'Fader-Chop auf Deck ' + (a + 1)); });
    chop(c0); at(n - 0.2, openB);
    at(n, dropMsg('mit vollem Bass')); end = 'none'; endAt = n + 0.3;
  } else if (p && synced) {       // geplant: B laeuft ohne Bass mit; genau am Hoehepunkt-Wechsel (Beat n) tauschen die Baesse
    Bd.goal.low = Bd.knob.low = 0;
    if (tech === 'eq') { Bd.goal.high = Bd.knob.high = 0.35; at(0, () => { ramp(b, 'fader', 0.85, n / 2); ramp(b, 'high', 0.5, n / 2); }); at(n / 2, () => { ramp(a, 'mid', 0.25, n / 2); ramp(a, 'high', 0.3, n / 2); }); }
    else if (tech === 'bass') { at(0, () => ramp(b, 'fader', 0.85, 4)); at(Math.max(0, n - 8), () => ramp(a, 'high', 0.3, Math.min(8, n))); }
    else { at(0, () => { ramp(b, 'fader', 0.85, n / 2); ramp(a, 'high', 0.05, n); }); at(n / 2, () => ramp(a, 'mid', 0.15, n / 2)); }
    at(n - 0.2, () => { ramp(a, 'low', 0, 0.2); openB(); log(b, 'Bass-Tausch: Deck ' + (a + 1) + ' Bass raus, Deck ' + (b + 1) + ' Bass rein'); });   // kurz VOR der Eins, damit der erste Kick voll da ist
    at(n, dropMsg('übernimmt'));
  } else if (tech === 'bass') {     // B laeuft ohne Bass mit, auf der Eins tauschen die Baesse, dann geht A raus
    Bd.goal.low = Bd.knob.low = 0; at(0, () => ramp(b, 'fader', 0.85, n / 4)); at(n / 2, swap); at(n / 2 + 1, () => ramp(a, 'high', 0.25, n / 2 - 2)); at(n - 4, () => ramp(a, 'fader', 0.5, 4));
  } else if (tech === 'eq') {       // langsam reinblenden, A verliert erst Mitten, dann Bass, dann Hoehen
    Bd.goal.low = Bd.knob.low = 0; Bd.goal.high = Bd.knob.high = 0.3; at(0, () => ramp(b, 'fader', 0.85, n / 2)); at(n / 4, () => { ramp(a, 'mid', 0.15, n / 2); ramp(b, 'high', 0.5, n / 4); }); at(n / 2, swap); at(n / 2 + 1, () => ramp(a, 'high', 0.2, n / 4));
  } else if (tech === 'sweep') {    // A wird nach und nach duenn gefiltert, B waechst darunter hervor
    Bd.goal.low = Bd.knob.low = 0; Bd.goal.mid = Bd.knob.mid = 0.2; at(0, () => { ramp(b, 'fader', 0.85, n / 4); ramp(a, 'high', 0.02, n * 0.7); }); at(n / 4, () => ramp(b, 'mid', 0.5, n / 4)); at(n / 2, () => ramp(a, 'mid', 0.1, n / 4)); at(n * 0.75, swap);
  } else if (tech === 'echo' && synced) {   // B blendet beatgenau ein, A verabschiedet sich mit Echo
    Bd.goal.low = Bd.knob.low = 0; at(0, () => ramp(b, 'fader', 0.85, n / 2)); at(n / 2, swap); echoOut(n); end = 'none'; endAt = n + 6;
  } else if (tech === 'echo') {     // Tempi passen nicht: A haengt im Echo aus, B setzt genau dann auf seiner Eins ein
    const eb = p ? n : 4; startB = eb; echoOut(eb); at(eb, () => { Bd.goal.fader = Bd.knob.fader = 1; }); end = 'none'; endAt = eb + 6;
  } else if (tech === 'fade') {     // Tempi passen nicht: kurzer Crossfade, A ohne Bass, damit sich die Rhythmen nicht beissen
    at(0, () => { ramp(a, 'low', 0, 1); ramp(b, 'fader', 0.9, 4); ramp(a, 'high', 0.2, 6); }); at(4, () => ramp(a, 'fader', 0, 4)); end = 'none';
  } else {                          // harter Cut mit Backspin - die Ausnahme
    at(n - 0.05, () => { Bd.goal.fader = Bd.knob.fader = 1; focus[b] = { name: 'fader', until: A.ctx.currentTime + 0.6 }; }); end = 'spin';
  }
  at(endAt, () => finish(a, b, end));
  Bd.play(T0 + startB * spb, rate); Bd.state = 'QUEUED'; jogUntil[b] = T0 + (startB + 1) * spb;
  at(startB, () => { Bd.state = 'PLAYING'; });
  S.sort((p, q) => p.at - q.at);
  lastDrop = T0 + (synced ? n : startB) * spb;
  trans = { T0, spb, S, i: 0 };
  if (p) { lastTech = tech; lastPair = [Ad.entry.key, Bd.entry.key]; listMark(Ad.entry.oi); }
  const label = (p && plan && plan.names && plan.names[tech]) || { drop: 'Roll + Drop', rolldrop: 'Roll + Drop-in', bass: 'Bass-Swap', eq: 'EQ-Blend', sweep: 'Höhen-Sweep', echo: 'Echo-Out', fade: 'Crossfade', cut: 'harter Cut' }[tech];
  say(b, label + ' → ' + shortName(Bd.track.name));
}

function finish(a, b, end) {
  const Ad = decks[a], spb = spbLive();
  ramp(b, 'fader', 1, 2);
  if (end === 'spin') { Ad.backspin(spb * 2); jogUntil[a] = A.ctx.currentTime + spb * 2.2; log(a, 'Backspin auf Deck ' + (a + 1)); }
  else if (end === 'fade') ramp(a, 'fader', 0, 4);
  trans = { T0: A.ctx.currentTime, spb, S: [{ at: end === 'spin' ? 2.1 : end === 'fade' ? 4.1 : 0.1, fn: () => recue(a, b) }], i: 0 };
}

function recue(a, b) {
  const Ad = decks[a]; Ad.stop(); Ad.sweepOff();
  Ad.fader.gain.cancelScheduledValues(0); Ad.fader.gain.value = 0; Ad.goal.fader = Ad.knob.fader = 0;
  ramp(a, 'low', 0.5, 1); ramp(a, 'mid', 0.5, 1, 1); ramp(a, 'high', 0.5, 1, 2);
  live = b; liveSince = A.ctx.currentTime; urge = 0; trans = null; gestureCool = A.ctx.currentTime + 4 * spbLive();
  if (checking) return;                                  // Hoerprobe: nach dem Wechsel wird nichts nachgeladen
  const old = Ad.entry; Ad.entry = null; release(old); loadDeck(a);
  evoNext();
}

function gesture(beat) {
  const now = A.ctx.currentTime; if (mode !== 'hirn' || trans || now < gestureCool || beat % 4 !== 0) return;
  let k = 0; for (let i = 1; i < 4; i++) if (sig[live * 4 + i] > sig[live * 4 + k]) k = i;
  const zz = sig[live * 4 + k]; if (zz < G().gTh) return;
  const d = live, nm = CH[k];
  if (nm === 'low') { ramp(d, 'low', 0, 0.25); ramp(d, 'low', 0.5, 0.1, 3.9); }
  else if (nm === 'mid') { ramp(d, 'mid', 0.18, 1); ramp(d, 'mid', 0.5, 1, 3); }
  else if (nm === 'high') { ramp(d, 'high', 0.12, 1); ramp(d, 'high', 0.5, 1, 3); }
  else { for (let i = 0; i < 4; i++) { ramp(d, 'fader', 0, 0, i * 0.5 + 0.25); ramp(d, 'fader', 1, 0, i * 0.5 + 0.5); } }
  gestureCool = now + 16 * spbLive();
  log(d, 'Kanal ' + (d ? 'R' : 'L') + '·' + NAME[nm] + ' feuert (z=' + zz.toFixed(1) + ') → ' + (nm === 'fader' ? 'Fader-Chop' : NAME[nm] + ' kurz raus') + ' auf Deck ' + (d + 1));
}

function djLogic(dt) {
  const now = A.ctx.currentTime; let Ad = decks[live], spb = spbLive();
  // Automations-Rampen: Zielwerte der Regler
  for (let i = ramps.length - 1; i >= 0; i--) {
    const r = ramps[i]; if (now < r.t0) continue;
    const g = decks[r.d].goal; if (r.from === null) r.from = g[r.name];
    const u = r.t1 > r.t0 ? clamp((now - r.t0) / (r.t1 - r.t0)) : 1;
    g[r.name] = r.from + (r.to - r.from) * u; focus[r.d] = { name: r.name, until: now + 0.45 };
    if (u >= 1) ramps.splice(i, 1);
  }
  for (const D of decks) { for (const k of CH) D.knob[k] += (D.goal[k] - D.knob[k]) * Math.min(1, dt * 16); D.apply(); }
  if (trans) { while (trans && trans.i < trans.S.length && now >= trans.T0 + trans.S[trans.i].at * trans.spb) { const t = trans; t.S[t.i++].fn(); } }
  Ad = decks[live]; spb = spbLive();          // ein Schritt oben kann das laufende Deck gewechselt haben
  // Beat-Uhr des laufenden Decks: Lichtblitz auf jeden Schlag mit Bass
  const bp = (Ad.pos() - Ad.track.phase) / Ad.track.beat, beat = Math.floor(bp);
  if (beat !== lastBeat && Ad.playing) {
    lastBeat = beat;
    const f = new Uint8Array(8); A.masterAn.getByteFrequencyData(f); const bass = (f[1] + f[2] + f[3] + f[4]) / 1020;
    if (bass > 0.55) flash = bass;
    gesture(beat);
  }
  // Mix-Drang: waechst langsam von selbst und schneller, wenn die Hirnhaelfte des wartenden Decks aktiver ist
  if (!trans && mode === 'show') { forceMix = false; return { bp, spb }; }
  if (!trans) {
    const trp = mode === 'plan' && Ad.entry && Ad.entry.oi !== undefined ? plan.tr[Ad.entry.oi] : null, ramping = trp && trp.aRate && Ad.pos() >= trp.aRamp;
    if (ramping && Ad.playing) { const left = Math.max(0.05, (trp.aOut - Ad.pos()) / Ad.rate); Ad.setRate(Ad.rate + (trp.aRate - Ad.rate) * Math.min(1, dt / left)); }   // A kommt dem naechsten Song im Tempo entgegen
    else if (Ad.rate !== 1 && Ad.playing) Ad.setRate(Ad.rate + clamp(1 - Ad.rate, -0.004 * dt, 0.004 * dt));   // Tempo gleitet zurueck aufs Original
    const Bd = decks[1 - live];
    if (Ad.remaining() < 0.4 && Bd.track && !Bd.playing) {            // Song zu Ende, bevor gemixt wurde: direkt weiter
      Bd.goal.fader = 1; Bd.play(now + 0.05, 1); log(1 - live, 'Song zu Ende → Deck ' + (2 - live) + ' übernimmt direkt'); recue(live, 1 - live); return { bp: 0, spb };
    }
    if (mode === 'plan' && Ad.entry && Ad.entry.oi !== undefined) {     // Set-Plan: Uebergang startet exakt an der geplanten Stelle
      const tr = plan.tr[Ad.entry.oi]; planLeft = (tr.aOut - Ad.pos()) / Ad.rate;
      if (forceMix && planLeft > 10) { Ad.stop(); Ad.offset = tr.aOut - 8; Ad.play(now + 0.05, Ad.rate); log(live, 'Vorgespult bis 8 s vor dem geplanten Übergang'); }
      else if (planLeft < 1.2 && !(checking && lastDrop)) startTransition('Set-Plan (' + tr.why + ')', { ...tr, T0: now + Math.max(0.08, planLeft) });
      forceMix = false; return { bp, spb };
    }
    const lead = sideZ[1 - live] - sideZ[live];
    urge += dt * (G().urge / 55 + 0.1 * G().lead * Math.max(0, lead));
    const need = (32 + 16) * spb + 4, minLive = 32 * spb;
    if (forceMix) startTransition('Von Hand angestoßen');
    else if (Ad.remaining() < need) startTransition('Track läuft aus');
    else if (urge >= 1 && now - liveSince > minLive) startTransition(lead > 0.05 ? (1 - live ? 'Rechte' : 'Linke') + ' Hirnhälfte führt (Δz=' + lead.toFixed(1) + ')' : 'Mix-Drang voll');
  }
  forceMix = false;
  return { bp, spb };
}

// ---------------------------------------------------------- Anzeige ----
function buildDeckPanels() {
  document.querySelectorAll('.deck').forEach((el, d) => {
    el.innerHTML = `<div class="lab"><span>Deck ${d + 1}</span><span class="st">–</span></div><div class="name">–</div>
      <div class="row"><span class="tm">0:00.00</span><span class="bpm">– BPM</span></div><canvas width="480" height="60"></canvas>
      <div class="fad">FADER<div class="tr"><div class="fi"></div></div><b>0%</b></div>
      <div class="knobs">${['low', 'mid', 'high'].map(n => `<div class="knob" data-k="${n}"><svg viewBox="0 0 34 34"><circle cx="17" cy="17" r="13" fill="none" stroke="#232936" stroke-width="3" stroke-dasharray="61.26 100" transform="rotate(135 17 17)" stroke-linecap="round"/><circle class="arc" cx="17" cy="17" r="13" fill="none" stroke="var(--c)" stroke-width="3" stroke-dasharray="30 100" transform="rotate(135 17 17)" stroke-linecap="round"/><line class="ptr" x1="17" y1="17" x2="17" y2="7" stroke="var(--c)" stroke-width="2.5" stroke-linecap="round"/></svg>${n.toUpperCase()}<i>0.0 dB</i></div>`).join('')}</div>`;
    const q = (s) => el.querySelector(s), cv = q('canvas');
    deckUI.push({ st: q('.st'), name: q('.name'), tm: q('.tm'), bpm: q('.bpm'), cv, g: cv.getContext('2d'), fi: q('.fi'), pc: q('.fad b'), knobs: [...el.querySelectorAll('.knob')].map(k => ({ n: k.dataset.k, arc: k.querySelector('.arc'), ptr: k.querySelector('.ptr'), val: k.querySelector('i') })) });
  });
}
const ST = { ROLL: 'LOOP ROLL', LADEN: 'LÄDT', PLAYING: 'PLAYING', CUED: 'CUED', QUEUED: 'QUEUED', BACKSPIN: 'BACKSPIN', LEER: '–' };
function drawDeck(d) {
  const D = decks[d], U = deckUI[d], t = D.track;
  if (!t) { U.st.textContent = D.state === 'LADEN' ? 'LÄDT' : '–'; U.name.textContent = D.pending || '–'; U.g.fillStyle = '#07080b'; U.g.fillRect(0, 0, 480, 60); return; }
  const p = D.pos(), g = U.g, W = 480, H = 60, w = t.wave, span = 8;
  U.st.textContent = ST[D.state]; U.name.textContent = t.name;
  const m = Math.floor(p / 60), s = p - m * 60; U.tm.textContent = m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  U.bpm.textContent = (t.bpm * D.rate).toFixed(1) + ' BPM';
  U.fi.style.width = (D.knob.fader * 100).toFixed(1) + '%'; U.pc.textContent = Math.round(D.knob.fader * 100) + '%';
  for (const k of U.knobs) { const v = D.knob[k.n]; k.arc.setAttribute('stroke-dasharray', (61.26 * v).toFixed(2) + ' 100'); k.ptr.setAttribute('transform', 'rotate(' + ((v - 0.5) * 270).toFixed(1) + ' 17 17)'); k.val.textContent = A.dbLabel(v); }
  g.fillStyle = '#07080b'; g.fillRect(0, 0, W, H);
  const c0 = (p - span / 2) * 100, step = span * 100 / W;
  for (let x = 0; x < W; x += 2) {
    const c = Math.floor(c0 + x * step); if (c < 0 || c >= w.n) continue;
    const a = Math.max(w.amp[c], w.amp[c + 1] || 0) / 255, h = Math.max(1, a * H * 0.95), b = w.bass[c];
    g.fillStyle = b > 165 ? ((c >> 3) % 3 ? '#ff3d8a' : '#ff4a4a') : b > 105 ? '#c264ff' : '#3d9bff';
    g.fillRect(x, (H - h) / 2, 2, h);
  }
  g.fillStyle = 'rgba(255,255,255,.22)';
  const b0 = Math.ceil((p - span / 2 - t.phase) / t.beat);
  for (let i = b0; ; i++) { const x = ((t.phase + i * t.beat) - (p - span / 2)) / span * W; if (x > W) break; g.fillRect(x, i % 4 === 0 ? 0 : H - 6, 1, i % 4 === 0 ? H : 6); }
  g.fillStyle = '#fff'; g.fillRect(W / 2 - 1, 0, 2, H);
}

let brainBase = null, bg = null, bT = null;
function fit(cv) { const r = devicePixelRatio || 1, w = Math.round(cv.clientWidth * r), h = Math.round(cv.clientHeight * r); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; } return false; }
function brainT(cv) { const s = Math.min(cv.width * 0.49, cv.height * 1.02); return { s, cx: cv.width / 2, cy: cv.height / 2 }; }
function drawBrainBase() {
  const cv = $('brainC'); fit(cv); brainBase = null; if (!cv.width || !cv.height) return; bT = brainT(cv);
  brainBase = document.createElement('canvas'); brainBase.width = cv.width; brainBase.height = cv.height;
  const g = brainBase.getContext('2d'); g.fillStyle = 'rgba(70,150,165,.12)';
  for (let i = 0; i < N; i += 2) g.fillRect(bT.cx + xy[i * 2] * bT.s, bT.cy - xy[i * 2 + 1] * bT.s, 1, 1);
  bg = cv.getContext('2d'); bg.drawImage(brainBase, 0, 0);
}
function drawBrain() {
  const cv = $('brainC'); if (fit(cv) || !brainBase) drawBrainBase(); if (!brainBase) return;
  const g = bg, now = clockMs(), r = Math.max(1, cv.width / 380);
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.clearRect(0, 0, cv.width, cv.height); g.drawImage(brainBase, 0, 0);
  g.globalCompositeOperation = 'lighter'; g.fillStyle = '#9fe6ff';
  for (const R of recent) {
    const age = (now - R.t) / 320; if (age > 1) continue;
    g.globalAlpha = (1 - age) * 0.22; const sp = R.sp;
    for (let k = 0; k < sp.length; k++) { const i = sp[k]; g.fillRect(bT.cx + xy[i * 2] * bT.s - r / 2, bT.cy - xy[i * 2 + 1] * bT.s - r / 2, r, r); }
  }
  g.globalAlpha = 1;
}
let rg = null;
function drawRaster(m) {
  const cv = $('rasterC'); if (!cv.clientWidth || !cv.clientHeight) return; if (fit(cv) || !rg) { rg = cv.getContext('2d'); rg.fillStyle = '#10131a'; rg.fillRect(0, 0, cv.width, cv.height); }
  const adv = Math.max(1, Math.round(cv.width / 300)), W = cv.width, H = cv.height, rh = H / 150;
  rg.drawImage(cv, -adv, 0); rg.fillStyle = '#10131a'; rg.fillRect(W - adv, 0, adv, H);
  rg.fillStyle = '#e8c873'; const ra = m.raster;
  for (let k = 0; k < ra.length; k += 2) rg.fillRect(W - adv + (ra[k + 1] / 20) * adv, ra[k] * rh, Math.max(1, adv / 2), Math.max(1, rh));
}

// ------------------------------------------------------------ Frame ----
let lastT = 0, stimT = 0, lastRaf = 0;
// Ist die Seite im Hintergrund (Tab gewechselt, Fenster verdeckt), pausiert der Browser requestAnimationFrame - und damit
// wuerde auch das Mixen stehenbleiben. Deshalb tickt zusaetzlich ein Worker (dessen Timer nicht gedrosselt wird) und
// treibt dann nur die Logik weiter, ohne zu zeichnen.
if (!REC) {
  const tk = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),33)'], { type: 'text/javascript' })));
  tk.onmessage = () => { if (running && performance.now() - lastRaf > 150) frame(performance.now(), true); };
}
function frame(tms, bg) {
  if (!REC && !bg) { requestAnimationFrame(frame); lastRaf = performance.now(); }
  const dt = Math.min(0.05, (tms - lastT) / 1000 || 0.016); lastT = tms;
  if (!running) return;
  let beatPh = 0;
  if (!paused && decks[live].track) {                     // waehrend ein Deck nach einem Sprung noch laedt, ruht die Logik
    const r = djLogic(dt); beatPh = r.bp - Math.floor(r.bp);
    if (tms - stimT > 40 || flash > 0) {
      stimT = tms;
      worker.postMessage({ type: 'stim', jl: clamp(10 + 700 * decks[0].level, 0, 260), jr: clamp(10 + 700 * decks[1].level, 0, 260), flash, gain: +$('sGain').value * G().gain, noise: +$('sNoise').value });
    }
  }
  if (bg) { flash = 0; return; }                          // im Hintergrund: nur Logik, kein Bild
  const now = A.ctx.currentTime;
  const st = { beat: beatPh, energy: clamp(decks[live].level * 5), flash, spikes: clamp(spikeRate / 900), xf: decks[1].knob.fader - decks[0].knob.fader,
    decks: decks.map((D, d) => ({ knob: D.knob, spin: paused ? 0 : D.spin, level: D.level, focus: focus[d].until > now ? focus[d].name : null, jog: D.state === 'BACKSPIN' || now < jogUntil[d] })) };
  flash = 0;
  if (VIDEO && mode === 'show') videoCam(dt);
  scene3d.update(dt, st);
  drawDeck(0); drawDeck(1); drawBrain();
  if (VIDEO) drawVideo();
  $('stat').textContent = mode === 'show' ? '' : mode === 'plan' ? (trans ? 'Übergang läuft' : 'Übergang in ' + Math.floor(Math.max(0, planLeft) / 60) + ':' + String(Math.floor(Math.max(0, planLeft) % 60)).padStart(2, '0')) : 'Mix-Drang ' + Math.round(clamp(urge) * 100) + '%';
  $('evo').textContent = 'Gen ' + evo.gen + ' · ' + (evo.cur + 1) + '/' + POP;
  $('simv').textContent = lastTick.cost > 20 ? 'Zeitlupe ×' + (20 / lastTick.cost).toFixed(2) : '';

}
