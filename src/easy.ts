// Easy mode: a form over the deploy YAML. The parsed YAML Document *is* the model, so comments and
// layout written by hand in YAML mode survive edits made here (only the touched values change).
import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";
import { legacySteps, PM2_DO, stepKind } from "./deploy.ts";

export type Path = (string | number)[];
type Doc = Document.Parsed;

// ---------- document helpers (pure, tested in easy.test.ts) ----------

/** Parses YAML for the form; throws on syntax errors (the form needs a well-formed tree). */
export function openDoc(text: string): Doc {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`YAML: ${doc.errors[0].message.split("\n")[0]}`);
  if (!isMap(doc.contents)) throw new Error("YAML: the file must be key: value lines");
  return doc;
}

/** Scalar at `path` as text ("" when missing or not a scalar). */
export function get(doc: Doc, path: Path): string {
  const v = doc.getIn(path);
  return v === undefined || v === null || typeof v === "object" ? "" : String(v);
}

export const count = (doc: Doc, path: Path) => {
  const s = doc.getIn(path, true);
  return isSeq(s) ? s.items.length : 0;
};

/** `key: ` with nothing after it is null; turn such parents into real maps/lists before writing below them. */
function ensure(doc: Doc, path: Path) {
  for (let i = 1; i < path.length; i++) {
    const at = path.slice(0, i);
    const n = doc.getIn(at, true);
    if (n === undefined || (isScalar(n) && n.value === null)) doc.setIn(at, doc.createNode(typeof path[i] === "number" ? [] : {}));
  }
}

/** Sets a text value; blank removes the key. An existing scalar is edited in place so its comment stays. */
export function put(doc: Doc, path: Path, value: string) {
  const v = value.trim();
  if (!v) {
    if (doc.hasIn(path)) doc.deleteIn(path);
    return;
  }
  const multi = v.includes("\n");
  const text = multi ? v + "\n" : v;
  const node = doc.getIn(path, true);
  if (isScalar(node)) {
    if (node.value === text) return;
    node.value = text;
    if (multi) node.type = "BLOCK_LITERAL";
    else if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") node.type = "PLAIN";
    return;
  }
  ensure(doc, path);
  const n = doc.createNode(text);
  if (multi) n.type = "BLOCK_LITERAL";
  doc.setIn(path, n);
}

/** Appends an item to the list at `path` (created if missing). */
export function push(doc: Doc, path: Path, item: unknown) {
  const s = doc.getIn(path, true);
  if (isSeq(s)) s.items.push(doc.createNode(item));
  else {
    ensure(doc, [...path, 0]);
    doc.setIn(path, doc.createNode([item]));
  }
}

/** Removes item `i`; an emptied list (other than targets / steps) is removed with it. */
export function removeAt(doc: Doc, path: Path, i: number) {
  doc.deleteIn([...path, i]);
  if (!count(doc, path) && !["targets", "steps"].includes(String(path[path.length - 1]))) doc.deleteIn(path);
}

/** Moves item `from` to position `to` (drag and drop). */
export function moveTo(doc: Doc, path: Path, from: number, to: number) {
  const s = doc.getIn(path, true);
  if (!isSeq(s) || from === to || to < 0 || to >= s.items.length) return;
  s.items.splice(to, 0, ...s.items.splice(from, 1));
}

/** Moves item `i` by `d` (-1 up, +1 down). */
export function move(doc: Doc, path: Path, i: number, d: number) {
  const s = doc.getIn(path, true);
  if (!isSeq(s) || i + d < 0 || i + d >= s.items.length) return;
  [s.items[i], s.items[i + d]] = [s.items[i + d], s.items[i]];
}

const stepsPath = (i: number): Path => ["spec", "targets", i, "steps"];

/** Raw steps of target `i`; old-style build / mounts / pm2 are shown as the steps they mean. */
export function stepsOf(doc: Doc, i: number): unknown[] {
  const s = doc.getIn(stepsPath(i), true);
  if (isSeq(s)) return s.toJSON() as unknown[];
  const t = doc.getIn(["spec", "targets", i], true);
  return legacySteps(isMap(t) ? t.toJSON() : {});
}

/** A step as a YAML node; mount / pm2 maps are written on one line ({ from: …, to: … }). */
function stepNode(doc: Doc, raw: unknown) {
  const n = doc.createNode(raw);
  if (isMap(n)) n.items.forEach((p) => isMap(p.value) && ["mount", "pm2"].includes(String((p.key as any)?.value ?? p.key)) && (p.value.flow = true));
  return n;
}

