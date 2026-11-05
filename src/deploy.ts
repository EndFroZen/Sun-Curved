// Sun Curved deploy engine: a Kubernetes-style manifest is compiled into ONE bash script,
// which is piped to `bash -s` on the machine. Interactive bits of the old shell scripts
// (pick a tag, discard local changes?) are asked in the app first and baked into the script.
import { parse } from "yaml";

export type Mount = { from: string; to: string };
export type Pm2Do = "restart" | "reload" | "status";
/** One step of a target, run in the order written. */
export type Step =
  | { kind: "checkout" }
  | { kind: "run"; cmd: string }
  | { kind: "mount"; from: string; to: string }
  | { kind: "unmount"; to: string }
  | { kind: "pm2"; app: string; do: Pm2Do }
  | { kind: "log"; text: string }
  | { kind: "fail"; text: string }
  /** `cond` is a bash command: exit 0 = passed -> `then`, anything else -> `else` (the deploy goes on). */
  | { kind: "if"; cond: string; then: Step[]; else: Step[] };
export type Target = {
  name: string;
  path: string;
  dirty: "ask" | "discard" | "fail";
  steps: Step[];
};

export const STEP_KINDS = ["checkout", "run", "mount", "unmount", "pm2", "log", "fail", "if"] as const;

/** Every step of a list, including the ones inside if / then / else. */
export const allSteps = (steps: Step[]): Step[] => steps.flatMap((s) => (s.kind === "if" ? [s, ...allSteps(s.then), ...allSteps(s.else)] : [s]));
export const PM2_DO: Pm2Do[] = ["restart", "reload", "status"];

/** Which step a raw YAML item is ("checkout" or a one-key map), or "" if none. */
export function stepKind(s: unknown): (typeof STEP_KINDS)[number] | "" {
  if (s === "checkout" || s === "fail") return s;
  if (!s || typeof s !== "object" || Array.isArray(s)) return "";
  const keys = Object.keys(s);
  return keys.length === 1 && (STEP_KINDS as readonly string[]).includes(keys[0]) ? (keys[0] as (typeof STEP_KINDS)[number]) : "";
}

/** Old-style target (build / mounts / pm2 keys) as the equivalent raw `steps` list. */
export function legacySteps(t: any): unknown[] {
  const mounts: any[] = Array.isArray(t?.mounts) ? t.mounts : [];
  return [
    ...mounts.map((m) => ({ unmount: m?.to })),
    "checkout",
    ...(t?.build ? [{ run: t.build }] : []),
    ...mounts.map((m) => ({ mount: { from: m?.from, to: m?.to } })),
    ...(t?.pm2 ? [{ pm2: { app: t.pm2, do: "status" } }] : []),
  ];
}
export type Manifest = {
  name: string;
  envFrom?: string;
  sudo: "login-password" | "none";
  gitUrl: string;
  auth?: { user: string; token: string }; // names of env vars, never the values
  version: string; // "tag" = choose at apply time, otherwise a fixed tag
  branch?: string; // set = no tags: pull the latest commit of this branch
  targets: Target[];
};

/** Root on the machine (used inside double quotes in shell). */
export const BASE = "$HOME/EndFroZen/SunCurved";

