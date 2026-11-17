import {Fonts} from "@/ui/Fonts"
import {loadFont} from "@opendaw/lib-dom"
import {Lazy} from "@opendaw/lib-std"

export class FontLoader {
    @Lazy
    static async load() {
        return Promise.allSettled([
            loadFont(Fonts.SchibstedGrotesk), loadFont(Fonts.SchibstedGroteskItalic),
            loadFont(Fonts.PlexMono), loadFont(Fonts.PlexMonoMedium), loadFont(Fonts.OpenSans)
        ])
    }
}