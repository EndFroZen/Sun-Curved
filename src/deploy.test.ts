// Run: node src/deploy.test.ts   (Node 22.6+ strips the types; needs bash + git on PATH)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, dq, parseManifest, parsePm2, scripts, sq, suggest, TEMPLATE, TERMINAL_PATH, yamlPath } from "./deploy.ts";

// --- parsing ---
const t = parseManifest(TEMPLATE);
assert.equal(t.gitUrl, "https://github.com/me/my-app.git");
// old-style keys become steps in the old fixed order
assert.deepEqual(t.targets[0].steps, [
  { kind: "unmount", to: "public/cache" },
  { kind: "checkout" },
  { kind: "run", cmd: "./build.sh" },
  { kind: "mount", from: "/data/cache", to: "public/cache" },
  { kind: "pm2", app: "my-app", do: "status" },
]);
const bad = (yaml: string, msg: RegExp) => assert.throws(() => parseManifest(yaml), msg);
bad("kind: Deployment", /apiVersion/);
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
const yaml = `apiVersion: suncurved/v1
kind: Deployment
metadata: { name: demo }
spec:
  source: { repo: "file://${remote.startsWith("/") ? "" : "/"}${remote}", version: tag }
  targets:
    - name: main
      path: ~/app
      dirty: ask
      build: cat > /dev/null; echo "built at $(git describe --tags)" > built.txt
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
assert.match(readFileSync(`${home}/EndFroZen/SunCurved/state/demo`, "utf8"), /^v1\.0\.0 ok /);

// dirty tree + not discarded -> fails, state says failed
writeFileSync(`${home}/app/junk.txt`, "x");
assert.match(run(scripts.precheck(m)).stdout.toString(), /dirty main\n[\s\S]*\?\? junk.txt/);
r = run(compile(m, { tag: "v1.2.0", discard: [] }));
assert.notEqual(r.status, 0);
assert.match(r.stdout.toString(), /!! FAILED at: main: checkout \$TAG\n/);
assert.match(readFileSync(`${home}/EndFroZen/SunCurved/state/demo`, "utf8"), /^v1\.2\.0 failed /);

// dirty tree + discard -> deploys v1.2.0
r = run(compile(m, { tag: "v1.2.0", discard: ["main"] }));
assert.equal(r.status, 0, r.stdout.toString());
assert.equal(readFileSync(`${home}/app/built.txt`, "utf8").trim(), "built at v1.2.0");

// branch mode (no tags): pulls the newest commit of the branch, records branch@sha
g(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "three");
g(seed, "push", "-q", remote, "HEAD:refs/heads/main");
const head = g(seed, "rev-parse", "--short", "HEAD").trim();
const mb = parseManifest(yaml.replace("version: tag", "branch: main"));
assert.equal(mb.branch, "main");
assert.ok(!/^tag /m.test(run(scripts.precheck(mb)).stdout.toString())); // no tag listing
r = run(compile(mb, { tag: "main", discard: ["main"] })); // built.txt from the runs above
assert.equal(r.status, 0, r.stdout.toString() + r.stderr.toString());
assert.match(r.stdout.toString(), /==> main: pull main\n[\s\S]* three\n/);
assert.equal(g(`${home}/app`, "rev-parse", "--short", "HEAD").trim(), head);
assert.match(readFileSync(`${home}/EndFroZen/SunCurved/state/demo`, "utf8"), new RegExp(`^main@${head} ok `));
// second run: already up to date, still fine
assert.equal(run(compile(mb, { tag: "main", discard: ["main"] })).status, 0);
bad(yaml.replace("version: tag", "version: tag, branch: main"), /either version .* or branch/);
bad(yaml.replace("version: tag", "branch: \"-x\""), /not a valid branch/);

// steps: any order, e.g. unmount -> npm ci -> build -> mount -> pm2 restart
{
  const flow = parseManifest(TEMPLATE.replace(/      build:[\s\S]*$/, `      steps:
        - unmount: public/cache
        - checkout
        - run: npm ci
        - run: |
            npm run build
            echo done
        - mount: { from: /data/cache, to: public/cache }
        - pm2: { app: my-app, do: restart }
