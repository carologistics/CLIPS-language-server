/**
 * @file The tree-sitter language and its query sources, in a module of their
 * own so parsing.ts and symbolTable.ts can share them without a cycle.
 */

import { readFileSync } from 'node:fs';
import Parser from 'tree-sitter';
import Clips from 'tree-sitter-clips';

/**
 * The CLIPS language, for `Parser.setLanguage` and `Parser.Query`. The
 * binding's typings don't match `Parser.Language`, hence the cast.
 */
export const CLIPS_LANGUAGE = Clips as unknown as Parser.Language;

/**
 * Reads a query source from the binding.
 *
 * @param name - The binding property.
 * @returns The `.scm` source.
 * @throws If the binding doesn't provide the query.
 */
function queryText(name: 'LOCALS_QUERY' | 'TAGS_QUERY'): string {
  const text = (Clips as unknown as Record<string, string | undefined>)[name];
  if (!text) throw new Error(`tree-sitter-clips did not expose ${name}`);
  return text;
}

/** Source of `locals.scm`, used by {@link findLocalDefinitions}. */
export const LOCALS_QUERY_SOURCE = queryText('LOCALS_QUERY');
/** Source of `tags.scm`, used by {@link buildSymbolTable}. */
export const TAGS_QUERY_SOURCE = queryText('TAGS_QUERY');

/**
 * The grammar's keywords (`defrule`, `slot`, `SYMBOL`, `?NONE`, ...), read
 * from its `grammar.json`. Completion uses them to pick keywords out of the
 * tokens the parser expects. Empty if the file can't be read.
 */
export const KEYWORD_LITERALS: ReadonlySet<string> = loadKeywordLiterals();

/**
 * Collects the keyword strings from the grammar's `grammar.json`.
 *
 * @returns The keywords; empty if the file can't be read.
 */
function loadKeywordLiterals(): Set<string> {
  const keywords = new Set<string>();
  try {
    const bindingUrl = import.meta.resolve('tree-sitter-clips');
    const grammar = JSON.parse(readFileSync(new URL('../../src/grammar.json', bindingUrl), 'utf8'));
    /** Adds every keyword-like `STRING` rule below `value`. */
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === 'object') {
        const rule = value as { type?: unknown; value?: unknown };
        if (rule.type === 'STRING' && typeof rule.value === 'string' && /^[A-Za-z?]/.test(rule.value)) {
          keywords.add(rule.value);
        }
        for (const child of Object.values(value)) visit(child);
      }
    };
    visit(grammar.rules);
  } catch {
    // No keyword suggestions then.
  }
  return keywords;
}
