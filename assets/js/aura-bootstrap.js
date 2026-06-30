/**
 * =========================================================
 * AURA Bootstrap
 * File: assets/js/aura-bootstrap.js
 * Version: 1.1.0
 * Status: Production Bootstrap Layer
 * =========================================================
 */

/* eslint-disable no-console */

const APP_NAME = "AURA";
const APP_VERSION = "1.1.0";
const UI_MODULE_URL = "./aura-console-ui.js";
const MODULE_TIMEOUT_MS = 12000;

const BOOT_EVENTS = Object.freeze({
    START: "aura:boot:start",
    READY: "aura:boot:ready",
    ERROR: "aura:boot:error",
    SHUTDOWN: "aura:shutdown",
    UI_READY: "aura:ui:ready",
});

const isBrowser =
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof globalThis !== "undefined";

const root = globalThis;

const state = {
    bootPromise: null,
    bootController: null,
    booted: false,
    booting: false,
    cancelled: false,
    sequenceId: 0,
    startedAt: 0,
    finishedAt: 0,
    error: null,
    ui: null,
    subscribers: new Map(),
    listenerDisposers: [],
};

function ensureNamespace() {
    const existing = root.AURA;

    if (existing && typeof existing === "object") {
        return existing;
    }

    const namespace = {};
    try {
        root.AURA = namespace;
    } catch {
        // If assignment fails, fall back to the local object.
    }

    return root.AURA && typeof root.AURA === "object" ? root.AURA : namespace;
}

const aura = ensureNamespace();

/**
 * Converts any error-like value into an Error instance.
 * @param {unknown} value
 * @returns {Error}
 */
function toError(value) {
    if (value instanceof Error) {
        return value;
    }

    if (typeof value === "string") {
        return new Error(value);
    }

    try {
        return new Error(JSON.stringify(value));
    } catch {
        return new Error(String(value));
    }
}

/**
 * Returns a safe readable error message.
 * @param {unknown} value
 * @returns {string}
 */
function safeMessage(value) {
    return toError(value).message || "Unknown error";
}

/**
 * Returns a high-resolution timestamp when available.
 * @returns {number}
 */
function now() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
}

/**
 * Returns a promise that resolves when the DOM is ready.
 * @returns {Promise<void>}
 */
function waitForDomReady() {
    if (!isBrowser) {
        return Promise.reject(new Error(`${APP_NAME} requires a browser DOM environment.`));
    }

    if (document.readyState === "interactive" || document.readyState === "complete") {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
}

/**
 * Wraps a promise with a timeout.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, label) {
    let timerId;

    const timeoutPromise = new Promise((_, reject) => {
        timerId = window.setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timerId !== undefined) {
            clearTimeout(timerId);
        }
    });
}

/**
 * Safely invokes a function.
 * @template T
 * @param {() => T} fn
 * @param {T | undefined} [fallback]
 * @returns {T | undefined}
 */
function safeInvoke(fn, fallback = undefined) {
    try {
        return fn();
    } catch (error) {
        console.error(`[${APP_NAME}]`, error);
        return fallback;
    }
}

/**
 * Registers a cleanup callback.
 * @param {() => void} cleanup
 * @returns {void}
 */
function trackCleanup(cleanup) {
    state.listenerDisposers.push(cleanup);
}

/**
 * Adds a listener and tracks it for cleanup.
 * @param {EventTarget} target
 * @param {string} type
 * @param {EventListenerOrEventListenerObject} listener
 * @param {AddEventListenerOptions | boolean} [options]
 * @returns {void}
 */
function addListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    trackCleanup(() => {
        try {
            target.removeEventListener(type, listener, options);
        } catch {
            // Ignore cleanup failures.
        }
    });
}

/**
 * Clears all tracked listeners.
 * @returns {void}
 */
function clearListeners() {
    while (state.listenerDisposers.length > 0) {
        const cleanup = state.listenerDisposers.pop();
        safeInvoke(() => cleanup?.());
    }
}

/**
 * Emits an internal event and a DOM CustomEvent.
 * @param {string} type
 * @param {unknown} [detail]
 * @returns {void}
 */
