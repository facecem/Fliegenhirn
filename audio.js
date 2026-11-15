// DJ-Audio: zwei Decks mit 3-Band-EQ, Fader, Backspin; Track-Analyse (BPM, Beat-Raster, Wellenform);
// drei eingebaute, komplett synthetisierte Demo-Tracks.

export let ctx = null, master = null, masterAn = null;

// offlineSec gesetzt -> OfflineAudioContext: nichts ist zu hoeren, der Ton wird exakt berechnet (fuer die Videoaufnahme)
export function initAudio(offlineSec) {
  ctx = offlineSec ? new OfflineAudioContext(2, Math.ceil(offlineSec * 48000), 48000) : new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain(); master.gain.value = 0.8;
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -6; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.12;
  masterAn = ctx.createAnalyser(); masterAn.fftSize = 1024; masterAn.smoothingTimeConstant = 0.5;
  // Weicher Begrenzer am Ende: bis 0,8 unveraendert, darueber sanft abgerundet - nichts geht ueber Vollaussteuerung und wird hart abgeschnitten
  const clip = ctx.createWaveShaper(), cv = new Float32Array(2049);
  for (let i = 0; i < cv.length; i++) { const x = (i / 1024 - 1) * 2, a = Math.abs(x); cv[i] = Math.sign(x) * (a <= 0.8 ? a : 0.8 + 0.19 * Math.tanh((a - 0.8) / 0.19)); }
  clip.curve = cv; clip.oversample = '2x';
  const pre = ctx.createGain(); pre.gain.value = 0.5; const postG = ctx.createGain(); postG.gain.value = 1;      // Kennlinie deckt Eingaenge bis +-2 ab
  master.connect(lim); lim.connect(pre); pre.connect(clip); clip.connect(postG); postG.connect(masterAn); masterAn.connect(ctx.destination);
  return ctx;
}

// Reglerstellung 0..1 -> dB (0.5 = 0 dB, 0 = Kill, 1 = +6 dB)
// Rausch-Riser: gefiltertes Rauschen, das bis t1 heller und lauter wird
export function riser(t0, t1, peak = 0.2) {
  const n = ctx.sampleRate * 2, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8; bp.frequency.setValueAtTime(300, t0); bp.frequency.exponentialRampToValueAtTime(9000, t1);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.001, t0); g.gain.exponentialRampToValueAtTime(peak, t1 - 0.02); g.gain.linearRampToValueAtTime(0, t1);
  s.connect(bp); bp.connect(g); g.connect(master); s.start(t0); s.stop(t1 + 0.05);
}

export function knobDb(k) { return k >= 0.5 ? (k - 0.5) * 12 : -60 * Math.pow(1 - 2 * k, 1.6); }
export function dbLabel(k) { return k < 0.02 ? '−∞ dB' : knobDb(k).toFixed(1) + ' dB'; }

