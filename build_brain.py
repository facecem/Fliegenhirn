"""
build_brain.py — reduziert den adulten FlyWire-Connectome (139k Neuronen, 3,87 Mio.
Verbindungen) auf einen spielbaren Region-Graphen und exportiert brain.json.

Idee: Jede Hirnregion (neuropil) wird ein "Kanal". Wir bauen einen gerichteten,
gewichteten Region->Region-Graphen mit Vorzeichen (erregend/hemmend, aus dem
Neurotransmitter der Prä-Neuronen). Die Web-App simuliert diesen reduzierten Graphen
im Takt und übersetzt Region-Aktivität in Sounds.

Ausgabe: brain.json  { meta, nodes[], edges[] }
"""
import json
import pandas as pd

DATA = "data"
TOP_REGIONS = 48          # so viele Regionen behalten wir (nach Gesamt-Synapsen)
MERGE_SIDES = True        # _L / _R zu einer Region zusammenfassen

# Neurotransmitter -> Vorzeichen/Gewicht der Wirkung (Drosophila-typisch)
NT_SIGN = {
    "ACH":  1.0,   # Acetylcholin  -> erregend
    "GABA": -1.0,  # GABA          -> hemmend
    "GLUT": -1.0,  # Glutamat      -> in der Fliege meist hemmend (GluCl)
    "DA":   0.3,   # Dopamin       -> modulatorisch (schwach +)
    "SER":  0.3,   # Serotonin     -> modulatorisch
    "OCT":  0.3,   # Octopamin     -> modulatorisch
}

# Regions-Präfix -> (System, Klartextname). Bestimmt Gruppierung + Funktions-Tags.
SYSTEMS = [
    ("ME",   "optic",           "Medulla"),
    ("LOP",  "optic",           "Lobula-Platte"),
    ("LO",   "optic",           "Lobula"),
    ("AME",  "optic",           "Akzessor. Medulla"),
    ("LA",   "optic",           "Lamina"),
    ("AL",   "olfactory",       "Antennallobus (Riechen)"),
    ("CA",   "mushroom_body",   "Calyx (Pilzkörper)"),
    ("PED",  "mushroom_body",   "Pedunculus (Pilzkörper)"),
    ("MB",   "mushroom_body",   "Pilzkörper-Lobus"),
    ("FB",   "central_complex", "Fan-shaped Body"),
    ("EB",   "central_complex", "Ellipsoid Body"),
    ("PB",   "central_complex", "Protocerebral Bridge"),
    ("NO",   "central_complex", "Noduli"),
    ("LAL",  "central_complex", "Lateraler Akzessorlobus"),
    ("BU",   "central_complex", "Bulbus"),
    ("LH",   "lateral_horn",    "Lateral Horn"),
    ("AOTU", "visual_central",  "Ant.-opt. Tuberkel"),
    ("AVLP", "ventrolateral",   "Ant.-vent. lat. Protocerebrum"),
    ("PVLP", "ventrolateral",   "Post.-vent. lat. Protocerebrum"),
    ("PLP",  "ventrolateral",   "Post.-lat. Protocerebrum"),
    ("WED",  "ventrolateral",   "Wedge"),
    ("SLP",  "superior",        "Sup.-lat. Protocerebrum"),
    ("SIP",  "superior",        "Sup.-interm. Protocerebrum"),
    ("SMP",  "superior",        "Sup.-med. Protocerebrum"),
    ("CRE",  "central",         "Crepine"),
    ("SCL",  "central",         "Superior clamp"),
    ("ICL",  "central",         "Inferior clamp"),
    ("IB",   "central",         "Inferior bridge"),
    ("ATL",  "central",         "Antler"),
    ("VES",  "central",         "Vest"),
    ("EPA",  "central",         "Epaulette"),
    ("GOR",  "central",         "Gorget"),
    ("SPS",  "central",         "Sup. post. slope"),
    ("IPS",  "central",         "Inf. post. slope"),
    ("GNG",  "motor_gustatory", "Gnathalganglion (Mund)"),
    ("SAD",  "motor_gustatory", "Saddle"),
    ("PRW",  "motor_gustatory", "Prow"),
    ("FLA",  "motor_gustatory", "Flange"),
    ("GA",   "central_complex", "Gall"),
]


def region_of(neuropil: str):
    """neuropil-String -> (base_id, system, klartext). None wenn nicht zuordenbar."""
    if not isinstance(neuropil, str) or neuropil in ("", "None", "UNASGN"):
        return None
    base = neuropil
    if MERGE_SIDES and (base.endswith("_L") or base.endswith("_R")):
        base = base[:-2]
    # längste Präfixe zuerst, damit z.B. LAL nicht als LA (Lamina) verkannt wird
    for prefix, system, name in sorted(SYSTEMS, key=lambda s: -len(s[0])):
        if base == prefix or base.startswith(prefix):
            return base, system, name
    return base, "other", base


