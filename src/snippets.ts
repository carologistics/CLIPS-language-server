/**
 * @file Completion snippets. The `(` is already typed, so no snippet starts
 * with one; callers pass `close` when the closing `)` is still missing.
 */

import type { SyntaxNode } from 'tree-sitter';
import type { BuiltinFunction } from './builtins.js';

/**
 * Escapes text for snippet syntax (`progn$` contains a `$`).
 *
 * @param text - Plain text.
 * @returns The escaped text.
 */
export function escapeSnippet(text: string): string {
  return text.replace(/[\\$}]/g, '\\$&');
}

/** Snippet bodies by keyword; `$0` is the final cursor position. */
const KEYWORD_SNIPPETS: Record<string, string> = {
  defrule: 'defrule ${1:name}\n  ${2:pattern}\n  =>\n  $0',
  deftemplate: 'deftemplate ${1:name}\n  (slot ${2:slot-name})$0',
  deffacts: 'deffacts ${1:name}\n  $0',
  deffunction: 'deffunction ${1:name} ($2)\n  $0',
  defgeneric: 'defgeneric ${1:name}$0',
  defmethod: 'defmethod ${1:name} ($2)\n  $0',
  defclass: 'defclass ${1:Name} (is-a ${2:USER})\n  (slot ${3:slot-name})$0',
  'defmessage-handler': 'defmessage-handler ${1:class} ${2:message} ($3)\n  $0',
  definstances: 'definstances ${1:name}\n  ([${2:instance}] of ${3:class})$0',
  defglobal: 'defglobal ?*${1:name}* = ${2:value}$0',
  defmodule: 'defmodule ${1:NAME}\n  (export ?ALL)$0',
  if: 'if ${1:condition} then\n  $0',
  'progn$': 'progn\\$ (?${1:item} ${2:list})\n  $0',
  'loop-for-count': 'loop-for-count (?${1:i} ${2:1} ${3:10})\n  $0',
  foreach: 'foreach ?${1:item} ${2:list}\n  $0',
  while: 'while ${1:condition}\n  $0',
  // The manual syntax of these doesn't give a usable snippet.
  bind: 'bind ?${1:var} ${2:value}',
  retract: 'retract ${1:?f}',
  assert: 'assert (${1:fact})',
  'make-instance': 'make-instance [${1:name}] of ${2:class}',
  'active-make-instance': 'active-make-instance [${1:name}] of ${2:class}'
};

for (const query of ['do-for-fact', 'do-for-all-facts', 'delayed-do-for-all-facts']) {
  KEYWORD_SNIPPETS[query] = `${query} ((?\${1:f} \${2:template})) \${3:TRUE}\n  $0`;
}
for (const query of ['any-factp', 'find-fact', 'find-all-facts']) {
  KEYWORD_SNIPPETS[query] = `${query} ((?\${1:f} \${2:template})) \${3:TRUE}$0`;
}
for (const query of ['do-for-instance', 'do-for-all-instances', 'delayed-do-for-all-instances']) {
  KEYWORD_SNIPPETS[query] = `${query} ((?\${1:i} \${2:class})) \${3:TRUE}\n  $0`;
}
for (const query of ['any-instancep', 'find-instance', 'find-all-instances']) {
  KEYWORD_SNIPPETS[query] = `${query} ((?\${1:i} \${2:class})) \${3:TRUE}$0`;
}

/**
 * Adds `$0` if missing, and the closing paren if `close`.
 *
 * @param body - The snippet so far.
 * @param close - Whether to add the closing paren.
 * @returns The snippet.
 */
function finish(body: string, close: boolean): string {
  const withEnd = body.includes('$0') ? body : `${body}$0`;
  return close ? `${withEnd})` : withEnd;
}

/**
 * A name followed by one placeholder per argument.
 *
 * @param name - The function name.
 * @param args - The argument placeholders' texts.
 * @param close - Whether to add the closing paren.
 * @returns The snippet.
 */
