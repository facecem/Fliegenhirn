// Ganzhirn-Simulation der Fruchtfliege (FlyWire v783): 139.255 Leaky-Integrate-and-Fire-Neuronen,
// 2,7 Mio. gerichtete Verbindungen. Parameter nach Shiu et al. 2024 (Nature), Zeitschritt 2 ms.
// Das Vorzeichen jeder Verbindung kommt vom Transmitter des sendenden Neurons, das Gewicht von der Synapsenzahl.
// Zwei Abweichungen vom Originalmodell, ohne die das Netz entweder stumm bleibt oder in Daueranfall kippt:
// Hemmung zaehlt doppelt (inh = 2) und jedes Neuron ermuedet nach einem Spike (Schwelle +11 mV, klingt in 150 ms ab).
'use strict';

const TAU_M = 20, TAU_G = 5;        // ms: Membran, Synapse
const V_TH = 7;                     // mV ueber Ruhe (-52 -> -45)
const W_SYN = 0.275;                // mV pro Synapse
const DT = 2;                       // ms pro Schritt (= synaptische Verzoegerung)
const REFR = 1;                     // Schritte Refraktaerzeit
const TICK = 20;                    // ms Simulationszeit pro Paket
const NCH = 8;                      // Ausgangskanaele: 4 links, 4 rechts
const ROWS = 150;                   // Zeilen im Spike-Raster

let N = 0, off, tgt, w, cls, side;
let S, ad, adT, stepNo = 1, act, inAct, nAct = 0, chOf, rowOf, cnt;   // S: pro Neuron [v, g, -, refraktaer-bis-Schritt]            // S: pro Neuron [v, g, Ermuedung, Refraktaerzeit] direkt nebeneinander (cache-freundlich)
let jonL, jonR, photo, outputs;
let cur = new Int32Array(1 << 16), nCur = 0;
let stim = { jl: 0, jr: 0, flash: 0, gain: 1, noise: 0.02, inh: 2, adapt: 11 };
// Ermuedung (Schwellen-Anhebung nach jedem Spike) klingt mit 150 ms ab
let running = false, timer = 0, simMs = 0, lastWall = 0, behind = 0, flashSteps = 0, flashAmp = 0, sinceRows = 0;
const DM = DT / TAU_M, DG = Math.exp(-DT / TAU_G);

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') init(m);
  else if (m.type === 'stim') { const f = m.flash; Object.assign(stim, m); if (f > 0) { flashSteps = 2; flashAmp = f; } }
  else if (m.type === 'steps') { for (let i = 0; i < m.n; i++) tick(); postMessage({ type: 'done' }); }   // Offline-Rendern: genau n Pakete rechnen
  else if (m.type === 'run') { running = m.on; lastWall = performance.now(); behind = 0; if (running && !timer) timer = setInterval(loop, 10); }
};

function init(m) {
  N = m.N; const E = m.E;
  off = new Int32Array(m.con, 0, N + 1);          // Int32 statt Uint32: bleibt in der Engine eine echte Ganzzahl
  tgt = new Int32Array(m.con, (N + 1) * 4, E);
  w = new Int8Array(m.con, (N + 1) * 4 + E * 4, E);
  cls = new Uint8Array(m.neu, N * 8, N);
  side = new Uint8Array(m.neu, N * 9, N);
  S = new Float32Array(N * 4); ad = new Float32Array(N); adT = new Float32Array(N); act = new Int32Array(N); inAct = new Uint8Array(N);
  chOf = new Int8Array(N).fill(-1); rowOf = new Int16Array(N).fill(-1); cnt = new Uint16Array(N);
  const L = [], R = [], P = [], O = [];
  for (let i = 0; i < N; i++) {
    const c = cls[i];
    if (c === 1) (side[i] === 1 ? R : L).push(i);
    else if (c === 2) P.push(i);
    else if (c === 3 || c === 4) O.push(i);
  }
  jonL = Uint32Array.from(L); jonR = Uint32Array.from(R); photo = Uint32Array.from(P); outputs = Uint32Array.from(O);
  // Absteigende Neuronen + Motorneuronen -> 8 Kanaele (linke Hirnhaelfte = Deck 1, rechte = Deck 2)
  const k = [0, 0];
  for (const i of O) { const s = side[i] === 2 ? (i & 1) : side[i]; chOf[i] = s * 4 + (k[s]++ % 4); }
  pickRows(true);
  postMessage({ type: 'ready', jon: [L.length, R.length], photo: P.length, out: O.length });
}

// Raster zeigt eine feste Stichprobe: Hoer-Neuronen, Fotorezeptoren, Ausgang - und die aktivsten Zentralneuronen.
function pickRows(first) {
  rowOf.fill(-1); let r = 0;
  const take = (arr, n) => { const st = Math.max(1, Math.floor(arr.length / n)); for (let i = 0; i < arr.length && n > 0; i += st, n--) rowOf[arr[i]] = r++; };
  take(jonL, 12); take(jonR, 12); take(photo, 16);
  if (first) take(outputs, 30);
  else {
    const act = []; for (let i = 0; i < N; i++) if (cnt[i] > 0 && cls[i] !== 1 && cls[i] !== 2) act.push(i);
    for (let i = act.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0, t = act[i]; act[i] = act[j]; act[j] = t; }   // zufaellige aktive Neuronen
    for (let i = 0; i < act.length && r < ROWS; i++) rowOf[act[i]] = r++;
  }
  cnt.fill(0);
}

