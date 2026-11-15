"""Lokaler Server fuer Fliegenhirn DJ (nur 127.0.0.1).

Liefert die Seite aus diesem Ordner und zusaetzlich alle Musikdateien, die in den Nachbarordnern
liegen (z. B. ../Neuer Ordner) oder in ./musik:
  /songs.json   Liste der gefundenen Songs
  /song/<nr>    die Datei selbst
"""
import http.server, json, mimetypes, os, shutil, sys, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AUDIO = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".opus", ".aac"}
SKIP = {"dj", "data", "venv", "__pycache__"}
def _port():                          # PORT-Variable hat Vorrang (Vorschau im Claude-Fenster), sonst 1. Argument
    for v in (os.environ.get("PORT"), sys.argv[1] if len(sys.argv) > 1 else None):
        if v and v.isdigit():
            return int(v)
    return 8141


def find_songs():
    dirs = [os.path.join(HERE, "musik")]
    for d in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, d)
        if os.path.isdir(p) and d not in SKIP and not d.startswith("."):
            dirs.append(p)
    out = []
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            p = os.path.join(d, f)
            if os.path.isfile(p) and os.path.splitext(f)[1].lower() in AUDIO:
                out.append(p)
    return out


PLAN_LOCK = threading.Lock()


def ensure_plan(play=None):
    """Plant das Set neu, wenn sich Songs, Spieldauer oder deine Vorgaben (Daumen, Bewertungen, Verschiebungen) geaendert haben."""
    with PLAN_LOCK:
        want = {"%s|%d" % (os.path.basename(p), os.path.getsize(p)) for p in find_songs()}
        try:
            old = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))
            have, was, ostamp, over = {s["key"] for s in old["songs"]}, old.get("play"), old.get("stamp"), old.get("ver")
        except Exception:
            have, was, ostamp, over = None, None, None, None
        play = play or was or 45
        try:
            import plan_set
            if have == want and was == play and ostamp == plan_set.user_data()[3] and over == plan_set.VERSION:
                return
            print("Plane das Set neu ...", flush=True)
            plan_set.main(play)
        except Exception as err:                      # z. B. PyAV fehlt: dann laeuft die Seite ohne Plan
            print("Set-Planung fehlgeschlagen:", err, flush=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/songs.json":
            songs = find_songs()
            body = json.dumps([
                {"name": os.path.splitext(os.path.basename(p))[0], "url": "/song/%d" % i,
                 "key": "%s|%d" % (os.path.basename(p), os.path.getsize(p))}
                for i, p in enumerate(songs)]).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/plan.json":
            q = self.path.partition("?")[2]
            try:
                play = max(20, min(240, int(q.split("play=")[1].split("&")[0]))) if "play=" in q else None
            except ValueError:
                play = None
            ensure_plan(play)
        if path.startswith("/song/"):
            songs = find_songs()
            try:
                p = songs[int(path[6:])]
            except (ValueError, IndexError):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(p)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(os.path.getsize(p)))
            self.end_headers()
            with open(p, "rb") as f:
                shutil.copyfileobj(f, self.wfile)
            return
        super().do_GET()

    def do_POST(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}

        def done(code=200):
            self.send_response(code); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"ok")

        def update(name, fn):                           # kleine JSON-Datei lesen, aendern, schreiben
            p = os.path.join(HERE, name)
            try:
                d = json.load(open(p, encoding="utf-8"))
            except Exception:
                d = {}
            fn(d)
            json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

        tech, v = q.get("tech", ""), 1 if q.get("v") == "1" else -1
        if u.path == "/vote" and tech.isalpha():            # Daumen fuer eine Technik allgemein
            update("prefs.json", lambda d: d.__setitem__(tech, d.get(tech, 0) + v))
            return done()
        if u.path == "/rate" and tech.isalpha() and "a" in q and "b" in q:   # Daumen fuer genau diesen Uebergang
            key = q["a"] + ">>" + q["b"]
            update("ratings.json", lambda d: d.setdefault(key, {}).__setitem__(tech, d.get(key, {}).get(tech, 0) + v))
            return done()
        if u.path == "/check" and tech.isalpha() and "a" in q and "b" in q:   # Messwerte der stummen Hoerprobe
            try:
                m = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8"))
            except Exception:
                return done(400)
            key = q["a"] + ">>" + q["b"]
            update("check.json", lambda d: d.setdefault(key, {}).__setitem__(tech, m))
            return done()
        if u.path == "/override" and "name" in q:           # Hoehepunkt eines Songs von Hand verschieben
            def f(d):
                e = d.setdefault(q["name"], {})
                for k in ("einstieg", "ausstieg"):
                    if k in q:
                        e[k] = round(float(q[k]), 3)
            update("overrides.json", f)
            return done()
        name = os.path.basename(q.get("name", ""))
        if u.path != "/save" or os.path.splitext(name)[1].lower() not in (".mp4", ".webm", ".h264", ".json", ".wav"):
            self.send_error(400)
            return
        n = int(self.headers.get("Content-Length") or 0)
        os.makedirs(os.path.join(HERE, "video"), exist_ok=True)
        with open(os.path.join(HERE, "video", name), "wb") as f:
            left = n
            while left > 0:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                f.write(chunk); left -= len(chunk)
        done()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    PORT = _port()
    print("Fliegenhirn DJ: http://127.0.0.1:%d/  (%d Songs gefunden)" % (PORT, len(find_songs())))
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