/** Before editing steps of target `i`: turn old-style keys into a real `steps` list, and `pm2: name` into a map. */
export function toSteps(doc: Doc, i: number) {
  if (!doc.hasIn(stepsPath(i))) {
    const steps = stepsOf(doc, i);
    for (const k of ["build", "mounts", "pm2"]) doc.deleteIn(["spec", "targets", i, k]);
    ensure(doc, [...stepsPath(i), 0]);
    doc.setIn(stepsPath(i), doc.createNode([]));
    steps.forEach((s) => (doc.getIn(stepsPath(i), true) as any).items.push(stepNode(doc, s)));
  }
  // short forms the form can't edit in place: `pm2: name` -> { app, do }, bare `fail` -> fail: "" (also inside if)
  const fix = (list: Path) => {
    const s = doc.getIn(list, true);
    if (!isSeq(s)) return;
    (s.toJSON() as any[]).forEach((x, k) => {
      if (x === "fail") doc.setIn([...list, k], stepNode(doc, { fail: "" }));
      else if (stepKind(x) === "pm2" && typeof x.pm2 === "string") doc.setIn([...list, k], stepNode(doc, { pm2: { app: x.pm2, do: "status" } }));
      else if (stepKind(x) === "if") ["then", "else"].forEach((b) => fix([...list, k, "if", b]));
    });
  };
  fix(stepsPath(i));
}

/** Adds a step to target `i` (checkout goes first, the rest at the end); returns its index.
 *  `list` = a then / else list inside an if step instead of the target's own steps. */
export function addStep(doc: Doc, i: number, raw: unknown, list: Path = stepsPath(i)): number {
  toSteps(doc, i);
  if (!isSeq(doc.getIn(list, true))) {
    ensure(doc, [...list, 0]);
    doc.setIn(list, doc.createNode([]));
  }
  const s = doc.getIn(list, true) as any;
  if (raw === "checkout") {
    s.items.unshift(stepNode(doc, raw));
    return 0;
  }
  s.items.push(stepNode(doc, raw));
  return s.items.length - 1;
}

/** Moves step `j` of list `from` into list `to` (target `i`), at index `at` (default: the end).
 *  Returns false when it can't go there (into itself, or a checkout into an if). */
export function moveStep(doc: Doc, i: number, from: Path, j: number, to: Path, at = -1): boolean {
  toSteps(doc, i);
  const me = keyOf([...from, j]);
  const tk = keyOf(to);
  if (tk === me || tk.startsWith(me + ".") || tk.startsWith(me + "[")) return false;
  const src = doc.getIn(from, true);
  if (!isSeq(src) || j < 0 || j >= src.items.length) return false;
  if (stepKind((src.items[j] as any).toJSON()) === "checkout" && tk !== keyOf(stepsPath(i))) return false;
  if (tk === keyOf(from)) {
    moveTo(doc, from, j, at < 0 ? src.items.length - 1 : at);
    return true;
  }
  // `to` may run through `from` below the moved item: it shifts up by one once the item is out
  const dest = [...to];
  const n = from.length;
  if (to.length > n && keyOf(to.slice(0, n)) === keyOf(from) && typeof to[n] === "number" && (to[n] as number) > j) dest[n] = (to[n] as number) - 1;
  const [item] = src.items.splice(j, 1);
  if (!src.items.length && ["then", "else"].includes(String(from[from.length - 1]))) doc.deleteIn(from);
  if (!isSeq(doc.getIn(dest, true))) {
    ensure(doc, [...dest, 0]);
    doc.setIn(dest, doc.createNode([]));
  }
  const d = doc.getIn(dest, true) as any;
  d.items.splice(at < 0 ? d.items.length : at, 0, item);
  return true;
}

/** Turns run step `j` of `list` into an if whose condition is that command (passed -> log, failed -> stop). */
export function wrapInIf(doc: Doc, i: number, list: Path, j: number): boolean {
  toSteps(doc, i);
  const cmd = get(doc, [...list, j, "run"]).trim();
  if (!cmd) return false;
  const first = cmd.split("\n")[0];
  doc.setIn([...list, j], doc.createNode({ if: { run: cmd, then: [{ log: `${first} ผ่าน` }], else: [{ fail: `${first} ไม่ผ่าน` }] } }));
  return true;
}

/** A run step that just runs a script file. */
export const isScript = (line: string) => /^(\.{0,2}\/|~\/|\/)\S+\.(sh|bash)$/.test(line.trim());

/** Picked path made relative to the target folder when it's inside it (./build.sh). */
export function relTo(base: string, p: string) {
  const b = base.replace(/\/+$/, "");
  return b && p.startsWith(b + "/") ? "./" + p.slice(b.length + 1) : p;
}

/** Dotted key used in parse errors: ["spec","targets",0,"path"] -> spec.targets[0].path */
export const keyOf = (p: Path) => p.map((x, i) => (typeof x === "number" ? `[${x}]` : i ? `.${x}` : x)).join("");

/** Key a parseManifest error is about ("spec.targets[0].path is required" -> spec.targets[0].path). */
export const errKey = (msg: string) => /^[A-Za-z]+(?:\.[A-Za-z]+|\[\d+\])*/.exec(msg)?.[0] ?? "";

// ---------- the form ----------

type IconName = "folder" | "plus" | "x" | "arrowUp" | "arrowDown" | "trash" | "terminal" | "file" | "corner";
export type EasyOptions = {
  /** New YAML after an edit in the form. */
  change(yaml: string): void;
  /** Remote picker; returns a path (with ~ for home) or null. */
  pick(kind: "dir" | "file", start: string): Promise<string | null>;
  /** Variable names defined in an env file on the machine (names only, never values). */
  envNames(file: string): Promise<string[]>;
  /** pm2 process names on the machine, or null when pm2 isn't installed. */
  pm2Apps(envFrom?: string): Promise<string[] | null>;
  icon(name: IconName, cls?: string): string;
};

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const dirOf = (p: string) => (p.includes("/") ? p.replace(/\/[^/]*$/, "") || "/" : "~");
const T: Path = ["spec", "targets"];
let uidSeq = 0;

