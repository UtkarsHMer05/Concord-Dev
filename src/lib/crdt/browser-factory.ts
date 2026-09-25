import type { LoadConcordCrdtFactory } from "./wasm-types";

type BrowserFactoryWindow = Window & {
  loadConcordCrdt?: (options?: Record<string, unknown>) => Promise<import("./wasm-types").ConcordModule>;
};

let scriptLoad: Promise<void> | null = null;

/** Load the same public WASM runtime used by the CRDT worker for offline bundle verification. */
export const loadBrowserCrdtFactory: LoadConcordCrdtFactory = async () => {
  if (typeof window === "undefined") throw new Error("CRDT verification requires a browser");
  const browser = window as BrowserFactoryWindow;
  if (typeof browser.loadConcordCrdt !== "function") {
    scriptLoad ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("/wasm/concord-crdt.js", window.location.origin).href;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Could not load Concord WASM"));
      document.head.append(script);
    }).catch((error: unknown) => {
      scriptLoad = null;
      throw error;
    });
    await scriptLoad;
  }

  const factory = browser.loadConcordCrdt;
  if (typeof factory !== "function") throw new Error("Concord WASM factory is unavailable");
  const response = await fetch(new URL("/wasm/concord-crdt.wasm", window.location.origin).href);
  if (!response.ok) throw new Error(`Could not load Concord WASM binary (${response.status})`);
  const wasmBinary = await response.arrayBuffer();
  return factory({
    instantiateWasm(info: WebAssembly.Imports, receiveInstance: (instance: WebAssembly.Instance) => void) {
      return WebAssembly.instantiate(wasmBinary, info).then(({ instance }) => {
        receiveInstance(instance);
        return instance.exports;
      });
    },
  });
};
