/**
 * @file Incremental parsing: after each edit the tree must equal a full parse.
 */

import Parser from 'tree-sitter';
import Clips from 'tree-sitter-clips';
import { parseDocument, getTree, removeDocument } from '../dist/parsing.js';

/** Parser for the full parses to compare with. */
const reference = new Parser();
reference.setLanguage(Clips);

/** URI of the edited document. */
const uri = 'file:///incremental.clp';

/** Number of failed checks. */
let failures = 0;
/**
 * Records a check result.
 *
 * @param label - What is checked.
 * @param condition - Whether it passed.
 * @param detail - Printed after the label.
 */
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!condition) failures++;
}

/** The text the edits start from. */
const base = `(deftemplate sensor "a reading"
  (slot id)
  (multislot samples))

(defglobal ?*threshold* = 10)

(deffunction average (?a ?b)
  (bind ?sum (+ ?a ?b))
  (/ ?sum 2))

(defrule check
  ?s <- (sensor (id ?sid) (samples $?data))
  =>
  (average ?sid ?*threshold*))
`;

/**
 * Applies one string edit and checks that the incremental tree matches a full parse.
 *
 * @param label - Name of the edit.
 * @param text - The new text.
 */
function step(label, text) {
  const before = getTree(uri);
  const incremental = parseDocument(uri, text);
  const full = reference.parse(text);

  check(`${label}: structure matches full parse`, incremental.rootNode.toString() === full.rootNode.toString());

  // Only shows that an old tree was reused; the comparison above is what matters.
  if (before && before !== incremental && typeof before.getChangedRanges === 'function') {
    const ranges = before.getChangedRanges(incremental);
    const spanned = ranges.reduce((n, r) => n + (r.endIndex - r.startIndex), 0);
    check(`${label}: changed ranges are bounded`, spanned <= text.length,
      `${spanned} of ${text.length} chars in changed ranges`);
  }
}

try {
  parseDocument(uri, base);
  check('initial parse matches full parse',
    getTree(uri).rootNode.toString() === reference.parse(base).rootNode.toString());

  const cached = getTree(uri);
  check('no-op change returns the cached tree object', parseDocument(uri, base) === cached);

  step('insert slot attribute',
    base.replace('(slot id)', '(slot id (type INTEGER))'));

  step('delete slot attribute',
    base.replace('(slot id)', '(slot id (type INTEGER))').replace(' (type INTEGER)', ''));

  step('rename ?*threshold* -> ?*limit*',
    base.replaceAll('?*threshold*', '?*limit*'));

  step('insert a new deffunction mid-file',
    base.replace('(defrule check', '(deffunction twice (?x) (* 2 ?x))\n\n(defrule check'));

  step('edit at start of file',
    base.replace('(deftemplate sensor "a reading"', '(deftemplate sensor "a sensor reading"'));

  step('append trailing construct',
    base + '\n(defglobal ?*extra* = 0)\n');

  step('introduce a syntax error', base.replace('(/ ?sum 2))', '(/ ?sum 2)'));
  step('repair the syntax error', base);

  step('wholesale replace',
    '(defclass Widget (is-a USER) (slot label))\n(definstances things (w of Widget))\n');

  removeDocument(uri);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall incremental-parse checks passed');
  }
} catch (err) {
  console.error('incremental test failed:', err);
  process.exitCode = 1;
}
