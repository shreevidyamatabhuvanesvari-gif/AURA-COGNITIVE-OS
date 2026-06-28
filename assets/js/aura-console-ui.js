/**
 * =========================================================
 * AURA Console UI
 * File: assets/js/aura-console-ui.js
 * Version: 1.0.0
 * Status: Production UI Layer
 * =========================================================
 */

/* eslint-disable no-console */

const AURA_UI_STORAGE_KEY = "aura-console-draft";
const AURA_UI_HISTORY_KEY = "aura-console-history";
const MAX_HISTORY_ITEMS = 100;
const TOAST_DEFAULT_DURATION = 2800;

const state = {
    initialized: false,
    bootTime: null,
    commandCount: 0,
    lastExecutionAt: null,
    history: [],
    listeners: [],
    toastTimers: new Set(),
};

const dom = {
    app: null,
    systemIndicator: null,
    systemStatus: null,
    engineStatus: null,
    bootTime: null,
    commandCount: null,
    memoryStatus: null,
    executionTime: null,
    executeButton: null,
    copyButton: null,
    clearButton: null,
    downloadButton: null,
    commandInput: null,
    outputConsole: null,
    toastContainer: null,
    modalContainer: null,
};

function $(selector, root = document) {
    return root.querySelector(selector);
}

function safeLocalStorageGet(key) {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function safeLocalStorageSet(key, value) {
    try {
        window.localStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

function safeLocalStorageRemove(key) {
    try {
        window.localStorage.removeItem(key);
        return true;
    } catch {
        return false;
    }
}

function formatTime(date = new Date()) {
    return new Intl.DateTimeFormat("hi-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(date);
}

function formatDateTime(date = new Date()) {
    return new Intl.DateTimeFormat("hi-IN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(date);
}

function sanitizeText(value) {
    return String(value ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
}

function getCommandInputValue() {
    return sanitizeText(dom.commandInput?.value ?? "");
}

function setCommandInputValue(value) {
    if (!dom.commandInput) return;
    dom.commandInput.value = sanitizeText(value);
    updateCharacterCount();
    persistDraft();
}

function getOutputText() {
    return sanitizeText(dom.outputConsole?.textContent ?? "");
}

function setOutputText(value) {
    if (!dom.outputConsole) return;
    dom.outputConsole.textContent = sanitizeText(value);
}

function appendOutputBlock(title, content, options = {}) {
    const timestamp = formatTime();
    const separator = options.separator ?? "—";
    const block = [
        `[${timestamp}] ${title}`,
        separator,
        sanitizeText(content),
        "",
    ].join("\n");

    const existing = getOutputText().trim();
    const next = existing ? `${existing}\n${block}` : block;
    setOutputText(next);

    scrollOutputToBottom();
}

function scrollOutputToBottom() {
    if (!dom.outputConsole) return;
    dom.outputConsole.scrollTop = dom.outputConsole.scrollHeight;
}

function updateCharacterCount() {
    const el = $("#characterCount");
    if (!el) return;
    const length = getCommandInputValue().length;
    el.textContent = `अक्षर : ${length}`;
}

function updateCommandCount() {
    if (!dom.commandCount) return;
    dom.commandCount.textContent = String(state.commandCount);
}

function updateBootTime() {
    if (!dom.bootTime) return;
    dom.bootTime.textContent = state.bootTime ? formatDateTime(state.bootTime) : "--";
}

function updateExecutionTimeLabel(text) {
    if (!dom.executionTime) return;
    dom.executionTime.textContent = text;
}

function setSystemStatus(text, online = false) {
    if (dom.systemStatus) dom.systemStatus.textContent = text;
    if (dom.systemIndicator) {
        dom.systemIndicator.classList.toggle("online", Boolean(online));
        dom.systemIndicator.classList.toggle("offline", !online);
    }
}

function setEngineStatus(text) {
    if (dom.engineStatus) dom.engineStatus.textContent = text;
}

function setMemoryStatus(text) {
    if (dom.memoryStatus) dom.memoryStatus.textContent = text;
}

function registerHistoryEntry(entry) {
    state.history.unshift({
        input: sanitizeText(entry.input),
        output: sanitizeText(entry.output),
        createdAt: entry.createdAt ?? new Date().toISOString(),
        status: entry.status ?? "ok",
    });

    if (state.history.length > MAX_HISTORY_ITEMS) {
        state.history.length = MAX_HISTORY_ITEMS;
    }

    try {
        safeLocalStorageSet(AURA_UI_HISTORY_KEY, JSON.stringify(state.history));
    } catch {
        // ignore
    }
}

function restoreHistory() {
    const raw = safeLocalStorageGet(AURA_UI_HISTORY_KEY);
    if (!raw) return;

    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            state.history = parsed.slice(0, MAX_HISTORY_ITEMS);
        }
    } catch {
        state.history = [];
    }
}

function persistDraft() {
    if (!dom.commandInput) return;
    safeLocalStorageSet(AURA_UI_STORAGE_KEY, dom.commandInput.value);
}

function restoreDraft() {
    const saved = safeLocalStorageGet(AURA_UI_STORAGE_KEY);
    if (saved && dom.commandInput) {
        dom.commandInput.value = saved;
    }
    updateCharacterCount();
}

async function copyTextToClipboard(text) {
    const payload = sanitizeText(text);

    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(payload);
        return true;
    }

    const fallback = document.createElement("textarea");
    fallback.value = payload;
    fallback.setAttribute("readonly", "true");
    fallback.style.position = "fixed";
    fallback.style.top = "-9999px";
    fallback.style.left = "-9999px";
    document.body.appendChild(fallback);
    fallback.select();
    fallback.setSelectionRange(0, fallback.value.length);

    let success = false;
    try {
        success = document.execCommand("copy");
    } catch {
        success = false;
    } finally {
        fallback.remove();
    }

    return success;
}

function showToast(message, type = "info", title = "सूचना", duration = TOAST_DEFAULT_DURATION) {
    if (!dom.toastContainer) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    const header = document.createElement("div");
    header.className = "toast-title";

    const titleNode = document.createElement("span");
    titleNode.textContent = title;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "toast-close";
    closeButton.setAttribute("aria-label", "सूचना बंद करें");
    closeButton.textContent = "✕";

    const messageNode = document.createElement("div");
    messageNode.className = "toast-message";
    messageNode.textContent = sanitizeText(message);

    closeButton.addEventListener("click", () => toast.remove());

    header.append(titleNode, closeButton);
    toast.append(header, messageNode);
    dom.toastContainer.appendChild(toast);

    const timer = window.setTimeout(() => {
        toast.remove();
        state.toastTimers.delete(timer);
    }, duration);

    state.toastTimers.add(timer);
    return toast;
}

function openModal({ title = "संदेश", body = "", actions = [] } = {}) {
    if (!dom.modalContainer) return;

    dom.modalContainer.innerHTML = "";
    dom.modalContainer.classList.add("modal-open");
    dom.modalContainer.style.display = "flex";
    dom.modalContainer.setAttribute("aria-hidden", "false");

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "document");

    const modalHeader = document.createElement("div");
    modalHeader.className = "modal-header";

    const heading = document.createElement("h3");
    heading.textContent = title;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "button-secondary";
    closeButton.textContent = "बंद करें";
    closeButton.addEventListener("click", closeModal);

    modalHeader.append(heading, closeButton);

    const modalBody = document.createElement("div");
    modalBody.className = "modal-body";
    if (typeof body === "string") {
        modalBody.textContent = body;
    } else if (body instanceof Node) {
        modalBody.appendChild(body);
    }

    const modalFooter = document.createElement("div");
    modalFooter.className = "modal-footer";

    for (const action of actions) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = action.primary ? "button-primary" : "button-secondary";
        btn.textContent = action.label;
        btn.addEventListener("click", async () => {
            try {
                await action.onClick?.();
            } finally {
                if (action.closeOnClick !== false) closeModal();
            }
        });
        modalFooter.appendChild(btn);
    }

    modal.append(modalHeader, modalBody, modalFooter);
    dom.modalContainer.appendChild(modal);
}

function closeModal() {
    if (!dom.modalContainer) return;
    dom.modalContainer.classList.remove("modal-open");
    dom.modalContainer.style.display = "none";
    dom.modalContainer.setAttribute("aria-hidden", "true");
    dom.modalContainer.innerHTML = "";
}

function clearConsole() {
    setCommandInputValue("");
    setOutputText("आदेश की प्रतीक्षा है...");
    state.commandCount = 0;
    updateCommandCount();
    updateExecutionTimeLabel("तैयार");
    safeLocalStorageRemove(AURA_UI_STORAGE_KEY);
    showToast("कंसोल साफ़ कर दिया गया।", "success", "सफल");
}

function downloadText(filename, content) {
    const blob = new Blob([sanitizeText(content)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadConsole() {
    const currentCommand = getCommandInputValue();
    const currentOutput = getOutputText();

    const content = [
        "AURA Console Export",
        `निर्माण समय: ${formatDateTime(new Date())}`,
        "",
        "[आदेश]",
        currentCommand || "(कोई आदेश नहीं)",
        "",
        "[परिणाम]",
        currentOutput || "(कोई परिणाम नहीं)",
        "",
        "[इतिहास]",
        JSON.stringify(state.history, null, 2),
        "",
    ].join("\n");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadText(`aura-console-${stamp}.txt`, content);
    showToast("डाउनलोड तैयार है।", "info", "डाउनलोड");
}

async function copyConsole() {
    const payload = getOutputText().trim() || getCommandInputValue().trim();

    if (!payload) {
        showToast("प्रतिलिपि करने के लिए कोई पाठ उपलब्ध नहीं है।", "warning", "रिक्त");
        return;
    }

    try {
        const success = await copyTextToClipboard(payload);
        if (success) {
            showToast("पाठ प्रतिलिपि कर दिया गया।", "success", "प्रतिलिपि");
        } else {
            showToast("प्रतिलिपि नहीं हो सकी।", "error", "त्रुटि");
        }
    } catch (error) {
        console.error("[AURA UI] Copy failed:", error);
        showToast("प्रतिलिपि असफल रही।", "error", "त्रुटि");
    }
}

function resolveExecutor() {
    const globalAURA = window.AURA || {};
    if (typeof globalAURA.executeCommand === "function") {
        return globalAURA.executeCommand.bind(globalAURA);
    }

    if (typeof globalAURA.coreExecuteCommand === "function") {
        return globalAURA.coreExecuteCommand.bind(globalAURA);
    }

    if (window.AURA?.core?.executeCommand && typeof window.AURA.core.executeCommand === "function") {
        return window.AURA.core.executeCommand.bind(window.AURA.core);
    }

    return null;
}

async function executeCurrentCommand() {
    const command = getCommandInputValue().trim();

    if (!command) {
        showToast("कृपया पहले कोई आदेश लिखें।", "warning", "आवश्यक");
        dom.commandInput?.focus();
        return;
    }

    state.commandCount += 1;
    updateCommandCount();
    updateExecutionTimeLabel("चल रहा है...");
    setEngineStatus("सक्रिय");
    setMemoryStatus("सक्रिय");

    const startedAt = performance.now();
    const executor = resolveExecutor();

    let resultText = "";
    let status = "ok";

    try {
        if (executor) {
            const result = await executor(command, {
                ui: api,
                state,
            });

            if (typeof result === "string") {
                resultText = result;
            } else if (result && typeof result === "object" && "output" in result) {
                resultText = sanitizeText(result.output);
                status = result.status === "error" ? "error" : "ok";
            } else {
                resultText = JSON.stringify(result, null, 2);
            }
        } else {
            resultText = [
                "AURA इंजन अभी आरम्भिक अवस्था में है।",
                "",
                "प्राप्त आदेश:",
                command,
                "",
                "यह UI परत सफलतापूर्वक कार्य कर रही है।",
            ].join("\n");
        }

        dom.outputConsole?.classList.remove("output-error");
        dom.outputConsole?.classList.add("output-success");
    } catch (error) {
        status = "error";
        resultText = `आदेश निष्पादन असफल: ${error?.message || String(error)}`;
        dom.outputConsole?.classList.remove("output-success");
        dom.outputConsole?.classList.add("output-error");
        console.error("[AURA UI] Command execution failed:", error);
    } finally {
        state.lastExecutionAt = new Date();
        const elapsed = (performance.now() - startedAt).toFixed(2);
        updateExecutionTimeLabel(`${elapsed} ms`);
    }

    const formattedOutput = [
        `> ${command}`,
        "",
        resultText,
    ].join("\n");

    setOutputText(formattedOutput);
    registerHistoryEntry({
        input: command,
        output: resultText,
        status,
    });

    persistDraft();
    scrollOutputToBottom();

    if (status === "error") {
        showToast("आदेश निष्पादन में त्रुटि हुई।", "error", "त्रुटि");
    } else {
        showToast("आदेश निष्पादित हो गया।", "success", "सफल");
    }
}

function bindEvent(target, eventName, handler, options) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(eventName, handler, options);
    state.listeners.push({ target, eventName, handler, options });
}

function unbindEvents() {
    for (const entry of state.listeners) {
        try {
            entry.target.removeEventListener(entry.eventName, entry.handler, entry.options);
        } catch {
            // ignore
        }
    }
    state.listeners = [];
}

function wireEvents() {
    bindEvent(dom.executeButton, "click", executeCurrentCommand);
    bindEvent(dom.copyButton, "click", copyConsole);
    bindEvent(dom.clearButton, "click", clearConsole);
    bindEvent(dom.downloadButton, "click", downloadConsole);

    bindEvent(dom.commandInput, "input", () => {
        updateCharacterCount();
        persistDraft();
    });

    bindEvent(dom.commandInput, "keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void executeCurrentCommand();
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
            event.preventDefault();
            clearConsole();
        }
    });

    bindEvent(window, "beforeunload", persistDraft);

    bindEvent(dom.modalContainer, "click", (event) => {
        if (event.target === dom.modalContainer) {
            closeModal();
        }
    });

    bindEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            persistDraft();
        }
    });
}

