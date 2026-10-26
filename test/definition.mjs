/**
 * @file Go-to-definition: each case clicks a position and checks the target.
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

/** The fixture definitions are resolved in. */
const src = `(deftemplate foo
  (slot bar))

(defglobal ?*count* = 0)

(defclass Animal
  (is-a USER))

(defclass Dog
  (is-a Animal))

(defmethod speak ((?x Dog))
  (printout t ?x crlf))

(definstances pets
  ([rex] of Dog))

(deffunction helper (?a ?b)
  (+ ?a ?b))

(defrule my-rule
  ?f <- (foo (bar ?x))
  =>
  (helper ?x ?*count*)
  (printout t foo crlf))

(deffacts seed
  (foo (bar 9)))

(defrule remake
  ?g <- (foo (bar 1))
  =>
  (assert (foo (bar 2)))
  (modify ?g (bar 3)))

(deffunction poke (?h)
  (modify ?h (bar 4)))

(defmodule MAIN (export ?ALL))

(defrule waiting
  (not (ask))
  (foo)
  =>
  (assert (ask))
  (do-for-all-facts ((?q foo)) TRUE (modify ?q (bar 5))))

(deffacts MAIN::boot
  (ask))

(deffunction listing (?items)
  (foreach ?it ?items
    (println ?it-index)))

(defclass Store (is-a USER)
  (slot stock-flag)
  (multislot contents))

(defclass Depot (is-a Store))

(definstances depots
  ([d1] of Depot (contents [a] [b])))

(defrule audit-depot
  (object (is-a Depot) (name ?dep) (stock-flag yes))
  =>
  (modify-instance ?dep (stock-flag no)))

(deffunction introspect (?which)
  (println (slot-range Depot stock-flag) (deftemplate-slot-multip foo bar) (class-slots Store inherit) (slot-types Depot ?which)))

(defmodule LATER (import MAIN ?ALL))

(defmodule PORTS
  (import MAIN deftemplate foo)
  (import MAIN defclass Store)
  (export deffunction helper))

(definstances bare-depots
  (of Depot))

(defmessage-handler Store restock ()
  (send ?self tally))

(defmessage-handler Depot tally () 1)

(deffunction query-stores ()
  (do-for-all-instances ((?st Store)) TRUE (send ?st print)))

(deffacts stage-seed
  (stage start))

(defrule stage-advance
  ?s <- (stage start)
  =>
  (retract ?s)
  (assert (stage next)))

(defrule stage-finish
  (stage next)
  (pair $? 7)
  =>
  (assert (stage done))
  (assert (pair 1 7))
  (assert (pair 1 8)))

(defclass Lamp (is-a USER))

(definstances lamps
  (lamp-1 of Lamp)
  ([lamp-2] of Lamp))

(defrule lamp-work
  =>
  (make-instance [lamp-3] of Lamp)
  (duplicate-instance [lamp-3] to [lamp-4])
  (send [lamp-1] print)
  (send [lamp-2] print)
  (send [lamp-4] print)
  (send [ghost] print))
`;

/**
 * The position of the `occurrence`-th `needle` in the fixture.
 *
 * @param needle - Text to find.
 * @param occurrence - Which match, 0-based.
 * @returns The LSP position.
 */
function position(needle, occurrence = 0) {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = src.indexOf(needle, index + 1);
    if (index === -1) throw new Error(`needle not found: "${needle}" (occurrence ${occurrence})`);
  }
  const before = src.slice(0, index);
  const line = (before.match(/\n/g) ?? []).length;
  const character = index - before.lastIndexOf('\n') - 1;
  return { line, character };
}

/**
 * The fixture text a range covers.
 *
 * @param range - An LSP range.
 * @returns The text; a multi-line range gives its first line and `...`.
 */
