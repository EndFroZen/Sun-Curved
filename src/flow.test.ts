// Run: node src/flow.test.ts
import assert from "node:assert/strict";
import { compile, parseManifest, TEMPLATE } from "./deploy.ts";
import { flowKind, flowSteps, isoLayout, nextStep } from "./flow.ts";

const s = flowSteps(compile(parseManifest(TEMPLATE), { tag: "v1", discard: [], sudoPassword: "x" }));
assert.deepEqual(
  s.map((x) => x.title),
  ["main: unmount public/cache", "main: checkout $TAG", "main: ./build.sh", "main: mount public/cache", "main: pm2 status my-app", "DEPLOYMENT SUCCESS"],
);
assert.equal(s[2].group, "main");
assert.equal(s[2].label, "./build.sh");
assert.ok(s[2].cmds.includes("./build.sh"));
assert.equal(s[s.length - 1].group, "done");
assert.ok(!s[s.length - 1].cmds.includes("} < /dev/null"));
assert.deepEqual(s.map(flowKind), ["mount", "git", "run", "mount", "pm2", "done"]);

// if: branches are marked, plumbing lines hidden, a `==> ` title jumps over the branch that didn't run
{
  const m = parseManifest(TEMPLATE.replace(/      build:[\s\S]*$/, `      steps:
        - checkout
        - if:
            run: ./build.sh
            then:
              - pm2: { app: my-app, do: restart }
            else:
              - run: echo old
              - fail: build failed
        - run: echo after
`));
  const f = flowSteps(compile(m, { tag: "v1", discard: [] }));
  assert.deepEqual(f.map((x) => [x.label, x.branch.join("/")]), [
    ["checkout $TAG", ""], ["if ./build.sh", ""], ["pm2 restart my-app", "then"], ["echo old", "else"], ["fail build failed", "else"], ["echo after", ""], ["DEPLOYMENT SUCCESS", ""],
  ]);
  assert.deepEqual(f[1].cmds.slice(1), ["./build.sh"]); // after the cd
  assert.deepEqual(f.map(flowKind).slice(1, 5), ["if", "pm2", "run", "fail"]);
  assert.equal(nextStep(f, 1, "main: echo after"), 5); // condition passed: else steps skipped
  assert.equal(nextStep(f, 1, "main: echo old"), 3);
  assert.equal(nextStep(f, 1, "something else"), 2);

  // 3D view: then goes to one side, else to the other, they meet after the longer branch; fail has no way out
  const { pos, edges } = isoLayout(f);
  assert.deepEqual(pos, [{ col: 0, lane: 0 }, { col: 1, lane: 0 }, { col: 2, lane: -1 }, { col: 2, lane: 1 }, { col: 3, lane: 1 }, { col: 4, lane: 0 }, { col: 5, lane: 0 }]);
  assert.deepEqual(edges, [[0, 1], [1, 2], [1, 3], [3, 4], [2, 5], [5, 6]]);
}
// straight pipeline: one lane; an if with only an else falls through when the condition passes
assert.deepEqual(isoLayout(s).pos.map((p) => p.lane), [0, 0, 0, 0, 0, 0]);
{
  const g = [{ branch: [] }, { branch: ["else"] }, { branch: [] }].map((b, i) => ({ title: "t" + i, group: "main", label: "x", cmds: [], ...b }));
  assert.deepEqual(isoLayout(g).edges, [[0, 1], [0, 2], [1, 2]]);
}
console.log("flow ok");
