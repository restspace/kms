// Runs tests/verify-0015-org-contacts.sql against a migrated D1 and fails the
// process if any check reports FAIL (workplan-5 §2, "Post-migrate verification").
//
//   node scripts/verify-org-contacts.mjs            # --local (default)
//   node scripts/verify-org-contacts.mjs --remote
//
// Run it immediately after `wrangler d1 migrations apply`, against the database
// that was actually migrated. It reads the audit and snapshot tables 0015 leaves
// behind, so it only means anything while those still exist.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const remote = process.argv.includes('--remote');
const target = remote ? '--remote' : '--local';

// Resolve wrangler's entrypoint and run it on this node, rather than shelling
// out to the npx shim — spawning a .cmd is EINVAL on Windows.
// (wrangler's package "exports" hides ./bin, so resolve via its package.json.)
const require_ = createRequire(import.meta.url);
const wrangler = new URL('bin/wrangler.js', pathToFileURL(require_.resolve('wrangler/package.json')));

let raw;
try {
  raw = execFileSync(
    process.execPath,
    [fileURLToPath(wrangler), 'd1', 'execute', 'kms', target, '--json', '--file', 'tests/verify-0015-org-contacts.sql'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
} catch (err) {
  console.error(`wrangler failed: ${err.message}`);
  if (err.stdout) console.error(err.stdout.toString());
  if (err.stderr) console.error(err.stderr.toString());
  process.exit(1);
}

// wrangler prints a banner before the JSON; take from the first bracket on.
const start = raw.search(/[[{]/);
if (start < 0) {
  console.error('no JSON in wrangler output:\n' + raw);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(raw.slice(start));
} catch (err) {
  console.error(`could not parse wrangler JSON: ${err.message}\n${raw.slice(start, 2000)}`);
  process.exit(1);
}

// One element per statement in the .sql file, each with its own results array.
const rows = (Array.isArray(payload) ? payload : [payload]).flatMap((r) => r?.results ?? []);

if (rows.length === 0) {
  console.error('verification returned no rows — did 0015 run against this database?');
  process.exit(1);
}

// SKIP is not a failure: a check can be inapplicable, e.g. nothing to compare
// against on a database that held no contacts before 0015 ran. It is still
// printed — a silently skipped check is worse than a noisy one.
let failed = 0;
let skipped = 0;
for (const row of rows) {
  const status = row.status ?? '?';
  if (status === 'SKIP') skipped++;
  else if (status !== 'PASS') failed++;
  const mark = status === 'PASS' ? 'ok  ' : status === 'SKIP' ? 'skip' : 'FAIL';
  console.log(`${mark} ${String(row.check).padEnd(38)} ${row.detail ?? ''}`);
}

console.log(
  `\n${rows.length - failed - skipped}/${rows.length} checks passed` +
    (skipped ? `, ${skipped} skipped` : '') +
    (failed ? `, ${failed} FAILED` : ''),
);
process.exit(failed === 0 ? 0 : 1);
