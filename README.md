# Fliegenhirn DJ

Das komplette Gehirn einer Fruchtfliege (139.255 Neuronen, 2,7 Mio. Verbindungen) läuft als Simulation im Browser und steht am DJ-Pult.

## Online (GitHub Pages)

Im Repo unter **Settings → Pages** als Quelle `Deploy from a branch`, Branch `main`, Ordner `/ (root)` wählen. Nach ein bis zwei Minuten ist die Seite unter `https://<name>.github.io/<repo>/` erreichbar.

Online läuft die Fliege mit drei eingebauten Demo-Tracks. Über „+ Songs" kann jeder eigene Dateien laden; sie bleiben im Browser und werden nirgends hochgeladen.

## Lokal mit eigenem Set-Plan

Der Ordner `lokal/` enthält den Planer (Analyse der Songs, geplante Übergänge, Hörprobe, Video-Export). Dafür die Dateien aus `lokal/` neben `index.html` legen, Songs in einen Nachbarordner, dann `start.bat` starten. Braucht Python mit `numpy` und `av`.

## Daten

Verdrahtung: FlyWire-Connectome v783 (Dorkenwald et al. 2024, Zenodo 10676866). Simulationsmodell nach Shiu et al. 2024, mit doppelter Hemmung und Spike-Ermüdung.

Es ist keine Musik enthalten.
