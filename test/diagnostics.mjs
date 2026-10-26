/**
 * @file Semantic diagnostics: one fixture triggers every check; each case
 * expects a code on a given line.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-jsonrpc/node.js';

/** The built server. */
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url));

/** Fixture with the cases the checks below refer to by line. */
const src = `(deftemplate cheese
  (slot prune (type SYMBOL) (allowed-values no yes))
  (slot temp (type FLOAT) (range 6.0 7.99))
  (slot rating (type INTEGER) (default "bad"))
  (slot rating (type INTEGER))
  (multislot tags))

(deftemplate ok-template
  (slot a)
  (slot b))

(deftemplate ok-template
  (slot a))

(defglobal ?*known* = 3)

(defclass Vehicle (is-a Machine)
  (slot wheels))

(definstances fleet ([v1] of Rocket))

(defgeneric weigh)
(defmethod weigh ((?n NUMBER)) (* ?n 2))

(deffunction dup-params (?x ?x) (+ ?x 1))

(deffunction calls-dup-params ()
  (dup-params 5))

(defrule ok-rule
  (ok-template (a ?a))
  =>
  (printout t ?a crlf))

(defrule problems
  ?self <- (cheese (prune maybe) (temp 42.0) (missing ?w) (tags ?one))
  (not (widget (id ?wid)))
  (test (eq ?wid ?never))
  =>
  (printout t ?ghost crlf ?*missing* crlf)
  (weigh "heavy")
  (bind ?dead 1))

(defrule tag-member
  (cheese (tags $? ?t $?))
  =>
  (printout t ?t crlf))

(defrule uses-mystery-template
  (mystery-fact (x 1))
  =>
  (printout t "hi" crlf))

(deftemplate widget-a
  (slot id (type INTEGER)))

(deftemplate widget-b
  (slot id (type SYMBOL)))

(defrule impossible-join
  (widget-a (id ?wid2))
  (widget-b (id ?wid2))
  =>
  (printout t ?wid2 crlf))

(deftemplate required-thing
  (slot mandatory (default ?NONE))
  (slot optional))

(defrule assert-missing-required
  =>
  (assert (required-thing (optional 1))))

(defclass Loopy (is-a Loopy2)
  (slot x))

(defclass Loopy2 (is-a Loopy)
  (slot y))

(defrule shadow-pattern-example
  (ok-template (a ?matched))
  =>
  (bind ?matched 2)
  (println ?matched))

(deffunction shadow-example (?x)
  (bind ?x (+ ?x 1))
  (printout t ?x crlf))

(deffunction use-before-bind-example ()
  (printout t ?late crlf)
  (bind ?late 1))

(deffunction needs-two-args (?a ?b)
  (+ ?a ?b))

(defrule qualified-calls
  =>
  (MAIN::needs-two-args 1 2)
  (MAIN::needs-two-args 1)
  (MAIN::printout t "x" crlf))

(defrule calls-things
  =>
  (needs-two-args 1)
  (totally-made-up-function 1))

(defrule fact-actions
  ?c <- (ok-template (a 1))
  =>
  (assert (needs-two-args))
  (modify ?c (a (another-made-up-function 2))))

(defrule modify-slots
  ?ch <- (cheese (prune no))
  ?ord <- (shelf 3)
  =>
  (modify ?ch (ripeness 5))
  (modify ?ch (prune perhaps))
  (duplicate ?ch (temp 6.5 7.0))
  (modify ?ch (temp 7.5) (tags a b))
  (modify ?ord (level 4)))

(defrule loop-indexes
  =>
  (foreach ?item (create$ a b) (println ?item " at " ?item-index))
  (progn$ (?elt (create$ c d)) (println ?elt " at " ?elt-index)))

(defrule loop-scopes
  =>
  (foreach ?outer (create$ 1 2)
    (progn$ (?inner (create$ 3 4))
      (println ?outer ?outer-index ?inner ?inner-index)))
  (println ?outer-index)
  (loop-for-count (?n 1 2) (println ?n))
  (println ?n)
  (do-for-all-facts ((?qf cheese)) TRUE (println ?qf))
  (println "after" ?qf))

(deffunction fn-scopes (?p $?rest)
  (foreach ?e ?rest (println ?e ?e-index ?p))
  (println "after" ?e-index)
  (println ?ghost))

(defmethod method-scopes ((?n NUMBER (> ?n 0)))
  (println ?n ?missing))

(defmessage-handler Vehicle describe ()
  (println ?self:wheels))

(defrule slot-shorthand-after-query
  =>
  (do-for-all-facts ((?sq cheese)) TRUE (println ?sq:prune))
  (println "late" ?sq:prune)
  (println ?nobody:prune))

(defrule return-value-fields
  ?c <- (cheese (temp ?t))
  =>
  (duplicate ?c (temp =(+ ?t 0.5)))
  (assert (temperature =(no-such-function ?t))))

(definstances nameless-of
  (of NoSuchClass))

(defclass Legacy (is-a INITIAL-OBJECT))

(defrule modify-slotless-pattern
  ?bare <- (ok-template)
  =>
  (modify ?bare (a 2))
  (do-for-all-facts ((?q cheese)) TRUE (modify ?q (prune perhaps))))

(deffunction modify-unknown-fact (?p)
  (modify ?p (anything 1)))

(deffacts stock
  (cheese (prune yes) (flavour mild))
  (cheese (prune sometimes))
  (cheese (temp 6.5 7.0))
  (cheese (temp (made-up-in-slot-value 1)))
  (cheese (temp 7.0) (tags a b c))
  (shelf-count (+ 1 2)))

(load "rules.clp")
(reset)
(printout t "ready" crlf)
(batch-made-up-command 1)
(run)
`;

