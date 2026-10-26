/**
 * @file Per-document index of named constructs, built from the grammar's
 * `tags.scm` query.
 */

import Parser, { type SyntaxNode, type Tree } from 'tree-sitter';
import { SymbolKind } from 'vscode-languageserver/node.js';
import {
  isDeclarationFile,
  readExternals,
  readHostFunctions,
  type ExternalName,
  type HostFunction
} from './declarations.js';
import { CLIPS_LANGUAGE, TAGS_QUERY_SOURCE } from './language.js';
import { instanceNameKey, instanceSites } from './sites.js';

/** The compiled `tags.scm` query. */
const tagsQuery = new Parser.Query(CLIPS_LANGUAGE, TAGS_QUERY_SOURCE);

/**
 * `@definition.<suffix>` capture to `SymbolKind`. Other captures, such as
 * `@definition.defmessage_handler.class`, are ignored.
 */
const KIND_BY_SUFFIX: Record<string, SymbolKind> = {
  function: SymbolKind.Function,
  method: SymbolKind.Method,
  type: SymbolKind.Struct,
  class: SymbolKind.Class,
  module: SymbolKind.Module,
  constant: SymbolKind.Constant,
  field: SymbolKind.Field
};

/**
 * Lookup key of a `name` or `global_variable` node; `MODULE::x` keys as `x`.
 *
 * @param nameNode - A `name` or `global_variable` node.
 * @returns The unqualified name.
 */
export function nameKey(nameNode: SyntaxNode): string {
  const child = nameNode.firstChild;
  if (child?.type === 'qualified_name') {
    return child.children[2]?.text ?? nameNode.text;
  }
  return nameNode.text;
}

/**
 * Lookup key of a call head; `(UTIL::double 21)` keys as `double`.
 *
 * @param functionNameNode - A `function_name` node.
 * @returns The unqualified function name.
 */
export function functionNameKey(functionNameNode: SyntaxNode): string {
  return nameKey(functionNameNode);
}

/**
 * Whether a call head has a module prefix, as in `(UTIL::double 21)`.
 *
 * @param functionNameNode - A `function_name` node.
 */
export function isQualifiedCall(functionNameNode: SyntaxNode): boolean {
  return functionNameNode.firstChild?.type === 'qualified_name';
}

/** A named construct or slot. */
export interface SymbolEntry {
  /** Document the construct is defined in. */
  uri: string;
  /** Unqualified name. */
  name: string;
  /** Symbol kind for the outline. */
  kind: SymbolKind;
  /** The name node; the go-to-definition target. */
  nameNode: SyntaxNode;
  /** The whole construct. */
  definitionNode: SyntaxNode;
}

/** A document's constructs, with lookup maps by category. */
export interface SymbolTable {
  /** All entries, in query match order. */
  entries: SymbolEntry[];
  /** Deftemplates by name. */
  templates: Map<string, SymbolEntry>;
  /** deffunction, defgeneric and defmethod; a generic has several entries. */
  functionLike: Map<string, SymbolEntry[]>;
  /** Defclasses by name. */
  classes: Map<string, SymbolEntry>;
  /** Keyed by the full `?*name*` text. */
  globals: Map<string, SymbolEntry>;
  /** Heads of ordered facts and patterns, e.g. `phase` in (phase match). May include template names. */
  facts: Map<string, NameUse[]>;
  /** Instance names created in definstances or make-instance. */
  instances: Map<string, NameUse[]>;
  /** From `defudf` lines; .clpd files only. */
  hostFunctions: Map<string, HostFunction>;
  /** From `defexternal` lines, keyed by `externalKey`; .clpd files only. */
  externals: Map<string, ExternalName>;
}

/** Where a fact or instance name occurs. */
export interface NameUse {
  /** The document. */
  uri: string;
  /** Offset in the document. */
  start: number;
  /** For an instance: the class after `of`. */
  className?: string | null;
}

/**
 * `tags.scm` also matches a defclass's superclass as its name; only the
 * first `name` child is the class's own.
 *
 * @param nameNode - The captured `name` node.
 * @param defclassNode - The enclosing `defclass_construct`.
 * @returns `true` if `nameNode` is the class's own name.
 */
function isDefclassOwnName(nameNode: SyntaxNode, defclassNode: SyntaxNode): boolean {
  // Compare ids: the Node binding may return different wrapper objects for the same node.
  return defclassNode.children.find((c) => c.type === 'name')?.id === nameNode.id;
}

