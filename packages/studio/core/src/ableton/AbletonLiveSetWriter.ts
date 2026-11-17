import {int, isDefined, Optional} from "@opendaw/lib-std"

export namespace AbletonLiveSetWriter {
    export type Note = { time: number, duration: number, key: int, velocity: number }
    type ClipBase = { name: string, time: number, duration: number, enabled: boolean, playStart: number, loopEnd: Optional<number> }
    export type NoteClip = ClipBase & { type: "notes", notes: ReadonlyArray<Note> }
    export type WarpMarker = { seconds: number, beats: number }
    export type AudioClip = ClipBase & {
        type: "audio", relativePath: string, durationInSeconds: number, sampleRate: number
        warpMarkers: ReadonlyArray<WarpMarker>
    }
    export type Track = {
        name: string, type: "notes" | "audio", volume: number, pan: number, mute: boolean
        clips: ReadonlyArray<NoteClip | AudioClip>
    }
    export type LiveSet = {
        bpm: number, numerator: int, denominator: int
        locators: ReadonlyArray<{ time: number, name: string }>, tracks: ReadonlyArray<Track>
    }

    const SCENES = 8

    export const write = (liveSet: LiveSet): string => {
        let nextId = 1
        const id = (): int => nextId++
        const tracks = liveSet.tracks.map((track, index) => writeTrack(track, index, id)).join("")
        const main = writeMainTrack(liveSet, id)
        const scenes = Array.from({length: SCENES}, (_, index) => element("Scene", {Id: index},
            value("Name", "") + value("Color", -1) + value("Tempo", liveSet.bpm) + value("IsTempoEnabled", false)
            + value("TimeSignatureId", encodeSignature(liveSet.numerator, liveSet.denominator))
            + value("IsTimeSignatureEnabled", false))).join("")
        const locators = liveSet.locators.map((locator, index) => element("Locator", {Id: index},
            value("LomId", 0) + value("Time", locator.time) + value("Name", locator.name) + value("Annotation", "")
            + value("IsSongStart", false))).join("")
        const body = element("Tracks", {}, tracks) + main + element("SendsPre", {}, "")
            + element("Scenes", {}, scenes) + element("Locators", {}, element("Locators", {}, locators))
            + value("SelectedDocumentViewInMainWindow", 0)
        return `<?xml version="1.0" encoding="UTF-8"?>\n`
            + element("Ableton", {MajorVersion: 5, MinorVersion: "12.0_12117", SchemaChangeCount: 10, Creator: "openDAW"},
                element("LiveSet", {}, value("NextPointeeId", nextId + 1) + body))
    }

    // Live stores the signature as one number: denominator exponent * 99 + numerator - 1
    const encodeSignature = (numerator: int, denominator: int): int => Math.log2(denominator) * 99 + numerator - 1

    const writeTrack = (track: Track, index: int, id: () => int): string => {
        const isNotes = track.type === "notes"
        const slots = clipSlots()
        const events = track.clips.map((clip, clipIndex) => clip.type === "notes"
            ? writeNoteClip(clip, clipIndex) : writeAudioClip(clip, clipIndex)).join("")
        const arrangement = element("ArrangerAutomation", {}, element("Events", {}, events))
        const mainSequencer = element("MainSequencer", {}, toggle("On", true, id) + slots
            + (isNotes ? element("ClipTimeable", {}, arrangement) : element("Sample", {}, arrangement)))
        const freezeSequencer = element("FreezeSequencer", {}, toggle("On", true, id) + slots
            + element("Sample", {}, element("ArrangerAutomation", {}, element("Events", {}, ""))))
        const deviceChain = element("DeviceChain", {},
            routing("AudioOutputRouting", "AudioOut/Main", "Main")
            + mixer(track.volume, track.pan, !track.mute, id)
            + mainSequencer + freezeSequencer
            + element("DeviceChain", {}, element("Devices", {}, "") + element("SignalModulations", {}, "")))
        return element(isNotes ? "MidiTrack" : "AudioTrack", {Id: index + 10},
            element("Name", {}, value("EffectiveName", track.name) + value("UserName", track.name)
                + value("Annotation", "") + value("MemorizedFirstClipName", ""))
            + value("Color", index % 70) + value("TrackGroupId", -1) + value("TrackUnfolded", true)
            + value("LinkedTrackGroupId", -1) + value("Freeze", false) + deviceChain)
    }

    const writeMainTrack = (liveSet: LiveSet, id: () => int): string => element("MainTrack", {},
        element("Name", {}, value("EffectiveName", "Main") + value("UserName", "") + value("Annotation", "")
            + value("MemorizedFirstClipName", ""))
        + value("Color", -1) + value("TrackGroupId", -1) + value("TrackUnfolded", false) + value("LinkedTrackGroupId", -1)
        + element("DeviceChain", {},
            routing("AudioOutputRouting", "AudioOut/External/S0", "Ext. Out", "1/2")
            + mixer(1.0, 0.0, true, id, [
                parameter("Tempo", liveSet.bpm, id, [60.0, 200.0]),
                element("TimeSignature", {}, value("LomId", 0)
                    + value("Manual", encodeSignature(liveSet.numerator, liveSet.denominator)) + automationTarget(id))
            ].join(""))
            + element("DeviceChain", {}, element("Devices", {}, "") + element("SignalModulations", {}, ""))))

