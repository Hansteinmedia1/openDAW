import {isDefined, Nullable, RuntimeNotifier, Terminable, Terminator} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {StudioService} from "@/service/StudioService"

// Follows an Ableton Link session through the local Basalt Link Bridge (a browser cannot speak Link's UDP itself)
export namespace LinkSync {
    type State = {
        type: "state", time: number, tempo: number, beat: number, phase: number, quantum: number
        playing: boolean, peers: number
    }
    type Pong = { type: "pong", id: number, time: number }
    export type Status = { connected: boolean, peers: number, tempo: number, playing: boolean, offsetMillis: number }

    const BridgeUrl = "ws://127.0.0.1:17890"
    const MinLeadMillis = 60
    const lifecycle = new Terminator()
    let socket: Nullable<WebSocket> = null
    let last: Nullable<State> = null
    let offsetMicros = 0
    let bestRoundTrip = Number.POSITIVE_INFINITY
    let pingId = 0
    let pingSentAt = 0
    let applyingTempo = false
    let engineChangeByLink = false
    let startTimer: Nullable<ReturnType<typeof setTimeout>> = null
    let announcedPeers = -1

    export const isActive = (): boolean => isDefined(socket)

    export const status = (): Status => ({
        connected: socket?.readyState === WebSocket.OPEN, peers: last?.peers ?? 0, tempo: last?.tempo ?? 0,
        playing: last?.playing ?? false, offsetMillis: offsetMicros / 1000
    })

    export const toggle = (service: StudioService): void => {
        if (isActive()) {disconnect()} else {connect(service)}
    }

    const send = (message: object): void => {
        if (socket?.readyState === WebSocket.OPEN) {socket.send(JSON.stringify(message))}
    }

    const connect = (service: StudioService): void => {
        const connection = new WebSocket(BridgeUrl)
        socket = connection
        connection.onopen = () => {
            RuntimeNotifier.notify({message: "Link: mit dem Hilfsprogramm verbunden.", icon: "Info"})
            ping()
            const interval = setInterval(ping, 2000)
            lifecycle.own(Terminable.create(() => clearInterval(interval)))
            lifecycle.own(service.projectProfileService.catchupAndSubscribe(() => watchProject(service)))
            lifecycle.own(service.engine.isPlaying.subscribe(owner => onLocalTransport(service, owner.getValue())))
        }
        connection.onmessage = event => {
            const message: State | Pong = JSON.parse(event.data)
            if (message.type === "pong") {onPong(message)} else if (message.type === "state") {onState(service, message)}
        }
        connection.onclose = () => {
            const opened = isDefined(last)
            disconnect()
            RuntimeNotifier.notify(opened
                ? {message: "Link: Verbindung zum Hilfsprogramm getrennt.", icon: "Info"}
                : {
                    message: "Link: Hilfsprogramm nicht gefunden. Starte „Basalt Link Bridge“ auf diesem Rechner.",
                    icon: "Warning"
                })
        }
    }

    const disconnect = (): void => {
        const connection = socket
        socket = null
        last = null
        announcedPeers = -1
        bestRoundTrip = Number.POSITIVE_INFINITY
        cancelStart()
        lifecycle.terminate()
        if (isDefined(connection)) {
            connection.onclose = null
            connection.close()
        }
    }

    const projectLifecycle = new Terminator()
    const watchProject = (service: StudioService): void => {
        projectLifecycle.terminate()
        if (!service.hasProfile) {return}
        const {timelineBox} = service.project
        projectLifecycle.own(timelineBox.bpm.subscribe(owner => {
            if (!applyingTempo) {send({type: "tempo", bpm: owner.getValue()})}
        }))
        if (isDefined(last)) {applyTempo(service, last.tempo)}
    }

    const ping = (): void => {
        pingId++
        pingSentAt = performance.now()
        send({type: "ping", id: pingId})
    }

    const onPong = (pong: Pong): void => {
        if (pong.id !== pingId) {return}
        const received = performance.now()
        const roundTrip = received - pingSentAt
        if (roundTrip > bestRoundTrip * 1.5 && roundTrip > 2) {return}
        bestRoundTrip = Math.min(bestRoundTrip, roundTrip)
        offsetMicros = pong.time - (pingSentAt + received) / 2 * 1000
    }

    const linkNowMicros = (): number => performance.now() * 1000 + offsetMicros

    const applyTempo = (service: StudioService, tempo: number): void => {
        if (!service.hasProfile) {return}
        const {editing, timelineBox} = service.project
        if (Math.abs(timelineBox.bpm.getValue() - tempo) < 0.005) {return}
        applyingTempo = true
        editing.modify(() => timelineBox.bpm.setValue(tempo), false)
        applyingTempo = false
    }

    const onState = (service: StudioService, state: State): void => {
        last = state
        if (state.peers !== announcedPeers) {
            announcedPeers = state.peers
            RuntimeNotifier.notify({
                message: `Link: ${state.peers} weitere Teilnehmer, ${state.tempo.toFixed(1)} BPM.`, icon: "Info"
            })
        }
        applyTempo(service, state.tempo)
        if (!service.hasProfile) {return}
        const playing = service.engine.isPlaying.getValue()
        if (state.playing && !playing && !isDefined(startTimer)) {
            scheduleStart(service, state)
        } else if (!state.playing) {
            cancelStart()
            if (playing) {
                engineChangeByLink = true
                service.engine.stop()
            }
        }
    }

    const scheduleStart = (service: StudioService, state: State): void => {
        const millisPerBeat = 60000 / state.tempo
        const ageMillis = (linkNowMicros() - state.time) / 1000
        const beatsLeft = (state.quantum - state.phase % state.quantum) % state.quantum
        const {outputLatency, baseLatency} = service.audioContext
        const latencyMillis = ((outputLatency ?? 0) + (baseLatency ?? 0)) * 1000
        let delay = beatsLeft * millisPerBeat - ageMillis - latencyMillis
        while (delay < MinLeadMillis) {delay += state.quantum * millisPerBeat}
        startTimer = setTimeout(() => {
            startTimer = null
            if (!service.hasProfile || !(last?.playing ?? false)) {return}
            const {engine, project: {timelineBox: {signature}}} = service
            const bar = PPQN.fromSignature(signature.nominator.getValue(), signature.denominator.getValue())
            engineChangeByLink = true
            engine.setPosition(Math.floor(engine.position.getValue() / bar) * bar)
            engine.play()
        }, delay)
    }

    const cancelStart = (): void => {
        if (isDefined(startTimer)) {
            clearTimeout(startTimer)
            startTimer = null
        }
    }

    const onLocalTransport = (service: StudioService, playing: boolean): void => {
        if (engineChangeByLink) {
            engineChangeByLink = false
            return
        }
        if (playing) {
            // A local start is handed to the session: stop, announce it, and start with everyone on the next bar
            engineChangeByLink = true
            service.engine.stop()
            send({type: "play", playing: true})
        } else {
            send({type: "play", playing: false})
        }
    }
}
