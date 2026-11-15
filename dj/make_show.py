"""Vermisst den Showcase-Uebergang BIKINI GRELL -> KETA UND KRAWALL auf die Millisekunde und schreibt show.json.

Idee des Uebergangs: KETA-Intro (ohne Bass, baut sich auf) liegt ueber dem vollen BIKINI-Teil; BIKINI wird
ausgeduennt und stottert im Loop-Roll hoch; der KETA-Drop faellt exakt auf das Ende des BIKINI-Blocks.

Aufruf:  python -P make_show.py
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plan_set as P
from server import find_songs

A_NAME, B_NAME = "BIKINI GRELL", "KETA UND KRAWALL"
A_EXIT_BAR, A_START_BAR = 40, 28          # BIKINI: Block endet an Takt 40; der Clip beginnt an Takt 28
SR = P.SR


def kick_env(y, t0, t1, hop=32, n=512):
    """Bass-Anschlaege (43-170 Hz) mit 1,5 ms Aufloesung im Ausschnitt [t0, t1]."""
    a, b = max(0, int(t0 * SR) - n), min(len(y), int(t1 * SR) + n)
    fr = np.lib.stride_tricks.sliding_window_view(y[a:b], n)[::hop]
    mag = np.abs(np.fft.rfft(fr * np.hanning(n), axis=1))[:, 1:5]
    e = np.log((mag ** 2).sum(1) + 1e-6)
    on = np.maximum(0, np.diff(e, prepend=e[0]))
    on = np.convolve(on, np.ones(3) / 3, mode="same")
    t = (a + n / 2 + hop * np.arange(len(on))) / SR
    return t, on


def fit_grid(y, beats, i0, i1):
    """Verfeinert die Schlaege i0..i1 auf den naechsten Kick und legt eine Gerade durch (Zeit = t0 + k * spb)."""
    t, on = kick_env(y, beats[i0] - 0.3, beats[i1] + 0.3)
    k, tt = [], []
    for i in range(i0, i1 + 1):
        m = (t > beats[i] - 0.07) & (t < beats[i] + 0.07)
        if m.any() and on[m].max() > 0.25 * np.percentile(on, 99):
            k.append(i); tt.append(t[m][np.argmax(on[m])])
    k, tt = np.array(k), np.array(tt)
    for _ in range(3):                                   # Ausreisser raus
        f = np.polyfit(k, tt, 1)
        r = tt - np.polyval(f, k)
        keep = np.abs(r) < max(0.012, 2 * r.std())
        k, tt = k[keep], tt[keep]
    f = np.polyfit(k, tt, 1)
    return f, len(k), float(np.sqrt(np.mean((tt - np.polyval(f, k)) ** 2)))


def main():
    try: sys.stdout.reconfigure(encoding="utf-8")
    except Exception: pass
    cache = json.load(open(os.path.join(HERE, "plan_cache.json"), encoding="utf-8"))
    S = {}
    for p in find_songs():
        for tag in (A_NAME, B_NAME):
            if tag in os.path.basename(p):
                key = "%s|%d" % (os.path.basename(p), os.path.getsize(p))
                S[tag] = {"key": key, "y": P.load(p), **{k: cache[key][k] for k in ("beats", "phi", "hit", "bpm", "dur")}}
    A, B = S[A_NAME], S[B_NAME]
    ba, bb = np.array(A["beats"]), np.array(B["beats"])

    # ---- BIKINI: Raster aus den 32 Schlaegen vor dem Blockende
    ia = A["phi"] + 4 * A_EXIT_BAR
    fa, na, ra = fit_grid(A["y"], ba, ia - 32, ia - 1)
    a_drop = float(np.polyval(fa, ia))
    print("BIKINI: %d Kicks, Abweichung %.1f ms, Schlag %.5f s (%.2f BPM), Blockende bei %.3f s" % (na, ra * 1000, fa[0], 60 / fa[0], a_drop))

    # ---- KETA: wo setzt der Bass wirklich ein? Bass-Energie pro Schlag rund um den erkannten Einsatz
    ib = B["phi"] + 4 * B["hit"]
    def bass_db(i):                                       # Bass-Pegel (unter ~170 Hz) im Schlag i
        seg = B["y"][int(bb[i] * SR):int(bb[i + 1] * SR)]
        sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
        f = np.fft.rfftfreq(len(seg), 1 / SR)
        return 10 * np.log10(sp[(f > 35) & (f < 170)].sum() / len(seg) + 1e-9)
    lvl = np.array([bass_db(i) for i in range(ib - 12, ib + 16)])
    ref = np.median(lvl[14:])
    print("KETA Bass pro Schlag in dB unter vollem Pegel (erkannter Einsatz = Position 12):")
    print("   " + " ".join("%3d" % round(v - ref) for v in lvl))
    first = ib - 12 + next(j for j in range(len(lvl) - 4) if (lvl[j:j + 4] > ref - 4).all())
    fb, nb, rb = fit_grid(B["y"], bb, first, first + 31)
    b_drop = float(np.polyval(fb, first))
    print("KETA:   %d Kicks, Abweichung %.1f ms, Schlag %.5f s (%.2f BPM), Drop bei %.3f s (Schlag %+d gegen Analyse)" % (nb, rb * 1000, fb[0], 60 / fb[0], b_drop, first - ib))

    rate = fb[0] / fa[0]
    # Lautheit angleichen: BIKINI auf -8,5 dB RMS, KETA auf -7 dB (der Drop darf etwas lauter sein, aber nicht 6 dB)
    rms = lambda y, t0, t1: 20 * np.log10(np.sqrt(np.mean(y[int(t0 * SR):int(t1 * SR)] ** 2)) + 1e-9)
    la, lb = rms(A["y"], a_drop - 16, a_drop), rms(B["y"], b_drop, b_drop + 16)
    trim_a, trim_b = 10 ** ((-8.5 - la) / 20), 10 ** ((-7.0 - lb) / 20)
    print("Lautheit: BIKINI %.1f dB -> Faktor %.2f, KETA %.1f dB -> Faktor %.2f" % (la, trim_a, lb, trim_b))
    a_start = float(np.polyval(fa, A["phi"] + 4 * A_START_BAR))
    show = {"a": A["key"], "b": B["key"], "aStart": round(a_start, 4), "aDrop": round(a_drop, 4), "spbA": round(float(fa[0]), 6),
            "bDrop": round(b_drop, 4), "spbB": round(float(fb[0]), 6), "rate": round(float(rate), 5), "bStart": 0.0, "trimA": round(float(trim_a), 3), "trimB": round(float(trim_b), 3)}
    json.dump(show, open(os.path.join(HERE, "show.json"), "w"))
    lead = (b_drop - show["bStart"]) / rate
    print("Tempo: KETA laeuft %+.2f %% schneller. KETA steigt %.1f s (%.1f Schlaege) vor dem Drop ein. Clip: %.1f s BIKINI allein, dann Uebergang." % ((rate - 1) * 100, lead, lead / fa[0], a_drop - a_start - lead))
    return show, A, B


if __name__ == "__main__":
    main()
