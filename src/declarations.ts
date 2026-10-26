/**
 * @file Declaration files (.clpd): what a host program that embeds CLIPS
 * defines (AddUDF functions, constructs from Build or Eval). dump.clp
 * generates one; besides constructs it may contain
 *
 *   (defudf <name> ["<returnTypes>" [<min> [<max> ["<argTypes>"]]]])
 *   (defexternal deftemplate|defclass|defglobal <name>)
 *
 * with AddUDF type codes (APG 8.2). defexternal only says a name exists.
 * A .clpd file applies to the .clp files in its folder and below.
 */

import { dirname, sep } from 'node:path';
import type { SyntaxNode, Tree } from 'tree-sitter';
import { BUILTIN_FUNCTIONS, type BuiltinFunction } from './builtins.js';
import { uriKey, uriToPath } from './uri.js';

/** A function the host program registers with `AddUDF`, from a `(defudf ...)` line. */
export interface HostFunction {
  /** URI of the declaration file. */
  uri: string;
  /** Function name. */
  name: string;
  /** The name in the `defudf` line. */
  nameNode: SyntaxNode;
  /** The whole `(defudf ...)` call. */
  definitionNode: SyntaxNode;
  /** Same shape as a built-in entry, so both are handled alike. */
  signature: BuiltinFunction;
  /** Generation time of the dump; `null` if hand-written. */
  generated: string | null;
}

/** The kinds of construct `(defexternal <kind> <name>)` can declare. */
export const EXTERNAL_KINDS = ['deftemplate', 'defclass', 'defglobal'] as const;
/** One of {@link EXTERNAL_KINDS}. */
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];

/** A name declared by `(defexternal <kind> <name>)`. */
export interface ExternalName {
  /** URI of the declaration file. */
  uri: string;
  /** The construct kind. */
  kind: ExternalKind;
  /** The name; `?*name*` for a global. */
  name: string;
  /** A constant, or a global variable. */
  nameNode: SyntaxNode;
  /** The whole `(defexternal ...)` call. */
  definitionNode: SyntaxNode;
}

/**
 * Key of an {@link ExternalName} in `SymbolTable.externals`.
 *
 * @param kind - The construct kind.
 * @param name - The name.
 * @returns The key.
 */
export function externalKey(kind: ExternalKind, name: string): string {
  return `${kind} ${name}`;
}

/**
 * Reads the `defexternal` lines of a declaration file.
 *
 * @param tree - The file's tree.
 * @param uri - The file's URI.
 * @returns The names by {@link externalKey} (first one wins) and the malformed lines.
 */
export function readExternals(tree: Tree, uri: string): { names: Map<string, ExternalName>; problems: DefudfProblem[] } {
  const names = new Map<string, ExternalName>();
  const problems: DefudfProblem[] = [];
  const usage = `expected (defexternal <kind> <name>), <kind> one of ${EXTERNAL_KINDS.join(', ')}`;
  for (const call of topLevelCalls(tree.rootNode, 'defexternal')) {
    const [kindNode, nameNode, extra] = call.namedChildren.slice(1).filter((n) => n.type !== 'comment_line');
    const kind = kindNode?.text as ExternalKind | undefined;
    if (!kindNode || !kind || !EXTERNAL_KINDS.includes(kind)) {
      problems.push({ node: kindNode ?? call, message: `Unknown kind${kindNode ? ` "${kindNode.text}"` : ''}: ${usage}` });
      continue;
    }
    const isGlobal = nameNode?.type === 'variable' && nameNode.firstChild?.type === 'global_variable';
    const isSymbol = nameNode?.type === 'constant' && nameNode.firstChild?.type === 'symbol';
    if (!nameNode || (kind === 'defglobal' ? !isGlobal : !isSymbol)) {
      problems.push({ node: nameNode ?? call, message: kind === 'defglobal' ? `A global is written ?*name*: ${usage}` : `Missing or invalid name: ${usage}` });
      continue;
    }
    if (extra) {
      problems.push({ node: extra, message: `Too many fields: ${usage}` });
      continue;
    }
    // MODULE::name is keyed by name, as elsewhere.
    const name = isGlobal ? nameNode.text : nameNode.text.split('::').pop()!;
    const key = externalKey(kind, name);
    if (!names.has(key)) names.set(key, { uri, kind, name, nameNode, definitionNode: call });
  }
  return { names, problems };
}