export const TEMPLATE = `apiVersion: suncurved/v1
kind: Deployment
metadata:
  name: my-app
spec:
  envFrom: ~/EndFroZen/CommandCenter/endfrozen.env   # optional; secrets stay on the machine
  sudo: login-password                               # or: none
  source:
    repo: github.com/me/my-app
    auth: { user: GITHUB_USERNAME, token: GITHUB_TOKEN }   # env var NAMES from envFrom
    version: tag                                     # pick a tag when applying
  targets:
    - name: main
      path: ~/Projects/my-app
      dirty: ask                                     # ask | discard | fail
      build: ./build.sh
      pm2: my-app
      mounts:
        - from: /data/cache
          to: public/cache                           # relative to path
`;

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
const str = (v: unknown, what: string) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is required`);
  return v.trim();
};
const optStr = (v: unknown, what: string) => (v === undefined || v === null ? undefined : str(String(v), what));

/** Parses and validates a manifest; throws Error with a message meant for the user. */
export function parseManifest(text: string): Manifest {
  let doc: any;
  try {
    doc = parse(text);
  } catch (e) {
    throw new Error(`YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  if (doc?.apiVersion !== "suncurved/v1") throw new Error('apiVersion must be "suncurved/v1"');
  if (doc.kind !== "Deployment") throw new Error('kind must be "Deployment"');
  const name = doc.metadata?.name;
  if (typeof name !== "string" || !NAME.test(name)) throw new Error("metadata.name: lowercase letters, digits and '-' only");
  const spec = doc.spec ?? {};

  const sudo = spec.sudo ?? "none";
  if (sudo !== "login-password" && sudo !== "none") throw new Error('spec.sudo must be "login-password" or "none"');

  const repo = str(spec.source?.repo, "spec.source.repo");
  const gitUrl = /^[a-z]+:\/\//.test(repo) || repo.includes("@") ? repo : `https://${repo.replace(/\.git$/, "")}.git`;
  let auth: Manifest["auth"];
  if (spec.source?.auth) {
    const { user, token } = spec.source.auth;
    if (!VAR.test(user ?? "") || !VAR.test(token ?? "")) throw new Error("spec.source.auth: user/token must be env var names");
    auth = { user, token };
  }

  const branch = optStr(spec.source?.branch, "spec.source.branch");
  if (branch !== undefined) {
    if (spec.source?.version !== undefined) throw new Error("spec.source: use either version (tags) or branch (git pull), not both");
    if (!/^[\w./-]+$/.test(branch) || branch.startsWith("-")) throw new Error("spec.source.branch: not a valid branch name");
  }

  if (!Array.isArray(spec.targets) || !spec.targets.length) throw new Error("spec.targets: at least one target");
  const targets: Target[] = spec.targets.map((t: any, i: number) => {
    const where = `spec.targets[${i}]`;
    const tname = t?.name;
    if (typeof tname !== "string" || !NAME.test(tname)) throw new Error(`${where}.name: lowercase letters, digits and '-' only`);
    const dirty = t.dirty ?? "ask";
    if (!["ask", "discard", "fail"].includes(dirty)) throw new Error(`${where}.dirty: ask | discard | fail`);
    let steps: Step[];
    if (t.steps === undefined) {
      // old style: validate with the keys the user actually wrote, then turn into steps
      (t.mounts ?? []).forEach((m: any, j: number) => {
        str(m?.from, `${where}.mounts[${j}].from`);
        str(m?.to, `${where}.mounts[${j}].to`);
      });
      optStr(t.build, `${where}.build`);
      optStr(t.pm2, `${where}.pm2`);
      steps = parseSteps(legacySteps(t), `${where}.steps`);
      if (t.mounts?.length && sudo === "none") throw new Error(`${where}.mounts need spec.sudo: login-password`);
    } else {
      if (t.build !== undefined || t.mounts !== undefined || t.pm2 !== undefined)
        throw new Error(`${where}: use steps, or the old build / mounts / pm2 keys - not both`);
      if (!Array.isArray(t.steps)) throw new Error(`${where}.steps: a list of steps`);
      steps = parseSteps(t.steps, `${where}.steps`);
      if (steps.filter((s) => s.kind === "checkout").length > 1) throw new Error(`${where}.steps: only one checkout`);
      if (allSteps(steps).some((s) => s.kind === "mount" || s.kind === "unmount") && sudo === "none")
        throw new Error(`${where}.steps: mount / unmount need spec.sudo: login-password`);
    }
    return { name: tname, path: str(t.path, `${where}.path`), dirty, steps };
  });

  return {
    name,
    envFrom: optStr(spec.envFrom, "spec.envFrom"),
    sudo,
    gitUrl,
    auth,
    version: String(spec.source?.version ?? "tag"),
    branch,
    targets,
  };
}