`));
  assert.deepEqual(flow.targets[0].steps.map((s) => s.kind), ["unmount", "checkout", "run", "run", "mount", "pm2"]);
  const sh = compile(flow, { tag: "v1", discard: [], sudoPassword: "x" });
  const titles = [...sh.matchAll(/^step '(.*)'$/gm)].map((x) => x[1]);
  assert.deepEqual(titles, ["main: unmount public/cache", "main: checkout $TAG", "main: npm ci", "main: npm run build …", "main: mount public/cache", "main: pm2 restart my-app", "DEPLOYMENT SUCCESS"]);
  assert.match(sh, /pm2 restart 'my-app'/);
  // the old keys and steps can't be mixed; bad steps say where
  const tgt = TEMPLATE.replace(/      build:[\s\S]*$/, "");
  bad(tgt + "      build: x\n      steps: [checkout]\n", /use steps, or the old/);
  bad(tgt + "      steps: [checkout, checkout]\n", /only one checkout/);
  bad(tgt + "      steps: [{ bogus: 1 }]\n", /steps\[0\]: one of checkout/);
  bad(tgt + "      steps: [{ pm2: { app: a, do: kill } }]\n", /steps\[0\]\.pm2\.do/);
  bad(tgt.replace("sudo: login-password", "sudo: none") + "      steps: [{ unmount: x }]\n", /mount \/ unmount need spec.sudo/);
  assert.deepEqual(parseManifest(tgt + "      steps: [{ pm2: app1 }]\n").targets[0].steps, [{ kind: "pm2", app: "app1", do: "status" }]);
}
// steps really run in the written order around checkout
{
  writeFileSync(`${home}/order.log`, "");
  const ms = parseManifest(yaml.replace(/      build:.*\n/, `      steps:
        - run: echo "pre $(git describe --tags --always)" >> "$HOME/order.log"
        - checkout
        - run: echo "post $(git describe --tags)" >> "$HOME/order.log"
        - log: |
            deployed $TAG "ok" \`x\` 50% \\n
            line two
`));
  r = run(compile(ms, { tag: "v1.0.0", discard: ["main"] }));
  assert.equal(r.status, 0, r.stdout.toString() + r.stderr.toString());
  assert.match(readFileSync(`${home}/order.log`, "utf8"), /^pre .+\npost v1\.0\.0\n$/);
  // log step: one "## " line per line, $TAG expanded, quotes / backticks / % / \ printed as written
  assert.match(r.stdout.toString(), /\n## deployed v1\.0\.0 "ok" `x` 50% \\n\n## line two\n/);
  assert.deepEqual(ms.targets[0].steps.at(-1), { kind: "log", text: 'deployed $TAG "ok" `x` 50% \\n\nline two' });
}

