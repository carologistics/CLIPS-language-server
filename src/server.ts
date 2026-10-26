#!/usr/bin/env node
/**
 * @file Server entry point: LSP connection, capabilities and handlers.
 * A change in one file can affect diagnostics in another, so any index
 * change re-validates all documents in scope.
 */

import {
  CodeActionKind,
  createConnection,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CodeAction,
  type CodeActionParams,
  type CompletionItem,
  type CompletionParams,
  type DefinitionParams,
  type Diagnostic,
  type DidChangeWatchedFilesParams,
  type DocumentSymbol,
  type DocumentSymbolParams,
  type Hover,
  type HoverParams,
  type InitializeParams,
  type InitializeResult,
  type Location,
  type SymbolInformation,
  type WorkspaceSymbolParams
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { provideCodeActions } from './codeActions.js';
import { provideCompletion, resolveCompletionItem, type CompletionData } from './completion.js';
import { collectDeclarationDiagnostics } from './declarationDiagnostics.js';
import { declarationApplies, isDeclarationFile } from './declarations.js';
import { provideDefinition } from './definitions.js';
import { collectSemanticDiagnostics, type ProgramContext } from './diagnostics.js';
import { provideHover } from './hover.js';
import { buildLoadGraph, programFiles, type LoadGraph } from './loads.js';
import {
  collectSyntaxDiagnostics,
  getAllDocuments,
  getCompletionScope,
  getDeclarationFiles,
  getDeclarationTables,
  getGeneration,
  getScope,
  getSymbolTable,
  getText,
  getTree,
  parseDocument
} from './parsing.js';
import { searchWorkspaceSymbols, toDocumentSymbols } from './symbolQueries.js';
import { mergeSymbolTables, type SymbolTable } from './symbolTable.js';
import { uriKey } from './uri.js';
import {
  addWorkspaceFolders,
  isIndexedFile,
  isOpen,
  markClosed,
  markOpen,
  removeWorkspaceFolders,
  syncFromDisk,
  workspaceFolderKeys
} from './workspace.js';

/** The LSP connection; the transport comes from the command line (`--stdio`, `--node-ipc`, ...). */
const connection = createConnection(ProposedFeatures.all);
/** The open documents. */
const documents = new TextDocuments(TextDocument);

/** Workspace folders from `initialize`, indexed after `initialized`. */
let initialFolders: string[] = [];
/** Client sends `workspace/didChangeWorkspaceFolders`. */
let supportsFolderChanges = false;
/** Client answers `workspace/configuration`. */
let supportsConfiguration = false;
/** Client allows registering for configuration changes. */
let supportsConfigurationRegistration = false;
/** Client allows registering file watchers. */
let supportsWatcherRegistration = false;
/** Client renders Markdown in completion documentation. */
let completionMarkdown = false;
/** Client supports snippets. */
let completionSnippetSupport = false;
/** Client can create files in a workspace edit (for `externals.clpd`). */
let canCreateFiles = false;
/** `clips.completion.snippets`. */
let snippetsEnabled = true;
/** `clips.completion.unlinkedFiles`: other files' constructs for documents no load links to. */
let unlinkedFiles: 'include' | 'exclude' = 'include';

/** `clips.diagnostics.scope`: diagnostics for open files only, or for all indexed files. */
type DiagnosticsScope = 'openFiles' | 'workspace';
/** Current value of `clips.diagnostics.scope`. */
let diagnosticsScope: DiagnosticsScope = 'openFiles';

/**
 * The scope from a `clips` settings object.
 *
 * @param settings - The settings object, possibly malformed.
 * @returns The scope; `openFiles` for unknown values.
 */
function scopeFromSettings(settings: unknown): DiagnosticsScope {
  const value = (settings as { diagnostics?: { scope?: unknown } } | null | undefined)?.diagnostics?.scope;
  return value === 'workspace' ? 'workspace' : 'openFiles';
}

/**
 * Applies a `clips` settings object.
 *
 * @param settings - The settings object, possibly malformed.
 */
function applySettings(settings: unknown): void {
  diagnosticsScope = scopeFromSettings(settings);
  const completion = (settings as { completion?: { snippets?: unknown; unlinkedFiles?: unknown } } | null | undefined)?.completion;
  snippetsEnabled = completion?.snippets !== false;
  unlinkedFiles = completion?.unlinkedFiles === 'exclude' ? 'exclude' : 'include';
}

/**
 * Records the workspace folders and client capabilities.
 *
 * @param params - The initialize params; `workspaceFolders` or `rootUri` name the folders.
 * @returns The server's capabilities.
 */
connection.onInitialize((params: InitializeParams): InitializeResult => {
  if (params.workspaceFolders) {
    initialFolders = params.workspaceFolders.map((f) => f.uri);
  } else if (params.rootUri) {
    initialFolders = [params.rootUri];
  }
  supportsFolderChanges = !!params.capabilities.workspace?.workspaceFolders;
  supportsConfiguration = !!params.capabilities.workspace?.configuration;
  supportsConfigurationRegistration =
    !!params.capabilities.workspace?.didChangeConfiguration?.dynamicRegistration;
  supportsWatcherRegistration = !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;
  completionMarkdown =
    params.capabilities.textDocument?.completion?.completionItem?.documentationFormat?.includes('markdown') ?? false;
  completionSnippetSupport = !!params.capabilities.textDocument?.completion?.completionItem?.snippetSupport;
  const workspaceEdit = params.capabilities.workspace?.workspaceEdit;
  canCreateFiles = !!workspaceEdit?.documentChanges && !!workspaceEdit.resourceOperations?.includes('create');

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      hoverProvider: true,
      completionProvider: { triggerCharacters: ['(', '?', '['], resolveProvider: true },
      documentSymbolProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      workspaceSymbolProvider: true,
      workspace: {
        workspaceFolders: { supported: true, changeNotifications: true }
      }
    }
  };
});