function parseSteps(items: unknown[], where: string, inIf = false): Step[] {
  return items.map((s: any, k): Step => {
    const w = `${where}[${k}]`;
    const kind = stepKind(s);
    if (!kind) throw new Error(`${w}: one of checkout, run, mount, unmount, pm2, log, fail, if`);
    if (kind === "checkout") {
      if (inIf) throw new Error(`${w}: checkout can't be inside if`);
      return { kind };
    }
    const v = typeof s === "string" ? undefined : s[kind];
    if (kind === "run") return { kind, cmd: str(v, `${w}.run`) };
    if (kind === "log") return { kind, text: str(v, `${w}.log`) };
    if (kind === "fail") return { kind, text: v === null || v === undefined || v === "" ? "stopped by a fail step" : str(String(v), `${w}.fail`) };
    if (kind === "if") {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${w}.if: { run: <condition>, then: [...], else: [...] }`);
      const extra = Object.keys(v).find((x) => !["run", "then", "else"].includes(x));
      if (extra) throw new Error(`${w}.if.${extra}: only run, then and else`);
      const list = (x: unknown, key: string) => {
        if (x === undefined || x === null) return [];
        if (!Array.isArray(x)) throw new Error(`${w}.if.${key}: a list of steps`);
        return parseSteps(x, `${w}.if.${key}`, true);
      };
      const then = list(v.then, "then");
      const els = list(v.else, "else");
      if (!then.length && !els.length) throw new Error(`${w}.if: needs steps in then or else`);
      return { kind, cond: str(v.run, `${w}.if.run`), then, else: els };
    }
    if (kind === "unmount") return { kind, to: str(v, `${w}.unmount`) };
    if (kind === "mount") return { kind, from: str(v?.from, `${w}.mount.from`), to: str(v?.to, `${w}.mount.to`) };
    const app = typeof v === "string" ? v : v?.app;
    const d = (typeof v === "object" && v?.do) || "status";
    if (!PM2_DO.includes(d)) throw new Error(`${w}.pm2.do: restart | reload | status`);
    return { kind, app: str(app, `${w}.pm2.app`), do: d };
  });
}

// ---------- shell building blocks ----------

/** Single-quotes a value for POSIX sh. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Double-quotes a path, turning a leading ~/ into $HOME/. */
export const dq = (p: string) => {
  const home = p === "~" || p.startsWith("~/");
  const rest = home ? p.slice(1) : p;
  return `"${home ? "$HOME" : ""}${rest.replace(/[\\"$`]/g, "\\$&")}"`;
};
const joinPath = (base: string, rel: string) => (rel.startsWith("/") || rel.startsWith("~") ? rel : `${base.replace(/\/$/, "")}/${rel}`);
const b64 = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));

function gitFn(m: Manifest) {
  if (!m.auth) return `git_auth() { git "$@"; }`;
  // Credentials come from env at run time; the token never appears in a URL or in `ps`.
  const helper = `!f() { echo "username=$${m.auth.user}"; echo "password=$${m.auth.token}"; }; f`;
  return `git_auth() { git -c credential.helper= -c ${sq(`credential.helper=${helper}`)} "$@"; }`;
}

/** Takes PATH from the user's interactive shell, i.e. what they get in a terminal (~/.bashrc: nvm, Go, ...).
 *  Scripts here run non-interactive, and Ubuntu's .bashrc returns early for those, so without this a deploy
 *  finds other (older) tools than the terminal does. The marker line keeps anything .bashrc prints out of
 *  the value; </dev/null + a 10 s cap stop a .bashrc that waits for input. Any problem: PATH stays as it was.
 *  Runs before `set -e` / the ERR trap so a failure here can never fail the deploy. */
export const TERMINAL_PATH = `__t=; command -v timeout >/dev/null 2>&1 && __t="timeout 10"
__p=$($__t bash -ic 'printf "\\n__SC_PATH__%s\\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^__SC_PATH__//p' | tail -n 1)
[ -n "$__p" ] && export PATH="$__p"; unset __t __p`;

const prelude = (m: Manifest) =>
  [
    m.envFrom ? `set -a; . ${dq(m.envFrom)}; set +a` : "",
    `GIT_URL=${sq(m.gitUrl)}`,
    gitFn(m),
  ].filter(Boolean).join("\n");

/** Small read-only scripts used by the app. */
export const scripts = {
  list: `cd "${BASE}/deployments" 2>/dev/null || exit 0
for f in *.yaml; do [ -e "$f" ] || continue; n=\${f%.yaml}; echo "$n $(cat "../state/$n" 2>/dev/null || echo never)"; done`,
  read: (name: string) => `cat "${BASE}/deployments/${name}.yaml"`,
  save: (m: Manifest, text: string) =>
    `mkdir -p "${BASE}/deployments" && echo ${b64(text)} | base64 -d > "${BASE}/deployments/${m.name}.yaml"`,
  /** "pm2 no" when pm2 isn't installed, else "pm2 yes" + `pm2 jlist`. Run with the login shell and the
   *  deployment's env file, so it sees the same PATH as a deploy. Never starts the pm2 daemon. */
  pm2Apps: (envFrom?: string) => `${TERMINAL_PATH}\n${envFrom ?`set -a; . ${dq(envFrom)} 2>/dev/null; set +a\n` : ""}command -v pm2 >/dev/null 2>&1 || { echo "pm2 no"; exit 0; }
echo "pm2 yes"
[ -S "\${PM2_HOME:-$HOME/.pm2}/rpc.sock" ] || { echo "[]"; exit 0; }
pm2 jlist 2>/dev/null`,
  /** Variable NAMES defined in an env file (values never leave the machine). */
  envNames: (file: string) => `sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\\2/p' ${dq(file)} 2>/dev/null | sort -u`,
  /** Writes a standalone script (compile with standalone: true) to scripts/<name>.sh, only the user can read/run it. */
  saveSh: (name: string, sh: string) =>
    `mkdir -p "${BASE}/scripts" && f="${BASE}/scripts/${name}.sh" && (umask 077 && echo ${b64(sh)} | base64 -d > "$f") && chmod 700 "$f" && echo "$f"`,
  /** Deletes only Sun Curved's own files, never the projects. */
  remove: (name: string) =>
    `rm -f "${BASE}/deployments/${name}.yaml" "${BASE}/state/${name}" "${BASE}/scripts/${name}.sh" && echo deleted`,
  /** Lists remote tags ("tag X") and dirty targets ("dirty NAME" + indented status). */
  precheck: (m: Manifest) =>
    `${TERMINAL_PATH}
${prelude(m)}
${m.version === "tag" && !m.branch ? `git_auth ls-remote --tags "$GIT_URL" | awk -F/ '{print $3}' | grep -v '\\^{}$' | sort -V | sed 's/^/tag /'` : ""}
${m.targets
  .map((t) => `if cd ${dq(t.path)} 2>/dev/null && [ -n "$(git status --porcelain)" ]; then echo ${sq(`dirty ${t.name}`)}; git status --short | head -n 15 | sed 's/^/  /'; fi`)
  .join("\n")}`,
};

/** Output of scripts.pm2Apps -> process names (sorted), or null when pm2 isn't installed. */
export function parsePm2(out: string): string[] | null {
  if (!/^pm2 yes$/m.test(out)) return null;
  // pm2 may print "[PM2] ..." notices first; the list is the line that is a JSON array
  const line = out.split("\n").map((l) => l.trim()).filter((l) => l === "[]" || l.startsWith("[{")).pop();
  try {
    const list = JSON.parse(line ?? "[]");
    return [...new Set<string>(list.map((p: any) => String(p?.name ?? "")).filter(Boolean))].sort();
  } catch {
    return [];
  }
}

/** `standalone`: a script file to run by hand in a terminal - tag comes from $1, sudo and
 *  "discard local changes?" ask on the terminal, and no password is written into it. */
export type RunOptions = { tag: string; discard: string[]; sudoPassword?: string; standalone?: boolean };

/** How the standalone script gets its tag. */
const standaloneTag = (m: Manifest) =>
  m.branch ? `BRANCH=${sq(m.branch)}; TAG="$BRANCH"`
  : m.version === "tag" ? `TAG="\${1:?usage: $0 <tag>   e.g. $0 v1.2.0}"`
  : `TAG=${sq(m.version)}`;

/** Log title of a run step: its first line, kept short. */
const runTitle = (cmd: string) => {
  const first = cmd.split("\n").find((l) => l.trim())!.trim();
  const more = cmd.trim().includes("\n") ? " …" : "";
  return (first.length > 48 ? first.slice(0, 47) + "…" : first) + more;
};

/** Prefix of the lines a `log` step writes (the app shows them highlighted). */
export const LOG_MARK = "## ";
/** A `log` step: prints the message, one "## " line per line. Inside double quotes, so $TAG, $BRANCH,
 *  env-file variables and $(...) work like in a terminal echo. */
const logLine = (text: string) => {
  const lines = text.replace(/\s+$/, "").split("\n").map((l) => `"${l.replace(/[\\"`]/g, "\\$&")}"`);
  return `printf '${LOG_MARK}%s\\n' ${lines.join(" ")}`;
};

