// Page state that survives leaving a page, reloading and logging out, per
// user: the selected tab, project, target, filters, search text, open
// sections and unsaved drafts. Every component in this module goes through
// this one file, so moving to core's shared page-state helper (when it
// arrives) means changing only the four functions below.
//
// Today the state lives in the browser's localStorage, keyed by module and
// user id. Every read and write is wrapped: storage can be blocked, full or
// empty (private window), and the page must work without it.
import React, { createContext, useCallback, useContext, useState } from 'react';

const PageScope = createContext('anonymous');

// Wraps the module; `userId` is the logged-in user's id.
export function PageStateProvider({ userId, children }) {
  return <PageScope.Provider value={userId ? String(userId) : 'anonymous'}>{children}</PageScope.Provider>;
}

export function usePageScope() {
  return useContext(PageScope);
}

function storageKey(scope, key) {
  return `mff:alphapulldown:${scope}:${key}`;
}

export function readPageState(scope, key, fallback) {
  try {
    const raw = window.localStorage.getItem(storageKey(scope, key));
    return raw === null ? fallback : JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

export function writePageState(scope, key, value) {
  try {
    if (value === undefined || value === null) window.localStorage.removeItem(storageKey(scope, key));
    else window.localStorage.setItem(storageKey(scope, key), JSON.stringify(value));
  } catch (err) {
    // storage unavailable: the page keeps working, it just forgets
  }
}

export function clearPageState(scope, key) {
  writePageState(scope, key, null);
}

// Like useState, but remembered under `key` for the current user. A saved
// value that no longer fits (the caller decides) is handled by the caller.
export function usePageState(key, initial) {
  const scope = usePageScope();
  const [value, setValue] = useState(() => readPageState(scope, key, initial));
  const update = useCallback(next => {
    setValue(prev => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      writePageState(scope, key, resolved);
      return resolved;
    });
  }, [scope, key]);
  return [value, update];
}

// Unsaved form edits. `base` is what the server held when the edits began
// (any JSON-able value); a draft is brought back only while the server still
// holds exactly that, so an old draft never overwrites a newer saved state.
export function restoreDraft(scope, key, base) {
  const kept = readPageState(scope, key, null);
  return kept && kept.base === JSON.stringify(base) ? kept.value : null;
}

export function rememberDraft(scope, key, base, value) {
  const baseText = JSON.stringify(base);
  if (JSON.stringify(value) === baseText) clearPageState(scope, key);
  else writePageState(scope, key, { base: baseText, value });
}
