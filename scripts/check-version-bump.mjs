#!/usr/bin/env node
/**
 * Fail when a pull request changes the app's version.
 *
 * Usage: node scripts/check-version-bump.mjs <base-ref> <head-ref>
 *
 * Reads the resolved version out of each of the four files at both commits and
 * compares the values, rather than looking at the diff. `Cargo.lock` carries a
 * `version` line for every dependency, so a diff-based check would fire on any
 * pull request that legitimately bumps a crate.
 *
 * On a mismatch it prints one GitHub error annotation per file, anchored to the
 * line that sets the version so the message lands on that line in the pull
 * request's Files changed tab, and exits 1.
 */

import { execFileSync } from 'node:child_process';
import {
  APP_VERSION_FILES,
  findVersionChanges,
  findVersionLine,
  formatAnnotation,
  readAppVersion,
} from './version-files.mjs';

function readAt(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf-8' });
  } catch {
    throw new Error(`cannot read ${path} at ${ref}; is that commit fetched?`);
  }
}

/** Every version file's contents at one commit, keyed by path. */
function filesAt(ref) {
  return Object.fromEntries(APP_VERSION_FILES.map((path) => [path, readAt(ref, path)]));
}

function versionsIn(files) {
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [path, readAppVersion(path, text)])
  );
}

const [baseRef, headRef] = process.argv.slice(2);
if (!baseRef || !headRef) {
  console.error('usage: check-version-bump.mjs <base-ref> <head-ref>');
  process.exit(2);
}

const headFiles = filesAt(headRef);
const changes = findVersionChanges(versionsIn(filesAt(baseRef)), versionsIn(headFiles));

if (changes.length === 0) {
  console.log('App version matches the base branch in all four files.');
} else {
  for (const change of changes) {
    console.log(formatAnnotation({ ...change, line: findVersionLine(change.path, headFiles[change.path]) }));
  }
  process.exitCode = 1;
}