    const mixer = (volume: number, pan: number, speaker: boolean, id: () => int, extra: string = ""): string =>
        element("Mixer", {}, toggle("On", true, id) + element("Sends", {}, "") + toggle("Speaker", speaker, id)
            + value("SoloSink", false) + value("PanMode", 0) + parameter("Pan", pan, id, [-1.0, 1.0])
            + parameter("SplitStereoPanL", -1.0, id, [-1.0, 1.0]) + parameter("SplitStereoPanR", 1.0, id, [-1.0, 1.0])
            + parameter("Volume", volume, id, [0.0003162277571, 1.99526238])
            + element("CrossFadeState", {}, value("LomId", 0) + value("Manual", 1) + automationTarget(id)) + extra)

    const clipSlots = (): string => element("ClipSlotList", {}, Array.from({length: SCENES}, (_, index) =>
        element("ClipSlot", {Id: index}, value("LomId", 0) + element("ClipSlot", {}, element("Value", {}, ""))
            + value("HasStop", true) + value("NeedRefreeze", true))).join(""))

    // Loop values are beats (all clips are written warped). Without a loop the window starts at the play start.
    const clipFrame = (clip: NoteClip | AudioClip, index: int): string => {
        const looped = isDefined(clip.loopEnd) && clip.loopEnd < clip.playStart + clip.duration - 1e-6
        const loopStart = looped ? 0.0 : clip.playStart
        const loopEnd = looped ? clip.loopEnd ?? 0.0 : clip.playStart + clip.duration
        return value("LomId", 0) + value("CurrentStart", clip.time) + value("CurrentEnd", clip.time + clip.duration)
            + element("Loop", {}, value("LoopStart", loopStart) + value("LoopEnd", loopEnd)
                + value("StartRelative", looped ? clip.playStart : 0.0) + value("LoopOn", looped)
                + value("OutMarker", loopEnd) + value("HiddenLoopStart", loopStart) + value("HiddenLoopEnd", loopEnd))
            + value("Name", clip.name) + value("Annotation", "") + value("Color", -1)
            + value("Disabled", !clip.enabled) + value("IsWarped", true) + value("TakeId", index + 1)
    }

    const writeNoteClip = (clip: NoteClip, index: int): string => {
        const keys = [...new Set(clip.notes.map(note => note.key))].sort((keyA, keyB) => keyA - keyB)
        let noteId = 1
        const keyTracks = keys.map((key, keyIndex) => element("KeyTrack", {Id: keyIndex},
            element("Notes", {}, clip.notes.filter(note => note.key === key).map(note => element("MidiNoteEvent", {
                Time: note.time, Duration: note.duration,
                Velocity: Math.max(1, Math.min(127, Math.round(note.velocity * 127))),
                OffVelocity: 64, IsEnabled: true, NoteId: noteId++
            }, null)).join("")) + value("MidiKey", key))).join("")
        return element("MidiClip", {Id: index, Time: clip.time}, clipFrame(clip, index)
            + element("Notes", {}, element("KeyTracks", {}, keyTracks)
                + element("PerNoteEventStore", {}, element("EventLists", {}, ""))
                + element("NoteIdGenerator", {}, value("NextId", noteId))))
    }

    const writeAudioClip = (clip: AudioClip, index: int): string => element("AudioClip", {Id: index, Time: clip.time},
        clipFrame(clip, index)
        + element("SampleRef", {}, element("FileRef", {}, value("RelativePathType", 1)
                + value("RelativePath", clip.relativePath) + value("Path", "") + value("Type", 1)
                + value("LivePackName", "") + value("LivePackId", "") + value("OriginalFileSize", 0) + value("OriginalCrc", 0))
            + value("LastModDate", 0) + element("SourceContext", {}, "") + value("SampleUsageHint", 0)
            + value("DefaultDuration", Math.round(clip.durationInSeconds * clip.sampleRate))
            + value("DefaultSampleRate", clip.sampleRate))
        + value("WarpMode", 4) + value("Fade", true) + value("PitchCoarse", 0) + value("PitchFine", 0) + value("SampleVolume", 1)
        + element("WarpMarkers", {}, clip.warpMarkers.map((marker, markerIndex) =>
            element("WarpMarker", {Id: markerIndex, SecTime: marker.seconds, BeatTime: marker.beats}, null)).join("")))

    const routing = (tag: string, target: string, upper: string, lower: string = ""): string => element(tag, {},
        value("Target", target) + value("UpperDisplayString", upper) + value("LowerDisplayString", lower))
    const automationTarget = (id: () => int): string =>
        element("AutomationTarget", {Id: id()}, value("LockEnvelope", 0))
    const toggle = (tag: string, on: boolean, id: () => int): string =>
        element(tag, {}, value("LomId", 0) + value("Manual", on) + automationTarget(id))
    const parameter = (tag: string, manual: number, id: () => int, [min, max]: [number, number]): string =>
        element(tag, {}, value("LomId", 0) + value("Manual", manual)
            + element("MidiControllerRange", {}, value("Min", min) + value("Max", max))
            + automationTarget(id) + element("ModulationTarget", {Id: id()}, value("LockEnvelope", 0)))
    const value = (tag: string, data: string | number | boolean): string => element(tag, {Value: data}, null)
    const element = (tag: string, attributes: Record<string, string | number | boolean>, content: string | null): string => {
        const attributeText = Object.entries(attributes)
            .map(([name, data]) => ` ${name}="${escape(typeof data === "number" ? format(data) : String(data))}"`).join("")
        return content === null ? `<${tag}${attributeText} />` : `<${tag}${attributeText}>${content}</${tag}>`
    }
    const format = (number: number): string => Number.isInteger(number) ? String(number) : String(Number(number.toPrecision(15)))
    const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}
