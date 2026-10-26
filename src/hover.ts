/**
 * @file Hover: renders a {@link resolveTarget} result as Markdown.
 *
 * A construct's docstring is its quoted comment, else a `;` comment at the
 * end of its first line, else one right after its closing paren. `;;;`
 * blocks above a construct are not used.
 */

import type { SyntaxNode, Tree } from 'tree-sitter';
import { MarkupKind, type Hover, type Position } from 'vscode-languageserver/node.js';
import { CLIPS_VERSION, type BuiltinFunction } from './builtins.js';
import { BUILTIN_CLASS_PARENTS } from './classes.js';
import { isDeclarationFile, type ExternalName, type HostFunction } from './declarations.js';
import { bareVarName, findLocalReferences } from './locals.js';
import { toRange } from './lsp.js';
import { instanceSitesFor, orderedFactSites } from './sites.js';
import { enclosingLhsSlot, literalType, resolveRhsPatternSlot, resolveTemplateSlot } from './slots.js';
import { functionNameKey, nameKey, type SymbolEntry, type SymbolTable } from './symbolTable.js';
import { resolveTarget, type HoverTarget } from './targets.js';
import { displayName, uriKey } from './uri.js';

/**
 * Workspace context for a hover: the hovered document, the roots of all
 * documents (for usage counts), and the files of its program (`null` if no
 * load links it to anything).
 */
export interface HoverContext {
  /** The hovered document. */
  uri: string;
  /** Roots of all indexed documents, for usage counts. */
  roots: SyntaxNode[];
  /** All indexed documents, for finding instance creation sites. */
  documents?: { uri: string; tree: Tree }[];
  /** Files of the document's program, or null if no load links it to anything. */
  program?: { files: Set<string> } | null;
}

/** Most docstring lines shown. */
const DOC_MAX_LINES = 3;
/** Most docstring characters shown. */
const DOC_MAX_CHARS = 240;
/** Slots shown in a template or class synopsis. */
const MAX_SLOT_LINES = 12;

/**
 * The hover at a position.
 *
 * @param tree - The document's tree.
 * @param table - The lookup scope.
 * @param position - The position.
 * @param context - Workspace context; without it usage counts cover only the defining file.
 * @returns The hover, or `null`.
 */
export function provideHover(
  tree: Tree,
  table: SymbolTable,
  position: Position,
  context?: HoverContext
): Hover | null {
  const target = resolveTarget(tree, table, position);
  if (!target) return null;

  const value = render(target, table, context);
  if (!value) return null;

  return {
    contents: { kind: MarkupKind.Markdown, value },
    range: toRange(target.reference)
  };
}

/**
 * Renders a target; also used by completion resolve.
 *
 * @param target - The target.
 * @param table - The lookup scope.
 * @param context - Workspace context; without it usage counts cover only the defining file.
 * @returns The Markdown, or `null`.
 */
export function render(target: HoverTarget, table: SymbolTable, context?: HoverContext): string | null {
  switch (target.kind) {
    case 'construct':
      return renderConstructs(target.entries, table, context);
    case 'local':
      return renderLocal(target.bindings, table, target.reference);
    case 'slot':
      return renderSlot(target, context);
    case 'builtin':
      return renderBuiltin(target.name, target.entry);
    case 'hostFunction':
      return renderHostFunction(target.host);
    case 'external':
      return renderExternal(target.external);
    case 'orderedFact':
      return renderOrderedFact(target.name, target.reference, context);
    case 'module':
      return target.entry ? renderConstructs([target.entry], table, context) : renderMainModule();
    case 'classSlot':
      return renderClassSlot(target, context);
    case 'patternAttribute':
      return renderPatternAttribute(target.name);
    case 'builtinClass':
      return renderBuiltinClass(target.name);
    case 'systemHandler':
      return renderSystemHandler(target.name);
    case 'instanceName':
      return renderInstanceName(target.name, target.reference, context);
  }
}

// Ordered facts and modules

/**
 * Card for an ordered fact: what it is and how often it is asserted and used.
 *
 * @param name - The fact name.
 * @param reference - The hovered node.
 * @param context - Workspace context.
 * @returns The Markdown.
 */
function renderOrderedFact(name: string, reference: SyntaxNode, context?: HoverContext): string {
  const roots = context?.roots ?? [rootOf(reference)];
  const sites = roots.reduce((total, root) => total + orderedFactSites(name, root).length, 0);
  const rules = roots.reduce((total, root) => total + countReferencingRules(name, 'deftemplate_construct', root), 0);

  const usage = [
    sites > 0 ? `asserted at ${sites} site${sites === 1 ? '' : 's'}` : 'never asserted in the workspace',
    rules > 0 ? `used in ${rules} rule${rules === 1 ? '' : 's'}` : null
  ].filter((bit): bit is string => bit !== null);

  return [
    fence(`(${name} ...)`),
    `An ordered fact: there is no \`deftemplate ${name}\`, so CLIPS creates an implied one, a single multifield slot, the first time it is used.`,
    usage.join(' · '),
    italic('ordered fact')
  ].join('\n\n');
}

/**
 * Card for a class slot, noting when it is inherited.
 *
 * @param target - The `classSlot` target.
 * @param context - Workspace context.
 * @returns The Markdown.
 */
function renderClassSlot(target: Extract<HoverTarget, { kind: 'classSlot' }>, context?: HoverContext): string {
  const owner = target.slot.owner;
  const inherited = target.className !== owner.name ? ` · inherited by ${target.className}` : '';
  return [
    fence(collapse(target.slot.node.text)),
    italic(`slot of defclass ${owner.name}${inherited}${definedIn([owner], context)}`)
  ].join('\n\n');
}

/**
 * Card for `is-a` or `name` in an object pattern.
 *
 * @param name - The keyword.
 * @returns The Markdown.
 */
function renderPatternAttribute(name: 'is-a' | 'name'): string {
  const [syntax, text] =
    name === 'is-a'
      ? ['(is-a <class-name>+)', 'Restricts the object pattern to instances of these classes or their subclasses.']
      : ['(name <constraint>)', 'Matches the instance\'s name, e.g. `[gauge-1]`. A variable here, `(name ?x)`, binds it, so `?x` can be passed to `send`, `modify-instance` and the like.'];
  return [fence(syntax), text, italic('object pattern attribute · built into every instance, not a slot of its class')].join('\n\n');
}