/**
 * Builds a document's symbol table.
 *
 * @param tree - The document's tree.
 * @param uri - The document's URI.
 * @returns The symbol table.
 */
export function buildSymbolTable(tree: Tree, uri: string): SymbolTable {
  const entries: SymbolEntry[] = [];
  const templates = new Map<string, SymbolEntry>();
  const functionLike = new Map<string, SymbolEntry[]>();
  const classes = new Map<string, SymbolEntry>();
  const globals = new Map<string, SymbolEntry>();

  // matches(), not captures(), so each @name stays paired with its @definition.
  for (const match of tagsQuery.matches(tree.rootNode)) {
    let nameNode: SyntaxNode | undefined;
    let definitionNode: SyntaxNode | undefined;
    let kindSuffix: string | undefined;

    for (const capture of match.captures) {
      if (capture.name === 'name') {
        nameNode = capture.node;
      } else if (capture.name.startsWith('definition.')) {
        const suffix = capture.name.slice('definition.'.length);
        if (suffix in KIND_BY_SUFFIX) {
          definitionNode = capture.node;
          kindSuffix = suffix;
        }
      }
    }
    if (!nameNode || !definitionNode || !kindSuffix) continue;
    // Error recovery can insert an empty MISSING name while typing. VS Code
    // rejects the whole outline if a symbol name is empty.
    if (nameNode.isMissing || nameNode.startIndex === nameNode.endIndex) continue;
    if (definitionNode.type === 'defclass_construct' && !isDefclassOwnName(nameNode, definitionNode)) {
      continue;
    }

    const entry: SymbolEntry = {
      uri,
      name: nameKey(nameNode),
      kind: KIND_BY_SUFFIX[kindSuffix],
      nameNode,
      definitionNode
    };
    entries.push(entry);

    switch (definitionNode.type) {
      case 'deftemplate_construct':
        templates.set(entry.name, entry);
        break;
      case 'deffunction_construct':
      case 'defgeneric_construct':
      case 'defmethod_construct': {
        const list = functionLike.get(entry.name);
        if (list) list.push(entry);
        else functionLike.set(entry.name, [entry]);
        break;
      }
      case 'defclass_construct':
        classes.set(entry.name, entry);
        break;
      case 'defglobal_construct':
        globals.set(entry.name, entry);
        break;
      default:
        break;
    }
  }

  const facts = new Map<string, NameUse[]>();
  for (const pattern of tree.rootNode.descendantsOfType(['ordered_RHS_pattern', 'ordered_pattern_CE'])) {
    const head = pattern.children.find((c) => c.type === 'name');
    if (!head || head.isMissing || head.startIndex === head.endIndex) continue;
    addUse(facts, nameKey(head), { uri, start: head.startIndex });
  }
  const instances = new Map<string, NameUse[]>();
  for (const site of instanceSites(tree.rootNode)) {
    if (!site.className) continue; // duplicate-instance: no class
    addUse(instances, instanceNameKey(site.nameNode.text), { uri, start: site.nameNode.startIndex, className: site.className });
  }
  const declaration = isDeclarationFile(uri);
  const hostFunctions = declaration ? readHostFunctions(tree, uri).functions : new Map<string, HostFunction>();
  const externals = declaration ? readExternals(tree, uri).names : new Map<string, ExternalName>();

  return { entries, templates, functionLike, classes, globals, facts, instances, hostFunctions, externals };
}

/**
 * Adds an occurrence to a use map.
 *
 * @param map - The map.
 * @param name - The name.
 * @param use - The occurrence.
 */
function addUse(map: Map<string, NameUse[]>, name: string, use: NameUse): void {
  const list = map.get(name);
  if (list) list.push(use);
  else map.set(name, [use]);
}

/**
 * Merges use maps.
 *
 * @param maps - The maps, in order.
 * @returns One map with all occurrences.
 */
function mergeUses(maps: Map<string, NameUse[]>[]): Map<string, NameUse[]> {
  const merged = new Map<string, NameUse[]>();
  for (const map of maps) for (const [name, uses] of map) for (const use of uses) addUse(merged, name, use);
  return merged;
}

