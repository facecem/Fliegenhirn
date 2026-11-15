# Fliegenhirn — Recherche

Ziel: Ein neuronales Netz auf Basis eines **echten Fliegen-Connectomes** (Drosophila melanogaster),
analog zum bestehenden C.-elegans-Wurmhirn-Projekt (302 Neuronen), nur größer.

## Verfügbare echte Connectome-Datensätze

| Datensatz | Neuronen | Synapsen | Jahr | Sim im Browser? |
|---|---|---|---|---|
| **Larven-Gehirn** (Winding et al., Science) | **3.016** | ~548.000 | 2023 | ✅ machbar |
| **Adult FlyWire** (Murthy/Seung, Nature) | **139.255** | >50 Mio. | 2024 | ⚠️ nur aggregiert |

Vergleich: C. elegans = 302 Neuronen.

## Empfehlung
Larven-Connectome (3.016 Neuronen). Vollständig, synaptische Auflösung, enthält
echte Lernzentren (Pilzkörper / mushroom bodies) → assoziatives Lernen möglich.

## Quellen
- Larve: Winding, Pedigo et al., "The connectome of an insect brain", Science 379, eadd9330 (2023)
  https://www.science.org/doi/10.1126/science.add9330
- Adult: FlyWire Consortium, Nature 2024; Codex: https://codex.flywire.ai
  https://www.nature.com/articles/s41586-024-07686-5
- Wikipedia Überblick: https://en.wikipedia.org/wiki/Drosophila_connectome

## Geladene Daten (in data/, FlyWire v783, Zenodo 10676866)
Quelle: https://storage.googleapis.com/flywire-data/codex/data/fafb/783/
- **neurons.csv.gz** — 139.255 Neuronen; Spalten: root_id, group, nt_type (Transmitter:
  GABA/ACH/GLUT/DA/SER/OCT), *_avg-Scores
- **connections.csv.gz** — 3.869.878 Kanten; Spalten: pre_root_id, post_root_id,
  neuropil (Hirnregion), syn_count, nt_type
- **classification.csv.gz** — 139.255; Spalten: root_id, flow, super_class, class,
  sub_class, hemilineage, side (L/R), nerve  → Basis fürs Aggregieren
- **cell_stats.csv.gz** — 139.246; Spalten: root_id, length_nm, area_nm, size_nm

Aggregieren auf Hirnregionen: über `neuropil` (in connections) bzw. `super_class`/`class`
(in classification). Kommt in der Python-Datei.

## Offene Fragen (vor dem Bauen zu klären)
- [ ] Larve (3.016) oder Adult (aggregiert)?
- [ ] Nur Visualisierung/Simulation des Netzes, oder soll es etwas "steuern"
      (z.B. Strichmännchen/Agent wie beim Wurm)?
- [ ] Reine Web-App (HTML, eine Datei) wie die anderen Projekte?
