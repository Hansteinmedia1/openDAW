import {describe, expect, it} from "vitest"
import {Option} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {AudioRegionBox, AudioUnitBox, MarkerBox, NoteEventBox, NoteRegionBox} from "@opendaw/studio-boxes"
import {DawProjectImport} from "../dawproject/DawProjectImporter"
import {AbletonLiveSet} from "./AbletonLiveSet"
import {AbletonImport} from "./AbletonImport"

// A Live 11 set in 3/4 at 90 BPM: two locators, a looped MIDI clip, an unwarped audio clip on a track in a muted group
const liveSetXml = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton Creator="Ableton Live 11.3.21"><LiveSet>
<Tracks>
  <GroupTrack Id="9"><Name><EffectiveName Value="Group"/></Name><TrackGroupId Value="-1"/>
    <DeviceChain><Mixer><Speaker><Manual Value="false"/></Speaker></Mixer></DeviceChain></GroupTrack>
  <MidiTrack Id="1"><Name><EffectiveName Value="Keys"/></Name><TrackGroupId Value="-1"/>
    <DeviceChain><Mixer><Volume><Manual Value="0.5"/></Volume><Pan><Manual Value="-1"/></Pan><Speaker><Manual Value="true"/></Speaker></Mixer>
    <MainSequencer><ClipTimeable><ArrangerAutomation><Events>
      <MidiClip Id="0" Time="8"><CurrentStart Value="8"/><CurrentEnd Value="16"/>
        <Loop><LoopStart Value="2"/><LoopEnd Value="6"/><StartRelative Value="0"/><LoopOn Value="true"/></Loop>
        <Name Value="Riff"/><Disabled Value="false"/>
        <Notes><KeyTracks><KeyTrack Id="0"><Notes>
          <MidiNoteEvent Time="2" Duration="1" Velocity="127" IsEnabled="true"/>
          <MidiNoteEvent Time="3" Duration="1" Velocity="64" IsEnabled="false"/>
          <MidiNoteEvent Time="5" Duration="0.5" Velocity="100" IsEnabled="true"/>
          <MidiNoteEvent Time="0" Duration="1" Velocity="100" IsEnabled="true"/>
        </Notes><MidiKey Value="60"/></KeyTrack></KeyTracks></Notes>
      </MidiClip>
    </Events></ArrangerAutomation></ClipTimeable></MainSequencer></DeviceChain></MidiTrack>
  <AudioTrack Id="2"><Name><EffectiveName Value="Guitar"/></Name><TrackGroupId Value="9"/>
    <DeviceChain><Mixer><Speaker><Manual Value="true"/></Speaker></Mixer>
    <MainSequencer><Sample><ArrangerAutomation><Events>
      <AudioClip Id="0" Time="0"><CurrentStart Value="0"/><CurrentEnd Value="3"/>
        <Loop><LoopStart Value="1"/><LoopEnd Value="5"/><StartRelative Value="0"/><LoopOn Value="false"/></Loop>
        <Name Value="Take"/><Disabled Value="false"/><IsWarped Value="false"/>
        <SampleRef><FileRef><RelativePath Value="Samples/Recorded/Take.wav"/><Path Value="/Users/someone/Take.wav"/></FileRef>
          <DefaultDuration Value="480000"/><DefaultSampleRate Value="48000"/></SampleRef>
      </AudioClip>
      <AudioClip Id="1" Time="4"><CurrentStart Value="4"/><CurrentEnd Value="6"/>
        <Loop><LoopStart Value="0"/><LoopEnd Value="2"/><StartRelative Value="0"/><LoopOn Value="false"/></Loop>
        <Name Value="Missing"/><Disabled Value="false"/><IsWarped Value="false"/>
        <SampleRef><FileRef><RelativePath Value="../Elsewhere/Missing.wav"/><Path Value="/Users/someone/Missing.wav"/></FileRef>
          <DefaultDuration Value="96000"/><DefaultSampleRate Value="48000"/></SampleRef>
      </AudioClip>
    </Events></ArrangerAutomation></Sample></MainSequencer></DeviceChain></AudioTrack>
