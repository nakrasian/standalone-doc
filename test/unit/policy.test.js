import { test } from "node:test";
import assert from "node:assert/strict";
import { createPolicy } from "../../src/policy.js";

/* `plan()` and `persist()` are pure, so the interesting half of the save policy is
   testable without a browser. The DOM half (apply) has browser specs. */

const ASSETS = [
  { id: "registry", kind: "js", role: "infra", order: 5, requiredBy: ["*"], bytes: 10_000 },
  { id: "boot-ui", kind: "js", role: "infra", order: 6, requiredBy: ["*"], bytes: 10_000 },
  { id: "page-styles", kind: "css", order: 10, requiredBy: ["*"], bytes: 8_000 },
  { id: "toolbar-styles", kind: "css", order: 20, requiredBy: ["edit"], bytes: 13_000 },
  { id: "signals", kind: "js", order: 30, requiredBy: ["*"], bytes: 1_400 },
  { id: "progress", kind: "js", order: 45, requiredBy: ["edit"], bytes: 2_000 },
  { id: "status", kind: "js", order: 60, requiredBy: ["edit"], bytes: 3_300 },
  { id: "editor", kind: "js", order: 70, requiredBy: ["edit"], bytes: 16_000 },
  { id: "figures", kind: "js", order: 80, requiredBy: ["*"], bytes: 42_000 },
  { id: "toolbar", kind: "js", order: 90, requiredBy: ["edit"], bytes: 23_000 },
  { id: "export", kind: "js", order: 100, requiredBy: ["edit"], bytes: 34_000 },
  { id: "bootstrap", kind: "js", role: "infra", order: 120, requiredBy: ["*"], bytes: 300 },
];

const manifest = { assets: ASSETS.map((asset) => ({...asset, mode: "inline"})) };
const policy = createPolicy({ figures: null, settings: { mode: "edit" }, env: {} });

/** id -> target, for readable assertions. */
const targets = (planned) => Object.fromEntries(planned.decisions.map((d) => [d.id, d.to]));
const targetMap = targets;

test("inline puts everything the mode needs in the file", () => {
  const edit = targets(policy.plan(manifest, {policy: "inline", mode: "edit"}));
  assert.equal(new Set(Object.values(edit)).size, 1, "every asset inline");
  assert.equal(edit.signals, "inline");
  assert.equal(edit.export, "inline");

  const view = targets(policy.plan(manifest, {policy: "inline", mode: "view"}));
  assert.equal(view.signals, "inline");
  assert.equal(view.figures, "inline");
  /* Capabilities the document does not have are absent, not offloaded. */
  assert.equal(view.editor, "absent");
  assert.equal(view.toolbar, "absent");
  assert.equal(view.status, "absent");
  assert.equal(view.progress, "absent");
});

test("smart inlines the body and offloads the authoring capability", () => {
  const smart = targets(policy.plan(manifest, {policy: "smart", mode: "edit"}));
  assert.equal(smart.signals, "inline", "reader assets stay in the file");
  assert.equal(smart.figures, "inline");
  assert.equal(smart["page-styles"], "inline");
  assert.equal(smart.editor, "online", "authoring goes to the CDN");
  assert.equal(smart.toolbar, "online");
  assert.equal(smart.export, "online");
  assert.equal(smart.status, "online");
  assert.equal(smart["toolbar-styles"], "online");
  assert.equal(smart.registry, "inline", "the loader is never offloaded");
});

test("smart collapses into inline in view mode, because nothing is authoring-only", () => {
  const smart = targets(policy.plan(manifest, {policy: "smart", mode: "view"}));
  const inline = targets(policy.plan(manifest, {policy: "inline", mode: "view"}));
  assert.deepEqual(smart, inline);
});

test("slim offloads everything except the loader", () => {
  const slim = targets(policy.plan(manifest, {policy: "slim", mode: "edit"}));
  assert.equal(slim.registry, "inline");
  assert.equal(slim["boot-ui"], "inline");
  assert.equal(slim.bootstrap, "inline");
  for (const id of ["page-styles", "signals", "figures", "editor", "toolbar", "export"]) {
    assert.equal(slim[id], "online", `${id} should be online`);
  }
});

test("the loader can never be offloaded, whatever the policy or the author says", () => {
  for (const name of policy.PRESETS) {
    const planned = targets(policy.plan(manifest, {policy: name, mode: "edit"}));
    assert.equal(planned.registry, "inline");
  }
  const forced = targets(policy.plan(manifest, {policy: "slim", mode: "edit", overrides: {registry: "absent"}}));
  assert.equal(forced.registry, "inline");
});

