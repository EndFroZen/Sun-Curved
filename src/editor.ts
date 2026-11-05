// Code editor for deploy manifests: CodeMirror 6 + our schema-driven suggestions.
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { snippetCompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { suggest } from "./deploy";

// Colours come from CSS variables (styles.css), so day/night switches without rebuilding the editor.
const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--code-key)" },
  { tag: [t.string, t.special(t.string), t.content], color: "var(--code-str)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--code-num)" },
  { tag: t.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: "var(--code-kw)" },
  { tag: [t.variableName, t.special(t.variableName), t.labelName, t.typeName], color: "var(--code-var)" },
  { tag: [t.punctuation, t.separator, t.operator, t.bracket, t.brace, t.squareBracket, t.meta], color: "var(--code-punct)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: "var(--code-fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "'Cascadia Mono', Consolas, monospace", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--code-cursor)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--code-cursor)", borderLeftWidth: "2px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--code-gutter)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px" },
  ".cm-activeLine": { backgroundColor: "var(--code-active)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--code-cursor)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--code-sel) !important" },
  ".cm-selectionMatch": { backgroundColor: "var(--code-active)" },
  ".cm-matchingBracket": { backgroundColor: "var(--code-sel)", outline: "none" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--code-active)", border: "none", color: "var(--code-comment)" },
  ".cm-tooltip": {
    backgroundColor: "var(--code-tip-bg)",
    border: "1px solid var(--code-tip-border)",
    borderRadius: "10px",
    overflow: "hidden",
    boxShadow: "0 12px 32px rgb(0 0 0 / .35)",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "'Cascadia Mono', Consolas, monospace", maxHeight: "18em" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px !important" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--code-sel)", color: "var(--code-fg)" },
  ".cm-completionDetail": { color: "var(--code-comment)", fontStyle: "normal", marginLeft: "0.8em" },
  ".cm-completionInfo": { padding: "6px 10px", maxWidth: "22em", color: "var(--code-fg)" },
  ".cm-completionIcon": { opacity: "0.8" },
  ".cm-panels": { backgroundColor: "var(--code-tip-bg)", color: "var(--code-fg)" },
  ".cm-panel input, .cm-panel button": { color: "inherit" },
});

/** Bridges deploy.suggest() into CodeMirror completions. */
function complete(ctx: CompletionContext) {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const lines = ctx.state.doc.toString().split("\n");
  const r = suggest(lines, line.number - 1, before);
  if (!r) return null;
  // Typing a word or a value opens the list; on a blank indent only Ctrl+Space does.
  if (!ctx.explicit && r.start === before.length && !/:\s+$|-\s+$/.test(before)) return null;
  const options: Completion[] = r.items.map((s) =>
    s.kind === "snippet"
      ? snippetCompletion(s.insert, { label: s.label, type: "keyword", detail: "snippet", info: s.doc })
      : { label: s.label, type: s.kind === "key" ? "property" : "constant", apply: s.insert, info: s.doc },
  );
  return { from: line.from + r.start, options, validFor: /^[\w-]*$/ };
}

const yamlLang = yaml();
const yamlExt = [yamlLang, yamlLang.language.data.of({ autocomplete: complete })];
const shExt = StreamLanguage.define(shell);
// manifest = YAML + deploy-schema suggestions; yaml = plain YAML (any other file).
const langs = { manifest: yamlExt, yaml: yaml(), sh: shExt, text: [] };
export type Mode = keyof typeof langs;

export type CodeEditor = { get(): string; set(text: string, mode?: Mode, readOnly?: boolean): void; focus(): void };

export function createEditor(parent: HTMLElement, onChange: () => void): CodeEditor {
  const lang = new Compartment();
  const readOnly = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        indentUnit.of("  "),
        EditorState.tabSize.of(2),
        lang.of(yamlExt),
        readOnly.of(EditorState.readOnly.of(false)),
        syntaxHighlighting(highlight),
        theme,
        EditorView.updateListener.of((u) => u.docChanged && onChange()),
      ],
    }),
  });
  return {
    get: () => view.state.doc.toString(),
    set(text, mode = "manifest", ro = false) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        effects: [lang.reconfigure(langs[mode]), readOnly.reconfigure(EditorState.readOnly.of(ro))],
      });
    },
    focus: () => view.focus(),
  };
}
