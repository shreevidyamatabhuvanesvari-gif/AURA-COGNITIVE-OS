/**
 * =========================================================
 * AURA Engine Loader
 * File: assets/js/engine-loader.js
 * Version: 1.1.0
 * Status: Production Loader Layer
 * =========================================================
 */

/* eslint-disable no-console */

const APP_NAME = "AURA";
const APP_VERSION = "1.1.0";
const MODULE_TIMEOUT_MS = 15000;
const MODULE_BASE_URL = new URL(".", import.meta.url).href;

const LOADER_EVENTS = Object.freeze({
    START: "aura:loader:start",
    GROUP_START: "aura:loader:group:start",
    GROUP_READY: "aura:loader:group:ready",
    MODULE_START: "aura:loader:module:start",
    MODULE_READY: "aura:loader:module:ready",
    ERROR: "aura:loader:error",
    READY: "aura:loader:ready",
    RESET: "aura:loader:reset",
});

const isBrowser =
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof globalThis !== "undefined";

const root = globalThis;

const state = {
    activeOperations: 0,
    startedAt: 0,
    finishedAt: 0,
    lastOperation: null,
    lastError: null,
};

const subscribers = new Map();

/** @type {Map<string, GroupDescriptor>} */
const groupRegistry = new Map();

/** @type {string[]} */
const groupOrder = [];

/** @type {Map<string, ModuleRecord>} */
const moduleRecords = new Map();

/** @type {LoaderApi | null} */
let publicApi = null;

/**
 * @typedef {Object} ModuleDescriptor
 * @property {string} name
 * @property {string} path
 * @property {boolean} [critical=true]
 * @property {boolean} [autoInitialize=true]
 */

/**
 * @typedef {Object} ResolvedModuleDescriptor
 * @property {string} name
 * @property {string} path
 * @property {string} url
 * @property {boolean} critical
 * @property {boolean} autoInitialize
 */

/**
 * @typedef {Object} GroupDescriptor
 * @property {string} name
 * @property {ReadonlyArray<ResolvedModuleDescriptor>} modules
 */

/**
 * @typedef {Object} ModuleRecord
 * @property {string} key
 * @property {string} groupName
 * @property {string} moduleName
 * @property {string} url
 * @property {boolean} critical
 * @property {boolean} autoInitialize
 * @property {Promise<any> | null} importPromise
 * @property {Promise<any> | null} initPromise
 * @property {any | null} namespace
 * @property {"idle" | "loading" | "loaded" | "initializing" | "ready" | "failed"} status
 * @property {boolean} initialized
 * @property {unknown} error
 * @property {number} loadedAt
 * @property {number} initializedAt
 * @property {number} failedAt
 */

/**
 * @typedef {Object} LoaderContext
 * @property {string} appName
 * @property {string} appVersion
 * @property {string} groupName
 * @property {string} moduleName
 * @property {string} modulePath
 * @property {string} moduleUrl
 * @property {Readonly<ResolvedModuleDescriptor>} module
 * @property {Record<string, unknown>} namespace
 * @property {Record<string, unknown>} globalAURA
 * @property {ReturnType<typeof getState>} state
 * @property {ReturnType<typeof getManifest>} manifest
 * @property {string[]} groups
 * @property {LoaderApi | null} loader
 * @property {Record<string, unknown>} context
 */

/**
 * @typedef {Object} LoaderApi
 * @property {string} appName
 * @property {string} version
 * @property {LoaderErrorConstructor} LoaderError
 * @property {Record<string, string>} events
 * @property {() => ReturnType<typeof getState>} getState
 * @property {() => ReturnType<typeof getManifest>} getManifest
 * @property {() => string[]} getGroupNames
 * @property {() => string[]} getLoadedModuleUrls
 * @property {() => ReturnType<typeof getModuleStatus>} getModuleStatus
 * @property {(groupName: string, modules: ModuleDescriptor[], options?: { replace?: boolean }) => GroupDescriptor} registerGroup
 * @property {(groupName: string, descriptor: ModuleDescriptor, options?: { replace?: boolean }) => GroupDescriptor} registerModule
 * @property {(groupName: string, moduleName: string, options?: { autoInitialize?: boolean, context?: Record<string, unknown> }) => Promise<any>} loadModule
 * @property {(groupName: string, options?: { autoInitialize?: boolean }) => Promise<GroupLoadResult>} loadGroup
 * @property {(groupNames: string[], options?: { autoInitialize?: boolean }) => Promise<GroupLoadResult[]>} loadGroups
 * @property {(options?: { autoInitialize?: boolean }) => Promise<GroupLoadResult[]>} loadAll
 * @property {(options?: { clearRegistrations?: boolean }) => void} resetLoaderState
 * @property {(type: string, handler: (detail: unknown) => void) => () => void} on
 * @property {(type: string, handler: (detail: unknown) => void) => void} off
 * @property {(type: string, handler: (detail: unknown) => void) => () => void} once
 * @property {(type: string, detail?: unknown) => void} emit
 */

/**
 * @typedef {Object} LoaderErrorOptions
 * @property {unknown} [cause]
 */

/**
 * @typedef {new (code: string, message: string, options?: LoaderErrorOptions) => Error & { code: string }} LoaderErrorConstructor
 */

/**
 * @typedef {Object} GroupLoadResult
 * @property {string} groupName
 * @property {Array<{ moduleName: string, moduleUrl: string, namespace: any }>} modules
 * @property {Array<{ moduleName: string, moduleUrl: string, error: unknown }>} failedModules
 * @property {number} durationMs
 */