test("an override wins over the preset, and cannot resurrect an out-of-mode asset", () => {
  const planned = targets(policy.plan(manifest, {policy: "slim", mode: "edit", overrides: {editor: "inline", figures: "absent"}}));
  assert.equal(planned.editor, "inline");
  assert.equal(planned.figures, "absent");

  const view = targets(policy.plan(manifest, {policy: "inline", mode: "view", overrides: {editor: "inline"}}));
  assert.equal(view.editor, "absent", "mode eligibility is not negotiable");
});

test("persist keeps the preset while nothing is overridden", () => {
  for (const name of ["inline", "smart", "slim"]) {
    const planned = policy.plan(manifest, {policy: name, mode: "edit"});
    assert.deepEqual(policy.persist(planned), {policy: name});
    assert.equal(policy.presetFor(planned), name);
  }
});

test("persist switches to an explicit map the moment anything is overridden", () => {
  const planned = policy.plan(manifest, {policy: "slim", mode: "edit", overrides: {figures: "inline"}});
  const stored = policy.persist(planned);
  assert.equal(policy.presetFor(planned), null);
  assert.ok(!("policy" in stored), "an overridden document must not claim a preset");
  assert.equal(stored.assets.figures, "inline");
  assert.equal(stored.assets.editor, "online");
  assert.ok(!("registry" in stored.assets), "the loader is never a choice");
});

test("a map wins over a stale preset when reading the document", () => {
  assert.deepEqual(policy.resolve({assets: {figures: "inline"}}), {policy: null, overrides: {figures: "inline"}});
  assert.deepEqual(policy.resolve({policy: "slim"}), {policy: "slim", overrides: {}});
  assert.deepEqual(policy.resolve({}), {policy: "inline", overrides: {}});
  assert.deepEqual(policy.resolve({policy: "nonsense"}), {policy: "inline", overrides: {}});
});

test("the estimate counts the inline bytes plus the rest of the document", () => {
  const planned = policy.plan(manifest, {policy: "slim", mode: "edit", baseBytes: 5_000});
  const infraBytes = 10_000 + 10_000 + 300;
  assert.equal(planned.inlineBytes, infraBytes);
  assert.equal(planned.estimate, 5_000 + infraBytes);
});

/* A plugin's presence is the author's switch, not a figure count: an installed plugin
   may contribute menus and be used by no figure at all. */
test("a plugin travels while it is switched on, and is absent when switched off", () => {
  const plugin = (enabled) => ({
    plugins: { mermaid: { enabled } },
    assets: [
      ...ASSETS.map((asset) => ({...asset, mode: "inline"})),
      {id: "mermaid", kind: "js", order: 200, category: "plugin", plugin: "mermaid", requiredBy: ["*"], mode: "online", bytes: 860_000},
    ],
  });

  const on = targetMap(policy.plan(plugin(true), {policy: "inline", mode: "edit", usage: {}}));
  assert.equal(on.mermaid, "inline", "switched on with no figures still travels");

  const off = targetMap(policy.plan(plugin(false), {policy: "inline", mode: "edit", usage: {mermaid: 2}}));
  assert.equal(off.mermaid, "absent", "switched off is absent even when a figure wants it");

  const slim = targetMap(policy.plan(plugin(true), {policy: "slim", mode: "edit", usage: {mermaid: 1}}));
  assert.equal(slim.mermaid, "online", "and it follows the preset like any asset");
});

test("a plugin a figure needs cannot be set absent by the save policy", () => {
  const doc = {
    plugins: { mermaid: { enabled: true } },
    assets: [
      ...ASSETS.map((asset) => ({...asset, mode: "inline"})),
      {id: "mermaid", kind: "js", order: 200, category: "plugin", plugin: "mermaid", requiredBy: ["*"], mode: "online", bytes: 860_000},
    ],
  };
  /* Document settings could set `absent` while the Plugins sheet refused to switch the
     plugin off — two guardrails, one door. The door clamps now. */
  const used = targetMap(policy.plan(doc, {policy: "inline", mode: "edit", overrides: {mermaid: "absent"}, usage: {mermaid: 1}}));
  assert.equal(used.mermaid, "inline", "a figure needs it, so it travels");
  const unused = targetMap(policy.plan(doc, {policy: "inline", mode: "edit", overrides: {mermaid: "absent"}, usage: {}}));
  assert.equal(unused.mermaid, "absent", "an unused plugin is still the author's to drop");
});

