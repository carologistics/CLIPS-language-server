/**
 * @file Quick fixes for unknown names and slots and unneeded declarations.
 *
 * For an unknown name: change to a similar known name, declare it as
 * external (with the slots the workspace uses, or name only), define it in
 * this file, or declare all unknown names except likely typos. The last is
 * a normal quick fix, not `source.fixAll`, so saving never declares typos.
 *
 * Declarations go into the nearest hand-written .clpd file, or a new
 * `externals.clpd`. A generated `host.clpd` is never edited.
 */

import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SyntaxNode, Tree } from 'tree-sitter';
import {
  CodeActionKind,
  CreateFile,
  TextDocumentEdit,
  TextEdit,
  type CodeAction,
  type Diagnostic,
  type Position,
  type Range,
  type WorkspaceEdit
} from 'vscode-languageserver/node.js';
import { BUILTIN_FUNCTIONS } from './builtins.js';
import { BUILTIN_CLASSES, instanceDefinitionClass } from './classes.js';
import { isDeclarationFile, type DeclarationFileInfo } from './declarations.js';
import type { UnknownNameData, UnknownSlotData } from './diagnostics.js';
import { factActionPatterns } from './slots.js';
import { nameKey, type SymbolTable } from './symbolTable.js';
import { displayName, uriKey, uriToPath } from './uri.js';

/** Input for the quick fixes. */
export interface CodeActionContext {
  /** The document the fixes are for. */
  uri: string;
  /** Its tree. */
  tree: Tree;
  /** The lookup scope. */
  scope: SymbolTable;
  /** All indexed documents, to find how names are used. */
  documents: { uri: string; tree: Tree; text: string }[];
  /** Nearest first. */
  declarationFiles: DeclarationFileInfo[];
  /** All of the document's diagnostics, for the bulk fix. */
  allDiagnostics: Diagnostic[];
  /** The client can create files, so a new `externals.clpd` can be offered. */
  canCreateFiles: boolean;
}

/** File created for hand-written declarations. */
export const HAND_WRITTEN_FILE = 'externals.clpd';

/** Codes of the unknown-name diagnostics, which get the declare fixes. */
const UNKNOWN_CODES = new Set(['clips(template-unknown)', 'clips(class-unknown)', 'clips(global-unknown)', 'clips(function-unknown)']);
/** Codes of the declaration-file hints, which get the remove fix. */
const REMOVE_CODES = new Set(['clips(declaration-redundant)', 'clips(declaration-unused)']);

/**
 * The quick fixes for the given diagnostics.
 *
 * @param diagnostics - The diagnostics, with their `data`.
 * @param context - See {@link CodeActionContext}.
 * @returns The code actions.
 */
export function provideCodeActions(diagnostics: Diagnostic[], context: CodeActionContext): CodeAction[] {
  const actions: CodeAction[] = [];
  let bulkOffered = false;
  for (const diagnostic of diagnostics) {
    const code = String(diagnostic.code ?? '');
    if (UNKNOWN_CODES.has(code) && isUnknownNameData(diagnostic.data)) {
      actions.push(...unknownNameFixes(diagnostic, diagnostic.data, context));
      if (!bulkOffered) {
        const bulk = bulkDeclareFix(context);
        if (bulk) actions.push(bulk);
        bulkOffered = true;
      }
    } else if (code === 'clips(slot-unknown)' && isUnknownSlotData(diagnostic.data)) {
      const fix = addSlotFix(diagnostic, diagnostic.data, context);
      if (fix) actions.push(fix);
    } else if (REMOVE_CODES.has(code) && (diagnostic.data as { remove?: unknown } | undefined)?.remove === true) {
      const fix = removeDeclarationFix(diagnostic, context);
      if (fix) actions.push(fix);
    }
  }
  return actions;
}

/**
 * Whether diagnostic `data` is an {@link UnknownNameData}.
 *
 * @param data - The diagnostic's `data`.
 */