/**
 * Returns true when a value is a plain object.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null)
    );
}

/**
 * Custom error type with stable error codes.
 */
class LoaderError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {LoaderErrorOptions} [options]
     */
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = "LoaderError";
        this.code = code;
    }
}

/**
 * @param {unknown} value
 * @returns {Error}
 */
function toError(value) {
    if (value instanceof Error) return value;
    if (typeof value === "string") return new Error(value);

    try {
        return new Error(JSON.stringify(value));
    } catch {
        return new Error(String(value));
    }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeMessage(value) {
    return toError(value).message || "Unknown error";
}

/**
 * @param {string} code
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {LoaderError}
 */
function createLoaderError(code, message, cause) {
    return new LoaderError(code, message, cause === undefined ? {} : { cause });
}

/**
 * @returns {number}
 */
function now() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
}

/**
 * @returns {void}
 */
function assertBrowserRuntime() {
    if (!isBrowser) {
        throw createLoaderError(
            "LOADER_BROWSER_ONLY",
            `${APP_NAME} engine loader requires a browser runtime.`
        );
    }
}

/**
 * @returns {void}
 */
function assertLoaderIdle() {
    if (state.activeOperations > 0) {
        throw createLoaderError(
            "LOADER_BUSY",
            "Cannot mutate or reset the loader while load operations are in progress."
        );
    }
}

/**
 * Ensures the global AURA namespace exists and is extensible.
 * @returns {Record<string, unknown>}
 */
function ensureNamespace() {
    if (root.AURA === undefined) {
        root.AURA = {};
    }

    if (!root.AURA || typeof root.AURA !== "object") {
        throw createLoaderError(
            "LOADER_NAMESPACE_COLLISION",
            "Global AURA exists but is not an object."
        );
    }

    if (!Object.isExtensible(root.AURA)) {
        throw createLoaderError(
            "LOADER_NAMESPACE_LOCKED",
            "Global AURA namespace is not extensible."
        );
    }

    return root.AURA;
}

const aura = ensureNamespace();

/**
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<void>}
 */
function waitForTimeout(timeoutMs, label) {
    return new Promise((_, reject) => {
        const timerId = globalThis.setTimeout(() => {
            reject(createLoaderError("LOADER_TIMEOUT", `${label} timed out after ${timeoutMs} ms.`));
        }, timeoutMs);

        Promise.resolve().finally(() => {
            globalThis.clearTimeout(timerId);
        });
    });
}

/**
 * Wraps a promise with timeout protection.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, label) {
    let timerId;

    const timeoutPromise = new Promise((_, reject) => {
        timerId = globalThis.setTimeout(() => {
            reject(createLoaderError("LOADER_TIMEOUT", `${label} timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timerId !== undefined) {
            globalThis.clearTimeout(timerId);
        }
    });
}

/**
 * Validates and normalizes a group name.
 * @param {string} groupName
 * @returns {string}
 */
function normalizeGroupName(groupName) {
    if (typeof groupName !== "string") {
        throw createLoaderError("LOADER_INVALID_GROUP_NAME", "Group name must be a string.");
    }

    const normalized = groupName.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalized)) {
        throw createLoaderError(
            "LOADER_INVALID_GROUP_NAME",
            `Invalid group name "${groupName}".`
        );
    }

    return normalized;
}

/**
 * Validates and normalizes a module name.
 * @param {string} moduleName
 * @returns {string}
 */
function normalizeModuleName(moduleName) {
    if (typeof moduleName !== "string") {
        throw createLoaderError("LOADER_INVALID_MODULE_NAME", "Module name must be a string.");
    }

    const normalized = moduleName.trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
        throw createLoaderError(
            "LOADER_INVALID_MODULE_NAME",
            `Invalid module name "${moduleName}".`
        );
    }

    return normalized;
}

/**
 * Validates a relative module path and ensures it stays under the loader directory.
 * @param {string} relativePath
 * @returns {string}
 */
function normalizeModulePath(relativePath) {
    if (typeof relativePath !== "string") {
        throw createLoaderError("LOADER_INVALID_MODULE_PATH", "Module path must be a string.");
    }

    const normalized = relativePath.trim();

    if (!normalized.startsWith("./")) {
        throw createLoaderError(
            "LOADER_INVALID_MODULE_PATH",
            `Module path must start with "./": "${relativePath}".`
        );
    }

    if (
        normalized.includes("://") ||
        normalized.startsWith("//") ||
        normalized.includes("\\") ||
        normalized.includes("\0")
    ) {
        throw createLoaderError(
            "LOADER_INVALID_MODULE_PATH",
            `Module path is not allowed: "${relativePath}".`
        );
    }

    if (!/^[./A-Za-z0-9_-]+\.js$/u.test(normalized)) {
        throw createLoaderError(
            "LOADER_INVALID_MODULE_PATH",
            `Module path must be a relative .js file: "${relativePath}".`
        );
    }

    return normalized;
}

/**
 * Resolves a module URL relative to this file and prevents directory escape.
 * @param {string} relativePath
 * @returns {string}
 */
function resolveModuleUrl(relativePath) {
    const normalized = normalizeModulePath(relativePath);
    const resolved = new URL(normalized, import.meta.url);

    if (!resolved.href.startsWith(MODULE_BASE_URL)) {
        throw createLoaderError(
            "LOADER_PATH_ESCAPE",
            `Module path escapes the loader directory: "${relativePath}".`
        );
    }

    return resolved.href;
}