/** Descriptions of some predefined classes. */
const BUILTIN_CLASS_TEXT: Record<string, string> = {
  OBJECT: 'The root of the class hierarchy.',
  USER: 'The superclass of user-defined classes. Only classes under USER can have instances, and it defines the system message handlers (`init`, `delete`, `print`, ...).',
  PRIMITIVE: 'The superclass of the classes of plain CLIPS values -- for method restrictions, not instances.'
};

/**
 * Card for a predefined class.
 *
 * @param name - The class.
 * @returns The Markdown.
 */
function renderBuiltinClass(name: string): string {
  const parents = BUILTIN_CLASS_PARENTS[name] ?? [];
  const text = BUILTIN_CLASS_TEXT[name] ?? `The class of CLIPS ${name} values, for method parameter restrictions and \`(type ...)\`-style checks.`;
  return [
    fence(parents.length > 0 ? `(defclass ${name} (is-a ${parents.join(' ')}))` : `(defclass ${name})`),
    text,
    italic('built-in class · abstract · predefined by CLIPS')
  ].join('\n\n');
}

/** System message handlers (BPG 9.4). */
const SYSTEM_HANDLER_TEXT: Record<string, string> = {
  init: 'Initializes a new instance\'s slots from their defaults and the slot overrides. Sent by `make-instance`.',
  delete: 'Deletes the instance. Sent by `unmake-instance`.',
  print: 'Prints the instance\'s slots.',
  create: 'Called right after an instance is created, before `init`. Does nothing by default; define an `after` handler to hook in.',
  'direct-modify': 'Changes slots directly, without `put-` messages. Used by `modify-instance`.',
  'message-modify': 'Changes slots through `put-` messages. Used by `message-modify-instance`.',
  'direct-duplicate': 'Copies the instance, setting slots directly. Used by `duplicate-instance`.',
  'message-duplicate': 'Copies the instance, setting slots through `put-` messages. Used by `message-duplicate-instance`.'
};

/**
 * Card for a system message handler.
 *
 * @param name - The handler.
 * @returns The Markdown.
 */
function renderSystemHandler(name: string): string {
  return [fence(`(send <instance> ${name})`), SYSTEM_HANDLER_TEXT[name] ?? '', italic('system message handler · defined on USER')]
    .filter((part) => part !== '')
    .join('\n\n');
}

/**
 * Card for an instance name: where it is created. A name created nowhere
 * may still exist at run time, so it isn't called undefined.
 *
 * @param name - The name without brackets.
 * @param reference - The hovered node.
 * @param context - Workspace context.
 * @returns The Markdown.
 */
function renderInstanceName(name: string, reference: SyntaxNode, context?: HoverContext): string {
  const uri = context?.uri ?? '';
  const documents = context?.documents ?? [{ uri, tree: { rootNode: rootOf(reference) } as Tree }];
  const sites = instanceSitesFor(name, uri, documents);
  if (sites.length === 0) {
    return [fence(`[${name}]`), italic('instance name · not created under this literal name anywhere in the workspace (it may be generated, computed or loaded at run time)')].join('\n\n');
  }
  const shown = sites.slice(0, 3).map(({ site }) =>
    site.className ? `([${name}] of ${site.className})` : `(duplicate-instance ${site.copyOf ?? '?'} to [${name}])`
  );
  const creators = [...new Set(sites.map(({ site }) => instanceCreator(site.nameNode)))];
  const files = [...new Set(sites.filter((s) => uriKey(s.uri) !== uriKey(uri)).map((s) => `\`${displayName(s.uri)}\``))];
  const more = sites.length > 3 ? ` · ${sites.length} places` : '';
  return [
    fence(shown.join('\n')),
    `Created by ${creators.join(', ')}.`,
    italic(`instance name${more}${files.length > 0 ? ` · defined in ${files.join(', ')}` : ''}`)
  ].join('\n\n');
}

/**
 * What creates the instance, e.g. `definstances circuit`.
 *
 * @param nameNode - The instance name where it is created.
 * @returns Markdown text.
 */
function instanceCreator(nameNode: SyntaxNode): string {
  const how = nameNode.parent?.type === 'instance_action' ? '`duplicate-instance`' : null;
  for (let a = nameNode.parent; a; a = a.parent) {
    if (!a.type.endsWith('_construct')) continue;
    const construct = a.type.replace(/_construct$/, '');
    const own = a.children.find((c) => c.type === 'name')?.text ?? '';
    if (construct === 'definstances') return `\`definstances ${own}\``;
    return `${how ?? '`make-instance`'} in ${construct} \`${own}\``;
  }
  return how ?? '`make-instance`';
}

/**
 * Card for `MAIN` without a `defmodule MAIN`.
 *
 * @returns The Markdown.
 */
function renderMainModule(): string {
  return [
    fence('(defmodule MAIN)'),
    'The default module, predefined by CLIPS: every construct not placed in another module belongs to `MAIN`. It exports nothing unless redefined with `(defmodule MAIN (export ...))`.',
    italic('built-in module')
  ].join('\n\n');
}

// Built-in functions

/**
 * Argument count, e.g. `"2"`, `"1 or more"`, `"2 to 3"`.
 *
 * @param entry - The function entry.
 * @returns The text, or `null` if unknown.
 */
function formatArity(entry: BuiltinFunction): string | null {
  if (!entry.min_args) return null;
  if (entry.min_args === entry.max_args) return entry.min_args;
  if (entry.max_args === 'UNBOUNDED') return `${entry.min_args} or more`;
  if (!entry.max_args) return `${entry.min_args} or more`;
  return `${entry.min_args} to ${entry.max_args}`;
}

/**
 * Argument types, e.g. `"numeric, numeric"` for `mod`.
 *
 * @param entry - The function entry.
 * @returns The text, or `null`.
 */
function formatArgTypes(entry: BuiltinFunction): string | null {
  const required = entry.arg_types ?? [];
  if (required.length === 0 && !entry.variadic_type) return null;
  const parts = [...required];
  if (entry.variadic_type) parts.push(`${entry.variadic_type}*`);
  return parts.join(', ');
}

/**
 * Card for a built-in function.
 *
 * @param name - The function.
 * @param entry - Its entry.
 * @returns The Markdown.
 */
