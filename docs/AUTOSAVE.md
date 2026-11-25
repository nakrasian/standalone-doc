# Autosave, the conflict bar, and what a snapshot is for

**Status: draft, not implemented.** Written 2026-11-24 against the library at
`docs.nhlu.dev` and runtime `v0.13.1`. It is the design for the next runtime release,
together with A1 (publish the loader bytes at the tag) and A2 (`#doc-settings.updates.inline`).

The library side is already in place and deployed: `If-Match` on save (`409` with both
versions named), `?checkpoint=0`, and a per-library snapshot cap.

---

## 1. The three pieces of chrome

### 1a. Back to the library — top left, replacing the mark

A hosted document already knows where it belongs: `#doc-settings.cloud` is `{id, api}`, and
`api` is relative on purpose. So the link is derivable, not a new field.

- **Placement: the top-left corner of the ribbon, where the mark is.** The mark is an
  identity that says nothing the person does not already know; the way back is the one
  thing they will look for. It replaces the icon rather than sitting beside it, so the
  ribbon gains no width.
- **Shape:** `‹ Library` — the guillemet is the affordance, three words at most. `href="/"`
  resolved against the document's own origin, so it is correct on any hostname the library
  answers on.
- **Only when `cloud` is present.** A copy exported to disk has `cloud` stripped, and a
  document opened from a file has no library to go back to. The link must simply not be
  there rather than point at `file:///`.
- **The viewer's bar is not exempt:** a *published* copy has no `cloud` either, so a share
  never shows it. If a library ever wants a "browse this library" link on a share, that is a
  deliberate export option, not a default.
- Keyboard: it is the first tab stop in the chrome. It must not steal the first ⌘S.

### 1b. Toasts — and what autosave must *not* say

Three tiers, the same as the shelf's:

| Surface | When | Life |
|---|---|---|
| **Toast** | a save finished (manual), or any save failed | 5 s ok / 10 s error, `role="alert"` on errors |
| **Bar** | a decision is needed (conflict, sign-in expired) | stays until resolved |
| **Boot card** | the document could not start | with the remedy that already exists |

**With autosave on, a *successful* autosave says nothing.** The person did not ask for it;
a toast every thirty seconds is a notification that trains people to ignore notifications.
The ribbon carries a quiet state instead — `Saved 12:04` in the status area, updating in
place — and the toast is reserved for:

- a **manual** save (⌘S) succeeding — the person asked, so they get an answer;
- **any** failure, autosave or not, because a failed autosave is the one case where silence
  costs work;
- a conflict, which is a bar rather than a toast (below).

A failed autosave that keeps failing says so **once**, then the bar shows
`Could not save · retrying in 30 s`, and the retry interval backs off (30 s → 1 min → 2 min,
capped). A toast per attempt is how a working document gets closed by accident.

### 1c. The conflict bar

A `409 conflict` from the library means: *this document changed somewhere else since you
loaded it.* Two tabs, a second machine, or a person plus an autosave. The library also says
which version is current (`current.updatedAt`, `current.savedAt`).

```
┌──────────────────────────────────────────────────────────────────────────┐
│ This document was saved elsewhere — 12:04 today.                          │
│ Your unsaved changes are still here.     [ Reload theirs ]  [ Keep mine ] │
└──────────────────────────────────────────────────────────────────────────┘
```

Rules that make it a decision rather than a nuisance:

1. **Autosave stops while the bar is up.** One conflicting write is information; a loop of
   them is a way to lose the other tab's work a keystroke at a time.
2. **The document is not reloaded underneath the person.** The bar is the offer; nothing
   moves until one of the two buttons is pressed.
3. **Reload theirs** = discard the in-memory edits and load the current version from
   `/d/<id>`. It is the only destructive button, so it is the secondary one, and it asks
   once (`Discard your unsaved changes?`) before it does it.
4. **Keep mine** = `PUT` **without** `If-Match`, which the library accepts and snapshots
   first. Their version becomes a snapshot, so "keep mine" is recoverable from History
   rather than merely decisive.
5. **Re-check on click.** The version may have moved again while the bar was up; if
   `current.updatedAt` no longer matches what the bar quoted, re-read and re-offer rather
   than overwrite something three saves newer.