const INPUT = "ez-in";
const BTN = "rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent";
const ADD = "flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-500 enabled:hover:bg-zinc-800 enabled:hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-40";

export function createEasy(box: HTMLElement, o: EasyOptions) {
  let doc: Doc | null = null;
  let focusStep: string | null = null; // "target:step" to focus after the next render
  let pm2: string[] | null | undefined; // process names; null = pm2 not installed; undefined = unknown
  let pm2Asked: string | null = null; // env file the current answer is for
  let verMode: "tag" | "fixed" | "branch" | null = null; // chosen Version chip while its box is still empty
  const uid = `easy${++uidSeq}`;
  const envCache = new Map<string, string[]>();

  const emit = () => doc && o.change(doc.toString({ lineWidth: 0 }));
  const g = (p: Path) => get(doc!, p);
  const P = (p: Path) => `data-p="${esc(JSON.stringify(p))}" data-k="${esc(keyOf(p))}"`;
  const input = (p: Path, ph = "", extra = "") => `<input ${P(p)} value="${esc(g(p))}" placeholder="${esc(ph)}" spellcheck="false" class="${INPUT}" ${extra} />`;
  const pickBtn = (p: Path, kind: "dir" | "file", i = -1) =>
    `<button type="button" data-act="pick" data-for="${esc(JSON.stringify(p))}" data-kind="${kind}" data-i="${i}" title="${kind === "dir" ? "เลือกโฟลเดอร์" : "เลือกไฟล์"}บนเครื่อง" class="${BTN} text-amber-400">${o.icon("folder")}</button>`;
  const radio = (name: string, attr: string, value: string, checked: boolean, label: string) =>
    `<label class="cursor-pointer"><input type="radio" name="${name}" ${attr} value="${value}" ${checked ? "checked" : ""} class="ez-opt sr-only" /><span class="ez-chip">${label}</span></label>`;
  const toggle = (attr: string, checked: boolean, label: string, k = "") =>
    `<label class="cursor-pointer" ${k ? `data-k="${k}"` : ""}><input type="checkbox" ${attr} ${checked ? "checked" : ""} class="ez-opt sr-only" /><span class="ez-chip">${label}</span></label>`;
  const act = (a: string, ic: IconName, title: string, i: number, j = -1, disabled = false) =>
    `<button type="button" data-act="${a}" data-i="${i}" data-j="${j}" title="${title}" ${disabled ? "disabled" : ""} class="${BTN}">${o.icon(ic, "h-3.5 w-3.5")}</button>`;
  const addBtn = (a: string, i: number, label: string) =>
    `<button type="button" data-act="${a}" data-i="${i}" class="${ADD}">${o.icon("plus", "h-3.5 w-3.5")} ${label}</button>`;

  // ---- tree pieces: each <li> is one row; children hang off it with └ lines (styles.css .tree) ----
  const node = (head: string, kids: string[] = [], attrs = "") =>
    `<li ${attrs}><div class="tree-row">${head}</div>${kids.length ? `<ul>${kids.join("")}</ul>` : ""}</li>`;
  /** Row with a label; `tip` shows on hover. */
  const leaf = (label: string, control: string, tip = "", kids: string[] = []) =>
    node(`<span class="tree-label" ${tip ? `title="${esc(tip)}"` : ""}>${label}</span><span class="flex min-w-0 flex-wrap items-center gap-1">${control}</span>`, kids);
  const section = (label: string, kids: string[], tip = "") =>
    node(`<span class="text-sm font-medium text-zinc-300" ${tip ? `title="${esc(tip)}"` : ""}>${label}</span>`, kids);
  /** Row buttons, shown on hover / focus. */
  const acts = (html: string) => `<span class="tree-acts flex shrink-0 items-center">${html}</span>`;
  /** Field inside a step: `data-ti` makes the first edit turn old-style keys into `steps`. */
  const sInput = (i: number, p: Path, value: string, ph: string, extra = "") =>
    `<input ${P(p)} data-ti="${i}" value="${esc(value)}" placeholder="${esc(ph)}" spellcheck="false" class="${INPUT}" ${extra} />`;

  /** Where step `k` of `list` (target `i`) can go: the then / else of every other if in the target,
   *  out of the if it sits in, and - for a command - becoming an if's condition itself. */
  function moveChoices(i: number, list: Path, k: number): { label: string; tone?: "then" | "else"; run: (d: Doc) => boolean }[] {
    const d = doc!;
    const s = d.getIn([...list, k]) as any;
    const raw = s && typeof s === "object" && "toJSON" in s ? s.toJSON() : s;
    const kind = stepKind(raw);
    if (kind === "checkout") return [];
    const out: { label: string; tone?: "then" | "else"; run: (d: Doc) => boolean }[] = [];
    if (kind === "run" && String(raw.run ?? "").trim())
      out.push({ label: "ใช้คำสั่งนี้เป็นเงื่อนไข if", run: (x) => wrapInIf(x, i, list, k) });
    const me = keyOf([...list, k]);
    const short = (c: unknown) => {
      const t = String(c ?? "").trim().split("\n")[0] || "(ยังไม่ใส่เงื่อนไข)";
      return t.length > 32 ? t.slice(0, 31) + "…" : t;
    };
    const walk = (lp: Path, items: unknown[]) =>
      items.forEach((x: any, q) => {
        if (stepKind(x) !== "if") return;
        const ip = [...lp, q];
        const ik = keyOf(ip);
        if (ik === me || ik.startsWith(me + ".") || ik.startsWith(me + "[")) return; // itself / inside itself
        for (const b of ["then", "else"] as const) {
          const bp = [...ip, "if", b];
          if (keyOf(bp) !== keyOf(list))
            out.push({ label: `${b === "then" ? "ถ้าผ่าน" : "ถ้าไม่ผ่าน"} · if ${short(x.if?.run)}`, tone: b, run: (y) => moveStep(y, i, list, k, bp) });
          walk(bp, Array.isArray(x.if?.[b]) ? x.if[b] : []);
        }
      });
    walk(stepsPath(i), stepsOf(d, i));
    if (list[list.length - 1] === "then" || list[list.length - 1] === "else") {
      const parent = list.slice(0, -3);
      const at = (list[list.length - 3] as number) + 1;
      out.push({ label: "ย้ายออกจาก if (ไปต่อท้าย if)", run: (y) => moveStep(y, i, list, k, parent, at) });
    }
    return out;
  }

  /** Small popup menu next to a button; `pick` gets the chosen index. */
  let menuPick: ((m: number) => void) | null = null;
  const closeMenu = () => {
    box.querySelector("[data-menu]")?.remove();
    menuPick = null;
  };
  function openMenu(at: HTMLElement, items: { label: string; tone?: string }[], pick: (m: number) => void) {
    closeMenu();
    const m = document.createElement("div");
    m.dataset.menu = "";
    m.className = "fixed z-50 min-w-56 rounded-xl border border-zinc-700 bg-zinc-900/95 p-1 text-sm text-zinc-100 shadow-2xl shadow-black/50 backdrop-blur";
    m.innerHTML =
      `<p class="px-3 pt-1 pb-1.5 text-[11px] text-zinc-500">ย้ายขั้นตอนนี้ไป…</p>` +
      items
        .map((x, n) => `<button type="button" data-act="menu-pick" data-m="${n}" class="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-amber-500 hover:text-black ${x.tone ? `ez-br-${x.tone}` : ""}">${esc(x.label)}</button>`)
        .join("");
    box.appendChild(m);
    const r = at.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 4))}px`;
    m.style.top = `${r.bottom + 4 + m.offsetHeight > innerHeight ? r.top - m.offsetHeight - 4 : r.bottom + 4}px`;
    menuPick = pick;
  }
  document.addEventListener("mousedown", (e) => menuPick && !(e.target as HTMLElement).closest("[data-menu]") && closeMenu());
  document.addEventListener("keydown", (e) => e.key === "Escape" && menuPick && closeMenu());
  box.addEventListener("scroll", () => menuPick && closeMenu());

  /** "+ step" buttons for a list of steps (`list` = the target's steps or a then / else list). */
  function addRow(i: number, list: Path, items: unknown[], nested: boolean) {
    const l = `data-l="${esc(JSON.stringify(list))}"`;
    const add = (kind: string, label: string) =>
      `<button type="button" data-act="step-add" data-kind="${kind}" data-i="${i}" ${l} class="${ADD}">${o.icon("plus", "h-3.5 w-3.5")} ${label}</button>`;
    const checkout = nested || items.some((s) => stepKind(s) === "checkout") ? "" : add("checkout", g(["spec", "source", "branch"]) ? "git pull" : "checkout");
    return node(`<span class="flex flex-wrap items-center">
      ${add("run", "คำสั่ง")}${add("script", "สคริปต์ .sh")}${add("unmount", "unmount")}${add("mount", "mount")}${add("pm2", "pm2")}${add("log", "log")}${add("if", "if")}${add("fail", "หยุด")}
      ${checkout}</span>`);
  }

  /** Rows of a step list, plus its "+" buttons. */
  function stepRows(i: number, list: Path, items: unknown[], nested: boolean) {
    return [...items.map((s, k) => stepRow(i, list, k, s, items.length)), addRow(i, list, items, nested)];
  }

  /** One step row: drag handle + what it does + its fields. */
  function stepRow(i: number, list: Path, k: number, s: any, n: number) {
    const p = [...list, k];
    const kind = stepKind(s);
    const L = esc(JSON.stringify(list));
    const badge = (label: string, cls = "") =>
      `<span class="ez-kind ${cls}" draggable="true" data-drag="${k}" title="ลากเพื่อเรียงลำดับ">${label}</span>`;
    let kids: string[] = [];
    let body: string;
    if (kind === "checkout") {
      const dirty = g([...T, i, "dirty"]) || "ask";
      const dr = `data-r="${esc(JSON.stringify([...T, i, "dirty"]))}"`;
      const branch = g(["spec", "source", "branch"]);
      body = `${badge(branch ? "git pull" : "checkout", "ez-kind-git")}
        <span class="text-xs text-zinc-500">${branch ? esc(branch) : "tag ที่เลือก"} · ไฟล์แก้ค้าง</span>
        ${radio(`${uid}-dirty-${i}`, dr, "ask", dirty === "ask", "ถามก่อน")}
        ${radio(`${uid}-dirty-${i}`, dr, "discard", dirty === "discard", "ทิ้งเลย")}
        ${radio(`${uid}-dirty-${i}`, dr, "fail", dirty === "fail", "หยุด")}`;
    } else if (kind === "run") {
      const cmd = String(s.run ?? "");
      const script = isScript(cmd);
      body = `${badge(o.icon(script ? "file" : "terminal", "h-3.5 w-3.5"), script ? "ez-kind-file" : "")}
        <textarea ${P([...p, "run"])} data-ti="${i}" rows="1" placeholder="คำสั่ง bash เช่น npm ci" spellcheck="false" class="${INPUT} ez-area">${esc(cmd)}</textarea>`;
    } else if (kind === "log") {
      body = `${badge("log", "ez-kind-log")}${sInput(i, [...p, "log"], String(s.log ?? ""), "ข้อความที่จะขึ้นใน log เช่น เริ่ม build $TAG", 'style="min-width:16rem"')}`;
    } else if (kind === "unmount") {
      body = `${badge("unmount")}${sInput(i, [...p, "unmount"], String(s.unmount ?? ""), "public/cache")}`;
    } else if (kind === "mount") {
      body = `${badge("mount")}
        ${sInput(i, [...p, "mount", "from"], String(s.mount?.from ?? ""), "/data/source")}${pickBtn([...p, "mount", "from"], "dir", i)}
        <span class="text-zinc-500">→</span>
        ${sInput(i, [...p, "mount", "to"], String(s.mount?.to ?? ""), "public/cache")}`;
    } else if (kind === "pm2") {
      const v = s.pm2;
      const app = typeof v === "string" ? v : String(v?.app ?? "");
      const d = (typeof v === "object" && v?.do) || "status";
      const dr = `data-r="${esc(JSON.stringify([...p, "pm2", "do"]))}" data-ti="${i}"`;
      body = `${badge("pm2")}${sInput(i, [...p, "pm2", "app"], app, "ชื่อ process", `list="${uid}-pm2" data-pm2`)}
        ${PM2_DO.map((x) => radio(`${uid}-pm2-${i}-${k}`, dr, x, d === x, x)).join("")}
        <span data-pm2warn class="hidden text-xs text-red-400"></span>`;
    } else if (kind === "fail") {
      body = `${badge("หยุด", "ez-kind-fail")}${sInput(i, [...p, "fail"], typeof s === "string" ? "" : String(s.fail ?? ""), "ข้อความ เช่น build ไม่ผ่าน", 'style="min-width:16rem"')}
        <span class="text-xs text-zinc-500">deploy ล้มเหลวตรงนี้</span>`;
    } else if (kind === "if") {
      const v = s.if && typeof s.if === "object" ? s.if : {};
      const branch = (b: "then" | "else", label: string, tip: string) => {
        const items = Array.isArray(v[b]) ? v[b] : [];
        return node(`<span class="ez-br ez-br-${b}" title="${esc(tip)}">${label}</span>`, stepRows(i, [...p, "if", b], items, true));
      };
      body = `${badge("if", "ez-kind-if")}
        <textarea ${P([...p, "if", "run"])} data-ti="${i}" rows="1" placeholder="เงื่อนไข: คำสั่ง เช่น npm run build (exit 0 = ผ่าน)" spellcheck="false" class="${INPUT} ez-area">${esc(String(v.run ?? ""))}</textarea>`;
      kids = [
        branch("then", "ถ้าผ่าน", "คำสั่งเงื่อนไขจบด้วย exit 0"),
        branch("else", "ถ้าไม่ผ่าน", "คำสั่งเงื่อนไขพัง (exit ไม่ใช่ 0) แทนที่ deploy จะหยุด จะทำขั้นตอนพวกนี้แล้วไปต่อ"),
      ];
    } else {
      body = `${badge("?")}<span class="font-mono text-xs text-zinc-500" title="แก้ขั้นตอนนี้ในโหมด YAML">${esc(JSON.stringify(s))}</span>`;
    }
    const sAct = (a: string, ic: IconName, title: string, disabled = false) =>
      `<button type="button" data-act="${a}" data-i="${i}" data-j="${k}" data-l="${L}" title="${title}" ${disabled ? "disabled" : ""} class="${BTN}">${o.icon(ic, "h-3.5 w-3.5")}</button>`;
    const movable = moveChoices(i, list, k).length > 0;
    const tools = acts(
      (movable ? sAct("step-move", "corner", "ย้ายเข้า / ออกจาก if") : "") +
        sAct("step-up", "arrowUp", "เลื่อนขึ้น", k === 0) + sAct("step-down", "arrowDown", "เลื่อนลง", k === n - 1) + sAct("step-del", "x", "ลบขั้นตอนนี้"),
    );
    return node(`<span class="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-k="${esc(keyOf(p))}">${body}</span>${tools}`, kids, `data-step="${esc(keyOf(p))}" data-l="${L}" data-j="${k}" data-ti="${i}"`);
  }

  function targetNode(i: number, n: number) {
    const t = [...T, i];
    const rows = stepRows(i, stepsPath(i), stepsOf(doc!, i), false);

    const head = `
      <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-amber-500/15 text-xs font-semibold text-amber-400">${i + 1}</span>
      <input ${P([...t, "name"])} value="${esc(g([...t, "name"]))}" placeholder="ชื่อ target" spellcheck="false"
        class="ez-in font-semibold" />
      ${acts(act("target-up", "arrowUp", "เลื่อนขึ้น", i, -1, i === 0) + act("target-down", "arrowDown", "เลื่อนลง", i, -1, i === n - 1) + act("target-del", "trash", "ลบ target นี้", i))}`;
    return node(head, [
      leaf("Path", input([...t, "path"], "~/Projects/my-app") + pickBtn([...t, "path"], "dir", i), "โฟลเดอร์ git ที่ clone ไว้แล้วบนเครื่อง"),
      section("ขั้นตอน", rows, "รันจากบนลงล่าง ลากป้ายด้านหน้าเพื่อเรียงลำดับ ขั้นไหนพัง = หยุด"),
    ]);
  }

  function render() {
    if (!doc) return;
    const top = box.scrollTop;
    const ver = g(["spec", "source", "version"]);
    const vm = verMode ?? (doc.hasIn(["spec", "source", "branch"]) ? "branch" : ver && ver !== "tag" ? "fixed" : "tag");
    const priv = doc.hasIn(["spec", "source", "auth"]);
    const n = count(doc, T);
    const root = `
      <span class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-amber-500 text-black">${o.icon("folder", "h-3.5 w-3.5")}</span>
      <input ${P(["metadata", "name"])} value="${esc(g(["metadata", "name"]))}" placeholder="ชื่อ deploy เช่น my-app" spellcheck="false" title="a-z, 0-9 และ - เท่านั้น ใช้เป็นชื่อไฟล์บนเครื่อง"
        class="ez-in text-base! font-semibold" />`;
    const kids = [
      leaf("ไฟล์ env", input(["spec", "envFrom"], "~/EndFroZen/CommandCenter/app.env (ไม่บังคับ)") + pickBtn(["spec", "envFrom"], "file"), "โหลดก่อนทุกขั้นตอน ความลับอยู่ในไฟล์นี้บนเครื่องเท่านั้น"),
      leaf("sudo", toggle("data-sudo", g(["spec", "sudo"]) === "login-password", "ใช้รหัส login", "spec.sudo"), "เปิดเมื่อมี mount: ใช้รหัส login ที่บันทึกไว้เป็นรหัส sudo"),
      section("Source", [
        leaf("Repo", input(["spec", "source", "repo"], "github.com/owner/repo")),
        leaf("Private", toggle("data-private", priv, "ใช้ user/token จากไฟล์ env"),
          "ใส่ชื่อตัวแปรในไฟล์ env ไม่ใช่ค่าจริง",
          priv
            ? [
                leaf("user", input(["spec", "source", "auth", "user"], "GITHUB_USERNAME", `list="${uid}-env"`)),
                leaf("token", input(["spec", "source", "auth", "token"], "GITHUB_TOKEN", `list="${uid}-env"`)),
              ]
            : []),
        leaf("Version", `<div class="flex flex-wrap items-center gap-1">
          ${radio(`${uid}-ver`, "data-ver", "tag", vm === "tag", "เลือก tag ตอน deploy")}
          ${radio(`${uid}-ver`, "data-ver", "fixed", vm === "fixed", "ล็อก tag")}
          ${radio(`${uid}-ver`, "data-ver", "branch", vm === "branch", "git pull branch")}
          ${vm === "fixed" ? input(["spec", "source", "version"], "v1.2.0", "data-vin") : ""}
          ${vm === "branch" ? input(["spec", "source", "branch"], "main", "data-vin") : ""}</div>`,
          "ไม่มี tag ใช้ git pull branch: ดึง commit ล่าสุดของ branch นั้น"),
      ]),
      ...Array.from({ length: n }, (_, i) => targetNode(i, n)),
      node(addBtn("target-add", -1, "target")),
    ];
    box.innerHTML = `
      <div class="mx-auto max-w-3xl px-6 py-5"><ul class="tree">${node(root, kids)}</ul></div>
      <datalist id="${uid}-env"></datalist>
      <datalist id="${uid}-pm2"></datalist>`;
    box.scrollTop = top;
    if (focusStep) {
      box.querySelector<HTMLElement>(`[data-step="${focusStep}"] :is(input, textarea)`)?.focus();
      focusStep = null;
    }
    loadEnv();
    loadPm2();
  }

  /** Asks the machine which pm2 processes exist, again whenever the env file changes (it may set PATH). */
  function loadPm2() {
    const env = doc ? g(["spec", "envFrom"]) : "";
    if (pm2Asked === env) return applyPm2();
    pm2Asked = env;
    pm2 = undefined;
    o.pm2Apps(env || undefined)
      .then((v) => pm2Asked === env && (pm2 = v))
      .catch(() => pm2Asked === env && (pm2Asked = null)) // try again next render
      .finally(applyPm2);
  }

  /** Fills the pm2 suggestions; no pm2 on the machine = "+ pm2" disabled and pm2 rows flagged. */
  function applyPm2() {
    const none = pm2 === null;
    const dl = box.querySelector(`#${uid}-pm2`);
    if (dl) dl.innerHTML = (pm2 ?? []).map((v) => `<option value="${esc(v)}"></option>`).join("");
    box.querySelectorAll<HTMLButtonElement>('[data-act="step-add"][data-kind="pm2"]').forEach((b) => {
      b.disabled = none;
      b.title = none ? "เครื่องนี้ไม่ได้ติดตั้ง pm2" : "";
    });
    box.querySelectorAll<HTMLInputElement>("[data-pm2]").forEach(warnPm2);
  }
  function warnPm2(inp: HTMLInputElement) {
    const w = inp.parentElement?.querySelector<HTMLElement>("[data-pm2warn]");
    if (!w) return;
    const app = inp.value.trim();
    const msg = pm2 === null ? "เครื่องนี้ไม่ได้ติดตั้ง pm2" : pm2 && app && !pm2.includes(app) ? "ไม่มี process นี้ใน pm2" : "";
    w.textContent = msg;
    w.classList.toggle("hidden", !msg);
  }

  async function loadEnv() {
    const f = doc && g(["spec", "envFrom"]);
    const dl = box.querySelector(`#${uid}-env`);
    if (!f || !dl) return;
    if (!envCache.has(f)) envCache.set(f, await o.envNames(f).catch(() => []));
    dl.innerHTML = envCache.get(f)!.map((v) => `<option value="${esc(v)}"></option>`).join("");
  }

  const freeName = () => {
    const names = new Set(Array.from({ length: count(doc!, T) }, (_, i) => g([...T, i, "name"])));
    for (let k = 1; ; k++) if (!names.has(k === 1 ? "sub" : `sub${k}`)) return k === 1 ? "sub" : `sub${k}`;
  };
  const needSudo = (d: Doc) => g(["spec", "sudo"]) !== "login-password" && put(d, ["spec", "sudo"], "login-password");

  box.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    if (!doc || !el.dataset.p) return;
    const path = JSON.parse(el.dataset.p) as Path;
    if (el.dataset.ti) {
      toSteps(doc, +el.dataset.ti);
      // a step field emptied keeps its key (run: "") so the step stays and the error points at it
      if (!el.value.trim()) {
        const n = doc.getIn(path, true);
        if (isScalar(n)) n.value = "";
        else doc.setIn(path, "");
        return emit();
      }
    }
    put(doc, path, el.value);
    if ("pm2" in el.dataset) warnPm2(el);
    emit();
  });

  box.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    if (!doc) return;
    if (el.dataset.r) {
      if (el.dataset.ti) toSteps(doc, +el.dataset.ti);
      put(doc, JSON.parse(el.dataset.r), el.value);
    }
    else if ("sudo" in el.dataset) put(doc, ["spec", "sudo"], el.checked ? "login-password" : "none");
    else if ("private" in el.dataset) {
      if (el.checked) {
        put(doc, ["spec", "source", "auth", "user"], "GITHUB_USERNAME");
        put(doc, ["spec", "source", "auth", "token"], "GITHUB_TOKEN");
      } else doc.deleteIn(["spec", "source", "auth"]);
      render();
    } else if ("ver" in el.dataset) {
      // tag / fixed tag use `version`; branch uses `branch` instead (the two can't be set together)
      const src = ["spec", "source"];
      const mode = el.value as "tag" | "fixed" | "branch";
      if (mode === "branch") {
        doc.deleteIn([...src, "version"]);
        if (!g([...src, "branch"])) put(doc, [...src, "branch"], "main");
      } else {
        doc.deleteIn([...src, "branch"]);
        const v = g([...src, "version"]);
        if (mode === "tag" || v === "tag") put(doc, [...src, "version"], mode === "tag" ? "tag" : "");
      }
      verMode = mode;
      render();
      box.querySelector<HTMLInputElement>("[data-vin]")?.focus();
    } else {
      if (el.dataset.k === "spec.envFrom") (loadEnv(), loadPm2());
      return;
    }
    emit();
  });

  box.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!b || !doc) return;
    const d = doc;
    const i = +(b.dataset.i ?? -1);
    const j = +(b.dataset.j ?? -1);
    const t = [...T, i];
    const list = b.dataset.l ? (JSON.parse(b.dataset.l) as Path) : stepsPath(i); // which step list a step button is about
    switch (b.dataset.act) {
      case "target-add":
        push(d, T, { name: freeName(), path: "~/Projects/", dirty: "ask", steps: ["checkout"] });
        break;
      case "target-del":
        removeAt(d, T, i);
        break;
      case "target-up":
      case "target-down":
        move(d, T, i, b.dataset.act === "target-up" ? -1 : 1);
        break;
      case "step-add": {
        const kind = b.dataset.kind!;
        let raw: unknown;
        if (kind === "script") {
          const base = g([...t, "path"]);
          const p = await o.pick("file", base || "~");
          if (!p || doc !== d) return;
          raw = { run: relTo(base, p) };
        } else
          raw = {
            run: { run: "" },
            unmount: { unmount: "" },
            mount: { mount: { from: "", to: "" } },
            pm2: { pm2: { app: "", do: "restart" } },
            log: { log: "" },
            fail: { fail: "" },
            if: { if: { run: "", then: [{ log: "ผ่าน" }], else: [{ fail: "ไม่ผ่าน" }] } },
            checkout: "checkout",
          }[kind];
        if (kind === "mount" || kind === "unmount") needSudo(d);
        focusStep = keyOf([...list, addStep(d, i, raw, list)]);
        break;
      }
      case "step-del":
        toSteps(d, i);
        removeAt(d, list, j);
        break;
      case "step-move": {
        const choices = moveChoices(i, list, j);
        openMenu(b, choices, (m) => {
          if (doc !== d || !choices[m]?.run(d)) return;
          focusStep = null;
          emit();
          render();
        });
        return;
      }
      case "menu-pick": {
        const pick = menuPick;
        closeMenu();
        pick?.(+b.dataset.m!);
        return;
      }
      case "step-up":
      case "step-down":
        toSteps(d, i);
        move(d, list, j, b.dataset.act === "step-up" ? -1 : 1);
        break;
      case "pick": {
        const path = JSON.parse(b.dataset.for!) as Path;
        if (path[4] === "steps") toSteps(d, i);
        const kind = b.dataset.kind as "dir" | "file";
        const cur = g(path);
        const p = await o.pick(kind, kind === "file" ? dirOf(cur) : cur || "~");
        if (!p || doc !== d) return;
        put(d, path, p);
        break;
      }
      default:
        return;
    }
    emit();
    render();
  });

  // ---- drag a step's badge onto another step of the same list to reorder ----
  let dragging: { l: string; from: number } | null = null;
  /** Step row under the pointer that sits in the dragged step's list (rows nested in an if are skipped up). */
  const stepAt = (e: Event) => {
    let li = (e.target as HTMLElement).closest<HTMLElement>("[data-step]");
    while (li && dragging && li.dataset.l !== dragging.l) li = li.parentElement?.closest<HTMLElement>("[data-step]") ?? null;
    return li;
  };
  const clearDrop = () => box.querySelectorAll(".ez-drop-before, .ez-drop-after").forEach((el) => el.classList.remove("ez-drop-before", "ez-drop-after"));
  box.addEventListener("dragstart", (e) => {
    const h = (e.target as HTMLElement).closest<HTMLElement>("[data-drag]");
    const li = h?.closest<HTMLElement>("[data-step]");
    if (!h || !li) return;
    dragging = { l: li.dataset.l!, from: +li.dataset.j! };
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", li.dataset.step!);
    li.classList.add("opacity-40");
  });
  box.addEventListener("dragover", (e) => {
    const li = stepAt(e);
    if (!dragging || !li) return;
    e.preventDefault();
    clearDrop();
    const r = li.querySelector(".tree-row")!.getBoundingClientRect(); // the row itself, not an if's branches below it
    li.classList.add(e.clientY < r.top + r.height / 2 ? "ez-drop-before" : "ez-drop-after");
  });
  box.addEventListener("drop", (e) => {
    const li = stepAt(e);
    if (!dragging || !li || !doc) return;
    e.preventDefault();
    const { l, from } = dragging;
    const over = +li.dataset.j!;
    let to = li.classList.contains("ez-drop-after") ? over + 1 : over;
    if (from < to) to--; // the dragged item leaves its old slot first
    toSteps(doc, +li.dataset.ti!);
    moveTo(doc, JSON.parse(l), from, to);
    emit();
    render();
  });
  box.addEventListener("dragend", () => {
    dragging = null;
    clearDrop();
    box.querySelectorAll(".opacity-40").forEach((el) => el.classList.remove("opacity-40"));
  });

  return {
    /** Shows `text` in the form; returns an error message if it can't be shown. */
    load(text: string): string | null {
      try {
        doc = openDoc(text);
      } catch (e) {
        return (e as Error).message;
      }
      focusStep = null;
      verMode = null;
      render();
      return null;
    },
    /** Outlines the fields a parseManifest error is about ("" clears). */
    mark(msg: string) {
      box.querySelectorAll(".easy-bad").forEach((el) => el.classList.remove("easy-bad"));
      const k = errKey(msg);
      if (!k) return;
      box.querySelectorAll<HTMLElement>("[data-k]").forEach((el) => {
        const ek = el.dataset.k!;
        if (ek === k || ek.startsWith(k + ".") || ek.startsWith(k + "[")) el.classList.add("easy-bad");
      });
    },
  };
}
