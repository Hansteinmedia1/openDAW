import {describe, expect, it} from "vitest"
import {gunzipSync} from "node:zlib"
import {Option} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {DawProjectImport} from "../dawproject/DawProjectImporter"
import {AbletonLiveSet} from "./AbletonLiveSet"
import {AbletonImport} from "./AbletonImport"
import {AbletonExport} from "./AbletonExport"
import {AbletonLiveSetWriter} from "./AbletonLiveSetWriter"

const liveSetXml = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton Creator="Ableton Live 12.0"><LiveSet>
<Tracks>
  <MidiTrack Id="1"><Name><EffectiveName Value="Keys &amp; Pads"/></Name><TrackGroupId Value="-1"/>
    <DeviceChain><Mixer><Volume><Manual Value="0.5"/></Volume><Pan><Manual Value="-0.5"/></Pan><Speaker><Manual Value="true"/></Speaker></Mixer>
    <MainSequencer><ClipTimeable><ArrangerAutomation><Events>
      <MidiClip Id="0" Time="8"><CurrentStart Value="8"/><CurrentEnd Value="16"/>
        <Loop><LoopStart Value="0"/><LoopEnd Value="4"/><StartRelative Value="1"/><LoopOn Value="true"/></Loop>
        <Name Value="Riff"/><Disabled Value="false"/>
        <Notes><KeyTracks><KeyTrack Id="0"><Notes>
          <MidiNoteEvent Time="0" Duration="1" Velocity="127" IsEnabled="true"/>
          <MidiNoteEvent Time="2" Duration="0.5" Velocity="64" IsEnabled="true"/>
        </Notes><MidiKey Value="60"/></KeyTrack></KeyTracks></Notes>
      </MidiClip>
    </Events></ArrangerAutomation></ClipTimeable></MainSequencer></DeviceChain></MidiTrack>
  <AudioTrack Id="2"><Name><EffectiveName Value="Guitar"/></Name><TrackGroupId Value="-1"/>
    <DeviceChain><Mixer><Speaker><Manual Value="false"/></Speaker></Mixer>
    <MainSequencer><Sample><ArrangerAutomation><Events>
      <AudioClip Id="0" Time="4"><CurrentStart Value="4"/><CurrentEnd Value="10"/>
        <Loop><LoopStart Value="1"/><LoopEnd Value="7"/><StartRelative Value="0"/><LoopOn Value="false"/></Loop>
        <Name Value="Take"/><Disabled Value="false"/><IsWarped Value="true"/>
        <SampleRef><FileRef><RelativePath Value="Samples/Take.wav"/></FileRef>
          <DefaultDuration Value="480000"/><DefaultSampleRate Value="48000"/></SampleRef>
        <WarpMarkers><WarpMarker Id="0" SecTime="0" BeatTime="0"/><WarpMarker Id="1" SecTime="10" BeatTime="20"/></WarpMarkers>
      </AudioClip>
    </Events></ArrangerAutomation></Sample></MainSequencer></DeviceChain></AudioTrack>
</Tracks>
<MainTrack><DeviceChain><Mixer><Tempo><Manual Value="120"/></Tempo><TimeSignature><Manual Value="201"/></TimeSignature></Mixer></DeviceChain></MainTrack>
<Locators><Locators><Locator Id="0"><Time Value="0"/><Name Value="Intro"/></Locator><Locator Id="1"><Time Value="8"/><Name Value="Chorus"/></Locator></Locators></Locators>
</LiveSet></Ableton>`

describe("AbletonLiveSetWriter", () => {
    it("writes well-formed XML with escaped names", () => {
        const xml = AbletonLiveSetWriter.write({bpm: 90, numerator: 3, denominator: 4, locators: [{time: 4, name: "A & <B>"}],
            tracks: [{name: "\"Lead\"", type: "notes", volume: 1, pan: 0, mute: false, clips: []}]})
        const document = new DOMParser().parseFromString(xml, "application/xml")
        expect(document.getElementsByTagName("parsererror").length).toBe(0)
        expect(document.querySelector("Locator > Name")?.getAttribute("Value")).toBe("A & <B>")
        expect(document.querySelector("TimeSignature > Manual")?.getAttribute("Value")).toBe("200")
        expect(document.querySelectorAll("MidiTrack ClipSlotList").length).toBe(2)
    })
})

describe("AbletonExport", () => {
    it("round-trips tracks, clips, notes, audio, mixer and locators through openDAW", async () => {
        const original = AbletonLiveSet.parse(liveSetXml)
        const {project, resources} = await AbletonImport.toDawProject(original, async () => Option.wrap(new ArrayBuffer(8)))
        const {skeleton} = await DawProjectImport.read(project, resources)
        const audio = AudioData.create(48000, 480000, 2)
        const {files, warnings} = await AbletonExport.write(skeleton, "Song: 1", () => Option.wrap(audio))
        expect(warnings).toEqual([])
        expect(files.map(({path}) => path.replace(/-[0-9a-f]{8}\.wav$/, ".wav"))).toEqual(["Song- 1.als", "Samples/Imported/Take.wav"])
        const exported = AbletonLiveSet.parse(gunzipSync(new Uint8Array(files[0].buffer)).toString("utf8"))
        expect([exported.bpm, exported.numerator, exported.denominator]).toEqual([120, 4, 4])
        expect(exported.locators).toEqual(original.locators)
        const [keys, guitar] = exported.tracks
        expect([keys.name, keys.type, keys.mute, guitar.name, guitar.type, guitar.mute]).toEqual(["Keys & Pads", "notes", false, "Guitar", "audio", true])
        expect(keys.volume).toBeCloseTo(0.5, 5)
        expect(keys.pan).toBeCloseTo(-0.5, 5)
        const riff = keys.clips[0] as AbletonLiveSet.NoteClip
        expect([riff.time, riff.duration, riff.playStart, riff.loopEnd]).toEqual([8, 8, 1, 4])
        expect(riff.notes.map(({time, key}) => [time, key])).toEqual([[0, 60], [2, 60]])
        const take = guitar.clips[0] as AbletonLiveSet.AudioClip
        expect([take.time, take.duration, take.playStart, take.sample.durationInSeconds]).toEqual([4, 6, 1, 10])
        expect(take.sample.relativePath).toMatch(/^Samples\/Imported\/Take-[0-9a-f]{8}\.wav$/)
        expect(take.beatsPerSecond).toBeCloseTo(2, 5)
    })
})
