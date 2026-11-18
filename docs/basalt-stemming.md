# Stem-Trennung in Basalt (Neural Demux)

Stand der Funktion „Import → Neural Demux...“ in diesem Fork: Messung, bekannte Fehler, Modelle und Lizenzen.

## Messung vom 18.11.2026

Gemessen im echten Ablauf über die Oberfläche auf https://daw.hansteinmedia.com (Dashboard → Neural Demux → Datei →
Dialog → Separate), mit `Apps/DAW/agent/test/demux.mjs` aus dem Hauptrepo.

- Rechner: MacBook Pro M1 Pro, 16 GB, Chrome 157 ohne Fenster (headless), WebGPU über Metal, kein Ersatz-Adapter.
- Datei: Stereo-WAV, 44,1 kHz, 16 Bit, 3:41 min (220,8 s). Modell: htdemucs v4 (smank).

| Lauf | Modell | Modell laden | Trennen | Stems importieren | Gesamt |
|---|---|---|---|---|---|
| WebGPU, leerer Browser | Download 19,1 s | – | 84,4 s | 3,6 s | 107,4 s |
| WebGPU, Modell im Cache | – | 2,0 s | 85,3 s | 3,4 s | 91,0 s |
| WASM (CPU), Modell im Cache | – | 1,6 s | 104,6 s | 3,5 s | 110,0 s |

- **Download:** Die Modelldatei hat 304.321.552 Byte (290 MiB). Über die Leitung gingen 224,5 MiB, weil der Server sie
  unterwegs mit gzip verkleinert. Dauer 13 bis 19 s in drei Abrufen (hängt von der Leitung ab). Danach liegt das Modell im
  Browser-Speicher (OPFS) und wird nicht noch einmal angefragt.
- **Trennen:** WebGPU braucht rund 0,38 s je Sekunde Audio, WASM rund 0,47 s. WebGPU ist hier nur etwa 20 % schneller.
  onnxruntime meldet dazu, dass nicht alle Rechenschritte auf der Grafikkarte laufen.
- **Ergebnis:** In allen drei Läufen vier Spuren (drums, bass, other, vocals), jede 220,8 s lang und ab Position 0.
  Die Pegel der Stems sind in allen drei Läufen gleich (bass −23,8 dB, other −34,3 dB, drums −57,0 dB, vocals −61,6 dB RMS).
  Die Quelle liegt bei −22,4 dB und ist fast nur Bass (unter 150 Hz: −22,9 dB); die Verteilung passt also zum Material.

### Nicht gemessen

- Wie die Stems klingen. Die Messung prüft Dauer, Position und Pegel, kein Gehör.
- Ein Browser mit Fenster und andere Rechner. Auf Geräten ohne WebGPU oder mit wenig Speicher können die Zeiten deutlich
  abweichen.
- Das Abbrechen während Download und Trennung.

## Fehler aus der Messung und was daraus wurde

1. **Mono-Dateien scheiterten** mit „Neural demux failed.“ (`Got invalid dimensions for input: mix`): Das Modell erwartet
   zwei Kanäle. Behoben am 18.11.2026: Mono wird vor der Trennung auf zwei Kanäle verdoppelt, die Stems kommen wieder als
   Mono zurück. Geprüft mit einer Mono-WAV von 40 s, WebGPU und WASM: vier Spuren von 40 s.
2. **Das zweite Modell (jackjiangxinfa, Apache-2.0)** war nicht gehostet und endete mit „Model download failed.“ Es ist
   derselbe Demucs v4 in einem anderen ONNX-Export. Aus dem Dialog entfernt.
3. **Fehlermeldungen waren kurze Einblendungen.** Jetzt Dialoge, die Ursache und nächsten Schritt nennen.

## Oberfläche (seit 18.11.2026)

Die Funktion heißt „In Stems trennen“ (Menü Import, Spotlight, Dashboard); intern bleibt der Name `NeuralDemux`.
Die Spuren heißen Schlagzeug, Bass, Gesang und Rest, ihre Regionen tragen die Farbtöne Rost (346), Blau (204), Ocker (40)
und Türkis (176). Das Grau „Schiefer“ aus dem Designsystem gibt es nicht, weil Spurfarben hier nur ein Farbton sind.
Die Größenangabe des Modells im Code stand auf 250 MB und ist auf die echte Dateigröße korrigiert.

Konsolenmeldungen ohne Bezug zur Trennung: Abrufe der Preset- und WebCLAP-Listen von `assets.opendaw.studio` scheitern an
CORS (der Schalter `VITE_CLOUD_ASSETS=off` deckt bisher nur Samples und Soundfonts ab), der Nutzerzähler von
`api.opendaw.studio` wird blockiert, eine Datei liefert 404.

## Modelle und Lizenzen

| Modell | Quelle | Lizenz | Bei uns |
|---|---|---|---|
| htdemucs v4 | ONNX-Export `smank/htdemucs-onnx` (Hugging Face) | MIT | unter `/models/htdemucs/v4/model.onnx` |
| htdemucs v4, zweiter Export | jackjiangxinfa | Apache-2.0 | nicht gehostet, nicht mehr wählbar |

Demucs selbst (Meta Research, Hybrid Transformer Demucs v4) steht unter MIT. Die Adresse der Modelle kommt aus
`VITE_MODEL_BASE_URL`, die Prüfsummen stehen unverändert in `packages/lib/inference`.
