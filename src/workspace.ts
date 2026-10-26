/**
 * @file Indexes every .clp and .clpd file in the workspace folders. An open
 * file uses the editor's text and ignores disk changes; a closed one uses
 * the file on disk.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeclarationFile } from './declarations.js';
import { getAllDocuments, parseDocument, removeDocument } from './parsing.js';
import { uriKey, uriToPath } from './uri.js';

/** Directories not scanned. Hidden directories are skipped as well. */
const SKIPPED_DIRECTORIES = new Set(['node_modules']);
/** Most files indexed; limits very large workspaces such as a home directory. */
const MAX_INDEXED_FILES = 5000;
/** Larger files are not indexed. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Parsing is synchronous; yield after this many files so requests aren't blocked. */
const FILES_PER_SLICE = 25;

/** Workspace folder roots, as {@link uriKey} keys. */
const folderKeys = new Set<string>();
/** Keys of the documents open in the client. */
const openKeys = new Set<string>();

/**
 * True for `.clp` files (any case).
 *
 * @param name - A file name, path or URI.
 */
export function isClipsFile(name: string): boolean {
  return name.toLowerCase().endsWith('.clp');
}

/**
 * True for every file the server indexes: `.clp` and `.clpd`.
 *
 * @param name - A file name, path or URI.
 */
export function isIndexedFile(name: string): boolean {
  return isClipsFile(name) || isDeclarationFile(name);
}

/**
 * Marks a document as open, so disk changes no longer replace its text.
 *
 * @param uri - The document's URI.
 */
export function markOpen(uri: string): void {
  openKeys.add(uriKey(uri));
}

/**
 * Marks a document as closed; the file on disk is used again.
 *
 * @param uri - The document's URI.
 */
export function markClosed(uri: string): void {
  openKeys.delete(uriKey(uri));
}

/**
 * Whether the client has the document open.
 *
 * @param uri - The document's URI.
 */
export function isOpen(uri: string): boolean {
  return openKeys.has(uriKey(uri));
}

/**
 * The workspace folder roots as path keys; base directories for `(load ...)` paths.
 *
 * @returns The keys.
 */
export function workspaceFolderKeys(): string[] {
  return [...folderKeys];
}

/**
 * Whether a file is inside one of the workspace folders.
 *
 * @param uri - Any document URI.
 * @returns `true` for a `file:` URI under a workspace folder.
 */
export function isInWorkspace(uri: string): boolean {
  const key = uriKey(uri);
  for (const folder of folderKeys) {
    if (key === folder || key.startsWith(folder.endsWith(sep) ? folder : folder + sep)) return true;
  }
  return false;
}

/**
 * Adds workspace folders and indexes their files.
 *
 * @param folderUris - `file:` URIs of the folders.
 * @returns The number of files indexed.
 */
export async function addWorkspaceFolders(folderUris: string[]): Promise<number> {
  const roots: string[] = [];
  for (const folderUri of folderUris) {
    const path = uriToPath(folderUri);
    if (path === null) continue;
    folderKeys.add(uriKey(folderUri));
    roots.push(path);
  }

  const files: string[] = [];
  for (const root of roots) await collectClipsFiles(root, files);

  let indexed = 0;
  for (let i = 0; i < files.length; i++) {
    if (await indexFile(pathToFileURL(files[i]).href)) indexed++;
    if ((i + 1) % FILES_PER_SLICE === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return indexed;
}

/**
 * Removes workspace folders and their closed documents. Open documents stay
 * until they are closed.
 *
 * @param folderUris - `file:` URIs of the removed folders.
 */
export function removeWorkspaceFolders(folderUris: string[]): void {
  for (const folderUri of folderUris) folderKeys.delete(uriKey(folderUri));
  for (const { uri } of [...getAllDocuments()]) {
    if (!isOpen(uri) && !isInWorkspace(uri)) removeDocument(uri);
  }
}

/**
 * Re-reads a closed file from disk. A file that is gone or outside the
 * workspace is removed from the index.
 *
 * @param uri - The file's URI.
 * @returns `true` if the index changed.
 */
export async function syncFromDisk(uri: string): Promise<boolean> {
  if (isOpen(uri)) return false;
  if (!isInWorkspace(uri)) {
    removeDocument(uri);
    return true;
  }
  if (await indexFile(uri)) return true;
  removeDocument(uri); // deleted, unreadable, or too large
  return true;
}

/**
 * Reads and parses one file.
 *
 * @param uri - The file's `file:` URI.
 * @returns `false` if the file is open, unreadable or too large.
 */
async function indexFile(uri: string): Promise<boolean> {
  const path = uriToPath(uri);
  if (path === null) return false;
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES) return false;
    const text = await readFile(path, 'utf8');
    // The file may have been opened while we were reading it.
    if (isOpen(uri)) return false;
    parseDocument(uri, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collects .clp and .clpd paths under a directory. Skips hidden and
 * symlinked directories (which could loop).
 *
 * @param dir - Directory to scan.
 * @param out - Collected paths; stops at {@link MAX_INDEXED_FILES}.
 */
async function collectClipsFiles(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_INDEXED_FILES) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_INDEXED_FILES) return;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await collectClipsFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && isIndexedFile(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}
