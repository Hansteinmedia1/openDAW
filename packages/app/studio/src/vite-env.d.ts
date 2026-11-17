/// <reference types="vite/client" />

declare module "*.sass?inline" {
    const css: string
    export default css
}

interface ImportMetaEnv {
    readonly BUILD_UUID: string
    readonly VITE_MODEL_BASE_URL?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}