function collectDom() {
    dom.app = $("#app");
    dom.systemIndicator = $("#systemIndicator");
    dom.systemStatus = $("#systemStatus");
    dom.engineStatus = $("#engineStatus");
    dom.bootTime = $("#bootTime");
    dom.commandCount = $("#commandCount");
    dom.memoryStatus = $("#memoryStatus");
    dom.executionTime = $("#executionTime");
    dom.executeButton = $("#executeButton");
    dom.copyButton = $("#copyButton");
    dom.clearButton = $("#clearButton");
    dom.downloadButton = $("#downloadButton");
    dom.commandInput = $("#commandInput");
    dom.outputConsole = $("#outputConsole");
    dom.toastContainer = $("#toastContainer");
    dom.modalContainer = $("#modalContainer");
}

function validateDom() {
    const required = [
        "app",
        "systemIndicator",
        "systemStatus",
        "engineStatus",
        "bootTime",
        "commandCount",
        "executeButton",
        "copyButton",
        "clearButton",
        "downloadButton",
        "commandInput",
        "outputConsole",
        "toastContainer",
        "modalContainer",
    ];

    const missing = required.filter((key) => !dom[key]);
    if (missing.length > 0) {
        throw new Error(`AURA UI DOM elements missing: ${missing.join(", ")}`);
    }
}