/** Compiles the manifest into the full deploy script (fed to `bash -s`). */
export function compile(m: Manifest, o: RunOptions): string {
  const L: string[] = [];
  const add = (...lines: string[]) => L.push(...lines);
  const step = (title: string) => add("", `step ${sq(title)}`);

  add(
    `#!/bin/bash`,
    `# generated by Sun Curved from deployments/${m.name}.yaml`,
    `# PATH as in your terminal (~/.bashrc), then the env file can still override it`,
    TERMINAL_PATH,
    `set -Eeo pipefail`,
    (o.standalone ? standaloneTag(m) : m.branch ? `BRANCH=${sq(m.branch)}; TAG="$BRANCH"` : `TAG=${sq(o.tag)}`) + "; STEP=start",
    `STATE="${BASE}/state/${m.name}"; mkdir -p "${BASE}/state"`,
    `step() { STEP="$1"; printf '\\n==> %s\\n' "$1"; }`,
    `on_err() { echo; echo "!! FAILED at: $STEP"; printf "%s failed %s\\n" "$TAG" "$(date "+%F %T")" > "$STATE"; }`,
    `trap on_err ERR`,
  );
  if (m.sudo === "login-password") {
    if (o.standalone) add(`sudo_cmd() { sudo "$@"; }  # asks for the password on the terminal`);
    else add(`SUDO_PW=${sq(o.sudoPassword ?? "")}`, `sudo_cmd() { printf '%s\\n' "$SUDO_PW" | sudo -S -p '' "$@"; }`);
  }
  add(prelude(m));

  for (const t of m.targets) {
    const n = t.name;
    add("", `# ---------- target: ${n} ----------`);
    stepsOf(t, t.steps);
  }

  function stepsOf(t: Target, steps: Step[]) {
    const n = t.name;
    for (const s of steps) {
      if (s.kind === "checkout") checkout(t);
      else if (s.kind === "log") add(logLine(s.text));
      else if (s.kind === "fail") {
        // `false` fires the ERR trap: "!! FAILED at: <step>" and the state file says failed
        step(`${n}: fail ${runTitle(s.text)}`);
        add(logLine(s.text).replace(`'${LOG_MARK}%s`, "'!! %s"), "false");
      } else if (s.kind === "if") {
        // The condition runs as a normal command (not inside `if`, where bash ignores set -e), in a subshell
        // with its own set -e, so a multi-line condition fails at its first failing line like a run step.
        // "#@" lines are plumbing the Flow view hides; "# @then/@else/@end" mark the branches for it.
        step(`${n}: if ${runTitle(s.cond)}`);
        add(
          `cd ${dq(t.path)}`,
          `set +e; trap - ERR  #@`,
          `( set -e  #@`,
          s.cond,
          `)  #@`,
          `IF_RC=$?; set -e; trap on_err ERR  #@`,
          `if [ "$IF_RC" = 0 ]; then echo "condition passed -> then"  #@`,
          `# @then`,
        );
        stepsOf(t, s.then);
        add(`:  #@`, `else echo "condition failed (exit $IF_RC) -> else"  #@`, `# @else`);
        stepsOf(t, s.else);
        add(`:  #@`, `fi  #@`, `# @end`);
      }
      else if (s.kind === "run") {
        step(`${n}: ${runTitle(s.cmd)}`);
        add(`cd ${dq(t.path)}`, s.cmd);
      } else if (s.kind === "unmount") {
        step(`${n}: unmount ${s.to}`);
        const to = dq(joinPath(t.path, s.to));
        add(`if mountpoint -q ${to}; then sudo_cmd umount ${to}; echo "unmounted ${s.to}"; else echo "not mounted: ${s.to}"; fi`);
      } else if (s.kind === "mount") {
        step(`${n}: mount ${s.to}`);
        const to = dq(joinPath(t.path, s.to));
        add(
          `mkdir -p ${to}`,
          `sudo_cmd mount --bind ${dq(s.from)} ${to}`,
          `mountpoint -q ${to} || { echo "mount failed: ${s.to}"; false; }`,
          `echo "mounted ${s.from} -> ${s.to}"`,
        );
      } else {
        step(`${n}: pm2 ${s.do} ${s.app}`);
        if (s.do !== "status") add(`cd ${dq(t.path)}`, `pm2 ${s.do} ${sq(s.app)}`);
        add(`pm2 describe ${sq(s.app)} 2>/dev/null | grep -E "status|version" || echo "pm2: ${s.app} not found"`);
      }
    }
  }

  function checkout(t: Target) {
    const n = t.name;
    step(m.branch ? `${n}: pull ${m.branch}` : `${n}: checkout $TAG`);
    add(`cd ${dq(t.path)}`, `if [ -n "$(git status --porcelain)" ]; then`, `  git status --short`);
    if (t.dirty === "discard" || (!o.standalone && o.discard.includes(n))) add(`  echo "discarding local changes"`, `  git reset --hard`, `  git clean -fd`);
    else if (t.dirty === "ask" && o.standalone)
      add(
        `  if read -r -p ${sq(`discard these changes in ${n}? [y/N] `)} a < /dev/tty && [ "$a" = y ]; then`,
        `    git reset --hard`,
        `    git clean -fd`,
        `  else echo "working tree has local changes - not discarding"; false; fi`,
      );
    else add(`  echo "working tree has local changes - not discarding"`, `  false`);
    add(`else echo "working tree is clean"; fi`);
    if (m.branch)
      // Like `git pull --ff-only`, but from spec.source.repo: stops (no merge) if the local branch has diverged.
      add(
        `git_auth fetch "$GIT_URL" "refs/heads/$BRANCH"`,
        `git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" FETCH_HEAD`,
        `git merge --ff-only -q FETCH_HEAD`,
        `TAG="$BRANCH@$(git rev-parse --short HEAD)"`,
      );
    else add(`git_auth fetch "$GIT_URL" "refs/tags/$TAG:refs/tags/$TAG"`, `git checkout -q "$TAG"`);
    add(`git log -1 --oneline`);
  }

  step("DEPLOYMENT SUCCESS");
  add(
    `echo "Tag   : $TAG"`,
    `printf "%s ok %s\\n" "$TAG" "$(date "+%F %T")" > "$STATE"`,
  );
  // The script arrives on bash's stdin. Wrapping it in { … } makes bash read all of it before running,
  // and < /dev/null stops a build command from swallowing the rest of the script as its input.
  // A standalone file is read from disk and run in a terminal, so it keeps the terminal as stdin.
  if (o.standalone) return L.join("\n") + "\n";
  return [...L.slice(0, 2), "{", ...L.slice(2), "} < /dev/null"].join("\n") + "\n";
}

