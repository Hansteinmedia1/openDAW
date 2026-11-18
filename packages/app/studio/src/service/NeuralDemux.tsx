import css from "./NeuralDemux.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {
    Bytes,
    DefaultObservableValue,
    Errors,
    isAbsent,
    isDefined,
    Option,
    RuntimeNotifier,
    UUID
} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Files, Html} from "@opendaw/lib-dom"
import {WavFile} from "@opendaw/lib-dsp"
import type {ExecutionProvider, TaskKey} from "@opendaw/lib-inference"
import {AudioContentFactory, Project, ProjectMeta, ProjectProfile} from "@opendaw/studio-core"
import {InstrumentFactories, Sample} from "@opendaw/studio-adapters"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {StudioService} from "@/service/StudioService"
import {ensureInference} from "@/service/InferenceLoader"

const className = Html.adoptStyleSheet(css, "NeuralDemux")

type StemSeparationKey = Extract<TaskKey, `stem-separation${string}`>

const TASK: StemSeparationKey = "stem-separation"
const HEADLINE = "In Stems trennen"
const MODEL_INFO = "Modell: Hybrid Transformer Demucs v4 (ONNX-Export smank/htdemucs-onnx, MIT)."

// Track colours are hues only, there is no grey: the remainder uses teal
const STEMS = [
    {key: "drums", label: "Schlagzeug", hue: 346.0},
    {key: "bass", label: "Bass", hue: 204.0},
    {key: "vocals", label: "Gesang", hue: 40.0},
    {key: "other", label: "Rest", hue: 176.0}
] as const

const isWebGPUAvailable = (): boolean =>
    isDefined((navigator as Navigator & { gpu?: unknown }).gpu)

const providerLabel = (provider: ExecutionProvider): string =>
    provider === "webgpu" ? "Grafikkarte (WebGPU)" : "Prozessor (WASM)"

let lastProvider: Option<ExecutionProvider> = Option.None

const decodeAudioFile = async (file: File, sampleRate: number):
    Promise<{ audio: Float32Array, channels: 1 | 2, frames: number }> => {
    const arrayBuffer = await file.arrayBuffer()
    const ctx = new AudioContext({sampleRate})
    const decoded = await ctx.decodeAudioData(arrayBuffer)
    await ctx.close()
    const channels: 1 | 2 = decoded.numberOfChannels >= 2 ? 2 : 1
    const frames = decoded.length
    const planar = new Float32Array(channels * frames)
    for (let c = 0; c < channels; c++) {
        const sourceChannel = decoded.numberOfChannels >= 2 ? decoded.getChannelData(c) : decoded.getChannelData(0)
        planar.set(sourceChannel, c * frames)
    }
    return {audio: planar, channels, frames}
}

// The model expects two channels
const toStereo = (audio: Float32Array, channels: 1 | 2, frames: number): Float32Array => {
    if (channels === 2) {return audio}
    const stereo = new Float32Array(2 * frames)
    stereo.set(audio.subarray(0, frames), 0)
    stereo.set(audio.subarray(0, frames), frames)
    return stereo
}

const toSourceChannels = (stem: Float32Array, channels: 1 | 2, frames: number): ReadonlyArray<Float32Array> => {
    const left = stem.subarray(0, frames)
    const right = stem.subarray(frames, 2 * frames)
    return channels === 2 ? [left, right] : [left.map((value, index) => (value + right[index]) * 0.5)]
}

