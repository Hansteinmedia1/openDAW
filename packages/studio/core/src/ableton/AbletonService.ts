import {Errors, isDefined, Option, panic, RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Files} from "@opendaw/lib-dom"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {FilePickerAcceptTypes} from "../FilePickerAcceptTypes"
import {ExternalLib} from "../ExternalLib"
import {ProjectProfile} from "../project"
import {AbletonExport} from "./AbletonExport"
import {DawProjectImport} from "../dawproject/DawProjectImporter"
import {SampleService} from "../samples"
import {AbletonLiveSet} from "./AbletonLiveSet"
import {AbletonImport} from "./AbletonImport"

export class AbletonService {
    static async importLiveSet(sampleService: SampleService): Promise<Option<ProjectSkeleton>> {
        const {status, value: files, error} =
            await Promises.tryCatch(Files.open({types: [FilePickerAcceptTypes.AbletonLiveSetFileType]}))
        if (status === "rejected") {
            if (Errors.isAbort(error)) {return Option.None}
            return panic(String(error))
        }
        const file = files.at(0)
        if (!isDefined(file)) {return Option.None}
        const parsed = await Promises.tryCatch(file.arrayBuffer().then(AbletonLiveSet.decompress).then(AbletonLiveSet.parse))
        if (parsed.status === "rejected") {
            console.warn(parsed.error)
            RuntimeNotifier.notify({message: "This is not a readable Ableton Live set.", icon: "Warning"})
            return Option.None
        }
        const liveSet = parsed.value
        const usesAudio = liveSet.tracks.some(track => track.clips.some(clip => clip.type === "audio"))
        const folder = usesAudio && await RuntimeNotifier.approve({
            headline: "Ableton Live Set",
            message: `'${file.name}' plays audio files. Select the set's project folder to import them as well.`,
            approveText: "Select Folder",
            cancelText: "Without Audio"
        }) ? await AbletonService.#openFolder() : []
        const resolver = AbletonService.#sampleResolver(folder)
        const dialog = RuntimeNotifier.progress({headline: "Importing Ableton Live Set..."})
        const importResult = await Promises.tryCatch(AbletonImport.toDawProject(liveSet, resolver)
            .then(async ({project, resources, warnings}) =>
                ({...await DawProjectImport.read(project, resources), resources, warnings})))
        if (importResult.status === "rejected") {
            dialog.terminate()
            console.warn(importResult.error)
            RuntimeNotifier.notify({message: "Import failed.", icon: "Warning"})
            return Option.None
        }
        const {skeleton, audioIds, resources, warnings} = importResult.value
        await Promise.all(audioIds
            .map(uuid => resources.fromUUID(uuid))
            .map(resource => sampleService.importFile({uuid: resource.uuid, name: resource.name, arrayBuffer: resource.buffer})))
        dialog.terminate()
        if (warnings.length > 0) {
            const counted = new Map<string, number>()
            warnings.forEach(warning => counted.set(warning, (counted.get(warning) ?? 0) + 1))
            const lines = Array.from(counted, ([warning, count]) => count > 1 ? `${warning} (${count}×)` : warning)
            const more = lines.length > 12 ? `\n… and ${lines.length - 12} more (see console)` : ""
            console.info(lines.join("\n"))
            await RuntimeNotifier.info({headline: "Imported with notes", message: lines.slice(0, 12).join("\n") + more})
        }
        return Option.wrap(skeleton)
    }

    // Saves a zip with a Live project folder: "<name> Project/<name>.als" and "Samples/Imported/*.wav"
    static async exportLiveSet(profile: ProjectProfile): Promise<void> {
        const {project, meta} = profile
        const name = meta.name.replace(/[\\/:*?"<>|]/g, "-").trim() || "openDAW"
        const dialog = RuntimeNotifier.progress({headline: "Exporting Ableton Live Set..."})
        const exported = await Promises.tryCatch(AbletonExport.write(project.skeleton, name,
            uuid => project.sampleManager.getOrCreate(uuid).data))
        const zipLib = await ExternalLib.JSZip()
        if (exported.status === "rejected" || zipLib.status === "rejected") {
            dialog.terminate()
            console.warn(exported.status === "rejected" ? exported.error : zipLib.error)
            return RuntimeNotifier.info({headline: "Export Error", message: "The Live set could not be written."})
        }
        const zip = new zipLib.value()
        exported.value.files.forEach(({path, buffer}) => zip.file(`${name} Project/${path}`, buffer))
        const buffer = await zip.generateAsync({type: "arraybuffer"})
        dialog.terminate()
        const saved = await Promises.tryCatch(Files.save(buffer,
            {types: [FilePickerAcceptTypes.ZipFileType], suggestedName: `${name} Project.zip`}))
        if (saved.status === "rejected" && !Errors.isAbort(saved.error)) {throw saved.error}
        const {warnings} = exported.value
        if (saved.status === "resolved" && warnings.length > 0) {
            await RuntimeNotifier.info({headline: "Exported with notes", message: warnings.join("\n")})
        }
    }

    // Matches Live's project-relative paths, falls back to a unique file name anywhere in the folder
    static #sampleResolver(folder: ReadonlyArray<File>): AbletonImport.SampleResolver {
        const byPath = new Map(folder.map(file => [file.webkitRelativePath.split("/").slice(1).join("/"), file]))
        const byName = new Map<string, Array<File>>()
        folder.forEach(file => byName.set(file.name, [...(byName.get(file.name) ?? []), file]))
        return async (sample: AbletonLiveSet.Sample): Promise<Option<ArrayBuffer>> => {
            const named = byName.get(sample.fileName) ?? []
            const file = byPath.get(sample.relativePath) ?? (named.length === 1 ? named[0] : undefined)
            return isDefined(file) ? Option.wrap(await file.arrayBuffer()) : Option.None
        }
    }

    static #openFolder(): Promise<ReadonlyArray<File>> {
        return new Promise(resolve => {
            const input = document.createElement("input")
            input.type = "file"
            input.webkitdirectory = true
            input.style.display = "none"
            input.addEventListener("change", () => {
                resolve(Array.from(input.files ?? []))
                input.remove()
            })
            input.addEventListener("cancel", () => {
                resolve([])
                input.remove()
            })
            document.body.appendChild(input)
            input.click()
        })
    }
}