export function renderBuiltin(name: string, entry: BuiltinFunction): string {
  const version = CLIPS_VERSION ? `CLIPS ${CLIPS_VERSION}` : 'CLIPS';
  const provenance =
    entry.section && entry.title
      ? `built-in function · ${version} · Basic Programming Guide §${entry.section} — ${entry.title}${entry.page ? `, p. ${entry.page}` : ''}`
      : `built-in function · ${version}${entry.source_file ? ` · ${entry.source_file}` : ''}`;
  return renderFunctionCard(entry, provenance);
}

/**
 * Card for a host function, with the dump's date so an old dump is noticed.
 *
 * @param host - The host function.
 * @returns The Markdown.
 */
export function renderHostFunction(host: HostFunction): string {
  const generated = host.generated === null ? '' : ` · generated by dump.clp${host.generated ? ` on ${host.generated}` : ''}`;
  return renderFunctionCard(host.signature, `host function · declared in ${displayName(host.uri)}${generated}`);
}

/**
 * The card for a name declared by `(defexternal <kind> <name>)`: it exists
 * (the host program defines it), and nothing more is known.
 *
 * @param external - The declaration.
 * @returns The Markdown.
 */
export function renderExternal(external: ExternalName): string {
  const unknown =
    external.kind === 'defglobal'
      ? 'its value is unknown'
      : `its ${external.kind === 'deftemplate' ? 'slots are' : 'superclasses and slots are'} unknown, so they aren't checked`;
  const what = { deftemplate: 'deftemplate', defclass: 'defclass', defglobal: 'defglobal' }[external.kind];
  return [
    fence(`(defexternal ${external.kind} ${external.name})`),
    `A ${what} the program that embeds CLIPS defines, declared by name only: ${unknown}. Write the full construct in the declaration file to have it checked.`,
    italic(`declared in ${displayName(external.uri)}`)
  ].join('\n\n');
}

/**
 * A function card: syntax, description, arguments, return types, source.
 *
 * @param entry - A built-in or host function entry.
 * @param provenance - The source line, e.g. `built-in function`.
 * @returns The Markdown.
 */