function emit(type, detail = undefined) {
    const handlers = state.subscribers.get(type);
    if (handlers) {
        for (const handler of handlers) {
            safeInvoke(() => handler(detail));
        }
    }

    if (isBrowser && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        safeInvoke(() => {
            window.dispatchEvent(new CustomEvent(type, { detail }));
        });
    }
}

/**
 * Subscribes to an internal event.
 * @param {string} type
 * @param {(detail: unknown) => void} handler
 * @returns {() => void}
 */
function on(type, handler) {
    if (typeof handler !== "function") {
        throw new TypeError("AURA.on expects a function.");
    }

    const handlers = state.subscribers.get(type) ?? new Set();
    handlers.add(handler);
    state.subscribers.set(type, handlers);

    return () => off(type, handler);
}

/**
 * Unsubscribes from an internal event.
 * @param {string} type
 * @param {(detail: unknown) => void} handler
 * @returns {void}
 */
function off(type, handler) {
    const handlers = state.subscribers.get(type);
    if (!handlers) return;

    handlers.delete(handler);
    if (handlers.size === 0) {
        state.subscribers.delete(type);
    }
}

/**
 * Subscribes once to an internal event.
 * @param {string} type
 * @param {(detail: unknown) => void} handler
 * @returns {() => void}
 */
function once(type, handler) {
    const unsubscribe = on(type, (detail) => {
        unsubscribe();
        handler(detail);
    });

    return unsubscribe;
}

/**
 * Returns a safe runtime snapshot.
 * @returns {{
 *   booted: boolean,
 *   booting: boolean,
 *   cancelled: boolean,
 *   sequenceId: number,
 *   startedAt: number,
 *   finishedAt: number,
 *   hasUi: boolean,
 *   error: string | null
 * }}
 */
function getState() {
    return Object.freeze({
        booted: state.booted,
        booting: state.booting,
        cancelled: state.cancelled,
        sequenceId: state.sequenceId,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        hasUi: Boolean(state.ui),
        error: state.error ? safeMessage(state.error) : null,
    });
}

/**
 * Sets the browser document boot phase.
 * @param {"booting" | "ready" | "error" | "shutdown"} phase
 * @returns {void}
 */
function setDocumentBootPhase(phase) {
    if (!isBrowser) return;

    if (document.documentElement) {
        document.documentElement.dataset.auraBootPhase = phase;
    }

    switch (phase) {
        case "ready":
            document.title = `${APP_NAME} — तैयार`;
            break;
        case "error":
            document.title = `${APP_NAME} — त्रुटि`;
            break;
        case "shutdown":
            document.title = `${APP_NAME} — बंद`;
            break;
        default:
            document.title = `${APP_NAME} — प्रारम्भ`;
            break;
    }
}

/**
 * Writes text into a DOM node by id.
 * @param {string} id
 * @param {string} text
 * @returns {void}
 */
function setNodeText(id, text) {
    if (!isBrowser) return;

    const node = document.getElementById(id);
    if (node) {
        node.textContent = text;
    }
}

/**
 * Reads the output surface safely.
 * @returns {string}
 */
function readOutputSurface() {
    if (!isBrowser) return "";

    const output = document.getElementById("outputConsole");
    if (!output) return "";

    if (output instanceof HTMLTextAreaElement) {
        return output.value ?? "";
    }

    return output.textContent ?? "";
}

/**
 * Writes text to the output surface safely.
 * @param {string} text
 * @returns {void}
 */
function writeOutputSurface(text) {
    if (!isBrowser) return;

    const output = document.getElementById("outputConsole");
    if (!output) return;

    const value = String(text ?? "");

    if (output instanceof HTMLTextAreaElement) {
        output.value = value;
    } else {
        output.textContent = value;
    }
}

/**
 * Appends text to the output surface safely.
 * @param {string} text
 * @returns {void}
 */
function appendOutputSurface(text) {
    const current = readOutputSurface().trim();
    const next = current ? `${current}\n${String(text ?? "")}` : String(text ?? "");
    writeOutputSurface(next);
}

/**
 * Updates system status, with UI module fallback.
 * @param {string} text
 * @param {boolean} [online=false]
 * @returns {void}
 */