/**
 * Registers for changes, then indexes the workspace in the background and
 * re-checks documents opened in the meantime.
 */
connection.onInitialized(async () => {
  connection.console.log('CLIPS language server started');

  if (supportsConfigurationRegistration) {
    await connection.client.register(DidChangeConfigurationNotification.type, undefined).catch(() => undefined);
  }
  if (supportsWatcherRegistration) {
    // Many clients only report file changes for watchers the server registers.
    await connection.client
      .register(DidChangeWatchedFilesNotification.type, { watchers: [{ globPattern: '**/*.{clp,CLP,clpd}' }] })
      .catch(() => undefined);
  }
  await loadConfiguration();

  if (supportsFolderChanges) {
    connection.workspace.onDidChangeWorkspaceFolders(async (event) => {
      removeWorkspaceFolders(event.removed.map((f) => f.uri));
      const count = await addWorkspaceFolders(event.added.map((f) => f.uri));
      connection.console.log(`Indexed ${count} .clp file(s) from added workspace folder(s)`);
      scheduleRevalidation();
    });
  }

  // Documents opened before indexing finishes are re-checked afterwards.
  void addWorkspaceFolders(initialFolders).then((count) => {
    connection.console.log(`Indexed ${count} .clp file(s) in the workspace`);
    scheduleRevalidation();
  });
});

/**
 * Go to definition, across files.
 *
 * @param params - Document and position.
 * @returns The locations, or `null`.
 */
connection.onDefinition((params: DefinitionParams): Location[] | null => {
  const uri = params.textDocument.uri;
  const tree = getTree(uri);
  const scope = getScope(uri);
  if (!tree || !scope) return null;
  return provideDefinition(tree, scope, uri, params.position, getAllDocuments());
});

/**
 * Hover, with usage counts over all indexed documents.
 *
 * @param params - Document and position.
 * @returns The hover, or `null`.
 */
connection.onHover((params: HoverParams): Hover | null => {
  const uri = params.textDocument.uri;
  const tree = getTree(uri);
  const scope = getScope(uri);
  if (!tree || !scope) return null;
  const documents = [...getAllDocuments()];
  const roots = documents.map((d) => d.tree.rootNode);
  const program = programFiles(currentLoadGraph().graph, uri);
  return provideHover(tree, scope, params.position, { uri, roots, documents, program });
});

/**
 * Completion, for open documents only.
 *
 * @param params - Document and position.
 * @returns The items.
 */
connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  // In a program whose load graph is complete, offer only its files. With no
  // load links at all, follow clips.completion.unlinkedFiles. A program with a
  // computed load path may contain files we can't see, so filter nothing.
  const program = programFiles(currentLoadGraph().graph, params.textDocument.uri);
  const admit = program?.complete
    ? (other: string) => program.files.has(uriKey(other))
    : !program && unlinkedFiles === 'exclude'
      ? () => false
      : () => true;
  const scope = getCompletionScope(params.textDocument.uri, admit);
  if (!document || !scope) return [];
  return provideCompletion(document.getText(), document.offsetAt(params.position), params.position, scope, document.uri, {
    snippets: completionSnippetSupport && snippetsEnabled,
    unlinked: !program
  });
});

/**
 * Adds the hover card as the item's documentation.
 *
 * @param item - A completion item from this server.
 * @returns The item.
 */
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  const data = item.data as CompletionData | undefined;
  if (!data) return item;
  const scope = getCompletionScope(data.uri);
  const roots = [...getAllDocuments()].map((d) => d.tree.rootNode);
  return resolveCompletionItem(item, scope, { uri: data.uri, roots }, completionMarkdown);
});

