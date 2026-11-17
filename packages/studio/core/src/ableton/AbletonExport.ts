import {asDefined, asInstanceOf, isInstanceOf, Option, UUID} from "@opendaw/lib-std"
import {AudioData, dbToGain, PPQN, TimeBase, WavFile} from "@opendaw/lib-dsp"
import {
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioSignalsmithBox,
    AudioTimeStretchBox,
    AudioUnitBox,
    MarkerBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox,
    ValueEventCollectionBox,
    WarpMarkerBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {DeviceBoxUtils, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {AbletonLiveSetWriter} from "./AbletonLiveSetWriter"

export namespace AbletonExport {
    export type SampleSource = (uuid: UUID.Bytes) => Option<AudioData>
    export type File = { path: string, buffer: ArrayBuffer }
    export type Result = { files: ReadonlyArray<File>, warnings: ReadonlyArray<string> }

    // Writes "<name>.als" and its audio files below "Samples/Imported/", the layout of a Live project folder
    export const write = async (skeleton: ProjectSkeleton, name: string, samples: SampleSource): Promise<Result> => {
        const {boxGraph, mandatoryBoxes: {timelineBox, rootBox}} = skeleton
        const bpm = timelineBox.bpm.getValue()
        const warnings: Array<string> = []
        const files: Array<File> = []
        type Sample = { path: string, sampleRate: number, seconds: number }
        const samplePaths = UUID.newSet<{ uuid: UUID.Bytes, value: Option<Sample> }>(entry => entry.uuid)
        const resolveSample = (fileBox: AudioFileBox): Option<Sample> => {
            const uuid = fileBox.address.uuid
            const known = samplePaths.opt(uuid)
            if (known.nonEmpty()) {return known.unwrap().value}
            const resolved = samples(uuid).map(data => {
                const baseName = safeName(fileBox.fileName.getValue().replace(/\.[a-z0-9]{2,4}$/i, "")) || "Sample"
                const fileName = `${baseName}-${UUID.toString(uuid).slice(0, 8)}.wav`
                const path = `Samples/Imported/${fileName}`
                files.push({path, buffer: WavFile.encodeInts24(data)})
                return {path, sampleRate: data.sampleRate, seconds: data.numberOfFrames / data.sampleRate}
            })
            if (resolved.isEmpty()) {warnings.push(`${fileBox.fileName.getValue()}: audio data not loaded, its regions are skipped`)}
            samplePaths.add({uuid, value: resolved})
            return resolved
        }
        const toBeats = (pulses: number): number => pulses / PPQN.Quarter
        const writeNoteRegion = (region: NoteRegionBox): AbletonLiveSetWriter.NoteClip => {
            const collection = asInstanceOf(region.events.targetVertex.unwrap("No notes").box, NoteEventCollectionBox)
            return {
                type: "notes", name: region.label.getValue(),
                time: toBeats(region.position.getValue()), duration: toBeats(region.duration.getValue()),
                enabled: !region.mute.getValue(), playStart: toBeats(region.loopOffset.getValue()),
                loopEnd: toBeats(region.loopDuration.getValue()),
                notes: collection.events.pointerHub.incoming()
                    .map(({box}) => asInstanceOf(box, NoteEventBox))
                    .map(box => ({
                        time: toBeats(box.position.getValue()), duration: toBeats(box.duration.getValue()),
                        key: box.pitch.getValue(), velocity: box.velocity.getValue()
                    }))
            }
        }
        const writeAudioRegion = (region: AudioRegionBox): Option<AbletonLiveSetWriter.AudioClip> => {
            const fileBox = asInstanceOf(region.file.targetVertex.unwrap("No file").box, AudioFileBox)
            return resolveSample(fileBox).map(({path, sampleRate, seconds}) => {
                const inSeconds = region.timeBase.getValue() === TimeBase.Seconds
                const toRegionBeats = (value: number): number => inSeconds ? value * bpm / 60.0 : toBeats(value)
                const playMode = region.playMode.targetVertex.map(({box}) => box)
                const markers = playMode.mapOr(box => isInstanceOf(box, AudioPitchStretchBox)
                    || isInstanceOf(box, AudioTimeStretchBox) || isInstanceOf(box, AudioSignalsmithBox)
                    ? box.warpMarkers.pointerHub.incoming()
                        .map(({box: markerBox}) => asInstanceOf(markerBox, WarpMarkerBox))
                        .map(markerBox => ({seconds: markerBox.seconds.getValue(), beats: toBeats(markerBox.position.getValue())}))
                        .sort((markerA, markerB) => markerA.beats - markerB.beats)
                    : [], [])
                const warpMarkers = markers.length >= 2 ? markers : [{seconds: 0.0, beats: 0.0}, {seconds, beats: seconds * bpm / 60.0}]
                return {
                    type: "audio", name: region.label.getValue(),
                    time: toRegionBeats(region.position.getValue()), duration: toRegionBeats(region.duration.getValue()),
                    enabled: !region.mute.getValue(), playStart: toRegionBeats(region.loopOffset.getValue()),
                    loopEnd: toRegionBeats(region.loopDuration.getValue()),
                    relativePath: path, durationInSeconds: seconds, sampleRate, warpMarkers
                }
            })
        }
        const tracks: Array<AbletonLiveSetWriter.Track> = []
        rootBox.audioUnits.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, AudioUnitBox))
            .filter(unit => unit.type.getValue() === AudioUnitType.Instrument)
            .sort((unitA, unitB) => unitA.index.getValue() - unitB.index.getValue())
            .forEach(unit => {
                const label = DeviceBoxUtils.lookupLabelField(unit.input.pointerHub.incoming().at(0)?.box).getValue()
                const trackBoxes = unit.tracks.pointerHub.incoming()
                    .map(({box}) => asInstanceOf(box, TrackBox))
                    .filter(track => track.type.getValue() === TrackType.Notes || track.type.getValue() === TrackType.Audio)
                    .sort((trackA, trackB) => trackA.index.getValue() - trackB.index.getValue())
                trackBoxes.forEach((trackBox, index) => {
                    const regions = trackBox.regions.pointerHub.incoming().map(({box}) => box)
                    const isNotes = trackBox.type.getValue() === TrackType.Notes
                    tracks.push({
                        name: trackBoxes.length > 1 ? `${label} ${index + 1}` : label,
                        type: isNotes ? "notes" : "audio",
                        volume: dbToGain(unit.volume.getValue()), pan: unit.panning.getValue(), mute: unit.mute.getValue(),
                        clips: regions.flatMap((region): ReadonlyArray<AbletonLiveSetWriter.NoteClip | AbletonLiveSetWriter.AudioClip> =>
                            isInstanceOf(region, NoteRegionBox) ? [writeNoteRegion(region)]
                                : isInstanceOf(region, AudioRegionBox) ? writeAudioRegion(region).mapOr(clip => [clip], []) : [])
                            .sort((clipA, clipB) => clipA.time - clipB.time)
                    })
                })
            })
        const locators = timelineBox.markerTrack.markers.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, MarkerBox))
            .map(box => ({time: toBeats(box.position.getValue()), name: box.label.getValue()}))
            .sort((locatorA, locatorB) => locatorA.time - locatorB.time)
        const {tempoTrack} = timelineBox
        const tempoEvents = tempoTrack.events.targetVertex
            .mapOr(({box}) => asInstanceOf(box, ValueEventCollectionBox).events.pointerHub.incoming().length, 0)
        if (tempoTrack.enabled.getValue() && tempoEvents > 0) {
            warnings.push("Tempo automation is not exported, the set uses the project tempo")
        }
        const xml = AbletonLiveSetWriter.write({
            bpm, numerator: timelineBox.signature.nominator.getValue(), denominator: timelineBox.signature.denominator.getValue(),
            locators, tracks
        })
        const als = await new Response(asDefined(new Response(xml).body).pipeThrough(new CompressionStream("gzip"))).arrayBuffer()
        return {files: [{path: `${safeName(name) || "openDAW"}.als`, buffer: als}, ...files], warnings}
    }

    const safeName = (name: string): string => name.replace(/[\\/:*?"<>|]/g, "-").trim()
}
