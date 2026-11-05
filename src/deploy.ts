// Sun Curved deploy engine: a Kubernetes-style manifest is compiled into ONE bash script,
// which is piped to `bash -s` on the machine. Interactive bits of the old shell scripts
// (pick a tag, discard local changes?) are asked in the app first and baked into the script.
import { parse } from "yaml";

export type Mount = { from: string; to: string };
export type Target = {
  name: string;
  path: string;
  trafficBefore?: string;
  trafficAfter?: string;
  dirty: "ask" | "discard" | "fail";
  build?: string;
  pm2?: string;
  mounts: Mount[];
};
export type Manifest = {
  name: string;
  envFrom?: string;
  sudo: "login-password" | "none";
  gitUrl: string;
  auth?: { user: string; token: string }; // names of env vars, never the values
  version: string; // "tag" = choose at apply time, otherwise a fixed tag
  traffic: Record<string, string>; // port -> switch script
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
  traffic:                                           # optional blue/green switch scripts
    nginx:
      3000: ~/switch-3000.sh
      3001: ~/switch-3001.sh
  targets:
    - name: main
      path: ~/Projects/my-app
      trafficBefore: 3001
      dirty: ask                                     # ask | discard | fail
      build: ./build.sh
      pm2: my-app
      mounts:
        - from: /data/cache
          to: public/cache                           # relative to path
      trafficAfter: 3000
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

  const traffic: Record<string, string> = {};
  const nginx = spec.traffic?.nginx ?? {};
  for (const [port, script] of Object.entries(nginx)) {
    if (!/^\d+$/.test(port)) throw new Error(`spec.traffic.nginx: "${port}" is not a port`);
    traffic[port] = str(script, `spec.traffic.nginx.${port}`);
  }

  if (!Array.isArray(spec.targets) || !spec.targets.length) throw new Error("spec.targets: at least one target");
  const targets: Target[] = spec.targets.map((t: any, i: number) => {
    const where = `spec.targets[${i}]`;
    const tname = t?.name;
    if (typeof tname !== "string" || !NAME.test(tname)) throw new Error(`${where}.name: lowercase letters, digits and '-' only`);
    const dirty = t.dirty ?? "ask";
    if (!["ask", "discard", "fail"].includes(dirty)) throw new Error(`${where}.dirty: ask | discard | fail`);
    const port = (k: string) => {
      const p = optStr(t[k], `${where}.${k}`);
      if (p !== undefined && !traffic[p]) throw new Error(`${where}.${k}: no spec.traffic.nginx entry for ${p}`);
      return p;
    };
    const mounts = (t.mounts ?? []).map((m: any, j: number) => ({
      from: str(m?.from, `${where}.mounts[${j}].from`),
      to: str(m?.to, `${where}.mounts[${j}].to`),
    }));
    if (mounts.length && sudo === "none") throw new Error(`${where}.mounts need spec.sudo: login-password`);
    return {
      name: tname,
      path: str(t.path, `${where}.path`),
      trafficBefore: port("trafficBefore"),
      trafficAfter: port("trafficAfter"),
      dirty,
      build: optStr(t.build, `${where}.build`),
      pm2: optStr(t.pm2, `${where}.pm2`),
      mounts,
    };
  });

  return {
    name,
    envFrom: optStr(spec.envFrom, "spec.envFrom"),
    sudo,
    gitUrl,
    auth,
    version: String(spec.source?.version ?? "tag"),
    traffic,
    targets,
  };
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
  /** Deletes only Sun Curved's own files, never the projects. */
  remove: (name: string) => `rm -f "${BASE}/deployments/${name}.yaml" "${BASE}/state/${name}" && echo deleted`,
  /** Lists remote tags ("tag X") and dirty targets ("dirty NAME" + indented status). */
  precheck: (m: Manifest) =>
    `${prelude(m)}
${m.version === "tag" ? `git_auth ls-remote --tags "$GIT_URL" | awk -F/ '{print $3}' | grep -v '\\^{}$' | sort -V | sed 's/^/tag /'` : ""}
${m.targets
  .map((t) => `if cd ${dq(t.path)} 2>/dev/null && [ -n "$(git status --porcelain)" ]; then echo ${sq(`dirty ${t.name}`)}; git status --short | head -n 15 | sed 's/^/  /'; fi`)
  .join("\n")}`,
};

export type RunOptions = { tag: string; discard: string[]; sudoPassword?: string };

