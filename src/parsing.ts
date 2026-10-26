/**
 * @file Document store (open documents and indexed files, parsed with their
 * symbol tables) and syntax diagnostics.
 */

import Parser, { type Edit, type Point, type SyntaxNode, type Tree } from 'tree-sitter';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node.js';
import { declarationApplies, declarationHeader, isDeclarationFile, type DeclarationFileInfo } from './declarations.js';
import { CLIPS_LANGUAGE } from './language.js';
import { toRange } from './lsp.js';
import { buildSymbolTable, mergeSymbolTables, overlaySymbolTable, type SymbolTable } from './symbolTable.js';
import { uriKey } from './uri.js';

/** The shared parser; parsing is synchronous, so one is enough. */
const parser = new Parser();
parser.setLanguage(CLIPS_LANGUAGE);

/** A parsed document. */
interface CachedDocument {
  /** The client's URI spelling if open, otherwise the scan's. */
  uri: string;
  /** The parse tree. */
  tree: Tree;
  /** The parsed text, for computing the next incremental edit. */
  text: string;
  /** Symbol table of the current tree. */
  table: SymbolTable;
  /** Table of the last parse without errors, see {@link getCompletionScope}. */
  lastGoodTable: SymbolTable | null;
}

/** Documents by {@link uriKey}. */
const documents = new Map<string, CachedDocument>();

/** Incremented on every change, so the load graph knows when to rebuild. */
let generation = 0;

/**
 * Changes whenever a document is added, reparsed or removed.
 *
 * @returns The current generation.
 */
export function getGeneration(): number {
  return generation;
}

/**
 * Parses and caches a document with its symbol table. Reparses
 * incrementally if a previous version is cached; the symbol table is
 * always rebuilt.
 *
 * @param uri - The document's URI.
 * @param text - Its full text.
 * @returns The tree.
 */
export function parseDocument(uri: string, text: string): Tree {
  const key = uriKey(uri);
  const previous = documents.get(key);

  let tree: Tree;
  if (previous) {
    const edit = computeEdit(previous.text, text);
    if (!edit) {
      // Same text, e.g. an indexed file that was just opened. Entries store
      // the URI, so rebuild if the spelling changed.
      if (previous.uri !== uri) {
        previous.uri = uri;
        previous.table = buildSymbolTable(previous.tree, uri);
        if (!previous.tree.rootNode.hasError) previous.lastGoodTable = previous.table;
        generation++;
      }
      return previous.tree;
    }
    previous.tree.edit(edit);
    try {
      tree = parser.parse(text, previous.tree);
    } catch {
      tree = parser.parse(text);
    }
  } else {
    tree = parser.parse(text);
  }

  const table = buildSymbolTable(tree, uri);
  const lastGoodTable = tree.rootNode.hasError ? (previous?.lastGoodTable ?? null) : table;
  documents.set(key, { uri, tree, text, table, lastGoodTable });
  generation++;
  return tree;
}

/**
 * Parses a text without caching it.
 *
 * @param text - The text.
 * @returns Its tree.
 */
export function parseText(text: string): Tree {
  return parser.parse(text);
}

/**
 * The changed span between two texts as one tree-sitter edit, with the
 * common prefix and suffix removed. Offsets are UTF-16 code units, as the
 * Node binding expects; boundaries never split a surrogate pair.
 *
 * @param oldText - The previous text.
 * @param newText - The new text.
 * @returns The edit, or `null` if the texts are equal.
 */
function computeEdit(oldText: string, newText: string): Edit | null {
  if (oldText === newText) return null;

  const oldLength = oldText.length;
  const newLength = newText.length;

  let start = 0;
  const maxStart = Math.min(oldLength, newLength);
  while (start < maxStart && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  if (start > 0 && start < oldLength && isLowSurrogate(oldText.charCodeAt(start))) start--;

  let oldEnd = oldLength;
  let newEnd = newLength;
  const maxSuffix = Math.min(oldLength - start, newLength - start);
  let matched = 0;
  while (matched < maxSuffix && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
    matched++;
  }
  if (matched > 0 && oldEnd < oldLength && isHighSurrogate(oldText.charCodeAt(oldEnd - 1))) {
    oldEnd++;
    newEnd++;
  }

  return {
    startIndex: start,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition: pointAt(oldText, start),
    oldEndPosition: pointAt(oldText, oldEnd),
    newEndPosition: pointAt(newText, newEnd)
  };
}

/**
 * True for a UTF-16 high surrogate.
 *
 * @param code - A UTF-16 code unit.
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * True for a UTF-16 low surrogate.
 *
 * @param code - A UTF-16 code unit.
 */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Converts an offset to a tree-sitter point.
 *
 * @param text - The text.
 * @param index - An offset in `text`.
 * @returns Row and column.
 */
function pointAt(text: string, index: number): Point {
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      row++;
      lineStart = i + 1;
    }
  }
  return { row, column: index - lineStart };
}