/**
 * Converts an input descriptor to a frozen resolved descriptor.
 * @param {string} groupName
 * @param {ModuleDescriptor} descriptor
 * @returns {ResolvedModuleDescriptor}
 */
function normalizeModuleDescriptor(groupName, descriptor) {
    if (!isPlainObject(descriptor)) {
        throw createLoaderError(
            "LOADER_INVALID_DESCRIPTOR",
            `Invalid module descriptor in group "${groupName}".`
        );
    }

    const name = normalizeModuleName(String(descriptor.name ?? ""));
    const path = normalizeModulePath(String(descriptor.path ?? ""));
    const url = resolveModuleUrl(path);

    return Object.freeze({
        name,
        path,
        url,
        critical: descriptor.critical !== false,
        autoInitialize: descriptor.autoInitialize !== false,
    });
}

/**
 * Builds a frozen group descriptor and validates uniqueness within the group.
 * @param {string} groupName
 * @param {ModuleDescriptor[]} modules
 * @returns {GroupDescriptor}
 */
function buildGroupDescriptor(groupName, modules) {
    const normalizedGroupName = normalizeGroupName(groupName);

    if (!Array.isArray(modules) || modules.length === 0) {
        throw createLoaderError(
            "LOADER_EMPTY_GROUP",
            `Group "${normalizedGroupName}" must contain at least one module.`
        );
    }

    const seenNames = new Set();
    const resolved = modules.map((descriptor) => {
        const moduleDescriptor = normalizeModuleDescriptor(normalizedGroupName, descriptor);

        if (seenNames.has(moduleDescriptor.name)) {
            throw createLoaderError(
                "LOADER_DUPLICATE_MODULE_NAME",
                `Duplicate module name "${moduleDescriptor.name}" in group "${normalizedGroupName}".`
            );
        }

        seenNames.add(moduleDescriptor.name);
        return moduleDescriptor;
    });

    return Object.freeze({
        name: normalizedGroupName,
        modules: Object.freeze(resolved),
    });
}

/**
 * Removes any runtime records belonging to a group.
 * @param {string} groupName
 * @returns {void}
 */
function deleteGroupRecords(groupName) {
    const prefix = `${groupName}/`;
    for (const key of moduleRecords.keys()) {
        if (key.startsWith(prefix)) {
            moduleRecords.delete(key);
        }
    }
}

/**
 * Registers a group in deterministic order.
 * @param {string} groupName
 * @param {ModuleDescriptor[]} modules
 * @param {{ replace?: boolean }} [options]
 * @returns {GroupDescriptor}
 */
function registerGroup(groupName, modules, options = {}) {
    assertLoaderIdle();

    const descriptor = buildGroupDescriptor(groupName, modules);
    const exists = groupRegistry.has(descriptor.name);

    if (exists && !options.replace) {
        throw createLoaderError(
            "LOADER_GROUP_EXISTS",
            `Module group "${descriptor.name}" is already registered.`
        );
    }

    if (exists) {
        deleteGroupRecords(descriptor.name);
    }

    groupRegistry.set(descriptor.name, descriptor);

    if (!exists) {
        groupOrder.push(descriptor.name);
    }

    return descriptor;
}

/**
 * Registers or replaces a module in a group.
 * @param {string} groupName
 * @param {ModuleDescriptor} descriptor
 * @param {{ replace?: boolean }} [options]
 * @returns {GroupDescriptor}
 */
function registerModule(groupName, descriptor, options = {}) {
    assertLoaderIdle();

    const normalizedGroupName = normalizeGroupName(groupName);
    const existing = groupRegistry.get(normalizedGroupName);

    if (!existing) {
        throw createLoaderError(
            "LOADER_UNKNOWN_GROUP",
            `Cannot register module because group "${normalizedGroupName}" does not exist.`
        );
    }

    const moduleDescriptor = normalizeModuleDescriptor(normalizedGroupName, descriptor);
    const key = `${normalizedGroupName}/${moduleDescriptor.name}`;
    const modules = [...existing.modules];
    const index = modules.findIndex((entry) => entry.name === moduleDescriptor.name);

    if (index >= 0 && !options.replace) {
        throw createLoaderError(
            "LOADER_MODULE_EXISTS",
            `Module "${moduleDescriptor.name}" already exists in group "${normalizedGroupName}".`
        );
    }

    if (index >= 0) {
        modules[index] = moduleDescriptor;
    } else {
        modules.push(moduleDescriptor);
    }

    moduleRecords.delete(key);

    const updated = Object.freeze({
        name: existing.name,
        modules: Object.freeze(modules),
    });

    groupRegistry.set(normalizedGroupName, updated);
    return updated;
}

/**
 * Returns a stable record for a module owner.
 * @param {string} groupName
 * @param {ResolvedModuleDescriptor} descriptor
 * @returns {ModuleRecord}
 */
function getOrCreateModuleRecord(groupName, descriptor) {
    const key = `${groupName}/${descriptor.name}`;
    const existing = moduleRecords.get(key);
    if (existing) {
        return existing;
    }

    /** @type {ModuleRecord} */
    const record = {
        key,
        groupName,
        moduleName: descriptor.name,
        url: descriptor.url,
        critical: descriptor.critical,
        autoInitialize: descriptor.autoInitialize,
        importPromise: null,
        initPromise: null,
        namespace: null,
        status: "idle",
        initialized: false,
        error: null,
        loadedAt: 0,
        initializedAt: 0,
        failedAt: 0,
    };

    moduleRecords.set(key, record);
    return record;
}

