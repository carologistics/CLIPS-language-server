/**
 * @file Semantic diagnostics. References resolve against the whole
 * workspace; checks that depend on which files form a program use the load
 * graph and stay quiet when it is incomplete. When unsure, a check doesn't
 * report. Constructs with syntax errors are skipped. The variable checks are
 * in variableChecks.ts; declaration files have their own checks in
 * declarationDiagnostics.ts.
 */

import type { SyntaxNode, Tree } from 'tree-sitter';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node.js';
import { BUILTIN_FUNCTIONS } from './builtins.js';
import { BUILTIN_CLASSES, instanceDefinitionClass, isDefclassSuperclassName } from './classes.js';
import { externalKey, type DeclarationFileInfo } from './declarations.js';
import type { LoadCall } from './loads.js';
import { bareVarName, findLocalDefinitions } from './locals.js';
import { diag, relatedAt, toRange } from './lsp.js';
import {
  enclosingLhsSlot,
  factActionPatterns,
  findSlotDefinition,
  literalSatisfiesTypes,
  literalType,
  resolveFactActionTemplate,
  resolveRhsPatternSlot,
  resolveTemplateSlot,
  slotConstraints,
  type SlotConstraints
} from './slots.js';
import { functionNameKey, isQualifiedCall, nameKey, type SymbolEntry, type SymbolTable } from './symbolTable.js';
import { displayName, uriKey } from './uri.js';
import {
  checkDuplicateParameters,
  checkFunctionBodyVariables,
  checkRebindTypeConflicts,
  checkRuleVariables,
  checkUnusedPatternVariables,
  checkUnusedVariables,
  checkVariableShadowing,
  checkVariableUsedBeforeBound
} from './variableChecks.js';

/**
 * Calls whose nested forms aren't calls: `switch`'s `case` and `default`
 * clauses parse as nested calls. Name checks skip everything inside them.
 */
const NON_CALL_ARGUMENT_FUNCTIONS = new Set(['switch']);

/** Primitive types; argument type checks only handle these. */
const PRIMITIVE_TYPE_NAMES = new Set([
  'SYMBOL',
  'STRING',
  'LEXEME',
  'INSTANCE-NAME',
  'INSTANCE-ADDRESS',
  'INSTANCE',
  'INTEGER',
  'FLOAT',
  'NUMBER',
  'EXTERNAL-ADDRESS',
  'FACT-ADDRESS'
]);

/** Constructs checked for duplicate names; a defmethod repeats its generic's name. */
const NAMED_CONSTRUCT_TYPES = new Set([
  'deftemplate_construct',
  'defrule_construct',
  'deffunction_construct',
  'defgeneric_construct',
  'defclass_construct',
  'defmodule_construct',
  'deffacts_construct',
  'definstances_construct',
  'defglobal_construct'
]);

/** Load graph information about the document. */
export interface ProgramContext {
  /** The document's load calls. */
  loadCalls: LoadCall[];
  /** Declaration files that apply; named in unknown-name messages. */
  declarations?: DeclarationFileInfo[];
  /** The document's program; `null` if no load calls lead into or out of it. */
  program: {
    /** Own tables of the program's other files. */
    otherTables: SymbolTable[];
    /** What the program can see; `null` if incomplete. */
    scope: SymbolTable | null;
  } | null;
}

/**
 * Runs all semantic checks. Checks on the document's own definitions
 * (duplicates, cycles) use `table`, so they never point into other files;
 * reference checks use `scope`.
 *
 * @param tree - The document's tree.
 * @param table - The document's own table.
 * @param uri - The document's URI.
 * @param scope - The lookup scope; defaults to `table`.
 * @param context - Load graph information.
 * @returns The diagnostics.
 */
export function collectSemanticDiagnostics(
  tree: Tree,
  table: SymbolTable,
  uri: string,
  scope: SymbolTable = table,
  context: ProgramContext = { loadCalls: [], program: null }
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const root = tree.rootNode;
  const programScope = context.program?.scope ?? null;
  const note = declarationNote(context.declarations ?? []);

  checkDuplicateConstructNames(table, uri, out);
  checkCrossFileDuplicates(table, context.program?.otherTables ?? [], out);
  checkFunctionGenericConflicts(table, context.program?.otherTables ?? [], out);
  checkLoadTargets(context.loadCalls, out);
  checkDuplicateSlotNames(root, uri, out);
  checkSlotDefaults(root, out);
  checkPatterns(root, scope, out, programScope, note);
  checkFactActionSlots(root, scope, out);
  checkUnknownClasses(root, scope, out, programScope, note);
  checkUnknownGlobals(root, scope, out, programScope, note);
  checkDuplicateParameters(root, uri, out);
  checkRuleVariables(root, out);
  checkFunctionBodyVariables(root, out);
  checkUnusedVariables(root, out);
  checkGenericCallArguments(root, scope, out);

  checkUnknownFunctionCalls(root, scope, out, programScope, note);
  checkVariableUsedBeforeBound(root, out);
  checkUnusedPatternVariables(root, out);
  checkRebindTypeConflicts(root, scope, out);
  checkFunctionArity(root, scope, uri, out);
  checkDeffunctionReplacesExternal(table, scope, out);
  checkMissingRequiredSlots(root, scope, out);
  checkClassInheritanceCycles(table, out);
  checkVariableShadowing(root, out);

  return out;
}

// Helpers

/**
 * Text appended to unknown-name messages: how to get a dump, or the age
 * of the dump that lacks the name.
 *
 * @param files - The declaration files that apply.
 * @returns The text, starting with ". ".
 */
function declarationNote(files: DeclarationFileInfo[]): string {
  if (files.length === 0) {
    return '. If the program that embeds CLIPS defines it, run scripts/dump-host/dump.clp in that program (see its header), or declare it with a quick fix';
  }
  const dumps = files.filter((f) => f.generated !== null);
  if (dumps.length > 0) {
    const list = dumps.map((d) => `${displayName(d.uri)}${d.generated ? ` (generated ${d.generated})` : ''}`).join(', ');
    return `. Not in ${list} either: a typo, or the dump is older than the host's current code`;
  }
  return `. Not declared in ${files.map((f) => displayName(f.uri)).join(', ')} either`;
}