/**
 * Top-level calls named `head`, e.g. `defudf`.
 *
 * @param root - The file's root node.
 * @param head - The function name.
 * @returns The calls in document order.
 */
export function topLevelCalls(root: SyntaxNode, head: string): SyntaxNode[] {
  return root.namedChildren.filter((n) => n.type === 'function_call' && n.namedChildren[0]?.type === 'function_name' && n.namedChildren[0].text === head);
}

/**
 * True for `.clpd` names and URIs (any case).
 *
 * @param nameOrUri - A file name, path or URI.
 */
export function isDeclarationFile(nameOrUri: string): boolean {
  return nameOrUri.toLowerCase().endsWith('.clpd');
}

/**
 * Whether the document is in the declaration file's folder or below.
 * Untitled documents get none.
 *
 * @param declarationUri - The `.clpd` file's URI.
 * @param documentUri - The document being checked.
 */
export function declarationApplies(declarationUri: string, documentUri: string): boolean {
  const declarationPath = uriToPath(declarationUri);
  if (declarationPath === null || uriToPath(documentUri) === null) return false;
  const folder = dirname(uriKey(declarationUri));
  const document = uriKey(documentUri);
  return document.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/** First line of a file generated by `dump.clp`. */
const GENERATED_HEADER = /^;;; Generated by dump\.clp(?: on (\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?))?/;

/**
 * When `dump.clp` generated the file.
 *
 * @param text - The file's text.
 * @returns `null` if hand-written, `''` if the header has no time.
 */
export function generatedAt(text: string): string | null {
  const match = GENERATED_HEADER.exec(text);
  return match ? (match[1] ?? '') : null;
}

/** A declaration file that applies to a document. */
export interface DeclarationFileInfo {
  /** The file's URI. */
  uri: string;
  /** See {@link generatedAt}: `null` for a hand-written file. */
  generated: string | null;
}

/**
 * {@link generatedAt} for a parsed file.
 *
 * @param tree - The file's tree.
 * @returns The generation time, or `null` if the file has no dump header.
 */
export function declarationHeader(tree: Tree): string | null {
  const first = tree.rootNode.firstChild;
  return first?.type === 'comment_line' && first.startIndex === 0 ? generatedAt(first.text) : null;
}

/** A malformed `defudf` or `defexternal` line. */
export interface DefudfProblem {
  /** Where to report it. */
  node: SyntaxNode;
  /** What is wrong. */
  message: string;
}

/** AddUDF type codes (APG 8.2). */
const TYPE_LABEL: Record<string, string> = {
  b: 'boolean',
  d: 'float',
  e: 'external-address',
  f: 'fact-address',
  i: 'instance-address',
  l: 'integer',
  m: 'multifield',
  n: 'instance-name',
  s: 'string',
  y: 'symbol',
  v: 'void',
  '*': 'expression'
};

/**
 * Reads the `defudf` lines. Built-ins are skipped: the dump lists them too,
 * and the built-in data describes them better.
 *
 * @param tree - The file's tree.
 * @param uri - The file's URI.
 * @returns The host functions by name (first one wins) and the malformed lines.
 */
export function readHostFunctions(tree: Tree, uri: string): { functions: Map<string, HostFunction>; problems: DefudfProblem[] } {
  const functions = new Map<string, HostFunction>();
  const problems: DefudfProblem[] = [];
  const generated = declarationHeader(tree);
  for (const call of defudfCalls(tree.rootNode)) {
    const parsed = parseDefudf(call);
    if ('message' in parsed) {
      problems.push(parsed);
      continue;
    }
    if (BUILTIN_FUNCTIONS.has(parsed.name) || functions.has(parsed.name)) continue;
    functions.set(parsed.name, { uri, name: parsed.name, nameNode: parsed.nameNode, definitionNode: call, signature: parsed.signature, generated });
  }
  return { functions, problems };
}

/**
 * The `defudf` lines of a file.
 *
 * @param root - The file's root node.
 * @returns The calls.
 */
export function defudfCalls(root: SyntaxNode): SyntaxNode[] {
  return topLevelCalls(root, 'defudf');
}

/**
 * Parses a `defudf` line, or says what is wrong with it.
 *
 * @param call - The `(defudf ...)` call.
 * @returns The name and signature, or the problem.
 */
function parseDefudf(call: SyntaxNode): { name: string; nameNode: SyntaxNode; signature: BuiltinFunction } | DefudfProblem {
  const head = call.namedChildren[0];
  const args = call.namedChildren.slice(1).filter((n) => n.type !== 'comment_line');
  const usage = 'expected (defudf <name> ["<returnTypes>" [<min> [<max> ["<argTypes>"]]]])';

  const nameNode = args[0];
  const nameLeaf = nameNode?.type === 'constant' ? nameNode.firstChild : null;
  if (!nameNode || nameLeaf?.type !== 'symbol') return { node: nameNode ?? head, message: `defudf needs a function name: ${usage}` };
  if (args.length > 5) return { node: args[5], message: `Too many fields: ${usage}` };

  const returns = args[1] ? stringField(args[1]) : null;
  if (args[1] && returns === null) return { node: args[1], message: 'The return types must be a string of AddUDF type codes, e.g. "ld"' };
  const min = args[2] ? integerField(args[2]) : null;
  if (args[2] && min === null) return { node: args[2], message: 'The minimum argument count must be a non-negative integer' };
  const max = args[3] ? (args[3].text === '*' ? 'UNBOUNDED' : integerField(args[3])) : null;
  if (args[3] && max === null) return { node: args[3], message: 'The maximum argument count must be a non-negative integer or *' };
  if (min !== null && typeof max === 'number' && min > max) return { node: args[3], message: `The maximum (${max}) is below the minimum (${min})` };
  const restriction = args[4] ? stringField(args[4]) : null;
  if (args[4] && restriction === null) return { node: args[4], message: 'The argument types must be a string of AddUDF type codes, e.g. "ld;s"' };

  for (const [node, codes] of [[args[1], returns], [args[4], restriction]] as const) {
    const bad = codes ? [...codes].find((c) => c !== ';' && !(c in TYPE_LABEL)) : undefined;
    if (node && bad) return { node, message: `Unknown type code "${bad}" (valid: ${Object.keys(TYPE_LABEL).join(' ')})` };
  }

  const name = nameNode.text;
  return { name, nameNode, signature: signatureOf(name, returns, min, max, restriction) };
}

/**
 * A string constant without quotes.
 *
 * @param node - A field of a `defudf` line.
 * @returns The contents, or `null` if it isn't a string.
 */
function stringField(node: SyntaxNode): string | null {
  const leaf = node.type === 'constant' ? node.firstChild : null;
  return leaf?.type === 'string' ? leaf.text.slice(1, -1) : null;
}

/**
 * A non-negative integer.
 *
 * @param node - A field of a `defudf` line.
 * @returns The value, or `null` if it isn't one.
 */
function integerField(node: SyntaxNode): number | null {
  return /^\d+$/.test(node.text) ? Number(node.text) : null;
}

/**
 * A host function as a built-in entry. Unknown parts are `null`; the `"*"`
 * return type `dump.clp` writes counts as unknown.
 *
 * @param name - The function name.
 * @param returns - The return type codes.
 * @param min - Minimum argument count.
 * @param max - Maximum argument count.
 * @param restriction - The argument type string.
 * @returns The entry.
 */
function signatureOf(
  name: string,
  returns: string | null,
  min: number | null,
  max: number | 'UNBOUNDED' | null,
  restriction: string | null
): BuiltinFunction {
  const known = min !== null && max !== null;
  const types = known ? perArgumentTypes(min, max, restriction) : null;
  const returnTypes = returns && returns !== '*' ? [...new Set([...returns].map((c) => TYPE_LABEL[c]))] : null;
  return {
    name,
    section: null,
    title: null,
    page: null,
    description: 'A function the program that embeds CLIPS registers with AddUDF.',
    syntax: known ? synthesizeSyntax(name, min, max, restriction) : null,
    syntax_source: known ? 'synthesized-from-source' : null,
    min_args: min === null ? null : String(min),
    max_args: max === null ? null : String(max),
    return_types: returnTypes,
    source_file: null,
    arg_types: types?.positions ?? null,
    variadic_type: types?.variadic ?? null
  };
}

// The decoding below mirrors scripts/extract-builtins/extract_source_signatures.py,
// so host functions read like the built-ins generated from the CLIPS source.

/**
 * Type codes as a label, e.g. "ld" -> "numeric".
 *
 * @param chars - AddUDF type codes.
 * @returns The label; `expression` if empty.
 */
function decodeTypeChars(chars: string): string {
  if (!chars) return 'expression';
  const letters = [...new Set(chars)].sort();
  if (letters.length === 2 && letters[0] === 'd' && letters[1] === 'l') return 'numeric';
  return [...new Set(letters.map((c) => TYPE_LABEL[c] ?? c))].join('|');
}

/**
 * Label of argument `position` in a restriction string; segment 0 is the default.
 *
 * @param restriction - The argument type string, or `null` for none.
 * @param position - The argument position, 1-based.
 * @returns The label.
 */
function decodeRestriction(restriction: string | null, position: number): string {
  if (restriction === null) return 'expression';
  const segments = restriction.split(';');
  if (position < segments.length && segments[position]) return decodeTypeChars(segments[position]);
  return decodeTypeChars(segments[0] ?? '');
}

/**
 * Argument types per required position, and of the repeating last argument.
 *
 * @param min - Minimum argument count.
 * @param max - Maximum argument count.
 * @param restriction - The argument type string.
 * @returns The labels; `variadic` is `null` if there are no optional arguments.
 */
function perArgumentTypes(min: number, max: number | 'UNBOUNDED', restriction: string | null): { positions: string[]; variadic: string | null } {
  const positions: string[] = [];
  for (let pos = 1; pos <= min; pos++) positions.push(decodeRestriction(restriction, pos));
  const variadic = max === 'UNBOUNDED' || max > min ? decodeRestriction(restriction, min + 1) : null;
  return { positions, variadic };
}

/**
 * A syntax token for a type label, e.g. `<integer-expression>`.
 *
 * @param label - The type label.
 * @returns The token.
 */
function token(label: string): string {
  return label === 'expression' ? '<expression>' : `<${label}-expression>`;
}

/**
 * A syntax line, e.g. "(distance <numeric-expression> ...)".
 *
 * @param name - The function name.
 * @param min - Minimum argument count.
 * @param max - Maximum argument count.
 * @param restriction - The argument type string.
 * @returns The line.
 */
function synthesizeSyntax(name: string, min: number, max: number | 'UNBOUNDED', restriction: string | null): string {
  const tokens: string[] = [];
  for (let pos = 1; pos <= min; pos++) tokens.push(token(decodeRestriction(restriction, pos)));
  if (max === 'UNBOUNDED' || max > min) {
    const tail = token(decodeRestriction(restriction, min + 1));
    if (min === 0) tokens.push(`${tail}*`);
    else tokens[tokens.length - 1] += '+';
  }
  return tokens.length === 0 ? `(${name})` : `(${name} ${tokens.join(' ')})`;
}
