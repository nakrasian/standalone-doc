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