/** `data` of unknown-name diagnostics, for the quick fixes. */
export interface UnknownNameData {
  /** What kind of construct the name should be. */
  kind: 'deftemplate' | 'defclass' | 'defglobal' | 'function';
  /** The unknown name. */
  name: string;
}

/** `data` of `slot-unknown` diagnostics, for "Add slot". */
export interface UnknownSlotData {
  /** Tells it apart from {@link UnknownNameData}. */
  kind: 'slot';
  /** The template name. */
  template: string;
  /** The unknown slot. */
  slot: string;
}

/**
 * A slot definition's name.
 *
 * @param inner - A `single_slot_definition`, `multislot_definition` or `slot` node.
 * @returns The name, or `null` if missing.
 */
function slotDefName(inner: SyntaxNode): string | null {
  const nameNode = inner.children.find((c) => c.type === 'name');
  return nameNode ? nameKey(nameNode) : null;
}

// Duplicates

/**
 * Repeated definitions of a name within one construct kind.
 *
 * @param table - The document's own table.
 * @param uri - The document's URI.
 * @param out - Output.
 */
function checkDuplicateConstructNames(table: SymbolTable, uri: string, out: Diagnostic[]): void {
  const first = new Map<string, SymbolEntry>();
  for (const entry of table.entries) {
    const kind = entry.definitionNode.type;
    if (!NAMED_CONSTRUCT_TYPES.has(kind)) continue;
    const key = `${kind}::${entry.name}`;
    const prior = first.get(key);
    if (prior) {
      const label = kind.replace(/_construct$/, '');
      out.push(
        diag(
          entry.nameNode,
          `Duplicate ${label} "${entry.name}" — the later definition replaces the earlier one`,
          DiagnosticSeverity.Warning,
          'duplicate-construct',
          { relatedInformation: relatedAt(uri, prior.nameNode, 'first defined here') }
        )
      );
    } else {
      first.set(key, entry);
    }
  }
}

/**
 * The same construct in this file and another file of the program; CLIPS
 * keeps whichever is loaded last. For templates the slots are compared.
 *
 * @param table - The document's own table.
 * @param otherTables - The program's other files.
 * @param out - Output.
 */
function checkCrossFileDuplicates(table: SymbolTable, otherTables: SymbolTable[], out: Diagnostic[]): void {
  if (otherTables.length === 0) return;
  const seen = new Set<string>();

  for (const entry of table.entries) {
    const kind = entry.definitionNode.type;
    if (!NAMED_CONSTRUCT_TYPES.has(kind)) continue;
    const key = `${kind}::${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const elsewhere = otherTables.flatMap((t) =>
      t.entries.filter((e) => e.definitionNode.type === kind && e.name === entry.name)
    );
    if (elsewhere.length === 0) continue;

    const label = kind.replace(/_construct$/, '');
    const files = [...new Set(elsewhere.map((e) => displayName(e.uri)))].join(', ');
    const related = elsewhere.map((e) => ({
      location: { uri: e.uri, range: toRange(e.nameNode) },
      message: `also defined here`
    }));

    let message = `Duplicate ${label} "${entry.name}" — also defined in ${files}, which this program also loads; CLIPS keeps whichever file it loads last`;
    if (kind === 'deftemplate_construct') {
      const here = templateSlots(entry.definitionNode);
      const differing = elsewhere.find((e) => templateSlots(e.definitionNode) !== here);
      if (differing) {
        message =
          `Deftemplate "${entry.name}" is also defined in ${displayName(differing.uri)} with different slots ` +
          `(here: ${here || 'none'}; there: ${templateSlots(differing.definitionNode) || 'none'}) — ` +
          `CLIPS keeps whichever file it loads last, so code written for the other version breaks`;
      }
    }

    out.push(diag(entry.nameNode, message, DiagnosticSeverity.Warning, 'duplicate-construct-across-files', { relatedInformation: related }));
  }
}

/**
 * A template's sorted slot list, e.g. `"age, multislot tags, name"`.
 *
 * @param templateNode - A `deftemplate_construct` node.
 * @returns The list.
 */
function templateSlots(templateNode: SyntaxNode): string {
  const slots: string[] = [];
  for (const child of templateNode.children) {
    if (child.type !== 'slot_definition' || !child.firstChild) continue;
    const name = slotDefName(child.firstChild);
    if (name === null) continue;
    slots.push(child.firstChild.type === 'multislot_definition' ? `multislot ${name}` : name);
  }
  return slots.sort((a, b) => a.replace('multislot ', '').localeCompare(b.replace('multislot ', ''))).join(', ');
}

/**
 * A deffunction and a generic with the same name, which CLIPS won't load.
 *
 * @param table - The document's own table.
 * @param otherTables - The program's other files.
 * @param out - Output.
 */
function checkFunctionGenericConflicts(table: SymbolTable, otherTables: SymbolTable[], out: Diagnostic[]): void {
  /** Whether the entry is a deffunction. */
  const isFunction = (e: SymbolEntry) => e.definitionNode.type === 'deffunction_construct';
  /** Whether the entry is a defgeneric or defmethod. */
  const isGeneric = (e: SymbolEntry) =>
    e.definitionNode.type === 'defgeneric_construct' || e.definitionNode.type === 'defmethod_construct';
  const everywhere = [table, ...otherTables].flatMap((t) => t.entries);

  for (const entry of table.entries) {
    if (!isFunction(entry) && !isGeneric(entry)) continue;
    const opponent = everywhere.find(
      (e) => e.name === entry.name && (isFunction(entry) ? isGeneric(e) : isFunction(e))
    );
    if (!opponent) continue;

    const mine = entry.definitionNode.type.replace(/_construct$/, '');
    const theirs = opponent.definitionNode.type.replace(/_construct$/, '');
    const where = opponent.uri === entry.uri ? 'in this file' : `in ${displayName(opponent.uri)}`;
    out.push(
      diag(
        entry.nameNode,
        `"${entry.name}" is both a ${mine} here and a ${theirs} ${where} — CLIPS doesn't allow a deffunction and a generic function with the same name, so loading fails`,
        DiagnosticSeverity.Error,
        'function-generic-conflict',
        { relatedInformation: [{ location: { uri: opponent.uri, range: toRange(opponent.nameNode) }, message: `${theirs} "${opponent.name}"` }] }
      )
    );
  }
}

