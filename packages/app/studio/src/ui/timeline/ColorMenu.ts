import {MenuItem} from "@opendaw/studio-core"
import {ColorCodes, TrackType} from "@opendaw/studio-adapters"
import {Procedure} from "@opendaw/lib-std"

export namespace ColorMenu {
    const Colors: ReadonlyArray<{ label: string, hue: number }> = [
        {label: "Blue", hue: ColorCodes.forTrackType(TrackType.Audio)},
        {label: "Ochre", hue: ColorCodes.forTrackType(TrackType.Notes)},
        {label: "Teal", hue: ColorCodes.forTrackType(TrackType.Value)},
        {label: "Moss", hue: 84.0},
        {label: "Lava", hue: 18.0},
        {label: "Rust", hue: 346.0},
        {label: "Amethyst", hue: 260.0}
    ].sort((a, b) => a.hue - b.hue)

    export const createItem = (procedure: Procedure<number>) => MenuItem.default({label: "Color"})
        .setRuntimeChildrenProcedure(parent => parent
            .addMenuItem(...Colors.map(({label, hue}) => MenuItem.default({label})
                .setTriggerProcedure(() => procedure(hue)))))
}