/**
 * Returns a module initializer if the module exposes one.
 * Supported forms:
 * - export function initialize(context) {}
 * - export default { initialize(context) {} }
 * - export default function initialize(context) {}
 * @param {any} namespace
 * @returns {((context: LoaderContext) => unknown|Promise<unknown>) | null}
 */
function getModuleInitializer(namespace) {
    if (!namespace || typeof namespace !== "object") {
        return null;
    }

    if (typeof namespace.initialize === "function") {
        return namespace.initialize.bind(namespace);
    }

    if (typeof namespace.default === "function") {
        return namespace.default;
    }

    if (
        namespace.default &&
        typeof namespace.default === "object" &&
        typeof namespace.default.initialize === "function"
    ) {
        return namespace.default.initialize.bind(namespace.default);
    }

    return null;
}

/**
 * Returns a frozen runtime snapshot.
 * @returns {{
 *   activeOperations: number,
 *   startedAt: number,
 *   finishedAt: number,
 *   lastOperation: string | null,
 *   lastError: string | null,
 *   registeredGroups: number,
 *   registeredModules: number,
 *   loadedModules: number,
 *   initializedModules: number,
 *   failedModules: number
 * }}
 */
function getState() {
    let loadedModules = 0;
    let initializedModules = 0;
    let failedModules = 0;

    for (const record of moduleRecords.values()) {
        if (record.namespace !== null) {
            loadedModules += 1;
        }
        if (record.initialized) {
            initializedModules += 1;
        }
        if (record.status === "failed") {
            failedModules += 1;
        }
    }

    return Object.freeze({
        activeOperations: state.activeOperations,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        lastOperation: state.lastOperation,
        lastError: state.lastError ? safeMessage(state.lastError) : null,
        registeredGroups: groupRegistry.size,
        registeredModules: Array.from(groupRegistry.values()).reduce(
            (count, group) => count + group.modules.length,
            0
        ),
        loadedModules,
        initializedModules,
        failedModules,
    });
}

/**
 * Returns a plain manifest snapshot.
 * @returns {Record<string, Array<{ name: string, path: string, critical: boolean, autoInitialize: boolean }>>}
 */
function getManifest() {
    const snapshot = {};

    for (const groupName of groupOrder) {
        const group = groupRegistry.get(groupName);
        if (!group) continue;

        snapshot[groupName] = group.modules.map((module) => ({
            name: module.name,
            path: module.path,
            critical: module.critical,
            autoInitialize: module.autoInitialize,
        }));
    }

    return snapshot;
}

/**
 * Returns registered group names in loading order.
 * @returns {string[]}
 */
function getGroupNames() {
    return [...groupOrder];
}

/**
 * Returns all loaded module URLs without duplicates.
 * @returns {string[]}
 */
function getLoadedModuleUrls() {
    return [...new Set(
        Array.from(moduleRecords.values())
            .filter((record) => record.namespace !== null)
            .map((record) => record.url)
    )];
}

/**
 * Returns module status snapshots for diagnostics.
 * @returns {Array<{
 *   key: string,
 *   groupName: string,
 *   moduleName: string,
 *   url: string,
 *   critical: boolean,
 *   autoInitialize: boolean,
 *   status: string,
 *   initialized: boolean,
 *   loadedAt: number,
 *   initializedAt: number,
 *   failedAt: number,
 *   error: string | null
 * }>}
 */
function getModuleStatus() {
    return Array.from(moduleRecords.values()).map((record) => ({
        key: record.key,
        groupName: record.groupName,
        moduleName: record.moduleName,
        url: record.url,
        critical: record.critical,
        autoInitialize: record.autoInitialize,
        status: record.status,
        initialized: record.initialized,
        loadedAt: record.loadedAt,
        initializedAt: record.initializedAt,
        failedAt: record.failedAt,
        error: record.error ? safeMessage(record.error) : null,
    }));
}

/**
 * Creates the public loader API reference.
 * @returns {LoaderApi}
 */
function getApi() {
    return publicApi ?? /** @type {LoaderApi | null} */ (aura.engineLoader ?? null);
}

/**
 * Registers an event handler.
 * @param {string} type
 * @param {(detail: unknown) => void} handler
 * @returns {() => void}
 */
function on(type, handler) {
    if (typeof handler !== "function") {
        throw createLoaderError("LOADER_INVALID_HANDLER", "Event handler must be a function.");
    }

    const handlers = subscribers.get(type) ?? new Set();
    handlers.add(handler);
    subscribers.set(type, handlers);

    return () => off(type, handler);
}

/**
 * Unregisters an event handler.
 * @param {string} type
 * @param {(detail: unknown) => void} handler
 * @returns {void}
 */
function off(type, handler) {
    const handlers = subscribers.get(type);
    if (!handlers) return;

    handlers.delete(handler);
    if (handlers.size === 0) {
        subscribers.delete(type);
    }
}

/**
 * Registers a once-only event handler.
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
 * Emits an internal event and a DOM CustomEvent when available.
 * @param {string} type
 * @param {unknown} [detail]
 * @returns {void}
 */
function emit(type, detail = undefined) {
    const handlers = subscribers.get(type);
    if (handlers) {
        for (const handler of handlers) {
            try {
                handler(detail);
            } catch (error) {
                console.error(`[${APP_NAME}] Event handler error:`, error);
            }
        }
    }

    if (isBrowser && typeof root.dispatchEvent === "function" && typeof CustomEvent === "function") {
        try {
            root.dispatchEvent(new CustomEvent(type, { detail }));
        } catch {
            // DOM event emission is best-effort only.
        }
    }
}