/**
 * Repeated slot names in a template or class.
 *
 * @param root - The document's root.
 * @param uri - The document's URI.
 * @param out - Output.
 */
function checkDuplicateSlotNames(root: SyntaxNode, uri: string, out: Diagnostic[]): void {
  for (const construct of root.descendantsOfType(['deftemplate_construct', 'defclass_construct'])) {
    if (construct.hasError) continue;
    const childType = construct.type === 'deftemplate_construct' ? 'slot_definition' : 'slot';
    const label = construct.type === 'deftemplate_construct' ? 'deftemplate' : 'defclass';
    const first = new Map<string, SyntaxNode>();
    for (const child of construct.children) {
      if (child.type !== childType) continue;
      const inner = childType === 'slot_definition' ? child.firstChild : child;
      if (!inner) continue;
      const nameNode = inner.children.find((c) => c.type === 'name');
      if (!nameNode) continue;
      const name = nameKey(nameNode);
      const prior = first.get(name);
      if (prior) {
        out.push(
          diag(nameNode, `Duplicate slot "${name}" in this ${label}`, DiagnosticSeverity.Error, 'duplicate-slot', {
            relatedInformation: relatedAt(uri, prior, 'first declared here')
          })
        );
      } else {
        first.set(name, nameNode);
      }
    }
  }
}

// Load graph

/**
 * Loads of files that don't exist. Only a warning: CLIPS resolves paths
 * from its working directory.
 *
 * @param loadCalls - The document's load calls.
 * @param out - Output.
 */
function checkLoadTargets(loadCalls: LoadCall[], out: Diagnostic[]): void {
  for (const call of loadCalls) {
    if (call.target.kind !== 'missing') continue;
    out.push(
      diag(
        call.argument,
        `Can't find "${call.target.path}" — no such file next to this one or in a workspace folder (CLIPS resolves relative paths from its working directory, so it only loads if CLIPS is started from a folder containing it)`,
        DiagnosticSeverity.Warning,
        'load-file-missing'
      )
    );
  }
}

/**
 * A reference defined in the workspace but not in this program.
 *
 * @param node - The reference.
 * @param label - The construct kind, e.g. `Deffunction`.
 * @param name - The name.
 * @param definitions - Where it is defined.
 * @param out - Output.
 */
function reportNotLoaded(
  node: SyntaxNode,
  label: string,
  name: string,
  definitions: SymbolEntry[],
  out: Diagnostic[]
): void {
  const files = [...new Set(definitions.map((e) => displayName(e.uri)))].join(', ');
  out.push(
    diag(
      node,
      `${label} "${name}" is defined in ${files}, but no (load …) or (batch …) in this program reaches that file`,
      DiagnosticSeverity.Warning,
      'construct-not-loaded',
      {
        relatedInformation: definitions.map((e) => ({
          location: { uri: e.uri, range: toRange(e.nameNode) },
          message: `${label} "${name}"`
        }))
      }
    )
  );
}

// Value vs. slot constraints (shared by pattern checks and default checks)

/**
 * Checks a constant against a slot's allowed values, type and range.
 *
 * @param constNode - The constant.
 * @param c - The slot's constraints.
 * @param label - `value` or `default value`.
 * @param out - Output.
 */
function reportConstantAgainstSlot(
  constNode: SyntaxNode,
  c: SlotConstraints,
  label: string,
  out: Diagnostic[]
): void {
  const text = constNode.text;

  if (c.allowedValues && c.allowedValues.length > 0 && !c.allowedValues.includes(text)) {
    out.push(
      diag(
        constNode,
        `${label} ${text} is not one of the slot's allowed values (${c.allowedValues.join(', ')})`,
        DiagnosticSeverity.Error,
        'slot-value-not-allowed'
      )
    );
    return;
  }

  const lit = literalType(constNode);
  if (lit && c.types.length > 0 && !literalSatisfiesTypes(lit, c.types)) {
    out.push(
      diag(
        constNode,
        `${label} is ${lit}, but the slot is declared (type ${c.types.join(' | ')})`,
        DiagnosticSeverity.Error,
        'slot-value-type'
      )
    );
    return;
  }

  if (c.range) {
    const value = Number.parseFloat(text);
    const lo = Number.parseFloat(c.range.lo);
    const hi = Number.parseFloat(c.range.hi);
    if (
      !Number.isNaN(value) &&
      !Number.isNaN(lo) &&
      !Number.isNaN(hi) &&
      (value < lo || value > hi)
    ) {
      out.push(
        diag(
          constNode,
          `${label} ${text} is outside the slot's range [${c.range.lo}, ${c.range.hi}]`,
          DiagnosticSeverity.Warning,
          'slot-value-range'
        )
      );
    }
  }
}

/**
 * A slot's static default against the slot's constraints.
 *
 * @param root - The document's root.
 * @param out - Output.
 */
function checkSlotDefaults(root: SyntaxNode, out: Diagnostic[]): void {
  for (const inner of root.descendantsOfType(['single_slot_definition', 'multislot_definition'])) {
    if (inner.hasError) continue;
    const c = slotConstraints(inner);
    if (!c.defaultValues || c.defaultValues.length === 0) continue;
    for (const value of c.defaultValues) {
      if (value.type !== 'constant') continue; // computed
      reportConstantAgainstSlot(value, c, 'default value', out);
    }
  }
}