function setStatus(text, online = false) {
    if (state.ui && typeof state.ui.setSystemStatus === "function") {
        safeInvoke(() => state.ui.setSystemStatus(text, online));
        return;
    }

    setNodeText("systemStatus", text);

    if (isBrowser) {
        const indicator = document.getElementById("systemIndicator");
        if (indicator) {
            indicator.classList.toggle("online", Boolean(online));
            indicator.classList.toggle("offline", !online);
        }
    }
}

/**
 * Updates engine status, with UI module fallback.
 * @param {string} text
 * @returns {void}
 */
function setEngineStatus(text) {
    if (state.ui && typeof state.ui.setEngineStatus === "function") {
        safeInvoke(() => state.ui.setEngineStatus(text));
        return;
    }

    setNodeText("engineStatus", text);
}

/**
 * Updates memory status, with UI module fallback.
 * @param {string} text
 * @returns {void}
 */
function setMemoryStatus(text) {
    if (state.ui && typeof state.ui.setMemoryStatus === "function") {
        safeInvoke(() => state.ui.setMemoryStatus(text));
        return;
    }

    setNodeText("memoryStatus", text);
}

/**
 * Displays a boot or status message.
 * @param {string} message
 * @param {"info" | "success" | "warning" | "error"} [type="info"]
 * @param {string} [title=APP_NAME]
 * @returns {void}
 */
function announce(message, type = "info", title = APP_NAME) {
    const text = String(message ?? "");

    if (state.ui && typeof state.ui.appendOutputBlock === "function") {
        safeInvoke(() => state.ui.appendOutputBlock(title, text));
    } else {
        appendOutputSurface(`[${title}] ${text}`);
    }

    if (state.ui && typeof state.ui.showToast === "function") {
        safeInvoke(() => state.ui.showToast(text, type, title, type === "error" ? 5000 : 2500));
    }
}

/**
 * Renders a fatal error to the best available surface.
 * @param {unknown} error
 * @returns {void}
 */
function renderFatalError(error) {
    const message = [
        `${APP_NAME} बूट असफल हुआ।`,
        "",
        "त्रुटि:",
        safeMessage(error),
    ].join("\n");

    if (state.ui && typeof state.ui.setOutputText === "function") {
        safeInvoke(() => state.ui.setOutputText(message));
    } else {
        writeOutputSurface(message);
    }

    if (state.ui && typeof state.ui.showToast === "function") {
        safeInvoke(() => state.ui.showToast("बूट में त्रुटि हुई।", "error", "त्रुटि", 5000));
    } else if (isBrowser) {
        setStatus("त्रुटि", false);
    }
}

/**
 * Loads the UI module with timeout protection.
 * @returns {Promise<any>}
 */
async function loadUiModule() {
    if (!isBrowser) {
        throw new Error(`${APP_NAME} requires a browser DOM environment.`);
    }

    return withTimeout(import(UI_MODULE_URL), MODULE_TIMEOUT_MS, "UI module load");
}

/**
 * Normalizes the UI API from the loaded module.
 * @param {any} moduleNamespace
 * @returns {any | null}
 */
function resolveUiApi(moduleNamespace) {
    if (!moduleNamespace) return null;

    const candidate = moduleNamespace.default ?? moduleNamespace;

    if (candidate && typeof candidate === "object") {
        return candidate;
    }

    return null;
}

/**
 * Attaches the UI API to bootstrap state.
 * @param {any} uiApi
 * @returns {void}
 */
function attachUiApi(uiApi) {
    if (!uiApi || typeof uiApi !== "object") {
        throw new Error("Invalid UI API.");
    }

    state.ui = uiApi;
    emit(BOOT_EVENTS.UI_READY, uiApi);
}

/**
 * Aborts the current boot session and removes session listeners.
 * @returns {void}
 */
function abortBootSession() {
    if (state.bootController) {
        safeInvoke(() => state.bootController.abort());
        state.bootController = null;
    }

    clearListeners();
}

/**
 * Tears down the current UI instance.
 * @returns {void}
 */