export class Deck {
  constructor(id) {
    this.id = id; this.track = null; this.src = null; this.rate = 1;
    this.offset = 0; this.startT = 0; this.playing = false; this.state = 'LEER';
    this.spin = 0;                                   // Jog-Drehrichtung fuer die 3D-Szene
    this.knob = { low: 0.5, mid: 0.5, high: 0.5, fader: 0 };   // was das Pult gerade zeigt
    this.goal = { low: 0.5, mid: 0.5, high: 0.5, fader: 0 };   // wohin das Bein dreht
    this.hpf = ctx.createBiquadFilter(); this.hpf.type = 'highpass'; this.hpf.frequency.value = 20; this.hpf.Q.value = 0.9;
    this.trim = ctx.createGain(); this.trim.connect(this.hpf); this.inp = this.trim;                    // Pegel-Angleich zwischen unterschiedlich laut gemasterten Songs   // Hochpass fuer Filterfahrten
    this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 220; this.hpf.connect(this.low);
    this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1100; this.mid.Q.value = 0.7;
    this.high = ctx.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 4200;
    this.an = ctx.createAnalyser(); this.an.fftSize = 512;
    this.fader = ctx.createGain(); this.fader.gain.value = 0;
    this.low.connect(this.mid); this.mid.connect(this.high); this.high.connect(this.an); this.high.connect(this.fader); this.fader.connect(master);
    // Echo: Abgriff vor dem Fader -> Delay mit Rueckkopplung -> Master (klingt weiter, wenn der Fader zu ist)
    this.send = ctx.createGain(); this.send.gain.value = 0; this.delay = ctx.createDelay(2); this.fb = ctx.createGain(); this.fb.gain.value = 0.55;
    const wet = ctx.createGain(); wet.gain.value = 0.8; const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
    this.high.connect(this.send); this.send.connect(hp); hp.connect(this.delay); this.delay.connect(this.fb); this.fb.connect(this.delay); this.delay.connect(wet); wet.connect(master);
    this._buf = new Float32Array(512); this.level = 0;
  }
  load(track, cue) { this.stop(); this.track = track; this.offset = cue; this.state = 'CUED'; this.rate = 1; }
  pos() { return this.playing ? this.offset + Math.max(0, ctx.currentTime - this.startT) * this.rate : this.offset; }
  remaining() { return this.track ? this.track.dur - this.pos() : 0; }
  play(when, rate) {
    if (!this.track) return;
    this._kill();
    this.rate = rate || this.rate;
    const s = ctx.createBufferSource(); s.buffer = this.track.buffer; s.playbackRate.value = this.rate;
    s.connect(this.inp); s.start(when, Math.max(0, this.offset));
    this.src = s; this.startT = when; this.playing = true; this.state = 'PLAYING'; this.spin = 1;
  }
  sweep(f0, f1, t0, t1) { const f = this.hpf.frequency; f.cancelScheduledValues(t0); f.setValueAtTime(f0, t0); f.exponentialRampToValueAtTime(f1, t1); }
  sweepOff() { const f = this.hpf.frequency; f.cancelScheduledValues(0); f.setValueAtTime(20, ctx.currentTime); }
  // Loop-Roll: ab `when` wird dasselbe Stueck ab Trackposition `pos` immer kuerzer wiederholt. parts = [[Schlaege, Anzahl], ...]
  roll(when, pos, spbWall, parts) {
    if (this.src) this.src.stop(when);
    let t = when;
    for (const [beats, count] of parts) for (let i = 0; i < count; i++) {
      const dur = beats * spbWall, s = ctx.createBufferSource(), g = ctx.createGain();
      s.buffer = this.track.buffer; s.playbackRate.value = this.rate;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.002); g.gain.setValueAtTime(1, t + dur - 0.004); g.gain.linearRampToValueAtTime(0, t + dur);
      s.connect(g); g.connect(this.inp); s.start(t, pos, dur * this.rate + 0.01); s.stop(t + dur + 0.01); t += dur;
    }
    return t;
  }
  echo(on, beatSec) { const t = ctx.currentTime; if (on) this.delay.delayTime.setValueAtTime(Math.min(1.9, beatSec * 0.75), t); this.send.gain.setTargetAtTime(on ? 1 : 0, t, 0.015); }
  stop() { if (this.playing) this.offset = this.pos(); this._kill(); this.playing = false; this.spin = 0; }
  // Tempo im Lauf aendern (Pitch-Fader), Position bleibt stimmig
  setRate(r) { if (this.playing && this.src) { this.offset = this.pos(); this.startT = Math.max(this.startT, ctx.currentTime); this.src.playbackRate.setValueAtTime(r, ctx.currentTime); } this.rate = r; }
  _kill() { if (this.src) { try { this.src.stop(); } catch (e) { } this.src.disconnect(); this.src = null; } }
  // Platte zurueckreissen: rueckwaerts laufender Puffer, Tempo faellt ab
  backspin(dur) {
    if (!this.track) return;
    const p = this.pos(), now = ctx.currentTime; this._kill(); this.playing = false;
    const s = ctx.createBufferSource(); s.buffer = this.track.reversed();
    s.playbackRate.setValueAtTime(3.2, now); s.playbackRate.exponentialRampToValueAtTime(0.25, now + dur);
    s.connect(this.inp); s.start(now, Math.max(0, this.track.dur - p)); s.stop(now + dur);
    this.src = s; this.offset = p; this.state = 'BACKSPIN'; this.spin = -3;
    this.fader.gain.setTargetAtTime(0, now + dur * 0.55, dur * 0.15);
  }
  // Pult-Werte auf die Audio-Knoten uebertragen (jeden Frame)
  apply() {
    const t = ctx.currentTime;
    this.low.gain.setTargetAtTime(knobDb(this.knob.low), t, 0.02);
    this.mid.gain.setTargetAtTime(knobDb(this.knob.mid) * 0.6, t, 0.02);
    this.high.gain.setTargetAtTime(knobDb(this.knob.high), t, 0.02);
    if (this.state !== 'BACKSPIN') this.fader.gain.setTargetAtTime(this.knob.fader * this.knob.fader, t, 0.02);
    this.an.getFloatTimeDomainData(this._buf);
    let s = 0; for (let i = 0; i < 512; i++) s += this._buf[i] * this._buf[i];
    this.level = Math.sqrt(s / 512);
  }
}