// LHS template patterns

/**
 * LHS template patterns: unknown templates and slots, slot arity, and
 * constant values against the slot constraints.
 *
 * @param root - The document's root.
 * @param table - The lookup scope.
 * @param out - Output.
 * @param programScope - The program's scope, for "not loaded" checks.
 * @param note - Appended to unknown-name messages.
 */
function checkPatterns(
  root: SyntaxNode,
  table: SymbolTable,
  out: Diagnostic[],
  programScope: SymbolTable | null = null,
  note = ''
): void {
  for (const pattern of root.descendantsOfType('template_pattern_CE')) {
    if (pattern.hasError) continue;
    const headNode = pattern.children.find((c) => c.type === 'name');
    if (!headNode) continue;
    const templateName = nameKey(headNode);
    const template = table.templates.get(templateName);

    if (!template) {
      // Declared with defexternal: exists, slots unknown.
      if (table.externals.has(externalKey('deftemplate', templateName))) continue;
      // Slots are used, so this must be a deftemplate.
      out.push(
        diag(
          headNode,
          `Unknown deftemplate "${templateName}" — no deftemplate with this name in the workspace${note}`,
          DiagnosticSeverity.Warning,
          'template-unknown',
          { data: { kind: 'deftemplate', name: templateName } satisfies UnknownNameData }
        )
      );
      continue;
    }
    if (programScope && !programScope.templates.has(templateName)) {
      reportNotLoaded(headNode, 'Deftemplate', templateName, [template], out);
    }

    for (const wrapper of pattern.children) {
      if (wrapper.type !== 'LHS_slot') continue;
      const slotNode = wrapper.firstChild;
      if (!slotNode) continue;
      const slotNameNode = slotNode.children.find((c) => c.type === 'name');
      if (!slotNameNode) continue;
      const slotName = nameKey(slotNameNode);

      const slotDef = findSlotDefinition(template.definitionNode, slotName);
      if (!slotDef) {
        out.push(
          diag(
            slotNameNode,
            `deftemplate "${templateName}" has no slot "${slotName}"`,
            DiagnosticSeverity.Error,
            'slot-unknown',
            { data: { kind: 'slot', template: templateName, slot: slotName } satisfies UnknownSlotData }
          )
        );
        continue;
      }

      const c = slotConstraints(slotDef);
      const terms = slotNode.descendantsOfType('term');

      const hasSingleVar = terms.some((t) => t.firstChild?.type === 'single_field_variable');
      // A bare $? counts too: (color $? ?c $?) matches each element.
      const hasMultiVar =
        terms.some((t) => t.firstChild?.type === 'multifield_variable') ||
        slotNode.children.some((ch) => ch.type === 'constraint' && ch.firstChild?.type === '$?');
      if (c.isMultislot && hasSingleVar && !hasMultiVar) {
        // Often intended when exactly one value is expected, so only a hint.
        out.push(
          diag(
            slotNode,
            `Single-field variable matches multislot "${slotName}" only when it holds exactly one value — use $?… to capture all of them`,
            DiagnosticSeverity.Hint,
            'slot-arity-single-on-multi'
          )
        );
      }
      if (!c.isMultislot && hasMultiVar) {
        out.push(
          diag(
            slotNode,
            `Multifield variable used on single-field slot "${slotName}"`,
            DiagnosticSeverity.Error,
            'slot-arity-multi-on-single'
          )
        );
      }

      for (const term of terms) {
        if (term.previousSibling?.type === '~') continue; // ~value means "not this value"
        const child = term.firstChild;
        if (child?.type !== 'constant') continue;
        reportConstantAgainstSlot(child, c, 'value', out);
      }
    }
  }
}

// modify / duplicate: ordered fact, unknown slot, value types, arity

/**
 * A slot assignment like `(age 4)`: the slot must exist, a single-field
 * slot takes one value, and constants must satisfy its constraints.
 *
 * @param template - The template.
 * @param slotNode - The assignment.
 * @param slotNameNode - The slot name.
 * @param values - The values.
 * @param out - Output.
 */
function checkSlotAssignment(
  template: SymbolEntry,
  slotNode: SyntaxNode,
  slotNameNode: SyntaxNode,
  values: SyntaxNode[],
  out: Diagnostic[]
): void {
  const slotName = slotNameNode.type === 'name' ? nameKey(slotNameNode) : slotNameNode.text;
  const slotDef = findSlotDefinition(template.definitionNode, slotName);
  if (!slotDef) {
    out.push(
      diag(
        slotNameNode,
        `deftemplate "${template.name}" has no slot "${slotName}"`,
        DiagnosticSeverity.Error,
        'slot-unknown',
        { data: { kind: 'slot', template: template.name, slot: slotName } satisfies UnknownSlotData }
      )
    );
    return;
  }

  const c = slotConstraints(slotDef);

  if (!c.isMultislot) {
    if (values.length !== 1) {
      out.push(
        diag(
          slotNode,
          `Single-field slot "${slotName}" takes exactly one value, but ${values.length} are given`,
          DiagnosticSeverity.Error,
          'slot-arity-multi-on-single'
        )
      );
    } else if (values[0].type === 'variable' && values[0].firstChild?.type === 'multifield_variable') {
      out.push(
        diag(
          slotNode,
          `Multifield variable used on single-field slot "${slotName}"`,
          DiagnosticSeverity.Error,
          'slot-arity-multi-on-single'
        )
      );
    }
  }

  for (const value of values) {
    if (value.type === 'constant') reportConstantAgainstSlot(value, c, 'value', out);
  }
}

/**
 * Slots in modify/duplicate, against the template of `?f`'s pattern. Also
 * reports modify/duplicate of an ordered fact, which CLIPS rejects.
 *
 * @param root - The document's root.
 * @param table - The lookup scope.
 * @param out - Output.
 */
