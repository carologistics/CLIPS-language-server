/**
 * @file Syntax diagnostic messages, including errors the Node binding hides.
 */

import { collectSyntaxDiagnostics, parseText } from '../dist/parsing.js';

/** Sources and the syntax messages expected for them, in order. */
const cases = [
  // [source, expected messages in order]
  ['(defmethod m ((?x)) ?x)', ['A parameter restriction in parentheses needs a type or a query; write the parameter without parentheses for no restriction']],
  ['(defmethod m (($?rest)) ?rest)', ['A parameter restriction in parentheses needs a type or a query; write the parameter without parentheses for no restriction']],
  ['(deffunction f () (loop-for-count 3))', ['loop-for-count needs `do` or an action after the range']],
  ['(deffunction f () (loop-for-count (?i 1 3)))', ['loop-for-count needs `do` or an action after the range']],
  ['(deftemplate)', ['Missing deftemplate name']],
  ['(defrule (foo) => (bar))', ['Missing defrule name']],
  ['(defclass (is-a USER))', ['Missing defclass name']],
  ['(deftemplate t (slot))', ['Missing slot name']],
  ['(defclass A (is-a))', ['A class needs at least one superclass after is-a']],
  ['(defrule r (a ?_x) =>)', ['"?_x" is not a valid variable: a variable name must start with a letter']],
  ['(defrule r (b $?-y) =>)', ['"$?-y" is not a valid variable: a variable name must start with a letter']],
  ['(deffunction f (?1x) 1)', ['"?1x" is not a valid variable: a variable name must start with a letter']],
  ['(deffunction f () (printout t ?_x))', ['"?_x" is not a valid variable: a variable name must start with a letter']],
  ['(defrule r (a) (logical (b)) =>)', ['Logical CEs must come before all other conditional elements of a rule']],
  ['(defmodule M (export deftemplate))', ['Name the deftemplate constructs here, or use ?ALL or ?NONE']],
  ['(deftemplate t (slot x (range ?low 10)))', ['Syntax error near "?low"', 'range takes a number or ?VARIABLE']],
  ['(deftemplate t (multislot x (cardinality ?n 2)))', ['Syntax error near "?n"', 'cardinality takes an integer or ?VARIABLE']],
  // a visible error does not hide a hidden one elsewhere
  ['(deftemplate a (slot x) ())\n(deftemplate)', ['Syntax error near "()"', 'Missing deftemplate name']],
  // valid code stays clean
  ['(defmethod m ((?x INTEGER) ?y) ?x)\n(deffunction f () (loop-for-count 3 do))', []]
];

/** Number of failed checks. */
let failures = 0;
for (const [src, want] of cases) {
  const got = collectSyntaxDiagnostics(parseText(src)).map((d) => d.message);
  const pass = got.length === want.length && got.every((m, i) => m === want[i]);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${JSON.stringify(src)}`);
  if (!pass) {
    console.log(`      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`);
    failures++;
  }
}
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall syntax message checks passed');
}