function isUnknownNameData(data: unknown): data is UnknownNameData {
  const d = data as UnknownNameData | undefined;
  return !!d && typeof d.name === 'string' && ['deftemplate', 'defclass', 'defglobal', 'function'].includes(d.kind);
}

/**
 * Whether diagnostic `data` is an {@link UnknownSlotData}.
 *
 * @param data - The diagnostic's `data`.
 */
function isUnknownSlotData(data: unknown): data is UnknownSlotData {
  const d = data as UnknownSlotData | undefined;
  return !!d && d.kind === 'slot' && typeof d.template === 'string' && typeof d.slot === 'string';
}

// Unknown names

/** Kind names used in fix titles. */
const KIND_LABEL: Record<UnknownNameData['kind'], string> = {
  deftemplate: 'template',
  defclass: 'class',
  defglobal: 'global',
  function: 'function'
};

/**
 * The fixes for one unknown name, in menu order.
 *
 * @param diagnostic - The unknown-name diagnostic.
 * @param data - Its `data`.
 * @param context - See {@link CodeActionContext}.
 * @returns The code actions.
 */
function unknownNameFixes(diagnostic: Diagnostic, data: UnknownNameData, context: CodeActionContext): CodeAction[] {
  const actions: CodeAction[] = [];
  const label = KIND_LABEL[data.kind];

  const typed = rangeText(context, diagnostic.range);
  const candidates = typed !== null && !typed.includes('::') ? closeNames(data, context.scope) : [];
  candidates.forEach((candidate, i) => {
    actions.push({
      title: `Change to "${candidate}"`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      isPreferred: i === 0,
      edit: { changes: { [context.uri]: [TextEdit.replace(diagnostic.range, candidate)] } }
    });
  });

  const target = declarationTarget(context);
  const full = fullDeclaration(data, context);
  const nameOnly = nameOnlyDeclaration(data);
  if (target) {
    const where = displayName(target.uri);
    if (full) actions.push(declareAction(`Declare ${label} "${data.name}" as external (${full.summary}) in ${where}`, [full.text], diagnostic, target));
    const only = data.kind === 'deftemplate' || data.kind === 'defclass' ? ' (name only, slots unchecked)' : '';
    actions.push(declareAction(`Declare ${label} "${data.name}" as external${only} in ${where}`, [nameOnly], diagnostic, target));
  }

  const definition = localDefinition(data, diagnostic, context);
  if (definition) {
    const form = topLevelFormAt(context.tree, diagnostic.range.start);
    const at: Position = { line: form ? form.startPosition.row : 0, character: 0 };
    actions.push({
      title: `Define ${label} "${data.name}" in this file`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: { changes: { [context.uri]: [TextEdit.insert(at, `${definition}\n\n`)] } }
    });
  }
  return actions;
}

/**
 * Declares all unknown names of the document except likely typos; offered for two or more.
 *
 * @param context - See {@link CodeActionContext}.
 * @returns The fix, or `null` if fewer than two names would be declared.
 */