// if: build passed -> then, failed -> else (deploy goes on); custom conditions; fail stops with a message
{
  const tgt = TEMPLATE.replace(/      build:[\s\S]*$/, "");
  bad(tgt + "      steps: [{ if: { then: [{ run: x }] } }]\n", /steps\[0\]\.if\.run is required/);
  bad(tgt + "      steps: [{ if: { run: x } }]\n", /needs steps in then or else/);
  bad(tgt + "      steps: [{ if: { run: x, when: 1, then: [{ run: y }] } }]\n", /if\.when: only run, then and else/);
  bad(tgt + "      steps: [{ if: { run: x, else: [checkout] } }]\n", /if\.else\[0\]: checkout can't be inside if/);
  bad(tgt.replace("sudo: login-password", "sudo: none") + "      steps: [{ if: { run: x, then: [{ mount: { from: a, to: b } }] } }]\n", /mount \/ unmount need/);
  assert.deepEqual(parseManifest(tgt + "      steps: [{ if: { run: x, else: [fail] } }]\n").targets[0].steps, [
    { kind: "if", cond: "x", then: [], else: [{ kind: "fail", text: "stopped by a fail step" }] },
  ]);

  const withIf = (cond: string, extra = "") =>
    parseManifest(yaml.replace(/      build:.*\n/, `      steps:
        - checkout
        - if:
            run: |
              ${cond}
              echo cond-ran >> "$HOME/if.log"
            then:
              - run: echo "then $TAG" >> "$HOME/if.log"
              - if:
                  run: test -f built.txt
                  then: [{ run: echo nested-then >> "$HOME/if.log" }]
                  else: [{ run: echo nested-else >> "$HOME/if.log" }]
            else:
              - log: build failed
              - run: echo "else" >> "$HOME/if.log"
        - run: echo after >> "$HOME/if.log"
${extra}`));
  const go = (cond: string, extra = "") => {
    writeFileSync(`${home}/if.log`, "");
    const r = run(compile(withIf(cond, extra), { tag: "v1.0.0", discard: ["main"] }));
    return { r, log: readFileSync(`${home}/if.log`, "utf8"), out: r.stdout.toString() };
  };
  // build passes
  let x = go(`echo built > built.txt`);
  assert.equal(x.r.status, 0, x.out + x.r.stderr.toString());
  assert.equal(x.log, "cond-ran\nthen v1.0.0\nnested-then\nafter\n");
  assert.match(x.out, /condition passed -> then/);
  // build fails at its first line: the rest of the condition doesn't run (set -e inside), else runs, deploy still ok
  x = go(`rm -f built.txt; false`);
  assert.equal(x.r.status, 0, x.out + x.r.stderr.toString());
  assert.equal(x.log, "else\nafter\n");
  assert.match(x.out, /condition failed \(exit 1\) -> else\n## build failed\n/);
  assert.match(readFileSync(`${home}/EndFroZen/SunCurved/state/demo`, "utf8"), /^v1\.0\.0 ok /);
  // a custom condition ($TAG), and set -e is back on after the if
  x = go(`[ "$TAG" = v9 ]`, `        - run: "false"\n        - run: echo never >> "$HOME/if.log"\n`);
  assert.notEqual(x.r.status, 0);
  assert.equal(x.log, "else\nafter\n");
  assert.match(x.out, /!! FAILED at: main: false/);
  // fail step: stops with its message, state = failed
  x = go(`false`, `        - fail: stop $TAG now\n        - run: echo never >> "$HOME/if.log"\n`);
  assert.notEqual(x.r.status, 0);
  assert.match(x.out, /\n!! stop v1\.0\.0 now\n/);
  assert.ok(!x.log.includes("never"));
  assert.match(readFileSync(`${home}/EndFroZen/SunCurved/state/demo`, "utf8"), /^v1\.0\.0 failed /);
}

// standalone script file: no password inside, tag from $1, sudo asks on the terminal
{
  const full = parseManifest(TEMPLATE);
  const file = compile(full, { tag: "", discard: ["main"], sudoPassword: "s3cret", standalone: true });
  assert.ok(!file.includes("s3cret") && !file.includes("SUDO_PW"));
  assert.match(file, /sudo_cmd\(\) \{ sudo "\$@"; \}/);
  assert.match(file, /TAG="\$\{1:\?usage/);
  assert.match(file, /read -r -p 'discard these changes in main\? \[y\/N\] ' a < \/dev\/tty/); // discard list ignored: asks
  assert.ok(!file.includes("} < /dev/null"));
  // save it on the "machine" and run it like a user would: file + chmod 700 + ./x.sh <tag>
  const saved = run(scripts.saveSh("demo", compile(m, { tag: "", discard: [], standalone: true })));
  assert.equal(saved.status, 0, saved.stderr.toString());
  const path = saved.stdout.toString().trim();
  assert.match(path, /EndFroZen\/SunCurved\/scripts\/demo\.sh$/);
  execFileSync("git", ["-C", `${home}/app`, "clean", "-fdq"]); // clean tree: nothing to ask
  execFileSync("git", ["-C", `${home}/app`, "reset", "-q", "--hard"]);
  const noTag = spawnSync("bash", [path], { env: { ...process.env, HOME: home } });
  assert.notEqual(noTag.status, 0);
  assert.match(noTag.stderr.toString(), /usage: .* <tag>/);
  const ok = spawnSync("bash", [path, "v1.0.0"], { env: { ...process.env, HOME: home } });
  assert.equal(ok.status, 0, ok.stdout.toString() + ok.stderr.toString());
  assert.equal(readFileSync(`${home}/app/built.txt`, "utf8").trim(), "built at v1.0.0");
  assert.match(run(scripts.remove("demo")).stdout.toString(), /deleted/);
  assert.throws(() => readFileSync(path));
}

// pm2 process names for the form
assert.equal(parsePm2("pm2 no\n"), null);
assert.deepEqual(parsePm2("pm2 yes\n[]\n"), []);
assert.deepEqual(parsePm2('pm2 yes\n[PM2] Spawning PM2 daemon\n[{"name":"web","pm_id":0},{"name":"api"},{"name":"web"}]\n'), ["api", "web"]);
assert.deepEqual(parsePm2("pm2 yes\ngarbage\n"), []);
// no pm2 on PATH -> "pm2 no"; pm2 present but no daemon -> empty list, daemon not started
assert.equal(parsePm2(run(`PATH=/nonexistent\n${scripts.pm2Apps()}`).stdout.toString()), null);
{
  const bin = `${home}/bin`;
  execFileSync("bash", ["-c", `mkdir -p "${bin}" && printf '#!/bin/sh\\necho STARTED >> "$HOME/pm2.log"\\n' > "${bin}/pm2" && chmod +x "${bin}/pm2"`]);
  const out = run(`PATH="$(cd "${bin}" && pwd):$PATH"\n${scripts.pm2Apps()}`).stdout.toString(); // pwd: C:/x -> /c/x on Windows
  assert.deepEqual(parsePm2(out), []);
  assert.throws(() => readFileSync(`${home}/pm2.log`)); // pm2 was never run
  // pm2 only on the PATH set in the deployment's env file (e.g. nvm) -> still found
  execFileSync("bash", ["-c", `cd "${bin}" && echo "PATH=$(pwd):\\$PATH" > "${home}/pm2.env"`]);
  assert.equal(parsePm2(run(`PATH=/usr/bin:/bin\n${scripts.pm2Apps()}`).stdout.toString()), null);
  assert.deepEqual(parsePm2(run(`PATH=/usr/bin:/bin\n${scripts.pm2Apps("~/pm2.env")}`).stdout.toString()), []);
  // pm2 only on the terminal's PATH: added at the END of ~/.bashrc, after Ubuntu's "not interactive -> return"
  // guard (that's where nvm puts it). No env file needed, and anything .bashrc prints is ignored.
  execFileSync("bash", ["-c", `cd "${bin}" && printf 'echo hello from bashrc\\ncase $- in *i*) ;; *) return;; esac\\nexport PATH="%s:$PATH"\\necho bye\\n' "$(pwd)" > "${home}/.bashrc"`]);
  assert.deepEqual(parsePm2(run(`PATH=/usr/bin:/bin\n${scripts.pm2Apps()}`).stdout.toString()), []);
  const sh = compile(parseManifest(TEMPLATE), { tag: "v1", discard: [] });
  const tp = sh.indexOf("__SC_PATH__");
  assert.ok(tp > 0 && tp < sh.indexOf("set -Eeo pipefail") && tp < sh.indexOf("set -a;")); // before set -e and the env file
  // a .bashrc that hangs or fails never breaks anything: PATH stays as it was
  writeFileSync(`${home}/.bashrc`, "exit 3\n");
  assert.equal(run(`PATH=/usr/bin:/bin\n${TERMINAL_PATH}\necho "$PATH"`).stdout.toString(), "/usr/bin:/bin\n");
  unlinkSync(`${home}/.bashrc`);
}

// env var names only, never values
writeFileSync(`${home}/a.env`, "GITHUB_TOKEN=ghp_secret\nexport USER_X=1\n# NOPE=1\nB = 2\n");
assert.equal(run(scripts.envNames("~/a.env")).stdout.toString(), "GITHUB_TOKEN\nUSER_X\n");

// --- editor suggestions ---
{
  const doc = TEMPLATE.split("\n");
  const row = (re: RegExp) => doc.findIndex((l) => re.test(l));
  assert.equal(yamlPath(doc, row(/^  sudo:/), 2), "spec");
  assert.equal(yamlPath(doc, row(/^    version:/), 4), "spec.source");
  assert.equal(yamlPath(doc, row(/^      path:/), 6), "spec.targets[]");
  assert.equal(yamlPath(doc, row(/^      dirty:/), 6), "spec.targets[]");
  assert.equal(yamlPath(doc, row(/^          to:/), 10), "spec.targets[].mounts[]");
  assert.equal(yamlPath([...doc.slice(0, row(/^          to:/) + 1), "      pm2: x"], row(/^          to:/) + 1, 6), "spec.targets[]"); // after the nested mounts list
  assert.equal(yamlPath(doc, row(/^      path:/), 4), "spec.targets"); // new item level
  assert.equal(yamlPath(doc, 0, 0), "");

  const labels = (r: ReturnType<typeof suggest>) => r?.items.map((i) => i.label) ?? [];
  const at = (re: RegExp, before: string) => suggest(doc, row(re), before);
  assert.ok(labels(at(/^  sudo:/, "  s")).includes("source"));
  assert.deepEqual(labels(at(/^  sudo:/, "  sudo: ")), ["login-password", "none"]);
  assert.deepEqual(labels(at(/^      dirty:/, "      dirty: d")), ["ask", "discard", "fail"]);
  assert.equal(at(/^      dirty:/, "      dirty: d")!.start, "      dirty: ".length);
  assert.ok(labels(at(/^      path:/, "    ")).includes("- target"));
  assert.ok(labels(at(/^          to:/, "          ")).includes("from"));
  assert.equal(at(/^  sudo:/, "  # note "), null);
}

console.log("deploy.ts ok");
