/**
 * @file Completion and completion resolve.
 *
 * While typing, the open form usually parses as an ERROR, so each request
 * parses a repaired copy instead: the top-level form up to the cursor, a
 * placeholder for the word being typed, and a `)` for every open paren.
 * The placeholder's ancestors tell what kind of name goes there; the
 * parser's lookahead gives the keywords allowed there.
 */

import Parser, { type SyntaxNode, type Tree } from 'tree-sitter';
import {
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
  type CompletionItem,
  type Position,
  type Range
} from 'vscode-languageserver/node.js';
import { BUILTIN_FUNCTIONS, builtinArgumentAt } from './builtins.js';
import {
  allHandlers,
  attributeClasses,
  BUILTIN_CLASSES,
  classAncestry,
  classSlots,
  constrainedBy,
  findClassSlot,
  isConcreteClass,
  isDefclassSuperclassName,
  isMatchableClass,
  isObjectPatternClass,
  slotAccessors,
  slotOverrideClasses,
  SYSTEM_HANDLERS,
  variableReferent
} from './classes.js';
import { render, renderBuiltin, renderExternal, renderHostFunction, type HoverContext } from './hover.js';
import { externalKey, isDeclarationFile, type ExternalKind } from './declarations.js';
import { CLIPS_LANGUAGE, KEYWORD_LITERALS } from './language.js';
import { isDeclarationPosition, visibleVariables, type VisibleVariable } from './locals.js';
import { parseText } from './parsing.js';
import {
  findSlotDefinition,
  resolveFactActionTemplate,
  resolveRhsPatternSlot,
  resolveTemplateSlot,
  slotConstraints
} from './slots.js';
import {
  builtinSnippet,
  deffunctionSnippet,
  keywordSnippet,
  nameSnippet,
  slotSnippet,
  switchClauseSnippet
} from './snippets.js';
import { nameKey, type NameUse, type SymbolEntry, type SymbolTable } from './symbolTable.js';
import { displayName, uriKey } from './uri.js';

/** Placeholder for the word being typed. */
const MARKER = 'clipsCompletionMarker';

/** `(` plus a construct keyword in column 0 starts a new form, even if the last one is unclosed. */
const CONSTRUCT_START = /^\((?:defrule|deftemplate|deffacts|defglobal|deffunction|defgeneric|defmethod|defclass|defmessage-handler|definstances|defmodule)(?=[\s;)]|$)/;

