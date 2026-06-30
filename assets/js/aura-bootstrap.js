/**
 * =========================================================
 * AURA Bootstrap
 * File: assets/js/aura-bootstrap.js
 * Version: 1.3.0
 * =========================================================
 */

const APP_NAME = "AURA";
const APP_VERSION = "1.3.0";

const root = globalThis;

const state = {
  bootPromise: null,
  loader: null,
  ui: null,
  initialized: false,
  testMode: false,
  lastError: null
};

/* =========================================================
   Namespace
========================================================= */

if (!root.AURA || typeof root.AURA !== "object") {
  root.AURA = {};
}

const aura = root.AURA;

/* =========================================================
   Safe Property Definition
========================================================= */

function defineSafeProperty(name, descriptor) {
  const existing =
    Object.getOwnPropertyDescriptor(aura, name);

  if (existing) {
    return;
  }

  Object.defineProperty(aura, name, {
    configurable: true,
    enumerable: true,
    ...descriptor
  });
}

/* =========================================================
   Utilities
========================================================= */

function isBrowser() {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined"
  );
}

function setOutput(text) {
  const output =
    document.getElementById("outputConsole");

  if (!output) {
    return;
  }

  output.textContent =
    typeof text === "string"
      ? text
      : JSON.stringify(text, null, 2);
}

function getSearchParams() {
  return new URLSearchParams(location.search);
}

/* =========================================================
   Load Engine Loader
========================================================= */

async function loadEngineLoader() {
  if (state.loader) {
    return state.loader;
  }

  const mod =
    await import("./engine-loader.js");

  const loader =
    mod.default ||
    mod.engineLoader ||
    null;

  if (!loader) {
    throw new Error(
      "engine-loader.js did not export an API."
    );
  }

  state.loader = loader;

  return loader;
}

/* =========================================================
   Load UI
========================================================= */

async function loadUi() {
  if (state.ui) {
    return state.ui;
  }

  const mod =
    await import("./aura-console-ui.js");

  const ui =
    mod.default ||
    root.AURA.ui ||
    null;

  if (!ui) {
    throw new Error(
      "aura-console-ui.js did not export an API."
    );
  }

  state.ui = ui;

  if (
    typeof ui.initialize === "function"
  ) {
    const uiState =
      typeof ui.getState === "function"
        ? ui.getState()
        : null;

    if (
      !uiState ||
      !uiState.initialized
    ) {
      await ui.initialize();
    }
  }

  return ui;
}

/* =========================================================
   Diagnostics
========================================================= */

async function runDiagnostics() {
  const params = getSearchParams();

  const action =
    params.get("action") || "boot";

  switch (action) {
    case "boot":
      return {
        success: true,
        action: "boot",
        auraVersion: APP_VERSION,
        initialized:
          state.initialized
      };

    case "state":
      return getState();

    case "import": {
      const modulePath =
        params.get("module");

      if (!modulePath) {
        throw new Error(
          "module parameter missing."
        );
      }

      const mod =
        await import(modulePath);

      return {
        success: true,
        action: "import",
        exports:
          Object.keys(mod)
      };
    }

    default:
      throw new Error(
        `Unknown action: ${action}`
      );
  }
}

/* =========================================================
   State
========================================================= */

function getState() {
  return {
    success: true,
    version: APP_VERSION,
    initialized:
      state.initialized,
    testMode:
      state.testMode,
    loaderLoaded:
      !!state.loader,
    uiLoaded:
      !!state.ui,
    lastError:
      state.lastError
  };
}

/* =========================================================
   Boot
========================================================= */

async function boot() {
  if (state.bootPromise) {
    return state.bootPromise;
  }

  state.bootPromise =
    (async () => {
      try {
        if (!isBrowser()) {
          throw new Error(
            "Browser environment required."
          );
        }

        const params =
          getSearchParams();

        state.testMode =
          params.get("mode") ===
          "test";

        await loadEngineLoader();

        if (
          state.testMode
        ) {
          const result =
            await runDiagnostics();

          setOutput(result);
        } else {
          await loadUi();
        }

        state.initialized = true;

        return aura;
      } catch (error) {
        state.lastError =
          error.message;

        setOutput({
          success: false,
          action: "boot",
          error:
            error.message,
          timestamp:
            new Date().toISOString()
        });

        throw error;
      }
    })();

  return state.bootPromise;
}

/* =========================================================
   Shutdown
========================================================= */

async function shutdown() {
  state.initialized = false;
  state.loader = null;
  state.ui = null;
  state.bootPromise = null;
}

/* =========================================================
   Public API
========================================================= */

defineSafeProperty(
  "name",
  {
    value: APP_NAME
  }
);

defineSafeProperty(
  "version",
  {
    value: APP_VERSION
  }
);

defineSafeProperty(
  "engineLoader",
  {
    get() {
      return state.loader;
    }
  }
);

defineSafeProperty(
  "loader",
  {
    get() {
      return state.loader;
    }
  }
);

defineSafeProperty(
  "ui",
  {
    get() {
      return state.ui;
    }
  }
);

defineSafeProperty(
  "ready",
  {
    get() {
      return state.bootPromise;
    }
  }
);

defineSafeProperty(
  "boot",
  {
    value: boot
  }
);

defineSafeProperty(
  "shutdown",
  {
    value: shutdown
  }
);

defineSafeProperty(
  "getState",
  {
    value: getState
  }
);

/* =========================================================
   Auto Boot
========================================================= */

if (isBrowser()) {
  void boot().catch((error) => {
    console.error(
      "[AURA]",
      error
    );
  });
}

export default aura;