/**
 * The cached tree of a document.
 *
 * @param uri - The document's URI.
 * @returns The tree, or `undefined` if not cached.
 */
export function getTree(uri: string): Tree | undefined {
  return documents.get(uriKey(uri))?.tree;
}

/**
 * The text a document was last parsed from.
 *
 * @param uri - The document's URI.
 * @returns The text, or `undefined` if not cached.
 */
export function getText(uri: string): string | undefined {
  return documents.get(uriKey(uri))?.text;
}

/**
 * A document's own symbol table. To resolve references use {@link getScope}.
 *
 * @param uri - The document's URI.
 * @returns The table, or `undefined` if not cached.
 */
export function getSymbolTable(uri: string): SymbolTable | undefined {
  return documents.get(uriKey(uri))?.table;
}

/**
 * A document's table merged with all others' (see `mergeSymbolTables`).
 * Built per request; cheap for CLIPS-sized projects and never stale.
 *
 * @param uri - The document's URI.
 * @returns The scope, or `undefined` if not cached.
 */
export function getScope(uri: string): SymbolTable | undefined {
  const key = uriKey(uri);
  const own = documents.get(key);
  if (!own) return undefined;
  const { others, declarations } = scopeTables(key, own.uri, () => true);
  return mergeSymbolTables(own.table, others, declarations);
}

/**
 * Tables of the other documents: the `.clp` files `admit` accepts, and
 * the declaration files that apply to the document.
 *
 * @param key - The document's key.
 * @param uri - The document's URI.
 * @param admit - Which other `.clp` files to include.
 * @returns The program tables and the declaration tables.
 */
function scopeTables(key: string, uri: string, admit: (otherUri: string) => boolean): { others: SymbolTable[]; declarations: SymbolTable[] } {
  const others: SymbolTable[] = [];
  const declarations: SymbolTable[] = [];
  for (const [otherKey, doc] of documents) {
    if (otherKey === key) continue;
    if (isDeclarationFile(doc.uri)) {
      if (declarationApplies(doc.uri, uri)) declarations.push(doc.table);
    } else if (admit(doc.uri)) {
      others.push(doc.table);
    }
  }
  return { others, declarations };
}

/**
 * Tables of the declaration files that apply to a document.
 *
 * @param uri - The document's URI.
 * @returns The tables.
 */
export function getDeclarationTables(uri: string): SymbolTable[] {
  return scopeTables(uriKey(uri), uri, () => false).declarations;
}

/**
 * Declaration files that apply to a document, nearest first.
 *
 * @param uri - The document's URI.
 * @returns The files with their generation headers.
 */
export function getDeclarationFiles(uri: string): DeclarationFileInfo[] {
  const key = uriKey(uri);
  const files: DeclarationFileInfo[] = [];
  for (const [otherKey, doc] of documents) {
    if (otherKey === key || !isDeclarationFile(doc.uri) || !declarationApplies(doc.uri, uri)) continue;
    files.push({ uri: doc.uri, generated: declarationHeader(doc.tree) });
  }
  return files.sort((a, b) => uriKey(b.uri).length - uriKey(a.uri).length);
}

/**
 * Like {@link getScope}, plus definitions the current parse lost after its
 * first syntax error, taken from the last error-free parse.
 *
 * @param uri - The document's URI.
 * @param admit - Which other documents to include; all by default.
 * @returns The scope, or `undefined` if not cached.
 */
export function getCompletionScope(uri: string, admit: (otherUri: string) => boolean = () => true): SymbolTable | undefined {
  const key = uriKey(uri);
  const own = documents.get(key);
  if (!own) return undefined;
  const { others, declarations } = scopeTables(key, own.uri, admit);
  const stale = own.lastGoodTable;
  const firstError = stale && stale !== own.table ? firstErrorIndex(own.tree.rootNode) : null;
  const base = stale && firstError !== null ? overlaySymbolTable(own.table, stale, firstError) : own.table;
  return mergeSymbolTables(base, others, declarations);
}

/**
 * Offset of the first ERROR or missing node.
 *
 * @param node - The subtree.
 * @returns The offset, or `null` if the subtree has no error.
 */