/** Characters of the word being completed, including a variable's `?`. */
const WORD_CHAR = /[A-Za-z0-9_\-/+$*#'%<>=?]/;

/** Lookaheads this large only occur in the error state and say nothing. */
const GENERIC_LOOKAHEAD_SIZE = 100;

/** Sort groups, lowest first. Construct keywords come first at the head of a top-level form. */
const GROUP = { construct: '0', local: '1', thisFile: '2', otherFile: '3', builtin: '4', keyword: '5' } as const;

/** Options from client capabilities and settings. */
export interface CompletionOptions {
  /** Snippets are supported and enabled. */
  snippets: boolean;
  /** No load links the document to other files; their items say so. */
  unlinked?: boolean;
}

/**
 * Lets resolve find what an item describes: `uri` is the completed
 * document, `name` the item's name.
 */
export type CompletionData =
  /** A built-in function. */
  | { uri: string; type: 'builtin'; name: string }
  /** A host function from a declaration file. */
  | { uri: string; type: 'host'; name: string }
  /** A name declared by `(defexternal <kind> <name>)`. */
  | { uri: string; type: 'external'; kind: ExternalKind; name: string }
  /** A user construct. */
  | { uri: string; type: 'construct'; category: 'template' | 'class' | 'function' | 'global'; name: string }
  /** A template slot. */
  | { uri: string; type: 'slot'; template: string; name: string }
  /** A class slot. */
  | { uri: string; type: 'classSlot'; className: string; name: string }
  /** A message handler of a class. */
  | { uri: string; type: 'handler'; className: string; name: string };

// Finding the cursor's form and word

/** Result of {@link scan}. */
interface Scan {
  /** The `(` of the enclosing top-level form. */
  topStart: number;
  /** Parens still open, counted from `topStart`. */
  depth: number;
  /** `end` is inside a string. */
  inString: boolean;
  /** `end` is inside a comment. */
  inComment: boolean;
}

/**
 * Whether the `(` at `i` starts a construct in column 0.
 *
 * @param text - The document text.
 * @param i - Offset of a `(`.
 */
function startsConstruct(text: string, i: number): boolean {
  return (i === 0 || text[i - 1] === '\n') && CONSTRUCT_START.test(text.slice(i, i + 24));
}

/**
 * Finds the top-level form around `end` and its open paren count,
 * skipping strings and comments. Constructs never nest, so a construct in
 * column 0 starts a new form at any depth.
 *
 * @param text - The document text.
 * @param end - The cursor offset.
 * @returns The form's start (-1 if none), depth and lexical state at `end`.
 */
function scan(text: string, end: number): Scan {
  let topStart = -1;
  let depth = 0;
  let inString = false;
  let inComment = false;
  for (let i = 0; i < end; i++) {
    const ch = text[i];
    if (inComment) {
      if (ch === '\n') inComment = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === ';') inComment = true;
    else if (ch === '"') inString = true;
    else if (ch === '(') {
      if (depth === 0 || startsConstruct(text, i)) {
        topStart = i;
        depth = 0;
      }
      depth++;
    } else if (ch === ')') {
      if (depth > 0) depth--;
    }
  }
  return { topStart, depth, inString, inComment };
}

/**
 * Whether the form at `topStart` is closed before the text ends or a new construct starts.
 *
 * @param text - The document text.
 * @param topStart - Offset of the form's `(`.
 */
function formIsClosed(text: string, topStart: number): boolean {
  let depth = 0;
  let inString = false;
  let inComment = false;
  for (let i = topStart; i < text.length; i++) {
    const ch = text[i];
    if (inComment) {
      if (ch === '\n') inComment = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === ';') inComment = true;
    else if (ch === '"') inString = true;
    else if (ch === '(') {
      if (i > topStart && depth > 0 && startsConstruct(text, i)) return false;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

/**
 * Whether only blanks follow the word, then `)` or a line end, so a snippet won't duplicate arguments.
 *
 * @param text - The document text.
 * @param offset - The cursor offset.
 */
function nothingFollows(text: string, offset: number): boolean {
  let i = offset;
  while (i < text.length && WORD_CHAR.test(text[i])) i++;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i >= text.length || text[i] === ')' || text[i] === '\n' || text[i] === '\r';
}

/** The variable prefix of a word: none, `?`, `$?` or `?*`. */
type Sigil = 'none' | 'single' | 'multi' | 'global';

/**
 * The variable prefix of the word being typed.
 *
 * @param word - The word.
 * @returns The prefix kind.
 */
function sigilOf(word: string): Sigil {
  if (word.startsWith('?*')) return 'global';
  if (word.startsWith('$?')) return 'multi';
  if (word.startsWith('?')) return 'single';
  return 'none';
}

// Step 3–4: parse the repaired copy and classify the position

/**
 * What goes at the cursor. In variants with `at` and `scope`, they are the
 * placeholder and the root of the repaired copy, for the visible variables.
 */
type Context =
  /** Nothing. */
  | { kind: 'none' }
  /** A variable, after `?` or `$?`. */
  | { kind: 'variable'; at: SyntaxNode; scope: SyntaxNode }
  /** A call head: functions, special forms and, at the top level, constructs. */
  | { kind: 'callHead' }
  /** An LHS pattern head: templates, ordered facts and CE keywords. */
  | { kind: 'patternHead' }
  /** A fact head; with `facts` also ordered fact names (not in queries). */
  | { kind: 'template'; facts: boolean }
  /** Template slots; `inParens` for `(slot ...)` as opposed to `?f:slot`. */
  | { kind: 'slot'; templates: SymbolEntry[]; inParens: boolean }
  /** Class slots (`null`: all classes); `objectPattern` adds `is-a` and `name`. */
  | { kind: 'classSlot'; classes: string[] | null; inParens: boolean; objectPattern: boolean }
  /**
   * A value: allowed values, variables, and globals except in LHS patterns.
   * `extra` adds words such as `do` after a while condition or `crlf`.
   */
  | { kind: 'value'; at: SyntaxNode; scope: SyntaxNode; allowed: string[]; globals: boolean; extra?: string[] }
  /** A module name; `exclude` is the module being defined. */
  | { kind: 'module'; exclude: string | null }
  /** A construct in an import/export item. */
  | { kind: 'portConstruct'; constructType: string }
  /** An I/O logical name. */
  | { kind: 'logicalName'; input: boolean }
  /** A `send` message for these classes (`null`: unknown). */
  | { kind: 'message'; classes: string[] | null }
  /** A class name, filtered by `purpose`. */
  | { kind: 'class'; purpose: ClassPurpose }
  /** A defmethod name: generics and built-ins, not deffunctions. */
  | { kind: 'generic' }
  /** A `switch` clause: `case` or `default`. */
  | { kind: 'switchClause' }
  /** Only keywords the grammar allows here. */
  | { kind: 'keywords' }
  /** Unknown position: everything that might fit (`at` is `null` when there are no variables). */
  | { kind: 'fallback'; at: SyntaxNode | null; scope: SyntaxNode | null };

/** Which classes fit: any, those `make-instance` accepts, or those an object pattern can match. */
type ClassPurpose = 'any' | 'instantiable' | 'matchable';

/**
 * Whether a constant is a value directly in an LHS pattern, where CLIPS rejects globals.
 *
 * @param constant - A `constant` node.
 */
function inLhsPatternValue(constant: SyntaxNode): boolean {
  const owner = constrainedBy(constant);
  return (
    owner?.type === 'single_field_LHS_slot' ||
    owner?.type === 'multifield_LHS_slot' ||
    owner?.type === 'ordered_pattern_CE' ||
    owner?.type === 'attribute_constraint'
  );
}

/** Logical names that work without `open`; others give [ROUTER1]. */
const OUTPUT_LOGICAL_NAMES = ['t', 'stdout', 'stderr', 'stdwrn'];
/** Logical names that work for input without `open`. */
const INPUT_LOGICAL_NAMES = ['t', 'stdin'];
/** Functions whose first argument is an input logical name. */
const INPUT_FUNCTIONS = new Set(['read', 'readline', 'read-number', 'get-char']);
/** Symbols the print functions print as characters (BPG 12.4.2.2). */
const PRINT_SYMBOLS = ['crlf', 'tab', 'vtab', 'ff'];
/** Leading arguments that aren't printed (printout's logical name). */
const PRINT_FUNCTIONS: Record<string, number> = { printout: 1, print: 0, println: 0 };

/**
 * Whether a call is a clause of a `switch`.
 *
 * @param call - A `function_call` node.
 */
function isSwitchClause(call: SyntaxNode): boolean {
  const outer = call.parent;
  if (outer?.type !== 'function_call') return false;
  const args = outer.namedChildren;
  return args[0]?.type === 'function_name' && args[0].text === 'switch' && args.indexOf(args.find((a) => a.id === call.id)!) > 1;
}

/**
 * The deepest node at `offset`.
 *
 * @param tree - The tree.
 * @param offset - The offset.
 * @returns The leaf.
 */
function leafAt(tree: Tree, offset: number): SyntaxNode {
  let node = tree.rootNode.descendantForIndex(offset, offset);
  while (node.childCount > 0) {
    const child = node.children.find((c) => c.startIndex <= offset && offset < c.endIndex);
    if (!child) break;
    node = child;
  }
  return node;
}

/** Number of terminal symbols; the root's type id is the first nonterminal. */
let tokenCount: number | null = null;

/**
 * Keywords allowed in a parse state, and whether a symbol is allowed too.
 *
 * @param state - A parse state id.
 * @returns The keywords and the symbol flag, or `null` if the state is invalid.
 */
function lookahead(state: number): { keywords: string[]; acceptsSymbol: boolean } | null {
  tokenCount ??= parseText('').rootNode.typeId;
  let iterator: Parser.LookaheadIterator;
  try {
    iterator = new Parser.LookaheadIterator(CLIPS_LANGUAGE, state);
  } catch {
    return null;
  }
  const keywords: string[] = [];
  let acceptsSymbol = false;
  let count = 0;
  for (const name of iterator) {
    count++;
    if (iterator.currentTypeId >= tokenCount) continue;
    if (name === 'symbol' || name === 'symbol_token1') acceptsSymbol = true;
    else if (KEYWORD_LITERALS.has(name)) keywords.push(name);
  }
  if (count >= GENERIC_LOOKAHEAD_SIZE) return null;
  return { keywords: [...new Set(keywords)], acceptsSymbol };
}

/**
 * The slot definition a constant is a value of.
 *
 * @param constant - A `constant` node.
 * @param scope - The lookup scope.
 * @returns The definition, or `null` if unknown.
 */
function valueSlot(constant: SyntaxNode, scope: SymbolTable): SyntaxNode | null {
  const owner = constrainedBy(constant);

  // (sensor (status ok)) on the LHS
  if (owner && (owner.type === 'single_field_LHS_slot' || owner.type === 'multifield_LHS_slot')) {
    return resolveTemplateSlot(owner, scope)?.slotDefinition ?? null;
  }

  // (object (is-a C) (color red))
  if (owner?.type === 'attribute_constraint' && owner.children[1]?.type === 'name') {
    return findClassSlot(attributeClasses(owner), nameKey(owner.children[1]), scope)?.node ?? null;
  }

  // (assert (sensor (status ok)))
  const parent = constant.parent;
  if (parent?.type === 'function_call') {
    return resolveRhsPatternSlot(parent, scope)?.slotDefinition ?? null;
  }

  // (modify ?f (status ok))
  if (parent?.type === 'RHS_field') {
    const slot = parent.parent;
    const factAction = slot?.parent?.parent;
    const slotName = slot?.children.find((c) => c.type === 'name');
    if (slotName && factAction?.type === 'fact_action') {
      const template = resolveFactActionTemplate(factAction, scope);
      return template ? findSlotDefinition(template.definitionNode, nameKey(slotName)) : null;
    }
  }
  return null;
}

/**
 * Classifies the placeholder's position from its ancestors.
 *
 * @param marker - The placeholder symbol, or its variable node after `?`/`$?`.
 * @param scope - The lookup scope.
 * @param root - Root of the repaired copy.
 * @param keywordOnly - Keywords are allowed here but no plain symbol.
 * @returns The completion context.
 */
function classify(marker: SyntaxNode, scope: SymbolTable, root: SyntaxNode, keywordOnly: boolean): Context {
  if (marker.type === 'single_field_variable' || marker.type === 'multifield_variable') {
    return isDeclarationPosition(marker) ? { kind: 'none' } : { kind: 'variable', at: marker, scope: root };
  }

  const parent = marker.type === 'symbol' ? marker.parent : null;
  if (!parent) return keywordOnly ? { kind: 'keywords' } : { kind: 'fallback', at: null, scope: null };

  switch (parent.type) {
    case 'function_name': {
      // In an asserted fact of a known deftemplate, a nested form is a slot.
      const slot = parent.parent ? resolveRhsPatternSlot(parent.parent, scope) : null;
      if (slot) return { kind: 'slot', templates: [slot.owner], inParens: true };
      return parent.parent && isSwitchClause(parent.parent) ? { kind: 'switchClause' } : { kind: 'callHead' };
    }

    case 'name':
      return classifyName(parent, scope, keywordOnly);

    case 'constant': {
      const owner = parent.parent;
      if (owner?.type === 'instance_definition' && parent.previousSibling?.type === 'of') return { kind: 'class', purpose: 'instantiable' };
      if (isObjectPatternClass(parent)) return { kind: 'class', purpose: 'matchable' };

      if (owner?.type === 'slot_override') {
        const classes = slotOverrideClasses(owner, scope);
        const slotNameNode = owner.namedChildren[0];
        if (slotNameNode?.id === parent.id) return { kind: 'classSlot', classes, inParens: true, objectPattern: false };
        const slot = slotNameNode ? findClassSlot(classes, slotNameNode.text, scope) : null;
        return { kind: 'value', at: marker, scope: root, allowed: allowedValues(slot?.node ?? null), globals: true };
      }

      if (owner?.type === 'function_call') {
        const args = owner.namedChildren;
        const head = args[0]?.type === 'function_name' ? args[0].text : null;
        const index = args.findIndex((a) => a.id === parent.id);
        if (head === 'send' && index === 2) {
          const receiver = args[1]?.type === 'variable' ? args[1].firstChild : null;
          const classes = receiver ? (variableReferent(receiver, scope)?.classes ?? []) : [];
          return { kind: 'message', classes: classes.length > 0 ? classes : null };
        }
        const argument = builtinArgumentAt(parent, scope);
        switch (argument?.role) {
          case 'class':
            return { kind: 'class', purpose: 'any' };
          case 'template':
            return { kind: 'template', facts: false };
          case 'module':
            return { kind: 'module', exclude: null };
          case 'logicalName':
            return { kind: 'logicalName', input: INPUT_FUNCTIONS.has(argument.functionName) };
          case 'slot': {
            if (argument.classLiteral) return { kind: 'classSlot', classes: [argument.classLiteral], inParens: false, objectPattern: false };
            const template = argument.templateLiteral ? scope.templates.get(argument.templateLiteral) : undefined;
            if (template) return { kind: 'slot', templates: [template], inParens: false };
            break;
          }
        }
        const extra =
          head === 'while' && index === 2
            ? ['do']
            : head !== null && head in PRINT_FUNCTIONS && index > PRINT_FUNCTIONS[head]
              ? PRINT_SYMBOLS
              : [];
        if (extra.length > 0) return { kind: 'value', at: marker, scope: root, allowed: [], globals: true, extra };
      }

      return {
        kind: 'value',
        at: marker,
        scope: root,
        allowed: allowedValues(valueSlot(parent, scope)),
        globals: !inLhsPatternValue(parent)
      };
    }

    default:
      return keywordOnly ? { kind: 'keywords' } : { kind: 'fallback', at: marker, scope: root };
  }
}

/**
 * Classifies a placeholder that parsed as a `name`.
 *
 * @param nameNode - The placeholder's `name` node.
 * @param scope - The lookup scope.
 * @param keywordOnly - Keywords are allowed here but no plain symbol.
 * @returns The completion context.
 */
function classifyName(nameNode: SyntaxNode, scope: SymbolTable, keywordOnly: boolean): Context {
  const context = nameNode.parent;
  if (!context) return { kind: 'none' };
  const isFirstName = context.children.find((c) => c.type === 'name')?.id === nameNode.id;

  switch (context.type) {
    case 'ordered_pattern_CE':
    case 'template_pattern_CE':
      return isFirstName ? { kind: 'patternHead' } : { kind: 'none' };
    case 'ordered_RHS_pattern':
    case 'template_RHS_pattern':
      return { kind: 'template', facts: true };
    case 'fact_set_member_template':
      return { kind: 'template', facts: false };
    case 'port_specification': {
      // (defmodule B (import |
      const own = context.parent?.children.find((c) => c.type === 'name');
      return { kind: 'module', exclude: own ? nameKey(own) : null };
    }
    case 'port_item': {
      const constructType = context.children.find((c) => c.type === 'port_construct')?.text;
      return constructType ? { kind: 'portConstruct', constructType } : { kind: 'none' };
    }
    case 'instance_set_member_template':
    case 'parameter_restriction':
    case 'wildcard_parameter_restriction':
      return { kind: 'class', purpose: 'any' };
    case 'single_field_LHS_slot':
    case 'multifield_LHS_slot': {
      const slot = resolveTemplateSlot(context, scope);
      return slot ? { kind: 'slot', templates: [slot.owner], inParens: true } : { kind: 'none' };
    }
    case 'single_field_RHS_slot':
    case 'multifield_RHS_slot': {
      const factAction = context.parent?.parent;
      const owner = factAction?.type === 'fact_action' ? resolveFactActionTemplate(factAction, scope) : null;
      return owner ? { kind: 'slot', templates: [owner], inParens: true } : { kind: 'none' };
    }
    case 'attribute_constraint':
      return { kind: 'classSlot', classes: attributeClasses(context), inParens: true, objectPattern: true };
    case 'special_variable': {
      // ?f:slot, ?self:slot
      const variable = context.children.find((c) => c.type === 'symbol');
      const referent = variable ? variableReferent(variable, scope) : null;
      if (!referent) return { kind: 'none' };
      if (referent.templates.length > 0) return { kind: 'slot', templates: referent.templates, inParens: false };
      return { kind: 'classSlot', classes: referent.classes, inParens: false, objectPattern: false };
    }
    case 'defclass_construct':
      return isDefclassSuperclassName(nameNode, context) ? { kind: 'class', purpose: 'any' } : { kind: 'none' };
    case 'defmessage_handler_construct':
      return isFirstName ? { kind: 'class', purpose: 'any' } : { kind: 'none' };
    case 'defmethod_construct':
      return { kind: 'generic' };
    case 'ERROR': {
      // E.g. "(defmethod area" before the parameter list: only the keyword tells.
      const keyword = nameNode.previousSibling?.type;
      if (keyword === 'defmethod') return { kind: 'generic' };
      if (keyword === 'defmessage-handler') return { kind: 'class', purpose: 'any' };
      return { kind: 'none' };
    }
    default:
      return keywordOnly ? { kind: 'keywords' } : { kind: 'none' }; // a new name is being defined
  }
}

/**
 * A slot's `allowed-*` values.
 *
 * @param slotDefinition - The slot definition, or `null`.
 * @returns The values; empty if none are declared.
 */
function allowedValues(slotDefinition: SyntaxNode | null): string[] {
  return slotDefinition ? (slotConstraints(slotDefinition).allowedValues ?? []) : [];
}

// Step 5–7: candidates and items

/** How snippets are inserted; `null` for plain names. */
interface SnippetPlan {
  /** Whether to add the closing paren. */
  close: boolean;
}

/** Collects items; the first per label wins. */
class Items {
  /** Items by label. */
  private readonly byLabel = new Map<string, CompletionItem>();

  /** @param unlinked - See {@link CompletionOptions.unlinked}. */
  constructor(
    private readonly range: Range,
    readonly unlinked = false
  ) {}

  /**
   * Adds an item unless one with the same label exists.
   *
   * @param label - The label.
   * @param kind - The item kind.
   * @param group - The sort group.
   * @param detail - The detail text.
   * @param data - Data for resolve.
   * @param snippet - Snippet text, if any.
   */
  add(label: string, kind: CompletionItemKind, group: string, detail?: string, data?: CompletionData, snippet?: string | null): void {
    if (this.byLabel.has(label)) return;
    const item: CompletionItem = {
      label,
      kind,
      detail,
      sortText: `${group}${label}`,
      textEdit: { range: this.range, newText: snippet ?? label },
      data
    };
    if (snippet) item.insertTextFormat = InsertTextFormat.Snippet;
    this.byLabel.set(label, item);
  }

  /**
   * The collected items.
   *
   * @returns The items in insertion order.
   */
  list(): CompletionItem[] {
    return [...this.byLabel.values()];
  }
}

/**
 * Sort group and detail suffix for where a construct is defined.
 *
 * @param entry - The construct.
 * @param uri - The document being completed.
 * @param items - The item list, for its `unlinked` flag.
 * @returns The group and the suffix (empty for this file).
 */
function where(entry: SymbolEntry, uri: string, items: Items): { group: string; suffix: string } {
  if (uriKey(entry.uri) === uriKey(uri)) return { group: GROUP.thisFile, suffix: '' };
  // The host program defines it: no load chain is involved.
  if (isDeclarationFile(entry.uri)) return { group: GROUP.otherFile, suffix: ` · ${displayName(entry.uri)} (host program)` };
  const note = items.unlinked ? ' (not linked by any load)' : '';
  return { group: GROUP.otherFile, suffix: ` · ${displayName(entry.uri)}${note}` };
}

/**
 * Adds the deftemplates.
 *
 * @param items - The items.
 * @param scope - The lookup scope.
 * @param uri - The document's URI.
 */
function addTemplates(items: Items, scope: SymbolTable, uri: string): void {
  for (const [name, entry] of scope.templates) {
    const { group, suffix } = where(entry, uri, items);
    items.add(name, CompletionItemKind.Struct, group, `deftemplate${suffix}`, { uri, type: 'construct', category: 'template', name });
  }
  addExternals(items, scope, uri, 'deftemplate', CompletionItemKind.Struct);
}

/**
 * Names declared by `(defexternal <kind> <name>)` that no construct
 * defines, labelled as declared by name only.
 *
 * @param items - Output.
 * @param scope - The lookup scope.
 * @param uri - The document being completed.
 * @param kind - Which kind of name.
 * @param itemKind - The completion item kind to show.
 * @param label - The label of an item (a global in a port item is written without `?* *`).
 */
function addExternals(
  items: Items,
  scope: SymbolTable,
  uri: string,
  kind: ExternalKind,
  itemKind: CompletionItemKind,
  label: (name: string) => string = (name) => name
): void {
  for (const external of scope.externals.values()) {
    if (external.kind !== kind) continue;
    const defined = kind === 'deftemplate' ? scope.templates : kind === 'defclass' ? scope.classes : scope.globals;
    if (defined.has(external.name)) continue;
    items.add(label(external.name), itemKind, GROUP.otherFile, `${kind} (name only) · ${displayName(external.uri)} (host program)`, {
      uri,
      type: 'external',
      kind,
      name: external.name
    });
  }
}

/**
 * Class names. `make-instance` needs a concrete user class ([INSMNGR3]);
 * an object pattern needs a class some concrete, reactive class is or
 * inherits from ([OBJRTBLD1/2]).
 *
 * @param items - Output.
 * @param scope - The lookup scope.
 * @param uri - The document being completed.
 * @param purpose - Which classes fit.
 */
function addClasses(items: Items, scope: SymbolTable, uri: string, purpose: ClassPurpose = 'any'): void {
  /** Whether a class fits `purpose`. */
  const fits = (name: string): boolean =>
    purpose === 'any' ||
    (purpose === 'instantiable' ? isConcreteClass(name, scope) : isMatchableClass(name, scope));
  for (const [name, entry] of scope.classes) {
    if (!fits(name)) continue;
    const { group, suffix } = where(entry, uri, items);
    items.add(name, CompletionItemKind.Class, group, `defclass${suffix}`, { uri, type: 'construct', category: 'class', name });
  }
  // Whether a name-only class is concrete or reactive is unknown: offer it everywhere.
  addExternals(items, scope, uri, 'defclass', CompletionItemKind.Class);
  if (purpose === 'instantiable') return;
  for (const name of BUILTIN_CLASSES) {
    if (purpose === 'matchable' && !((name === 'USER' || name === 'OBJECT') && fits(name))) continue;
    items.add(name, CompletionItemKind.Class, GROUP.builtin, 'built-in class');
  }
}

/**
 * Ordered fact names used elsewhere, e.g. `phase` from (assert (phase match)).
 *
 * @param items - Output.
 * @param scope - The lookup scope.
 * @param uri - The document being completed.
 * @param typing - Offset of the word being typed, which doesn't count as a use.
 */
function addOrderedFacts(items: Items, scope: SymbolTable, uri: string, typing: number): void {
  for (const [name, uses] of scope.facts) {
    if (scope.templates.has(name) || scope.externals.has(externalKey('deftemplate', name))) continue;
    const others = uses.filter((u) => !(uriKey(u.uri) === uriKey(uri) && u.start === typing));
    if (others.length === 0) continue;
    items.add(name, CompletionItemKind.Struct, useGroup(others, uri, items), `ordered fact${useSuffix(others, uri, items)}`);
  }
}

/**
 * This file's group if the name is used here.
 *
 * @param uses - The name's occurrences.
 * @param uri - The document being completed.
 * @param items - The item list.
 * @returns The sort group.
 */
function useGroup(uses: NameUse[], uri: string, items: Items): string {
  return uses.some((u) => uriKey(u.uri) === uriKey(uri)) ? GROUP.thisFile : GROUP.otherFile;
}

/**
 * Names another file if the name isn't used here.
 *
 * @param uses - The name's occurrences.
 * @param uri - The document being completed.
 * @param items - The item list, for its `unlinked` flag.
 * @returns The detail suffix; empty if used here.
 */
function useSuffix(uses: NameUse[], uri: string, items: Items): string {
  if (uses.some((u) => uriKey(u.uri) === uriKey(uri))) return '';
  return ` · ${displayName(uses[0].uri)}${items.unlinked ? ' (not linked by any load)' : ''}`;
}

/**
 * `MAIN` and every defmodule except `exclude`.
 *
 * @param items - Output.
 * @param scope - The lookup scope.
 * @param uri - The document being completed.
 * @param exclude - The module being defined, or `null`.
 */
function addModules(items: Items, scope: SymbolTable, uri: string, exclude: string | null): void {
  if (exclude !== 'MAIN') items.add('MAIN', CompletionItemKind.Module, GROUP.builtin, 'predefined module');
  for (const entry of scope.entries) {
    if (entry.definitionNode.type !== 'defmodule_construct' || entry.name === exclude) continue;
    const { group, suffix } = where(entry, uri, items);
    items.add(entry.name, CompletionItemKind.Module, group, `defmodule${suffix}`);
  }
}

/**
 * Constructs for `(export deftemplate |`; globals without `?* *`.
 *
 * @param items - Output.
 * @param scope - The lookup scope.
 * @param uri - The document being completed.
 * @param constructType - The port item's construct keyword.
 */
function addPortConstructs(items: Items, scope: SymbolTable, uri: string, constructType: string): void {
  switch (constructType) {
    case 'deftemplate':
      addTemplates(items, scope, uri);
      break;
    case 'defclass':
      for (const [name, entry] of scope.classes) {
        const { group, suffix } = where(entry, uri, items);
        items.add(name, CompletionItemKind.Class, group, `defclass${suffix}`, { uri, type: 'construct', category: 'class', name });
      }
      addExternals(items, scope, uri, 'defclass', CompletionItemKind.Class);
      break;
    case 'defglobal':
      for (const [name, entry] of scope.globals) {
        const bare = name.replace(/^\?\*/, '').replace(/\*$/, '');
        const { group, suffix } = where(entry, uri, items);
        items.add(bare, CompletionItemKind.Variable, group, `defglobal ${name}${suffix}`);
      }
      addExternals(items, scope, uri, 'defglobal', CompletionItemKind.Variable, (name) => name.replace(/^\?\*/, '').replace(/\*$/, ''));
      break;
    case 'deffunction':
    case 'defgeneric':
      for (const [name, entries] of scope.functionLike) {
        const isFunction = entries.some((e) => e.definitionNode.type === 'deffunction_construct');
        if (isFunction !== (constructType === 'deffunction')) continue;
        const { group, suffix } = where(entries[0], uri, items);
        items.add(name, CompletionItemKind.Function, group, `${constructType}${suffix}`, { uri, type: 'construct', category: 'function', name });
      }
      break;
  }
}

/**
 * Instance names after `[`; the items replace from the `[`.
 *
 * @param items - Output.
 * @param scope - The lookup scope.
 * @param uri - The document being completed.
 */
function addInstanceNames(items: Items, scope: SymbolTable, uri: string): void {
  for (const [name, uses] of scope.instances) {
    const className = uses.find((u) => u.className)?.className;
    items.add(`[${name}]`, CompletionItemKind.Reference, useGroup(uses, uri, items), `instance${className ? ` of ${className}` : ''}${useSuffix(uses, uri, items)}`);
  }
}

/**
 * Names for `(defmethod`: generics and built-ins; a deffunction name would clash ([GENRCPSR5]).
 *
 * @param items - Output.
 * @param scope - The lookup scope.
 * @param uri - The document being completed.
 */
function addGenericNames(items: Items, scope: SymbolTable, uri: string): void {
  for (const [name, entries] of scope.functionLike) {
    if (entries.some((e) => e.definitionNode.type === 'deffunction_construct')) continue;
    const { group, suffix } = where(entries[0], uri, items);
    items.add(name, CompletionItemKind.Function, group, `defgeneric${suffix}`, { uri, type: 'construct', category: 'function', name });
  }
  for (const [name, entry] of BUILTIN_FUNCTIONS) {
    items.add(name, CompletionItemKind.Function, GROUP.builtin, entry.syntax?.split('\n')[0] ?? 'built-in function', { uri, type: 'builtin', name });
  }
}

/**
 * Adds user functions, built-ins and host functions.
 *
 * @param items - The items.
 * @param scope - The lookup scope.
 * @param uri - The document's URI.
 * @param plan - Snippet plan, or `null`.
 */
function addFunctions(items: Items, scope: SymbolTable, uri: string, plan: SnippetPlan | null): void {
  for (const [name, entries] of scope.functionLike) {
    const first = entries[0];
    const { group, suffix } = where(first, uri, items);
    const kind = first.definitionNode.type.replace('_construct', '');
    const snippet = !plan
      ? null
      : first.definitionNode.type === 'deffunction_construct'
        ? deffunctionSnippet(name, first.definitionNode, plan.close)
        : nameSnippet(name, plan.close);
    items.add(name, CompletionItemKind.Function, group, `${kind}${suffix}`, { uri, type: 'construct', category: 'function', name }, snippet);
  }
  for (const [name, entry] of BUILTIN_FUNCTIONS) {
    const detail = entry.syntax?.split('\n')[0] ?? 'built-in function';
    const snippet = plan ? builtinSnippet(name, entry, plan.close) : null;
    items.add(name, CompletionItemKind.Function, GROUP.builtin, detail, { uri, type: 'builtin', name }, snippet);
  }
  for (const [name, host] of scope.hostFunctions) {
    const detail = `${host.signature.syntax ?? `(${name} ...)`} · host function`;
    const snippet = !plan ? null : host.signature.syntax ? builtinSnippet(name, host.signature, plan.close) : nameSnippet(name, plan.close);
    items.add(name, CompletionItemKind.Function, GROUP.otherFile, detail, { uri, type: 'host', name }, snippet);
  }
}

/**
 * Adds the globals.
 *
 * @param items - The items.
 * @param scope - The lookup scope.
 * @param uri - The document's URI.
 */
function addGlobals(items: Items, scope: SymbolTable, uri: string): void {
  for (const [name, entry] of scope.globals) {
    const { group, suffix } = where(entry, uri, items);
    items.add(name, CompletionItemKind.Variable, group, `defglobal${suffix}`, { uri, type: 'construct', category: 'global', name });
  }
  addExternals(items, scope, uri, 'defglobal', CompletionItemKind.Variable);
}

/**
 * Adds the slots of templates.
 *
 * @param items - The items.
 * @param templates - The templates.
 * @param uri - The document's URI.
 * @param plan - Snippet plan, or `null`.
 */
function addSlots(items: Items, templates: SymbolEntry[], uri: string, plan: SnippetPlan | null): void {
  for (const owner of templates) {
    for (const child of owner.definitionNode.children) {
      if (child.type !== 'slot_definition') continue;
      const inner = child.firstChild;
      const nameNode = inner?.children.find((c) => c.type === 'name');
      if (!inner || !nameNode) continue;
      const name = nameKey(nameNode);
      const keyword = inner.type === 'multislot_definition' ? 'multislot' : 'slot';
      const snippet = plan ? slotSnippet(name, plan.close) : null;
      items.add(name, CompletionItemKind.Field, GROUP.local, `${keyword} of ${owner.name}`, { uri, type: 'slot', template: owner.name, name }, snippet);
    }
  }
}

/**
 * Adds the slots of classes, inherited ones included.
 *
 * @param items - The items.
 * @param classes - The classes; `null` for all.
 * @param scope - The lookup scope.
 * @param uri - The document's URI.
 * @param plan - Snippet plan, or `null`.
 */
function addClassSlots(items: Items, classes: string[] | null, scope: SymbolTable, uri: string, plan: SnippetPlan | null): void {
  for (const className of classes ?? [...scope.classes.keys()]) {
    for (const slot of classSlots(className, scope)) {
      const keyword = /^\(\s*multislot\b/.test(slot.node.text) ? 'multislot' : 'slot';
      const snippet = plan ? slotSnippet(slot.name, plan.close) : null;
      items.add(slot.name, CompletionItemKind.Field, GROUP.local, `${keyword} of ${slot.owner.name}`, { uri, type: 'classSlot', className, name: slot.name }, snippet);
    }
  }
}

/**
 * Adds the messages instances of the classes respond to: handlers,
 * accessors and system handlers.
 *
 * @param items - The items.
 * @param classes - The receiver's classes; `null` if unknown.
 * @param scope - The lookup scope.
 * @param uri - The document's URI.
 */
function addMessages(items: Items, classes: string[] | null, scope: SymbolTable, uri: string): void {
  const handlers = allHandlers(scope);
  const known = classes ?? [...scope.classes.keys()];
  for (const className of known) {
    const ancestry = new Set(classAncestry(className, scope).map((e) => e.name));
    for (const handler of handlers) {
      if (classes && !ancestry.has(handler.className)) continue;
      const { group } = where(handler.entry, uri, items);
      items.add(handler.name, CompletionItemKind.Method, group, `message-handler of ${handler.className}`, {
        uri,
        type: 'handler',
        className: handler.className,
        name: handler.name
      });
    }
    for (const slot of classSlots(className, scope)) {
      for (const accessor of slotAccessors(slot)) {
        items.add(accessor, CompletionItemKind.Method, GROUP.local, `slot accessor of ${slot.owner.name}`);
      }
    }
  }
  if (!classes) {
    for (const handler of handlers) {
      items.add(handler.name, CompletionItemKind.Method, GROUP.otherFile, `message-handler of ${handler.className}`, {
        uri,
        type: 'handler',
        className: handler.className,
        name: handler.name
      });
    }
  }
  for (const name of SYSTEM_HANDLERS) items.add(name, CompletionItemKind.Method, GROUP.builtin, 'system message handler');
}

/** Detail text per variable binding kind. */
const BINDING_DETAIL: Record<VisibleVariable['kind'], string> = {
  pattern: 'pattern variable',
  'fact-address': 'fact address',
  parameter: 'parameter',
  bind: 'bound with bind',
  loop: 'loop variable',
  query: 'query variable',
  implicit: 'implicit variable'
};

/**
 * Adds the variables visible at `at`.
 *
 * @param items - The items.
 * @param at - The node at the cursor.
 * @param scope - The enclosing construct.
 * @param sigil - The typed prefix.
 */
function addVariables(items: Items, at: SyntaxNode, scope: SyntaxNode, sigil: Sigil): void {
  const prefix = sigil === 'multi' ? '$?' : '?';
  for (const v of visibleVariables(scope, at)) {
    const detail = BINDING_DETAIL[v.kind] + (v.multifield ? ' (multifield)' : '');
    items.add(`${prefix}${v.name}`, CompletionItemKind.Variable, GROUP.local, detail);
  }
}

/**
 * Adds allowed slot values.
 *
 * @param items - The items.
 * @param values - The values.
 */
function addValues(items: Items, values: string[]): void {
  for (const value of values) items.add(value, CompletionItemKind.EnumMember, GROUP.local, 'allowed value');
}

/**
 * Adds keywords, with snippets if planned.
 *
 * @param items - The items.
 * @param keywords - The keywords.
 * @param plan - Snippet plan, or `null`.
 * @param group - The sort group.
 */
function addKeywords(items: Items, keywords: string[], plan: SnippetPlan | null, group: string = GROUP.keyword): void {
  for (const keyword of keywords) {
    items.add(keyword, CompletionItemKind.Keyword, group, undefined, undefined, plan ? keywordSnippet(keyword, plan.close) : null);
  }
}

/**
 * Whether a keyword is `?NONE`, `?DERIVE`, `?VARIABLE` or `?ALL`, not the `?` wildcard.
 *
 * @param keyword - A grammar keyword.
 */
function isQuestionKeyword(keyword: string): boolean {
  return /^\?[A-Z]+$/.test(keyword);
}

/**
 * Whether a node is in an ERROR node.
 *
 * @param node - The node.
 */
function inError(node: SyntaxNode): boolean {
  for (let a: SyntaxNode | null = node; a; a = a.parent) if (a.type === 'ERROR') return true;
  return false;
}

/**
 * Whether a keyword fits in place of the placeholder: it parses, or the
 * only error is its own missing arguments, as in `(range)`.
 *
 * @param before - The form's text up to the placeholder.
 * @param keyword - The keyword.
 * @param depth - Parens to close after it.
 * @param offset - The placeholder's offset in that text.
 */
function keywordParses(before: string, keyword: string, depth: number, offset: number): boolean {
  const leaf = leafAt(parseText(before + keyword + ')'.repeat(depth)), offset);
  if (leaf.type !== keyword) return false;
  if (!inError(leaf)) return true;
  const error = leaf.parent;
  return error?.type === 'ERROR' && error.children.every((c) => c.id === leaf.id || c.type === '(' || c.type === ')');
}

/**
 * Completion items at a position.
 *
 * @param text - The document's text.
 * @param offset - The cursor offset (UTF-16).
 * @param position - The cursor position.
 * @param scope - From `getCompletionScope`.
 * @param uri - The document's URI.
 * @param options - Snippet options.
 * @returns The items; none in strings, comments, or where a new name is defined.
 */
export function provideCompletion(
  text: string,
  offset: number,
  position: Position,
  scope: SymbolTable,
  uri: string,
  options: CompletionOptions = { snippets: false }
): CompletionItem[] {
  let wordStart = offset;
  while (wordStart > 0 && WORD_CHAR.test(text[wordStart - 1])) wordStart--;
  const word = text.slice(wordStart, offset);
  const sigil = sigilOf(word);

  const { topStart, depth, inString, inComment } = scan(text, wordStart);
  if (inString || inComment) return [];

  const range: Range = {
    start: { line: position.line, character: position.character - word.length },
    end: position
  };
  const items = new Items(range, options.unlinked);

  if (sigil === 'global') {
    addGlobals(items, scope, uri);
    return items.list();
  }

  // An existing instance name after `[`, but not a new one in ([new] of C).
  if (text[wordStart - 1] === '[') {
    if (/\(\s*$/.test(text.slice(Math.max(0, wordStart - 40), wordStart - 1))) return [];
    const bracketed = new Items({ start: { line: position.line, character: range.start.character - 1 }, end: position }, options.unlinked);
    addInstanceNames(bracketed, scope, uri);
    return bracketed.list();
  }

  if (topStart < 0 || depth === 0) {
    // Top level: offer constructs with their opening paren. The parse state
    // also allows top-level calls, which aren't what's being typed here.
    if (sigil !== 'none') return [];
    const top = parseText(`(${MARKER})`);
    for (const keyword of lookahead(leafAt(top, 1).parseState)?.keywords ?? []) {
      if (!CONSTRUCT_START.test(`(${keyword} `)) continue;
      const body = options.snippets ? keywordSnippet(keyword, true) : null;
      items.add(keyword, CompletionItemKind.Snippet, GROUP.construct, `(${keyword} ...)`, undefined, body ? `(${body}` : `(${keyword}`);
    }
    return items.list();
  }

  const marker = sigil === 'multi' ? `$?${MARKER}` : sigil === 'single' ? `?${MARKER}` : MARKER;
  const markerOffset = wordStart - topStart;
  const tree = parseText(text.slice(topStart, wordStart) + marker + ')'.repeat(depth));

  const first = leafAt(tree, markerOffset);
  const allowed = lookahead(first.parseState);
  let markerNode: SyntaxNode = first;
  if (sigil !== 'none') {
    const variable = first.parent;
    if (variable && (variable.type === 'single_field_variable' || variable.type === 'multifield_variable')) {
      markerNode = variable;
    }
  }

  const keywordOnly = !!allowed && allowed.keywords.length > 0 && !allowed.acceptsSymbol;
  const context = classify(markerNode, scope, tree.rootNode, keywordOnly);
  // In an ERROR the lookahead includes keywords of unrelated rules (after
  // "(if TRUE": to, of, around). Keep only keywords that parse here.
  const keywords = inError(first)
    ? (allowed?.keywords ?? []).filter((k) => keywordParses(text.slice(topStart, wordStart), k, depth, markerOffset))
    : (allowed?.keywords ?? []);

  // Snippets only where the word opens its own form and nothing follows yet.
  const opensForm = text[wordStart - 1] === '(';
  const plan: SnippetPlan | null =
    options.snippets && opensForm && nothingFollows(text, offset) ? { close: !formIsClosed(text, topStart) } : null;

  switch (context.kind) {
    case 'none':
      break;
    case 'variable':
      addVariables(items, context.at, context.scope, sigil);
      // e.g. (default ?|
      addKeywords(items, keywords.filter(isQuestionKeyword), null);
      break;
    case 'callHead':
      addFunctions(items, scope, uri, plan);
      addKeywords(items, keywords, plan, depth === 1 ? GROUP.construct : GROUP.keyword);
      break;
    case 'patternHead':
      addTemplates(items, scope, uri);
      addOrderedFacts(items, scope, uri, wordStart);
      addKeywords(items, keywords, null);
      break;
    case 'template':
      addTemplates(items, scope, uri);
      if (context.facts) addOrderedFacts(items, scope, uri, wordStart);
      break;
    case 'module':
      addModules(items, scope, uri, context.exclude);
      break;
    case 'portConstruct':
      addPortConstructs(items, scope, uri, context.constructType);
      break;
    case 'logicalName':
      for (const name of context.input ? INPUT_LOGICAL_NAMES : OUTPUT_LOGICAL_NAMES) {
        items.add(name, CompletionItemKind.Constant, GROUP.local, name === 't' ? 'the standard stream' : 'logical name');
      }
      addVariables(items, markerNode, tree.rootNode, 'single');
      break;
    case 'slot':
      addSlots(items, context.templates, uri, context.inParens ? plan : null);
      break;
    case 'classSlot':
      addClassSlots(items, context.classes, scope, uri, context.inParens ? plan : null);
      if (context.objectPattern) addKeywords(items, keywords, null);
      break;
    case 'value':
      addValues(items, context.allowed);
      addKeywords(items, [...(context.extra ?? []), ...keywords.filter(isQuestionKeyword)], null, GROUP.local);
      addVariables(items, context.at, context.scope, 'single');
      if (context.globals) addGlobals(items, scope, uri);
      break;
    case 'message':
      addMessages(items, context.classes, scope, uri);
      break;
    case 'class':
      addClasses(items, scope, uri, context.purpose);
      break;
    case 'generic':
      addGenericNames(items, scope, uri);
      break;
    case 'switchClause':
      for (const clause of ['case', 'default'] as const) {
        items.add(clause, CompletionItemKind.Keyword, GROUP.keyword, undefined, undefined, plan ? switchClauseSnippet(clause, plan.close) : null);
      }
      break;
    case 'keywords':
      addKeywords(items, keywords, null);
      break;
    case 'fallback':
      if (context.at && context.scope) addVariables(items, context.at, context.scope, 'single');
      addGlobals(items, scope, uri);
      addTemplates(items, scope, uri);
      addFunctions(items, scope, uri, null);
      addClasses(items, scope, uri);
      addKeywords(items, keywords, null);
      break;
  }
  return items.list();
}

/**
 * Adds the hover card as documentation.
 *
 * @param item - An item from {@link provideCompletion}.
 * @param scope - The document's scope, if still cached.
 * @param context - Hover context.
 * @param markdown - Whether the client renders Markdown.
 * @returns The item.
 */
export function resolveCompletionItem(
  item: CompletionItem,
  scope: SymbolTable | undefined,
  context: HoverContext,
  markdown: boolean
): CompletionItem {
  const data = item.data as CompletionData | undefined;
  if (!data) return item;

  let value: string | null = null;
  if (data.type === 'builtin') {
    const entry = BUILTIN_FUNCTIONS.get(data.name);
    if (entry) value = renderBuiltin(data.name, entry);
  } else if (!scope) {
    return item; // document gone; only built-ins can still be described
  } else if (data.type === 'host') {
    const host = scope.hostFunctions.get(data.name);
    if (host) value = renderHostFunction(host);
  } else if (data.type === 'external') {
    const external = scope.externals.get(externalKey(data.kind, data.name));
    if (external) value = renderExternal(external);
  } else if (data.type === 'slot') {
    const owner = scope.templates.get(data.template);
    if (owner) {
      const slotDefinition = findSlotDefinition(owner.definitionNode, data.name);
      value = render({ kind: 'slot', owner, slotName: data.name, slotDefinition, reference: owner.nameNode }, scope, context);
    }
  } else if (data.type === 'classSlot') {
    const slot = classSlots(data.className, scope).find((s) => s.name === data.name);
    if (slot) value = '```clips\n' + slot.node.text.replace(/\s+/g, ' ') + '\n```\n\n' + `*slot of defclass ${slot.owner.name}*`;
  } else if (data.type === 'handler') {
    const handler = allHandlers(scope).find((h) => h.name === data.name && h.className === data.className);
    if (handler) value = render({ kind: 'construct', entries: [handler.entry], reference: handler.entry.nameNode }, scope, context);
  } else {
    const entries = constructEntries(scope, data.category, data.name);
    if (entries.length > 0) {
      value = render({ kind: 'construct', entries, reference: entries[0].nameNode }, scope, context);
    }
  }

  if (value) item.documentation = markdown ? { kind: MarkupKind.Markdown, value } : value;
  return item;
}

/**
 * The entries a construct item describes.
 *
 * @param scope - The lookup scope.
 * @param category - The construct category.
 * @param name - The name.
 * @returns The entries; empty if the name is gone.
 */
function constructEntries(scope: SymbolTable, category: 'template' | 'class' | 'function' | 'global', name: string): SymbolEntry[] {
  switch (category) {
    case 'template': {
      const entry = scope.templates.get(name);
      return entry ? [entry] : [];
    }
    case 'class': {
      const entry = scope.classes.get(name);
      return entry ? [entry] : [];
    }
    case 'global': {
      const entry = scope.globals.get(name);
      return entry ? [entry] : [];
    }
    case 'function':
      return scope.functionLike.get(name) ?? [];
  }
}