function renderFunctionCard(entry: BuiltinFunction, provenance: string): string {
  const parts: string[] = [];
  if (entry.syntax) parts.push(fence(entry.syntax));

  const arity = formatArity(entry);
  const argTypes = formatArgTypes(entry);
  const returns = entry.return_types && entry.return_types.length > 0 ? entry.return_types.join(' | ') : null;
  const meta = [
    arity ? `Arguments: ${arity}${argTypes ? ` (${argTypes})` : ''}` : null,
    returns ? `Returns: ${returns}` : null
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  parts.push(meta ? `${entry.description}\n\n${meta}` : entry.description);
  parts.push(italic(provenance));

  return parts.join('\n\n');
}

// Constructs

/**
 * Card for constructs sharing a name (one construct, or a generic with its methods).
 *
 * @param entries - The entries.
 * @param table - The lookup scope.
 * @param context - Workspace context.
 * @returns The Markdown, or `null`.
 */
function renderConstructs(
  entries: SymbolEntry[],
  table: SymbolTable,
  context?: HoverContext
): string | null {
  const lines = entries.map(synopsis).filter((l): l is string => l !== null);
  if (lines.length === 0) return null;

  const parts = [fence(lines.join('\n'))];

  const doc = firstDoc(entries);
  if (doc) parts.push(doc);

  const roots = context?.roots ?? [rootOf(entries[0].definitionNode)];
  const backlinks = dependencyLine(entries, table, roots);
  if (backlinks) parts.push(backlinks);

  parts.push(italic(provenance(entries) + definedIn(entries, context)));
  return parts.join('\n\n');
}

/**
 * Names the defining file when it isn't the hovered one.
 *
 * @param entries - The entries.
 * @param context - Workspace context.
 * @returns e.g. `` · defined in `templates.clp` ``, or `''`.
 */
function definedIn(entries: SymbolEntry[], context?: HoverContext): string {
  if (!context) return '';
  const here = uriKey(context.uri);
  const elsewhere = entries.filter((e) => uriKey(e.uri) !== here);
  // Host declarations aren't loaded, so the load notes don't apply to them.
  const declared = [...new Set(elsewhere.filter((e) => isDeclarationFile(e.uri)).map((e) => `\`${displayName(e.uri)}\``))];
  const others = elsewhere.filter((e) => !isDeclarationFile(e.uri));
  const files = [...new Set(others.map((e) => displayName(e.uri)))];
  if (files.length === 0) return declared.length > 0 ? ` · declared by the host program in ${declared.join(', ')}` : '';

  const list = files.map((f) => `\`${f}\``).join(', ');
  // Found in the workspace, but nothing says the files run together.
  const program = context.program;
  if (program === undefined) return ` · defined in ${list}`;
  if (program === null) return ` · defined in ${list} · not linked to this file by any (load ...)`;
  const outside = others.some((e) => !program.files.has(uriKey(e.uri)));
  return outside ? ` · defined in ${list} · not loaded by this file's program` : ` · defined in ${list}`;
}

/**
 * Usage line: what a rule matches, call counts of a function, or how many
 * rules, subclasses, methods or reads refer to a construct.
 *
 * @param entries - The entries.
 * @param table - The lookup scope.
 * @param roots - Roots of the documents to count in.
 * @returns The line, or `null`.
 */
function dependencyLine(entries: SymbolEntry[], table: SymbolTable, roots: SyntaxNode[]): string | null {
  const node = entries[0].definitionNode;
  const name = entries[0].name;
  /** Adds up a count over all roots. */
  const sum = (count: (root: SyntaxNode) => number): number =>
    roots.reduce((total, root) => total + count(root), 0);

  const FUNCTION_LIKE = new Set([
    'deffunction_construct',
    'defgeneric_construct',
    'defmethod_construct'
  ]);
  if (entries.every((e) => FUNCTION_LIKE.has(e.definitionNode.type))) {
    const calls = sum(
      (root) =>
        root
          .descendantsOfType('function_name')
          // A slot of an asserted template fact with the same name isn't a call.
          .filter((fn) => functionNameKey(fn) === name && !(fn.parent && resolveRhsPatternSlot(fn.parent, table))).length
    );
    if (calls > 0) return `called by ${calls} site${calls === 1 ? '' : 's'}`;
    return entries.some((e) => e.definitionNode.type === 'deffunction_construct')
      ? 'no call sites in the workspace'
      : null;
  }

  if (entries.length !== 1) return null;

  if (node.type === 'defrule_construct') {
    const refs = lhsPatternNames(node);
    return refs.length > 0 ? `matches: ${refs.map((r) => `\`${r}\``).join(', ')}` : null;
  }

  if (node.type === 'deftemplate_construct') {
    const bits: string[] = [];
    const rules = sum((root) => countReferencingRules(name, node.type, root));
    if (rules > 0) bits.push(`${rules} rule${rules === 1 ? '' : 's'}`);
    const deffacts = sum((root) => countReferencingDeffacts(name, root));
    if (deffacts > 0) bits.push(`${deffacts} deffacts`);
    return bits.length > 0 ? `used in ${bits.join(' · ')}` : null;
  }

  if (node.type === 'defclass_construct') {
    const bits: string[] = [];
    const subs = countSubclasses(name, table);
    if (subs > 0) bits.push(`${subs} subclass${subs === 1 ? '' : 'es'}`);
    const rules = sum((root) => countReferencingRules(name, node.type, root));
    if (rules > 0) bits.push(`${rules} rule${rules === 1 ? '' : 's'}`);
    const methods = sum((root) => countRestrictingMethods(name, root));
    if (methods > 0) bits.push(`${methods} method${methods === 1 ? '' : 's'}`);
    return bits.length > 0 ? `referenced by ${bits.join(' · ')}` : null;
  }

  if (node.type === 'defglobal_construct') {
    let reads = 0;
    let rebinds = 0;
    for (const root of roots) {
      const usage = globalUsage(name, root);
      reads += usage.reads;
      rebinds += usage.rebinds;
    }
    const bits = [reads === 1 ? '1 read' : `${reads} reads`];
    if (rebinds > 0) bits.push(`${rebinds} rebind${rebinds === 1 ? '' : 's'}`);
    return bits.join(' · ');
  }

  return null;
}

/**
 * Reads and `bind`s of a global; its own defglobal counts as neither.
 *
 * @param name - The global, `?*name*`.
 * @param root - A document's root.
 * @returns The counts.
 */
function globalUsage(name: string, root: SyntaxNode): { reads: number; rebinds: number } {
  let reads = 0;
  let rebinds = 0;
  for (const gv of root.descendantsOfType('global_variable')) {
    if (gv.text !== name) continue;
    if (gv.parent?.type === 'global_assignment') continue;

    const variable = gv.parent;
    const call = variable?.parent;
    if (call?.type === 'function_call') {
      const kids = call.namedChildren;
      if (kids[0]?.type === 'function_name' && kids[0].text === 'bind' && kids[1]?.id === variable?.id) {
        rebinds++;
        continue;
      }
    }
    reads++;
  }
  return { reads, rebinds };
}

/** Nodes whose first `name` is a fact or template name. */
const FACT_HEAD_TYPES = [
  'template_pattern_CE',
  'ordered_pattern_CE',
  'template_RHS_pattern',
  'ordered_RHS_pattern',
  'fact_set_member_template'
];

/**
 * Templates, ordered facts and `is-a` classes a rule's LHS matches.
 *
 * @param defruleNode - The rule.
 * @returns The names in document order.
 */
function lhsPatternNames(defruleNode: SyntaxNode): string[] {
  const body = defruleNode.children.find((c) => c.type === 'defrule_body');
  if (!body) return [];

  const names = new Set<string>();
  for (const pattern of body.descendantsOfType(['template_pattern_CE', 'ordered_pattern_CE'])) {
    const nameNode = pattern.children.find((c) => c.type === 'name');
    if (nameNode) names.add(nameKey(nameNode));
  }
  for (const object of body.descendantsOfType('object_pattern_CE')) {
    for (const attr of object.descendantsOfType('attribute_constraint')) {
      if (!/^\(\s*is-a\b/.test(attr.text)) continue;
      for (const sym of attr.descendantsOfType('symbol')) names.add(sym.text);
    }
  }
  return [...names];
}

/**
 * Whether a fact head names `name`.
 *
 * @param node - A pattern or fact node.
 * @param name - The unqualified name.
 */
function factHeadMatches(node: SyntaxNode, name: string): boolean {
  const nameNode = node.children.find((c) => c.type === 'name');
  return nameNode !== undefined && nameKey(nameNode) === name;
}

/**
 * Rules that use a template (in a fact pattern) or a class (in `is-a`).
 *
 * @param name - The construct name.
 * @param kind - `deftemplate_construct` or `defclass_construct`.
 * @param root - A document's root.
 * @returns The number of rules.
 */
function countReferencingRules(name: string, kind: string, root: SyntaxNode): number {
  const ruleIds = new Set<number>();

  /** Counts the rule that contains `ref`, if any. */
  const record = (ref: SyntaxNode) => {
    for (let a = ref.parent; a; a = a.parent) {
      if (a.type === 'defrule_construct') {
        ruleIds.add(a.id);
        return;
      }
    }
  };

  if (kind === 'defclass_construct') {
    for (const object of root.descendantsOfType('object_pattern_CE')) {
      for (const attr of object.descendantsOfType('attribute_constraint')) {
        if (/^\(\s*is-a\b/.test(attr.text) && attr.descendantsOfType('symbol').some((s) => s.text === name)) {
          record(object);
          break;
        }
      }
    }
  } else {
    for (const ref of root.descendantsOfType(FACT_HEAD_TYPES)) {
      if (factHeadMatches(ref, name)) record(ref);
    }
  }
  return ruleIds.size;
}

/**
 * deffacts blocks with a fact of the template.
 *
 * @param name - The template.
 * @param root - A document's root.
 * @returns The number of blocks.
 */
function countReferencingDeffacts(name: string, root: SyntaxNode): number {
  const ids = new Set<number>();
  for (const ref of root.descendantsOfType(['template_RHS_pattern', 'ordered_RHS_pattern'])) {
    if (!factHeadMatches(ref, name)) continue;
    for (let a = ref.parent; a; a = a.parent) {
      if (a.type === 'deffacts_construct') {
        ids.add(a.id);
        break;
      }
    }
  }
  return ids.size;
}

/**
 * Direct subclasses of a class.
 *
 * @param className - The class.
 * @param table - The lookup scope.
 * @returns The number of subclasses.
 */
function countSubclasses(className: string, table: SymbolTable): number {
  let count = 0;
  for (const entry of table.classes.values()) {
    if (entry.name === className) continue;
    const node = entry.definitionNode;
    let seenIsA = false;
    for (const child of node.children) {
      if (!seenIsA) {
        if (child.type === 'is-a') seenIsA = true;
        continue;
      }
      if (child.type === ')') break;
      if (child.type === 'name' && nameKey(child) === className) {
        count++;
        break;
      }
    }
  }
  return count;
}

/**
 * Methods with a parameter restricted to the class.
 *
 * @param className - The class.
 * @param root - A document's root.
 * @returns The number of methods.
 */
function countRestrictingMethods(className: string, root: SyntaxNode): number {
  const ids = new Set<number>();
  for (const restriction of root.descendantsOfType([
    'parameter_restriction',
    'wildcard_parameter_restriction'
  ])) {
    if (!restriction.descendantsOfType('name').some((n) => nameKey(n) === className)) continue;
    for (let a = restriction.parent; a; a = a.parent) {
      if (a.type === 'defmethod_construct') {
        ids.add(a.id);
        break;
      }
    }
  }
  return ids.size;
}

/**
 * The root of a node's tree.
 *
 * @param node - Any node.
 * @returns The root node.
 */
function rootOf(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

/**
 * A construct's signature line; templates and classes also list slots.
 *
 * @param entry - The entry.
 * @returns The synopsis.
 */
function synopsis(entry: SymbolEntry): string | null {
  const d = entry.definitionNode;
  const name = entry.name;

  switch (d.type) {
    case 'deftemplate_construct':
      return `(deftemplate ${name})` + slotList(d, 'slot_definition');
    case 'deffunction_construct':
      return `(deffunction ${name} (${parameterText(d)}))`;
    case 'defgeneric_construct':
      return `(defgeneric ${name})`;
    case 'defmethod_construct':
      return `(defmethod ${name}${methodIndex(d)} (${restrictionText(d)}))`;
    case 'defclass_construct':
      return `(defclass ${name} (is-a ${superclassText(d)}))` + slotList(d, 'slot');
    case 'defglobal_construct':
      return collapse(entry.nameNode.parent?.text ?? entry.nameNode.text);
    case 'defrule_construct':
      return `(defrule ${name})`;
    case 'defmodule_construct':
      return `(defmodule ${name})`;
    case 'deffacts_construct':
      return `(deffacts ${name})`;
    case 'definstances_construct':
      return `(definstances ${name})`;
    case 'defmessage_handler_construct':
      return `(defmessage-handler ${messageHandlerText(d)})`;
    default:
      return name;
  }
}

/**
 * Slot lines for a synopsis, at most {@link MAX_SLOT_LINES}.
 *
 * @param construct - The template or class.
 * @param slotChildType - `slot_definition` for templates, `slot` for classes.
 * @returns The lines with a leading newline, or `''`.
 */
function slotList(construct: SyntaxNode, slotChildType: 'slot_definition' | 'slot'): string {
  const lines: string[] = [];
  for (const child of construct.children) {
    if (child.type !== slotChildType) continue;
    // Template slots are wrapped in slot_definition. Class slots are all
    // `slot` nodes; only the keyword tells slot from multislot.
    const inner = slotChildType === 'slot_definition' ? child.firstChild : child;
    if (!inner) continue;
    const keyword = inner.type === 'multislot_definition' || /^\(\s*multislot\b/.test(inner.text)
      ? 'multislot'
      : 'slot';
    const nameChild = inner.children.find((c) => c.type === 'name');
    if (!nameChild) continue;
    const badge = slotBadge(inner);
    lines.push(`  (${keyword} ${nameKey(nameChild)})${badge ? ` · ${badge}` : ''}`);
  }
  if (lines.length === 0) return '';
  if (lines.length > MAX_SLOT_LINES) {
    lines.splice(MAX_SLOT_LINES, lines.length, `  … ${lines.length - MAX_SLOT_LINES} more`);
  }
  return '\n' + lines.join('\n');
}

/**
 * A short constraint summary for a slot line, e.g. `auto|manual` or
 * `FLOAT 6.0–7.99`.
 *
 * @param slotDefinition - A slot definition.
 * @returns The summary, or `null`.
 */
function slotBadge(slotDefinition: SyntaxNode): string | null {
  const parts: string[] = [];

  const typeAttr = slotDefinition.descendantsOfType('type_attribute')[0];
  const types = typeAttr
    ? (typeAttr.namedChildren.find((c) => c.type === 'type_specification')?.namedChildren ?? [])
        .filter((c) => c.type === 'allowed_type')
        .map((c) => c.text)
    : [];

  const allowedAttr = slotDefinition.descendantsOfType('allowed_constant_attribute')[0];
  const list = allowedAttr?.namedChildren.find((c) => c.type.endsWith('_list'));
  const allowed = (list?.namedChildren ?? [])
    .map((c) => collapse(c.text))
    .filter((t) => t.length > 0 && t !== '?VARIABLE');

  if (allowed.length > 0) {
    parts.push(allowed.length > 4 ? `${allowed.slice(0, 4).join('|')}|…` : allowed.join('|'));
  } else if (types.length > 0) {
    parts.push(types.join('/'));
  }

  const rangeAttr = slotDefinition.descendantsOfType('range_attribute')[0];
  const bounds = rangeAttr
    ? rangeAttr.namedChildren.filter((c) => c.type === 'range_specification').map((c) => c.text)
    : [];
  if (bounds.length === 2) parts.push(`${bounds[0]}–${bounds[1]}`);

  const cardAttr = slotDefinition.descendantsOfType('cardinality_attribute')[0];
  const card = cardAttr
    ? cardAttr.namedChildren.filter((c) => c.type === 'cardinality_specification').map((c) => c.text)
    : [];
  if (card.length === 2) parts.push(`[${card[0]}..${card[1]}]`);

  const defAttr = slotDefinition.descendantsOfType('default_attribute')[0];
  const defValue = defAttr?.namedChildren.map((c) => collapse(c.text)).join(' ');
  if (defValue) parts.push(`= ${defValue}`);

  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * A deffunction's parameters, e.g. `?question $?commands`.
 *
 * @param deffunctionNode - The deffunction.
 * @returns The parameter list.
 */
function parameterText(deffunctionNode: SyntaxNode): string {
  return deffunctionNode.children
    .filter((c) => c.type === 'regular_parameter' || c.type === 'wildcard_parameter')
    .map((c) => collapse(c.text))
    .join(' ');
}

/**
 * A defmethod's parameters, e.g. `(?x INTEGER) $?rest`.
 *
 * @param defmethodNode - The defmethod.
 * @returns The parameter list.
 */
function restrictionText(defmethodNode: SyntaxNode): string {
  return defmethodNode.children
    .filter(
      (c) => c.type === 'parameter_restriction' || c.type === 'wildcard_parameter_restriction'
    )
    .map((c) => collapse(c.text))
    .join(' ');
}

/**
 * A defmethod's index.
 *
 * @param defmethodNode - The defmethod.
 * @returns ` <index>`, or `''`.
 */
function methodIndex(defmethodNode: SyntaxNode): string {
  // ( defmethod name [index] ...
  const third = defmethodNode.children[3];
  return third?.type === 'integer' ? ` ${third.text}` : '';
}

/**
 * A defclass's superclasses.
 *
 * @param defclassNode - The defclass.
 * @returns The names, or `USER` if none.
 */
function superclassText(defclassNode: SyntaxNode): string {
  const names: string[] = [];
  let seenIsA = false;
  for (const child of defclassNode.children) {
    if (!seenIsA) {
      if (child.type === 'is-a') seenIsA = true;
      continue;
    }
    if (child.type === ')') break;
    if (child.type === 'name') names.push(nameKey(child));
  }
  return names.join(' ') || 'USER';
}

/**
 * A handler's `Class handler [type]`.
 *
 * @param handlerNode - The handler.
 * @returns The text.
 */
function messageHandlerText(handlerNode: SyntaxNode): string {
  const names = handlerNode.children.filter((c) => c.type === 'name');
  const type = handlerNode.children.find((c) => c.type === 'handler_type');
  const cls = names[0] ? nameKey(names[0]) : '?';
  const handler = names[1] ? nameKey(names[1]) : '?';
  return `${cls} ${handler}${type ? ' ' + type.text : ''}`;
}

/**
 * The info line of a construct card.
 *
 * @param entries - The entries.
 * @returns e.g. `deftemplate` or `defgeneric · 3 methods`.
 */
function provenance(entries: SymbolEntry[]): string {
  const kinds = entries.map((e) => e.definitionNode.type.replace(/_construct$/, ''));
  const methods = kinds.filter((k) => k === 'defmethod').length;
  if (kinds.includes('defgeneric') || methods > 0) {
    const head = kinds.includes('defgeneric') ? 'defgeneric' : 'defmethod';
    return methods > 0 ? `${head} · ${methods} method${methods === 1 ? '' : 's'}` : head;
  }

  const node = entries[0].definitionNode;

  if (node.type === 'defrule_construct') {
    const salience = ruleSalience(node);
    return salience !== null ? `defrule · salience ${salience}` : 'defrule';
  }

  if (node.type === 'defglobal_construct') {
    const value = entries[0].nameNode.parent?.namedChildren[1];
    const type = value ? literalType(value) : null;
    return type ? `defglobal · ${type}` : 'defglobal';
  }

  return kinds[0] ?? '';
}

/**
 * A rule's salience.
 *
 * @param defruleNode - The rule.
 * @returns The salience expression, or `null`.
 */
function ruleSalience(defruleNode: SyntaxNode): string | null {
  const body = defruleNode.children.find((c) => c.type === 'defrule_body');
  const declaration = body?.children.find((c) => c.type === 'declaration');
  if (!declaration) return null;
  for (const property of declaration.children) {
    if (property.type !== 'rule_property') continue;
    if (!/^\(\s*salience\b/.test(property.text)) continue;
    const expr = property.namedChildren[0];
    return expr ? collapse(expr.text) : null;
  }
  return null;
}


// Local variables

/**
 * Card for a local variable: its slot type if pattern-bound, joins with
 * other patterns, binding kind, scope and read count.
 *
 * @param bindings - The binding sites.
 * @param table - The lookup scope.
 * @param reference - The hovered occurrence; for `?x-index`, `bindings` holds `?x`.
 * @returns The Markdown.
 */
function renderLocal(bindings: SyntaxNode[], table: SymbolTable, reference?: SyntaxNode): string {
  const primary = bindings[0];
  if (reference && bareVarName(reference.text) !== bareVarName(primary.text)) {
    return renderLoopIndex(reference, primary);
  }
  const name = /^\$\?|^\?/.test(primary.text) ? primary.text : `?${primary.text}`;

  const lines = [fence(name)];

  const slot = enclosingLhsSlot(primary);
  const slotContext = slot ? resolveTemplateSlot(slot, table) : null;
  const typeSummary = slotContext?.slotDefinition
    ? slotTypeSummary(slotContext.slotDefinition)
    : null;
  if (typeSummary && slotContext) {
    lines.push(`${typeSummary} · from ${slotContext.owner.name}.${slotContext.slotName}`);
  }

  // Bound in several patterns: a join, not a rebind.
  const joinLine = joinConstraint(bindings, primary, table);
  if (joinLine) lines.push(joinLine);

  const kind = classifyBinding(primary) + (isMultifieldBinding(primary) ? ' (multifield)' : '');
  const scope = scopeOf(primary);
  const readNodes = findLocalReferences(primary);
  const footer = [kind];
  if (scope) footer.push(scope);
  if (readNodes.length === 0) {
    footer.push('0 reads');
  } else {
    footer.push(readNodes.length === 1 ? '1 read' : `${readNodes.length} reads`);
    footer.push(`first at line ${earliest(readNodes).startPosition.row + 1}`);
  }
  lines.push(italic(footer.join(' · ')));

  return lines.join('\n\n');
}

/**
 * Card for the implicit `?x-index` of `progn$`/`foreach`.
 *
 * @param reference - The `?x-index` occurrence.
 * @param loopVariable - The loop's `?x`.
 * @returns The Markdown.
 */
function renderLoopIndex(reference: SyntaxNode, loopVariable: SyntaxNode): string {
  const loop = classifyBinding(loopVariable).startsWith('progn$') ? 'progn$' : 'foreach';
  const name = reference.text.startsWith('?') ? reference.text : `?${reference.text}`;
  return [
    fence(name),
    `INTEGER · the 1-based position of the current \`${loopVariable.text}\` in the list`,
    italic(`implicit index of the ${loop} loop variable ${loopVariable.text} · line ${loopVariable.startPosition.row + 1}`)
  ].join('\n\n');
}