// ---------------------------------------------------------------- Track ----
export class Track {
  constructor(name, buffer, info) {
    this.name = name; this.buffer = buffer; this.dur = buffer.duration;
    this.bpm = info.bpm; this.phase = info.phase; this.beat = 60 / info.bpm; this.bar = this.beat * 4;
    this.solid = info.grid === undefined || info.grid >= 2.5;      // Beat-Raster verlaesslich genug zum Beatmatchen?
    this.cues = info.cues || this._autoCues();
    this.cueI = 0; this._rev = null; this.wave = waveform(buffer);
  }
  _autoCues() {             // Einstiegspunkte auf dem Taktraster, verteilt ueber die erste Haelfte
    const out = []; for (const f of [0.06, 0.22, 0.4]) out.push(this.phase + Math.round((this.dur * f - this.phase) / (this.bar * 4)) * this.bar * 4);
    return out.map(c => Math.max(this.phase, c));
  }
  nextCue() { const c = this.cues[this.cueI % this.cues.length]; this.cueI++; return c; }
  reversed() {
    if (!this._rev) {
      const b = this.buffer, r = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
      for (let c = 0; c < b.numberOfChannels; c++) { const d = r.getChannelData(c); d.set(b.getChannelData(c)); d.reverse(); }
      this._rev = r;
    }
    return this._rev;
  }
}

// Wellenform: 100 Spalten pro Sekunde, Hoehe = Pegel, Farbe = Bassanteil
function waveform(buf) {
  const d = buf.getChannelData(0), sr = buf.sampleRate, hop = Math.floor(sr / 100), n = Math.floor(d.length / hop);
  const amp = new Uint8Array(n), bass = new Uint8Array(n); const a = 1 - Math.exp(-2 * Math.PI * 180 / sr); let lp = 0;
  for (let i = 0; i < n; i++) {
    let pk = 0, el = 0, et = 0;
    for (let j = 0, s = i * hop; j < hop; j++) { const x = d[s + j]; lp += a * (x - lp); const ax = x < 0 ? -x : x; if (ax > pk) pk = ax; el += lp * lp; et += x * x; }
    amp[i] = Math.min(255, pk * 255); bass[i] = et > 1e-9 ? Math.min(255, Math.sqrt(el / et) * 300) : 0;
  }
  return { amp, bass, n };
}

// BPM + Beat-Phase aus der Onset-Huellkurve (bassbetont), Raster ueber den ganzen Track
export function analyze(buf) {
  const sr = buf.sampleRate, d = buf.getChannelData(0), fps = 200, hop = Math.floor(sr / fps), nF = Math.floor(d.length / hop);
  const env = new Float32Array(nF); const a = 1 - Math.exp(-2 * Math.PI * 120 / sr); let lp = 0, pl = 0, pb = 0, m = 0;
  for (let i = 0; i < nF; i++) {
    let el = 0, eb = 0; for (let j = 0, s = i * hop; j < hop; j++) { const x = d[s + j]; lp += a * (x - lp); el += lp * lp; eb += x * x; }
    el = Math.sqrt(el / hop); eb = Math.sqrt(eb / hop);
    env[i] = 0.75 * Math.max(0, el - pl) + 0.25 * Math.max(0, eb - pb); pl = el; pb = eb; m += env[i];
  }
  m = m / nF || 1; for (let i = 0; i < nF; i++) env[i] /= m;
  const comb = (bpm) => { const lag = fps * 60 / bpm; let s = 0, c = 0; for (let i = Math.ceil(lag); i < nF; i += 2) { const j = i - lag, j0 = j | 0, fr = j - j0; s += env[i] * (env[j0] * (1 - fr) + (env[j0 + 1] || 0) * fr); c++; } return c ? s / c : 0; };
  let rough = 120, best = -1;
  // Ein echtes Tempo traegt auch auf halber und doppelter Geschwindigkeit; 2/3- und 4/3-Irrtuemer tun das nicht
  for (let b = 84; b <= 168; b += 0.5) { const s = comb(b) + 0.5 * comb(b / 2) + 0.5 * comb(b * 2); if (s > best) { best = s; rough = b; } }
  let bpm = rough, phase = 0; best = -1;
  for (let b = rough - 2; b <= rough + 2; b += 0.02) {
    const lag = fps * 60 / b;
    for (let ph = 0; ph < lag; ph += 1) { let s = 0, c = 0; for (let t = ph; t < nF; t += lag) { s += env[t | 0]; c++; } if (c && s / c > best) { best = s / c; bpm = b; phase = ph; } }
  }
  // Vertrauen: wie viel staerker sind die Anschlaege auf dem Raster als daneben (halber Schlag versetzt)?
  const lagF = fps * 60 / bpm; let on = 0, offb = 0, c = 0;
  for (let t = phase; t + lagF / 2 < nF; t += lagF) { on += Math.max(env[t | 0], env[(t | 0) + 1] || 0); offb += Math.max(env[(t + lagF / 2) | 0], env[((t + lagF / 2) | 0) + 1] || 0); c++; }
  return { bpm: +bpm.toFixed(2), phase: phase / fps, conf: +(on / (offb + 1e-6)).toFixed(2), grid: +(best).toFixed(2) };
}

