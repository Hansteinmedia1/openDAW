import {asDefined, int, isDefined, Nullable, Optional, panic} from "@opendaw/lib-std"

export namespace AbletonLiveSet {
    export type Note = { time: number, duration: number, key: int, velocity: number }
    export type Sample = { relativePath: string, absolutePath: string, fileName: string, durationInSeconds: number }
    type ClipBase = { name: string, time: number, duration: number, enabled: boolean, playStart: number, loopEnd: Optional<number> }
    export type NoteClip = ClipBase & { type: "notes", notes: ReadonlyArray<Note> }
    export type AudioClip = ClipBase & { type: "audio", sample: Sample, beatsPerSecond: number, warped: boolean }
    export type Track = {
        id: string, name: string, type: "notes" | "audio"
        volume: number, pan: number, mute: boolean, clips: ReadonlyArray<NoteClip | AudioClip>
    }
    export type Locator = { time: number, name: string }
    export type LiveSet = {
        creator: string, bpm: number, numerator: int, denominator: int
        locators: ReadonlyArray<Locator>, tracks: ReadonlyArray<Track>, warnings: ReadonlyArray<string>
    }

    export const decompress = async (buffer: ArrayBuffer): Promise<string> =>
        new Response(asDefined(new Response(buffer).body).pipeThrough(new DecompressionStream("gzip"))).text()

    export const parse = (xml: string): LiveSet => {
        const document = new DOMParser().parseFromString(xml, "application/xml")
        const root = document.documentElement
        if (root.nodeName !== "Ableton") {return panic("Not an Ableton Live set")}
        const liveSet = child(root, "LiveSet") ?? panic("Missing LiveSet")
        const warnings: Array<string> = []
        const main = child(liveSet, "MasterTrack") ?? child(liveSet, "MainTrack")
        const bpm = number(main, "DeviceChain/Mixer/Tempo/Manual", 120.0)
        const {numerator, denominator} = decodeSignature(number(main, "DeviceChain/Mixer/TimeSignature/Manual", 201))
        const locators = children(liveSet, "Locators/Locators/Locator")
            .map(locator => ({time: number(locator, "Time", 0.0), name: value(locator, "Name") ?? ""}))
            .sort((locatorA, locatorB) => locatorA.time - locatorB.time)
        const trackElements = Array.from(child(liveSet, "Tracks")?.children ?? [])
        const mutedGroups = new Set(trackElements
            .filter(element => element.nodeName === "GroupTrack" && value(element, "DeviceChain/Mixer/Speaker/Manual") === "false")
            .map(element => element.getAttribute("Id")))
        const tracks = trackElements
            .filter(element => element.nodeName === "AudioTrack" || element.nodeName === "MidiTrack")
            .map(element => readTrack(element, bpm, mutedGroups, warnings))
        return {creator: root.getAttribute("Creator") ?? "", bpm, numerator, denominator, locators, tracks, warnings}
    }

    // Live stores the signature as one number: denominator exponent * 99 + numerator - 1
    const decodeSignature = (encoded: number): { numerator: int, denominator: int } =>
        ({numerator: encoded % 99 + 1, denominator: 2 ** Math.floor(encoded / 99)})

    const readTrack = (element: Element, bpm: number, mutedGroups: Set<Nullable<string>>, warnings: Array<string>): Track => {
        const name = value(element, "Name/EffectiveName") ?? value(element, "Name/UserName") ?? element.nodeName
        const isMidi = element.nodeName === "MidiTrack"
        const mute = value(element, "DeviceChain/Mixer/Speaker/Manual") === "false"
            || mutedGroups.has(value(element, "TrackGroupId") ?? null)
        const clips = isMidi
            ? children(element, "DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events/MidiClip").map(readNoteClip)
            : children(element, "DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip")
                .map(clip => readAudioClip(clip, `${name} / ${value(clip, "Name") ?? ""}`, bpm, warnings))
        return {
            id: element.getAttribute("Id") ?? name, name, type: isMidi ? "notes" : "audio",
            volume: number(element, "DeviceChain/Mixer/Volume/Manual", 1.0),
            pan: number(element, "DeviceChain/Mixer/Pan/Manual", 0.0),
            mute, clips
        }
    }

    const readFrame = (clip: Element) => {
        const time = number(clip, "CurrentStart", 0.0)
        return {
            name: value(clip, "Name") ?? "", time, duration: number(clip, "CurrentEnd", time) - time,
            enabled: value(clip, "Disabled") !== "true",
            loopStart: number(clip, "Loop/LoopStart", 0.0), loopEnd: number(clip, "Loop/LoopEnd", 0.0),
            startRelative: number(clip, "Loop/StartRelative", 0.0), loopOn: value(clip, "Loop/LoopOn") === "true"
        }
    }

