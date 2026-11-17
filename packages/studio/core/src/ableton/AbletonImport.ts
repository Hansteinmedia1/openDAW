import {isDefined, Option, panic, UUID} from "@opendaw/lib-std"
import {Xml} from "@opendaw/lib-xml"
import {
    ApplicationSchema,
    ArrangementSchema,
    AudioSchema,
    ChannelRole,
    ChannelSchema,
    ClipSchema,
    ClipsSchema,
    FileReferenceSchema,
    LanesSchema,
    MarkerSchema,
    MarkersSchema,
    NoteSchema,
    NotesSchema,
    ParameterEncoder,
    ProjectSchema,
    TimeSignatureParameterSchema,
    TimeUnit,
    TrackSchema,
    TransportSchema,
    Unit,
    RealParameterSchema,
    WarpSchema,
    WarpsSchema
} from "@opendaw/lib-dawproject"
import {DawProject} from "../dawproject/DawProject"
import {AbletonLiveSet} from "./AbletonLiveSet"

export namespace AbletonImport {
    export type SampleResolver = (sample: AbletonLiveSet.Sample) => Promise<Option<ArrayBuffer>>
    export type Result = { project: ProjectSchema, resources: DawProject.ResourceProvider, warnings: ReadonlyArray<string> }

    export const toDawProject = async (liveSet: AbletonLiveSet.LiveSet, resolveSample: SampleResolver): Promise<Result> => {
        const warnings = [...liveSet.warnings]
        const resources: Array<DawProject.Resource> = []
        const filePaths = new Map<string, Option<string>>()
        const resolve = async (sample: AbletonLiveSet.Sample): Promise<Option<string>> => {
            const key = sample.relativePath || sample.absolutePath
            const known = filePaths.get(key)
            if (isDefined(known)) {return known}
            if (/\.(mp4|mov|m4v|avi|mkv)$/i.test(sample.fileName)) {
                warnings.push(`${sample.fileName}: video files are skipped`)
                filePaths.set(key, Option.None)
                return Option.None
            }
            const buffer = await resolveSample(sample)
            const path = await buffer.match({
                none: async () => {
                    warnings.push(`${sample.fileName}: audio file not found, its clips are skipped`)
                    return Option.None
                },
                some: async buffer => {
                    const path = `samples/${resources.length}/${sample.fileName}`
                    resources.push({uuid: await UUID.sha256(buffer), path, name: sample.fileName, buffer})
                    return Option.wrap(path)
                }
            })
            filePaths.set(key, path)
            return path
        }
        const writeClip = async (clip: AbletonLiveSet.NoteClip | AbletonLiveSet.AudioClip): Promise<Option<ClipSchema>> => {
            const frame = {
                name: clip.name, time: clip.time, duration: clip.duration, contentTimeUnit: TimeUnit.BEATS,
                playStart: clip.playStart, loopStart: isDefined(clip.loopEnd) ? 0.0 : undefined, loopEnd: clip.loopEnd,
                enable: clip.enabled
            }
            if (clip.type === "notes") {
                return Option.wrap(Xml.element({
                    ...frame, content: [Xml.element({
                        notes: clip.notes.map(note => Xml.element({
                            time: note.time, duration: note.duration, channel: 0, key: note.key,
                            vel: note.velocity, rel: note.velocity
                        }, NoteSchema))
                    }, NotesSchema)]
                }, ClipSchema))
            }
            const {sample, beatsPerSecond, warped} = clip
            return (await resolve(sample)).map(path => Xml.element({
                ...frame, content: [Xml.element({
                    contentTimeUnit: "seconds",
                    content: [Xml.element({
                        channels: 2, sampleRate: 44100, duration: sample.durationInSeconds,
                        algorithm: warped ? "stretch" : "repitch",
                        file: Xml.element({path, external: false}, FileReferenceSchema)
                    }, AudioSchema)],
                    warps: [
                        Xml.element({time: 0.0, contentTime: 0.0}, WarpSchema),
                        Xml.element({time: sample.durationInSeconds * beatsPerSecond, contentTime: sample.durationInSeconds}, WarpSchema)
                    ]
                }, WarpsSchema)]
            }, ClipSchema))
        }
        const structure: Array<TrackSchema> = []
        const lanes: Array<LanesSchema> = []
        for (const [index, track] of liveSet.tracks.entries()) {
            const trackId = `track-${index}`
            const clips: Array<ClipSchema> = []
            for (const clip of track.clips) {(await writeClip(clip)).ifSome(schema => clips.push(schema))}
            structure.push(Xml.element({
                id: trackId, name: track.name, contentType: track.type, loaded: true,
                channel: Xml.element({
                    id: `channel-${index}`, role: ChannelRole.REGULAR, audioChannels: 2, destination: "master-channel",
                    volume: ParameterEncoder.linear(`volume-${index}`, track.volume, 0.0, 2.0, "Volume"),
                    pan: ParameterEncoder.normalized(`pan-${index}`, (track.pan + 1.0) / 2.0, 0.0, 1.0, "Pan"),
                    mute: ParameterEncoder.bool(`mute-${index}`, track.mute, "Mute")
                }, ChannelSchema)
            }, TrackSchema))
            lanes.push(Xml.element({id: `lanes-${index}`, track: trackId, lanes: [Xml.element({clips}, ClipsSchema)]}, LanesSchema))
        }
        structure.push(Xml.element({
            id: "master-track", name: "Master", contentType: "audio notes", loaded: true,
            channel: Xml.element({id: "master-channel", role: ChannelRole.MASTER, audioChannels: 2}, ChannelSchema)
        }, TrackSchema))
        const schema = Xml.element({
            version: "1.0",
            application: Xml.element({name: "Ableton Live", version: liveSet.creator}, ApplicationSchema),
            transport: Xml.element({
                tempo: Xml.element({id: "tempo", value: liveSet.bpm, unit: Unit.BPM}, RealParameterSchema),
                timeSignature: Xml.element({numerator: liveSet.numerator, denominator: liveSet.denominator},
                    TimeSignatureParameterSchema)
            }, TransportSchema),
            structure,
            arrangement: Xml.element({
                id: "arrangement",
                markers: liveSet.locators.length === 0 ? undefined : Xml.element({
                    marker: liveSet.locators.map(({time, name}) => Xml.element({time, name}, MarkerSchema))
                }, MarkersSchema),
                lanes: Xml.element({id: "lanes", timeUnit: TimeUnit.BEATS, lanes}, LanesSchema)
            }, ArrangementSchema)
        }, ProjectSchema)
        // Reparsed like a file, so the importer sees exactly what it reads from a .dawproject
        const project = Xml.parse(new XMLSerializer().serializeToString(Xml.toElement("Project", schema)), ProjectSchema)
        return {
            project, warnings, resources: {
                fromPath: (path: string): DawProject.Resource =>
                    resources.find(resource => resource.path === path) ?? panic(`Resource '${path}' not found`),
                fromUUID: (uuid: UUID.Bytes): DawProject.Resource =>
                    resources.find(resource => UUID.equals(resource.uuid, uuid)) ?? panic("Resource not found")
            }
        }
    }
}