function checkFactActionSlots(root: SyntaxNode, table: SymbolTable, out: Diagnostic[]): void {
  for (const action of root.descendantsOfType('fact_action')) {
    if (action.hasError) continue;
    const specifier = action.children.find((c) => c.type === 'variable');
    if (!specifier) continue;

    const patterns = factActionPatterns(action);
    if (!patterns) continue;

    // ?r <- (response) also parses as an ordered pattern; it's only an
    // ordered fact if no deftemplate has that name.
    /** Whether a pattern is an ordered fact and not a template pattern. */
    const isOrderedFact = (p: SyntaxNode): boolean => {
      const head = p.children.find((c) => c.type === 'name');
      const name = head ? nameKey(head) : null;
      return p.type === 'ordered_pattern_CE' && !(name && (table.templates.has(name) || table.externals.has(externalKey('deftemplate', name))));
    };
    if (patterns.every(isOrderedFact)) {
      const verb = action.namedChildren[0]?.text ?? 'modify';
      const head = patterns[0].children.find((c) => c.type === 'name');
      out.push(
        diag(
          specifier,
          `"${verb}" cannot be used on an ordered fact -- ${specifier.text} is bound to (${head ? nameKey(head) : '...'} ...), which has no deftemplate slots; retract it and assert a new fact instead`,
          DiagnosticSeverity.Error,
          'fact-action-ordered'
        )
      );
      continue;
    }

    const template = resolveFactActionTemplate(action, table);
    if (!template) continue; // unknown templates are reported at the pattern

    for (const wrapper of action.children) {
      if (wrapper.type !== 'RHS_slot') continue;
      const slotNode = wrapper.firstChild;
      if (!slotNode) continue;
      const slotNameNode = slotNode.children.find((c) => c.type === 'name');
      if (!slotNameNode) continue;
      const values = slotNode.children
        .filter((f) => f.type === 'RHS_field')
        .map((f) => f.firstNamedChild) // skips the = of =(...)
        .filter((v): v is SyntaxNode => v !== null);
      checkSlotAssignment(template, slotNode, slotNameNode, values, out);
    }
  }
}

// Unknown classes and globals

/**
 * Unknown classes in superclasses, method restrictions, instances and
 * object patterns.
 *
 * @param root - The document's root.
 * @param table - The lookup scope.
 * @param out - Output.
 * @param programScope - The program's scope, for "not loaded" checks.
 * @param note - Appended to unknown-name messages.
 */
