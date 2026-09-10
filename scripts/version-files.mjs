/**
 * Reading the app's version out of the four files that carry it.
 *
 * CONTRIBUTING.md tells contributors not to bump the version in a pull
 * request, because the maintainer moves all four together at release time.
 * `check-version-bump.mjs` uses this module to enforce that.
 *
 * The point of reading a resolved value rather than grepping a diff is
 * `Cargo.lock`: it carries a `version` line for every dependency, so a pull
 * request that legitimately bumps one would trip any naive line match. Only
 * the entry for this crate counts.
 */

/** The Cargo package name, which is also the built binary's name. */
const CRATE_NAME = 'better-ip-tv';

/** Every file that carries the app version, in the order CONTRIBUTING.md lists them. */
export const APP_VERSION_FILES = [
  'package.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
];

function fromJson(path, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${path} is not valid JSON: ${cause.message}`);
  }
  if (typeof parsed.version !== 'string') {
    throw new Error(`${path} has no top-level "version" string`);
  }
  return parsed.version;
}

function fromCargoToml(path, text) {
  // Only the [package] section. [dependencies] entries carry versions too.
  const section = text.split(/^\[/m).find((part) => part.startsWith('package]'));
  const version = section && /^version\s*=\s*"([^"]+)"/m.exec(section);
  if (!version) {
    throw new Error(`${path} has no version in its [package] section`);
  }
  return version[1];
}

function fromCargoLock(path, text) {
  // Each [[package]] block is one crate. Match the name line whole, so a crate
  // whose name merely starts with ours cannot be picked up instead.
  const nameLine = new RegExp(`^name = "${CRATE_NAME}"$`, 'm');
  const block = text.split('[[package]]').find((part) => nameLine.test(part));
  const version = block && /^version\s*=\s*"([^"]+)"/m.exec(block);
  if (!version) {
    throw new Error(`${path} has no [[package]] entry for "${CRATE_NAME}" with a version`);
  }
  return version[1];
}

const READERS = {
  'package.json': fromJson,
  'src-tauri/tauri.conf.json': fromJson,
  'src-tauri/Cargo.toml': fromCargoToml,
  'src-tauri/Cargo.lock': fromCargoLock,
};

/**
 * The app version declared by one of the four files.
 *
 * @param {string} path repo-relative path, one of `APP_VERSION_FILES`
 * @param {string} text the file's contents
 * @returns {string} the version string
 * @throws if the path is not one of the four, or the file carries no version
 */
export function readAppVersion(path, text) {
  const reader = READERS[path];
  if (!reader) {
    throw new Error(`${path} is not one of the files that carry the app version`);
  }
  return reader(path, text);
}

/**
 * The files whose app version differs between two commits.
 *
 * @param {Record<string, string>} base version per file at the base commit
 * @param {Record<string, string>} head version per file at the pull request's head
 * @returns {{path: string, base: string, head: string}[]} one entry per file that moved
 */
export function findVersionChanges(base, head) {
  return Object.keys(head)
    .filter((path) => base[path] !== head[path])
    .map((path) => ({ path, base: base[path], head: head[path] }));
}

/**
 * The 1-based line where a file declares the app version, for a GitHub
 * annotation that lands on the exact line in the pull request's diff.
 *
 * @param {string} path repo-relative path, one of `APP_VERSION_FILES`
 * @param {string} text the file's contents
 * @returns {number|null} the line, or null when it cannot be located
 */
export function findVersionLine(path, text) {
  const lines = text.split('\n');

  if (path.endsWith('.json')) {
    const i = lines.findIndex((line) => /^\s*"version"\s*:/.test(line));
    return i === -1 ? null : i + 1;
  }

  // Cargo.toml: the version under [package]. Cargo.lock: the version under the
  // [[package]] entry for this crate. Both are "the first version line after
  // the header that matters", so one scan covers them.
  const header =
    path.endsWith('Cargo.lock') ? new RegExp(`^name = "${CRATE_NAME}"$`) : /^\[package\]/;

  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) {
    return null;
  }
  const offset = lines.slice(start).findIndex((line) => /^version\s*=\s*"/.test(line));
  return offset === -1 ? null : start + offset + 1;
}

/**
 * A GitHub error annotation for one file whose version moved.
 *
 * Annotations must be a single line; a newline ends them early and the rest is
 * printed as ordinary log output.
 *
 * @param {{path: string, base: string, head: string, line: number|null}} change
 * @returns {string} the `::error` workflow command
 */
export function formatAnnotation({ path, base, head, line }) {
  const anchor = line === null ? `file=${path}` : `file=${path},line=${line}`;
  return (
    `::error ${anchor}::This sets the app version to ${head}; \`main\` has ${base}. ` +
    'The maintainer moves all four version files together when a release is cut, ' +
    'so please revert this line and leave the rest of your changes as they are. ' +
    'See the Versioning section of CONTRIBUTING.md.'
  );
}