// ---------- editor suggestions (our own, driven by the schema above) ----------

type KeyDoc = { doc: string; values?: string[]; snippet?: string };

/** Keys allowed at each YAML path; "[]" marks a list item. Mirrors parseManifest. */
export const SCHEMA: Record<string, Record<string, KeyDoc>> = {
  "": {
    apiVersion: { doc: "Always suncurved/v1", values: ["suncurved/v1"] },
    kind: { doc: "Always Deployment", values: ["Deployment"] },
    metadata: { doc: "Who this deployment is", snippet: "metadata:\n  name: ${my-app}" },
    spec: { doc: "What to deploy and how", snippet: "spec:\n  ${}" },
  },
  metadata: { name: { doc: "Deployment name: a-z, 0-9 and '-'" } },
  spec: {
    envFrom: { doc: "Env file on the machine, loaded before every step (secrets stay there)" },
    sudo: { doc: "How sudo gets its password", values: ["login-password", "none"] },
    source: {
      doc: "Git repository and version",
      snippet: "source:\n  repo: ${github.com/owner/repo}\n  auth: { user: ${GITHUB_USERNAME}, token: ${GITHUB_TOKEN} }\n  version: tag",
    },
    targets: {
      doc: "Projects to update, in order",
      snippet: "targets:\n  - name: ${main}\n    path: ${~/Projects/app}\n    dirty: ask\n    build: ${./build.sh}",
    },
  },
  "spec.source": {
    repo: { doc: "github.com/owner/repo, or any git URL" },
    auth: { doc: "Env var NAMES holding git credentials", snippet: "auth: { user: ${GITHUB_USERNAME}, token: ${GITHUB_TOKEN} }" },
    version: { doc: '"tag" = pick a tag when applying, or a fixed tag like v1.2.3', values: ["tag"] },
    branch: { doc: "No tags: git pull the latest commit of this branch (use instead of version)", values: ["main", "master"] },
  },
  "spec.source.auth": {
    user: { doc: "Env var with the git username", values: ["GITHUB_USERNAME"] },
    token: { doc: "Env var with the git token", values: ["GITHUB_TOKEN"] },
  },
  "spec.targets[]": {
    name: { doc: "Target name: a-z, 0-9 and '-'" },
    path: { doc: "Git working tree on the machine" },
    dirty: { doc: "Local changes in the working tree", values: ["ask", "discard", "fail"] },
    steps: { doc: "What to do, in order (instead of build / mounts / pm2)", snippet: "steps:\n  - checkout\n  - run: ${npm ci}" },
    build: { doc: "Old style: command run inside path after checkout" },
    pm2: { doc: "Old style: PM2 app name to report after the build" },
    mounts: { doc: "Old style: bind mounts redone around the build", snippet: "mounts:\n  - from: ${/data/source}\n    to: ${public/cache}" },
  },
  "spec.targets[].steps[]": {
    run: { doc: "Shell command run inside path" },
    log: { doc: "Write a message into the Deploy log ($TAG works)" },
    unmount: { doc: "Unmount this folder (relative to path) if mounted" },
    mount: { doc: "Bind mount", snippet: "mount: { from: ${/data/source}, to: ${public/cache} }" },
    pm2: { doc: "PM2 app", snippet: "pm2: { app: ${my-app}, do: ${restart} }" },
    fail: { doc: "Stop the deploy here with this message (marked failed)" },
    if: {
      doc: "Condition command: passed (exit 0) -> then, failed -> else; the deploy goes on",
      snippet: "if:\n  run: ${./build.sh}\n  then:\n    - pm2: { app: ${my-app}, do: restart }\n  else:\n    - fail: ${build failed}",
    },
  },
  "spec.targets[].steps[].if": {
    run: { doc: "Condition: bash command run inside path (exit 0 = passed)" },
    then: { doc: "Steps when the condition passed", snippet: "then:\n  - run: ${}" },
    else: { doc: "Steps when the condition failed", snippet: "else:\n  - fail: ${}" },
  },
  "spec.targets[].mounts[]": {
    from: { doc: "Source directory (absolute)" },
    to: { doc: "Mount point, relative to the target path" },
  },
};