/**
 * The earliest node of a non-empty list.
 *
 * @param nodes - The nodes.
 * @returns The one that starts first.
 */
function earliest(nodes: SyntaxNode[]): SyntaxNode {
  return nodes.reduce((best, node) => {
    if (node.startPosition.row !== best.startPosition.row) {
      return node.startPosition.row < best.startPosition.row ? node : best;
    }
    return node.startPosition.column < best.startPosition.column ? node : best;
  });
}

/**
 * Whether a binding holds a multifield value.
 *
 * @param binding - The binding occurrence.
 */
function isMultifieldBinding(binding: SyntaxNode): boolean {
  return (
    binding.type === 'multifield_variable' ||
    binding.type === 'wildcard_parameter' ||
    binding.text.startsWith('$?')
  );
}

/** Allowed values shown on a variable's type line. */
const MAX_ALLOWED_VALUES = 8;

/**
 * A slot's type, allowed values and range for a variable's card.
 *
 * @param slotDefinition - The slot definition.
 * @returns e.g. `type SYMBOL · one of: no yes`, or `null`.
 */
function slotTypeSummary(slotDefinition: SyntaxNode): string | null {
  const parts: string[] = [];

  const typeAttr = slotDefinition.descendantsOfType('type_attribute')[0];
  if (typeAttr) {
    const spec = typeAttr.namedChildren.find((c) => c.type === 'type_specification');
    if (spec && spec.text !== '?VARIABLE') {
      const types = spec.namedChildren
        .filter((c) => c.type === 'allowed_type')
        .map((c) => c.text);
      if (types.length > 0) parts.push(`type ${types.join('/')}`);
    }
  }

  const allowedAttr = slotDefinition.descendantsOfType('allowed_constant_attribute')[0];
  if (allowedAttr) {
    const list = allowedAttr.namedChildren.find((c) => c.type.endsWith('_list'));
    const values = (list?.namedChildren ?? [])
      .map((c) => collapse(c.text))
      .filter((t) => t.length > 0 && t !== '?VARIABLE');
    if (values.length > 0) {
      const shown =
        values.length > MAX_ALLOWED_VALUES
          ? `${values.slice(0, MAX_ALLOWED_VALUES).join(' ')} … (${values.length})`
          : values.join(' ');
      parts.push(`one of: ${shown}`);
    }
  }

  const rangeAttr = slotDefinition.descendantsOfType('range_attribute')[0];
  if (rangeAttr) {
    const bounds = rangeAttr.namedChildren
      .filter((c) => c.type === 'range_specification')
      .map((c) => c.text);
    if (bounds.length === 2) parts.push(`range ${bounds[0]}–${bounds[1]}`);
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The other slots a variable is bound in, as `template.slot`.
 *
 * @param bindings - The binding sites.
 * @param primary - The binding being shown.
 * @param table - The lookup scope.
 * @returns e.g. `` also constrains `cheese2.name` ``, or `null`.
 */
function joinConstraint(
  bindings: SyntaxNode[],
  primary: SyntaxNode,
  table: SymbolTable
): string | null {
  if (bindings.length < 2) return null;

  /** `template.slot` of the LHS slot around `node`, or the bare slot name. */
  const locate = (node: SyntaxNode): string | null => {
    const slot = enclosingLhsSlot(node);
    if (!slot) return null;
    const context = resolveTemplateSlot(slot, table);
    if (context) return `${context.owner.name}.${context.slotName}`;
    const slotNameNode = slot.children.find((c) => c.type === 'name');
    return slotNameNode ? nameKey(slotNameNode) : null;
  };

  const here = locate(primary);
  const others = [
    ...new Set(
      bindings
        .filter((b) => b.id !== primary.id)
        .map(locate)
        .filter((loc): loc is string => loc !== null && loc !== here)
    )
  ];

  if (others.length === 0) return null;
  return `also constrains ${others.map((o) => `\`${o}\``).join(', ')}`;
}

/**
 * How a variable is bound, as a label.
 *
 * @param binding - A binding site.
 * @returns e.g. `parameter` or `pattern-bound`.
 */
function classifyBinding(binding: SyntaxNode): string {
  switch (binding.type) {
    case 'regular_parameter':
    case 'wildcard_parameter':
    case 'parameter':
      return 'parameter';
    case 'global_variable':
      return 'global variable';
  }

  const parent = binding.parent;
  switch (parent?.type) {
    case 'assigned_pattern_CE':
      return 'fact-address binding';
    case 'parameter_restriction':
    case 'wildcard_parameter_restriction':
      return 'parameter';
    case 'progn_dollar_binding':
      return 'progn$ iteration variable';
    case 'loop_for_count_binding':
      return 'loop-for-count counter';
    case 'fact_set_member_template':
    case 'instance_set_member_template':
      return 'query variable';
  }

  if (parent?.type === 'variable' && parent.parent?.type === 'function_call') {
    const fn = parent.parent.children.find((c) => c.type === 'function_name');
    if (fn?.text === 'bind') return 'bound by `bind`';
    if (fn?.text === 'foreach') return 'foreach iteration variable';
  }

  if (isInLhsPattern(binding)) return 'pattern-bound';
  return 'local variable';
}

/** Ancestors that put a variable inside an LHS pattern. */
const LHS_PATTERN_TYPES = new Set([
  'single_field_LHS_slot',
  'multifield_LHS_slot',
  'ordered_pattern_CE',
  'template_pattern_CE',
  'object_pattern_CE'
]);
/** Ancestors where that search stops. */
const LHS_SEARCH_STOP_TYPES = new Set(['defrule_body', 'action', 'deffunction_construct']);

/**
 * Whether a node is inside an LHS pattern.
 *
 * @param node - The node.
 * @returns `true` if so.
 */
function isInLhsPattern(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (LHS_PATTERN_TYPES.has(current.type)) return true;
    if (LHS_SEARCH_STOP_TYPES.has(current.type)) return false;
    current = current.parent;
  }
  return false;
}

/**
 * The construct a binding is in.
 *
 * @param node - The binding.
 * @returns e.g. `deffunction ask-question`, or `null`.
 */
function scopeOf(node: SyntaxNode): string | null {
  let current = node.parent;
  while (current) {
    switch (current.type) {
      case 'deffunction_construct':
        return `deffunction ${constructName(current)}`;
      case 'defmethod_construct':
        return `defmethod ${constructName(current)}`;
      case 'defmessage_handler_construct':
        return `defmessage-handler ${constructName(current)}`;
      case 'defrule_construct':
        return `defrule ${constructName(current)}`;
    }
    current = current.parent;
  }
  return null;
}

/**
 * A construct's name.
 *
 * @param construct - A construct node.
 * @returns The name, or `?`.
 */
function constructName(construct: SyntaxNode): string {
  const nameChild = construct.children.find((c) => c.type === 'name');
  return nameChild ? nameKey(nameChild) : '?';
}

// Slots

/**
 * Card for a template slot.
 *
 * @param target - The `slot` target.
 * @param context - Workspace context, for where the template is defined.
 * @returns The Markdown.
 */
function renderSlot(target: Extract<HoverTarget, { kind: 'slot' }>, context?: HoverContext): string {
  const { owner, slotName, slotDefinition } = target;
  const where = definedIn([owner], context);

  if (!slotDefinition) {
    return fence(`(slot ${slotName})`) + '\n\n' + italic(`unknown slot of deftemplate ${owner.name}${where}`);
  }

  const keyword = slotDefinition.type === 'multislot_definition' ? 'multislot' : 'slot';
  const attrs = slotDefinition.children
    .filter((c) => c.type === 'template_attribute')
    .map((c) => `  ${collapse(c.text)}`);

  const body = `(${keyword} ${slotName})` + (attrs.length ? '\n' + attrs.join('\n') : '');
  const parts = [fence(body)];

  const doc = slotDoc(owner.definitionNode, slotDefinition);
  if (doc) parts.push(doc);

  parts.push(italic(`slot of deftemplate ${owner.name}${where}`));
  return parts.join('\n\n');
}

/**
 * The `;` comment after a slot, on the same line. Comments are extras, so
 * it is a child of the deftemplate.
 *
 * @param templateNode - The deftemplate.
 * @param slotInner - The slot definition.
 * @returns The comment text, or `null`.
 */
function slotDoc(templateNode: SyntaxNode, slotInner: SyntaxNode): string | null {
  const row = slotInner.startPosition.row;
  const comment = templateNode.children.find(
    (c) => c.type === 'comment_line' && c.startPosition.row === row
  );
  if (!comment) return null;
  const text = stripSemicolons(comment.text);
  return isMeaningful(text) ? clamp(text) : null;
}

// Docstrings

/**
 * The first docstring among the entries, so a generic can use a method's.
 *
 * @param entries - The entries.
 * @returns The docstring, or `null`.
 */
function firstDoc(entries: SymbolEntry[]): string | null {
  for (const entry of entries) {
    const doc = docFor(entry);
    if (doc) return doc;
  }
  return null;
}

/**
 * A construct's docstring (see the file comment for the order).
 *
 * @param entry - The entry.
 * @returns The docstring, or `null`.
 */
function docFor(entry: SymbolEntry): string | null {
  const d = entry.definitionNode;

  const quoted = quotedComment(d);
  if (quoted) {
    const text = quoted.text.replace(/^"/, '').replace(/"$/, '').trim();
    if (text) return clamp(text);
  }

  const sigRow = d.startPosition.row;
  const sigComments = d.children
    .filter((c) => c.type === 'comment_line' && c.startPosition.row === sigRow)
    .map((c) => stripSemicolons(c.text))
    .filter(isMeaningful);
  if (sigComments.length > 0) return clamp(sigComments.join(' '));

  const sibling = d.nextSibling;
  if (
    sibling?.type === 'comment_line' &&
    sibling.startPosition.row === d.endPosition.row
  ) {
    const text = stripSemicolons(sibling.text);
    if (isMeaningful(text)) return clamp(text);
  }

  return null;
}

/**
 * A construct's quoted comment; for a rule it is inside `defrule_body`.
 *
 * @param construct - The construct.
 * @returns The comment node, or `null`.
 */
function quotedComment(construct: SyntaxNode): SyntaxNode | null {
  const direct = construct.children.find((c) => c.type === 'comment');
  if (direct) return direct;
  const body = construct.children.find((c) => c.type === 'defrule_body');
  return body?.children.find((c) => c.type === 'comment') ?? null;
}

// Text helpers

/**
 * A ```clips code block.
 *
 * @param text - The code.
 * @returns The Markdown.
 */
function fence(text: string): string {
  return '```clips\n' + text + '\n```';
}

/**
 * Italic text.
 *
 * @param text - The text.
 * @returns The Markdown.
 */
function italic(text: string): string {
  return `*${text}*`;
}

/**
 * Collapses whitespace to single spaces.
 *
 * @param text - The text.
 * @returns The collapsed, trimmed text.
 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Strips leading `;` and one space.
 *
 * @param text - A comment line.
 * @returns The comment's text.
 */
function stripSemicolons(text: string): string {
  return text.replace(/^;+/, '').replace(/^[ \t]/, '').trimEnd();
}

/**
 * Whether a comment has words, not just decoration like `### ---`.
 *
 * @param text - The comment's text.
 */
function isMeaningful(text: string): boolean {
  return text.length > 0 && /[A-Za-z0-9]/.test(text);
}

/**
 * Limits a docstring to {@link DOC_MAX_LINES} lines and {@link DOC_MAX_CHARS} characters.
 *
 * @param text - The docstring.
 * @returns The shortened text, with "…" if cut.
 */
function clamp(text: string): string {
  let out = text.split('\n').slice(0, DOC_MAX_LINES).join('\n').trim();
  if (out.length > DOC_MAX_CHARS) out = out.slice(0, DOC_MAX_CHARS).trimEnd() + '…';
  return out;
}