/**
 * Wraps a module import in a stable, retry-safe promise.
 * @param {ModuleRecord} record
 * @param {ResolvedModuleDescriptor} descriptor
 * @returns {Promise<any>}
 */
function getImportPromise(record, descriptor) {
    if (record.importPromise) {
        return record.importPromise;
    }

    record.status = "loading";

    const promise = import(record.url)
        .then((namespace) => {
            record.namespace = namespace;
            record.loadedAt = Date.now();
            record.status = "loaded";
            record.error = null;
            return namespace;
        })
        .catch((error) => {
            record.failedAt = Date.now();
            record.status = "failed";
            record.error = error;
            record.importPromise = null;
            throw createLoaderError(
                "MODULE_IMPORT_FAILED",
                `Failed to load module "${descriptor.name}" from "${descriptor.path}": ${safeMessage(error)}`,
                error
            );
        });

    record.importPromise = withTimeout(
        promise,
        MODULE_TIMEOUT_MS,
        `Module load (${descriptor.name})`
    ).catch((error) => {
        record.failedAt = Date.now();
        record.status = "failed";
        record.error = error;
        record.importPromise = null;
        throw error;
    });

    return record.importPromise;
}

/**
 * Returns a stable initialization promise, executed exactly once.
 * @param {ModuleRecord} record
 * @param {ResolvedModuleDescriptor} descriptor
 * @param {LoaderContext} context
 * @param {any} namespace
 * @param {boolean} shouldInitialize
 * @returns {Promise<any>}
 */
function getInitializationPromise(record, descriptor, context, namespace, shouldInitialize) {
    if (record.initialized) {
        return Promise.resolve(namespace);
    }

    if (record.initPromise) {
        return record.initPromise;
    }

    const initializer = getModuleInitializer(namespace);

    if (!shouldInitialize || !initializer) {
        record.initialized = true;
        record.initializedAt = Date.now();
        record.status = "ready";
        return Promise.resolve(namespace);
    }

    record.status = "initializing";

    record.initPromise = Promise.resolve()
        .then(() => initializer(context))
        .then(() => {
            record.initialized = true;
            record.initializedAt = Date.now();
            record.status = "ready";
            return namespace;
        })
        .catch((error) => {
            record.initialized = false;
            record.initializedAt = 0;
            record.failedAt = Date.now();
            record.status = "failed";
            record.error = error;
            record.initPromise = null;
            throw createLoaderError(
                "MODULE_INIT_FAILED",
                `Failed to initialize module "${descriptor.name}" from "${descriptor.path}": ${safeMessage(error)}`,
                error
            );
        });

    return record.initPromise;
}

/**
 * Builds a frozen initializer context.
 * @param {string} groupName
 * @param {ResolvedModuleDescriptor} descriptor
 * @param {string} moduleUrl
 * @param {Record<string, unknown>} [extraContext]
 * @returns {LoaderContext}
 */
function buildContext(groupName, descriptor, moduleUrl, extraContext = {}) {
    const context = {
        appName: APP_NAME,
        appVersion: APP_VERSION,
        groupName,
        moduleName: descriptor.name,
        modulePath: descriptor.path,
        moduleUrl,
        module: Object.freeze({
            name: descriptor.name,
            path: descriptor.path,
            url: moduleUrl,
            critical: descriptor.critical,
            autoInitialize: descriptor.autoInitialize,
        }),
        namespace: aura,
        globalAURA: aura,
        state: getState(),
        manifest: getManifest(),
        groups: getGroupNames(),
        loader: getApi(),
        context: Object.freeze(isPlainObject(extraContext) ? { ...extraContext } : {}),
    };

    return Object.freeze(context);
}

/**
 * Internal module load without operation accounting.
 * @param {string} groupName
 * @param {string} moduleName
 * @param {{ autoInitialize?: boolean, context?: Record<string, unknown> }} [options]
 * @returns {Promise<any>}
 */
async function performLoadModule(groupName, moduleName, options = {}) {
    assertBrowserRuntime();

    const normalizedGroupName = normalizeGroupName(groupName);
    const normalizedModuleName = normalizeModuleName(moduleName);
    const group = requireGroup(normalizedGroupName);
    const descriptor = group.modules.find((entry) => entry.name === normalizedModuleName);

    if (!descriptor) {
        throw createLoaderError(
            "LOADER_UNKNOWN_MODULE",
            `Unknown module "${normalizedGroupName}/${normalizedModuleName}".`
        );
    }

    const record = getOrCreateModuleRecord(normalizedGroupName, descriptor);

    if (record.status === "ready" && record.initialized && record.namespace !== null) {
        return record.namespace;
    }

    const shouldInitialize = (options.autoInitialize ?? true) && descriptor.autoInitialize !== false;

    const namespace = await getImportPromise(record, descriptor);
    const context = buildContext(normalizedGroupName, descriptor, descriptor.url, options.context);

    await getInitializationPromise(record, descriptor, context, namespace, shouldInitialize);

    record.status = "ready";
    return namespace;
}

/**
 * Internal group load without operation accounting.
 * @param {string} groupName
 * @param {{ autoInitialize?: boolean }} [options]
 * @returns {Promise<GroupLoadResult>}
 */