// Analyse in einem eigenen Thread, damit Bild und Ton nicht stocken
let anWorker = null, anSeq = 0; const anWait = new Map();
export function analyzeAsync(buf) {
  if (!anWorker) {
    const src = analyze.toString() + ';onmessage=e=>{const d=e.data.d;postMessage({id:e.data.id,r:analyze({sampleRate:e.data.sr,getChannelData:()=>d})});}';
    anWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    anWorker.onmessage = (e) => { const f = anWait.get(e.data.id); anWait.delete(e.data.id); if (f) f(e.data.r); };
  }
  return new Promise((res) => { const id = ++anSeq, d = buf.getChannelData(0).slice(); anWait.set(id, res); anWorker.postMessage({ id, d, sr: buf.sampleRate }, [d.buffer]); });
}
export async function decode(arrayBuffer) { return ctx.decodeAudioData(arrayBuffer); }

// ------------------------------------------------------- Demo-Tracks ----
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const STYLES = [
  { name: 'Haltere Bounce', seed: 11, root: 43.65, bassWave: 'saw', hatOpen: 0.35, stab: [0, 3, 7], swing: 0 },
  { name: 'Ommatidia', seed: 29, root: 49.0, bassWave: 'sq', hatOpen: 0.15, stab: [0, 7, 10], swing: 0.012 },
  { name: 'Calyx Acid', seed: 53, root: 55.0, bassWave: 'acid', hatOpen: 0.5, stab: [0, 3, 10], swing: 0 },
];
export const DEMO_COUNT = STYLES.length;