/**
 * Quick fixes (see `codeActions.ts`).
 *
 * @param params - Document, range and diagnostics.
 * @returns The quick fixes.
 */
connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const uri = params.textDocument.uri;
  const tree = getTree(uri);
  const scope = getScope(uri);
  if (!tree || !scope) return [];
  // The fixes need each diagnostic's `data`. Some clients drop it, so fall
  // back to what we last published, matched by code and range.
  const known = lastDiagnostics.get(uriKey(uri)) ?? [];
  /** Same code and range. */
  const sameRange = (a: Diagnostic, b: Diagnostic) =>
    a.code === b.code && a.range.start.line === b.range.start.line && a.range.start.character === b.range.start.character &&
    a.range.end.line === b.range.end.line && a.range.end.character === b.range.end.character;
  const diagnostics = params.context.diagnostics.map((d) => (d.data !== undefined ? d : (known.find((k) => sameRange(k, d)) ?? d)));
  const documents = [...getAllDocuments()].map((d) => ({ uri: d.uri, tree: d.tree, text: getText(d.uri) ?? '' }));
  return provideCodeActions(diagnostics, {
    uri,
    tree,
    scope,
    documents,
    declarationFiles: getDeclarationFiles(uri),
    allDiagnostics: known,
    canCreateFiles
  });
});

/**
 * The document outline.
 *
 * @param params - The document.
 * @returns The outline.
 */
connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
  const table = getSymbolTable(params.textDocument.uri);
  return table ? toDocumentSymbols(table) : [];
});

/**
 * Symbol search over all indexed documents.
 *
 * @param params - The query.
 * @returns The matching symbols.
 */
connection.onWorkspaceSymbol((params: WorkspaceSymbolParams): SymbolInformation[] => {
  return searchWorkspaceSymbols(
    [...getAllDocuments()].map((d) => d.table),
    params.query
  );
});

/**
 * A .clp or .clpd file changed on disk. Closed files are re-read; open
 * files keep the editor's text.
 *
 * @param params - The file events.
 */
connection.onDidChangeWatchedFiles(async (params: DidChangeWatchedFilesParams) => {
  let changed = false;
  for (const event of params.changes) {
    if (!isIndexedFile(event.uri)) continue;
    // Created, changed and deleted are all handled by re-reading; a deleted file is dropped.
    if (await syncFromDisk(event.uri)) changed = true;
  }
  if (changed) scheduleRevalidation();
});

/**
 * Parses an open document and publishes its diagnostics.
 *
 * @param document - The document.
 */
function validate(document: TextDocument): void {
  parseDocument(document.uri, document.getText());
  publish(document.uri, computeDiagnostics(document.uri));
}

/**
 * Syntax and semantic diagnostics of a cached document.
 *
 * @param uri - The document's URI.
 * @returns The diagnostics.
 */
function computeDiagnostics(uri: string): Diagnostic[] {
  const tree = getTree(uri);
  if (!tree) return [];
  const diagnostics = collectSyntaxDiagnostics(tree);
  const table = getSymbolTable(uri);
  if (table && isDeclarationFile(uri)) {
    // A .clpd file only gets its own checks, none of the program checks.
    const described = [...getAllDocuments()].filter((d) => !isDeclarationFile(d.uri) && declarationApplies(uri, d.uri));
    const dumps = getDeclarationFiles(uri)
      .filter((f) => f.generated !== null)
      .flatMap((f) => {
        const dumpTable = getSymbolTable(f.uri);
        return dumpTable ? [{ uri: f.uri, table: dumpTable }] : [];
      });
    diagnostics.push(...collectDeclarationDiagnostics(tree, table, described, dumps));
    return diagnostics;
  }
  const scope = getScope(uri);
  if (table && scope) {
    diagnostics.push(...collectSemanticDiagnostics(tree, table, uri, scope, programContext(uri, table)));
  }
  return diagnostics;
}

/** The load graph and tables by key, cached until a document changes. */
let loadGraphCache:
  | { generation: number; folders: string; graph: LoadGraph; tables: Map<string, SymbolTable> }
  | undefined;

/**
 * The load graph, rebuilt only when a document or the folders changed.
 *
 * @returns The graph and the symbol tables of the `.clp` files by key.
 */
function currentLoadGraph(): { graph: LoadGraph; tables: Map<string, SymbolTable> } {
  const folderKeys = workspaceFolderKeys();
  const folders = folderKeys.join('\n');
  const generation = getGeneration();
  if (loadGraphCache?.generation !== generation || loadGraphCache.folders !== folders) {
    const docs = [...getAllDocuments()].filter((d) => !isDeclarationFile(d.uri));
    loadGraphCache = {
      generation,
      folders,
      graph: buildLoadGraph(docs, folderKeys),
      tables: new Map(docs.map((d) => [uriKey(d.uri), d.table]))
    };
  }
  return loadGraphCache;
}

