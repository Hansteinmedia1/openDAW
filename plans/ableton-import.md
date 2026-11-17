# Ableton Live Set import and export (and DAWproject markers)

> **Status:** implemented on branch `ableton-import`, all core tests pass (1146), not yet proposed upstream.

## Goal

Exchange songs with Ableton Live in both directions: open a Live set (`.als`) in openDAW with tracks, arrangement
clips, MIDI notes, audio files and locators, and export an openDAW project as a Live set. Ableton neither reads nor
writes DAWproject, so today the only route is rebuilding a song by hand.

## Split into three pull requests

1. **DAWproject markers** (small, independent):
   - `MarkersSchema` declared its children as a wrapper element (`@Xml.Element("Marker", Array)`), so
     `<Markers><Marker/>…</Markers>` never parsed. Now `@Xml.ElementRef(MarkerSchema)`; `ArrangementSchema.markers`
     is typed `MarkersSchema`.
   - `DawProjectImporter` creates a `MarkerBox` per marker on the timeline's marker track (time in beats, name,
     colour hue; unnamed markers become "Marker n").
   - `DawProjectExporter` writes the marker track back (`writeMarkers`).
   - Tests: import, export and re-parse round trip (`DawProjectImporter.test.ts`).
2. **Ableton import** (`packages/studio/core/src/ableton/`, menu *Import → Ableton Live Set...*, spotlight entry):
   - `AbletonLiveSet`: gunzip with `DecompressionStream`, parse with `DOMParser` into a small model.
   - `AbletonImport`: model → DAWproject schema, serialised and re-parsed, then the existing `DawProjectImport.read`.
     No second importer: everything the DAWproject path supports (and fixes) applies to Live sets too.
   - `AbletonService`: picks the `.als`, asks for the project folder (`<input webkitdirectory>`, works in Chrome,
     Firefox and Safari) only if the set plays audio, resolves samples by Live's project-relative path, falls back
     to a unique file name, imports them through `SampleService`, shows grouped notes.

3. **Ableton export** (menu *Export → Ableton Live Set...*, spotlight entry):
   - `AbletonExport` reads the skeleton directly (not via the DAWproject exporter, which drops region offsets and
     mute): instrument units → one Live track per note/audio track, regions → arrangement clips with offset, loop and
     every warp marker of the play mode, note events, volume, pan, mute, markers → locators, tempo and signature.
   - `AbletonLiveSetWriter` generates the XML from scratch (no Ableton template). It writes only what Live 12 needs:
     verified element by element against Live 12.4.16, which names the reason when it rejects a set
     (e.g. "Slot count mismatch": every `ClipSlotList`, also the `FreezeSequencer`'s, needs one slot per scene).
   - `AbletonService.exportLiveSet` saves `<name> Project.zip` = a Live project folder with `<name>.als` and
     `Samples/Imported/*.wav` (24-bit, referenced relative to the set). The set opens in Arrangement view.
   - Not exported (noted in a dialog): devices/plugins, automation including tempo automation, groups, sends.

## Mapping

| Live | openDAW |
|---|---|
| `MasterTrack`/`MainTrack` tempo and signature (`(exp × 99) + numerator − 1`) | timeline bpm and signature |
| `Locators` | marker track |
| `AudioTrack`, `MidiTrack` (set order), volume, pan, speaker off, muted group | audio units (Tape, Vaporisateur), volume, panning, mute |
| `MidiClip` in `ClipTimeable/ArrangerAutomation` with `KeyTracks` | note region, notes moved by the loop start so the loop begins at content zero |
| `AudioClip` in `Sample/ArrangerAutomation`, unwarped (loop values in seconds) | audio region at its natural speed |
| `AudioClip`, warped (loop values in beats) | audio region, warp markers approximated linearly first → last |
| `SampleRef/DefaultDuration` / `DefaultSampleRate` | file length without decoding |

Not imported, reported in the notes dialog: devices and plugins, automation, return and group tracks, session
clips, tempo automation, clip transposition, loops that do not start at the file start, video files, files
outside the selected folder. Non-linear warping is reported with its largest deviation in beats.

## Verification

- Export: `AbletonExport.test.ts` (well-formed XML with escaping, full round trip Live → openDAW → Live).
- Round trip of the four band sets: tempo, signature, all tracks and locators identical; audio clips identical
  (0.0000 beats deviation); of >5000 audible MIDI notes a handful move by ~1/1000 beat (openDAW's 960 PPQN grid),
  which can add or drop a note at a loop boundary. All four exported sets open in Live 12.4.16 without errors or
  missing media; the studio's own export of "What a Life" opens with clips, waveforms, volumes and locators.
- Unit tests: `AbletonImport.test.ts` (parser and full import into a skeleton), DAWproject marker tests.
- Real sets (Live 11.3 and 12.0, 16–23 tracks, up to 420 clips): every clip with an available file arrives,
  all locators become markers, ~1–4 s per set in the test runner.
- Studio: imported "What a Life" (126 BPM, 23 tracks) through the menu with its project folder; regions,
  waveforms, mutes and markers arrive as in the set.

## How it was made

Written with Claude Code (Anthropic); the contributor reviews every line before submitting. Ableton's format is undocumented; the mapping was
derived from real sets saved by Live 11.3 and 12.0 and checked against Live 12.4.16 (Trial), which opened every
set used here. The code follows `CLAUDE.md` (lib-std types, `Promises.tryCatch`, no `try/catch`, minimal comments).
