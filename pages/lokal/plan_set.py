"""Hoert alle Songs vorab durch und schreibt den Set-Plan (plan.json), den die Fliege dann ausfuehrt.

Prinzip des Sets: HOEHEPUNKT ZU HOEHEPUNKT. Von jedem Song wird der laute Teil (Hook/Drop) gespielt. Der Aufbau
des naechsten Songs laeuft ohne Bass unter dem noch laufenden Hoehepunkt mit; sobald der alte Hoehepunkt abklingt,
sitzt der neue schon da. Es gibt keine Strecke, in der man nur auf den naechsten Aufbau wartet.

Pro Song (analyse):  Tempo (mehrere Kandidaten, an den Kicks geprueft), Schlaege, einzelne Kick-Zeitpunkte (ms-genau),
                     Lautheit und Bass pro Schlag, Gesangs-Hinweis, Tonart, Pegel fuer den Lautstaerke-Angleich.
Pro Uebergang (pair): ms-genaues Raster beider Songs aus den Kicks, Tempo-Angleich (notfalls mit Tempo-Rampe),
                     Technik-Auswahl mit Selbstkontrolle (Kick-Deckung, Pegelsprung, Gesang auf Gesang).

Aufruf:  python -P plan_set.py [Sekunden pro Song]     (Analyse je Song wird in plan_cache2.json gemerkt)
"""
import json, math, os, sys
import numpy as np
import av

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from server import find_songs

VERSION = 5
SR, NFFT, HOP = 22050, 1024, 256
FPS = SR / HOP
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "H"]
MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
TECH_NAME = {"drop": "Roll + Drop", "bass": "Bass-Swap", "eq": "EQ-Blend", "cut": "Schnitt auf die Eins", "filter": "Filter-Fahrt", "echo": "Echo-Out",
             "chop": "Fader-Chop", "rolldrop": "Roll + Drop-in", "filterdrop": "Filter + Drop-in", "chopdrop": "Chop + Drop-in"}
SYNC_TECH, FREE_TECH = ("drop", "bass", "eq", "cut", "filter", "echo", "chop"), ("rolldrop", "filterdrop", "chopdrop", "echo")


# ------------------------------------------------------------------ Einlesen ----
def load_stereo(path):
    c = av.open(path)
    rs = av.AudioResampler("flt", "stereo", SR)
    out = []
    for f in c.decode(c.streams.audio[0]):
        for r in rs.resample(f):
            out.append(r.to_ndarray().reshape(-1, 2))
    c.close()
    x = np.concatenate(out).astype(np.float32)
    return x.mean(1), (x[:, 0] - x[:, 1]) / 2


def load(path):                                            # Mono (auch von make_show.py benutzt)
    return load_stereo(path)[0]


