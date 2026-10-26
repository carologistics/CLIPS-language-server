/**
 * @file Document identity. A file can arrive as `file:///c%3A/x.clp` (from
 * the client) or `file:///C:/x.clp` (from the workspace scan), so documents
 * are keyed by {@link uriKey}, never by the raw URI.
 */

import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Whether file names are case-insensitive here (Windows, macOS). */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Cache key for a document URI: the absolute path for `file:` URIs
 * (lowercased on case-insensitive file systems), otherwise the URI itself.
 *
 * @param uri - Any document URI.
 * @returns The same key for every spelling of the same file.
 */
export function uriKey(uri: string): string {
  const path = uriToPath(uri);
  return path === null ? uri : pathKey(path);
}

/**
 * {@link uriKey} for a file-system path, e.g. one from a `(load ...)` call.
 *
 * @param path - Any path; made absolute first.
 * @returns The key a document at that path is cached under.
 */
export function pathKey(path: string): string {
  const absolute = resolve(path);
  return CASE_INSENSITIVE_FS ? absolute.toLowerCase() : absolute;
}

/**
 * Converts a `file:` URI to an absolute path.
 *
 * @param uri - Any document URI.
 * @returns The path, or `null` for other or malformed URIs.
 */
export function uriToPath(uri: string): string | null {
  if (!uri.startsWith('file:')) return null;
  try {
    return resolve(fileURLToPath(uri));
  } catch {
    return null;
  }
}

/**
 * The file name to show in hovers, e.g. `rules.clp`.
 *
 * @param uri - Any document URI.
 * @returns The last path segment, or the URI if it has none.
 */
export function displayName(uri: string): string {
  const path = uriToPath(uri);
  if (path !== null) return basename(path);
  return uri.slice(uri.lastIndexOf('/') + 1) || uri;
}