export function makeDemo(k) {
  const st = STYLES[k], sr = 44100, bpm = 140, beat = 60 / bpm, s16 = beat / 4, bars = 72;
  const len = Math.ceil(bars * 4 * beat * sr) + sr, out = new Float32Array(len), R = rng(st.seed);
  const shot = (dur, fn) => { const n = Math.floor(dur * sr), a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = fn(i / sr, i); return a; };
  const add = (a, t, gain) => { let p = Math.floor(t * sr); for (let i = 0; i < a.length && p < len; i++, p++) out[p] += a[i] * gain; };
  const kick = shot(0.32, (t) => Math.tanh(2.2 * Math.sin(2 * Math.PI * (46 * t + 13 * (1 - Math.exp(-t * 34)))) * Math.exp(-t * 9)));
  let hp = 0; const noiseHP = () => { const x = R() * 2 - 1, y = x - hp; hp = x; return y * 0.5; };
  const hat = shot(0.05, (t) => noiseHP() * Math.exp(-t * 90));
  const hatO = shot(0.2, (t) => noiseHP() * Math.exp(-t * 16));
  let bp1 = 0, bp2 = 0; const clap = shot(0.22, (t) => { const x = R() * 2 - 1; bp1 += 0.35 * (x - bp1); bp2 += 0.08 * (bp1 - bp2); const e = Math.exp(-t * 22) + 0.7 * Math.exp(-Math.abs(t - 0.012) * 300) + 0.6 * Math.exp(-Math.abs(t - 0.025) * 300); return (bp1 - bp2) * e * 1.4; });
  const semi = (n) => Math.pow(2, n / 12);
  const bassNote = (f) => { let ph = 0, lp = 0, lp2 = 0; return shot(s16 * 1.9, (t) => { ph += f / sr; ph -= Math.floor(ph); const raw = st.bassWave === 'sq' ? (ph < 0.5 ? 1 : -1) : 2 * ph - 1; const cut = st.bassWave === 'acid' ? 0.03 + 0.45 * Math.exp(-t * 16) : 0.05 + 0.2 * Math.exp(-t * 22); lp += cut * (raw - lp); lp2 += cut * (lp - lp2); const e = Math.min(1, t * 400) * Math.exp(-t * 7); return Math.tanh((st.bassWave === 'acid' ? lp2 + 0.6 * (lp - lp2) * 2 : lp2) * 1.8) * e; }); };
  const stabNote = (f) => { const ph = [0, 0, 0, 0, 0, 0]; let lp = 0; return shot(0.45, (t) => { let x = 0; for (let v = 0; v < 6; v++) { const fr = f * semi(st.stab[v % 3]) * (v < 3 ? 1 : 1.006); ph[v] += fr / sr; ph[v] -= Math.floor(ph[v]); x += 2 * ph[v] - 1; } const cut = 0.06 + 0.3 * Math.exp(-t * 9); lp += cut * (x / 6 - lp); return lp * Math.exp(-t * 6) * Math.min(1, t * 300); }); };
  const scale = [0, 3, 5, 7, 10, 12];
  const bassPat = []; for (let i = 0; i < 16; i++) bassPat.push(i % 4 === 2 ? 0 : (i % 4 === 0 ? -1 : (R() < 0.45 ? scale[(R() * scale.length) | 0] : (R() < 0.5 ? 0 : -1))));
  const bassShots = {}; for (const n of new Set(bassPat)) if (n >= 0) bassShots[n] = bassNote(st.root * semi(n));
  const stabPat = []; for (let i = 0; i < 16; i++) stabPat.push((i === 3 || i === 6 || i === 11 || (i === 14 && R() < 0.6)) ? 1 : 0);
  const stabA = stabNote(st.root * 4), stabB = stabNote(st.root * 4 * semi(-2));
  // Aufbau in 8-Takt-Bloecken: K=Kick H=Hat C=Clap B=Bass S=Stab R=Riser
  const form = ['KH', 'KHB', 'KHCB', 'SR', 'KHCBS', 'KHCBS', 'HSR', 'KHCBS', 'KHC'];
  for (let bar = 0; bar < bars; bar++) {
    const sec = form[Math.min(form.length - 1, bar >> 3)], t0 = bar * 4 * beat, last = (bar & 7) === 7;
    for (let i = 0; i < 16; i++) {
      const t = t0 + i * s16 + (i & 1 ? st.swing : 0);
      if (sec.includes('K') && i % 4 === 0 && !(last && i >= 12 && sec !== 'KH')) add(kick, t, 0.95);
      if (sec.includes('K') && last && i >= 12) add(kick, t, 0.5 + 0.1 * (i - 12));
      if (sec.includes('H')) { if (i % 4 === 2) add(R() < st.hatOpen ? hatO : hat, t, 0.32); else if (i & 1) add(hat, t, 0.12 + 0.1 * R()); }
      if (sec.includes('C') && i % 8 === 4) add(clap, t, 0.5);
      if (sec.includes('B') && bassPat[i] >= 0) add(bassShots[bassPat[i]], t, 0.5);
      if (sec.includes('S') && stabPat[i]) add((bar & 3) === 3 ? stabB : stabA, t, 0.3);
    }
    if (sec.includes('R')) { const p0 = Math.floor(t0 * sr), n = Math.floor(4 * beat * sr), prog = (bar & 7) / 8; let l = 0; for (let i = 0; i < n; i++) { const u = prog + i / n / 8; l += (0.02 + 0.5 * u * u) * ((R() * 2 - 1) - l); out[p0 + i] += l * 0.28 * u; } }
  }
  for (let i = 0; i < len; i++) out[i] = Math.tanh(out[i] * 1.1) * 0.85;
  const buf = ctx.createBuffer(2, len, sr); buf.getChannelData(0).set(out); buf.getChannelData(1).set(out);
  const bar = 4 * beat;
  return new Track(st.name, buf, { bpm, phase: 0, cues: [8 * bar, 32 * bar, 16 * bar] });
}