function firstErrorIndex(node: SyntaxNode): number | null {
  if (node.type === 'ERROR' || node.isMissing) return node.startIndex;
  if (!node.hasError && !node.isMissing) return null;
  for (const child of node.children) {
    const index = firstErrorIndex(child);
    if (index !== null) return index;
  }
  return null;
}

/**
 * All cached documents, open or not.
 *
 * @returns The documents.
 */
export function* getAllDocuments(): IterableIterator<{ uri: string; tree: Tree; table: SymbolTable }> {
  for (const doc of documents.values()) yield { uri: doc.uri, tree: doc.tree, table: doc.table };
}

/**
 * Removes a document from the cache.
 *
 * @param uri - The document's URI.
 */
export function removeDocument(uri: string): void {
  if (documents.delete(uriKey(uri))) generation++;
}

/**
 * Syntax diagnostics: one per ERROR or missing node.
 *
 * @param tree - A parsed tree.
 * @returns The diagnostics in document order.
 */
export function collectSyntaxDiagnostics(tree: Tree): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  walk(tree.rootNode, diagnostics);
  return diagnostics;
}

/** Longest snippet of code quoted in a syntax error message. */
const MAX_SNIPPET_LENGTH = 60;

/**
 * The first line of an ERROR node's text, shortened. An ERROR node often
 * runs on to the next construct, far past the actual mistake.
 *
 * @param text - The node's text.
 * @returns At most {@link MAX_SNIPPET_LENGTH} characters, with "…" if cut.
 */
function summarize(text: string): string {
  const firstLine = text.split('\n')[0];
  const truncated = firstLine.length > MAX_SNIPPET_LENGTH;
  const snippet = truncated ? firstLine.slice(0, MAX_SNIPPET_LENGTH) : firstLine;
  return truncated || text.length > firstLine.length ? `${snippet}…` : snippet;
}

/**
 * Range of an ERROR node, limited to its first line (see {@link summarize}).
 *
 * @param node - An ERROR node.
 * @returns The range.
 */
function errorRange(node: SyntaxNode) {
  if (node.startPosition.row === node.endPosition.row) return toRange(node);
  const firstLineLength = node.text.split('\n')[0].length;
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.startPosition.row, character: node.startPosition.column + firstLineLength }
  };
}

/** Template and class slot definitions. */
const SLOT_DEFINITIONS = new Set(['single_slot_definition', 'multislot_definition', 'slot']);

/**
 * Message for a missing node. Its type is just recovery's cheapest repair
 * (often a global variable), so known cases get a message naming the rule.
 *
 * @param node - A missing node.
 * @returns The message.
 */
function missingMessage(node: SyntaxNode): string {
  const parent = node.parent;

  // (?x) in a defmethod: CLIPS needs a type or query in parentheses ([GENRCPSR13]).
  const restriction = parent?.type === 'other_query' ? parent.parent : null;
  if (restriction?.type === 'parameter_restriction' || restriction?.type === 'wildcard_parameter_restriction') {
    return 'A parameter restriction in parentheses needs a type or a query; write the parameter without parentheses for no restriction';
  }

  // (loop-for-count 3)
  for (let a: SyntaxNode | null = parent; a; a = a.parent) {
    if (a.type === 'action') {
      if (a.parent?.type === 'loop_for_count_expression') return 'loop-for-count needs `do` or an action after the range';
      break;
    }
  }

  return `Missing "${node.type}"`;
}

/**
 * Message for an error visible only as `hasError`; the Node binding hides
 * some inserted tokens. Usually a construct without a name.
 *
 * @param node - The deepest node with `hasError`.
 * @returns The message.
 */
function hiddenErrorMessage(node: SyntaxNode): string {
  const name = node.type === 'name' ? node : node.parent?.type === 'name' ? node.parent : null;
  const construct = name?.parent;
  const emptyName = !!name && name.startIndex === name.endIndex;

  // (is-a) with no superclass; check before the construct name below.
  if (emptyName && name.previousSibling?.type === 'is-a') {
    return 'A class needs at least one superclass after is-a';
  }
  // (export deftemplate) without names.
  if (emptyName && name.previousSibling?.type === 'port_construct') {
    return `Name the ${name.previousSibling.text} constructs here, or use ?ALL or ?NONE`;
  }
  // (range ?low 10): recovery skips the variable and inserts a number.
  for (let a: SyntaxNode | null = node; a && node.startIndex === node.endIndex; a = a.parent) {
    if (a.type === 'range_specification') return 'range takes a number or ?VARIABLE';
    if (a.type === 'cardinality_specification') return 'cardinality takes an integer or ?VARIABLE';
    if (a.type.endsWith('_attribute')) break;
  }

  if (emptyName && construct?.type.endsWith('_construct')) {
    return `Missing ${construct.type.slice(0, -'_construct'.length).replace(/_/g, '-')} name`;
  }
  if (emptyName && SLOT_DEFINITIONS.has(construct?.type ?? '')) {
    return 'Missing slot name';
  }
  return node.startIndex === node.endIndex ? `Missing "${node.type}"` : `Syntax error near "${summarize(node.text)}"`;
}