// steps inside if / then / else (one level of nesting gets suggestions)
SCHEMA["spec.targets[].steps[].if.then[]"] = SCHEMA["spec.targets[].steps[].if.else[]"] = SCHEMA["spec.targets[].steps[]"];

/** New list items offered on an empty line inside a list. */
const LIST_ITEMS: Record<string, { label: string; doc: string; snippet: string }> = {
  "spec.targets": { label: "- target", doc: "New target", snippet: "- name: ${sub}\n  path: ${~/Projects/app}\n  dirty: ask\n  build: ${./build.sh}" },
  "spec.targets[].mounts": { label: "- mount", doc: "New bind mount", snippet: "- from: ${/data/source}\n  to: ${public/cache}" },
  "spec.targets[].steps": { label: "- run", doc: "New command step", snippet: "- run: ${npm ci}" },
};

const KEY_LINE = /^(\s*)(-\s+)?([A-Za-z0-9_]+)\s*:/;

/** YAML path of the block that a key at column `indent` on line `row` belongs to, e.g. "spec.targets[]". */
export function yamlPath(lines: string[], row: number, indent: number): string {
  const parts: string[] = [];
  let cur = indent;
  let afterList = false; // just stepped out of a list item: its owner may sit at the same indent
  for (let r = row - 1; r >= 0 && (cur > 0 || afterList); r--) {
    const m = KEY_LINE.exec(lines[r]);
    if (!m) continue;
    const dashAt = m[1].length;
    const keyAt = dashAt + (m[2]?.length ?? 0);
    if (m[2]) {
      if (keyAt > cur) continue; // an item of a deeper list
      if (keyAt < cur) parts.unshift(m[3]); // we are under this item's first key
      parts.unshift("[]");
      cur = dashAt;
      afterList = true;
    } else if (keyAt < cur || (afterList && keyAt <= cur)) {
      parts.unshift(m[3]);
      cur = keyAt;
      afterList = false;
    }
  }
  return parts.join(".").replace(/\.\[\]/g, "[]");
}