def main():
    print("Lade connections ...")
    con = pd.read_csv(
        f"{DATA}/connections.csv.gz",
        usecols=["pre_root_id", "post_root_id", "neuropil", "syn_count", "nt_type"],
    )
    print(f"  {len(con):,} Kanten")

    # 1) Home-Region jedes Neurons = neuropil, in dem es die meisten INPUT-Synapsen hat
    print("Bestimme Home-Region je Neuron ...")
    home_tbl = (
        con.groupby(["post_root_id", "neuropil"])["syn_count"].sum().reset_index()
    )
    home_tbl = home_tbl.sort_values("syn_count").drop_duplicates(
        "post_root_id", keep="last"
    )
    home = dict(zip(home_tbl["post_root_id"], home_tbl["neuropil"]))
    # Fallback für Neuronen, die nur als Prä auftauchen: über ihre Output-neuropils
    pre_only = set(con["pre_root_id"]) - set(home)
    if pre_only:
        ht2 = (
            con[con["pre_root_id"].isin(pre_only)]
            .groupby(["pre_root_id", "neuropil"])["syn_count"].sum().reset_index()
            .sort_values("syn_count").drop_duplicates("pre_root_id", keep="last")
        )
        home.update(dict(zip(ht2["pre_root_id"], ht2["neuropil"])))

    # 2) Kanten auf Home-Regionen abbilden
    print("Aggregiere Region -> Region ...")
    con["src"] = con["pre_root_id"].map(home)
    con["dst"] = con["post_root_id"].map(home)
    con = con.dropna(subset=["src", "dst"])

    def base_region(np_):
        r = region_of(np_)
        return r[0] if r else None

    con["src_reg"] = con["src"].map(base_region)
    con["dst_reg"] = con["dst"].map(base_region)
    con = con.dropna(subset=["src_reg", "dst_reg"])
    con["sign"] = con["nt_type"].map(NT_SIGN).fillna(0.3)
    con["signed"] = con["syn_count"] * con["sign"]

    # 3) Top-Regionen nach Gesamt-Synapsen (rein + raus)
    tot = (
        con.groupby("src_reg")["syn_count"].sum()
        .add(con.groupby("dst_reg")["syn_count"].sum(), fill_value=0)
        .sort_values(ascending=False)
    )
    keep = list(tot.head(TOP_REGIONS).index)
    keepset = set(keep)
    sub = con[con["src_reg"].isin(keepset) & con["dst_reg"].isin(keepset)]

    # 4) Kanten-Aggregation
    edges_df = (
        sub.groupby(["src_reg", "dst_reg"])
        .agg(syn=("syn_count", "sum"), signed=("signed", "sum"))
        .reset_index()
    )
    # schwache Kanten weglassen (Rauschen)
    thresh = edges_df["syn"].quantile(0.35)
    edges_df = edges_df[edges_df["syn"] >= thresh]

    # 5) Knoten-Metadaten
    print("Baue Knoten ...")
    cls = pd.read_csv(f"{DATA}/classification.csv.gz",
                      usecols=["root_id", "super_class"])
    sc = dict(zip(cls["root_id"], cls["super_class"]))
    neur = pd.read_csv(f"{DATA}/neurons.csv.gz", usecols=["root_id", "nt_type"])
    ntmap = dict(zip(neur["root_id"], neur["nt_type"]))

    # Neuronen je Region (über Home-Region)
    home_reg = {nid: base_region(np_) for nid, np_ in home.items()}
    reg_neurons = {}
    for nid, reg in home_reg.items():
        if reg in keepset:
            reg_neurons.setdefault(reg, []).append(nid)

    nodes = []
    for reg in keep:
        _, system, name = region_of(reg) or (reg, "other", reg)
        ns = reg_neurons.get(reg, [])
        # erregend/hemmend-Balance der ausgehenden Kanten
        out = sub[sub["src_reg"] == reg]
        exc = out.loc[out["sign"] > 0, "syn_count"].sum()
        inh = out.loc[out["sign"] < 0, "syn_count"].sum()
        total = exc + inh
        nodes.append({
            "id": reg,
            "name": name,
            "system": system,
            "neurons": len(ns),
            "exc_frac": round(float(exc / total), 3) if total else 0.5,
        })

    edges = [{
        "s": r.src_reg, "t": r.dst_reg,
        "w": int(r.syn),
        "sign": 1 if r.signed >= 0 else -1,
    } for r in edges_df.itertuples()]

    meta = {
        "source": "FlyWire FAFB v783 (Zenodo 10676866)",
        "regions": len(nodes),
        "edges": len(edges),
        "merged_sides": MERGE_SIDES,
        "neurons_total": 139255,
    }
    out = {"meta": meta, "nodes": nodes, "edges": edges}
    with open("brain.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    print(f"\nOK -> brain.json  ({len(nodes)} Regionen, {len(edges)} Kanten)")
    print("Systeme:", sorted({n['system'] for n in nodes}))
    for n in nodes[:12]:
        print(f"  {n['id']:6s} {n['name']:28s} sys={n['system']:16s} "
              f"neuronen={n['neurons']:6d} exc={n['exc_frac']}")


if __name__ == "__main__":
    main()
