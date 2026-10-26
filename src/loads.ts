/**
 * @file Load graph: which .clp files form one program, from load, load*,
 * batch and batch* calls. Cross-file checks use it to tell "defined in the
 * workspace" from "available to this program".
 *
 * CLIPS resolves load paths against its working directory, which we can't
 * know. We try the loading file's directory first, then each workspace folder.
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { SyntaxNode, Tree } from 'tree-sitter';
import { pathKey, uriKey, uriToPath } from './uri.js';

/** Functions whose first argument names a file to load. */
const LOAD_COMMANDS = new Set(['load', 'load*', 'batch', 'batch*']);

/** Where a load call's argument points. */
export type LoadTarget =
  /** An indexed file. */
  | { kind: 'indexed'; key: string }
  /** Exists on disk but isn't indexed (outside the workspace, or e.g. a .bat file). */
  | { kind: 'unindexed' }
  /** No file at any candidate path. */
  | { kind: 'missing'; path: string }
  /** Not a literal path, e.g. a variable or `(str-cat ...)`. */
  | { kind: 'dynamic' };

/** A load or batch call. */
export interface LoadCall {
  /** `load`, `load*`, `batch` or `batch*`. */
  command: string;
  /** The path argument, where diagnostics are reported. */
  argument: SyntaxNode;
  /** Where the argument points. */
  target: LoadTarget;
}

/** Load relations between the indexed files, by file key. */
export interface LoadGraph {
  /** Each file's load calls. */
  calls: Map<string, LoadCall[]>;
  /** Files each file loads. */
  loads: Map<string, Set<string>>;
  /** Files that load each file. */
  loadedBy: Map<string, Set<string>>;
  /** Files with a load we can't follow (dynamic or unindexed target). */
  incomplete: Set<string>;
}

/**
 * Builds the load graph over all indexed documents.
 *
 * @param documents - The indexed documents.
 * @param folderKeys - Workspace folder roots, tried for relative paths.
 * @returns The graph.
 */
export function buildLoadGraph(
  documents: Iterable<{ uri: string; tree: Tree }>,
  folderKeys: string[]
): LoadGraph {
  const docs = [...documents];
  const indexed = new Set(docs.map((d) => uriKey(d.uri)));
  const graph: LoadGraph = { calls: new Map(), loads: new Map(), loadedBy: new Map(), incomplete: new Set() };

  for (const doc of docs) {
    const key = uriKey(doc.uri);
    const fromPath = uriToPath(doc.uri);
    const calls: LoadCall[] = [];
    const targets = new Set<string>();

    for (const call of doc.tree.rootNode.descendantsOfType('function_call')) {
      if (call.hasError) continue;
      const command = call.namedChildren[0];
      if (command?.type !== 'function_name' || !LOAD_COMMANDS.has(command.text)) continue;
      const argument = call.namedChildren[1];
      if (!argument) continue;

      const literal = literalPath(argument);
      const target: LoadTarget =
        literal === null ? { kind: 'dynamic' } : resolveTarget(literal, fromPath, folderKeys, indexed);
      calls.push({ command: command.text, argument, target });

      if (target.kind === 'indexed') targets.add(target.key);
      else if (target.kind === 'dynamic' || target.kind === 'unindexed') graph.incomplete.add(key);
    }

    graph.calls.set(key, calls);
    graph.loads.set(key, targets);
    for (const target of targets) {
      if (!graph.loadedBy.has(target)) graph.loadedBy.set(target, new Set());
      graph.loadedBy.get(target)!.add(key);
    }
  }

  return graph;
}

/**
 * The files of the program(s) a file belongs to: everything loaded from the
 * entry points (files nothing loads) above it. Several entry points are
 * merged.
 *
 * `complete` is false if some file in the program has a load we can't
 * follow. That is enough for duplicate checks, but not for "not loaded"
 * checks, since the missing definition may be in the unseen file.
 *
 * @param graph - The load graph.
 * @param uri - The file.
 * @returns The program's file keys, or `null` if no load calls lead into or out of the file.
 */
export function programFiles(graph: LoadGraph, uri: string): { files: Set<string>; complete: boolean } | null {
  const key = uriKey(uri);
  const loads = graph.loads.get(key);
  const loadedBy = graph.loadedBy.get(key);
  const hasCalls = (graph.calls.get(key)?.length ?? 0) > 0;
  if (!hasCalls && (!loadedBy || loadedBy.size === 0)) return null;

  const ancestors = closure(key, graph.loadedBy);
  let entryPoints = [...ancestors].filter((k) => (graph.loadedBy.get(k)?.size ?? 0) === 0);
  if (entryPoints.length === 0) entryPoints = [...ancestors]; // load cycle without an entry point

  const files = new Set<string>();
  for (const entry of entryPoints) {
    for (const k of closure(entry, graph.loads)) files.add(k);
  }
  if (loads && loads.size === 0 && files.size === 1 && !graph.incomplete.has(key)) {
    return null; // only loads of missing files
  }

  const complete = ![...files].some((k) => graph.incomplete.has(k));
  return { files, complete };
}

/**
 * All keys reachable from `start`, including `start`.
 *
 * @param start - The first key.
 * @param edges - Outgoing edges by key.
 * @returns The reachable keys.
 */
function closure(start: string, edges: Map<string, Set<string>>): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of edges.get(queue.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * A literal load path: a string or a bare symbol (CLIPS accepts both).
 *
 * @param argument - The call's first argument.
 * @returns The path, or `null` if it is computed.
 */
function literalPath(argument: SyntaxNode): string | null {
  const inner = argument.type === 'constant' ? argument.firstChild : null;
  if (inner?.type === 'string') return inner.text.slice(1, -1).replace(/\\(.)/g, '$1');
  if (inner?.type === 'symbol') return inner.text;
  return null;
}

/**
 * Resolves a literal path against the loading file's directory, then the
 * workspace folders.
 *
 * @param path - The path from the call.
 * @param fromPath - The loading file's path; `null` for an untitled document.
 * @param folderKeys - Workspace folder roots.
 * @param indexed - Keys of all indexed files.
 * @returns Where the path points.
 */
function resolveTarget(
  path: string,
  fromPath: string | null,
  folderKeys: string[],
  indexed: Set<string>
): LoadTarget {
  const candidates = isAbsolute(path)
    ? [resolve(path)]
    : [...(fromPath ? [resolve(dirname(fromPath), path)] : []), ...folderKeys.map((f) => resolve(f, path))];

  // Nothing to resolve against (untitled document, no folder): don't report it missing.
  if (candidates.length === 0) return { kind: 'unindexed' };
  for (const candidate of candidates) {
    const key = pathKey(candidate);
    if (indexed.has(key)) return { kind: 'indexed', key };
  }
  if (candidates.some((c) => existsSync(c))) return { kind: 'unindexed' };
  return { kind: 'missing', path };
}