6. **A conflict on a document with no unsaved changes** (an idle autosave firing after
   another tab saved) is silent: update the tracked version, no bar, no toast. The person
   did nothing, so there is nothing to decide.

The version the document tracks is the `ETag` from its last successful write (or from
`GET /api/docs/<id>` when it opened). It is the document's `updatedAt`, not R2's, so a
backup restore does not raise a false conflict.

---

## 2. Autosave modes

```jsonc
// #doc-settings
"autosave": { "mode": "off" | "idle" | "interval", "idleMs": 2000, "intervalMs": 60000 }
```

- **`off`** is the default, and the default for a document that predates the field. A file
  that downloads saves when it is told to.
- **`idle`** — two seconds after typing stops. This is what people mean by autosave.
- **`interval`** — every `intervalMs`, regardless of typing. For a document someone is
  reading and commenting on rather than writing.
- **Cloud only.** No `cloud` record → no autosave, whatever the field says. The sink is what
  makes a save possible, and a file on disk has no sink until the person picks one.
- **Never** while a manual save is in flight, while `navigator.onLine` is false (wait for
  `online`), after a failed boot, or while the conflict bar is up.
- **`pagehide` / `visibilitychange → hidden`** flushes one last save with `keepalive: true`
  and **with** a checkpoint. This is the only save that is allowed to be best-effort: it is
  the one that catches "closed the tab".

---

## 3. Snapshot policy: leaving, and time

The library keeps N snapshots per document (`HISTORY_LIMIT`, default 10). Ten snapshots is
not many, so the question is not "should we checkpoint often" but "which moments are worth
keeping".

| Trigger | Checkpoint? | Why |
|---|---|---|
| Manual ⌘S | **yes** | A person decided this version was worth keeping |
| Autosave (idle or interval) | **no** (`?checkpoint=0`) | A keystroke is not a milestone; ten of them would be five minutes of history |
| Leaving the document (`pagehide`, tab hidden for > 5 min) | **yes** | The end of a working session is exactly the boundary a person would pick |
| Every N minutes of continuous autosaving (default **15**) | **yes** | The floor: a long session still has intermediate versions |
| Restore from History | yes (it is a save) | Already the behaviour |
| Batch re-pin, rename | yes | Both are library operations, already snapshotted |

So a typical session leaves: one snapshot at open-ish, one every fifteen minutes, one when
you leave, plus every ⌘S. With the default cap of 10 that is roughly half a working day; on
a library with `HISTORY_LIMIT=50` it is most of a week. Raising the cap is a one-line
deploy — the Worker already reads it from `HISTORY_LIMIT` — and R2's free tier (10 GB) makes
it cheap for documents of this size.

Two edge cases worth writing down:

- **Nothing changed → no snapshot.** The runtime already skips a save whose blocks are
  identical; the leaving-checkpoint must use the same test, or a "hidden for five minutes"
  tick would fill History with identical versions.
- **The cap is pruned on every checkpoint, not on every save.** Autosaves do not prune, so
  the ten most recent *checkpoints* are the ten kept — which is what a person means by
  history.

---

## 4. What the library must do (already deployed)

| | |
|---|---|
| `ETag: "<updatedAt>"` on `GET /api/docs/<id>`, `PUT`, `PATCH` | the version a client quotes |
| `409 {code:"conflict", current:{updatedAt, savedAt}}` | when `If-Match` is stale |
| `?checkpoint=0` on `PUT` | save without a snapshot |
| `HISTORY_LIMIT` var | snapshots kept per document |

Not yet, and deliberately: **a lock**. A lease would need a writer identity and a timeout,
and a lease that expires mid-save is worse than a conflict the person can see. Conflicts
stay optimistic.

---

## 5. Open questions

1. Does `interval` autosave make sense for a *comment-mode* document (comments are saved in
   the same block)? Probably yes, with a longer interval.
2. Should "keep mine" ever be automatic — e.g. if the other version is older than the one in
   memory? No: recency is not authorship, and the two versions may be different documents.
3. The ribbon's `Saved 12:04`: does it need to say *where* it saved (a library name)? The
   cloud record has no label, so the honest answer today is just "Saved".
4. When a document is opened with autosave already on, should the first save be immediate or
   deferred? Deferred: opening is not editing.
