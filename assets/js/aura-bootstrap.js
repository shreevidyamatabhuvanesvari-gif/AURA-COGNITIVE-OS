/**
 * =========================================================
 * AURA Bootstrap
 * File: assets/js/aura-bootstrap.js
 * Version: 1.2.1
 * Status: Production Bootstrap Layer
 * =========================================================
 *
 * Responsibilities:
 * - Detect application mode vs URL test mode
 * - Load the engine loader deterministically
 * - Load the UI only in app mode
 * - Execute URL-driven diagnostics in test mode
 * - Keep app initialization and diagnostics separated
 * - Expose a stable public bootstrap API on window.AURA
 */

/* eslint-disable no-console */

const APP_NAME = "AURA";
const APP_VERSION = "1.2.1";
const MODULE_TIMEOUT_MS = 15000;

const MODULE_URLS = Object.freeze({
    engineLoader: new URL("./engine-loader.js", import.meta.url).href,
    ui: new URL("./aura-console-ui.js", import.meta.url).href,
});

const BOOT_EVENTS = Object.freeze({
    START: "aura:boot:start",
    READY: "aura:boot:ready",
    ERROR: "aura:boot:error",
    SHUTDOWN: "aura:shutdown",
    TEST_START: "aura:test:start",
    TEST_READY: "aura:test:ready",
    TEST_ERROR: "aura:test:error",
});

const root = globalThis;
const isBrowser =
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof location !== "undefined";

const state = {
    bootPromise: null,
    startedAt: 0,
    finishedAt: 0,
    booted: false,
    mode: "app",
    testMode: false,
    request: null,
    loader: null,
    ui: null,
    lastResult: null,
    lastError: null,
    guardsInstalled: false,
    listenerDisposers: [],
    subscribers: new Map(),
};

function ensureNamespace() {
    if (root.AURA === undefined) {
        root.AURA = {};
    }

    if (!root.AURA || typeof root.AURA !== "object") {
        throw new Error("Global AURA exists but is not an object.");
    }

    return root.AURA;
}

const aura = ensureNamespace();

/**
 * @typedef {Object} BootstrapRequest
 * @property {boolean} testMode
 * @property {string} action
 * @property {string | null} modulePath
 * @property {string | null} groupName
 * @property {string | null} moduleName
 * @property {boolean} autoInitialize
 */

/**
 * @typedef {Object} DiagnosticResult
 * @property {boolean} success
 * @property {string} action
 * @property {string} timestamp
 * @property {number} executionTimeMs
 * @property {unknown} [error]
 */

function now() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
}

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

function safeMessage(value) {
    return toError(value).message || "Unknown error";
}

function withTimeout(promise, timeoutMs, label) {
    let timerId;

    const timeoutPromise = new Promise((_, reject) => {
        timerId = window.setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timerId !== undefined) {
            window.clearTimeout(timerId);
        }
    });
}

