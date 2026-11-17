import {panic, TimeSpan} from "@opendaw/lib-std"
import {network, Promises, RetryOption} from "@opendaw/lib-runtime"

const AttemptTimeout = TimeSpan.seconds(10)
const RetryInterval = TimeSpan.seconds(1)

const IndefiniteRetry = (url: string): RetryOption => ({
    retry: (reason: unknown, exec: () => void): boolean => {
        console.debug(`[ProjectLoad] index '${url}' failed: ${reason} > will retry in ${RetryInterval.toString()}`)
        setTimeout(exec, RetryInterval.millis())
        return true
    }
})

// The published index is the catalogue and project loading waits for it, so this never rejects: a silent
// request is aborted after AttemptTimeout and a fresh one is sent, indefinitely, until one resolves.
// VITE_CLOUD_ASSETS=off: an installation the asset host does not allow (CORS) gets an empty catalogue at once
export const CloudAssetsEnabled = import.meta.env.VITE_CLOUD_ASSETS !== "off"

export const fetchIndex = (url: string, headers: RequestInit): Promise<unknown> =>
    !CloudAssetsEnabled ? Promise.resolve({version: 1, folders: []}) : Promises.retry(() => network
        .limitFetch(`${url}?v=${Date.now()}`, {
            ...headers, cache: "no-cache", signal: AbortSignal.timeout(AttemptTimeout.millis())
        })
        .then(response => response.ok ? response.json() : panic(`${response.status} ${response.statusText}`)),
        IndefiniteRetry(url))
