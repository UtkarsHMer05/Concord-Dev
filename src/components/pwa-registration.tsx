"use client";

/**
 * PWA registration (Feature 8). PRODUCTION ONLY — the hard gate is the
 * feature: a caching service worker in `next dev` would serve stale modules
 * and break HMR. Registered after the window's load event (standard SW
 * practice: no bandwidth contention with the initial render), and failures
 * are silent — installability is a progressive enhancement, never a
 * requirement for the local-first editor to work.
 */

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Progressive enhancement only: an SW registration failure must
        // never surface as an app error.
      });
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}