test("a plugin asset with no plugin entry in the index is absent", () => {
  const orphan = {
    assets: [
      ...ASSETS.map((asset) => ({...asset, mode: "inline"})),
      {id: "mermaid", kind: "js", order: 200, category: "plugin", plugin: "mermaid", requiredBy: ["*"], mode: "online", bytes: 1},
    ],
  };
  assert.equal(targetMap(policy.plan(orphan, {policy: "inline", mode: "edit"})).mermaid, "absent");
});

test("an override cannot keep a switched-off plugin in the file", () => {
  const planned = policy.plan(
    {
      plugins: { mermaid: { enabled: false } },
      assets: [
        ...ASSETS.map((asset) => ({...asset, mode: "inline"})),
        {id: "mermaid", kind: "js", order: 200, category: "plugin", plugin: "mermaid", requiredBy: ["*"], mode: "online", bytes: 1},
      ],
    },
    {policy: "inline", mode: "edit", overrides: {mermaid: "inline"}},
  );
  assert.equal(targetMap(planned).mermaid, "absent", "the switch is decided before the override");
});

/* ---------------------------------------------------------------- capabilities */

/* A capability the document does not declare is absent — the same rule as a mode, and
   the reason a document that never used comments does not carry the comments bundle
   (invariant 28). `off` is the one value that must not read as truthy. */
const WITH_CAPABILITY = {
  assets: [
    ...ASSETS.map((asset) => ({...asset, mode: "inline"})),
    {id: "comments", kind: "js", order: 76, requiredBy: ["*"], capability: "comments", mode: "inline", bytes: 6_000},
    {id: "comment-styles", kind: "css", order: 26, requiredBy: ["*"], capability: "comments", mode: "inline", bytes: 2_000},
  ],
};

test("an undeclared capability is absent in every policy and mode", () => {
  for (const preset of ["inline", "smart", "slim"]) {
    for (const mode of ["edit", "comment", "view"]) {
      const planned = targetMap(policy.plan(WITH_CAPABILITY, {policy: preset, mode}));
      assert.equal(planned.comments, "absent", `${preset}/${mode}: no declaration means no bytes`);
      assert.equal(planned["comment-styles"], "absent");
    }
  }
});

test("a declared capability travels, and \"off\" is a declared no", () => {
  const write = targetMap(policy.plan(WITH_CAPABILITY, {policy: "inline", mode: "comment", capabilities: {comments: "write"}}));
  assert.equal(write.comments, "inline", "a document that may be annotated carries the annotator");
  assert.equal(write["comment-styles"], "inline");

  const read = targetMap(policy.plan(WITH_CAPABILITY, {policy: "slim", mode: "view", capabilities: {comments: "read"}}));
  assert.equal(read.comments, "online", "the preset still decides how it travels");
  assert.equal(read["comment-styles"], "online");

  const off = targetMap(policy.plan(WITH_CAPABILITY, {policy: "inline", mode: "view", capabilities: {comments: "off"}}));
  assert.equal(off.comments, "absent", "\"off\" is false, not a truthy string");
  assert.equal(off["comment-styles"], "absent");
});

test("capabilities survive a preset round trip", () => {
  const declared = {comments: "write", edit: "off"};
  const planned = policy.plan(WITH_CAPABILITY, {policy: "inline", mode: "comment", capabilities: declared});
  assert.deepEqual(planned.capabilities, declared, "the plan carries what the file will declare");
  /* `presetFor()` re-plans from decisions alone; a capability dropped there would make a
     document with an absent comments bundle look like a hand-edited storage map. */
  assert.equal(policy.presetFor(planned), "inline");
  const slim = policy.plan(WITH_CAPABILITY, {policy: "slim", mode: "comment", capabilities: declared});
  assert.equal(policy.presetFor(slim), "slim", "the same capability set does not look like an override");
  assert.equal(targetMap(slim).comments, "online");
});

test("settingsFragment writes capabilities only when they differ", () => {
  const declared = {comments: "write"};
  const planned = policy.plan(WITH_CAPABILITY, {policy: "inline", mode: "edit", capabilities: declared});
  assert.deepEqual(policy.settingsFragment(planned, {}).capabilities, declared, "an export declares them");

  const stored = {capabilities: declared};
  const same = policy.plan(WITH_CAPABILITY, {policy: "inline", mode: "edit", capabilities: {...declared}});
  assert.equal(policy.settingsFragment(same, stored).capabilities, declared, "the stored object is reused, so its key order is stable");

  const none = policy.plan(WITH_CAPABILITY, {policy: "inline", mode: "edit"});
  assert.equal("capabilities" in policy.settingsFragment(none, {}), false, "a no-op save invents nothing");
});
