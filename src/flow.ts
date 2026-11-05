// Flow view of a deployment: the compiled script's `step` lines drawn as a pipeline.
// "Simulate" walks it without touching the machine; a real Apply lights it up from the `==> ` output.

export type FlowStep = { title: string; group: string; label: string; cmds: string[] };

/** Splits a compiled deploy script into its steps (same order bash prints `==> ` lines). */
export function flowSteps(script: string): FlowStep[] {
  const out: FlowStep[] = [];
  for (const line of script.split("\n")) {
    const m = /^step '(.*)'$/.exec(line);
    if (m) {
      const title = m[1].replace(/'\\''/g, "'");
      const i = title.indexOf(": ");
      const group = i >= 0 ? title.slice(0, i) : title.startsWith("traffic") ? "nginx" : "done";
      out.push({ title, group, label: i >= 0 ? title.slice(i + 2) : title, cmds: [] });
    } else if (out.length && line.trim() && !line.startsWith("#") && line !== "} < /dev/null") {
      out[out.length - 1].cmds.push(line);
    }
  }
  return out;
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createFlow(box: HTMLElement, log: (text: string, step: boolean) => void) {
  let steps: FlowStep[] = [];
  let at = -1; // current step
  let gen = 0; // bumping it stops a running simulation

  const paint = (state: "run" | "ok" | "fail") =>
    box.querySelectorAll<SVGGElement>("[data-i]").forEach((el) => {
      const i = +el.dataset.i!;
      el.dataset.state = i < at ? "ok" : i === at ? state : "idle";
    });

  async function simulate() {
    const me = ++gen;
    log("dry run - nothing is sent to the machine", false);
    for (at = 0; at < steps.length; at++) {
      paint("run");
      log(`==> ${steps[at].title}`, true);
      steps[at].cmds.forEach((c) => log(`  ${c}`, false));
      await sleep(700);
      if (me !== gen) return;
    }
    paint("ok");
  }

  return {
    /** Draws the pipeline of a compiled script; `head` = source line shown on top. */
    render(script: string, head: string) {
      gen++;
      at = -1;
      steps = flowSteps(script);
      // SVG pipeline: source box, then one box per step; wire i-1 -> i carries step i's state.
      const W = 440, H = 40, GAP = 22, X = 20;
      const y = (i: number) => (i + 1) * (H + GAP) + 10; // i = -1 is the source box
      const node = (i: number, top: string, label: string, tip: string) => `
        <g data-i="${i}" data-state="idle" class="flow-node">
          <title>${esc(tip)}</title>
          ${i >= 0 ? `<line x1="${W / 2}" y1="${y(i - 1) + H}" x2="${W / 2}" y2="${y(i)}" class="flow-wire" />` : ""}
          <rect x="${X}" y="${y(i)}" width="${W - 2 * X}" height="${H}" rx="10" />
          <text x="${X + 14}" y="${y(i) + 16}" class="flow-top">${esc(top)}</text>
          <text x="${X + 14}" y="${y(i) + 31}" class="flow-label">${esc(label)}</text>
        </g>`;
      const svg = `<svg viewBox="0 0 ${W} ${y(steps.length)}" width="${W}" class="mx-auto block">
        ${node(-1, "source", head, head)}
        ${steps.map((s, i) => node(i, s.group, s.label, s.cmds.join("\n"))).join("")}
      </svg>`;
      box.innerHTML = `
        <div class="flex items-center gap-3 border-b border-zinc-800 px-5 py-2">
          <span class="min-w-0 flex-1 truncate text-xs text-zinc-500">Hover a step to see its commands</span>
          <button data-sim class="rounded-lg border border-amber-500/40 px-3 py-1 text-xs font-medium text-amber-400 hover:bg-amber-500/10">▶ Simulate</button>
        </div>
        <div class="p-5">${svg}</div>`;
      box.querySelector<HTMLElement>("[data-sim]")!.onclick = simulate;
    },
    /** Real deploy printed a `==> ` line. */
    step() {
      gen++;
      at++;
      paint("run");
    },
    end(ok: boolean) {
      if (ok) at = steps.length;
      paint(ok ? "ok" : "fail");
    },
  };
}