/**
 * A rule cut short by a malformed `(if ...)` (no `then`), with templates
 * from the CLIPS 6.4.2 example animal.clp. The parser keeps everything
 * past the break inside one top-level ERROR node, the rest of the rule
 * as calls -- even the deffunction, whose closing paren the ERROR
 * swallowed. Error recovery is sensitive to the surrounding text: change
 * this and re-check the tree has that shape.
 * Opened as its own document so the error can't disturb `src`.
 */
const debrisSrc = `(deftemplate MAIN::rule
   (slot name (default-dynamic (gensym)))
   (slot validate (default no))
   (multislot if)
   (multislot then)
   (multislot processed))

(deftemplate MAIN::question
   (multislot valid-answers)
   (slot variable)
   (slot query))

(deftemplate MAIN::answer
   (slot variable)
   (slot prefix (default ""))
   (slot postfix (default "")))

(deftemplate MAIN::goal
   (slot variable))

(deftemplate MAIN::variable
   (slot name)
   (slot value))

(defrule ask
   =>
   (if backbone is yes)
   (question (variable backbone))
   (answer (variable x)))

(deffunction after-the-error ()
  (printout t "done" crlf))
`;

/**
 * The 0-based line of the `occurrence`-th `needle` in `text`.
 *
 * @param needle - Text to find.
 * @param occurrence - Which match, 0-based.
 * @param text - The text to search.
 * @returns The line.
 */
function lineOf(needle, occurrence = 0, text = src) {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(needle, index + 1);
    if (index === -1) throw new Error(`needle not found: "${needle}" (#${occurrence})`);
  }
  return text.slice(0, index).split('\n').length - 1;
}

/** The server under test. */
const child = spawn(process.execPath, [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (chunk) => process.stderr.write(`[server stderr] ${chunk}`));

/** JSON-RPC connection to the server. */
const connection = createMessageConnection(
  new StreamMessageReader(child.stdout),
  new StreamMessageWriter(child.stdin)
);
connection.listen();

/** Latest diagnostics for the fixture. */
let diagnostics = [];
/** Latest diagnostics for `debris.clp`. */
let debrisDiagnostics = [];
connection.onNotification('textDocument/publishDiagnostics', (params) => {
  if (params.uri === 'file:///debris.clp') debrisDiagnostics = params.diagnostics;
  else diagnostics = params.diagnostics;
});

/** Number of failed checks. */
let failures = 0;

/**
 * Checks that a diagnostic with `code` is on `line`.
 *
 * @param label - What is checked.
 * @param code - The code without `clips(...)`.
 * @param line - The line, 0-based.
 */
function expect(label, code, line) {
  const hit = diagnostics.find((d) => d.code === `clips(${code})` && d.range.start.line === line);
  console.log(`${hit ? 'PASS' : 'FAIL'}  ${label}`);
  if (!hit) {
    console.log(`      wanted clips(${code}) on line ${line + 1}`);
    console.log(
      `      got: ${JSON.stringify(diagnostics.filter((d) => d.range.start.line === line).map((d) => d.code))}`
    );
    failures++;
  }
}

/**
 * Checks that no diagnostic of any kind starts on `line`.
 *
 * @param label - What is checked.
 * @param line - The line, 0-based.
 */
function expectClean(label, line) {
  const hits = diagnostics.filter((d) => d.range.start.line === line);
  const pass = hits.length === 0;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  -> ${JSON.stringify(hits.map((d) => d.code))}`}`);
  if (!pass) failures++;
}