async function performLoadGroup(groupName, options = {}) {
    assertBrowserRuntime();

    const normalizedGroupName = normalizeGroupName(groupName);
    const group = requireGroup(normalizedGroupName);
    const started = now();
    const loadedModules = [];
    const failedModules = [];

    emit(LOADER_EVENTS.GROUP_START, {
        groupName: normalizedGroupName,
        moduleCount: group.modules.length,
    });

    for (const descriptor of group.modules) {
        try {
            const namespace = await performLoadModule(normalizedGroupName, descriptor.name, {
                autoInitialize: options.autoInitialize,
            });

            loadedModules.push({
                moduleName: descriptor.name,
                moduleUrl: descriptor.url,
                namespace,
            });
        } catch (error) {
            failedModules.push({
                moduleName: descriptor.name,
                moduleUrl: descriptor.url,
                error,
            });

            if (descriptor.critical !== false) {
                throw createLoaderError(
                    "LOADER_GROUP_FAILED",
                    `Group "${normalizedGroupName}" failed while loading module "${descriptor.name}": ${safeMessage(error)}`,
                    error
                );
            }
        }
    }

    const result = {
        groupName: normalizedGroupName,
        modules: loadedModules,
        failedModules,
        durationMs: Number((now() - started).toFixed(2)),
    };

    emit(LOADER_EVENTS.GROUP_READY, {
        groupName: normalizedGroupName,
        moduleCount: loadedModules.length,
        failedCount: failedModules.length,
        durationMs: result.durationMs,
    });

    return result;
}

/**
 * Internal multi-group load without operation accounting.
 * @param {string[]} groupNames
 * @param {{ autoInitialize?: boolean }} [options]
 * @returns {Promise<GroupLoadResult[]>}
 */
async function performLoadGroups(groupNames, options = {}) {
    if (!Array.isArray(groupNames) || groupNames.length === 0) {
        throw createLoaderError(
            "LOADER_EMPTY_GROUP_LIST",
            "loadGroups expects a non-empty array of group names."
        );
    }

    const results = [];
    for (const groupName of groupNames) {
        results.push(await performLoadGroup(groupName, options));
    }

    return results;
}

/**
 * Loads a single module.
 * @param {string} groupName
 * @param {string} moduleName
 * @param {{ autoInitialize?: boolean, context?: Record<string, unknown> }} [options]
 * @returns {Promise<any>}
 */
async function loadModule(groupName, moduleName, options = {}) {
    const normalizedGroupName = normalizeGroupName(groupName);
    const normalizedModuleName = normalizeModuleName(moduleName);

    startOperation(`module:${normalizedGroupName}/${normalizedModuleName}`);
    try {
        return await performLoadModule(normalizedGroupName, normalizedModuleName, options);
    } catch (error) {
        state.lastError = error;
        emit(LOADER_EVENTS.ERROR, {
            groupName: normalizedGroupName,
            moduleName: normalizedModuleName,
            error,
        });
        throw error;
    } finally {
        endOperation();
    }
}

/**
 * Loads a group in deterministic order.
 * @param {string} groupName
 * @param {{ autoInitialize?: boolean }} [options]
 * @returns {Promise<GroupLoadResult>}
 */
async function loadGroup(groupName, options = {}) {
    const normalizedGroupName = normalizeGroupName(groupName);

    startOperation(`group:${normalizedGroupName}`);
    try {
        return await performLoadGroup(normalizedGroupName, options);
    } catch (error) {
        state.lastError = error;
        emit(LOADER_EVENTS.ERROR, {
            groupName: normalizedGroupName,
            error,
        });
        throw error;
    } finally {
        endOperation();
    }
}

/**
 * Loads multiple groups sequentially.
 * @param {string[]} groupNames
 * @param {{ autoInitialize?: boolean }} [options]
 * @returns {Promise<GroupLoadResult[]>}
 */
async function loadGroups(groupNames, options = {}) {
    if (!Array.isArray(groupNames) || groupNames.length === 0) {
        throw createLoaderError(
            "LOADER_EMPTY_GROUP_LIST",
            "loadGroups expects a non-empty array of group names."
        );
    }

    const normalized = groupNames.map((groupName) => normalizeGroupName(groupName));

    startOperation(`groups:${normalized.join(",")}`);
    try {
        return await performLoadGroups(normalized, options);
    } catch (error) {
        state.lastError = error;
        emit(LOADER_EVENTS.ERROR, {
            groupNames: normalized,
            error,
        });
        throw error;
    } finally {
        endOperation();
    }
}

/**
 * Loads all registered groups sequentially.
 * @param {{ autoInitialize?: boolean }} [options]
 * @returns {Promise<GroupLoadResult[]>}
 */
async function loadAll(options = {}) {
    const groups = getGroupNames();

    if (groups.length === 0) {
        throw createLoaderError(
            "LOADER_EMPTY_MANIFEST",
            "No groups are registered in the loader manifest."
        );
    }

    startOperation("all");
    try {
        const results = await performLoadGroups(groups, options);

        emit(LOADER_EVENTS.READY, {
            groupCount: results.length,
            loadedModules: results.reduce((count, group) => count + group.modules.length, 0),
            failedModules: results.reduce((count, group) => count + group.failedModules.length, 0),
            durationMs: Number((now() - state.startedAt).toFixed(2)),
        });

        return results;
    } catch (error) {
        state.lastError = error;
        emit(LOADER_EVENTS.ERROR, { error });
        throw error;
    } finally {
        endOperation();
    }
}

/**
 * Resets runtime bookkeeping.
 * Native ES module cache cannot be unloaded by the browser.
 * @param {{ clearRegistrations?: boolean }} [options]
 * @returns {void}
 */