/**
 * Reports ERROR and missing nodes. A subtree with `hasError` and nothing
 * reported is reported at its deepest erroneous node.
 *
 * @param node - The subtree.
 * @param diagnostics - Output.
 * @returns Whether anything was reported.
 */
function walk(node: SyntaxNode, diagnostics: Diagnostic[]): boolean {
  if (node.type === 'ERROR') {
    // A marked mistake in or next to the ERROR is the real cause.
    const marked = [...markedMistakesIn(node), ...[node.previousSibling, node.nextSibling].map((s) => (s ? markedMistake(s) : null))]
      .filter((m): m is MarkedMistake => m !== null);
    if (marked.length > 0) {
      for (const m of marked) diagnostics.push({ severity: DiagnosticSeverity.Error, range: toRange(m.node), message: m.message, source: 'clips' });
      return true;
    }
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: errorRange(node),
      message: `Syntax error near "${summarize(node.text)}"`,
      source: 'clips'
    });
    return true;
  }

  let reported = false;
  if (node.isMissing) {
    // The name a marked mistake requires, inserted by recovery.
    const prev = node.previousSibling;
    const marked = prev?.type === 'invalid_variable_name' ? markedMistake(prev) : prev?.type === 'logical' && node.parent ? markedMistake(node.parent) : null;
    diagnostics.push(
      marked
        ? { severity: DiagnosticSeverity.Error, range: toRange(marked.node), message: marked.message, source: 'clips' }
        : { severity: DiagnosticSeverity.Error, range: toRange(node), message: missingMessage(node), source: 'clips' }
    );
    reported = true;
  }

  for (const child of node.children) {
    if (walk(child, diagnostics)) reported = true;
  }

  if (!reported && node.hasError && !node.children.some((c) => c.hasError)) {
    const marked = markedMistakesIn(node)[0];
    diagnostics.push(
      marked
        ? { severity: DiagnosticSeverity.Error, range: toRange(marked.node), message: marked.message, source: 'clips' }
        : { severity: DiagnosticSeverity.Error, range: toRange(node), message: hiddenErrorMessage(node), source: 'clips' }
    );
    reported = true;
  }
  return reported;
}

/** A mistake marked by a dead-end grammar rule. */
interface MarkedMistake {
  /** Where to report it. */
  node: SyntaxNode;
  /** The message. */
  message: string;
}

/**
 * Mistakes the grammar marks with rules that can't complete
 * (`invalid_variable_name`, `_misplaced_logical_CE`). They get their own
 * message instead of whatever recovery made of the code around them.
 *
 * @param node - Any node.
 * @returns The mistake, or `null`.
 */
function markedMistake(node: SyntaxNode): MarkedMistake | null {
  // ?_x, ?1x, ?-x ([SCANNER2])
  if (node.type === 'invalid_variable_name') {
    // Check the text before it; recovery may have moved the ? elsewhere in the tree.
    const before = node.startIndex > 0 ? node.tree.rootNode.descendantForIndex(node.startIndex - 1, node.startIndex) : null;
    if (before?.type !== '?' && before?.type !== '$?') return null;
    return { node, message: `"${before.type}${node.text}" is not a valid variable: a variable name must start with a letter` };
  }
  // A logical CE after another CE: only `(` and the keyword remain.
  if (node.type === 'conditional_element' && node.child(1)?.type === 'logical' && !node.children.some((c) => c.type === 'logical_CE')) {
    return { node: node.child(1)!, message: 'Logical CEs must come before all other conditional elements of a rule' };
  }
  return null;
}

/**
 * All {@link markedMistake}s in a subtree.
 *
 * @param root - The subtree.
 * @returns The mistakes in document order, each reported once.
 */
function markedMistakesIn(root: SyntaxNode): MarkedMistake[] {
  const found: MarkedMistake[] = [];
  (function visit(n: SyntaxNode): void {
    const m = markedMistake(n);
    if (m) {
      // Recovery can split one bad word into several tokens; report it once.
      const last = found[found.length - 1];
      if (!(last && last.node.endIndex === m.node.startIndex && last.node.type === m.node.type)) found.push(m);
      return;
    }
    for (const c of n.children) visit(c);
  })(root);
  return found;
}