def spectrogram(y):
    win = np.hanning(NFFT).astype(np.float32)
    fr = np.lib.stride_tricks.sliding_window_view(y, NFFT)[::HOP]
    out = np.empty((len(fr), NFFT // 2 + 1), dtype=np.float32)
    for i in range(0, len(fr), 4000):
        out[i:i + 4000] = np.abs(np.fft.rfft(fr[i:i + 4000] * win, axis=1))
    return out


def onset_env(mag):
    S = np.log1p(10 * mag)
    d = np.maximum(0, np.diff(S, axis=0, prepend=S[:1]))
    full, low = d.sum(1), d[:, :10].sum(1)
    env = full / (full.std() + 1e-9) + 0.5 * low / (low.std() + 1e-9)
    k = int(FPS * 0.5) | 1
    env = env - np.convolve(env, np.ones(k) / k, mode="same")
    return np.maximum(env, 0)


def autocorr(e):
    e = e - e.mean()
    n = len(e)
    f = np.fft.rfft(e, 2 * n)
    ac = np.fft.irfft(f * np.conj(f))[:n]
    return ac / (ac[0] + 1e-9)


def estimate_tempo(env):
    ac, x = autocorr(env), np.arange(len(env))
    best, bb = -1e9, 120.0
    for bpm in np.arange(60, 200.01, 0.25):
        lag = 60 * FPS / bpm
        s = sum(np.interp(lag * m, x, ac) / m for m in (1, 2, 3, 4))
        s *= math.exp(-0.5 * (math.log2(bpm / 120) / 0.7) ** 2)
        if s > best:
            best, bb = s, bpm
    return bb


def kick_onsets(y, n=512, hop=64):
    """Bass-Anschlaege (43-170 Hz) mit 3 ms Aufloesung: Zeitpunkte der Kicks und die Anschlagskurve selbst."""
    fr = np.lib.stride_tricks.sliding_window_view(y, n)[::hop]
    win = np.hanning(n).astype(np.float32)
    e = np.empty(len(fr))
    for i in range(0, len(fr), 8000):
        m = np.abs(np.fft.rfft(fr[i:i + 8000] * win, axis=1))[:, 1:5]
        e[i:i + 8000] = np.log((m ** 2).sum(1) + 1e-6)
    on = np.maximum(0, np.diff(e, prepend=e[0]))
    on = np.convolve(on, np.ones(3) / 3, mode="same")
    t = (n / 2 + hop * np.arange(len(on))) / SR
    w = 20                                                 # +-58 ms: staerkster Anschlag in diesem Fenster
    mx = np.lib.stride_tricks.sliding_window_view(np.pad(on, w), 2 * w + 1).max(1)
    pk = np.where((on >= mx) & (on > 0.3 * np.percentile(on, 99.5)))[0]
    return t[pk], on, SR / hop


def check_tempo(base, kick_fn, fps):
    """Prueft Halb-/Doppel- und 2:3-Verwandte des Tempos an den Kicks: beim echten Tempo liegt auf jedem Schlag
    ein Kick, auf dem halben Abstand aber nicht."""
    ac = autocorr(kick_fn)
    def val(lag):
        a, b = int(lag * 0.985), int(lag * 1.015) + 2
        return float(ac[a:b].max()) if b < len(ac) else 0.0
    def score(bpm):
        lag = 60 * fps / bpm
        return val(lag) - 0.8 * val(lag / 2)
    s0 = score(base)
    best, sb = base, s0
    for f in (2, 0.5, 1.5, 2 / 3):                          # die typischen Irrtuemer des Beat-Trackers
        c = base * f
        if 72 <= c <= 185:
            s = score(c)
            if s > sb:
                best, sb = c, s
    return (best, sb, s0) if sb >= s0 + 0.25 and sb >= 0.35 else (base, s0, s0)   # nur wechseln, wenn es deutlich besser passt


def track_beats(env, bpm, tight=100.0):
    """Beat-Tracking nach Ellis (2007): beste Kette von Anschlaegen im Abstand ~ einer Periode."""
    period = 60 * FPS / bpm
    g = np.exp(-0.5 * (np.arange(-int(period), int(period) + 1) / (period / 32 + 1e-9)) ** 2)
    ls = np.convolve(env / (env.std() + 1e-9), g, mode="same")
    n = len(ls)
    lo, hi = int(round(period / 2)), int(round(2 * period))
    win = np.arange(-hi, -lo + 1)
    pen = -tight * np.log(-win / period) ** 2
    cum, back = np.zeros(n), np.full(n, -1)
    for t in range(n):
        j0 = t + win[0]
        if j0 < 0:
            cum[t] = ls[t]
            continue
        sc = cum[j0:j0 + len(win)] + pen
        k = int(np.argmax(sc))
        cum[t], back[t] = ls[t] + sc[k], j0 + k
    tail = cum[-int(2 * period):]
    t = n - len(tail) + int(np.argmax(tail))
    beats = []
    while t >= 0:
        beats.append(t)
        t = back[t]
    return np.array(beats[::-1])


def cam(pc, minor):
    n = ((pc + 3) if minor else pc) * 7 % 12 + 8
    return ((n - 1) % 12 + 1, "A" if minor else "B")


def cam_dist(a, b):
    d = abs(a[0] - b[0]); d = min(d, 12 - d)
    return d + (0 if a[1] == b[1] else 1)


def analyse(path):
    y, side = load_stereo(path)
    dur = len(y) / SR
    mag = spectrogram(y)
    env = onset_env(mag)
    kt, kfn, kfps = kick_onsets(y)
    base = estimate_tempo(env)
    tempo, sc, sc0 = check_tempo(base, kfn, kfps)
    bf = track_beats(env, tempo)
    bf = bf[(bf > 0) & (bf < len(mag) - 1)]
    bt = bf * HOP / SR + NFFT / 2 / SR
    iv = np.diff(bt)
    n = len(bt)
    # ---- pro Schlag: Lautheit (echter Pegel), Bass, Gesangs-Hinweis
    cs = np.r_[0, np.cumsum(y.astype(np.float64) ** 2)]
    si = np.clip((np.r_[bt, bt[-1] + np.median(iv)] * SR).astype(int), 0, len(y))
    pw = (cs[si[1:]] - cs[si[:-1]]) / np.maximum(1, si[1:] - si[:-1])
    top = 10 * np.log10(np.percentile(pw, 95) + 1e-12)                 # Pegel der lauten Stellen (dB RMS)
    E = 10 * np.log10(pw + 1e-12) - top
    cnt = np.diff(np.append(bf, len(mag)))
    red = lambda a: np.add.reduceat(a, bf, axis=0) / (cnt[:, None] if a.ndim > 1 else cnt)
    low = red((mag[:, 2:9] ** 2).sum(1))
    B = 10 * np.log10(low + 1e-12); B -= np.percentile(B, 95)
    H = 10 * np.log10(red((mag[:, 186:] ** 2).sum(1)) + 1e-12); H -= np.percentile(H, 95)      # Hoehen ueber 4 kHz: Becken, Schichten
    ms = spectrogram(side)[:len(mag)]
    L = min(len(ms), len(mag))
    mid_c = np.add.reduceat((mag[:L, 14:158] ** 2).sum(1), bf[bf < L]) + 1e-9
    mid_s = np.add.reduceat((ms[:L, 14:158] ** 2).sum(1), bf[bf < L]) + 1e-9
    V = np.zeros(n); V[:len(mid_c)] = 10 * np.log10(mid_c / mid_s)     # Mitte gegen Seite im Stimmbereich
    # ---- Tonart: feines Spektrum (2,7 Hz) pro Schlag, auf 12 Toene gefaltet
    N2 = 8192
    fk = np.fft.rfftfreq(N2, 1 / SR)
    sel = (fk >= 100) & (fk <= 2000)
    pcs = (np.round(12 * np.log2(fk[sel] / 440) + 69).astype(int)) % 12
    w2 = np.hanning(N2)
    ch, Cb = np.zeros(12), np.zeros((n, 12))
    for i in range(n):
        c0 = int(bt[i] * SR)
        if c0 + N2 > len(y):
            continue
        sp = np.log1p(50 * np.abs(np.fft.rfft(y[c0:c0 + N2] * w2))[sel])
        Cb[i] = np.bincount(pcs, weights=sp, minlength=12)
        if E[i] >= -12:
            ch += Cb[i]
    Cq = np.round(9 * (Cb - Cb.min(1, keepdims=True)) / (np.ptp(Cb, axis=1, keepdims=True) + 1e-9)).astype(int)
    ks = [(np.corrcoef(np.roll(MAJ, k), ch)[0, 1], k, False) for k in range(12)] + [(np.corrcoef(np.roll(MIN, k), ch)[0, 1], k, True) for k in range(12)]
    _, pc, minor = max(ks)
    return {
        "dur": round(dur, 2), "bpm": round(float(60 / np.median(iv)), 2), "tempoFix": round(float(tempo / base), 3),
        "beats": [round(float(t), 3) for t in bt], "kicks": [int(round(t * 1000)) for t in kt],
        "E": [int(round(v)) for v in np.clip(E, -60, 9)], "B": [int(round(v)) for v in np.clip(B, -60, 9)],
        "V": [int(round(v)) for v in np.clip(V, -30, 40)], "C": ["".join(map(str, r)) for r in Cq], "H": [int(round(v)) for v in np.clip(H, -60, 9)], "top": round(float(top), 1),
        "tonart": NOTES[pc] + ("-Moll" if minor else "-Dur"), "camelot": "%d%s" % cam(pc, minor),
    }


# ------------------------------------------------------------------ Planen ----
def fold(r):
    while r < 0.75: r *= 2
    while r > 1.5: r /= 2
    return r


def camelot(s):
    return (int(s["camelot"][:-1]), s["camelot"][-1])


def repeats(s, L=32):
    """Wie oft kehrt der 8-Takt-Abschnitt ab Schlag i im Song wieder (gleiche Harmoniefolge)? Refrains wiederholen sich."""
    C = np.array([[int(c) for c in row] for row in s["C"]], float)
    n = len(C)
    C -= C.mean(1, keepdims=True)
    C /= np.linalg.norm(C, axis=1, keepdims=True) + 1e-9
    S = C @ C.T
    rep, best = np.zeros(n), []
    for d in range(L, n - L):
        dg = np.diagonal(S, d)
        cs = np.r_[0, np.cumsum(dg)]
        best.append((d, (cs[L:] - cs[:-L]) / L))             # Aehnlichkeit der Abschnitte i und i+d
    if not best:
        return rep
    allv = np.concatenate([r for _, r in best])
    thr = max(0.55, np.percentile(allv, 90))
    hit = np.zeros((n, n), bool)
    for d, r in best:
        ii = np.where(r >= thr)[0]
        hit[ii, ii + d] = True; hit[ii + d, ii] = True
    for i in range(n):                                      # Treffer, die naeher als 4 Takte beieinander liegen, zaehlen einmal
        j = np.where(hit[i])[0]
        rep[i] = 0 if not len(j) else 1 + int((np.diff(j) > 16).sum())
    return rep


def choose_part(s, play):
    """Welcher Teil des Songs laeuft: Einstieg = Beginn eines Hoehepunkts, Ausstieg = wo er abklingt (~play Sekunden).
    Hoehepunkt = intensiv (Pegel + Bass + Hoehen) UND wiederkehrend (Refrain); von gleich guten gewinnt der fruehere."""
    b, E, B = np.array(s["beats"]), np.array(s["E"], float), np.array(s["B"], float)
    n = len(b)
    I = E + 0.35 * np.clip(B, -15, 3) + 0.35 * np.clip(np.array(s["H"], float), -15, 3)
    cs = np.r_[0, np.cumsum(I)]
    def mean(i, j):
        i, j = max(0, min(n, i)), max(0, min(n, j))
        return (cs[j] - cs[i]) / max(1, j - i)
    L8 = np.array([mean(i, i + 32) for i in range(n)])
    top = L8[:max(1, n - 32)].max()
    spb = float(np.median(np.diff(b)))
    rp = repeats(s)
    rz = (rp - rp.mean()) / (rp.std() + 1e-9)
    cands = [(i, mean(i, i + 16) - mean(i - 16, i)) for i in range(8, n - 48) if b[i] <= 0.75 * s["dur"] and L8[i] >= top - 4.5]
    entries = [i for (i, j) in cands if j >= 1.5 and j >= max(jj for (ii, jj) in cands if abs(ii - i) <= 8)]
    if not entries:
        entries = [next((i for i in range(n - 48) if L8[i] >= top - 1.5), 0)]
    jump = dict(cands)
    def worth(i):
        # Ein Hook erkennt man vor allem am Sprung (davor ruhiger, dann voll), dazu: kehrt wieder, kommt frueh im Song.
        # Die ersten 25 s zaehlen kaum - dort setzt meist nur der Beat der ersten Strophe ein.
        return (0.25 * min(jump.get(i, 0), 12) + (L8[i] - top) / 3 + 0.3 * rz[i:i + 8].max() - b[i] / 100
                + (0.3 if b[i] >= 16 * spb + 0.3 else 0) - (1.5 if b[i] < 25 else 0))
    entry = max(entries, key=worth)
    def edge(k):                                            # auf den Schlag genau: wo setzt der Bass ein?
        return (B[k:k + 4].mean() - B[max(0, k - 2):k].mean()) + 0.5 * (E[k:k + 4].mean() - E[max(0, k - 2):k].mean()) if 2 <= k < n - 4 else -99
    best = max(range(max(2, entry - 3), min(n - 4, entry + 4)), key=edge)
    if edge(best) > edge(entry) + 1:
        entry = best
    ov = s.get("override") or {}
    if "einstieg" in ov:
        entry = int(np.argmin(np.abs(b - ov["einstieg"])))
    grid = [j for j in range(entry + 32, n - 16, 16) if b[j] <= s["dur"] - 8]
    if not grid:
        grid = [min(n - 1, entry + 32)]
    t = lambda j: b[j] - b[entry]
    ends = [j for j in grid if mean(j - 16, j) - mean(j, j + 16) >= 2.0 and mean(entry, j) >= top - 3]   # hier klingt der Hoehepunkt ab
    ok = [j for j in ends if 0.55 * play <= t(j) <= 1.8 * play]
    if ok:
        ex, why = min(ok, key=lambda j: abs(t(j) - play)), "klingt ab"
    else:
        early = [j for j in ends if t(j) >= max(12, 0.35 * play)]
        if early and t(early[0]) <= 1.8 * play:
            ex, why = early[0], "klingt ab"
        else:
            g8 = [j for j in grid if (j - entry) % 32 == 0] or grid
            ex, why = min(g8, key=lambda j: abs(t(j) - play)), "Zeit um"
    if "ausstieg" in ov:
        ex, why = max(entry + 16, int(np.argmin(np.abs(b - ov["ausstieg"])))), "von Hand"
    if "einstieg" in ov:
        why += ", Einstieg von Hand"
    s["entry"], s["exit"], s["phi"], s["exitWhy"], s["rep"] = int(entry), int(ex), int(entry % 4), why, int(rp[entry:entry + 8].max())
    s["stable"] = True


def fit_kicks(s, i0, i1, ref):
    """ms-genaues Raster: jeder Schlag i0..i1 wird auf den naechsten Kick gezogen, dann eine Gerade durchgelegt.
    Rueckgabe: Zeit am Schlag `ref`, Schlagdauer, Abweichung (s), Anteil getroffener Schlaege."""
    b, K = np.array(s["beats"]), np.array(s["kicks"]) / 1000.0
    i0, i1 = max(0, i0), min(len(b), i1)
    idx = np.arange(i0, i1)
    if len(idx) < 4:
        sp = float(np.median(np.diff(b)))
        return float(b[min(len(b) - 1, ref)]), sp, 0.03, 0.0
    k, tt = [], []
    if len(K):
        j = np.clip(np.searchsorted(K, b[idx]), 1, len(K) - 1)
        near = np.where(np.abs(K[j] - b[idx]) < np.abs(K[j - 1] - b[idx]), K[j], K[j - 1])
        m = np.abs(near - b[idx]) < 0.045
        k, tt = idx[m], near[m]
    if len(k) >= max(6, 0.4 * len(idx)):
        for _ in range(3):
            f = np.polyfit(k, tt, 1); r = tt - np.polyval(f, k)
            keep = np.abs(r) < max(0.010, 2 * r.std())
            if keep.sum() < 6: break
            k, tt = k[keep], tt[keep]
        f = np.polyfit(k, tt, 1)
        return float(np.polyval(f, ref)), float(f[0]), float(np.sqrt(np.mean((tt - np.polyval(f, k)) ** 2))), len(k) / len(idx)
    f = np.polyfit(idx, b[idx], 1)                         # zu wenige Kicks: grobes Raster aus dem Beat-Tracking
    return float(np.polyval(f, ref)), float(f[0]), float(np.sqrt(np.mean((b[idx] - np.polyval(f, idx)) ** 2))), 0.0


def vocal_share(s, i0, i1):
    V, E = np.array(s["V"], float), np.array(s["E"], float)
    loud = V[E > -8]
    if len(loud) < 16 or i1 <= i0:
        return 0.0
    thr = np.median(loud) + 1.0
    return float((V[max(0, i0):i1] > thr).mean())


def core(A, B):
    """Alles am Uebergang A -> B, was nicht von der Technik abhaengt: Raster, Tempo, Ueberlappung, Kontrolle."""
    tA, spA, rA, hA = fit_kicks(A, A["exit"] - 32, A["exit"], A["exit"])        # Hoehepunkt-Ende von A
    tB, spB, rB, hB = fit_kicks(B, B["entry"], B["entry"] + 32, B["entry"])     # Hoehepunkt-Beginn von B
    r = fold(spB / spA)                                     # so schnell muesste B laufen
    steady = rA < 0.012 and rB < 0.012 and hA >= 0.4 and hB >= 0.4
    lead = int((tB - 0.05) / spB) // 4 * 4                  # so viele Schlaege Aufbau hat B vor seinem Hoehepunkt
    n = max(0, min(32, lead, (A["exit"] - A["entry"]) - 16))
    n = n // 8 * 8 if n >= 8 else n // 4 * 4
    va, vb = vocal_share(A, A["exit"] - max(n, 8), A["exit"]), vocal_share(B, B["entry"] - max(n, 8), B["entry"])
    clash = va > 0.5 and vb > 0.5
    EA, EB, BB = np.array(A["E"], float), np.array(B["E"], float), np.array(B["B"], float)
    trimA, trimB = A["trim"], B["trim"]
    lvlA = EA[A["exit"] - 16:A["exit"]].mean() + A["top"] + 20 * math.log10(trimA)
    lvlB = EB[B["entry"]:B["entry"] + 16].mean() + B["top"] + 20 * math.log10(trimB)
    bassJump = BB[B["entry"]:B["entry"] + 8].mean() - BB[max(0, B["entry"] - 8):B["entry"]].mean() if B["entry"] >= 4 else 0.0
    mode, aRate = "frei", 1.0
    if steady and n >= 4:
        if abs(r - 1) <= 0.08:
            mode = "sync"
        elif abs(r - 1) <= 0.145:                           # zu weit: A kommt B vor dem Uebergang mit einer Tempo-Rampe entgegen
            mode, aRate = "rampe", r ** -0.5
    kd = cam_dist(camelot(A), camelot(B))
    return {"tA": tA, "spA": spA, "tB": tB, "spB": spB, "r": r, "n": n, "mode": mode, "aRate": aRate, "kd": kd, "clash": clash,
            "check": {"gridMsA": round(rA * 1000, 1), "gridMsB": round(rB * 1000, 1), "kicksA": round(hA, 2), "kicksB": round(hB, 2),
                      "levelJump": round(lvlB - lvlA, 1), "bassJump": round(float(bassJump), 1), "vocalA": round(va, 2), "vocalB": round(vb, 2)}}


def cost(A, B):
    c = core(A, B)
    k = 0.0 if c["kd"] <= 1 else 0.15 if c["kd"] == 2 else 0.3      # Tonart nur leicht gewichtet (Schaetzung ist grob)
    k += 0.25 if c["clash"] else 0
    k += 0.15 * max(0.0, math.log2(A["bpm"] / B["bpm"])) * 5       # Spannungsbogen: lieber schneller werden als langsamer
    if c["mode"] == "sync":
        return k + abs(math.log2(c["r"])) * 5 + (0 if c["n"] >= 16 else 0.2)
    if c["mode"] == "rampe":
        return k + 0.7
    return k + 1.1 + abs(math.log2(fold(A["bpm"] / B["bpm"])))


def best_order(S):
    """Beste Kette durch alle Songs: bis 12 Songs exakt (Held-Karp), darueber naechster Nachbar + Verschieben."""
    n = len(S)
    if n < 3:
        return list(range(n))
    C = [[cost(S[i], S[j]) if i != j else 0 for j in range(n)] for i in range(n)]
    if n > 12:
        total = lambda o: sum(C[o[i]][o[i + 1]] for i in range(n - 1))
        best = None
        for start in range(n):
            o, left = [start], set(range(n)) - {start}
            while left:
                nx = min(left, key=lambda j: C[o[-1]][j]); o.append(nx); left.remove(nx)
            if best is None or total(o) < total(best):
                best = o
        improved = True
        while improved:
            improved = False
            for i in range(n):
                for j in range(n):
                    if i == j:
                        continue
                    o = best[:]; x = o.pop(i); o.insert(j, x)
                    if total(o) < total(best) - 1e-9:
                        best, improved = o, True
        return best
    dp = {(1 << i, i): (0.0, -1) for i in range(n)}
    for mask in range(1, 1 << n):
        for last in range(n):
            if (mask, last) not in dp:
                continue
            base = dp[(mask, last)][0]
            for nx in range(n):
                if mask >> nx & 1:
                    continue
                k = (mask | 1 << nx, nx)
                v = base + C[last][nx]
                if k not in dp or v < dp[k][0]:
                    dp[k] = (v, last)
    full = (1 << n) - 1
    last = min(range(n), key=lambda i: dp[(full, i)][0])
    order, mask = [], full
    while last >= 0:
        order.append(last)
        prev = dp[(mask, last)][1]
        mask ^= 1 << last
        last = prev
    return order[::-1]


def pair(A, B, hist, prefs, ratings, checks):
    """Legt den Uebergang A -> B fest: alle passenden Techniken bewerten (Selbstkontrolle), beste nehmen.
    hist = bisher im Set benutzte Techniken (fuer die Abwechslung)."""
    c = core(A, B)
    ck, n = c["check"], c["n"]
    synced = c["mode"] in ("sync", "rampe")
    kick = ck["kicksA"]
    if synced:
        cand = {
            "drop": 1.0 + (0.3 if ck["bassJump"] >= 6 else -0.3) + (0 if kick >= 0.6 else -0.6),      # Roll braucht Kicks, Drop einen Bass-Einsatz
            "bass": 0.95 + (0.15 if n >= 16 else -0.1),
            "eq": 0.8 + (0.25 if c["kd"] <= 1 and not c["clash"] and n >= 16 else -0.5),             # lange Blende nur, wenn Tonart passt und nicht zwei singen
            "cut": 0.85 + (0.25 if ck["bassJump"] >= 8 else 0) + (0.2 if n <= 8 else 0),              # harter Schnitt lebt vom Bass-Einschlag
            "filter": 0.9 + (0.15 if n >= 16 else -0.3),
            "echo": 0.8 + (0.3 if ck["vocalA"] > 0.5 else 0),                                         # Echo klingt auf einer Stimme am besten
            "chop": 0.85 + (0.1 if kick >= 0.5 else -0.4) + (0 if n >= 8 else -0.4),
        }
    else:
        cand = {"rolldrop": 1.0 + (0.2 if kick >= 0.5 else -0.5), "filterdrop": 0.95, "chopdrop": 0.9 + (0 if kick >= 0.5 else -0.3), "echo": 0.85 + (0.2 if ck["vocalA"] > 0.5 else 0)}
    rk = ratings.get(A["key"] + ">>" + B["key"], {})
    ck2 = checks.get(A["key"] + ">>" + B["key"], {})             # Ergebnisse der stummen Hoerprobe
    for t in cand:
        cand[t] += 0.25 * max(-3, min(3, prefs.get(t, 0)))                 # deine Daumen fuer die Technik allgemein
        cand[t] += 1.0 * max(-2, min(2, rk.get(t, 0)))                     # ... und fuer genau diesen Uebergang
        if t in ck2: cand[t] += -0.9 if ck2[t].get("warn") else 0.15      # durchgefallen -> andere Technik; bestanden -> kleiner Bonus
        if hist and t == hist[-1]: cand[t] -= 1.2                          # nie zweimal hintereinander
        if len(hist) > 1 and t == hist[-2]: cand[t] -= 0.5
        if len(hist) > 2 and t == hist[-3]: cand[t] -= 0.25
        cand[t] -= 0.3 * hist.count(t) / max(1, len(hist)) * 4             # insgesamt gleichmaessig verteilen
    tech = max(cand, key=cand.get)
    out = {"tech": tech, "sync": synced, "spb": c["spA"], "aDrop": round(c["tA"], 4), "bDrop": round(c["tB"], 4), "check": ck,
           "scores": {k: round(v, 2) for k, v in cand.items()}}
    if synced:
        out.update({"beats": n, "rate": round(c["r"], 5), "aOut": round(c["tA"] - n * c["spA"], 4), "bIn": round(max(0.0, c["tB"] - n * c["spB"]), 4),
                    "roll": 8 if n >= 16 else 4, "late": bool(c["clash"] and n > 8)})
        if c["mode"] == "rampe":
            out.update({"aRate": round(c["aRate"], 4), "aRamp": round(c["tA"] - (n + 32) * c["spA"], 3)})
        why = "Tempo %+.1f %%" % ((c["r"] - 1) * 100) + (", A mit Tempo-Rampe" if c["mode"] == "rampe" else "")
    else:
        out.update({"beats": 8, "rate": 1.0, "aOut": round(c["tA"] - 8 * c["spA"], 4), "bIn": round(c["tB"], 4), "roll": 8, "late": False})
        why = "kein Beatmatch: " + ("Tempo %+.0f %% auseinander" % ((c["r"] - 1) * 100) if abs(c["r"] - 1) > 0.145 else "kein Aufbau bei B" if n < 4 else "Raster unsicher")
    warn = []
    if synced and max(ck["gridMsA"], ck["gridMsB"]) > 8: warn.append("Raster ±%.0f ms" % max(ck["gridMsA"], ck["gridMsB"]))
    if ck["levelJump"] < -2: warn.append("Drop %.0f dB leiser" % ck["levelJump"])
    if c["clash"]: warn.append("Gesang auf Gesang")
    out["why"], out["warn"] = why, warn
    if tech in ck2:
        out["measured"] = ck2[tech]
    return out


def user_data():
    """Was du von Hand vorgegeben hast: Daumen pro Technik, Bewertungen pro Uebergang, Hoehepunkte von Hand."""
    def rd(name):
        try: return json.load(open(os.path.join(HERE, name), encoding="utf-8"))
        except Exception: return {}
    prefs, ratings, checks = rd("prefs.json"), rd("ratings.json"), rd("check.json")
    over = {k: v for k, v in rd("overrides.json").items() if not k.startswith("_")}
    return prefs, ratings, over, json.dumps([prefs, ratings, over, checks], sort_keys=True), checks


def main(play=45):
    try: sys.stdout.reconfigure(encoding="utf-8")
    except Exception: pass
    cache_p = os.path.join(HERE, "plan_cache2.json")
    cache = json.load(open(cache_p, encoding="utf-8")) if os.path.exists(cache_p) else {}
    if cache.get("_ver") != VERSION:
        cache = {"_ver": VERSION}
    prefs, ratings, over, stamp, checks = user_data()
    songs = []
    for p in find_songs():
        key = "%s|%d" % (os.path.basename(p), os.path.getsize(p))
        if key not in cache:
            print("analysiere", os.path.basename(p), flush=True)
            try:
                cache[key] = analyse(p)
            except Exception as err:
                print("  uebersprungen:", err)
                continue
            json.dump(cache, open(cache_p, "w", encoding="utf-8"))
        s = {**cache[key], "key": key, "name": os.path.splitext(os.path.basename(p))[0]}
        s["trim"] = round(float(np.clip(10 ** ((-9.5 - s["top"]) / 20), 0.5, 1.6)), 3)     # alle Songs auf gleichen Pegel (hoechstens +4 dB)
        s["override"] = next((v for k, v in over.items() if k.lower() in s["name"].lower()), None)
        choose_part(s, play)
        _, sp, res, hit = fit_kicks(s, s["entry"], s["entry"] + 64, s["entry"])
        if hit >= 0.4 and res < 0.012:
            s["bpm"] = round(60 / sp, 2)                     # exaktes Tempo aus den Kicks statt aus dem groben Beat-Tracking
        songs.append(s)
    out_p = os.path.join(HERE, "plan.json")
    if not songs:
        json.dump({"songs": [], "tr": [], "play": play, "stamp": stamp, "ver": VERSION}, open(out_p, "w"))
        print("keine Songs gefunden")
        return
    S = [songs[i] for i in best_order(songs)]
    tr, hist = [], []
    for i in range(len(S)):
        t = pair(S[i], S[(i + 1) % len(S)], hist, prefs, ratings, checks)
        tr.append(t); hist.append(t["tech"])
    slim = []
    for i, s in enumerate(S):
        b = s["beats"]
        s["start"] = tr[i - 1]["bIn"]                       # wo der Song einsetzt: am Beginn seines Aufbaus
        s["tEntry"], s["tExit"] = b[s["entry"]], b[s["exit"]]
        slim.append({k: v for k, v in s.items() if k not in ("E", "B", "V", "H", "C", "kicks", "override")})
    json.dump({"songs": slim, "tr": tr, "play": play, "stamp": stamp, "ver": VERSION, "names": TECH_NAME}, open(out_p, "w", encoding="utf-8"))
    print("\nSET-PLAN  (Hoehepunkt zu Hoehepunkt, ~%d s pro Song)" % play)
    for i, s in enumerate(S):
        b = np.array(s["beats"]); t = tr[i]; ck = t["check"]
        fix = "" if abs(s["tempoFix"] - 1) < 0.01 else "  [Tempo korrigiert x%.2f]" % s["tempoFix"]
        print("%2d. %-34s %6.1f BPM %-8s Pegel %+.1f dB  Hoehepunkt %5.1f-%5.1f s (%2.0f s, %s, kehrt %dx wieder)%s" % (
            i + 1, s["name"][:34], s["bpm"], s["tonart"], 20 * math.log10(s["trim"]), b[s["entry"]], b[s["exit"]], b[s["exit"]] - b[s["entry"]], s["exitWhy"], s["rep"], fix))
        print("      → %-20s %2d Schlaege  %s%s  | Raster %.0f/%.0f ms, Pegelsprung %+.1f dB" % (
            TECH_NAME[t["tech"]], t["beats"], t["why"], (" · Achtung: " + ", ".join(t["warn"])) if t["warn"] else "", ck["gridMsA"], ck["gridMsB"], ck["levelJump"]))
    print("\n%d von %d Uebergaengen beatgematcht; Techniken: %s" % (sum(t["sync"] for t in tr), len(tr), ", ".join("%s x%d" % (TECH_NAME[k], sum(t["tech"] == k for t in tr)) for k in TECH_NAME if any(t["tech"] == k for t in tr))))


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 45)