function resetLoaderState(options = {}) {
    assertLoaderIdle();

    moduleRecords.clear();
    state.activeOperations = 0;
    state.startedAt = 0;
    state.finishedAt = 0;
    state.lastOperation = null;
    state.lastError = null;

    if (options.clearRegistrations === true) {
        groupRegistry.clear();
        groupOrder.length = 0;
    }

    emit(LOADER_EVENTS.RESET, getState());
    subscribers.clear();
}

/**
 * Returns the public API reference.
 * @returns {LoaderApi}
 */
function createPublicApi() {
    return Object.freeze({
        appName: APP_NAME,
        version: APP_VERSION,
        LoaderError,
        events: LOADER_EVENTS,
        getState,
        getManifest,
        getGroupNames,
        getLoadedModuleUrls,
        getModuleStatus,
        registerGroup,
        registerModule,
        loadModule,
        loadGroup,
        loadGroups,
        loadAll,
        resetLoaderState,
        on,
        off,
        once,
        emit,
    });
}

/**
 * Attaches the loader API to the global AURA namespace.
 * @returns {void}
 */
function attachApi() {
    if (aura.engineLoader && typeof aura.engineLoader === "object") {
        publicApi = /** @type {LoaderApi} */ (aura.engineLoader);
        return;
    }

    publicApi = createPublicApi();

    Object.defineProperty(aura, "engineLoader", {
        value: publicApi,
        enumerable: true,
        configurable: true,
        writable: false,
    });
}

/**
 * Returns the current public API.
 * @returns {LoaderApi}
 */
function startOperation(label) {
    state.activeOperations += 1;
    state.lastOperation = label;
    if (!state.startedAt) {
        state.startedAt = Date.now();
    }
}

/**
 * Ends an active operation.
 * @returns {void}
 */
function endOperation() {
    state.activeOperations = Math.max(0, state.activeOperations - 1);
    state.finishedAt = Date.now();
}

/**
 * Registers the default manifest in deterministic order.
 * Paths are intentionally local and relative to this file.
 * @returns {void}
 */
