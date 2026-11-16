import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

// /input/cases.json is either an array of {id, markdown} or an object
// holding that array under `cases`; /output/html.json must be a JSON
// array of 720 HTML strings, in the cases' order.
const raw = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const cases = Array.isArray(raw) ? raw : raw.cases;
const out = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i].markdown);
}
mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(out));