function initialize() {
    if (state.initialized) return api;

    collectDom();
    validateDom();

    state.bootTime = new Date();
    restoreHistory();
    restoreDraft();

    // Safety: ensure interaction is enabled.
    if (dom.commandInput) {
        dom.commandInput.removeAttribute("disabled");
        dom.commandInput.removeAttribute("readonly");
        dom.commandInput.setAttribute("autocomplete", "off");
        dom.commandInput.setAttribute("spellcheck", "false");
    }

    setSystemStatus("तैयार", true);
    setEngineStatus("ऑनलाइन");
    setMemoryStatus("सक्रिय");
    updateBootTime();
    updateCommandCount();
    updateCharacterCount();
    updateExecutionTimeLabel("तैयार");

    if (!getOutputText().trim()) {
        setOutputText("AURA तैयार है। कोई आदेश लिखें और चलाएँ।");
    }

    wireEvents();

    state.initialized = true;
    window.AURA = window.AURA || {};
    window.AURA.ui = api;

    return api;
}

function destroy() {
    unbindEvents();
    state.initialized = false;
}

const api = {
    initialize,
    destroy,
    executeCurrentCommand,
    clearConsole,
    copyConsole,
    downloadConsole,
    showToast,
    openModal,
    closeModal,
    setSystemStatus,
    setEngineStatus,
    setMemoryStatus,
    setOutputText,
    appendOutputBlock,
    setCommandInputValue,
    getCommandInputValue,
    getOutputText,
    getHistory: () => [...state.history],
    focusCommand: () => dom.commandInput?.focus(),
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        try {
            initialize();
        } catch (error) {
            console.error("[AURA UI] Initialization failed:", error);
            window.AURA = window.AURA || {};
            window.AURA.uiInitError = error;
        }
    });
} else {
    try {
        initialize();
    } catch (error) {
        console.error("[AURA UI] Initialization failed:", error);
        window.AURA = window.AURA || {};
        window.AURA.uiInitError = error;
    }
}

export default api;
export {
    initialize,
    destroy,
    executeCurrentCommand,
    clearConsole,
    copyConsole,
    downloadConsole,
    showToast,
    openModal,
    closeModal,
    setSystemStatus,
    setEngineStatus,
    setMemoryStatus,
    setOutputText,
    appendOutputBlock,
    setCommandInputValue,
    getCommandInputValue,
    getOutputText,
};
