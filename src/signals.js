const Signals = (() => {
  const target = document.getElementById("content");
  const listeners = new Map();
  let muted = 0;
  let composing = false;

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type).delete(fn);
  }

  function emit(type, detail) {
    for (const fn of listeners.get(type) || []) fn(detail);
  }

  // Suppress observer notifications for programmatic changes. Release in a
  // microtask so the MutationObserver callback still sees muted > 0.
  function mute(fn) {
    muted++;
    try {return fn();}
    finally {queueMicrotask(() => {muted--;});}
  }

  new MutationObserver(() => {
    if (muted) return;
    emit("mutation");
  }).observe(target, {childList: true, subtree: true, characterData: true});

  new ResizeObserver(() => {
    if (muted) return;
    emit("resize");
  }).observe(target);

  target.addEventListener("beforeinput", () => emit("beforeinput"));
  target.addEventListener("input", (e) => {
    if (e.isComposing || composing) return;
    emit("edit", {inputType: e.inputType});
  });
  target.addEventListener("compositionstart", () => {
    composing = true;
    emit("compositionstart");
  });
  target.addEventListener("compositionend", () => {
    composing = false;
    emit("compositionend");
  });

  return {on, emit, mute, get composing() {return composing;} };
})();
