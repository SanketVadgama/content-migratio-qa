import { useEffect, useRef, useState } from "react";

/**
 * Like useState, but persists the value to localStorage under `key`.
 * SSR-safe: during server render (no window) it just uses the initial value,
 * then hydrates from localStorage on the client after mount.
 *
 * Persistence is best-effort — if localStorage is unavailable (private mode,
 * quota, disabled) it degrades to plain in-memory state without throwing.
 */
export function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(initialValue);
  // Track whether we've hydrated, so the first client render doesn't overwrite
  // stored data with the initial value.
  const hydrated = useRef(false);

  // Hydrate from localStorage once, on mount (client only).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored !== null) {
        setValue(JSON.parse(stored) as T);
      }
    } catch {
      /* ignore corrupt/unavailable storage */
    }
    hydrated.current = true;
  }, [key]);

  // Persist on change (client only, after hydration).
  useEffect(() => {
    if (typeof window === "undefined" || !hydrated.current) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or unavailable — keep working in-memory */
    }
  }, [key, value]);

  return [value, setValue] as const;
}

/** Remove one or more persisted keys and reload defaults. Safe on server. */
export function clearPersistedKeys(keys: string[]) {
  if (typeof window === "undefined") return;
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}