</Tracks>
<MasterTrack><DeviceChain><Mixer><Tempo><Manual Value="90"/></Tempo><TimeSignature><Manual Value="200"/></TimeSignature></Mixer></DeviceChain></MasterTrack>
<Locators><Locators><Locator Id="1"><Time Value="12"/><Name Value="Chorus"/></Locator><Locator Id="0"><Time Value="0"/><Name Value="Intro"/></Locator></Locators></Locators>
</LiveSet></Ableton>`

describe("AbletonLiveSet", () => {
    const liveSet = AbletonLiveSet.parse(liveSetXml)

    it("reads tempo, signature and sorted locators", () => {
        expect([liveSet.bpm, liveSet.numerator, liveSet.denominator]).toEqual([90, 3, 4])
        expect(liveSet.locators).toEqual([{time: 0, name: "Intro"}, {time: 12, name: "Chorus"}])
    })

    it("moves looped notes to content zero and drops disabled notes", () => {
        const [keys] = liveSet.tracks
        expect([keys.type, keys.volume, keys.pan, keys.mute]).toEqual(["notes", 0.5, -1, false])
        const clip = keys.clips[0] as AbletonLiveSet.NoteClip
        expect([clip.time, clip.duration, clip.playStart, clip.loopEnd]).toEqual([8, 8, 0, 4])
        expect(clip.notes.map(({time, key, velocity}) => [time, key, velocity])).toEqual([[0, 60, 1], [3, 60, 100 / 127]])
    })

    it("converts unwarped audio clips to beats and mutes tracks of muted groups", () => {
        const guitar = liveSet.tracks[1]
        expect(guitar.mute).toBe(true)
        const clip = guitar.clips[0] as AbletonLiveSet.AudioClip
        expect([clip.playStart, clip.beatsPerSecond, clip.sample.durationInSeconds, clip.sample.fileName])
            .toEqual([1.5, 1.5, 10, "Take.wav"])
    })
})

describe("AbletonImport", () => {
    it("imports tracks, clips, notes, audio and markers into an openDAW project", async () => {
        const liveSet = AbletonLiveSet.parse(liveSetXml)
        const {project, resources, warnings} = await AbletonImport.toDawProject(liveSet, async sample =>
            sample.fileName === "Take.wav" ? Option.wrap(new Uint8Array([1, 2, 3, 4]).buffer) : Option.None)
        expect(warnings).toEqual(["Missing.wav: audio file not found, its clips are skipped"])
        const {skeleton, audioIds} = await DawProjectImport.read(project, resources)
        const boxes = skeleton.boxGraph.boxes()
        const count = (name: string) => boxes.filter(box => box.name === name).length
        expect(count(AudioUnitBox.name)).toBe(3)
        expect(count(NoteRegionBox.name)).toBe(1)
        expect(count(NoteEventBox.name)).toBe(2)
        expect(count(AudioRegionBox.name)).toBe(1)
        expect(audioIds.length).toBe(1)
        const {timelineBox} = skeleton.mandatoryBoxes
        expect(timelineBox.bpm.getValue()).toBe(90)
        expect([timelineBox.signature.nominator.getValue(), timelineBox.signature.denominator.getValue()]).toEqual([3, 4])
        const markers = timelineBox.markerTrack.markers.pointerHub.incoming()
            .map(({box}) => box as MarkerBox)
            .map(box => [box.position.getValue(), box.label.getValue()])
            .sort(([positionA], [positionB]) => Number(positionA) - Number(positionB))
        expect(markers).toEqual([[0, "Intro"], [12 * PPQN.Quarter, "Chorus"]])
        const region = boxes.find((box): box is AudioRegionBox => box instanceof AudioRegionBox)
        expect(region?.loopOffset.getValue()).toBe(1.5 * PPQN.Quarter)
    })
})
