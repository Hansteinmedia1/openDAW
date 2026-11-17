import {Color} from "@opendaw/lib-std"

export const ColorSchemes = ["basalt", "classic", "modern", "contrast"] as const

export type ColorScheme = typeof ColorSchemes[number]

export const DefaultColorScheme: ColorScheme = "basalt"

type NeutralName = "bright" | "gray" | "dark" | "shadow" | "black" | "background" | "panelBackground"
    | "panelBackgroundBright" | "panelBackgroundDark" | "headerBackground" | "footerBackground"

type Neutral = readonly [saturation: number, lightness: number, hue?: number]

const NeutralHue = 197

const Neutrals: Record<ColorScheme, Record<NeutralName, Neutral>> = {
    basalt: {
        bright: [48, 92, 39], gray: [42, 84, 39], dark: [24, 75, 39], shadow: [11, 62, 38], black: [9, 39],
        background: [16, 8], panelBackground: [15, 13], panelBackgroundBright: [14, 16], panelBackgroundDark: [15, 12],
        headerBackground: [19, 5], footerBackground: [16, 8]
    },
    classic: {
        bright: [5, 100], gray: [31, 91], dark: [15, 84], shadow: [10, 60], black: [10, 30],
        background: [8, 9], panelBackground: [14, 12], panelBackgroundBright: [13, 16], panelBackgroundDark: [14, 11],
        headerBackground: [14, 3], footerBackground: [14, 9]
    },
    modern: {
        bright: [0, 100], gray: [0, 70], dark: [0, 58], shadow: [0, 39], black: [0, 24],
        background: [0, 13], panelBackground: [0, 15], panelBackgroundBright: [0, 20], panelBackgroundDark: [0, 12],
        headerBackground: [0, 18], footerBackground: [0, 11]
    },
    contrast: {
        bright: [10, 100], gray: [10, 96], dark: [10, 90], shadow: [10, 76], black: [10, 58],
        background: [10, 4], panelBackground: [10, 9], panelBackgroundBright: [10, 16], panelBackgroundDark: [10, 6],
        headerBackground: [10, 3], footerBackground: [10, 5]
    }
}

let scheme: ColorScheme = DefaultColorScheme

const neutral = (name: NeutralName): Color => {
    const [saturation, lightness, hue] = Neutrals[scheme][name]
    return new Color(hue ?? NeutralHue, saturation, lightness)
}

export const Colors = {
    white: new Color(0, 0, 100),
    blue: new Color(35, 51, 64),
    green: new Color(150, 77, 69),
    yellow: new Color(51, 86, 63),
    cream: new Color(65, 37, 83),
    orange: new Color(34, 41, 54),
    red: new Color(7, 100, 64),
    purple: new Color(314, 100, 78),
    menuActive: new Color(27, 39, 35),
    get bright(): Color {return neutral("bright")},
    get gray(): Color {return neutral("gray")},
    get dark(): Color {return neutral("dark")},
    get shadow(): Color {return neutral("shadow")},
    get black(): Color {return neutral("black")},
    get background(): Color {return neutral("background")},
    get panelBackground(): Color {return neutral("panelBackground")},
    get panelBackgroundBright(): Color {return neutral("panelBackgroundBright")},
    get panelBackgroundDark(): Color {return neutral("panelBackgroundDark")},
    get headerBackground(): Color {return neutral("headerBackground")},
    get footerBackground(): Color {return neutral("footerBackground")}
}

export const setColorScheme = (value: ColorScheme): void => {scheme = value}

export const initializeColors = (root: { style: { setProperty: (name: string, value: string) => void } }) => {
    Object.entries(Colors).forEach(([name, value]) => {
        const cssName = name.replace(/([A-Z])/g, "-$1").toLowerCase()
        root.style.setProperty(`--color-${cssName}`, value.toString())
    })
}