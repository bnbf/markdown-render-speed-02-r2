// main.ts — driver for the markdown-render-speed-02 entry.
// Reads every case from /input/cases.json, renders each one with parse(),
// and writes the HTML strings, in case order, to /output/html.json.
// The local harness may point elsewhere with MAKEFUN_INPUT_DIR /
// MAKEFUN_OUTPUT_DIR; the server mounts the real /input and /output.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));

const html = [];
for (const c of cases) html.push(parse(c.markdown));

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
