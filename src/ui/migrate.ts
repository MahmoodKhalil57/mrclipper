// The app was called Clipdesk. Carry this browser's saved settings over to the new names once,
// the OpenRouter key included (it lives only here). Imported first, before anything reads storage.
try {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("clipdesk.")) continue;
    const next = `mrclipper.${k.slice("clipdesk.".length)}`;
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(k) ?? "");
    localStorage.removeItem(k);
  }
} catch {}
