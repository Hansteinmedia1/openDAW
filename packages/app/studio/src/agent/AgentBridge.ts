import {asInstanceOf, byte, int, isInstanceOf, Nullable, panic, UUID} from "@opendaw/lib-std"
import {ppqn, PPQN, TimeBase} from "@opendaw/lib-dsp"
import {
    AudioFileBox,
    AudioRegionBox,
    AudioUnitBox,
    MarkerBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {DeviceBoxUtils, InstrumentFactories, TrackType} from "@opendaw/studio-adapters"
import {AudioContentFactory} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"

// Lets an automated participant (a headless browser in a live room) read the open project and add content to it
export namespace AgentBridge {
    export type NoteInfo = { position: ppqn, duration: ppqn, pitch: int, velocity: number }
    export type RegionInfo = {
        uuid: string, type: "audio" | "notes", label: string, position: ppqn, duration: ppqn
        loopOffset: ppqn, loopDuration: ppqn, mute: boolean
        file: Nullable<{ uuid: string, name: string }>, notes: Nullable<int>
    }
    export type TrackInfo = { uuid: string, type: "audio" | "notes", regions: ReadonlyArray<RegionInfo> }
    export type UnitInfo = {
        uuid: string, label: string, instrument: string, mute: boolean, tracks: ReadonlyArray<TrackInfo>
    }
    export type ProjectInfo = {
        name: string, bpm: number, signature: [int, int], pulsesPerQuarter: int
        units: ReadonlyArray<UnitInfo>, markers: ReadonlyArray<{ position: ppqn, label: string }>
    }
    export type AudioInfo = { sampleRate: number, numberOfFrames: int, pcm16: string }
    export type DrumSample = { note: byte, name: string, exclude: boolean, wav: string }
    export type DrumRegion = {
        position: ppqn, duration: ppqn, loopDuration: ppqn, label: string, notes: ReadonlyArray<NoteInfo>
    }
    export type DrumPlan = { label: string, samples: ReadonlyArray<DrumSample>, regions: ReadonlyArray<DrumRegion> }
    export type Api = {
        describe(): Nullable<ProjectInfo>
        audio(fileUuid: string, sampleRate: number): Promise<AudioInfo>
        addDrums(plan: DrumPlan): Promise<string>
        addAudio(name: string, wav: string, position: ppqn): Promise<string>
    }

    export const install = (service: StudioService): void => {
        window.openDAWAgent = {
            describe: () => service.hasProfile ? describe(service) : null,
            audio: (fileUuid, sampleRate) => audio(service, fileUuid, sampleRate),
            addDrums: plan => addDrums(service, plan),
            addAudio: (name, wav, position) => addAudio(service, name, wav, position)
        }
    }

    const describe = (service: StudioService): ProjectInfo => {
        const {project, profile} = service
        const {rootBox, timelineBox} = project
        const bpm = timelineBox.bpm.getValue()
        // Audio regions that are not stretched keep their lengths in seconds: report everything in pulses
        const toPulses = (box: AudioRegionBox | NoteRegionBox, value: number): ppqn =>
            isInstanceOf(box, AudioRegionBox) && box.timeBase.getValue() === TimeBase.Seconds
                ? value * bpm / 60.0 * PPQN.Quarter : value
        const describeRegion = (box: AudioRegionBox | NoteRegionBox): RegionInfo => ({
            uuid: UUID.toString(box.address.uuid),
            type: isInstanceOf(box, AudioRegionBox) ? "audio" : "notes",
            label: box.label.getValue(),
            position: box.position.getValue(), duration: toPulses(box, box.duration.getValue()),
            loopOffset: toPulses(box, box.loopOffset.getValue()),
            loopDuration: toPulses(box, box.loopDuration.getValue()),
            mute: box.mute.getValue(),
            file: isInstanceOf(box, AudioRegionBox)
                ? box.file.targetVertex.mapOr(({box: fileBox}) => ({
                    uuid: UUID.toString(fileBox.address.uuid),
                    name: asInstanceOf(fileBox, AudioFileBox).fileName.getValue()
                }), null)
                : null,
            notes: isInstanceOf(box, NoteRegionBox)
                ? box.events.targetVertex.mapOr(({box: collection}) =>
                    asInstanceOf(collection, NoteEventCollectionBox).events.pointerHub.incoming().length, 0)
                : null
        })
        const describeTrack = (trackBox: TrackBox): TrackInfo => ({
            uuid: UUID.toString(trackBox.address.uuid),
            type: trackBox.type.getValue() === TrackType.Audio ? "audio" : "notes",
            regions: trackBox.regions.pointerHub.incoming()
                .map(({box}) => box)
                .filter(box => isInstanceOf(box, AudioRegionBox) || isInstanceOf(box, NoteRegionBox))
                .map(describeRegion)
                .sort((regionA, regionB) => regionA.position - regionB.position)
        })
        const units = rootBox.audioUnits.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, AudioUnitBox))
            .filter(unit => unit.type.getValue() === AudioUnitType.Instrument)
            .sort((unitA, unitB) => unitA.index.getValue() - unitB.index.getValue())
            .map((unit): UnitInfo => {
                const input = unit.input.pointerHub.incoming().at(0)?.box
                return {
                    uuid: UUID.toString(unit.address.uuid),
                    label: DeviceBoxUtils.lookupLabelField(input).getValue(),
                    instrument: input?.name ?? "",
                    mute: unit.mute.getValue(),
                    tracks: unit.tracks.pointerHub.incoming()
                        .map(({box}) => asInstanceOf(box, TrackBox))
                        .filter(track => track.type.getValue() === TrackType.Audio
                            || track.type.getValue() === TrackType.Notes)
                        .sort((trackA, trackB) => trackA.index.getValue() - trackB.index.getValue())
                        .map(describeTrack)
                }
            })
        return {
            name: profile.meta.name,
            bpm,
            signature: [timelineBox.signature.nominator.getValue(), timelineBox.signature.denominator.getValue()],
            pulsesPerQuarter: PPQN.Quarter,
            units,
            markers: timelineBox.markerTrack.markers.pointerHub.incoming()
                .map(({box}) => asInstanceOf(box, MarkerBox))
                .map(box => ({position: box.position.getValue(), label: box.label.getValue()}))
                .sort((markerA, markerB) => markerA.position - markerB.position)
        }
    }

    // Mono, reduced to about the requested rate: enough for tempo and onset analysis outside the studio
    const audio = async (service: StudioService, fileUuid: string, sampleRate: number): Promise<AudioInfo> => {
        const data = await service.sampleManager.getAudioData(UUID.parse(fileUuid))
        const step = Math.max(1, Math.floor(data.sampleRate / sampleRate))
        const numberOfFrames = Math.floor(data.numberOfFrames / step)
        const pcm = new Int16Array(numberOfFrames)
        const scale = 1.0 / (step * data.numberOfChannels)
        for (let frame = 0; frame < numberOfFrames; frame++) {
            let sum = 0.0
            for (const channel of data.frames) {
                for (let offset = 0; offset < step; offset++) {sum += channel[frame * step + offset]}
            }
            pcm[frame] = Math.max(-32768, Math.min(32767, Math.round(sum * scale * 32767)))
        }
        return {sampleRate: data.sampleRate / step, numberOfFrames, pcm16: toBase64(new Uint8Array(pcm.buffer))}
    }

    const addDrums = async (service: StudioService, plan: DrumPlan): Promise<string> => {
        if (!service.hasProfile) {return panic("No project is open")}
        const {project, sampleService} = service
        const attachment: Array<InstrumentFactories.PlayfieldAttachment[number]> = []
        for (const {note, name, exclude, wav} of plan.samples) {
            const sample = await sampleService.importFile({name, arrayBuffer: fromBase64(wav)})
            attachment.push({note, name, exclude, uuid: UUID.parse(sample.uuid), durationInSeconds: sample.duration})
        }
        const {editing, api} = project
        return editing.modify(() => {
            const {audioUnitBox, trackBox} = api.createInstrument(InstrumentFactories.Playfield,
                {name: plan.label, attachment})
            plan.regions.forEach(({position, duration, loopDuration, label, notes}) => {
                const region = api.createNoteRegion({trackBox, position, duration, loopDuration, name: label})
                notes.forEach(note => api.createNoteEvent({owner: region, ...note}))
            })
            return UUID.toString(audioUnitBox.address.uuid)
        }).unwrap("Could not add drums")
    }

    const addAudio = async (service: StudioService, name: string, wav: string, position: ppqn): Promise<string> => {
        if (!service.hasProfile) {return panic("No project is open")}
        const {project, sampleService} = service
        const sample = await sampleService.importFile({name, arrayBuffer: fromBase64(wav)})
        const {editing, boxGraph, api} = project
        return editing.modify(() => {
            const {trackBox, instrumentBox} = api.createInstrument(InstrumentFactories.Tape)
            instrumentBox.label.setValue(name)
            const uuid = UUID.parse(sample.uuid)
            const audioFileBox = boxGraph.findBox<AudioFileBox>(uuid)
                .unwrapOrElse(() => AudioFileBox.create(boxGraph, uuid, box => {
                    box.fileName.setValue(name)
                    box.startInSeconds.setValue(0)
                    box.endInSeconds.setValue(sample.duration)
                }))
            const region = AudioContentFactory.createNotStretchedRegion({
                boxGraph, sample, audioFileBox, position, targetTrack: trackBox
            })
            return UUID.toString(region.address.uuid)
        }).unwrap("Could not add audio")
    }

    const toBase64 = (bytes: Uint8Array): string => {
        const chunks: Array<string> = []
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
        }
        return btoa(chunks.join(""))
    }

    const fromBase64 = (text: string): ArrayBuffer =>
        Uint8Array.from(atob(text), char => char.charCodeAt(0)).buffer
}

declare global {
    interface Window {
        openDAWAgent?: AgentBridge.Api
    }
}
