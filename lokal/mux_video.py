"""Baut aus der Browser-Aufnahme (video/NAME.h264 + .wav + .json) ein TikTok-fertiges MP4:
1080x1920, H.264, feste 30 Bilder pro Sekunde, AAC-Ton.

Aufruf:  python -P mux_video.py [NAME]        (Standard: fliege-ikkimel)
"""
import json, os, sys
from fractions import Fraction
import av

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = sys.argv[1] if len(sys.argv) > 1 else "fliege-ikkimel"
V = os.path.join(HERE, "video")
FPS = 30


def main():
    meta = json.load(open(os.path.join(V, NAME + ".json")))
    ts = [t / 1e6 for t in meta["ts"]]                       # Aufnahmezeit jedes Bildes in Sekunden
    src = av.open(os.path.join(V, NAME + ".h264"), format="h264")
    wavp = os.path.join(V, NAME + ".wav")
    aud = av.open(wavp if os.path.exists(wavp) else os.path.join(V, NAME + ".webm"))
    out = av.open(os.path.join(V, NAME + ".mp4"), "w")
    vs = out.add_stream("libx264", rate=FPS)
    vs.width, vs.height, vs.pix_fmt = 1080, 1920, "yuv420p"
    vs.options = {"crf": "17", "preset": "medium", "profile": "high", "level": "4.2"}
    as_ = out.add_stream("aac", rate=48000)
    as_.bit_rate = 256000
    as_.layout = "stereo"

    # ---- Bild: fuer jeden Ausgabe-Zeitpunkt k/30 das zuletzt aufgenommene Bild
    k = n = 0
    dur = 0.0
    prev = None
    for i, f in enumerate(src.decode(video=0)):
        t = ts[i] if i < len(ts) else ts[-1] + (i - len(ts) + 1) / FPS
        while prev is not None and k / FPS < t:              # bis zu diesem Bild das vorige wiederholen
            g = prev.reformat(format="yuv420p"); g.pts = k; g.time_base = Fraction(1, FPS)
            for p in vs.encode(g): out.mux(p)
            k += 1
        prev = f; n += 1; dur = t
    if prev is not None:
        g = prev.reformat(format="yuv420p"); g.pts = k; g.time_base = Fraction(1, FPS)
        for p in vs.encode(g): out.mux(p)
        k += 1
    for p in vs.encode(): out.mux(p)

    # ---- Ton: Opus -> AAC, auf die Bildlaenge gekuerzt
    rs = av.AudioResampler("fltp", "stereo", 48000)
    pts = 0
    limit = int((k / FPS) * 48000)
    fifo = av.AudioFifo()
    for f in aud.decode(audio=0):
        for r in rs.resample(f):
            r.pts = None; fifo.write(r)
    while fifo.samples >= 1024 and pts < limit:
        fr = fifo.read(1024); fr.pts = pts; fr.time_base = Fraction(1, 48000); fr.sample_rate = 48000; pts += 1024
        for p in as_.encode(fr): out.mux(p)
    for p in as_.encode(): out.mux(p)
    out.close(); src.close(); aud.close()
    size = os.path.getsize(os.path.join(V, NAME + ".mp4")) / 1e6
    print("Aufnahme: %d Bilder in %.1f s (%.1f B/s), im Browser ausgelassen: %d" % (n, dur, n / max(dur, 1e-9), meta.get("dropped", 0)))
    print("MP4: %d Bilder bei %d B/s = %.1f s, Ton %.1f s, %.1f MB -> video/%s.mp4" % (k, FPS, k / FPS, pts / 48000, size, NAME))
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    print("Groesste Luecke zwischen zwei Bildern: %.0f ms; Luecken ueber 70 ms: %d" % (max(gaps) * 1000, sum(g > 0.07 for g in gaps)))


if __name__ == "__main__":
    main()
