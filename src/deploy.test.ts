// Run: node src/deploy.test.ts   (Node 22.6+ strips the types; needs bash + git on PATH)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, dq, parseManifest, scripts, sq, suggest, TEMPLATE, yamlPath } from "./deploy.ts";

// --- parsing ---
const t = parseManifest(TEMPLATE);
assert.equal(t.gitUrl, "https://github.com/me/my-app.git");
assert.equal(t.targets[0].trafficBefore, "3001");
assert.deepEqual(t.targets[0].mounts, [{ from: "/data/cache", to: "public/cache" }]);
const bad = (yaml: string, msg: RegExp) => assert.throws(() => parseManifest(yaml), msg);
bad("kind: Deployment", /apiVersion/);
bad(TEMPLATE.replace("trafficBefore: 3001", "trafficBefore: 9999"), /no spec.traffic.nginx entry for 9999/);
bad(TEMPLATE.replace("sudo: login-password", "sudo: none"), /mounts need spec.sudo/);
bad(TEMPLATE.replace("token: GITHUB_TOKEN", "token: ghp_x-y"), /env var names/);
bad("a: [", /YAML/);

// --- quoting ---
const sh = (cmd: string, env: Record<string, string> = {}) =>
  execFileSync("bash", ["-c", cmd], { env: { ...process.env, ...env } }).toString();
assert.equal(sh(`printf %s ${sq(`it's $HOME "x"`)}`), `it's $HOME "x"`);
assert.equal(sh(`printf %s ${dq("~/a b/$x")}`, { HOME: "/h" }), "/h/a b/$x");

// --- end to end: compile, then run the script with bash against a real repo ---
const home = mkdtempSync(join(tmpdir(), "sc-")).replace(/\\/g, "/");
const remote = `${home}/remote.git`;
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: { ...process.env, HOME: home } }).toString();
execFileSync("git", ["init", "-q", "--bare", remote]);
const seed = `${home}/seed`;
execFileSync("git", ["init", "-q", seed]);
g(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
g(seed, "tag", "v1.0.0");
g(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "two");
g(seed, "tag", "v1.2.0");
g(seed, "push", "-q", remote, "--tags", "HEAD:refs/heads/main");
execFileSync("git", ["clone", "-q", remote, `${home}/app`]);
for (const p of ["3000", "3001"]) {
  writeFileSync(`${home}/sw${p}.sh`, `#!/bin/bash\necho switched ${p} >> "$HOME/traffic.log"\n`);
  chmodSync(`${home}/sw${p}.sh`, 0o755);
}
const yaml = `apiVersion: suncurved/v1
kind: Deployment
metadata: { name: demo }
spec:
  source: { repo: "file://${remote.startsWith("/") ? "" : "/"}${remote}", version: tag }
  traffic: { nginx: { 3000: ~/sw3000.sh, 3001: ~/sw3001.sh } }
  targets:
    - name: main
      path: ~/app
      trafficBefore: 3001
      dirty: ask
      build: cat > /dev/null; echo "built at $(git describe --tags)" > built.txt
      trafficAfter: 3000
`;
const m = parseManifest(yaml);
const run = (script: string) => spawnSync("bash", ["-s"], { input: script, env: { ...process.env, HOME: home } });

// precheck lists tags (sorted) and no dirty targets
const pre = run(scripts.precheck(m)).stdout.toString();
assert.deepEqual(pre.trim().split("\n"), ["tag v1.0.0", "tag v1.2.0"]);

// happy path
let r = run(compile(m, { tag: "v1.0.0", discard: [] }));
assert.equal(r.status, 0, r.stdout.toString() + r.stderr.toString());
assert.equal(readFileSync(`${home}/app/built.txt`, "utf8").trim(), "built at v1.0.0");
assert.equal(readFileSync(`${home}/traffic.log`, "utf8"), "switched 3001\nswitched 3000\n");
assert.match(readFileSync(`${home}/EndFroZen/SunCurved/state/demo`, "utf8"), /^v1\.0\.0 ok /);

// dirty tree + not discarded -> fails, stays on 3001, state says failed
writeFileSync(`${home}/app/junk.txt`, "x");
assert.match(run(scripts.precheck(m)).stdout.toString(), /dirty main\n[\s\S]*\?\? junk.txt/);
r = run(compile(m, { tag: "v1.2.0", discard: [] }));
assert.notEqual(r.status, 0);
assert.match(r.stdout.toString(), /!! FAILED at: main: checkout \$TAG\n!! nginx port: 3001/);
assert.match(readFileSync(`${home}/EndFroZen/SunCurved/state/demo`, "utf8"), /^v1\.2\.0 failed /);

// dirty tree + discard -> deploys v1.2.0
r = run(compile(m, { tag: "v1.2.0", discard: ["main"] }));
assert.equal(r.status, 0, r.stdout.toString());
assert.equal(readFileSync(`${home}/app/built.txt`, "utf8").trim(), "built at v1.2.0");

// --- editor suggestions ---
{
  const doc = TEMPLATE.split("\n");
  const row = (re: RegExp) => doc.findIndex((l) => re.test(l));
  assert.equal(yamlPath(doc, row(/^  sudo:/), 2), "spec");
  assert.equal(yamlPath(doc, row(/^    version:/), 4), "spec.source");
  assert.equal(yamlPath(doc, row(/^      path:/), 6), "spec.targets[]");
  assert.equal(yamlPath(doc, row(/^      trafficBefore:/), 6), "spec.targets[]");
  assert.equal(yamlPath(doc, row(/^          to:/), 10), "spec.targets[].mounts[]");
  assert.equal(yamlPath(doc, row(/^      trafficAfter:/), 6), "spec.targets[]"); // after the nested mounts list
  assert.equal(yamlPath(doc, row(/^      path:/), 4), "spec.targets"); // new item level
  assert.equal(yamlPath(doc, 0, 0), "");

  const labels = (r: ReturnType<typeof suggest>) => r?.items.map((i) => i.label) ?? [];
  const at = (re: RegExp, before: string) => suggest(doc, row(re), before);
  assert.ok(labels(at(/^  sudo:/, "  s")).includes("source"));
  assert.deepEqual(labels(at(/^  sudo:/, "  sudo: ")), ["login-password", "none"]);
  assert.deepEqual(labels(at(/^      dirty:/, "      dirty: d")), ["ask", "discard", "fail"]);
  assert.equal(at(/^      dirty:/, "      dirty: d")!.start, "      dirty: ".length);
  assert.deepEqual(labels(at(/^      trafficBefore:/, "      trafficBefore: ")), ["3000", "3001"]);
  assert.ok(labels(at(/^      path:/, "    ")).includes("- target"));
  assert.ok(labels(at(/^          to:/, "          ")).includes("from"));
  assert.equal(at(/^  sudo:/, "  # note "), null);
}

console.log("deploy.ts ok");