function registerDefaultManifest() {
    registerGroup("foundation", [
        { name: "storage-engine", path: "./foundation/storage-engine.js" },
        { name: "event-bus", path: "./foundation/event-bus.js" },
        { name: "state-manager", path: "./foundation/state-manager.js" },
        { name: "logger", path: "./foundation/logger.js" },
        { name: "error-handler", path: "./foundation/error-handler.js" },
        { name: "scheduler", path: "./foundation/scheduler.js" },
        { name: "task-manager", path: "./foundation/task-manager.js" },
    ]);

    registerGroup("knowledge", [
        { name: "knowledge-engine", path: "./knowledge/knowledge-engine.js" },
        { name: "knowledge-validator", path: "./knowledge/knowledge-validator.js" },
        { name: "knowledge-index-engine", path: "./knowledge/knowledge-index-engine.js" },
        { name: "knowledge-import-engine", path: "./knowledge/knowledge-import-engine.js" },
        { name: "learning-engine", path: "./knowledge/learning-engine.js" },
    ]);

    registerGroup("memory", [
        { name: "content-memory-engine", path: "./memory/content-memory-engine.js" },
        { name: "working-memory-engine", path: "./memory/working-memory-engine.js" },
        { name: "semantic-memory-engine", path: "./memory/semantic-memory-engine.js" },
        { name: "episodic-memory-engine", path: "./memory/episodic-memory-engine.js" },
        { name: "pattern-extraction-engine", path: "./memory/pattern-extraction-engine.js" },
        { name: "knowledge-fragment-engine", path: "./memory/knowledge-fragment-engine.js" },
        { name: "memory-consolidation-engine", path: "./memory/memory-consolidation-engine.js" },
    ]);

    registerGroup("graph", [
        { name: "semantic-network-engine", path: "./graph/semantic-network-engine.js" },
        { name: "knowledge-graph-engine", path: "./graph/knowledge-graph-engine.js" },
        { name: "graph-query-engine", path: "./graph/graph-query-engine.js" },
    ]);

    registerGroup("learning-core", [
        { name: "learning-core-engine", path: "./learning-core/learning-core-engine.js" },
    ]);

    registerGroup("cognitive", [
        { name: "context-engine", path: "./cognitive/context-engine.js" },
        { name: "reasoning-engine", path: "./cognitive/reasoning-engine.js" },
        { name: "human-reasoning-engine", path: "./cognitive/human-reasoning-engine.js" },
        { name: "self-critic-engine", path: "./cognitive/self-critic-engine.js" },
        { name: "planner-engine", path: "./cognitive/planner-engine.js" },
        { name: "decision-engine", path: "./cognitive/decision-engine.js" },
        { name: "insight-engine", path: "./cognitive/insight-engine.js" },
    ]);

    registerGroup("creative", [
        { name: "idea-generation-engine", path: "./creative/idea-generation-engine.js" },
        { name: "creative-mind-engine", path: "./creative/creative-mind-engine.js" },
    ]);

    registerGroup("philosophy", [
        { name: "question-answer-engine", path: "./philosophy/question-answer-engine.js" },
        { name: "comparison-engine", path: "./philosophy/comparison-engine.js" },
        { name: "philosophy-engine", path: "./philosophy/philosophy-engine.js" },
    ]);

    registerGroup("meta", [
        { name: "meta", path: "./meta/meta.js" },
        { name: "goal-manager", path: "./meta/goal-manager.js" },
        { name: "performance-analyzer", path: "./meta/performance-analyzer.js" },
        { name: "meta-learning-engine", path: "./meta/meta-learning-engine.js" },
        { name: "self-improvement-engine", path: "./meta/self-improvement-engine.js" },
    ]);

    registerGroup("semantic-search", [
        { name: "embedding-engine", path: "./semantic-search/embedding-engine.js" },
        { name: "search-index-engine", path: "./semantic-search/search-index-engine.js" },
        { name: "retrieval-engine", path: "./semantic-search/retrieval-engine.js" },
        { name: "vector-search-engine", path: "./semantic-search/vector-search-engine.js" },
    ]);

    registerGroup("web-knowledge", [
        { name: "internet-search-engine", path: "./web-knowledge/internet-search-engine.js" },
        { name: "web-fetch-engine", path: "./web-knowledge/web-fetch-engine.js" },
        { name: "web-content-parser", path: "./web-knowledge/web-content-parser.js" },
        { name: "source-validator", path: "./web-knowledge/source-validator.js" },
        { name: "duplicate-content-engine", path: "./web-knowledge/duplicate-content-engine.js" },
        { name: "knowledge-extraction-engine", path: "./web-knowledge/knowledge-extraction-engine.js" },
        { name: "web-cache-engine", path: "./web-knowledge/web-cache-engine.js" },
        { name: "web-learning-engine", path: "./web-knowledge/web-learning-engine.js" },
    ]);

    registerGroup("feedback", [
        { name: "feedback-engine", path: "./feedback/feedback-engine.js" },
        { name: "feedback-analyzer", path: "./feedback/feedback-analyzer.js" },
    ]);

    registerGroup("hindi", [
        { name: "hindi-normalizer", path: "./hindi/hindi-normalizer.js" },
        { name: "hindi-tokenizer", path: "./hindi/hindi-tokenizer.js" },
        { name: "hindi-intent-engine", path: "./hindi/hindi-intent-engine.js" },
        { name: "hindi-command-router", path: "./hindi/hindi-command-router.js" },
        { name: "hindi-interaction-engine", path: "./hindi/hindi-interaction-engine.js" },
    ]);

    registerGroup("command", [
        { name: "command-manifest", path: "./command/command-manifest.js" },
        { name: "command-registry", path: "./command/command-registry.js" },
        { name: "command-parser", path: "./command/command-parser.js" },
        { name: "command-validator", path: "./command/command-validator.js" },
        { name: "command-router", path: "./command/command-router.js" },
        { name: "command-bootstrap", path: "./command/command-bootstrap.js" },
        { name: "command-bootstrap-v2", path: "./command/command-bootstrap-v2.js" },
        { name: "command-bootstrap-v3", path: "./command/command-bootstrap-v3.js" },
        { name: "command-bootstrap-v4", path: "./command/command-bootstrap-v4.js" },
        { name: "command-bootstrap-v5", path: "./command/command-bootstrap-v5.js" },
        { name: "command-bootstrap-v6", path: "./command/command-bootstrap-v6.js" },
        { name: "command-bootstrap-v7", path: "./command/command-bootstrap-v7.js" },
        { name: "command-bootstrap-v8", path: "./command/command-bootstrap-v8.js" },
        { name: "creative-command-bootstrap", path: "./command/creative-command-bootstrap.js" },
    ]);

    registerGroup("execution", [
        { name: "execution-context", path: "./execution/execution-context.js" },
        { name: "execution-pipeline", path: "./execution/execution-pipeline.js" },
        { name: "execution-monitor", path: "./execution/execution-monitor.js" },
        { name: "core-command-engine-v14", path: "./execution/core-command-engine-v14.js" },
    ]);

    registerGroup("security", [
        { name: "input-sanitizer", path: "./security/input-sanitizer.js" },
        { name: "permission-manager", path: "./security/permission-manager.js" },
        { name: "security-engine", path: "./security/security-engine.js" },
        { name: "safe-execution-engine", path: "./security/safe-execution-engine.js" },
        { name: "network-security-engine", path: "./security/network-security-engine.js" },
        { name: "content-filter-engine", path: "./security/content-filter-engine.js" },
    ]);

    registerGroup("plugins", [
        { name: "plugin-registry", path: "./plugins/plugin-registry.js" },
        { name: "plugin-loader", path: "./plugins/plugin-loader.js" },
        { name: "plugin-manager", path: "./plugins/plugin-manager.js" },
    ]);

    registerGroup("workers", [
        { name: "memory-worker", path: "./workers/memory-worker.js" },
        { name: "indexing-worker", path: "./workers/indexing-worker.js" },
        { name: "learning-worker", path: "./workers/learning-worker.js" },
        { name: "web-learning-worker", path: "./workers/web-learning-worker.js" },
        { name: "background-task-worker", path: "./workers/background-task-worker.js" },
    ]);
}

registerDefaultManifest();
attachApi();

/**
 * Returns the public API reference.
 * @returns {LoaderApi}
 */
function getPublicApi() {
    const api = getApi();
    if (!api) {
        throw createLoaderError(
            "LOADER_API_UNAVAILABLE",
            "AURA engine loader API is not available."
        );
    }

    return api;
}

if (isBrowser) {
    try {
        aura.engineLoader = getPublicApi();
    } catch {
        // Namespace attachment is best-effort. The defined property above is authoritative.
    }
}

export default getPublicApi();
export {
    APP_NAME,
    APP_VERSION,
    LoaderError,
    LOADER_EVENTS,
    getState,
    getManifest,
    getGroupNames,
    getLoadedModuleUrls,
    getModuleStatus,
    registerGroup,
    registerModule,
    loadModule,
    loadGroup,
    loadGroups,
    loadAll,
    resetLoaderState,
    on,
    off,
    once,
    emit,
};
