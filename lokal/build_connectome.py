"""Baut aus den FlyWire-v783-CSVs (../data) das kompakte Binaerformat fuer die Browser-Simulation.

Ausgabe (in diesem Ordner):
  connectome.bin  - CSR-Graph: off[N+1] uint32 | tgt[E] uint32 | w[E] int8 (Synapsenzahl, Vorzeichen = erregend/hemmend)
  neurons.bin     - pro Neuron: x,y float32 (Layout), cls uint8, side uint8
  meta.json       - Zaehler, Klassen-Namen, Regionen
Vorzeichen wie im Shiu-et-al.-2024-Modell: GABA und Glutamat hemmen, alles andere erregt.
"""
import json, os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")

neu = pd.read_csv(os.path.join(DATA, "neurons.csv.gz"))
cla = pd.read_csv(os.path.join(DATA, "classification.csv.gz"))
con = pd.read_csv(os.path.join(DATA, "connections.csv.gz"), usecols=["pre_root_id", "post_root_id", "syn_count"])

neu = neu.merge(cla, on="root_id", how="left")
N = len(neu)
idx = pd.Series(np.arange(N, dtype=np.int64), index=neu.root_id.values)

# --- Kanten: pro (pre,post) ueber alle Neuropile summieren --------------------------------
con["a"] = idx.reindex(con.pre_root_id.values).values
con["b"] = idx.reindex(con.post_root_id.values).values
con = con.dropna(subset=["a", "b"])
e = con.groupby(["a", "b"], sort=True).syn_count.sum().reset_index()
a = e.a.values.astype(np.int64); b = e.b.values.astype(np.uint32)
inhib = neu.nt_type.isin(["GABA", "GLUT"]).values
w = np.clip(e.syn_count.values, 1, 127).astype(np.int8)
w = np.where(inhib[a], -w, w).astype(np.int8)
off = np.zeros(N + 1, dtype=np.uint32)
np.cumsum(np.bincount(a, minlength=N), out=off[1:])
E = len(b)

# --- Klassen, die die App braucht ---------------------------------------------------------
# 0 sonst | 1 Hoer-Neuron (Johnston-Organ) | 2 Fotorezeptor | 3 absteigend (DN) | 4 Motor
# 5 Pilzkoerper-Kenyonzelle | 6 Zentralkomplex | 7 Dopamin
cls = np.zeros(N, dtype=np.uint8)
sc = neu.super_class.fillna("").values; c = neu["class"].fillna("").values; sub = neu.sub_class.fillna("").values
cls[neu.nt_type.values == "DA"] = 7
cls[c == "CX"] = 6
cls[c == "Kenyon_Cell"] = 5
cls[sc == "motor"] = 4
cls[sc == "descending"] = 3
cls[sub == "photo_receptor"] = 2
cls[sub == "auditory"] = 1
side = neu.side.map({"left": 0, "right": 1}).fillna(2).values.astype(np.uint8)

# --- Layout: schematisches Frontal-Hirn, jede Region ein Fleck ---------------------------
# (FlyWire-Koordinaten liegen nicht in ../data; die Position kommt aus der Neuropil-Gruppe.)
REG = {  # Name: (x, y, rx, ry)  -- x fuer die rechte Seite, links gespiegelt; x=0 => Mitte
 "ME": (.80, .02, .13, .30), "LO": (.60, .00, .07, .22), "LOP": (.56, -.06, .05, .16), "AME": (.66, .20, .03, .03),
 "LA": (.94, .02, .04, .28), "OCG": (0, .46, .05, .03),
 "AL": (.10, -.20, .08, .08), "MB": (.17, .22, .09, .12), "LH": (.38, .26, .06, .07),
 "FB": (0, .16, .12, .05), "EB": (0, .08, .06, .04), "PB": (0, .30, .14, .025), "NO": (0, .01, .04, .03),
 "SMP": (.09, .34, .08, .06), "SIP": (.22, .34, .05, .05), "SLP": (.32, .36, .08, .06), "CRE": (.14, .10, .05, .05),
 "LAL": (.16, -.06, .07, .06), "AVLP": (.36, -.10, .08, .10), "PVLP": (.42, .06, .06, .08), "PLP": (.46, .14, .06, .08),
 "WED": (.32, -.20, .06, .06), "AOTU": (.30, .24, .04, .04), "VES": (.10, -.10, .05, .06), "SPS": (.16, -.22, .06, .05),
 "IPS": (.14, -.30, .06, .04), "GNG": (0, -.38, .16, .08), "SAD": (.08, -.28, .08, .04), "AMMC": (.22, -.28, .05, .04),
 "PRW": (0, -.28, .05, .04), "FLA": (.07, -.22, .03, .04), "CAN": (.05, -.16, .02, .03), "ICL": (.26, .12, .05, .07),
 "SCL": (.28, .20, .05, .06), "IB": (.06, .24, .05, .05), "ATL": (.10, .28, .04, .03), "GOR": (.12, -.02, .03, .04),
 "EPA": (.20, .02, .04, .04), "BU": (.12, .04, .02, .02), "GA": (.20, -.01, .02, .02),
}
def region(g):
    if not isinstance(g, str): return "GNG"
    for part in g.split("."):
        p = part.split("_")[0]
        if p in REG: return p
        if p.startswith("MB"): return "MB"
    return "SMP"
rng = np.random.default_rng(7)
pos = np.zeros((N, 2), dtype=np.float32)
regs = neu.group.map(region).values
for i in range(N):
    x, y, rx, ry = REG[regs[i]]
    r = np.sqrt(rng.random()); t = rng.random() * 6.2832
    dx, dy = r * np.cos(t) * rx, r * np.sin(t) * ry
    if x == 0: px = dx
    else:
        s = side[i] if side[i] < 2 else rng.integers(0, 2)
        px = (x + dx) * (1 if s == 1 else -1)
    pos[i] = (px, y + dy)

with open(os.path.join(HERE, "connectome.bin"), "wb") as f:
    f.write(off.tobytes()); f.write(b.tobytes()); f.write(w.tobytes())
with open(os.path.join(HERE, "neurons.bin"), "wb") as f:
    f.write(pos.tobytes()); f.write(cls.tobytes()); f.write(side.tobytes())
meta = {"N": int(N), "E": int(E), "source": "FlyWire v783 (Dorkenwald et al. 2024, Zenodo 10676866)",
        "classes": ["sonst", "Hoer-Neuron (JON)", "Fotorezeptor", "absteigend (DN)", "Motor", "Kenyonzelle", "Zentralkomplex", "Dopamin"],
        "counts": [int((cls == k).sum()) for k in range(8)], "inhibitory": int(inhib.sum())}
json.dump(meta, open(os.path.join(HERE, "meta.json"), "w"), indent=1)
print(meta)
