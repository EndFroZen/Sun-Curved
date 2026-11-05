// Run: node src/flow.test.ts
import assert from "node:assert/strict";
import { compile, parseManifest, TEMPLATE } from "./deploy.ts";
import { flowSteps } from "./flow.ts";

const s = flowSteps(compile(parseManifest(TEMPLATE), { tag: "v1", discard: [], sudoPassword: "x" }));
assert.deepEqual(
  s.map((x) => x.title),
  ["traffic -> 3001", "main: unmount", "main: checkout $TAG", "main: build", "main: mount", "main: pm2 my-app", "traffic -> 3000", "DEPLOYMENT SUCCESS"],
);
assert.equal(s[0].group, "nginx");
assert.equal(s[3].group, "main");
assert.equal(s[3].label, "build");
assert.ok(s[3].cmds.includes("./build.sh"));
assert.ok(!s[s.length - 1].cmds.includes("} < /dev/null"));
console.log("flow ok");