export type Suggestion = { label: string; kind: "key" | "value" | "snippet"; doc?: string; insert: string };

/** Suggestions at the cursor: `before` is the line text left of the cursor. `start` = column to replace from. */
export function suggest(lines: string[], row: number, before: string): { start: number; items: Suggestion[] } | null {
  if (/^\s*#/.test(before) || before.includes(" #")) return null;

  // value position: "key: partial"
  const kv = /^(\s*)(-\s+)?([A-Za-z0-9_]+):\s+(\S*)$/.exec(before);
  if (kv) {
    const keyAt = kv[1].length + (kv[2]?.length ?? 0);
    const key = kv[3];
    const doc = SCHEMA[yamlPath(lines, row, keyAt)]?.[key];
    const values = doc?.values;
    if (!values?.length) return null;
    return { start: before.length - kv[4].length, items: values.map((v) => ({ label: v, kind: "value", doc: doc?.doc, insert: v })) };
  }

  // key position: "  partial" or "  - partial"
  const k = /^(\s*)(-\s+)?([A-Za-z0-9_]*)$/.exec(before);
  if (!k) return null;
  const keyAt = k[1].length + (k[2]?.length ?? 0);
  const path = yamlPath(lines, row, keyAt);
  const keys = SCHEMA[path] ?? {};
  const items: Suggestion[] = Object.entries(keys).map(([name, d]) =>
    d.snippet ? { label: name, kind: "snippet", doc: d.doc, insert: d.snippet } : { label: name, kind: "key", doc: d.doc, insert: `${name}: ` },
  );
  const list = !k[2] && !k[3] ? LIST_ITEMS[path] : undefined;
  if (list) items.unshift({ label: list.label, kind: "snippet", doc: list.doc, insert: list.snippet });
  return items.length ? { start: before.length - k[3].length, items } : null;
}