function bulkDeclareFix(context: CodeActionContext): CodeAction | null {
  const target = declarationTarget(context);
  if (!target) return null;
  const seen = new Set<string>();
  const unknown: UnknownNameData[] = [];
  for (const d of context.allDiagnostics) {
    if (!UNKNOWN_CODES.has(String(d.code ?? '')) || !isUnknownNameData(d.data)) continue;
    const key = `${d.data.kind} ${d.data.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unknown.push(d.data);
  }
  if (unknown.length < 2) return null;
  const typos = unknown.filter((u) => closeNames(u, context.scope).length > 0);
  const declared = unknown.filter((u) => !typos.includes(u));
  if (declared.length === 0) return null;
  const texts = declared.map((u) => fullDeclaration(u, context)?.text ?? nameOnlyDeclaration(u));
  const skipped = typos.length > 0 ? ` (${typos.length} likely typo${typos.length === 1 ? '' : 's'} left out: ${typos.map((t) => t.name).join(', ')})` : '';
  return declareAction(
    `Declare all ${declared.length} unknown names in this file as external in ${displayName(target.uri)}${skipped}`,
    texts,
    undefined,
    target
  );
}

/**
 * Up to 3 known names within edit distance 2 (and under half the name's length), nearest first.
 *
 * @param data - The unknown name.
 * @param scope - The lookup scope.
 * @returns The names.
 */
function closeNames(data: UnknownNameData, scope: SymbolTable): string[] {
  const names = new Set<string>();
  /** Names of the `defexternal` declarations of one kind. */
  const externals = (kind: string) => [...scope.externals.values()].filter((e) => e.kind === kind).map((e) => e.name);
  if (data.kind === 'deftemplate') [...scope.templates.keys(), ...externals('deftemplate')].forEach((n) => names.add(n));
  if (data.kind === 'defclass') [...scope.classes.keys(), ...BUILTIN_CLASSES, ...externals('defclass')].forEach((n) => names.add(n));
  if (data.kind === 'defglobal') [...scope.globals.keys(), ...externals('defglobal')].forEach((n) => names.add(n));
  if (data.kind === 'function') [...scope.functionLike.keys(), ...scope.hostFunctions.keys(), ...BUILTIN_FUNCTIONS.keys()].forEach((n) => names.add(n));
  names.delete(data.name);

  const limit = Math.min(2, Math.ceil(data.name.length / 2) - 1);
  return [...names]
    .map((name) => ({ name, distance: editDistance(data.name, name, limit) }))
    .filter((c) => c.distance <= limit)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((c) => c.name);
}

/**
 * Levenshtein distance, stopping early once it exceeds `limit`.
 *
 * @param a - One string.
 * @param b - The other string.
 * @param limit - The largest distance of interest.
 * @returns The distance, or `limit + 1` if it is larger.
 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * `(defexternal <kind> <name>)`, or `(defudf <name>)` for a function.
 *
 * @param data - The unknown name.
 * @returns The declaration.
 */
function nameOnlyDeclaration(data: UnknownNameData): string {
  return data.kind === 'function' ? `(defudf ${data.name})` : `(defexternal ${data.kind} ${data.name})`;
}

/**
 * A template or class with the slots used in the workspace.
 *
 * @param data - The unknown name.
 * @param context - See {@link CodeActionContext}.
 * @returns The construct and a slot summary, or `null` if no slots are known.
 */
function fullDeclaration(data: UnknownNameData, context: CodeActionContext): { text: string; summary: string } | null {
  if (data.kind !== 'deftemplate' && data.kind !== 'defclass') return null;
  const slots = data.kind === 'deftemplate' ? templateSlotsInUse(data.name, context) : classSlotsInUse(data.name, context);
  if (slots.size === 0) return null;
  return { text: constructText(data.kind, data.name, slots), summary: slotSummary(slots) };
}

/**
 * A definition to insert into the .clp file: inferred slots, a function stub, or a global set to 0.
 *
 * @param data - The unknown name.
 * @param diagnostic - Its diagnostic, which locates the call for a function.
 * @param context - See {@link CodeActionContext}.
 * @returns The definition text, or `null`.
 */
function localDefinition(data: UnknownNameData, diagnostic: Diagnostic, context: CodeActionContext): string | null {
  switch (data.kind) {
    case 'deftemplate':
      return constructText('deftemplate', data.name, templateSlotsInUse(data.name, context));
    case 'defclass':
      return constructText('defclass', data.name, classSlotsInUse(data.name, context));
    case 'defglobal':
      return `(defglobal ${data.name} = 0)`;
    case 'function': {
      // One parameter per argument, or $?args if a multifield is passed.
      const call = context.tree.rootNode.descendantForPosition({ row: diagnostic.range.start.line, column: diagnostic.range.start.character })?.parent;
      const head = call?.type === 'function_call' ? call : call?.parent?.type === 'function_call' ? call.parent : null;
      const args = head ? head.namedChildren.slice(1).filter((n) => n.type !== 'comment_line') : [];
      const spread = args.some((a) => a.type === 'variable' && a.firstChild?.type === 'multifield_variable');
      const params = spread ? ['$?args'] : args.map((_, i) => `?arg${i + 1}`);
      return `(deffunction ${data.name} (${params.join(' ')}))`;
    }
  }
}

/** Slot name to multislot, in order of first use. */
type SlotUse = Map<string, boolean>;

/**
 * Records a slot use; once multi, always multi.
 *
 * @param slots - The collected slots.
 * @param name - The slot name.
 * @param multi - Whether this use holds several values.
 */
function addSlot(slots: SlotUse, name: string, multi: boolean): void {
  slots.set(name, (slots.get(name) ?? false) || multi);
}

/**
 * Whether a value is or contains a multifield variable or `$?`.
 *
 * @param node - A value node.
 */
function isMultifieldValue(node: SyntaxNode): boolean {
  return node.descendantsOfType(['multifield_variable', 'multifield_global_variable']).length > 0 || node.children.some((c) => c.type === '$?');
}

/**
 * Trees of the .clp documents.
 *
 * @param context - See {@link CodeActionContext}.
 * @returns The trees.
 */
function clpTrees(context: CodeActionContext): Tree[] {
  return context.documents.filter((d) => !isDeclarationFile(d.uri)).map((d) => d.tree);
}

/**
 * Slots a template is used with: LHS patterns, asserted and deffacts facts
 * (where an unknown template parses as an ordered fact, so call heads are
 * slots), and modify/duplicate. Used with `$?` or a value count other than
 * one means multislot.
 *
 * @param name - The template name.
 * @param context - See {@link CodeActionContext}.
 * @returns The slots, in order of first use.
 */
function templateSlotsInUse(name: string, context: CodeActionContext): SlotUse {
  const slots: SlotUse = new Map();
  for (const tree of clpTrees(context)) {
    for (const pattern of tree.rootNode.descendantsOfType(['template_pattern_CE', 'ordered_RHS_pattern', 'fact_action'])) {
      if (pattern.hasError) continue;
      if (pattern.type === 'fact_action') {
        const bound = factActionPatterns(pattern) ?? [];
        if (!bound.some((p) => headName(p) === name)) continue;
        for (const wrapper of pattern.children) {
          const slot = wrapper.type === 'RHS_slot' ? wrapper.firstChild : null;
          const slotName = slot?.children.find((c) => c.type === 'name' && c.isNamed);
          if (!slot || !slotName) continue;
          const values = slot.children.filter((c) => c.type === 'RHS_field');
          addSlot(slots, nameKey(slotName), values.length !== 1 || values.some(isMultifieldValue));
        }
        continue;
      }
      if (headName(pattern) !== name) continue;
      if (pattern.type === 'template_pattern_CE') {
        for (const wrapper of pattern.children) {
          const slot = wrapper.type === 'LHS_slot' ? wrapper.firstChild : null;
          const slotName = slot?.children.find((c) => c.type === 'name' && c.isNamed);
          if (!slot || !slotName) continue;
          const constraints = slot.children.filter((c) => c.type === 'constraint');
          addSlot(slots, nameKey(slotName), constraints.length !== 1 || constraints.some(isMultifieldValue));
        }
      } else {
        for (const field of pattern.children) {
          const call = field.type === 'RHS_field' && field.firstChild?.type !== '=' ? field.firstNamedChild : null;
          const head = call?.type === 'function_call' ? call.namedChildren[0] : null;
          if (!call || head?.type !== 'function_name') continue;
          const values = call.namedChildren.slice(1).filter((n) => n.type !== 'comment_line');
          addSlot(slots, head.text, values.length !== 1 || values.some(isMultifieldValue));
        }
      }
    }
  }
  return slots;
}

/**
 * Slots a class is used with, in `(is-a <class>)` patterns and instances created of it.
 *
 * @param name - The class name.
 * @param context - See {@link CodeActionContext}.
 * @returns The slots, in order of first use.
 */
function classSlotsInUse(name: string, context: CodeActionContext): SlotUse {
  const slots: SlotUse = new Map();
  for (const tree of clpTrees(context)) {
    for (const object of tree.rootNode.descendantsOfType('object_pattern_CE')) {
      if (object.hasError) continue;
      const attributes = object.children.filter((c) => c.type === 'attribute_constraint');
      const isA = attributes.find((a) => a.child(1)?.type === 'is-a');
      if (!isA || !isA.descendantsOfType('symbol').some((s) => s.text === name)) continue;
      for (const attribute of attributes) {
        const slotName = attribute.children.find((c) => c.type === 'name' && c.isNamed);
        if (!slotName || attribute.child(1)?.type === 'is-a') continue;
        const constraints = attribute.children.filter((c) => c.type === 'constraint');
        addSlot(slots, nameKey(slotName), constraints.length !== 1 || constraints.some(isMultifieldValue));
      }
    }
    for (const instance of tree.rootNode.descendantsOfType('instance_definition')) {
      if (instance.hasError || instanceDefinitionClass(instance)?.text !== name) continue;
      for (const override of instance.children.filter((c) => c.type === 'slot_override')) {
        const [slotName, ...values] = override.namedChildren.filter((n) => n.type !== 'comment_line');
        if (slotName) addSlot(slots, slotName.text, values.length !== 1 || values.some(isMultifieldValue));
      }
    }
  }
  return slots;
}

/**
 * The template name a pattern or query member uses.
 *
 * @param pattern - A pattern or `fact_set_member_template`.
 * @returns The name, or `null`.
 */
function headName(pattern: SyntaxNode): string | null {
  if (pattern.type === 'fact_set_member_template') return pattern.namedChildren[1]?.text ?? null;
  const head = pattern.children.find((c) => c.type === 'name' && c.isNamed);
  return head ? nameKey(head) : null;
}

/**
 * A deftemplate or defclass with the given slots.
 *
 * @param kind - The construct.
 * @param name - Its name.
 * @param slots - Its slots.
 * @returns The construct text.
 */
function constructText(kind: 'deftemplate' | 'defclass', name: string, slots: SlotUse): string {
  const lines = [...slots].map(([slot, multi]) => `   (${multi ? 'multislot' : 'slot'} ${slot})`);
  if (kind === 'defclass') lines.unshift('   (is-a USER)');
  return lines.length === 0 ? `(${kind} ${name})` : `(${kind} ${name}\n${lines.join('\n')})`;
}

/**
 * Slot names for a fix title, at most four.
 *
 * @param slots - The slots.
 * @returns The summary, e.g. `slots a, b`.
 */
function slotSummary(slots: SlotUse): string {
  const names = [...slots.keys()];
  const shown = names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')}, … ${names.length - 4} more`;
  return `slot${names.length === 1 ? '' : 's'} ${shown}`;
}

// The hand-written declaration file

/** The file declarations go into. */
interface DeclarationTarget {
  /** The file's URI. */
  uri: string;
  /** `null` if the file has to be created. */
  text: string | null;
  /** `null` if the file has to be created. */
  tree: Tree | null;
}

/**
 * The nearest hand-written .clpd file, else a new `externals.clpd` next to
 * the nearest dump or the document.
 *
 * @param context - See {@link CodeActionContext}.
 * @returns The target, or `null` if there is none and the client can't create files.
 */
function declarationTarget(context: CodeActionContext): DeclarationTarget | null {
  const hand = context.declarationFiles.find((f) => f.generated === null);
  if (hand) {
    const doc = context.documents.find((d) => uriKey(d.uri) === uriKey(hand.uri));
    if (doc) return { uri: hand.uri, text: doc.text, tree: doc.tree };
  }
  if (!context.canCreateFiles) return null;
  const near = context.declarationFiles[0]?.uri ?? context.uri;
  const path = uriToPath(near);
  if (path === null) return null;
  return { uri: pathToFileURL(join(dirname(path), HAND_WRITTEN_FILE)).href, text: null, tree: null };
}

/**
 * Sort key of a declaration: kind, then name.
 *
 * @param text - The declaration's text.
 * @returns The kind's rank and the unqualified name.
 */
function declarationOrder(text: string): [number, string] {
  const match = /^\(\s*(\S+)\s+(?:(deftemplate|defclass|defglobal)\s+)?(\S+)/.exec(text);
  const head = match?.[1] ?? '';
  const kind = head === 'defexternal' ? (match?.[2] ?? '') : head;
  const rank: Record<string, number> = { defmodule: 0, deftemplate: 1, defclass: 2, 'defmessage-handler': 3, defglobal: 4, deffunction: 5, defgeneric: 5, defmethod: 5, defudf: 5 };
  return [rank[kind] ?? 6, (match?.[3] ?? '').replace(/^MAIN::/, '')];
}

/**
 * Whether sort key `a` comes before `b`.
 *
 * @param a - A sort key.
 * @param b - Another sort key.
 */
function before(a: [number, string], b: [number, string]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1].localeCompare(b[1]) < 0;
}

/** Comment at the top of a new `externals.clpd`. */
const NEW_FILE_HEADER =
  '; Hand-written declarations for the CLIPS language server: names the program\n' +
  '; that embeds CLIPS defines and its generated dump (host.clpd, written by\n' +
  "; scripts/dump-host/dump.clp) doesn't cover. Nothing here is run. Edit freely.\n" +
  ';   (defexternal deftemplate <name>)  a template whose slots are unknown\n' +
  ';   (defexternal defclass <name>)     a class whose slots are unknown\n' +
  ';   (defexternal defglobal ?*<name>*) a global whose value is unknown\n' +
  ';   (defudf <name> ["<returns>" <min> <max> ["<argTypes>"]])  a host function\n' +
  ';   or any CLIPS construct, written out in full\n\n';

/**
 * Inserts declarations into the target file in sorted order.
 *
 * @param texts - The declarations.
 * @param target - The file, existing or to be created.
 * @returns The edit.
 */
function declarationEdit(texts: string[], target: DeclarationTarget): WorkspaceEdit {
  const sorted = [...texts].sort((a, b) => (before(declarationOrder(a), declarationOrder(b)) ? -1 : 1));
  if (target.text === null || !target.tree) {
    return {
      documentChanges: [
        CreateFile.create(target.uri, { ignoreIfExists: true }),
        TextDocumentEdit.create({ uri: target.uri, version: null }, [TextEdit.insert({ line: 0, character: 0 }, NEW_FILE_HEADER + sorted.join('\n') + '\n')])
      ]
    };
  }

  const forms = target.tree.rootNode.namedChildren
    .filter((n) => n.type !== 'comment_line')
    .map((n) => ({ node: n, order: declarationOrder(n.text) }));
  const end = endPosition(target.text);
  const byPosition = new Map<string, { at: Position; texts: string[] }>();
  for (const text of sorted) {
    const order = declarationOrder(text);
    const next = forms.find((f) => before(order, f.order));
    const at = next ? { line: next.node.startPosition.row, character: 0 } : end;
    const key = `${at.line}:${at.character}`;
    const group = byPosition.get(key) ?? { at, texts: [] };
    group.texts.push(text);
    byPosition.set(key, group);
  }
  const needsNewline = target.text.length > 0 && !target.text.endsWith('\n');
  const edits = [...byPosition.values()].map(({ at, texts: group }) =>
    TextEdit.insert(at, (at === end && needsNewline ? '\n' : '') + group.map((t) => `${t}\n`).join(''))
  );
  return { documentChanges: [TextDocumentEdit.create({ uri: target.uri, version: null }, edits)] };
}

/**
 * A quick fix that adds declarations to the target file.
 *
 * @param title - The fix title.
 * @param texts - The declarations.
 * @param diagnostic - The diagnostic it fixes, if one.
 * @param target - The declaration file.
 * @returns The code action.
 */
function declareAction(title: string, texts: string[], diagnostic: Diagnostic | undefined, target: DeclarationTarget): CodeAction {
  return {
    title,
    kind: CodeActionKind.QuickFix,
    ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
    edit: declarationEdit(texts, target)
  };
}

// Add slot / remove declaration

/**
 * Adds `(slot x)` to the template; not for templates from a generated dump.
 *
 * @param diagnostic - The unknown-slot diagnostic.
 * @param data - Its `data`.
 * @param context - See {@link CodeActionContext}.
 * @returns The fix, or `null`.
 */
function addSlotFix(diagnostic: Diagnostic, data: UnknownSlotData, context: CodeActionContext): CodeAction | null {
  const template = context.scope.templates.get(data.template);
  if (!template) return null;
  const owner = context.declarationFiles.find((f) => uriKey(f.uri) === uriKey(template.uri));
  if (owner && owner.generated !== null) return null;
  const close = template.definitionNode.lastChild;
  if (close?.type !== ')') return null;
  const at = { line: close.startPosition.row, character: close.startPosition.column };
  return {
    title: `Add slot "${data.slot}" to deftemplate "${data.template}" in ${displayName(template.uri)}`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: { documentChanges: [TextDocumentEdit.create({ uri: template.uri, version: null }, [TextEdit.insert(at, `\n   (slot ${data.slot})`)])] }
  };
}

/**
 * Deletes the declaration the hint points at.
 *
 * @param diagnostic - The hint.
 * @param context - See {@link CodeActionContext}.
 * @returns The fix, or `null` if no form is there.
 */
function removeDeclarationFix(diagnostic: Diagnostic, context: CodeActionContext): CodeAction | null {
  const form = topLevelFormAt(context.tree, diagnostic.range.start);
  if (!form) return null;
  const range: Range = { start: { line: form.startPosition.row, character: 0 }, end: { line: form.endPosition.row + 1, character: 0 } };
  return {
    title: 'Remove this declaration',
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    isPreferred: true,
    edit: { changes: { [context.uri]: [TextEdit.del(range)] } }
  };
}

// Helpers

/**
 * The top-level form at a position.
 *
 * @param tree - The document's tree.
 * @param position - The position.
 * @returns The form, or `null`.
 */
function topLevelFormAt(tree: Tree, position: Position): SyntaxNode | null {
  const point = { row: position.line, column: position.character };
  /** Whether `n` spans the point, ends included. */
  const inside = (n: SyntaxNode) =>
    (n.startPosition.row < point.row || (n.startPosition.row === point.row && n.startPosition.column <= point.column)) &&
    (n.endPosition.row > point.row || (n.endPosition.row === point.row && n.endPosition.column >= point.column));
  return tree.rootNode.namedChildren.find((n) => n.type !== 'comment_line' && inside(n)) ?? null;
}

/**
 * The text of a single-line range in the current document.
 *
 * @param context - See {@link CodeActionContext}.
 * @param range - The range.
 * @returns The text, or `null` if the range spans lines.
 */
function rangeText(context: CodeActionContext, range: Range): string | null {
  if (range.start.line !== range.end.line) return null;
  const doc = context.documents.find((d) => uriKey(d.uri) === uriKey(context.uri));
  const line = doc?.text.split('\n')[range.start.line];
  return line === undefined ? null : line.slice(range.start.character, range.end.character);
}

/**
 * The end position of a text.
 *
 * @param text - The text.
 * @returns The position after its last character.
 */
function endPosition(text: string): Position {
  const lines = text.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}