/**
 * A document's load calls and, if known, the other files of its program.
 *
 * @param uri - The document's URI.
 * @param table - Its own symbol table.
 * @returns The context for the program checks.
 */
function programContext(uri: string, table: SymbolTable): ProgramContext {
  const { graph, tables } = currentLoadGraph();
  const key = uriKey(uri);
  const loadCalls = graph.calls.get(key) ?? [];
  const declarations = getDeclarationFiles(uri);
  const program = programFiles(graph, uri);
  if (!program) return { loadCalls, declarations, program: null };

  const otherTables: SymbolTable[] = [];
  for (const file of program.files) {
    const other = file === key ? undefined : tables.get(file);
    if (other) otherTables.push(other);
  }
  // Host declarations apply to every program in their folder, so they are
  // never "not loaded".
  const scope = program.complete ? mergeSymbolTables(table, otherTables, getDeclarationTables(uri)) : null;
  return { loadCalls, declarations, program: { otherTables, scope } };
}

/**
 * Documents with diagnostics on display (key to published URI). The client
 * keeps them until it gets an empty list, so we track what to clear.
 */
const published = new Map<string, string>();
/** Last published diagnostics per document, used by the quick fixes. */
const lastDiagnostics = new Map<string, Diagnostic[]>();

/**
 * Publishes a document's diagnostics.
 *
 * @param uri - The document's URI.
 * @param diagnostics - The diagnostics.
 */
function publish(uri: string, diagnostics: Diagnostic[]): void {
  published.set(uriKey(uri), uri);
  lastDiagnostics.set(uriKey(uri), diagnostics);
  connection.sendDiagnostics({ uri, diagnostics });
}

/**
 * Clears a document's diagnostics, if any are shown.
 *
 * @param uri - The document's URI.
 */
function clearPublished(uri: string): void {
  const key = uriKey(uri);
  const publishedUri = published.get(key);
  if (publishedUri === undefined) return;
  published.delete(key);
  lastDiagnostics.delete(key);
  connection.sendDiagnostics({ uri: publishedUri, diagnostics: [] });
}

/** Re-validates everything in the diagnostics scope and clears the rest. */
function revalidateAll(): void {
  const inScope = new Set<string>();

  for (const document of documents.all()) {
    inScope.add(uriKey(document.uri));
    validate(document);
  }

  if (diagnosticsScope === 'workspace') {
    for (const { uri } of [...getAllDocuments()]) {
      if (isOpen(uri)) continue;
      const key = uriKey(uri);
      inScope.add(key);
      const diagnostics = computeDiagnostics(uri);
      if (diagnostics.length > 0 || published.has(key)) publish(uri, diagnostics);
    }
  }

  for (const [key, uri] of [...published]) {
    if (!inScope.has(key)) clearPublished(uri);
  }
}

/** Delay before re-validating after the last index change. */
const REVALIDATION_DELAY_MS = 250;
/** Pending {@link revalidateAll} call. */
let revalidationTimer: NodeJS.Timeout | undefined;

/** Runs {@link revalidateAll} once the index stops changing. */
function scheduleRevalidation(): void {
  if (revalidationTimer) clearTimeout(revalidationTimer);
  revalidationTimer = setTimeout(() => {
    revalidationTimer = undefined;
    revalidateAll();
  }, REVALIDATION_DELAY_MS);
}

/** Fetches the `clips` settings, if the client supports `workspace/configuration`. */
async function loadConfiguration(): Promise<void> {
  if (!supportsConfiguration) return;
  try {
    applySettings(await connection.workspace.getConfiguration('clips'));
  } catch {
    // Keep the current settings.
  }
}

/** Re-reads the settings; re-validates if the diagnostics scope changed. */
connection.onDidChangeConfiguration(async (change) => {
  const before = diagnosticsScope;
  if (supportsConfiguration) await loadConfiguration();
  else applySettings((change.settings as { clips?: unknown } | null)?.clips);
  if (diagnosticsScope !== before) scheduleRevalidation();
});

/** Marks a document as open; `onDidChangeContent` follows and parses it. */
documents.onDidOpen((event) => {
  markOpen(event.document.uri);
});

/** Re-validates a document on every change, then the others. */
documents.onDidChangeContent((event) => {
  validate(event.document);
  scheduleRevalidation();
});

/**
 * On close the file on disk is used again, or the document is dropped if
 * it isn't a workspace file.
 */
documents.onDidClose(async (event) => {
  const uri = event.document.uri;
  markClosed(uri);
  if (diagnosticsScope === 'openFiles') clearPublished(uri);
  if (await syncFromDisk(uri)) scheduleRevalidation();
});

documents.listen(connection);
connection.listen();
