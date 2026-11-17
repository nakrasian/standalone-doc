/* Buttons and Mod+= / Mod+- walk this list; typed values may sit
   between stops. Exported so the zoom math can be unit-tested without a DOM. */
export const STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const MIN = STEPS[0];
export const MAX = STEPS[STEPS.length - 1];
export const TYPE_MIN = 0.1;
export const TYPE_MAX = 4;

export const clamp = (v) => Math.min(TYPE_MAX, Math.max(TYPE_MIN, v));

/* Nearest stop, compared in log space so the steps feel even. */
export function nearest(v) {
  let best = STEPS[0];
  for (const s of STEPS) {
    if (Math.abs(Math.log(s / v)) < Math.abs(Math.log(best / v))) best = s;
  }
  return best;
}

/* "150", "150%", " 150 % " → 150. Anything unparseable → null. */
export function parsePercent(text) {
  const n = parseFloat(String(text).replace(/[%\s]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function createZoom() {
  "use strict";
  const stage = document.getElementById("stage");
  const viewport = document.getElementById("viewport");
  let value = 1;

  /* Change zoom without losing the reading spot. The anchor is a CLIENT y
     (the same space as MouseEvent.clientY). The scroll correction is the
     anchor's change in client position, so content that grew below the
     anchor scrolls further down. */
  function apply(next, anchorY) {
    const z1 = clamp(next);
    const vr = viewport.getBoundingClientRect();
    const bottom = vr.top + viewport.clientHeight;
    const ay = anchorY == null
      ? vr.top + viewport.clientHeight / 2
      : Math.min(bottom, Math.max(vr.top, anchorY));

    if (z1 === value) {
      syncUI();
      return value;
    }

    const top0 = stage.getBoundingClientRect().top;
    const stageY = (ay - top0) / value; // anchor in stage layout px

    value = z1;
    /* A custom property, not `zoom` itself: the inline style only ever sets
       --zoom, so the print rule can reset `zoom` without !important. */
    stage.style.setProperty("--zoom", String(value));

    const top1 = stage.getBoundingClientRect().top;
    viewport.scrollTop += top1 + stageY * value - ay;

    syncUI();
    return value;
  }

  function step(dir, anchorY) {
    const i = STEPS.indexOf(nearest(value));
    const j = Math.max(0, Math.min(STEPS.length - 1, i + dir));
    /* At an end of the list (or past it, e.g. after a fit), stay put rather
       than jumping back to the last stop. */
    if (j === i) return apply(value, anchorY);
    return apply(STEPS[j], anchorY);
  }

  /* Commit a typed percentage; false means "restore the field". */
  function setPercent(text, anchorY) {
    const pct = parsePercent(text);
    if (pct == null) return false;
    apply(clamp(pct / 100), anchorY);
    return true;
  }

  /* One-shot: the fitted value becomes an ordinary zoom, so it neither
     re-fits on resize nor survives a save. The computed width is layout
     px, which makes this idempotent. */
  function fit() {
    const sheetW = parseFloat(getComputedStyle(stage).width);
    if (!sheetW) return value;
    return apply(viewport.clientWidth / sheetW, 0);
  }

  function syncUI() {
    const pct = Math.round(value * 100) + "%";
    /* Always refresh the fields, including a focused one: an explicit zoom
       command (button, shortcut, fit) must win over a half-typed value,
       otherwise the stale text would be committed on blur. Type-then-Enter
       is unaffected because syncUI only runs when zoom actually moves. */
    document.querySelectorAll("[data-zoom-input]").forEach((el) => {
      el.value = String(Math.round(value * 100));
    });
    document.querySelectorAll("[data-zoom-label]").forEach((el) => {
      el.textContent = "Zoom · " + pct;
    });
    document.querySelectorAll('[data-zoom="in"]').forEach((el) => {
      el.disabled = value >= MAX;
    });
    document.querySelectorAll('[data-zoom="out"]').forEach((el) => {
      el.disabled = value <= MIN;
    });
    document.querySelectorAll('[data-zoom="reset"]').forEach((el) => {
      el.setAttribute("aria-label", `Zoom ${pct}. Reset to 100%`);
      el.title = `Zoom ${pct} — reset to 100%`;
    });
  }

  function command(name, anchorY) {
    if (name === "in") return step(1, anchorY);
    if (name === "out") return step(-1, anchorY);
    if (name === "reset") return apply(1, anchorY);
    if (name === "fit") return fit();
    return value;
  }

  return {
    command,
    set: apply,
    setPercent,
    in: () => step(1),
    out: () => step(-1),
    reset: () => apply(1),
    fit,
    syncUI,
    get value() {return value},
  };
}
