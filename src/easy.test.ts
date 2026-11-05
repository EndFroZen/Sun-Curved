// Run: node src/easy.test.ts
import assert from "node:assert/strict";
import { parseManifest, TEMPLATE } from "./deploy.ts";
import { addStep, count, errKey, get, isScript, keyOf, move, moveStep, moveTo, openDoc, push, put, relTo, removeAt, stepsOf, toSteps, wrapInIf } from "./easy.ts";

const out = (d: ReturnType<typeof openDoc>) => d.toString({ lineWidth: 0 });

// editing a value keeps the comment on that line
let d = openDoc(TEMPLATE);
put(d, ["spec", "targets", 0, "dirty"], "fail");
assert.match(out(d), /dirty: fail\s+# ask \| discard \| fail/);
assert.equal(parseManifest(out(d)).targets[0].dirty, "fail");

// blank removes the key; setting creates it again
put(d, ["spec", "envFrom"], "  ");
assert.ok(!/^\s*envFrom:/m.test(out(d)));
put(d, ["spec", "envFrom"], "~/a.env");
assert.equal(parseManifest(out(d)).envFrom, "~/a.env");

// targets: add, move, remove
push(d, ["spec", "targets"], { name: "sub", path: "~/Projects/sub", dirty: "ask" });
assert.equal(count(d, ["spec", "targets"]), 2);
move(d, ["spec", "targets"], 1, -1);
assert.deepEqual(parseManifest(out(d)).targets.map((t) => t.name), ["sub", "main"]);
move(d, ["spec", "targets"], 0, -1); // already first: no-op
removeAt(d, ["spec", "targets"], 0);
assert.deepEqual(parseManifest(out(d)).targets.map((t) => t.name), ["main"]);

// steps: old-style keys are shown as steps, and become steps on the first edit
{
  const e = openDoc(TEMPLATE);
  assert.deepEqual(stepsOf(e, 0), [{ unmount: "public/cache" }, "checkout", { run: "./build.sh" }, { mount: { from: "/data/cache", to: "public/cache" } }, { pm2: { app: "my-app", do: "status" } }]);
  const before = parseManifest(out(e)).targets[0].steps;
  toSteps(e, 0);
  assert.ok(!/^\s+(build|mounts|pm2):/m.test(out(e)));
  assert.match(out(e), /- mount: \{ from: \/data\/cache, to: public\/cache \}/);
  assert.deepEqual(parseManifest(out(e)).targets[0].steps, before); // same deploy
  // the user's flow: unmount, npm ci, build, mount, pm2 restart
  put(e, ["spec", "targets", 0, "steps", 2, "run"], "npm run build");
  const k = addStep(e, 0, { run: "npm ci" });
  moveTo(e, ["spec", "targets", 0, "steps"], k, 2);
  put(e, ["spec", "targets", 0, "steps", 5, "pm2", "do"], "restart");
  assert.deepEqual(parseManifest(out(e)).targets[0].steps.map((s) => s.kind + (s.kind === "run" ? " " + s.cmd : s.kind === "pm2" ? " " + s.do : "")),
    ["unmount", "checkout", "run npm ci", "run npm run build", "mount", "pm2 restart"]);
  // checkout goes first; deleting every step keeps an empty list (not the old keys)
  removeAt(e, ["spec", "targets", 0, "steps"], 1);
  assert.equal(addStep(e, 0, "checkout"), 0);
  while (count(e, ["spec", "targets", 0, "steps"])) removeAt(e, ["spec", "targets", 0, "steps"], 0);
  assert.deepEqual(stepsOf(e, 0), []);
  // pm2: name (short form) becomes a map before editing
  const f = openDoc(TEMPLATE.replace(/      build:[\s\S]*$/, "      steps: [checkout, { pm2: app1 }]\n"));
  toSteps(f, 0);
  assert.deepEqual(stepsOf(f, 0)[1], { pm2: { app: "app1", do: "status" } });
  // if: added like the form does, steps go into its then / else lists (created when missing)
  const S = ["spec", "targets", 0, "steps"];
  toSteps(e, 0);
  const k2 = addStep(e, 0, { if: { run: "", then: [{ log: "ok" }], else: [] } });
  put(e, [...S, k2, "if", "run"], "./build.sh");
  addStep(e, 0, { pm2: { app: "app1", do: "restart" } }, [...S, k2, "if", "then"]);
  addStep(e, 0, { fail: "build failed" }, [...S, k2, "if", "else"]);
  removeAt(e, [...S, k2, "if", "then"], 0);
  assert.match(out(e), /- if:\n\s+run: \.\/build\.sh\n\s+then:\n\s+- pm2: \{ app: app1, do: restart \}\n\s+else:\n\s+- fail: build failed/);
  assert.deepEqual(parseManifest(out(e)).targets[0].steps[k2], {
    kind: "if", cond: "./build.sh", then: [{ kind: "pm2", app: "app1", do: "restart" }], else: [{ kind: "fail", text: "build failed" }],
  });
  // short forms inside if become editable maps too
  const h = openDoc(TEMPLATE.replace(/      build:[\s\S]*$/, "      steps: [{ if: { run: x, then: [{ pm2: a }], else: [fail] } }]\n"));
  toSteps(h, 0);
  assert.deepEqual(stepsOf(h, 0)[0], { if: { run: "x", then: [{ pm2: { app: "a", do: "status" } }], else: [{ fail: "" }] } });
}

// mounts: removing the last one drops the key
removeAt(d, ["spec", "targets", 0, "mounts"], 0);
assert.ok(!out(d).includes("mounts"));
push(d, ["spec", "targets", 0, "mounts"], { from: "/data", to: "public/x" });
assert.deepEqual(parseManifest(out(d)).targets[0].steps.filter((s) => s.kind === "mount"), [{ kind: "mount", from: "/data", to: "public/x" }]);

// numbers-looking values stay strings
put(d, ["spec", "source", "version"], "1.10");
assert.equal(parseManifest(out(d)).version, "1.10");

// a bare "spec:" (null) becomes a map when written into
d = openDoc("apiVersion: suncurved/v1\nkind: Deployment\nmetadata:\n  name: x\nspec:\n");
put(d, ["spec", "source", "repo"], "github.com/a/b");
push(d, ["spec", "targets"], { name: "main", path: "~/b" });
assert.equal(parseManifest(out(d)).gitUrl, "https://github.com/a/b.git");
assert.equal(get(d, ["spec", "targets", 0, "path"]), "~/b");

assert.throws(() => openDoc("a: ["), /YAML/);
assert.throws(() => openDoc("- a"), /key: value/);

// helpers
assert.ok(isScript("~/switch-3001.sh") && isScript("./build.sh") && !isScript("npm ci") && !isScript("bash x.sh"));
assert.equal(relTo("~/Projects/app/", "~/Projects/app/scripts/b.sh"), "./scripts/b.sh");
assert.equal(relTo("~/Projects/app", "~/other.sh"), "~/other.sh");
assert.equal(keyOf(["spec", "targets", 0, "mounts", 1, "from"]), "spec.targets[0].mounts[1].from");
assert.equal(errKey("spec.targets[0].path is required"), "spec.targets[0].path");
assert.equal(errKey("metadata.name: lowercase letters"), "metadata.name");
// the user's case: npm run build as its own step, pm2 after the if -> make build the condition, move pm2 under "passed"
{
  const S = ["spec", "targets", 0, "steps"];
  const e = openDoc(TEMPLATE.replace(/      build:[\s\S]*$/, `      steps:
        - checkout
        - run: npm ci
        - run: npm run build
        - if:
            run: ""
            then:
              - log: ok
            else:
              - fail: no
        - pm2: { app: web, do: restart }
`));
  const kinds = () => stepsOf(e, 0).map((s: any) => (typeof s === "string" ? s : Object.keys(s)[0]));
  // pm2 (index 4) -> then of the if at index 3
  assert.ok(moveStep(e, 0, S, 4, [...S, 3, "if", "then"]));
  assert.deepEqual((stepsOf(e, 0)[3] as any).if.then, [{ log: "ok" }, { pm2: { app: "web", do: "restart" } }]);
  // npm run build (index 2) becomes an if of its own; the old empty if can be deleted
  assert.ok(wrapInIf(e, 0, S, 2));
  assert.deepEqual(stepsOf(e, 0)[2], { if: { run: "npm run build", then: [{ log: "npm run build ผ่าน" }], else: [{ fail: "npm run build ไม่ผ่าน" }] } });
  // move the whole then-list content of the old if (index 3) into the new one (index 2), then out of an if
  assert.ok(moveStep(e, 0, [...S, 3, "if", "then"], 1, [...S, 2, "if", "then"]));
  assert.ok(moveStep(e, 0, [...S, 2, "if", "then"], 0, S, 3)); // the log goes out, right after the if
  assert.deepEqual(kinds(), ["checkout", "run", "if", "log", "if"]);
  assert.deepEqual((stepsOf(e, 0)[2] as any).if.then, [{ pm2: { app: "web", do: "restart" } }]);
  // moving a step that sits above an if into that if: the if's index shifts, still lands right
  assert.ok(moveStep(e, 0, S, 1, [...S, 2, "if", "else"], 0));
  assert.deepEqual((stepsOf(e, 0)[1] as any).if.else, [{ run: "npm ci" }, { fail: "npm run build ไม่ผ่าน" }]);
  // emptied then / else lists go away; not allowed: into itself, checkout into an if
  assert.ok(moveStep(e, 0, [...S, 3, "if", "then"], 0, S));
  assert.ok(!("then" in (stepsOf(e, 0)[3] as any).if));
  assert.ok(!moveStep(e, 0, S, 1, [...S, 1, "if", "then"]));
  assert.ok(!moveStep(e, 0, S, 0, [...S, 1, "if", "then"]));
  removeAt(e, S, 3); // the old if with no condition
  assert.deepEqual(parseManifest(out(e)).targets[0].steps.map((s) => s.kind), ["checkout", "if", "log", "log"]); // a valid deployment
}
console.log("easy ok");
