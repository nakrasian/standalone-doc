export function createProgress() {
  const dialog = document.getElementById("progress-dialog");
  const title = dialog.querySelector("[data-progress-title]");
  const track = dialog.querySelector(".progress");
  const bar = dialog.querySelector("[data-progress-bar]");
  const text = dialog.querySelector("[data-progress-text]");
  const cancel = dialog.querySelector("[data-progress-cancel]");
  let onCancel = null;

  function open({heading = "Working…", total = 1, cancelable = true, onCancel: cb = null} = {}) {
    title.textContent = heading;
    bar.style.width = "0%";
    track.setAttribute("aria-valuenow", "0");
    text.textContent = "Starting…";
    cancel.hidden = !cancelable;
    cancel.disabled = false;
    cancel.textContent = "Cancel";
    onCancel = cb;
    if (!dialog.open) dialog.showModal();
  }

  function update(fraction, label) {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    bar.style.width = pct + "%";
    track.setAttribute("aria-valuenow", pct);
    if (label) text.textContent = `${label} · ${pct}%`;
  }

  function setText(label) {
    text.textContent = label;
  }

  function setCancel(label, disabled = false) {
    cancel.textContent = label;
    cancel.disabled = disabled;
  }

  function close() {
    onCancel = null;
    if (dialog.open) dialog.close();
  }

  cancel.addEventListener("click", () => {
    if (!onCancel) return;
    const cb = onCancel;
    onCancel = null;
    cb();
  });

  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    cancel.click();
  });

  return {open, update, setText, setCancel, close, get isOpen() {return dialog.open;}};
}