const pickProvider = async (sizeLabel: string): Promise<Option<ExecutionProvider>> => {
    const webgpu = isWebGPUAvailable()
    const providerSelect: HTMLSelectElement = (
        <select>
            <option value="webgpu" disabled={!webgpu} selected={webgpu}>
                {`${providerLabel("webgpu")}${webgpu ? "" : " – in diesem Browser nicht verfügbar"}`}
            </option>
            <option value="wasm" selected={!webgpu}>{providerLabel("wasm")}</option>
        </select>
    ) as HTMLSelectElement
    const result = await Promises.tryCatch(Dialogs.show({
        headline: HEADLINE,
        content: (
            <div className={className}>
                <label>Rechenweg</label>
                {providerSelect}
                <p>{`${MODEL_INFO}\n${sizeLabel}, wird einmal geladen und bleibt im Browser gespeichert.`}</p>
            </div>
        ),
        okText: "Trennen",
        cancelable: true
    }))
    if (result.status === "rejected") {return Option.None}
    return Option.wrap(providerSelect.value === "webgpu" ? "webgpu" : "wasm")
}

const reportFailure = (message: string): Promise<void> => RuntimeNotifier.info({headline: HEADLINE, message})

export namespace NeuralDemux {
    export const run = async (service: StudioService): Promise<void> => {
        const approved = await RuntimeNotifier.approve({
            headline: HEADLINE,
            message: "Trennt eine Audiodatei in Schlagzeug, Bass, Gesang und Rest und legt die vier Stems als Spuren an.",
            approveText: "Datei wählen...",
            cancelText: "Abbrechen"
        })
        if (!approved) {return}
        const fileResult = await Promises.tryCatch(Files.open({
            types: [{
                description: "audio",
                accept: {"audio/*": [".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"]}
            }]
        }))
        if (fileResult.status === "rejected") {return}
        const fileMaybe = fileResult.value.at(0)
        if (isAbsent(fileMaybe)) {return}
        const file: File = fileMaybe
        const Inference = await ensureInference()
        const sizeLabel = Bytes.toString(Inference.modelDescriptor(TASK).bytes)
        const providerOpt = await pickProvider(sizeLabel)
        if (providerOpt.isEmpty()) {return}
        const provider = providerOpt.unwrap()
        await service.audioContext.suspend()
        try {
            await runDemux()
        } finally {
            await service.audioContext.resume()
        }
        async function runDemux(): Promise<void> {
            if (!service.hasProfile) {
                service.projectProfileService.setValue(Option.wrap(
                    new ProjectProfile(UUID.generate(), Project.new(service), ProjectMeta.init("Untitled"), Option.None)))
            }
            const decoded = await Promises.tryCatch(decodeAudioFile(file, 44100))
            if (decoded.status === "rejected") {
                console.warn(decoded.error)
                await reportFailure("Die Datei konnte nicht gelesen werden. Bitte eine WAV-, MP3-, FLAC-, M4A- oder OGG-Datei wählen.")
                return
            }
            const {audio, channels, frames} = decoded.value
            if (lastProvider.nonEmpty() && lastProvider.unwrap() !== provider) {await Inference.releaseTask(TASK)}
            const cached = await Inference.isCached(TASK)
            if (!cached) {
                const dlProgress = new DefaultObservableValue<number>(0)
                const dlController = new AbortController()
                const dlDialog = RuntimeNotifier.progress({
                    headline: "Modell wird geladen",
                    message: `${sizeLabel}, einmalig`,
                    progress: dlProgress,
                    cancel: () => dlController.abort(Errors.AbortError)
                })
                const preloadResult = await Promises.tryCatch(Inference.preload(TASK, {
                    progress: value => dlProgress.setValue(value),
                    signal: dlController.signal,
                    executionProvider: provider
                }))
                dlDialog.terminate()
                if (preloadResult.status === "rejected") {
                    if (!Errors.isAbort(preloadResult.error)) {
                        console.warn(preloadResult.error)
                        await reportFailure("Das Modell konnte nicht geladen werden. Internetverbindung prüfen und erneut versuchen.")
                    }
                    return
                }
            } else {
                const loadController = new AbortController()
                const loadDialog = RuntimeNotifier.progress({
                    headline: "Modell wird geladen",
                    message: `${sizeLabel}, aus dem Browser-Speicher`,
                    cancel: () => loadController.abort(Errors.AbortError)
                })
                const sessionResult = await Promises.tryCatch(Promise.race([
                    Inference.preload(TASK, {
                        signal: loadController.signal,
                        executionProvider: provider
                    }),
                    new Promise<never>((_, reject) => loadController.signal.addEventListener(
                        "abort", () => reject(Errors.AbortError), {once: true}))
                ]))
                loadDialog.terminate()
                if (sessionResult.status === "rejected") {
                    if (!Errors.isAbort(sessionResult.error)) {
                        console.warn(sessionResult.error)
                        await reportFailure("Das Modell konnte nicht gestartet werden. Seite neu laden und erneut versuchen.")
                    }
                    return
                }
            }
            const sepProgress = new DefaultObservableValue<number>(0)
            const sepController = new AbortController()
            const sepDialog = RuntimeNotifier.progress({
                headline: "Stems werden getrennt",
                message: `Rechenweg: ${providerLabel(provider)}`,
                progress: sepProgress,
                cancel: () => sepController.abort(Errors.AbortError)
            })
            const inferenceResult = await Promises.tryCatch(Inference.run(TASK, {
                audio: toStereo(audio, channels, frames), channels: 2, sampleRate: 44100
            }, {
                progress: value => sepProgress.setValue(value),
                signal: sepController.signal,
                downloadShare: 0,
                executionProvider: provider
            }))
            sepDialog.terminate()
            if (inferenceResult.status === "rejected") {
                if (!Errors.isAbort(inferenceResult.error)) {
                    console.warn(inferenceResult.error)
                    await reportFailure(provider === "webgpu"
                        ? "Die Trennung ist fehlgeschlagen. Erneut versuchen und als Rechenweg „Prozessor (WASM)“ wählen."
                        : "Die Trennung ist fehlgeschlagen. Seite neu laden und mit einer kürzeren Datei erneut versuchen.")
                }
                return
            }
            lastProvider = Option.wrap(provider)
            const stems = inferenceResult.value
            const importDialog = RuntimeNotifier.progress({
                headline: "Stems werden importiert"
            })
            const project = service.project
            const sampleService = service.sampleService
            const importResults: Array<{ name: string, hue: number, sample: Sample }> = []
            for (const {key, label, hue} of STEMS) {
                const channelData = toSourceChannels(stems[key], channels, frames)
                const arrayBuffer = WavFile.encodeInts16({
                    sampleRate: 44100,
                    length: frames,
                    numberOfChannels: channels,
                    getChannelData: (channel: number) => channelData[channel]
                })
                const importResult = await Promises.tryCatch(sampleService.importFile({
                    name: label,
                    arrayBuffer
                }))
                if (importResult.status === "rejected") {
                    console.warn(`Failed to import stem ${key}`, importResult.error)
                    continue
                }
                const sample = importResult.value
                await Promises.tryCatch(service.sampleManager.getAudioData(UUID.parse(sample.uuid)))
                importResults.push({name: label, hue, sample})
            }
            importDialog.terminate()
            const {editing, boxGraph, api} = project
            editing.modify(() => {
                for (const {name, hue, sample} of importResults) {
                    const {trackBox, instrumentBox} = api.createInstrument(InstrumentFactories.Tape)
                    instrumentBox.label.setValue(name)
                    const uuid = UUID.parse(sample.uuid)
                    const audioFileBox = boxGraph.findBox<AudioFileBox>(uuid)
                        .unwrapOrElse(() => AudioFileBox.create(boxGraph, uuid, box => {
                            box.fileName.setValue(name)
                            box.startInSeconds.setValue(0)
                            box.endInSeconds.setValue(sample.duration)
                        }))
                    AudioContentFactory.createNotStretchedRegion({
                        boxGraph, sample, audioFileBox, position: 0, targetTrack: trackBox
                    }).hue.setValue(hue)
                }
            })
        }
    }
}