function withArguments(name: string, args: string[], close: boolean): string {
  const placeholders = args.map((arg, i) => ` \${${i + 1}:${escapeSnippet(arg)}}`).join('');
  return finish(escapeSnippet(name) + placeholders, close);
}

/**
 * The snippet for a keyword.
 *
 * @param keyword - The keyword.
 * @param close - Whether to add the closing paren.
 * @returns The snippet, or `null` if it has none.
 */
export function keywordSnippet(keyword: string, close: boolean): string | null {
  const body = KEYWORD_SNIPPETS[keyword];
  return body ? finish(body, close) : null;
}

/**
 * The first complete form in a syntax text, whitespace collapsed. Manual
 * entries may span lines or list several variants.
 *
 * @param syntax - A syntax text from the manual.
 * @returns The form; the whole text if it never closes.
 */
function firstForm(syntax: string): string {
  const flat = syntax.replace(/\s+/g, ' ').trim();
  let depth = 0;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === '(') depth++;
    else if (flat[i] === ')' && --depth === 0) return flat.slice(0, i + 1);
  }
  return flat;
}

/**
 * Required arguments of a manual syntax form. `<x>*` and `[...]` are
 * skipped, `<x>+` counts once, bare words like `of` are kept.
 *
 * @param syntax - A syntax text from the manual.
 * @param name - The function name the form must start with.
 * @returns The arguments, or `null` for anything more complex (alternatives, nested groups).
 */
export function requiredArguments(syntax: string, name: string): string[] | null {
  const line = firstForm(syntax);
  const head = `(${name}`;
  if (!line.startsWith(head) || !line.endsWith(')')) return null;
  const inner = line.slice(head.length, -1).trim();
  if (inner === '') return [];

  const tokens: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    if (ch === ']' || ch === ')' || ch === '}') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  const args: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('[')) continue;
    const placeholder = /^<([^<>]+)>([*+]?)$/.exec(token);
    if (placeholder) {
      if (placeholder[2] !== '*') args.push(placeholder[1]);
      continue;
    }
    if (/^[A-Za-z][\w-]*$/.test(token)) {
      args.push(token);
      continue;
    }
    return null;
  }
  return args;
}

/**
 * Snippet for a built-in call, from its documented syntax.
 *
 * @param name - The function name.
 * @param entry - Its built-in entry.
 * @param close - Whether to add the closing paren.
 * @returns The snippet.
 */
export function builtinSnippet(name: string, entry: BuiltinFunction, close: boolean): string {
  const special = keywordSnippet(name, close);
  if (special) return special;
  const args = entry.syntax ? requiredArguments(entry.syntax, name) : null;
  return withArguments(name, args ?? [], close);
}

/**
 * Snippet for a deffunction call, one placeholder per required parameter.
 *
 * @param name - The function name.
 * @param deffunction - The `deffunction_construct` node.
 * @param close - Whether to add the closing paren.
 * @returns The snippet.
 */
export function deffunctionSnippet(name: string, deffunction: SyntaxNode, close: boolean): string {
  const params = deffunction.descendantsOfType('regular_parameter').filter((p) => p.parent?.id === deffunction.id);
  return withArguments(name, params.map((p) => p.text), close);
}

/**
 * Snippet for a `switch` clause: `case` or `default`.
 *
 * @param clause - The clause keyword.
 * @param close - Whether to add the closing paren.
 * @returns The snippet.
 */
export function switchClauseSnippet(clause: 'case' | 'default', close: boolean): string {
  return finish(clause === 'case' ? 'case ${1:value} then\n  $0' : 'default\n  $0', close);
}

/**
 * Snippet for a slot: its name, then the value.
 *
 * @param name - The slot name.
 * @param close - Whether to add the closing paren.
 * @returns The snippet.
 */
export function slotSnippet(name: string, close: boolean): string {
  return finish(`${escapeSnippet(name)} $0`, close);
}

/**
 * A plain name, plus the closing paren if needed.
 *
 * @param name - The name.
 * @param close - Whether to add the closing paren.
 * @returns The snippet.
 */
export function nameSnippet(name: string, close: boolean): string {
  return finish(escapeSnippet(name), close);
}