/**
 * Checks that a diagnostic with `code` exists, on any line. For checks whose
 * line depends on map iteration order.
 *
 * @param label - What is checked.
 * @param code - The code without `clips(...)`.
 */
function expectSomewhere(label, code) {
  const hit = diagnostics.some((d) => d.code === `clips(${code})`);
  console.log(`${hit ? 'PASS' : 'FAIL'}  ${label}`);
  if (!hit) failures++;
}

try {
  await connection.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  await connection.sendNotification('initialized', {});

  connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri: 'file:///diag.clp', languageId: 'clips', version: 1, text: src }
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Duplicates
  expect('duplicate slot name', 'duplicate-slot', lineOf('(slot rating (type INTEGER))\n  (multislot'));
  expect('duplicate construct name (deftemplate ok-template)', 'duplicate-construct', lineOf('deftemplate ok-template', 1));

  // Type checks
  expect('slot default violates own type', 'slot-value-type', lineOf('(default "bad")'));
  expect('constant not in allowed-values', 'slot-value-not-allowed', lineOf('(prune maybe)'));
  expect('number outside slot range', 'slot-value-range', lineOf('(temp 42.0)'));
  expect('generic-call argument type mismatch', 'method-arg-type', lineOf('(weigh "heavy")'));

  // Undefined references
  expect('unknown slot on known template', 'slot-unknown', lineOf('(missing ?w)'));
  expect('unknown deftemplate (slot syntax used)', 'template-unknown', lineOf('(mystery-fact (x 1))'));
  expect('unknown class (is-a superclass)', 'class-unknown', lineOf('(is-a Machine)'));
  expect('unknown class (definstances of)', 'class-unknown', lineOf('of Rocket'));
  expect('unknown global', 'global-unknown', lineOf('?*missing*'));

  // Variables
  expect('duplicate parameter', 'duplicate-parameter', lineOf('(?x ?x)'));
  expect('unbound variable on RHS', 'variable-unbound', lineOf('?ghost'));
  expect('unbound variable in a predicate', 'variable-unbound', lineOf('(eq ?wid ?never)'));
  expect('variable bound in not, used outside', 'variable-scope-escape', lineOf('(eq ?wid ?never)'));
  expect('unused bind target', 'variable-unused', lineOf('(bind ?dead 1)'));
  expect('single-field var on a multislot', 'slot-arity-single-on-multi', lineOf('(tags ?one)'));

  expect('LHS pattern-bound var never referenced elsewhere', 'variable-unused-pattern', lineOf('(tags ?one)'));
  expectClean('single-field var between $? wildcards on a multislot (element match)', lineOf('(cheese (tags $? ?t $?))'));

  // More checks
  expect('unknown function call', 'function-unknown', lineOf('(totally-made-up-function 1))'));
  expect('variable read before its own (bind ...)', 'variable-used-before-bound', lineOf('(printout t ?late crlf)'));
  expect(
    'rebind against incompatible slot types across CEs',
    'variable-rebind-type-conflict',
    lineOf('(widget-b (id ?wid2))')
  );
  expect('wrong argument count for a deffunction', 'function-arity', lineOf('(needs-two-args 1)'));
  // CLIPS rejects a deffunction with a duplicate parameter, so calls to it
  // aren't arity-checked.
  expectClean('call to a deffunction with a duplicate parameter', lineOf('(dup-params 5)'));

  // Module-qualified calls resolve on the function's own name; a built-in
  // can't take a module specifier (CLIPS: "Missing function declaration").
  expectClean('module-qualified call to a deffunction', lineOf('(MAIN::needs-two-args 1 2)'));
  expect('module-qualified call with wrong arity', 'function-arity', lineOf('(MAIN::needs-two-args 1)\n'));
  expect('module-qualified built-in', 'function-unknown', lineOf('(MAIN::printout t "x" crlf)'));
  expect(
    'fact construction omits a ?NONE-default slot',
    'slot-missing-required',
    lineOf('(assert (required-thing (optional 1))))')
  );
  expectSomewhere('class inheritance cycle', 'class-inheritance-cycle');
  // Rebinding a parameter to normalize it is a common CLIPS idiom; only
  // rebinding a pattern-bound name gets the hint.
  expectClean('bind reusing a parameter name is not flagged', lineOf('(bind ?x (+ ?x 1))'));
  expect('bind reuses a pattern-bound name', 'variable-shadow', lineOf('(bind ?matched 2)'));

  // Fact actions: an asserted fact head is not a call; a call in a modify slot value is.
  expectClean('asserted ordered fact sharing a deffunction name is not a call', lineOf('(assert (needs-two-args))'));
  expect('unknown function inside a modify slot value', 'function-unknown', lineOf('(another-made-up-function 2)'));

  // modify/duplicate slots, resolved through the fact-address binding
  expect('unknown slot in modify', 'slot-unknown', lineOf('(modify ?ch (ripeness 5))'));
  expect('modify value not in allowed-values', 'slot-value-not-allowed', lineOf('(modify ?ch (prune perhaps))'));
  expect('two values for a single-field slot in duplicate', 'slot-arity-multi-on-single', lineOf('(duplicate ?ch (temp 6.5 7.0))'));
  expect('modify on a fact bound to an ordered pattern', 'fact-action-ordered', lineOf('(modify ?ord (level 4))'));
  expectClean('modify on a template pattern written without slots is not an ordered fact', lineOf('(modify ?bare (a 2))'));
  expect('class after of without an instance name is checked', 'class-unknown', lineOf('(of NoSuchClass)'));
  // =(...) is one field holding the call's value (CLIPS 6.4.2), not a symbol `=` plus a call.
  expectClean('=(call) in a single-field slot is one value', lineOf('(duplicate ?c (temp =(+ ?t 0.5)))'));
  expect('the function in =(call) is a real call and is checked', 'function-unknown', lineOf('(assert (temperature =(no-such-function ?t)))'));
  // CLIPS 6.4.2 has no INITIAL-OBJECT ([INHERPSR3] on load).
  expect('INITIAL-OBJECT is not a built-in class in 6.4.2', 'class-unknown', lineOf('(defclass Legacy (is-a INITIAL-OBJECT))'));
  expectClean('foreach binds ?item-index next to ?item', lineOf('(println ?item " at " ?item-index)'));
  expectClean('progn$ binds ?elt-index next to ?elt', lineOf('(println ?elt " at " ?elt-index)'));
  // Loop and query variables exist only inside their form; CLIPS refuses
  // a rule reading one after it ([PRCCODE3] Undefined variable ...).
  expectClean('outer loop variables are visible in a nested loop', lineOf('(println ?outer ?outer-index ?inner ?inner-index)'));
  expect('foreach index read after the loop', 'variable-unbound', lineOf('(println ?outer-index)'));
  expect('loop-for-count counter read after the loop', 'variable-unbound', lineOf('(println ?n)\n'));
  expect('query variable read after the query', 'variable-unbound', lineOf('(println "after" ?qf))'));
  // Function bodies are checked too (CLIPS: Undefined variable ... in deffunction / in method).
  expectClean('deffunction: parameters and loop variables inside the loop', lineOf('(foreach ?e ?rest (println ?e ?e-index ?p))'));
  expect('deffunction: loop index read after the loop', 'variable-unbound', lineOf('(println "after" ?e-index)'));
  expect('deffunction: variable bound nowhere', 'variable-unbound', lineOf('(println ?ghost)'));
  expectClean('defmethod: restricted parameter, also inside its query', lineOf('(defmethod method-scopes ((?n NUMBER (> ?n 0)))'));
  expect('defmethod: variable bound nowhere', 'variable-unbound', lineOf('(println ?n ?missing)'));
  expectClean('message-handler: ?self:slot', lineOf('(println ?self:wheels)'));
  // ?var:slot reads the variable too.
  expectClean('query member slot inside its query', lineOf('(do-for-all-facts ((?sq cheese)) TRUE (println ?sq:prune))'));
  expect('query member slot read after the query', 'variable-unbound', lineOf('(println "late" ?sq:prune)'));
  expect('slot of a variable bound nowhere', 'variable-unbound', lineOf('(println ?nobody:prune)'));
  expect('modify of a fact-query variable checks its template', 'slot-value-not-allowed', lineOf('(modify ?q (prune perhaps))'));
  expectClean('valid modify of single and multislot', lineOf('(modify ?ch (temp 7.5) (tags a b))'));
  expectClean('modify of a parameter-bound fact is not checked', lineOf('(modify ?p (anything 1))'));

  // Slots of asserted / deffacts template facts
  expect('unknown slot in a deffacts fact', 'slot-unknown', lineOf('(cheese (prune yes) (flavour mild))'));
  expect('deffacts slot value not in allowed-values', 'slot-value-not-allowed', lineOf('(cheese (prune sometimes))'));
  expect('two values for a single-field slot in deffacts', 'slot-arity-multi-on-single', lineOf('(cheese (temp 6.5 7.0))'));
  expect('unknown function inside a slot value', 'function-unknown', lineOf('(made-up-in-slot-value 1)'));
  expectClean('valid deffacts template fact', lineOf('(cheese (temp 7.0) (tags a b c))'));
  expectClean('ordered fact holding a call', lineOf('(shelf-count (+ 1 2))'));

  // Top-level calls (batch-file style) parse and are checked like any other call
  // Clean even though rules.clp doesn't exist: this in-memory document has no
  // real path and there's no workspace folder, so the server has no directory
  // to resolve the load from and doesn't claim the file is missing (that case
  // is covered by test/loads.mjs).
  expectClean('top-level (load ...)', lineOf('(load "rules.clp")'));
  expectClean('top-level (reset)', lineOf('(reset)'));
  expectClean('top-level (printout ...)', lineOf('(printout t "ready" crlf)'));
  expect('unknown function in a top-level call', 'function-unknown', lineOf('(batch-made-up-command 1)'));

  // Clean code stays clean
  expectClean('clean deftemplate line', lineOf('(slot a)\n  (slot b)'));
  expectClean('clean rule LHS', lineOf('(ok-template (a ?a))'));
  expectClean('clean rule RHS', lineOf('(printout t ?a crlf))'));

  // Error-recovery debris inside a top-level ERROR node: the syntax error
  // is reported, the facts recovered as calls are not "unknown functions".
  connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri: 'file:///debris.clp', languageId: 'clips', version: 1, text: debrisSrc }
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  {
    const debrisLine = lineOf('(question (variable backbone)', 0, debrisSrc);
    const syntax = debrisDiagnostics.some((d) => d.code === undefined && d.range.start.line < debrisLine);
    console.log(`${syntax ? 'PASS' : 'FAIL'}  syntax error reported before the debris`);
    if (!syntax) failures++;
    const noise = debrisDiagnostics.filter((d) => d.code === 'clips(function-unknown)');
    const pass = noise.length === 0;
    console.log(`${pass ? 'PASS' : 'FAIL'}  calls inside a top-level ERROR are not unknown functions${pass ? '' : `  -> ${JSON.stringify(noise.map((d) => d.range.start.line + 1))}`}`);
    if (!pass) failures++;
  }

  await connection.sendRequest('shutdown');
  connection.sendNotification('exit');

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall diagnostics checks passed');
  }
} catch (err) {
  console.error('diagnostics test failed:', err);
  process.exitCode = 1;
} finally {
  connection.dispose();
  child.kill();
}