function push(i) { if (nCur >= cur.length) { const b = new Int32Array(cur.length * 2); b.set(cur); cur = b; } cur[nCur++] = i; }
function force(i) { const o = i * 4; if (S[o + 3] < stepNo) { S[o + 3] = stepNo + REFR; S[o] = 0; push(i); if (!inAct[i]) { inAct[i] = 1; act[nAct++] = i; } } }
function fire(arr, p) { for (let k = 0; k < arr.length; k++) if (Math.random() < p) force(arr[k]); }

function loop() {
  if (!running) return;
  const now = performance.now();
  behind += now - lastWall; lastWall = now;
  if (behind > 200) behind = 200;                 // nicht aufholen, wenn der Rechner zu langsam ist
  let guard = 0;
  while (behind >= TICK && guard++ < 3) { tick(); behind -= TICK; }
}

function tick() {
  const t0 = performance.now();
  const spikes = [], raster = [], ch = new Float32Array(NCH), byCls = new Uint32Array(8);
  const W = W_SYN * stim.gain, WI = W * stim.inh, AD = stim.adapt;
  const St = S, offs = off, tg = tgt, ws = w, ac = act, ia = inAct;   // lokale Kopien fuer die heisse Schleife
  const pStep = 0.001 * DT;
  act.subarray(0, nAct).sort();      // aufsteigend sortiert = fast sequentieller Speicherzugriff
  let total = 0, na = nAct;
  for (let s = 0; s < TICK; s += DT) {
    // 1) Spikes des letzten Schritts ueber die echten Synapsen zustellen
    for (let k = 0; k < nCur; k++) {
      const i = cur[k];
      for (let e = offs[i], e1 = offs[i + 1]; e < e1; e++) {
        const t = tg[e], we = ws[e]; St[t * 4 + 1] += (we < 0 ? we * WI : we * W);
        if (ia[t] === 0) { ia[t] = 1; ac[na++] = t; }
      }
    }
    nCur = 0; nAct = na;
    // 2) Sinnesreize: Schall -> Johnston-Organ (links/rechts), Lichtblitz -> Fotorezeptoren, dazu Spontanaktivitaet
    if (stim.jl > 0) fire(jonL, stim.jl * pStep);
    if (stim.jr > 0) fire(jonR, stim.jr * pStep);
    if (flashSteps > 0) { fire(photo, 0.08 * flashAmp); flashSteps--; }
    const nz = N * stim.noise * pStep; let kz = Math.floor(nz) + (Math.random() < nz % 1 ? 1 : 0);
    while (kz-- > 0) force((Math.random() * N) | 0);
    na = nAct;
    // 3) Membranen integrieren - nur Neuronen, die gerade etwas tun
    let j = 0; const now = stepNo;
    for (let k = 0; k < na; k++) {
      const i = ac[k], o = i * 4; let gi = St[o + 1], vi = St[o];
      if (St[o + 3] >= now) { gi *= DG; St[o + 1] = (gi < 0.02 && gi > -0.02) ? 0 : gi; ac[j++] = i; continue; }
      vi += (gi - vi) * DM; gi *= DG; if (gi < 0.02 && gi > -0.02) gi = 0;
      if (vi >= V_TH) {                                  // Ermuedung wird nur hier (selten) nachgerechnet
        let ai = ad[i]; if (ai > 0) ai *= Math.exp((adT[i] - now) * DT / 150);
        if (vi >= V_TH + ai) { vi = 0; St[o + 3] = now + REFR; ad[i] = ai + AD; adT[i] = now; push(i); }
      }
      else if (vi < -20) vi = -20;
      else if (gi === 0 && vi < 0.1 && vi > -0.1) { St[o] = 0; St[o + 1] = 0; ia[i] = 0; continue; }
      St[o] = vi; St[o + 1] = gi; ac[j++] = i;
    }
    stepNo++;
    na = j; nAct = j;
    total += nCur;
    for (let k = 0; k < nCur; k++) {
      const i = cur[k]; byCls[cls[i]]++; if (cnt[i] < 65535) cnt[i]++;
      if (chOf[i] >= 0) ch[chOf[i]]++;
      if (rowOf[i] >= 0) raster.push(rowOf[i], s);
      if (spikes.length < 2500) spikes.push(i);
    }
  }
  simMs += TICK; sinceRows += TICK;
  if (sinceRows >= 6000) { sinceRows = 0; pickRows(false); }
  const sp = Uint32Array.from(spikes), ra = Uint8Array.from(raster);
  postMessage({ type: 'tick', n: total, spikes: sp, raster: ra, ch, byCls, cost: performance.now() - t0, simMs }, [sp.buffer, ra.buffer, ch.buffer, byCls.buffer]);
}
