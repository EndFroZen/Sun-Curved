// Flow view of a deployment: the compiled script's `step` lines drawn as a pipeline.
// "Simulate" walks it without touching the machine; a real Apply lights it up from the `==> ` output.

/** `branch`: the if branches the step sits in, outermost first (empty = always runs). */
export type FlowStep = { title: string; group: string; label: string; cmds: string[]; branch: ("then" | "else")[] };

/** Splits a compiled deploy script into its steps (same order bash prints `==> ` lines). */
export function flowSteps(script: string): FlowStep[] {
  const out: FlowStep[] = [];
  const branch: ("then" | "else")[] = [];
  for (const line of script.split("\n")) {
    const m = /^step '(.*)'$/.exec(line);
    if (m) {
      const title = m[1].replace(/'\\''/g, "'");
      const i = title.indexOf(": ");
      const group = i >= 0 ? title.slice(0, i) : "done";
      out.push({ title, group, label: i >= 0 ? title.slice(i + 2) : title, cmds: [], branch: [...branch] });
    } else if (line === "# @then") branch.push("then");
    else if (line === "# @else") branch.splice(-1, 1, "else");
    else if (line === "# @end") branch.pop();
    else if (out.length && line.trim() && !line.startsWith("#") && !line.endsWith("  #@") && line !== "} < /dev/null") {
      out[out.length - 1].cmds.push(line);
    }
  }
  return out;
}

export type FlowKind = "git" | "run" | "mount" | "pm2" | "if" | "fail" | "done";
/** What a step is, from its label (for the icon and chip). */
export function flowKind(s: FlowStep): FlowKind {
  if (s.group === "done") return "done";
  if (/^(checkout|pull) /.test(s.label)) return "git";
  if (/^(un)?mount /.test(s.label)) return "mount";
  if (/^pm2 /.test(s.label)) return "pm2";
  if (/^if /.test(s.label)) return "if";
  if (/^fail /.test(s.label)) return "fail";
  return "run";
}

/** Index of the step a `==> title` line is about: the next one after `at` with that title
 *  (steps in between sat in a branch that didn't run). Unknown title: simply the next step. */
export function nextStep(steps: FlowStep[], at: number, title?: string): number {
  if (title !== undefined) for (let i = at + 1; i < steps.length; i++) if (steps[i].title === title) return i;
  return at + 1;
}

/** Where each step sits on the isometric floor: `col` runs along the pipeline, `lane` sideways
 *  (then branch on the negative side, else on the positive). `edges` = [from, to] pipes;
 *  a branch that didn't happen falls straight through from its if to where the branches meet. */
export function isoLayout(steps: FlowStep[]): { pos: { col: number; lane: number }[]; edges: [number, number][] } {
  const depth = Math.max(0, ...steps.map((s) => s.branch.length));
  const off = (side: "then" | "else", j: number) => (side === "then" ? -1 : 1) * 2 ** (depth - 1 - j);
  type Frame = { col: number; lane: number; max: number; side: "then" | "else"; tails: number[]; other: number[] };
  const stack: Frame[] = [];
  const pos: { col: number; lane: number }[] = [];
  const edges: [number, number][] = [];
  let col = -1, lane = 0;
  let tails: number[] = [];
  steps.forEach((s, i) => {
    const b = s.branch;
    let k = 0;
    while (k < stack.length && k < b.length && stack[k].side === b[k]) k++;
    while (stack.length > k) {
      const f = stack[stack.length - 1];
      f.max = Math.max(f.max, col);
      if (stack.length - 1 === k && k < b.length) {
        // then → else of the same if: start again next to the if
        f.other = tails;
        tails = f.tails;
        f.side = b[k];
        col = f.col;
        lane = f.lane + off(f.side, k);
        k++;
        break;
      }
      stack.pop(); // branches meet
      tails = [...f.other, ...tails];
      col = f.max;
      lane = f.lane;
    }
    while (stack.length < b.length) {
      const j = stack.length;
      stack.push({ col, lane, max: col, side: b[j], tails, other: tails });
      lane += off(b[j], j);
    }
    col++;
    pos.push({ col, lane });
    tails.forEach((t) => edges.push([t, i]));
    tails = flowKind(s) === "fail" ? [] : [i];
  });
  return { pos, edges };
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const svg = (d: string, cls = "h-4 w-4") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON: Record<FlowKind | "source" | "check" | "x" | "play" | "chev", string> = {
  source: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  git: '<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/>',
  run: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  mount: '<path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8"/>',
  pm2: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  if: '<path d="M6 3v6a6 6 0 0 0 6 6h6M18 15l-3-3M18 15l-3 3M6 21v-6"/>',
  fail: '<circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/>',
  done: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  play: '<path d="M6 3l14 9-14 9z"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
};
const KIND_NAME: Record<FlowKind, string> = { git: "git", run: "command", mount: "mount", pm2: "pm2", if: "if", fail: "fail", done: "finish" };
const fmt = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

type State = "idle" | "run" | "ok" | "fail" | "skip";

// ---- isometric 3D view: each step is a block on a floor, joined by pipes ----
const CELL = 112; // floor cell (px, before projection)
const KX = CELL * Math.cos(Math.PI / 6), KY = CELL * Math.sin(Math.PI / 6);
const A = 0.3; // half the block's footprint, in cells
const H = 22; // block height (px)
const n = (v: number) => +v.toFixed(1);
/** Floor point (col, lane) → screen. */
const P = (x: number, y: number): [number, number] => [n((x - y) * KX), n((x + y) * KY)];
const pts = (...p: [number, number][]) => p.map((q) => q.join(",")).join(" ");
const up = ([x, y]: [number, number], h: number): [number, number] => [x, n(y - h)];
// the block, around its own centre
const C = { n: P(-A, -A), e: P(A, -A), s: P(A, A), w: P(-A, A) };
const BLOCK = `
  <polygon class="iso-r" points="${pts(C.e, C.s, up(C.s, H), up(C.e, H))}"/>
  <polygon class="iso-l" points="${pts(C.w, C.s, up(C.s, H), up(C.w, H))}"/>
  <polygon class="iso-top" points="${pts(up(C.n, H), up(C.e, H), up(C.s, H), up(C.w, H))}"/>`;
const SLOT = `<polygon class="iso-slot" points="${pts(P(-A - 0.07, -A - 0.07), P(A + 0.07, -A - 0.07), P(A + 0.07, A + 0.07), P(-A - 0.07, A + 0.07))}"/>`;
// a 24×24 icon laid flat on the top face, its "up" along the face's up-right edge
const G = ((2 * A) / 24) * 0.62; // icon scale: 62% of the face
const r3 = (v: number) => +v.toFixed(3);
const FLAT = `matrix(${r3(KX * G)} ${r3(-KY * G)} ${r3(KX * G)} ${r3(KY * G)} ${n(-24 * KX * G)} ${-H})`;
// check / x stay upright (laid flat a check reads like an L), just squashed onto the face
const FACING = `matrix(1.15 0 0 .7 ${-12 * 1.15} ${n(-H - 12 * 0.7)})`;
const glyph = (d: string, cls: string, t = FLAT) => `<g class="${cls}" transform="${t}"><g fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</g></g>`;
const cut = (s: string, max = 20) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const LANE = 1.5; // lanes sit further apart than steps, so labels have room

function isoScene(steps: FlowStep[], repo: string, ver: string) {
  const { pos, edges } = isoLayout(steps);
  const all = [{ col: -1, lane: 0 }, ...pos].map((p) => ({ x: p.col, y: p.lane * LANE })); // the source sits before step 0
  const at = (i: number) => all[i + 1];
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const M = 0.75; // floor margin around the blocks (cells)
  const [x0, x1, y0, y1] = [Math.min(...xs) - M, Math.max(...xs) + M, Math.min(...ys) - M, Math.max(...ys) + M];
  const plate = [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
  // bounds of the floor + room for the labels on the right and the lifted blocks on top
  const minX = Math.min(...plate.map((c) => c[0])), maxX = Math.max(...plate.map((c) => c[0]), ...all.map((p) => P(p.x, p.y)[0] + 230));
  const minY = Math.min(...plate.map((c) => c[1]), ...all.map((p) => P(p.x, p.y)[1] - 70)), maxY = Math.max(...plate.map((c) => c[1])) + 4;

  let floor = "";
  for (let x = Math.ceil(x0); x <= x1; x++) for (let y = Math.ceil(y0 / LANE) * LANE; y <= y1; y += LANE) floor += `<circle cx="${P(x, y)[0]}" cy="${P(x, y)[1]}" r="1.4"/>`;

  const pipe = ([a, b]: [number, number]) => {
    const p = at(a), q = at(b);
    const path = p.y === q.y ? [P(p.x, p.y), P(q.x, q.y)] : [P(p.x, p.y), P(q.x - 0.5, p.y), P(q.x - 0.5, q.y), P(q.x, q.y)];
    return `M${path.map((c) => c.join(",")).join("L")}`;
  };
  const pipes = [[-1, 0] as [number, number], ...edges]
    .map((e) => `<path class="iso-pipe" d="${pipe(e)}"/><path class="iso-flowline" data-e="${e[0]},${e[1]}" d="${pipe(e)}"/>`)
    .join("");

  const lx = n(KX * A * 2 + 4), ly = -H + 2;
  const groups = new Set(steps.filter((s) => s.group !== "done").map((s) => s.group));
  let prev = "";
  /** The block, and its label (drawn later, above every block). */
  const node = (i: number): [string, string] => {
    const [x, y] = P(at(i).x, at(i).y);
    if (i < 0) {
      const short = repo.replace(/^https?:\/\//, "").replace(/\.git$/, "");
      return [
        `<g class="iso-node iso-k-source" transform="translate(${x},${y})" data-state="ok">${SLOT}<g class="iso-lift">${BLOCK}${glyph(ICON.source, "iso-glyph")}</g></g>`,
        `<g class="iso-node iso-k-source" transform="translate(${x},${y})"><text class="iso-label" x="${lx}" y="${ly}"><title>${esc(repo)}</title>${esc(cut(short, 26))}</text>
          <text class="iso-sub" x="${lx}" y="${ly + 15}">source${ver ? ` · ${esc(ver)}` : ""}</text></g>`,
      ];
    }
    const s = steps[i], kind = flowKind(s);
    const br = s.branch[s.branch.length - 1];
    const head = groups.size > 1 && s.group !== "done" && s.group !== prev ? `<text class="iso-group" x="${lx}" y="${ly - 17}">target · ${esc(s.group)}</text>` : "";
    prev = s.group;
    return [
      `<g class="iso-node iso-k-${kind}" data-i="${i}" data-state="idle" transform="translate(${x},${y})" tabindex="0" role="button" aria-label="${esc(s.title)}">
        <title>${esc(s.title)}</title>${SLOT}
        <g class="iso-lift">${BLOCK}${glyph(ICON[kind], "flow-ic iso-glyph")}${glyph(ICON.check, "flow-ok iso-glyph", FACING)}${glyph(ICON.x, "flow-bad iso-glyph", FACING)}</g>
      </g>`,
      `<g class="iso-node iso-text iso-k-${kind}" data-i="${i}" data-state="idle" transform="translate(${x},${y})">
        <title>${esc(s.title)}</title>${head}<text class="iso-label" x="${lx}" y="${ly}">${esc(cut(s.label))}</text>
        <text class="iso-sub" x="${lx}" y="${ly + 15}">${KIND_NAME[kind]}${br ? ` · <tspan class="iso-br-${br}">${br === "then" ? "ผ่าน" : "ไม่ผ่าน"}</tspan>` : ""} <tspan data-time></tspan></text>
      </g>`,
    ];
  };
  // back to front, so nearer blocks cover farther ones
  const order = [-1, ...steps.map((_, i) => i)].sort((a, b) => at(a).x + at(a).y - (at(b).x + at(b).y) || a - b).map(node);
  return `<svg class="iso" viewBox="${n(minX)} ${n(minY)} ${n(maxX - minX)} ${n(maxY - minY)}" width="${n(maxX - minX)}" height="${n(maxY - minY)}">
    <polygon class="iso-plate" points="${pts(...plate)}"/><g class="iso-floor">${floor}</g>
    <g>${pipes}</g>${order.map((o) => o[0]).join("")}${order.map((o) => o[1]).join("")}</svg>`;
}

export function createFlow(box: HTMLElement, log: (text: string, step: boolean) => void) {
  let steps: FlowStep[] = [];
  let st: State[] = [];
  let at = -1; // current step
  let gen = 0; // bumping it stops a running simulation
  let started: number[] = []; // when each step began (ms)
  let stopped: number[] = []; // when each step ended (ms)
  let t0 = 0; // when the run began
  let ended = 0; // when the run ended, 0 = still running
  let timer = 0;
  let live = false; // a real deploy is lighting it up
  let follow = true; // the detail panel follows the running step (until a block is clicked)
  let view: "iso" | "list" = localStorage.getItem("flow-view") === "list" ? "list" : "iso";

  /** Shows step `i` (its commands) under the 3D view. */
  function detail(i: number) {
    const el = box.querySelector<HTMLElement>("[data-detail]"), s = steps[i];
    if (!el || !s) return;
    box.querySelectorAll<SVGElement>(".iso-node[data-i]").forEach((g) => g.classList.toggle("iso-sel", +g.dataset.i! === i));
    const kind = flowKind(s), cmds = s.cmds.filter((c) => !/^cd /.test(c));
    const word: Record<State, string> = { idle: "รอ", run: "กำลังทำ…", ok: "สำเร็จ", fail: "ล้มเหลว", skip: "ข้าม" };
    el.dataset.state = st[i];
    el.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="flow-chip flow-chip-${kind}">${KIND_NAME[kind]}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-[13px] text-zinc-100">${esc(s.title)}</span>
        <span class="iso-detail-state">${word[st[i]]}</span>
      </div>
      ${cmds.length ? `<pre class="iso-cmds">${esc(cmds.join("\n"))}</pre>` : `<p class="mt-2 text-xs text-zinc-500">ไม่มีคำสั่ง</p>`}`;
  }

  const rows = () => box.querySelectorAll<HTMLElement>("[data-i]");
  function tick() {
    const now = ended || Date.now();
    rows().forEach((el) => {
      const i = +el.dataset.i!, t = el.querySelector<HTMLElement>("[data-time]");
      if (!t) return;
      t.textContent = started[i] === undefined ? "" : fmt((stopped[i] ?? now) - started[i]);
    });
    const total = box.querySelector<HTMLElement>("[data-total]");
    if (total && t0) total.textContent = fmt(now - t0);
  }
  function paint() {
    rows().forEach((el) => (el.dataset.state = st[+el.dataset.i!]));
    // a pipe lights up once something went through it: both ends ran
    box.querySelectorAll<SVGElement>("[data-e]").forEach((el) => {
      const [a, b] = el.dataset.e!.split(",").map(Number);
      const from = a < 0 ? "ok" : st[a], to = st[b];
      const went = (from === "ok" || from === "fail" || from === "run") && to !== "idle" && to !== "skip";
      el.dataset.state = !went ? "idle" : to === "run" ? "run" : to === "fail" ? "fail" : "ok";
    });
    if (follow && at >= 0) detail(at);
    const running = st.includes("run");
    const failed = st.includes("fail");
    const state = failed ? "fail" : running || (at >= 0 && !ended) ? "run" : "ok";
    const done = st.filter((s) => s === "ok" || s === "skip" || s === "fail").length;
    const bar = box.querySelector<HTMLElement>("[data-bar]");
    if (bar) {
      bar.style.width = `${steps.length ? (done / steps.length) * 100 : 0}%`;
      bar.dataset.state = state;
    }
    const count = box.querySelector<HTMLElement>("[data-count]");
    if (count) count.textContent = `${done}/${steps.length}`;
    const status = box.querySelector<HTMLElement>("[data-status]");
    if (status) {
      status.dataset.state = at < 0 ? "idle" : state;
      status.textContent = at < 0 ? "พร้อม" : state === "run" ? "กำลังทำ…" : state === "ok" ? "สำเร็จ" : "ล้มเหลว";
    }
    clearInterval(timer);
    if (running) timer = window.setInterval(tick, 200);
    tick();
  }
  function reset() {
    st = steps.map(() => "idle");
    at = -1;
    started = [];
    stopped = [];
    t0 = 0;
    ended = 0;
  }
  /** Step `i` starts: the running one is done, the ones jumped over were in a branch that didn't run. */
  function begin(i: number) {
    if (at < 0) {
      reset();
      t0 = Date.now();
    }
    if (i >= steps.length) return;
    const now = Date.now();
    if (at >= 0 && st[at] === "run") (st[at] = "ok"), (stopped[at] = now);
    for (let k = Math.max(at + 1, 0); k < i; k++) st[k] = "skip";
    st[i] = "run";
    started[i] = now;
    at = i;
    paint();
    follow = true;
    box.querySelector(`.flow-pane-${view} [data-i="${i}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function finish(ok: boolean) {
    ended = Date.now();
    if (at >= 0 && st[at] === "run") (st[at] = ok ? "ok" : "fail"), (stopped[at] = ended);
    if (ok) for (let k = at + 1; k < steps.length; k++) st[k] = "skip";
    paint();
  }

  /** Dry run; `pass` = what each if's condition does (then branch or else branch). */
  async function simulate(pass: boolean) {
    const me = ++gen;
    at = -1;
    log(`dry run (conditions ${pass ? "pass" : "fail"}) - nothing is sent to the machine`, false);
    const skip = pass ? "else" : "then";
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].branch.includes(skip)) continue;
      begin(i);
      log(`==> ${steps[i].title}`, true);
      steps[i].cmds.forEach((c) => log(`  ${c}`, false));
      await sleep(700);
      if (me !== gen) return;
      if (flowKind(steps[i]) === "fail") return finish(false);
    }
    finish(true);
  }

  function row(s: FlowStep, i: number, last: boolean) {
    const kind = flowKind(s);
    const cmds = s.cmds.filter((c) => !/^cd /.test(c));
    const br = s.branch[s.branch.length - 1];
    const tag = br ? `<span class="flow-br flow-br-${br}" title="ทำเมื่อเงื่อนไข${br === "then" ? "ผ่าน" : "ไม่ผ่าน"}">${br === "then" ? "ผ่าน" : "ไม่ผ่าน"}</span>` : "";
    return `
      <li data-i="${i}" data-state="idle" class="flow-row" style="margin-left:${s.branch.length * 1.75}rem">
        <div class="flow-rail">
          <span class="flow-dot">
            <span class="flow-ic">${svg(ICON[kind], "h-3.5 w-3.5")}</span>
            <span class="flow-ok">${svg(ICON.check, "h-3.5 w-3.5")}</span>
            <span class="flow-bad">${svg(ICON.x, "h-3.5 w-3.5")}</span>
          </span>
          ${last ? "" : `<span class="flow-line"></span>`}
        </div>
        <div class="flow-card" data-toggle tabindex="0" role="button" aria-expanded="false">
          <div class="flex items-center gap-2">
            ${tag}<span class="flow-chip flow-chip-${kind}">${KIND_NAME[kind]}</span>
            <span class="flow-label min-w-0 flex-1 truncate font-mono text-[13px] text-zinc-100">${esc(s.label)}</span>
            <span data-time class="font-mono text-[11px] tabular-nums text-zinc-500"></span>
            ${cmds.length ? `<span class="flow-chev text-zinc-500">${svg(ICON.chev, "h-3.5 w-3.5")}</span>` : ""}
          </div>
          ${cmds.length ? `<pre class="flow-cmds">${esc(cmds.join("\n"))}</pre>` : ""}
        </div>
      </li>`;
  }

  return {
    /** Draws the pipeline of a compiled script; `head` = "repo @ version" shown on top. */
    render(script: string, head: string) {
      gen++;
      clearInterval(timer);
      steps = flowSteps(script);
      reset();
      const hasIf = steps.some((s) => flowKind(s) === "if");
      const [repo, ver = ""] = head.split(" @ ");
      const short = repo.replace(/^https?:\/\//, "").replace(/\.git$/, "");
      // a heading whenever the target changes (only when there is more than one target)
      const groups = new Set(steps.filter((s) => s.group !== "done").map((s) => s.group));
      let prev = "";
      const list = steps
        .map((s, i) => {
          const h = groups.size > 1 && s.group !== "done" && s.group !== prev ? `<li class="flow-group">target · ${esc(s.group)}</li>` : "";
          prev = s.group;
          return h + row(s, i, i === steps.length - 1);
        })
        .join("");
      box.innerHTML = `
        <div class="flow" data-view="${view}">
          <div class="flow-head">
            <div class="flex items-center gap-3">
              <span data-status data-state="idle" class="flow-status">พร้อม</span>
              <span class="text-xs text-zinc-500"><span data-count>0/${steps.length}</span> ขั้นตอน · <span data-total>–</span></span>
              <span class="flex-1"></span>
              <span class="flow-views" role="group" aria-label="มุมมอง">
                <button data-view="iso" aria-pressed="${view === "iso"}">3D</button>
                <button data-view="list" aria-pressed="${view === "list"}">รายการ</button>
              </span>
              <button data-sim="1" class="flow-sim" ${hasIf ? 'title="จำลองว่าทุก if ผ่าน"' : ""}>${svg(ICON.play, "h-3 w-3")} Simulate${hasIf ? " · ผ่าน" : ""}</button>
              ${hasIf ? `<button data-sim="0" class="flow-sim flow-sim-bad" title="จำลองว่าทุก if ไม่ผ่าน">${svg(ICON.play, "h-3 w-3")} ไม่ผ่าน</button>` : ""}
            </div>
            <div class="flow-track"><span data-bar class="flow-bar"></span></div>
          </div>
          <div class="flow-pane-iso">
            <div class="iso-wrap">${isoScene(steps, repo, ver)}</div>
            <div class="iso-detail" data-detail><p class="text-center text-xs text-zinc-500">คลิกบล็อกเพื่อดูคำสั่ง</p></div>
          </div>
          <div class="flow-body flow-pane-list">
            <div class="flow-source">
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-amber-400">${svg(ICON.source)}</span>
              <div class="min-w-0 flex-1">
                <p class="text-[11px] font-medium uppercase tracking-wider text-zinc-500">source</p>
                <p class="truncate font-mono text-[13px] text-zinc-100" title="${esc(repo)}">${esc(short)}</p>
              </div>
              ${ver ? `<span class="flow-ver">${esc(ver)}</span>` : ""}
            </div>
            <ol class="flow-list">${list}</ol>
            <p class="mt-3 text-center text-[11px] text-zinc-500">คลิกขั้นตอนเพื่อดูคำสั่ง</p>
          </div>
        </div>`;
      box.querySelectorAll<HTMLElement>("[data-sim]").forEach((b) => (b.onclick = () => simulate(b.dataset.sim === "1")));
      box.querySelectorAll<HTMLButtonElement>("button[data-view]").forEach((b) => {
        b.onclick = () => {
          view = b.dataset.view as "iso" | "list";
          localStorage.setItem("flow-view", view);
          box.querySelector<HTMLElement>(".flow")!.dataset.view = view;
          box.querySelectorAll("button[data-view]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        };
      });
      box.querySelectorAll<SVGElement>(".iso-node[data-i]").forEach((g) => {
        const pick = () => ((follow = false), detail(+g.dataset.i!));
        g.onclick = pick;
        g.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick());
      });
      box.querySelectorAll<HTMLElement>("[data-toggle]").forEach((c) => {
        const flip = () => c.setAttribute("aria-expanded", String(c.getAttribute("aria-expanded") !== "true"));
        c.onclick = flip;
        c.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), flip());
      });
    },
    /** Real deploy printed a `==> title` line. */
    step(title?: string) {
      gen++;
      if (!live) (at = -1), (live = true); // a new real run (stops a simulation, forgets an earlier run)
      begin(nextStep(steps, at, title));
    },
    end(ok: boolean) {
      live = false;
      finish(ok);
    },
  };
}