function waitForDomReady() {
    if (!isBrowser) {
        return Promise.reject(new Error(`${APP_NAME} requires a browser runtime.`));
    }

    if (document.readyState === "interactive" || document.readyState === "complete") {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
}

function getSiteRootUrl() {
    return new URL("./", location.href);
}

function resolveSiteRelativeUrl(rawPath) {
    const value = String(rawPath ?? "").trim();

    if (!value) {
        throw new Error("Module path is required.");
    }

    if (
        value.includes("://") ||
        value.startsWith("//") ||
        value.includes("\\") ||
        value.includes("\0")
    ) {
        throw new Error(`Invalid module path: ${value}`);
    }

    const resolved = new URL(value, location.href);
    const siteRoot = getSiteRootUrl();

    if (resolved.origin !== location.origin) {
        throw new Error(`Cross-origin import blocked: ${value}`);
    }

    if (!resolved.href.startsWith(siteRoot.href)) {
        throw new Error(`Module path escapes the site root: ${value}`);
    }

    return resolved.href;
}

function safeCloneForOutput(value) {
    try {
        if (typeof structuredClone === "function") {
            return structuredClone(value);
        }
    } catch {
        // Fall through.
    }

    try {
        return JSON.parse(
            JSON.stringify(value, (_key, inner) => {
                if (typeof inner === "bigint") return `${inner}n`;
                if (typeof inner === "function") return `[Function ${inner.name || "anonymous"}]`;
                if (inner instanceof Error) {
                    return {
                        name: inner.name,
                        message: inner.message,
                        stack: inner.stack,
                    };
                }
                return inner;
            })
        );
    } catch {
        return value;
    }
}

function serializePayload(payload) {
    if (typeof payload === "string") {
        return payload;
    }

    try {
        return JSON.stringify(payload, null, 2);
    } catch (error) {
        return JSON.stringify(
            {
                success: false,
                error: safeMessage(error),
            },
            null,
            2
        );
    }
}

function renderToConsole(payload) {
    const text = serializePayload(payload);
    const output = document.getElementById("outputConsole");

    if (output instanceof HTMLTextAreaElement) {
        output.value = text;
        return;
    }

    if (output) {
        output.textContent = text;
        return;
    }

    const fallback = document.createElement("pre");
    fallback.textContent = text;
    fallback.style.cssText = [
        "margin:16px",
        "padding:16px",
        "border:1px solid #334155",
        "background:#020617",
        "color:#f8fafc",
        "white-space:pre-wrap",
        "font-family:monospace",
    ].join(";");
    document.body.appendChild(fallback);
}

function setStatus(text, online = false) {
    const status = document.getElementById("systemStatus");
    const indicator = document.getElementById("systemIndicator");

    if (status) {
        status.textContent = text;
    }

    if (indicator) {
        indicator.classList.toggle("online", Boolean(online));
        indicator.classList.toggle("offline", !online);
    }
}

function setDocumentBootPhase(phase) {
    if (!isBrowser) return;

    if (document.documentElement) {
        document.documentElement.dataset.auraBootPhase = phase;
        document.documentElement.dataset.auraMode = state.testMode ? "test" : "app";
    }

    switch (phase) {
        case "ready":
            document.title = `${APP_NAME} — तैयार`;
            break;
        case "test-ready":
            document.title = `${APP_NAME} — परीक्षण सफल`;
            break;
        case "error":
        case "test-error":
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

function emit(type, detail = undefined) {
    const handlers = state.subscribers.get(type);

    if (handlers) {
        for (const handler of handlers) {
            try {
                handler(detail);
            } catch (error) {
                console.error(`[${APP_NAME}] Event handler error:`, error);
            }
        }
    }

    if (isBrowser && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        try {
            window.dispatchEvent(new CustomEvent(type, { detail }));
        } catch {
            // Best-effort only.
        }
    }
}

function on(type, handler) {
    if (typeof handler !== "function") {
        throw new TypeError("Event handler must be a function.");
    }

    const handlers = state.subscribers.get(type) ?? new Set();
    handlers.add(handler);
    state.subscribers.set(type, handlers);

    return () => off(type, handler);
}

function off(type, handler) {
    const handlers = state.subscribers.get(type);
    if (!handlers) return;

    handlers.delete(handler);
    if (handlers.size === 0) {
        state.subscribers.delete(type);
    }
}

function once(type, handler) {
    const unsubscribe = on(type, (detail) => {
        unsubscribe();
        handler(detail);
    });

    return unsubscribe;
}

function addTrackedListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    state.listenerDisposers.push(() => {
        try {
            target.removeEventListener(type, listener, options);
        } catch {
            // Ignore cleanup failures.
        }
    });
}

function clearTrackedListeners() {
    while (state.listenerDisposers.length > 0) {
        const dispose = state.listenerDisposers.pop();
        try {
            dispose?.();
        } catch {
            // Ignore cleanup failures.
        }
    }
}

function installRuntimeGuards() {
    if (state.guardsInstalled || !isBrowser) {
        return;
    }

    const onError = (event) => {
        const error = event?.error ?? new Error(event?.message || "Unhandled runtime error");
        state.lastError = error;
        emit(BOOT_EVENTS.ERROR, error);
        console.error(`[${APP_NAME}] Runtime error:`, error);
    };

    const onUnhandledRejection = (event) => {
        const error = event?.reason ?? new Error("Unhandled promise rejection");
        state.lastError = error;
        emit(BOOT_EVENTS.ERROR, error);
        console.error(`[${APP_NAME}] Unhandled rejection:`, error);
    };

    addTrackedListener(window, "error", onError, { capture: true });
    addTrackedListener(window, "unhandledrejection", onUnhandledRejection);
    state.guardsInstalled = true;
}

function removeRuntimeGuards() {
    if (!state.guardsInstalled) {
        return;
    }

    clearTrackedListeners();
    state.guardsInstalled = false;
}

function parseBootstrapRequest() {
    const params = new URLSearchParams(location.search);

    const mode = String(params.get("mode") ?? "").trim().toLowerCase();
    const testFlag = String(params.get("test") ?? "").trim().toLowerCase();
    const testMode =
        mode === "test" ||
        testFlag === "1" ||
        testFlag === "true" ||
        testFlag === "yes";

    const action = String(
        params.get("action") ?? (params.has("module") ? "import" : "boot")
    )
        .trim()
        .toLowerCase();

    return {
        testMode,
        action,
        modulePath: params.get("module") ?? params.get("path") ?? null,
        groupName: params.get("group") ?? null,
        moduleName: params.get("moduleName") ?? params.get("module") ?? null,
        autoInitialize: String(params.get("autoInitialize") ?? "true") !== "false",
    };
}

function summarizeRequest(request) {
    return {
        testMode: request.testMode,
        action: request.action,
        modulePath: request.modulePath,
        groupName: request.groupName,
        moduleName: request.moduleName,
        autoInitialize: request.autoInitialize,
    };
}

function getState() {
    return Object.freeze({
        mode: state.mode,
        testMode: state.testMode,
        booted: state.booted,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        hasLoader: Boolean(state.loader),
        hasUi: Boolean(state.ui),
        lastError: state.lastError ? safeMessage(state.lastError) : null,
        request: state.request ? summarizeRequest(state.request) : null,
        diagnostics: state.lastResult ? safeCloneForOutput(state.lastResult) : null,
    });
}

function getLoaderApi() {
    return state.loader ?? aura.engineLoader ?? null;
}

async function loadEngineLoader() {
    if (state.loader) {
        return state.loader;
    }

    const moduleNamespace = await withTimeout(
        import(MODULE_URLS.engineLoader),
        MODULE_TIMEOUT_MS,
        "Engine loader load"
    );

    const loaderApi =
        moduleNamespace.default ??
        moduleNamespace.engineLoader ??
        aura.engineLoader ??
        null;

    if (!loaderApi) {
        throw new Error("Engine loader API is unavailable after import.");
    }

    state.loader = loaderApi;
    return loaderApi;
}

async function loadUiModule() {
    if (state.ui) {
        return state.ui;
    }

    const moduleNamespace = await withTimeout(
        import(MODULE_URLS.ui),
        MODULE_TIMEOUT_MS,
        "UI module load"
    );

    const uiApi = moduleNamespace.default ?? aura.ui ?? null;

    if (!uiApi) {
        throw new Error("UI module API is unavailable after import.");
    }

    if (typeof uiApi.initialize === "function") {
        const uiState = typeof uiApi.getState === "function" ? uiApi.getState() : null;
        if (!uiState || !uiState.initialized) {
            await uiApi.initialize();
        }
    }

    state.ui = uiApi;
    return uiApi;
}

async function initializeAppRuntime() {
    await loadEngineLoader();
    await loadUiModule();
}

async function runDiagnostics(request) {
    const loader = await loadEngineLoader();
    const startedAt = now();

    emit(BOOT_EVENTS.TEST_START, summarizeRequest(request));

    switch (request.action) {
        case "boot":
            return {
                success: true,
                action: "boot",
                auraVersion: APP_VERSION,
                auraState: getState(),
                loaderState: safeCloneForOutput(loader.getState?.() ?? null),
                timestamp: new Date().toISOString(),
                executionTimeMs: Number((now() - startedAt).toFixed(2)),
            };

        case "state":
            return {
                success: true,
                action: "state",
                auraState: getState(),
                loaderState: safeCloneForOutput(loader.getState?.() ?? null),
                timestamp: new Date().toISOString(),
                executionTimeMs: Number((now() - startedAt).toFixed(2)),
            };

        case "manifest":
            return {
                success: true,
                action: "manifest",
                manifest: safeCloneForOutput(loader.getManifest?.() ?? null),
                timestamp: new Date().toISOString(),
                executionTimeMs: Number((now() - startedAt).toFixed(2)),
            };

        case "import": {
            const modulePath = request.modulePath;
            const moduleUrl = resolveSiteRelativeUrl(modulePath);
            const namespace = await import(moduleUrl);

            return {
                success: true,
                action: "import",
                module: modulePath,
                moduleUrl,
                exports: Object.keys(namespace),
                hasDefault: Object.prototype.hasOwnProperty.call(namespace, "default"),
                defaultType: typeof namespace.default,
                timestamp: new Date().toISOString(),
                executionTimeMs: Number((now() - startedAt).toFixed(2)),
            };
        }

        case "load-group": {
            if (!request.groupName) {
                throw new Error("Group name is required for load-group.");
            }

            const result = await loader.loadGroup(request.groupName, {
                autoInitialize: request.autoInitialize,
            });

            return {
                success: true,
                action: "load-group",
                groupName: result.groupName,
                modules: result.modules.map((item) => item.moduleName),
                failedModules: result.failedModules.map((item) => item.moduleName),
                durationMs: result.durationMs,
                timestamp: new Date().toISOString(),
                executionTimeMs: Number((now() - startedAt).toFixed(2)),
            };
        }

        case "load-module": {
            if (!request.groupName) {
                throw new Error("Group name is required for load-module.");
            }

            if (!request.moduleName) {
                throw new Error("Module name is required for load-module.");
            }

            const namespace = await loader.loadModule(request.groupName, request.moduleName, {
                autoInitialize: request.autoInitialize,
            });

            return {
                success: true,
                action: "load-module",
                groupName: request.groupName,
                moduleName: request.moduleName,
                exports: Object.keys(namespace ?? {}),
                hasDefault: Boolean(namespace && Object.prototype.hasOwnProperty.call(namespace, "default")),
                timestamp: new Date().toISOString(),
                executionTimeMs: Number((now() - startedAt).toFixed(2)),
            };
        }

        case "load-all": {
            const result = await loader.loadAll({
                autoInitialize: request.autoInitialize,
            });

            return {
                success: true,
                action: "load-all",
                groupCount: result.length,
                loadedModules: result.reduce((count, group) => count + group.modules.length, 0),
                failedModules: result.reduce((count, group) => count + group.failedModules.length, 0),
                timestamp: new Date().toISOString(),
                executionTimeMs: Number((now() - startedAt).toFixed(2)),
            };
        }

        default:
            throw new Error(`Unknown diagnostic action: ${request.action}`);
    }
}

async function initializeTestMode(request) {
    const result = await runDiagnostics(request);
    state.lastResult = result;

    renderToConsole(result);
    setStatus(result.success ? "परीक्षण सफल" : "परीक्षण असफल", Boolean(result.success));

    emit(result.success ? BOOT_EVENTS.TEST_READY : BOOT_EVENTS.TEST_ERROR, result);
}

async function initializeAppMode() {
    await initializeAppRuntime();

    setStatus("तैयार", true);

    const output = document.getElementById("outputConsole");
    const outputText = output ? String(output.textContent ?? "").trim() : "";

    if (!outputText) {
        if (state.ui && typeof state.ui.setOutputText === "function") {
            state.ui.setOutputText("AURA तैयार है। आदेश लिखें और चलाएँ।");
        } else {
            renderToConsole("AURA तैयार है। आदेश लिखें और चलाएँ।");
        }
    }

    const toastApi = state.ui?.showToast;
    if (typeof toastApi === "function") {
        try {
            toastApi.call(state.ui, "AURA सफलतापूर्वक प्रारम्भ हो गया।", "success", "सफल", 2500);
        } catch {
            // Best-effort only.
        }
    }
}

function setReadyPromise(promise) {
    state.bootPromise = promise;
}

function boot() {
    if (state.bootPromise) {
        return state.bootPromise;
    }

    if (!isBrowser) {
        const error = new Error(`${APP_NAME} requires a browser runtime.`);
        state.lastError = error;
        const rejected = Promise.reject(error);
        rejected.catch(() => {
            // Prevent unhandled rejection noise if imported outside browser.
        });
        setReadyPromise(rejected);
        return rejected;
    }

    state.request = parseBootstrapRequest();
    state.testMode = state.request.testMode;
    state.mode = state.testMode ? "test" : "app";
    state.startedAt = Date.now();
    state.finishedAt = 0;
    state.booted = false;
    state.lastError = null;
    state.lastResult = null;

    const bootPromise = (async () => {
        await waitForDomReady();

        installRuntimeGuards();
        setDocumentBootPhase(state.testMode ? "test-booting" : "booting");
        setStatus(state.testMode ? "परीक्षण प्रारम्भ" : "प्रारम्भ हो रहा है...", false);

        if (state.testMode) {
            await initializeTestMode(state.request);
        } else {
            await initializeAppMode();
            emit(BOOT_EVENTS.READY, getState());
        }

        state.booted = true;
        state.finishedAt = Date.now();
        setDocumentBootPhase(state.testMode ? "test-ready" : "ready");

        return aura;
    })().catch((error) => {
        state.lastError = error;
        state.booted = false;
        state.finishedAt = Date.now();

        setDocumentBootPhase(state.testMode ? "test-error" : "error");
        setStatus(state.testMode ? "परीक्षण असफल" : "त्रुटि", false);

        const payload = {
            success: false,
            action: state.request?.action ?? "boot",
            error: safeMessage(error),
            timestamp: new Date().toISOString(),
        };

        state.lastResult = payload;
        renderToConsole(payload);

        emit(state.testMode ? BOOT_EVENTS.TEST_ERROR : BOOT_EVENTS.ERROR, error);

        setReadyPromise(null);
        throw error;
    });

    setReadyPromise(bootPromise);
    return bootPromise;
}

async function shutdown() {
    state.lastError = null;
    state.booted = false;
    state.finishedAt = Date.now();

    try {
        state.ui?.closeModal?.();
    } catch {
        // Ignore.
    }

    try {
        state.ui?.destroy?.();
    } catch {
        // Ignore.
    }

    state.ui = null;
    state.loader = null;
    state.request = null;
    state.lastResult = null;

    removeRuntimeGuards();
    setDocumentBootPhase("shutdown");
    setStatus("बंद", false);
    emit(BOOT_EVENTS.SHUTDOWN, getState());

    setReadyPromise(null);
    await Promise.resolve();
}

async function restart() {
    await shutdown();
    return boot();
}

function log(message) {
    console.log(`[${APP_NAME}] ${message}`);
}

function runDiagnosticsPublic(requestOverride = null) {
    const request = requestOverride
        ? {
              testMode: true,
              action: String(requestOverride.action ?? "boot"),
              modulePath: requestOverride.modulePath ?? requestOverride.module ?? null,
              groupName: requestOverride.groupName ?? requestOverride.group ?? null,
              moduleName: requestOverride.moduleName ?? requestOverride.module ?? null,
              autoInitialize: requestOverride.autoInitialize !== false,
          }
        : state.request;

    if (!request) {
        throw new Error("No diagnostic request is available.");
    }

    return runDiagnostics(request);
}

function attachApi() {
    Object.defineProperties(aura, {
        name: {
            value: APP_NAME,
            enumerable: true,
        },
        version: {
            value: APP_VERSION,
            enumerable: true,
        },
        mode: {
            get() {
                return state.mode;
            },
            enumerable: true,
        },
        testMode: {
            get() {
                return state.testMode;
            },
            enumerable: true,
        },
        request: {
            get() {
                return state.request ? summarizeRequest(state.request) : null;
            },
            enumerable: true,
        },
        ready: {
            get() {
                return state.bootPromise;
            },
            enumerable: true,
        },
        loader: {
            get() {
                return state.loader;
            },
            enumerable: true,
        },
        engineLoader: {
            get() {
                return state.loader;
            },
            enumerable: true,
        },
        ui: {
            get() {
                return state.ui;
            },
            enumerable: true,
        },
        diagnostics: {
            get() {
                return state.lastResult ? safeCloneForOutput(state.lastResult) : null;
            },
            enumerable: true,
        },
        events: {
            value: BOOT_EVENTS,
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
        runDiagnostics: {
            value: runDiagnosticsPublic,
            enumerable: true,
        },
        getState: {
            value: getState,
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
        log: {
            value: log,
            enumerable: true,
        },
    });
}

attachApi();

if (isBrowser) {
    void boot().catch((error) => {
        console.error(`[${APP_NAME}] Bootstrap failed:`, error);
    });
} else {
    state.lastError = new Error(`${APP_NAME} requires a browser runtime.`);
}

export default aura;
export {
    APP_NAME,
    APP_VERSION,
    BOOT_EVENTS,
    boot,
    shutdown,
    restart,
    runDiagnosticsPublic as runDiagnostics,
    getState,
    on,
    off,
    once,
    emit,
    log,
};