    // Notes move by the loop start, so the loop (or the start marker) begins at content zero
    const readNoteClip = (clip: Element): NoteClip => {
        const {name, time, duration, enabled, loopStart, loopEnd, startRelative, loopOn} = readFrame(clip)
        const notes = children(clip, "Notes/KeyTracks/KeyTrack").flatMap(keyTrack => {
            const key = number(keyTrack, "MidiKey", 60)
            return children(keyTrack, "Notes/MidiNoteEvent")
                .filter(event => event.getAttribute("IsEnabled") !== "false")
                .map(event => ({
                    time: Number(event.getAttribute("Time")) - loopStart,
                    duration: Number(event.getAttribute("Duration")),
                    key,
                    velocity: Math.min(1.0, Number(event.getAttribute("Velocity")) / 127.0)
                }))
        }).filter(note => note.time + note.duration > 0.0)
            .sort((noteA, noteB) => noteA.time - noteB.time || noteA.key - noteB.key)
        return {
            type: "notes", name, time, duration, enabled, notes,
            playStart: loopOn ? startRelative : 0.0, loopEnd: loopOn ? loopEnd - loopStart : undefined
        }
    }

    // Unwarped loop values are seconds, warped ones beats (warp markers approximated linearly)
    const readAudioClip = (clip: Element, label: string, bpm: number, warnings: Array<string>): AudioClip => {
        const {name, time, duration, enabled, loopStart, loopEnd, startRelative, loopOn} = readFrame(clip)
        const fileRef = child(clip, "SampleRef/FileRef")
        const relativePath = value(fileRef, "RelativePath") ?? ""
        const absolutePath = value(fileRef, "Path") ?? ""
        const sample: Sample = {
            relativePath, absolutePath,
            fileName: (relativePath || absolutePath).split("/").at(-1) ?? name,
            durationInSeconds: number(clip, "SampleRef/DefaultDuration", 0.0)
                / number(clip, "SampleRef/DefaultSampleRate", 44100.0)
        }
        const warped = value(clip, "IsWarped") === "true"
        let beatsPerSecond = bpm / 60.0
        let toContentBeats = (seconds: number): number => seconds * beatsPerSecond
        if (warped) {
            const markers = children(clip, "WarpMarkers/WarpMarker")
                .map(marker => ({seconds: Number(marker.getAttribute("SecTime")), beats: Number(marker.getAttribute("BeatTime"))}))
            const first = markers.at(0), last = markers.at(-1)
            let beatAtFileStart = 0.0
            if (isDefined(first) && isDefined(last) && last.seconds > first.seconds) {
                beatsPerSecond = (last.beats - first.beats) / (last.seconds - first.seconds)
                beatAtFileStart = first.beats - first.seconds * beatsPerSecond
                const deviation = Math.max(...markers.map(marker =>
                    Math.abs(marker.beats - (beatAtFileStart + marker.seconds * beatsPerSecond))))
                if (deviation > 0.05) {
                    warnings.push(`${label}: non-linear warping approximated (up to ${deviation.toFixed(2)} beats)`)
                }
            }
            toContentBeats = (beats: number): number => beats - beatAtFileStart
        }
        if (number(clip, "PitchCoarse", 0.0) !== 0.0 || number(clip, "PitchFine", 0.0) !== 0.0) {
            warnings.push(`${label}: transposition is not imported`)
        }
        let clipLoopEnd: Optional<number> = undefined
        if (loopOn) {
            if (Math.abs(toContentBeats(loopStart)) > 1e-3) {
                warnings.push(`${label}: loop does not start at the file start, the clip plays once`)
            } else {
                clipLoopEnd = toContentBeats(loopEnd)
            }
        }
        return {
            type: "audio", name, time, duration, enabled, sample, beatsPerSecond, warped,
            playStart: toContentBeats(loopStart + (loopOn ? startRelative : 0.0)), loopEnd: clipLoopEnd
        }
    }

    const child = (element: Nullable<Element>, path: string): Nullable<Element> =>
        path.split("/").reduce<Nullable<Element>>((current, name) =>
            current === null ? null : Array.from(current.children).find(node => node.nodeName === name) ?? null, element)
    const children = (element: Element, path: string): ReadonlyArray<Element> => {
        const names = path.split("/")
        const parent = names.length > 1 ? child(element, names.slice(0, -1).join("/")) : element
        return Array.from(parent?.children ?? []).filter(node => node.nodeName === names.at(-1))
    }
    const value = (element: Nullable<Element>, path: string): Optional<string> =>
        child(element, path)?.getAttribute("Value") ?? undefined
    const number = (element: Nullable<Element>, path: string, fallback: number): number => {
        const text = value(element, path)
        return isDefined(text) ? Number(text) : fallback
    }
}