/** Compiles the manifest into the full deploy script (fed to `bash -s`). */
export function compile(m: Manifest, o: RunOptions): string {
  const L: string[] = [];
  const add = (...lines: string[]) => L.push(...lines);
  const step = (title: string) => add("", `step ${sq(title)}`);
  const traffic = (port: string) => {
    step(`traffic -> ${port}`);
    add(`${dq(m.traffic[port])}`, `PORT=${port}`, `echo "nginx is now on port $PORT"`);
  };

  add(
    `#!/bin/bash`,
    `# generated by Sun Curved from deployments/${m.name}.yaml`,
    `set -Eeo pipefail`,
    `TAG=${sq(o.tag)}; PORT=unchanged; STEP=start`,
    `STATE="${BASE}/state/${m.name}"; mkdir -p "${BASE}/state"`,
    `step() { STEP="$1"; printf '\\n==> %s\\n' "$1"; }`,
    `trap 'echo; echo "!! FAILED at: $STEP"; echo "!! nginx port: $PORT"; printf "%s failed %s\\n" "$TAG" "$(date "+%F %T")" > "$STATE"' ERR`,
  );
  if (m.sudo === "login-password") {
    add(`SUDO_PW=${sq(o.sudoPassword ?? "")}`, `sudo_cmd() { printf '%s\\n' "$SUDO_PW" | sudo -S -p '' "$@"; }`);
  }
  add(prelude(m));

  for (const t of m.targets) {
    const n = t.name;
    add("", `# ---------- target: ${n} ----------`);
    if (t.trafficBefore) traffic(t.trafficBefore);

    if (t.mounts.length) {
      step(`${n}: unmount`);
      for (const mt of t.mounts) {
        const to = dq(joinPath(t.path, mt.to));
        add(`if mountpoint -q ${to}; then sudo_cmd umount ${to}; echo "unmounted ${mt.to}"; else echo "not mounted: ${mt.to}"; fi`);
      }
    }

    step(`${n}: checkout $TAG`);
    add(`cd ${dq(t.path)}`, `if [ -n "$(git status --porcelain)" ]; then`, `  git status --short`);
    if (t.dirty === "discard" || o.discard.includes(n)) add(`  echo "discarding local changes"`, `  git reset --hard`, `  git clean -fd`);
    else add(`  echo "working tree has local changes - not discarding"`, `  false`);
    add(
      `else echo "working tree is clean"; fi`,
      `git_auth fetch "$GIT_URL" "refs/tags/$TAG:refs/tags/$TAG"`,
      `git checkout -q "$TAG"`,
      `git log -1 --oneline`,
    );

    if (t.build) {
      step(`${n}: build`);
      add(`cd ${dq(t.path)}`, t.build);
    }

    if (t.mounts.length) {
      step(`${n}: mount`);
      for (const mt of t.mounts) {
        const to = dq(joinPath(t.path, mt.to));
        add(
          `mkdir -p ${to}`,
          `sudo_cmd mount --bind ${dq(mt.from)} ${to}`,
          `mountpoint -q ${to} || { echo "mount failed: ${mt.to}"; false; }`,
          `echo "mounted ${mt.from} -> ${mt.to}"`,
        );
      }
    }

    if (t.pm2) {
      step(`${n}: pm2 ${t.pm2}`);
      add(`pm2 describe ${sq(t.pm2)} 2>/dev/null | grep -E "status|version" || echo "pm2: ${t.pm2} not found"`);
    }

    if (t.trafficAfter) traffic(t.trafficAfter);
  }

  step("DEPLOYMENT SUCCESS");
  add(
    `echo "Tag   : $TAG"`,
    `echo "Nginx : $PORT"`,
    `printf "%s ok %s\\n" "$TAG" "$(date "+%F %T")" > "$STATE"`,
  );
  // The script arrives on bash's stdin. Wrapping it in { … } makes bash read all of it before running,
  // and < /dev/null stops a build command from swallowing the rest of the script as its input.
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
    traffic: {
      doc: "Blue/green switch scripts per port",
      snippet: "traffic:\n  nginx:\n    ${3000}: ${~/switch-3000.sh}\n    ${3001}: ${~/switch-3001.sh}",
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
  },
  "spec.source.auth": {
    user: { doc: "Env var with the git username", values: ["GITHUB_USERNAME"] },
    token: { doc: "Env var with the git token", values: ["GITHUB_TOKEN"] },
  },
  "spec.traffic": { nginx: { doc: "port: script that points nginx at that port", snippet: "nginx:\n  ${3000}: ${~/switch-3000.sh}" } },
  "spec.targets[]": {
    name: { doc: "Target name: a-z, 0-9 and '-'" },
    path: { doc: "Git working tree on the machine" },
    trafficBefore: { doc: "Switch traffic to this port before touching the target" },
    trafficAfter: { doc: "Switch traffic to this port once the target is done" },
    dirty: { doc: "Local changes in the working tree", values: ["ask", "discard", "fail"] },
    build: { doc: "Command run inside path after checkout" },
    pm2: { doc: "PM2 app name to report after the build" },
    mounts: { doc: "Bind mounts redone around the build", snippet: "mounts:\n  - from: ${/data/source}\n    to: ${public/cache}" },
  },
  "spec.targets[].mounts[]": {
    from: { doc: "Source directory (absolute)" },
    to: { doc: "Mount point, relative to the target path" },
  },
};

/** New list items offered on an empty line inside a list. */
const LIST_ITEMS: Record<string, { label: string; doc: string; snippet: string }> = {
  "spec.targets": { label: "- target", doc: "New target", snippet: "- name: ${sub}\n  path: ${~/Projects/app}\n  dirty: ask\n  build: ${./build.sh}" },
  "spec.targets[].mounts": { label: "- mount", doc: "New bind mount", snippet: "- from: ${/data/source}\n  to: ${public/cache}" },
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

/** Ports declared under traffic.nginx, for trafficBefore/After. */
function portsOf(lines: string[]) {
  const i = lines.findIndex((l) => /^\s*nginx\s*:/.test(l));
  if (i < 0) return [];
  const base = lines[i].search(/\S/);
  const ports: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && l.search(/\S/) <= base) break;
    const m = /^\s*(\d+)\s*:/.exec(l);
    if (m) ports.push(m[1]);
  }
  return ports;
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
    const values = key === "trafficBefore" || key === "trafficAfter" ? portsOf(lines) : doc?.values;
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
