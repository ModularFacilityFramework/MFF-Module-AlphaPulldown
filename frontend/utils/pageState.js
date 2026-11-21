// Page state that survives leaving a page, reloading and logging out, per
// user: the selected tab, project, target, filters, search text, open
// sections and unsaved drafts. Every component in this module goes through
// this one file.
//
// It uses core's shared helper, coreApi.usePageState (per user, saved in the
// browser at once and on the server). On an older core without it, it falls
// back to plain browser storage keyed by module and user id, so the pages
// behave the same either way. Storage can be blocked, full or empty, so every
// fallback read and write is wrapped and the page works without it.
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const PageContext = createContext({ scope: 'anonymous', core: null });

// Wraps the module. `coreApi` is what core gave it; `userId` the logged-in
// user's id (only the fallback needs it).
export function PageStateProvider({ coreApi, userId, children }) {
  const value = useMemo(() => ({ scope: userId ? String(userId) : 'anonymous', core: coreApi || null }), [coreApi, userId]);
  return <PageContext.Provider value={value}>{children}</PageContext.Provider>;
}

function fallbackKey(scope, key) {
  return `mff:alphapulldown:${scope}:${key}`;
}

function readFallback(scope, key, initial) {
  try {
    const raw = window.localStorage.getItem(fallbackKey(scope, key));
    return raw === null ? initial : JSON.parse(raw);
  } catch (err) {
    return initial;
  }
}

function writeFallback(scope, key, value) {
  try {
    if (value === undefined || value === null) window.localStorage.removeItem(fallbackKey(scope, key));
    else window.localStorage.setItem(fallbackKey(scope, key), JSON.stringify(value));
  } catch (err) {
    // storage unavailable: the page keeps working, it just forgets
  }
}

// Same shape as core's hook: [value, setValue, reset].
function useFallbackState(scope, key, initial, validate) {
  const [value, setValue] = useState(() => {
    const kept = readFallback(scope, key, initial);
    return typeof validate === 'function' && !validate(kept) ? initial : kept;
  });
  const update = useCallback(next => {
    setValue(prev => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      writeFallback(scope, key, resolved);
      return resolved;
    });
  }, [scope, key]);
  const reset = useCallback(() => {
    writeFallback(scope, key, null);
    setValue(initial);
  }, [scope, key, initial]);
  return [value, update, reset];
}

// Like useState, but remembered under `key` for the current user. `key` is
// "what" the state is, e.g. 'library:query'; it is stored as
// alphapulldown.<key> (letters, digits and _ . : - only). `validate`
// (optional function) rejects a remembered value that no longer fits.
function useCoreImpl(ctx, key, initial, validate) {
  return ctx.core.usePageState(`alphapulldown.${key}`, initial, validate);
}

function useFallbackImpl(ctx, key, initial, validate) {
  return useFallbackState(ctx.scope, key, initial, validate);
}

export function usePageState(key, initial, validate) {
  const ctx = useContext(PageContext);
  // Which helper is in use never changes while the module is mounted.
  const useImpl = ctx.core && typeof ctx.core.usePageState === 'function' ? useCoreImpl : useFallbackImpl;
  return useImpl(ctx, key, initial, validate);
}

// Unsaved form edits. `base` is what the server held when the edits began
// (any JSON-able value); the draft is brought back only while the server
// still holds exactly that, so an old draft never overwrites a newer saved
// state. restore(base) -> the kept value or null; remember(base, value)
// stores the edits (or forgets them when they equal the saved state - pass
// `unchanged` when equality is not plain JSON equality);
// forget() drops them. All three keep one identity for the component's life.
export function usePageDraft(key) {
  const [kept, setKept, resetKept] = usePageState(key, null);
  const keptRef = useRef(kept);
  const setRef = useRef(setKept);
  const resetRef = useRef(resetKept);
  keptRef.current = kept;
  setRef.current = setKept;
  resetRef.current = resetKept;
  const restore = useCallback(base => {
    const now = keptRef.current;
    return now && now.base === JSON.stringify(base) ? now.value : null;
  }, []);
  const forget = useCallback(() => { if (keptRef.current !== null) resetRef.current(); }, []);
  const remember = useCallback((base, value, unchanged) => {
    const baseText = JSON.stringify(base);
    const same = unchanged === undefined ? JSON.stringify(value) === baseText : unchanged;
    if (same) { if (keptRef.current !== null) resetRef.current(); return; }
    const now = keptRef.current;
    if (!now || now.base !== baseText || JSON.stringify(now.value) !== JSON.stringify(value)) setRef.current({ base: baseText, value });
  }, []);
  return useMemo(() => ({ restore, remember, forget }), [restore, remember, forget]);
}