function rangeText(range) {
  const lines = src.split('\n');
  if (range.start.line === range.end.line) {
    return lines[range.start.line].slice(range.start.character, range.end.character);
  }
  return `${lines[range.start.line].slice(range.start.character)}...`;
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

/** Number of failed checks. */
let failures = 0;
/**
 * Checks that the resolved locations cover `expectedText`.
 *
 * @param label - What is checked.
 * @param actual - The locations, or `null`.
 * @param expectedText - The texts joined by `, `, or `null` for no result.
 */
function check(label, actual, expectedText) {
  const got = actual === null ? null : actual.map((loc) => rangeText(loc.range)).join(', ');
  const pass = expectedText === null ? got === null : got === expectedText;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(got)}${pass ? '' : `  (expected ${JSON.stringify(expectedText)})`}`);
  if (!pass) failures++;
}

try {
  await connection.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  await connection.sendNotification('initialized', {});

  const uri = 'file:///defs.clp';
  connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId: 'clips', version: 1, text: src }
  });
  await new Promise((resolve) => setTimeout(resolve, 200));

  /**
   * Requests the definition at a position.
   *
   * @param pos - The position.
   * @returns The locations, or `null`.
   */
  async function goto(pos) {
    return connection.sendRequest('textDocument/definition', {
      textDocument: { uri },
      position: pos
    });
  }

  check('deftemplate reference (foo in LHS pattern head)',
    await goto(position('foo', 1 /* the LHS pattern head occurrence */)), 'foo');

  check('deftemplate slot reference (bar in (foo (bar ?x)) -> slot definition)',
    await goto(position('bar', 1 /* the LHS slot-name occurrence */)), 'bar');

  check('deffunction call reference (helper in RHS)',
    await goto(position('helper', 1)), 'helper');

  check('RHS local var reference (?x in helper call -> LHS binding)',
    await goto(position('?x', 3)), '?x');

  check('defglobal reference (?*count* in RHS)',
    await goto(position('?*count*', 1)), '?*count*');

  check('defclass is-a superclass reference (Animal in Dog is-a)',
    await goto(position('Animal', 1)), 'Animal');

  check('defmethod parameter type reference (Dog in parameter_restriction)',
    await goto(position('Dog', 1)), 'Dog');

  check('definstances instance-of class reference (Dog after "of" -> defclass)',
    await goto(position('Dog', 2)), 'Dog');

  check('deffunction parameter reference (?a in body)',
    await goto(position('?a', 1)), '?a');

  check('bare symbol argument (foo in printout, not a pattern reference) -> null',
    await goto(position('foo', 2 /* the printout t foo occurrence */)), null);

  check('built-in function call (printout) has no user-defined location -> null',
    await goto(position('printout', 0)), null);

  check('asserted fact head (foo in (assert (foo ...)) -> deftemplate)',
    await goto(position('foo (bar 2)')), 'foo');

  check('deffacts fact head (foo in deffacts body -> deftemplate)',
    await goto(position('foo (bar 9)')), 'foo');

  check('fact-address in modify (?g -> its ?g <- binding)',
    await goto(position('?g (bar 3)')), '?g');

  check('slot in modify (bar in (modify ?g (bar 3)) -> slot definition, via ?g <- (foo ...))',
    await goto(position('bar 3')), 'bar');

  check('slot in modify of a parameter-bound fact (template unknown) -> null',
    await goto(position('bar 4')), null);

  check('slot in an asserted template fact (bar in (assert (foo (bar 2))) -> slot definition)',
    await goto(position('bar 2')), 'bar');

  check('slot in a deffacts template fact (bar in (foo (bar 9)) -> slot definition)',
    await goto(position('bar 9')), 'bar');

  check('built-in fact action keyword (assert) has no user-defined location -> null',
    await goto(position('assert')), null);

  check('ordered fact in a pattern (ask, no deftemplate) -> where it is asserted',
    await goto(position('ask))')), 'ask, ask');

  check('template pattern without slots ((foo) parses as ordered) -> deftemplate',
    await goto({ ...position('(foo)'), character: position('(foo)').character + 1 }), 'foo');

  check('slot in modify of a fact-query variable (bar in (modify ?q (bar 5)) -> slot definition)',
    await goto(position('bar 5')), 'bar');

  check('module qualifier (MAIN in MAIN::boot -> defmodule)',
    await goto(position('MAIN::boot')), 'MAIN');

  check('implicit foreach index (?it-index -> the loop variable ?it)',
    await goto(position('?it-index')), '?it');

  check('slot in a definstances slot override (inherited from the superclass)',
    await goto(position('contents [a]')), 'contents');

  check('object pattern is-a class -> defclass',
    await goto(position('Depot) (name')), 'Depot');

  check('object pattern slot -> class slot',
    await goto(position('stock-flag yes')), 'stock-flag');

  check('object pattern (name ?dep) binds ?dep',
    await goto(position('?dep (stock-flag no)')), '?dep');

  check('slot in modify-instance of a (name ?x)-bound instance -> class slot',
    await goto(position('stock-flag no')), 'stock-flag');

  check('class argument of a built-in (slot-range Depot ...) -> defclass',
    await goto(position('Depot stock-flag')), 'Depot');

  check('slot argument of a built-in, inherited (slot-range Depot stock-flag) -> class slot',
    await goto(position('stock-flag) (deftemplate')), 'stock-flag');

  check('template argument of a built-in (deftemplate-slot-multip foo ...) -> deftemplate',
    await goto(position('foo bar)')), 'foo');

  check('slot argument of a template built-in (deftemplate-slot-multip foo bar) -> slot',
    await goto(position('bar) (class-slots')), 'bar');

  check('a keyword argument of a built-in (inherit) resolves to nothing',
    await goto(position('inherit)')), null);

  check('object pattern keyword (is-a) is built in, declared nowhere -> null',
    await goto(position('is-a Depot')), null);

  check('deftemplate named in an import item -> deftemplate',
    await goto(position('foo)\n  (import MAIN defclass')), 'foo');

  check('defclass named in an import item -> defclass',
    await goto(position('Store)\n  (export')), 'Store');

  check('deffunction named in an export item -> deffunction',
    await goto(position('helper))')), 'helper');

  // Ordered facts: only asserts whose literal fields could equal the pattern's.
  /** Start lines of the locations, comma-separated. */
  const lines = (locations) => (locations ?? []).map((l) => l.range.start.line).join(',');
  /** The line of `needle` in the fixture, as a string. */
  const onLine = (needle) => String(position(needle).line);
  {
    const got = await goto(position('stage start)\n  =>'));
    const pass = lines(got) === onLine('stage start))\n\n(defrule stage-advance');
    console.log(`${pass ? 'PASS' : 'FAIL'}  ordered fact pattern (stage start) -> only the deffacts creating it  ->  ${lines(got)}`);
    if (!pass) failures++;
  }
  {
    const got = await goto(position('stage next)\n  (pair'));
    const pass = lines(got) === onLine('stage next)))');
    console.log(`${pass ? 'PASS' : 'FAIL'}  ordered fact pattern (stage next) -> not the asserts of (stage start)/(stage done)  ->  ${lines(got)}`);
    if (!pass) failures++;
  }
  {
    const got = await goto(position('pair $? 7'));
    const pass = lines(got) === onLine('pair 1 7))');
    console.log(`${pass ? 'PASS' : 'FAIL'}  ordered fact with a multifield wildcard (pair $? 7) matches (pair 1 7), not (pair 1 8)  ->  ${lines(got)}`);
    if (!pass) failures++;
  }
  check('an assert site of an ordered fact with no other matching assert -> null',
    await goto(position('stage done)')), null);

  check('instance name -> its definstances entry (written without brackets)',
    await goto(position('lamp-1] print')), 'lamp-1');
  check('instance name -> its definstances entry (written with brackets)',
    await goto(position('lamp-2] print')), '[lamp-2]');
  check('instance name -> the make-instance creating it',
    await goto(position('lamp-3] to')), '[lamp-3]');
  check('instance name -> the new name of a duplicate-instance',
    await goto(position('lamp-4] print')), '[lamp-4]');
  check('instance name created nowhere -> null',
    await goto(position('ghost')), null);

  check('module in (import MAIN ?ALL) -> defmodule',
    await goto(position('MAIN ?ALL')), 'MAIN');

  check('class after of without an instance name ((of Depot)) -> defclass',
    await goto(position('Depot))\n\n(defmessage-handler')), 'Depot');

  check('send message -> handler of a subclass the receiver may be',
    await goto(position('tally))')), 'tally');

  check('class in an instance query ((?st Store)) -> defclass',
    await goto(position('Store)) TRUE')), 'Store');

  check('system message handler (print) is predefined -> null',
    await goto(position('print)))')), null);

  check('built-in class (USER) is predefined -> null',
    await goto(position('USER)\n  (slot stock-flag)')), null);

  check('special form keyword (do-for-all-facts) has no user-defined location -> null',
    await goto(position('do-for-all-facts')), null);

  await connection.sendRequest('shutdown');
  connection.sendNotification('exit');

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall definition checks passed');
  }
} catch (err) {
  console.error('definition test failed:', err);
  process.exitCode = 1;
} finally {
  connection.dispose();
  child.kill();
}