/**
 * The lookup scope of a document: its own table, then the other files'.
 * For templates, classes and globals the first definition wins; function
 * entries are concatenated, since a generic's methods can be in different
 * files. Use it for lookups only; checks on the document's own definitions
 * need its own table.
 *
 * @param own - The document's table.
 * @param others - The other documents' tables.
 * @param fallbacks - Declaration files; used only for names nothing else defines.
 * @returns The merged table.
 */
export function mergeSymbolTables(own: SymbolTable, others: Iterable<SymbolTable>, fallbacks: Iterable<SymbolTable> = []): SymbolTable {
  const entries = [...own.entries];
  const templates = new Map(own.templates);
  const classes = new Map(own.classes);
  const globals = new Map(own.globals);
  const hostFunctions = new Map(own.hostFunctions);
  const externals = new Map(own.externals);
  const functionLike = new Map<string, SymbolEntry[]>();
  for (const [name, list] of own.functionLike) functionLike.set(name, [...list]);

  const otherTables = [...others];
  for (const other of otherTables) {
    entries.push(...other.entries);
    for (const [name, entry] of other.templates) if (!templates.has(name)) templates.set(name, entry);
    for (const [name, entry] of other.classes) if (!classes.has(name)) classes.set(name, entry);
    for (const [name, entry] of other.globals) if (!globals.has(name)) globals.set(name, entry);
    for (const [name, fn] of other.hostFunctions) if (!hostFunctions.has(name)) hostFunctions.set(name, fn);
    for (const [key, external] of other.externals) if (!externals.has(key)) externals.set(key, external);
    for (const [name, list] of other.functionLike) {
      const existing = functionLike.get(name);
      if (existing) existing.push(...list);
      else functionLike.set(name, [...list]);
    }
  }

  const programNames = new Set(functionLike.keys());
  for (const fallback of fallbacks) {
    entries.push(...fallback.entries);
    for (const [name, entry] of fallback.templates) if (!templates.has(name)) templates.set(name, entry);
    for (const [name, entry] of fallback.classes) if (!classes.has(name)) classes.set(name, entry);
    for (const [name, entry] of fallback.globals) if (!globals.has(name)) globals.set(name, entry);
    for (const [name, fn] of fallback.hostFunctions) if (!hostFunctions.has(name)) hostFunctions.set(name, fn);
    for (const [key, external] of fallback.externals) if (!externals.has(key)) externals.set(key, external);
    for (const [name, list] of fallback.functionLike) {
      if (programNames.has(name)) continue;
      const existing = functionLike.get(name);
      if (existing) existing.push(...list);
      else functionLike.set(name, [...list]);
    }
  }

  const facts = mergeUses([own.facts, ...otherTables.map((t) => t.facts)]);
  const instances = mergeUses([own.instances, ...otherTables.map((t) => t.instances)]);
  return { entries, templates, functionLike, classes, globals, facts, instances, hostFunctions, externals };
}

/**
 * While a syntax error hides part of a file, adds back definitions from
 * the last error-free table: names missing from `current` that start at
 * or after the first error.
 *
 * @param current - The current table.
 * @param stale - The last error-free table.
 * @param fromIndex - Offset of the first syntax error.
 * @returns A new table.
 */
export function overlaySymbolTable(current: SymbolTable, stale: SymbolTable, fromIndex: number): SymbolTable {
  const entries = [...current.entries];
  const templates = new Map(current.templates);
  const classes = new Map(current.classes);
  const globals = new Map(current.globals);
  const functionLike = new Map<string, SymbolEntry[]>();
  for (const [name, list] of current.functionLike) functionLike.set(name, [...list]);

  /** Whether an entry starts at or after the first error. */
  const lost = (entry: SymbolEntry) => entry.definitionNode.startIndex >= fromIndex;
  /** Copies the lost entries of `source` that `map` lacks. */
  const take = (map: Map<string, SymbolEntry>, source: Map<string, SymbolEntry>) => {
    for (const [name, entry] of source) {
      if (map.has(name) || !lost(entry)) continue;
      map.set(name, entry);
      entries.push(entry);
    }
  };
  take(templates, stale.templates);
  take(classes, stale.classes);
  take(globals, stale.globals);
  for (const [name, list] of stale.functionLike) {
    if (functionLike.has(name)) continue;
    const kept = list.filter(lost);
    if (kept.length === 0) continue;
    functionLike.set(name, kept);
    entries.push(...kept);
  }

  return { entries, templates, functionLike, classes, globals, facts: current.facts, instances: current.instances, hostFunctions: current.hostFunctions, externals: current.externals };
}