function teardownUi() {
    const ui = state.ui;
    if (!ui) return;

    safeInvoke(() => ui.closeModal?.());
    safeInvoke(() => ui.destroy?.());
    state.ui = null;
}

/**
 * Clears all event subscribers.
 * @returns {void}
 */
function clearSubscribers() {
    state.subscribers.clear();
}

/**
 * Handles boot failure cleanup.
 * @param {unknown} error
 * @returns {void}
 */
function handleBootFailure(error) {
    abortBootSession();
    teardownUi();

    state.error = error;
    state.booting = false;
    state.booted = false;
    state.finishedAt = now();

    if (!state.cancelled) {
        setDocumentBootPhase("error");
        setStatus("बूट असफल", false);
        renderFatalError(error);
        emit(BOOT_EVENTS.ERROR, error);
    }

    if (state.bootPromise) {
        state.bootPromise = null;
    }
}

/**
 * Installs global runtime guards for the active boot session.
 * @param {AbortController} controller
 * @returns {void}
 */
function installGlobalGuards(controller) {
    if (!isBrowser) return;

    const signal = controller?.signal;

    const onError = (event) => {
        const runtimeError = event?.error ?? new Error(event?.message || "Unhandled runtime error");
        state.error = runtimeError;
        console.error(`[${APP_NAME}] Runtime error:`, runtimeError);

        if (state.ui && typeof state.ui.showToast === "function") {
            safeInvoke(() => state.ui.showToast("रनटाइम त्रुटि मिली।", "error", "त्रुटि", 5000));
        }

        emit(BOOT_EVENTS.ERROR, runtimeError);
    };

    const onUnhandledRejection = (event) => {
        const reason = event?.reason ?? new Error("Unhandled promise rejection");
        state.error = toError(reason);
        console.error(`[${APP_NAME}] Unhandled rejection:`, reason);

        if (state.ui && typeof state.ui.showToast === "function") {
            safeInvoke(() => state.ui.showToast("अप्रबंधित त्रुटि मिली।", "error", "त्रुटि", 5000));
        }

        emit(BOOT_EVENTS.ERROR, reason);
    };

    addListener(window, "error", onError, { capture: true, signal });
    addListener(window, "unhandledrejection", onUnhandledRejection, { signal });
}

/**
 * Boots AURA once and returns the shared boot promise.
 * @returns {Promise<Record<string, unknown>>}
 */
function boot() {
    if (!isBrowser) {
        const error = new Error(`${APP_NAME} requires a browser DOM environment.`);
        state.error = error;
        const rejected = Promise.reject(error);
        state.bootPromise = rejected;
        return rejected;
    }

    if (state.bootPromise) {
        return state.bootPromise;
    }

    state.cancelled = false;
    state.booting = true;
    state.booted = false;
    state.error = null;
    state.sequenceId += 1;
    state.startedAt = now();
    state.finishedAt = 0;

    const sessionController = new AbortController();
    state.bootController = sessionController;

    const bootTask = (async () => {
        await waitForDomReady();

        if (state.cancelled) {
            throw new Error("Boot was cancelled before initialization.");
        }

        setDocumentBootPhase("booting");
        installGlobalGuards(sessionController);

        setStatus("प्रारम्भ हो रहा है...", false);
        setEngineStatus("बूट");
        setMemoryStatus("तैयारी");

        emit(BOOT_EVENTS.START, {
            sequenceId: state.sequenceId,
            startedAt: state.startedAt,
        });

        const uiModule = await loadUiModule();

        if (state.cancelled) {
            throw new Error("Boot was cancelled after module loading.");
        }

        const uiApi = resolveUiApi(uiModule);
        if (!uiApi) {
            throw new Error("UI module did not expose a valid API.");
        }

        attachUiApi(uiApi);

        if (typeof uiApi.initialize === "function") {
            await uiApi.initialize();
        }

        if (state.cancelled) {
            throw new Error("Boot was cancelled after UI initialization.");
        }

        state.booted = true;
        state.booting = false;
        state.finishedAt = now();

        setDocumentBootPhase("ready");
        setStatus("तैयार", true);
        setEngineStatus("ऑनलाइन");
        setMemoryStatus("सक्रिय");

        if (!readOutputSurface().trim()) {
            if (state.ui && typeof state.ui.setOutputText === "function") {
                safeInvoke(() => state.ui.setOutputText("AURA तैयार है। आदेश लिखें और चलाएँ।"));
            } else {
                writeOutputSurface("AURA तैयार है। आदेश लिखें और चलाएँ।");
            }
        }

        if (state.ui && typeof state.ui.showToast === "function") {
            safeInvoke(() =>
                state.ui.showToast("AURA सफलतापूर्वक प्रारम्भ हो गया।", "success", "सफल", 2500)
            );
        }

        emit(BOOT_EVENTS.READY, getState());
        return aura;
    })();

    state.bootPromise = bootTask;

    bootTask.catch((error) => {
        handleBootFailure(error);
    });

    return bootTask;
}