function checkUnknownClasses(
  root: SyntaxNode,
  table: SymbolTable,
  out: Diagnostic[],
  programScope: SymbolTable | null = null,
  note = ''
): void {
  /** Reports a class name unless it is built-in, declared or defined and loaded. */
  const report = (node: SyntaxNode, name: string): void => {
    if (BUILTIN_CLASSES.has(name)) return;
    if (table.externals.has(externalKey('defclass', name))) return;
    const defined = table.classes.get(name);
    if (defined) {
      if (programScope && !programScope.classes.has(name)) reportNotLoaded(node, 'Defclass', name, [defined], out);
      return;
    }
    out.push(
      diag(
        node,
        `Unknown class "${name}" — not defined in the workspace and not a built-in COOL class${note}`,
        DiagnosticSeverity.Warning,
        'class-unknown',
        { data: { kind: 'defclass', name } satisfies UnknownNameData }
      )
    );
  };

  for (const defclass of root.descendantsOfType('defclass_construct')) {
    if (defclass.hasError) continue;
    for (const child of defclass.children) {
      if (child.type === 'name' && isDefclassSuperclassName(child, defclass)) {
        report(child, nameKey(child));
      }
    }
  }

  for (const restriction of root.descendantsOfType([
    'parameter_restriction',
    'wildcard_parameter_restriction'
  ])) {
    if (restriction.hasError) continue;
    for (const child of restriction.children) {
      if (child.type === 'name') report(child, nameKey(child));
    }
  }

  for (const instance of root.descendantsOfType('instance_definition')) {
    if (instance.hasError) continue;
    const classSymbol = instanceDefinitionClass(instance)?.firstChild;
    if (classSymbol?.type === 'symbol') report(classSymbol, classSymbol.text);
  }

  for (const object of root.descendantsOfType('object_pattern_CE')) {
    if (object.hasError) continue;
    for (const attr of object.descendantsOfType('attribute_constraint')) {
      if (!/^\(\s*is-a\b/.test(attr.text)) continue;
      for (const term of attr.descendantsOfType('term')) {
        if (term.previousSibling?.type === '~') continue;
        const constant = term.firstChild;
        const sym = constant?.type === 'constant' ? constant.firstChild : null;
        if (sym?.type === 'symbol') report(sym, sym.text);
      }
    }
  }
}

/**
 * Globals without a defglobal.
 *
 * @param root - The document's root.
 * @param table - The lookup scope.
 * @param out - Output.
 * @param programScope - The program's scope, for "not loaded" checks.
 * @param note - Appended to unknown-name messages.
 */
function checkUnknownGlobals(
  root: SyntaxNode,
  table: SymbolTable,
  out: Diagnostic[],
  programScope: SymbolTable | null = null,
  note = ''
): void {
  for (const gv of root.descendantsOfType('global_variable')) {
    if (gv.isMissing) continue; // inserted by error recovery
    if (gv.parent?.type === 'global_assignment') continue;
    const defined = table.globals.get(gv.text);
    if (defined) {
      if (programScope && !programScope.globals.has(gv.text)) reportNotLoaded(gv, 'Defglobal', gv.text, [defined], out);
      continue;
    }
    if (table.externals.has(externalKey('defglobal', gv.text))) continue;
    out.push(
      diag(
        gv,
        `Unknown global variable "${gv.text}" — no defglobal for it in the workspace${note}`,
        DiagnosticSeverity.Warning,
        'global-unknown',
        { data: { kind: 'defglobal', name: gv.text } satisfies UnknownNameData }
      )
    );
  }
}

// defmethod / defgeneric call-argument types

/**
 * Types of a method's parameter at `index`.
 *
 * @param methodNode - A `defmethod_construct` node.
 * @param index - The parameter position, 0-based.
 * @returns The types, or `null` if untyped or absent.
 */
function restrictionTypesAt(methodNode: SyntaxNode, index: number): string[] | null {
  const restrictions = methodNode.children.filter((c) => c.type === 'parameter_restriction');
  if (index < restrictions.length) {
    const types = restrictions[index].children.filter((c) => c.type === 'name').map((c) => nameKey(c));
    return types.length > 0 ? types : null;
  }
  const wildcard = methodNode.children.find((c) => c.type === 'wildcard_parameter_restriction');
  if (wildcard) {
    const types = wildcard.children.filter((c) => c.type === 'name').map((c) => nameKey(c));
    return types.length > 0 ? types : null;
  }
  return null;
}

/**
 * Type of a call argument: a literal, or a pattern variable whose slot has one type.
 *
 * @param argNode - The argument.
 * @param table - The lookup scope.
 * @returns The {@link literalType} type, or `null` if unknown.
 */
function argType(argNode: SyntaxNode, table: SymbolTable): string | null {
  if (argNode.type === 'constant') return literalType(argNode);
  if (argNode.type !== 'variable') return null;
  const inner = argNode.firstChild;
  if (!inner || inner.type !== 'single_field_variable') return null;

  for (const def of findLocalDefinitions(inner)) {
    const slot = enclosingLhsSlot(def);
    if (!slot) continue;
    const ctx = resolveTemplateSlot(slot, table);
    const types = ctx?.slotDefinition ? slotConstraints(ctx.slotDefinition).types : [];
    return types.length === 1 ? primitiveTypeToLiteral(types[0]) : null;
  }
  return null;
}

/**
 * A declared type in {@link literalType} terms.
 *
 * @param declared - A slot or parameter type.
 * @returns The type, or `null` if too broad to compare.
 */
function primitiveTypeToLiteral(declared: string): string | null {
  switch (declared) {
    case 'INTEGER':
      return 'INTEGER';
    case 'FLOAT':
      return 'FLOAT';
    case 'STRING':
      return 'STRING';
    case 'SYMBOL':
      return 'SYMBOL';
    case 'INSTANCE-NAME':
      return 'INSTANCE-NAME';
    default:
      return null; // NUMBER, LEXEME, classes: too broad to compare
  }
}

/**
 * Arguments to generics that no method's primitive type restriction accepts.
 *
 * @param root - The document's root.
 * @param table - The lookup scope.
 * @param out - Output.
 */
function checkGenericCallArguments(root: SyntaxNode, table: SymbolTable, out: Diagnostic[]): void {
  for (const call of root.descendantsOfType('function_call')) {
    if (call.hasError) continue;
    const kids = call.namedChildren;
    if (kids[0]?.type !== 'function_name') continue;

    const overloads = table.functionLike.get(functionNameKey(kids[0]));
    if (!overloads || overloads.length === 0) continue;
    if (!overloads.every((o) => o.definitionNode.type === 'defmethod_construct' || o.definitionNode.type === 'defgeneric_construct')) {
      continue;
    }
    const methods = overloads
      .map((o) => o.definitionNode)
      .filter((n) => n.type === 'defmethod_construct');
    if (methods.length === 0) continue;

    const args = kids.slice(1);
    for (let i = 0; i < args.length; i++) {
      const type = argType(args[i], table);
      if (!type) continue;

      const perMethod = methods.map((m) => restrictionTypesAt(m, i));
      if (perMethod.some((r) => r === null)) continue; // some method takes anything here
      if (!perMethod.every((r) => r!.every((t) => PRIMITIVE_TYPE_NAMES.has(t)))) continue;

      const acceptedBySome = perMethod.some((r) => r!.some((t) => literalSatisfiesTypes(type, [t])));
      if (!acceptedBySome) {
        const expected = [...new Set(perMethod.flat() as string[])].join(' / ');
        out.push(
          diag(
            args[i],
            `Argument ${i + 1} to generic "${kids[0].text}" is ${type}, but no applicable method accepts it (expected ${expected})`,
            DiagnosticSeverity.Warning,
            'method-arg-type'
          )
        );
      }
    }
  }
}

// function-unknown

/**
 * Whether a call head may be fact syntax: a direct field of an asserted
 * or deffacts fact (a slot if the template exists, which may be outside
 * the workspace), or anything inside a {@link NON_CALL_ARGUMENT_FUNCTIONS}
 * call.
 *
 * @param functionNameNode - The call head.
 * @returns `true` to skip the function checks.
 */
function isFactRepresentationContext(functionNameNode: SyntaxNode): boolean {
  const call = functionNameNode.parent;
  // =(...) is always a real call.
  if (call?.parent?.type === 'RHS_field' && call.parent.parent?.type === 'ordered_RHS_pattern' && call.parent.firstChild?.type !== '=') return true;

  for (let a: SyntaxNode | null = call; a; a = a.parent) {
    if (a.type === 'function_call') {
      const head = a.namedChildren[0];
      if (head?.type === 'function_name' && NON_CALL_ARGUMENT_FUNCTIONS.has(head.text)) return true;
    }
  }
  return false;
}

/**
 * Whether a call is left over from a construct broken by a syntax error.
 * The parser recovers the rest of such a construct as top-level calls, or
 * keeps it inside the ERROR node; checking those would only add noise.
 *
 * @param call - A call.
 * @returns `true` if it is inside an ERROR or follows one, with no intact construct in between.
 */
function isErrorRecoveryDebris(call: SyntaxNode): boolean {
  let top = call;
  while (top.parent && top.parent.parent) {
    top = top.parent;
    if (top.type === 'construct') return false;
    if (top.type === 'ERROR') return true;
  }
  if (top.type !== 'function_call') return false;

  for (let prev = top.previousSibling; prev; prev = prev.previousSibling) {
    if (prev.type === 'comment_line' || prev.type === 'function_call') continue;
    return prev.type === 'ERROR' || prev.hasError;
  }
  return false;
}

/**
 * Calls to names that are neither user functions nor known built-ins.
 * Only a warning: the list may miss optional or newer functions.
 *
 * @param root - The document's root.
 * @param table - The lookup scope.
 * @param out - Output.
 * @param programScope - The program's scope, for "not loaded" checks.
 * @param note - Appended to unknown-name messages.
 */
function checkUnknownFunctionCalls(
  root: SyntaxNode,
  table: SymbolTable,
  out: Diagnostic[],
  programScope: SymbolTable | null = null,
  note = ''
): void {
  for (const call of root.descendantsOfType('function_call')) {
    if (call.hasError) continue;
    const head = call.namedChildren[0];
    if (head?.type !== 'function_name') continue;
    // A built-in can't take a module prefix: CLIPS reports (MAIN::printout ...) as unknown.
    const name = functionNameKey(head);
    const qualified = isQualifiedCall(head);
    const defined = table.functionLike.get(name);
    if (defined && defined.length > 0) {
      if (
        programScope &&
        !programScope.functionLike.has(name) &&
        !BUILTIN_FUNCTIONS.has(name) &&
        !isFactRepresentationContext(head) &&
        !isErrorRecoveryDebris(call)
      ) {
        reportNotLoaded(head, 'Function', name, defined, out);
      }
      continue;
    }
    // Host functions can't take a module prefix either.
    if ((BUILTIN_FUNCTIONS.has(name) || table.hostFunctions.has(name)) && !qualified) continue;
    if (isFactRepresentationContext(head)) continue;
    if (isErrorRecoveryDebris(call)) continue;
    out.push(
      diag(
        head,
        `Unknown function "${head.text}" -- not a user-defined function/method in the workspace, and not one of the ${BUILTIN_FUNCTIONS.size} common built-ins this server recognizes (it may still be a valid CLIPS function not in that list yet)${note}`,
        DiagnosticSeverity.Warning,
        'function-unknown',
        { data: { kind: 'function', name } satisfies UnknownNameData }
      )
    );
  }
}

// function-arity

/**
 * Argument counts of deffunction calls; generics are skipped. The
 * document's own definition is preferred.
 *
 * @param root - The document's root.
 * @param table - The lookup scope.
 * @param uri - The document's URI.
 * @param out - Output.
 */
function checkFunctionArity(root: SyntaxNode, table: SymbolTable, uri: string, out: Diagnostic[]): void {
  for (const call of root.descendantsOfType('function_call')) {
    if (call.hasError) continue;
    const head = call.namedChildren[0];
    if (head?.type !== 'function_name') continue;
    // In (assert (cheese (name "x"))) `name` is a slot, even if a deffunction `name` exists.
    if (isFactRepresentationContext(head)) continue;
    if (isErrorRecoveryDebris(call)) continue;

    const overloads = table.functionLike.get(functionNameKey(head)) ?? [];
    const deffunctions = overloads.filter((o) => o.definitionNode.type === 'deffunction_construct');
    // Otherwise an unrelated copy of the file elsewhere in the workspace disables the check.
    const own = deffunctions.filter((o) => uriKey(o.uri) === uriKey(uri));
    const candidates = own.length > 0 ? own : deffunctions;
    if (overloads.length === 0) {
      checkHostFunctionArity(call, head, table, out);
      continue;
    }
    if (candidates.length !== 1) continue;

    const fn = candidates[0].definitionNode;
    // CLIPS rejects duplicate parameters ([PRCCODE7]); that's reported at the definition.
    const params = fn.children.filter((c) => c.type === 'regular_parameter' || c.type === 'wildcard_parameter');
    if (new Set(params.map((p) => bareVarName(p.text))).size !== params.length) continue;
    const required = fn.children.filter((c) => c.type === 'regular_parameter').length;
    const hasWildcard = fn.children.some((c) => c.type === 'wildcard_parameter');
    const argCount = call.namedChildren.length - 1;

    if (argCount < required || (!hasWildcard && argCount > required)) {
      const expected = hasWildcard
        ? `at least ${required} argument${required === 1 ? '' : 's'}`
        : `exactly ${required} argument${required === 1 ? '' : 's'}`;
      out.push(
        diag(
          head,
          `"${head.text}" expects ${expected}, but this call has ${argCount}`,
          DiagnosticSeverity.Error,
          'function-arity'
        )
      );
    }
  }
}

/**
 * Argument counts of host function calls ([ARGACCES1]). Skipped without
 * declared counts, for qualified calls, and with `$?` arguments.
 *
 * @param call - The call.
 * @param head - Its `function_name` node.
 * @param table - The lookup scope.
 * @param out - Output.
 */
function checkHostFunctionArity(call: SyntaxNode, head: SyntaxNode, table: SymbolTable, out: Diagnostic[]): void {
  if (isQualifiedCall(head)) return;
  const host = table.hostFunctions.get(functionNameKey(head));
  const min = host?.signature.min_args;
  const max = host?.signature.max_args;
  if (!host || min == null || max == null) return;
  const args = call.namedChildren.slice(1).filter((n) => n.type !== 'comment_line');
  const multifield = new Set(['multifield_variable', 'multifield_global_variable']);
  if (args.some((a) => a.type === 'variable' && multifield.has(a.firstChild?.type ?? ''))) return;

  const low = Number(min);
  const high = max === 'UNBOUNDED' ? Infinity : Number(max);
  if (args.length >= low && args.length <= high) return;
  /** `n argument(s)`. */
  const plural = (n: number) => `${n} argument${n === 1 ? '' : 's'}`;
  const expected =
    low === high ? `exactly ${plural(low)}` : high === Infinity ? `at least ${plural(low)}` : `${low} to ${plural(high)}`;
  out.push(
    diag(
      head,
      `"${head.text}" expects ${expected}, but this call has ${args.length} (host function, declared in ${displayName(host.uri)})`,
      DiagnosticSeverity.Error,
      'function-arity',
      { relatedInformation: [{ location: { uri: host.uri, range: toRange(host.nameNode) }, message: `(defudf ${host.name} ...)` }] }
    )
  );
}

// deffunction-replaces-external

/**
 * A deffunction named like a built-in or host function ([DFFNXPSR2]).
 *
 * @param table - The document's own table.
 * @param scope - The lookup scope.
 * @param out - Output.
 */
function checkDeffunctionReplacesExternal(table: SymbolTable, scope: SymbolTable, out: Diagnostic[]): void {
  for (const [name, entries] of table.functionLike) {
    const host = scope.hostFunctions.get(name);
    if (!BUILTIN_FUNCTIONS.has(name) && !host) continue;
    const what = host ? `a function the host program registers (declared in ${displayName(host.uri)})` : 'a CLIPS built-in function';
    for (const entry of entries) {
      if (entry.definitionNode.type !== 'deffunction_construct') continue;
      out.push(
        diag(
          entry.nameNode,
          `"${name}" is ${what}, and CLIPS does not allow a deffunction to replace an external function; rename it, or overload it with a defmethod`,
          DiagnosticSeverity.Error,
          'deffunction-replaces-external',
          host ? { relatedInformation: [{ location: { uri: host.uri, range: toRange(host.nameNode) }, message: `(defudf ${name} ...)` }] } : {}
        )
      );
    }
  }
}

// slot-missing-required

/**
 * `(default ?NONE)` slots not set when a fact is created.
 *
 * @param headNode - The fact head.
 * @param template - The template.
 * @param setSlots - The slots that are set.
 * @param out - Output.
 */
function reportMissingNoneSlots(
  headNode: SyntaxNode,
  template: SymbolEntry,
  setSlots: Set<string>,
  out: Diagnostic[]
): void {
  for (const child of template.definitionNode.children) {
    if (child.type !== 'slot_definition') continue;
    const inner = child.firstChild;
    if (!inner) continue;
    const nameNode = inner.children.find((c) => c.type === 'name');
    if (!nameNode) continue;
    const slotName = nameKey(nameNode);
    if (setSlots.has(slotName)) continue;

    const defAttr = inner.descendantsOfType('default_attribute')[0];
    if (!defAttr || !/\?NONE\b/.test(defAttr.text)) continue;

    out.push(
      diag(
        headNode,
        `Required slot "${slotName}" (default ?NONE) is not set when asserting "${template.name}"`,
        DiagnosticSeverity.Error,
        'slot-missing-required'
      )
    );
  }
}

/**
 * An asserted or deffacts fact of a known template: its slots and the
 * required slots it leaves out.
 *
 * @param pattern - An `ordered_RHS_pattern`.
 * @param table - The lookup scope.
 * @param out - Output.
 */
function checkRhsPattern(pattern: SyntaxNode, table: SymbolTable, out: Diagnostic[]): void {
  const headNode = pattern.children.find((c) => c.type === 'name');
  if (!headNode) return;
  const template = table.templates.get(nameKey(headNode));
  if (!template) return;

  const setSlots = new Set<string>();
  for (const field of pattern.children) {
    if (field.type !== 'RHS_field') continue;
    const call = field.firstChild; // `=` for =(...), which is no slot
    if (call?.type !== 'function_call' || !resolveRhsPatternSlot(call, table)) continue;
    const slotNameNode = call.namedChildren[0];
    setSlots.add(slotNameNode.text);
    checkSlotAssignment(template, call, slotNameNode, call.namedChildren.slice(1), out);
  }
  reportMissingNoneSlots(headNode, template, setSlots, out);
}

/**
 * Required slots of asserted and deffacts facts. modify and duplicate keep
 * the other slots, so they aren't checked.
 *
 * @param root - The document's root.
 * @param table - The lookup scope.
 * @param out - Output.
 */
function checkMissingRequiredSlots(root: SyntaxNode, table: SymbolTable, out: Diagnostic[]): void {
  for (const pattern of root.descendantsOfType('ordered_RHS_pattern')) {
    if (pattern.hasError) continue;
    checkRhsPattern(pattern, table, out);
  }
}

// class-inheritance-cycle

/**
 * Inheritance cycles among this file's classes, each reported once.
 *
 * @param table - The document's own table.
 * @param out - Output.
 */
function checkClassInheritanceCycles(table: SymbolTable, out: Diagnostic[]): void {
  const supersOf = new Map<string, string[]>();
  for (const [name, entry] of table.classes) {
    const supers: string[] = [];
    let seenIsA = false;
    for (const child of entry.definitionNode.children) {
      if (!seenIsA) {
        if (child.type === 'is-a') seenIsA = true;
        continue;
      }
      if (child.type === ')') break;
      if (child.type === 'name') supers.push(nameKey(child));
    }
    supersOf.set(name, supers);
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const reportedCycles = new Set<string>();

  /** Depth-first search from a class; reports each cycle once. */
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      const cycle = path.slice(path.indexOf(name)).concat(name);
      const key = [...new Set(cycle)].sort().join(',');
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        const entry = table.classes.get(name);
        if (entry) {
          out.push(
            diag(
              entry.nameNode,
              `Class inheritance cycle: ${cycle.join(' -> ')}`,
              DiagnosticSeverity.Error,
              'class-inheritance-cycle'
            )
          );
        }
      }
      return;
    }
    state.set(name, 'visiting');
    for (const superclass of supersOf.get(name) ?? []) {
      if (supersOf.has(superclass)) visit(superclass, [...path, name]);
    }
    state.set(name, 'done');
  };

  for (const name of supersOf.keys()) visit(name, []);
}
