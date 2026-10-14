// Regenerates viewer/assets/css/foundation.css from docs/design/ui-redesign-foundation.css.
//   node tests/viewer/gen-foundation.mjs
// static.test.mjs imports build() and fails when the committed file differs from its output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DESIGN = path.join(ROOT, 'docs', 'design', 'ui-redesign-foundation.css');
export const OUT = path.join(ROOT, 'viewer', 'assets', 'css', 'foundation.css');
export const REGEN_CMD = 'node tests/viewer/gen-foundation.mjs';

const HEADER = `/* GENERATED from docs/design/ui-redesign-foundation.css (v1.2): do not edit here. Change the design
   file (re-measure contrast), then regenerate this file with: ${REGEN_CMD} */
@layer foundation, legacy, app;
@layer foundation {
`;

export function build() {
  return HEADER + fs.readFileSync(DESIGN, 'utf8') + '}\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(OUT, build());
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
}