/**
 * Shuts AURA down gracefully.
 * @returns {Promise<void>}
 */
async function shutdown() {
    state.cancelled = true;

    const currentBoot = state.bootPromise;

    if (state.bootController) {
        safeInvoke(() => state.bootController.abort());
        state.bootController = null;
    }

    if (currentBoot) {
        try {
            await currentBoot;
        } catch {
            // Boot failure or cancellation is handled elsewhere.
        }
    }

    teardownUi();
    clearListeners();
    clearSubscribers();

    state.bootPromise = null;
    state.booting = false;
    state.booted = false;
    state.finishedAt = now();
    state.cancelled = false;

    setDocumentBootPhase("shutdown");
    emit(BOOT_EVENTS.SHUTDOWN, getState());
}

/**
 * Restarts AURA by shutting it down and booting it again.
 * @returns {Promise<Record<string, unknown>>}
 */
async function restart() {
    await shutdown();
    return boot();
}

/**
 * Logs a message with AURA prefix.
 * @param {string} message
 * @returns {void}
 */
function log(message) {
    console.log(`[${APP_NAME}] ${message}`);
}

/**
 * Sets up the public namespace.
 * @returns {void}
 */
function setupNamespace() {
    try {
        Object.defineProperties(aura, {
            name: {
                value: APP_NAME,
                enumerable: true,
            },
            version: {
                value: APP_VERSION,
                enumerable: true,
            },
            meta: {
                value: Object.freeze({
                    app: APP_NAME,
                    version: APP_VERSION,
                    module: true,
                    entry: import.meta.url,
                }),
                enumerable: true,
            },
            state: {
                get: getState,
                enumerable: true,
            },
            ui: {
                get() {
                    return state.ui;
                },
                enumerable: true,
            },
            ready: {
                get() {
                    return state.bootPromise;
                },
                enumerable: true,
            },
            isBooted: {
                get() {
                    return state.booted;
                },
                enumerable: true,
            },
            isBooting: {
                get() {
                    return state.booting;
                },
                enumerable: true,
            },
            boot: {
                value: boot,
                enumerable: true,
            },
            shutdown: {
                value: shutdown,
                enumerable: true,
            },
            restart: {
                value: restart,
                enumerable: true,
            },
            on: {
                value: on,
                enumerable: true,
            },
            off: {
                value: off,
                enumerable: true,
            },
            once: {
                value: once,
                enumerable: true,
            },
            emit: {
                value: emit,
                enumerable: true,
            },
            getState: {
                value: getState,
                enumerable: true,
            },
            log: {
                value: log,
                enumerable: true,
            },
            events: {
                value: BOOT_EVENTS,
                enumerable: true,
            },
        });
    } catch (error) {
        throw new Error(`Failed to initialize ${APP_NAME} namespace: ${safeMessage(error)}`);
    }
}

setupNamespace();

if (isBrowser) {
    void boot().catch(() => {
        // Boot errors are already handled and rendered.
    });
} else {
    state.error = new Error(`${APP_NAME} requires a browser DOM environment.`);
}

export default aura;
export {
    APP_NAME,
    APP_VERSION,
    BOOT_EVENTS,
    boot,
    shutdown,
    restart,
    getState,
    on,
    off,
    once,
    emit,
    log,
};
