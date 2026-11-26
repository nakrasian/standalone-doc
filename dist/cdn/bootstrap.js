/* Runs last, and as a module block: `await` means this line is the end of boot,
   not just the end of parsing. A rejection here still surfaces through the boot
   dialog, because boot() fails closed and records the error before rejecting. */
await globalThis.StandaloneDoc.boot();
