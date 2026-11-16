// markdown-render-speed-02: dependency-free marked 18.1.3-compatible parser.
// Written from scratch against the CommonMark 0.31.2 + GFM spec examples and
// marked's documented behaviour. Single-file, no dependencies, no network.

// ---------- helpers ----------
const EMAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => s.replace(/[&<>"']/g, c => EMAP[c]);
// Attribute escaping the way marked's P(s) does (NoEncode): < > " ' are
// always escaped, but & is left alone when it starts a valid entity
// reference (#123; / #xAB; / word;) so &ouml; stays &ouml; in hrefs/titles.
const escAttr = s => s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, c => c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c === "'" ? '&#39;' : '&amp;');

// Decode a numeric character reference body (after &# or &#x, without the ;).
// Returns the raw replacement character: 0, >0x10FFFF, or a surrogate
// becomes U+FFFD.
function numRef(dec, hex) {
  const n = hex ? parseInt(hex, 16) : parseInt(dec, 10);
  if (!n || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(n);
}

// Decode a character reference at position i of s (no escaping): returns
// [raw, nextIndex]. Numeric refs decode (FFFD rules); &word; passes through
// literally; anything else is a bare &.
function decodeRef(s, i) {
  const m = /^&#([0-9]{1,7});/.exec(s.slice(i));
  if (m) return [numRef(m[1], null), i + m[0].length];
  const h = /^&#[Xx]([0-9A-Fa-f]{1,6});/.exec(s.slice(i));
  if (h) return [numRef(null, h[1]), i + h[0].length];
  const w = /^&[A-Za-z0-9_]+;/.exec(s.slice(i));
  if (w) return [w[0], i + w[0].length];
  return ['&', i + 1];
}

// Handle '&' at position i of s in TEXT: returns [html, nextIndex].
// Numeric refs decode and the result is HTML-escaped (so &#X22; becomes
// &quot;); named entities pass through literally; a bare & becomes &amp;.
function ampAt(s, i) {
  const m = /^&#([0-9]{1,7});/.exec(s.slice(i));
  if (m) return [esc(numRef(m[1], null)), i + m[0].length];
  const h = /^&#[Xx]([0-9A-Fa-f]{1,6});/.exec(s.slice(i));
  if (h) return [esc(numRef(null, h[1])), i + h[0].length];
  const w = /^&[A-Za-z0-9_]+;/.exec(s.slice(i));
  if (w) return [w[0], i + w[0].length];
  return ['&amp;', i + 1];
}

// Normalize a link label for reference lookup: collapse whitespace, trim,
// case-fold (marked folds case the same way).
const normLabel = l => l.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');

// Encode a link destination the way marked does: encodeURI, then restore %
// that encodeURI itself produced for an original % (marked keeps % as %).
function cleanHref(h) {
  try { h = encodeURI(h).replace(/%25/g, '%'); } catch (e) { return null; }
  return h;
}

// Split a table row line into cells on unescaped pipes. Escaped pipes stay
// as \| in the cell text (the inline parser turns them into |).
function splitCells(line) {
  const cells = [];
  let cur = '', bs = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { bs++; cur += c; continue; }
    // An escaped pipe \| is content, not a separator: drop the escape
    // backslash so a code span sees a plain | (the cell is unescaped here,
    // before inline parsing, so `\|` renders as <code>|</code>).
    if (c === '|' && bs % 2 === 0) { cells.push(cur); cur = ''; bs = 0; continue; }
    if (c === '|' && bs % 2 === 1) { cur = cur.slice(0, -1) + '|'; bs = 0; continue; }
    bs = 0; cur += c;
  }
  cells.push(cur);
  // Drop one empty cell at each end when the line starts/ends with a pipe.
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

// ---------- block parsing ----------
// Block tokenizers work on the remaining source string and return
// {raw, html} (html '' for definitions, which only register a link), or null.
// `defs` is the shared link-reference map for the whole document.

const SPACES = '[ \\t]*';
const INDENT3 = ' {0,3}';

// A line is blank when it holds only spaces/tabs (a newline ends it).
function isBlank(line) { return /^[ \t]*$/.test(line); }

// Indent of a line in columns (tab advances to the next multiple of 4).
function lineIndent(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Strip up to `n` columns of leading indent from a line. A tab that spans
// past the strip point leaves the remaining columns as spaces.
function stripIndent(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else { return ' '.repeat(col + w - n) + line.slice(i + 1); }
    } else break;
  }
  return line.slice(i);
}

// Strip n columns from the front of a line regardless of character type
// (used for a list item's first line, where the columns are the marker).
function stripCols(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else { return ' '.repeat(col + w - n) + line.slice(i + 1); }
    } else { col++; i++; }
  }
  return line.slice(i);
}

// Expand the leading tabs of `s` to spaces, assuming `s` starts at column
// `col0`. Only leading whitespace is expanded; tabs after the first
// non-whitespace character are preserved (marked keeps those as-is).
function expandLeading(s, col0) {
  let col = col0, i = 0, out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { out += ' '; col++; i++; }
    else if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  return out + s.slice(i);
}

// First line of the remaining source (without its newline).
function firstLine(src) {
  const nl = src.indexOf('\n');
  return nl === -1 ? src : src.slice(0, nl);
}

const BLOCK_TAGS = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$)/i;

// Try to match a link reference definition at the start of src.
// Returns {raw, label, dest, title} or null. May span up to 3 lines.
function tryDef(src) {
  // Label: '[' ... ']' with backslash escapes. Nested '[' is not allowed
  // in a label (marked rejects it), so a '[' ends the definition.
  if (!/^ {0,3}\[/.test(src)) return null;
  let li = src.indexOf('[');
  let j = li + 1, label = '';
  let labelEnd = -1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\' && j + 1 < src.length) { label += src.slice(j, j + 2); j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') { labelEnd = j; break; }
    label += c; j++;
  }
  if (labelEnd === -1) return null;
  if (src[labelEnd + 1] !== ':') return null;
  // An empty (or whitespace-only) label is not a definition.
  if (!label.replace(/\\(.)/g, '$1').trim()) return null;
  let rest = src.slice(labelEnd + 2);
  // Destination: optional spaces/tabs/newlines, then <...> or a bare dest.
  let mm = /^[ \t]*(?:\n[ \t]*)?/.exec(rest);
  rest = rest.slice(mm[0].length);
  let dest = '';
  if (rest[0] === '<') {
    const end = rest.indexOf('>');
    if (end === -1) return null;
    dest = rest.slice(1, end);
    if (/[\n]/.test(dest) || /[\x00-\x1f]/.test(dest)) return null;
    rest = rest.slice(end + 1);
  } else {
    // Bare destination: no spaces or control chars, balanced parens.
    let i = 0, depth = 0;
    while (i < rest.length) {
      const c = rest[i];
      if (c === ' ' || c === '\t' || c === '\n' || c <= '\x1f') break;
      if (c === '(') { depth++; if (depth > 1) break; }
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === '\\' && i + 1 < rest.length) { i += 2; continue; }
      i++;
    }
    dest = rest.slice(0, i);
    if (!dest) return null;
    rest = rest.slice(i);
  }
  // Optional title. It must be separated from the destination by
  // whitespace and followed by a line end. If a candidate title is not
  // followed by a line end, fall back to no title.
  let title = null;
  let after = rest;
  // Try a title on the same line (after spaces/tabs) or on the next line.
  const tryTitle = (s) => {
    const q = s[0];
    if (q !== '"' && q !== "'" && q !== '(') return null;
    const close = q === '(' ? ')' : q;
    let k = 1;
    while (k < s.length) {
      const c = s[k];
      if (c === '\\' && k + 1 < s.length) { k += 2; continue; }
      // A blank line ends the definition; a title may not span one.
      if (c === '\n') {
        let m2 = k + 1;
        while (m2 < s.length && (s[m2] === ' ' || s[m2] === '\t')) m2++;
        if (m2 >= s.length || s[m2] === '\n') return null;
      }
      if (c === close) return { title: s.slice(1, k), rest: s.slice(k + 1) };
      k++;
    }
    return null;
  };
  let sp = /^[ \t]*/.exec(after)[0];
  let cand = after.slice(sp.length);
  // A same-line title needs at least one space/tab before it.
  let t = sp.length > 0 ? tryTitle(cand) : null;
  if (t && /^[ \t]*(?:\n|$)/.test(t.rest)) {
    title = t.title; after = t.rest;
  } else if (cand[0] === '\n') {
    // End of the destination's line: peek at the next line for a title.
    const nl = cand.slice(1);
    const sp2 = /^[ \t]*/.exec(nl)[0];
    const cand2 = nl.slice(sp2.length);
    const t2 = tryTitle(cand2);
    if (t2 && /^[ \t]*(?:\n|$)/.test(t2.rest)) {
      title = t2.title; after = t2.rest;
    } else {
      after = cand; // no title; the definition ends at this line end
    }
  } else {
    after = cand;
  }
  // After the definition there must be a line end (or end of input).
  const tail = /^[ \t]*(?:\n|$)/.exec(after);
  if (!tail) return null;
  const rawLen = src.length - after.length + tail[0].length;
  return { raw: src.slice(0, rawLen), label, dest, title };
}

// ---------- block parser (line-based) ----------
// Lines are the source split on \n (after \r normalisation). A block parser
// walks lines[a..b) and returns [html, nextIndex]. Link definitions register
// into `defs` and produce no output. Blocks are rendered after the whole
// document is parsed, so a definition anywhere can serve a link anywhere.

function blankAt(lines, i) { return i >= lines.length || isBlank(lines[i]); }

// Match a fenced code block starting at line i. Returns {raw lines count,
// lang, text} or null.
function fenceAt(lines, i) {
  const line = lines[i];
  const m = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!m) return null;
  const fence = m[1], ch = fence[0];
  if (ch === '`' && m[2].indexOf('`') !== -1) return null;
  // Content lines lose up to the fence's own indent (0-3 spaces).
  const find = m[0].length - m[1].length - m[2].length;
  let j = i + 1;
  const contentLines = [];
  for (; j < lines.length; j++) {
    const l = lines[j];
    const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
    if (cm && cm[1][0] === ch && cm[1].length >= fence.length) { j++; break; }
    let k = 0;
    while (k < l.length && k < find && l[k] === ' ') k++;
    contentLines.push(l.slice(k));
  }
  // The lines are joined by \n, with a trailing \n — except that a blank
  // line just before the closing fence already supplies it, so a block
  // ending in blanks loses one \n (marked's fence content rule).
  let text = contentLines.join('\n');
  if (contentLines.length && contentLines[contentLines.length - 1] !== '') text += '\n';
  const info = m[2].trim();
  // Language: first word of the info string, with backslash escapes
  // resolved (marked unescapes them, so ``` foo\+bar is language foo+bar).
  const langFull = info.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
  const lang = langFull.split(/\s+/)[0] || '';
  return { next: j, lang, text };
}

// Match an ATX heading at line i. Returns {depth, text, next} or null.
function atxAt(line) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line);
  if (!m) return null;
  let text = (m[2] || '').replace(/[ \t]+$/, '');
  // A closing run of #s preceded by a space is stripped. If the whole
  // content is #s (e.g. '### ###'), the space after the opening marker
  // counts as the preceding space, so the content is empty.
  const cm = /^(.*?)[ \t]+#+$/.exec(text);
  if (cm) text = cm[1].replace(/[ \t]+$/, '');
  else if (/^#+$/.test(text)) text = '';
  return { depth: m[1].length, text };
}

// Thematic break line (---, ***, ___, with spaces/tabs between).
function hrAt(line) {
  return /^ {0,3}(?:\*[ \t]*){3,}$/.test(line) ||
    /^ {0,3}(?:-[ \t]*){3,}$/.test(line) ||
    /^ {0,3}(?:_[ \t]*){3,}$/.test(line);
}

// A line that is only = or - runs (plus spaces): a setext underline.
function setextAt(line) {
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  return m ? (m[1][0] === '=' ? 1 : 2) : 0;
}

// HTML block start at line i. Returns the condition number (1-7) or 0.
function htmlStart(line) {
  const m = /^ {0,3}<(\/?)([A-Za-z][A-Za-z0-9-]*|!--|\?|!\[CDATA\[|![A-Za-z])/i.exec(line);
  if (!m) return 0;
  const tag = m[2].toLowerCase();
  if (m[1] === '/') {
    // Closing tag: condition 6 if a block tag, else 7 (when alone on line).
    // A closing pre/script/style/textarea tag is neither: pre etc. are
    // type-1 tags, so </pre> is not an HTML block at all.
    if (BLOCK_TAGS.test(tag)) return 6;
    if (/^(?:pre|script|style|textarea)$/.test(tag)) return 0;
    return /^ {0,3}<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.test(line) ? 7 : 0;
  }
  if (tag === '!--') return 2;
  if (tag === '?') return 3;
  if (/^![a-z]$/.test(tag)) return 4; // <! + letter (e.g. <!DOCTYPE)
  if (tag === '![cdata[') return 5;
  if (/^(?:pre|script|style|textarea)$/.test(tag)) return 1;
  if (BLOCK_TAGS.test(tag)) return 6;
  // Condition 7: a complete open tag alone on the line (a valid tag name
  // with optional attributes, then only whitespace). A '<' followed by
  // letters that are not a valid tag (e.g. <https://...>) is NOT an
  // HTML block — it is a paragraph with an autolink.
  if (/^ {0,3}<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>[ \t]*$/.test(line)) return 7;
  return 0;
}

// End condition for an HTML block of the given type, tested per line.
function htmlEnds(type, line) {
  switch (type) {
    case 1: return /<\/(pre|script|style|textarea)[\s>]/i.test(line);
    case 2: return /-->/.test(line);
    case 3: return /\?>/.test(line);
    case 4: return />/.test(line);
    case 5: return /\]\]>/.test(line);
    default: return false; // types 6 and 7 end at a blank line
  }
}

// Delimiter row of a table: cells of :?-+:? separated by pipes.
function tableDelimAt(line) {
  const t = line.trim();
  if (!/^[\s:|\-]*$/.test(t) || t.indexOf('-') === -1) return null;
  const cells = splitCells(t);
  const align = [];
  for (const c of cells) {
    const s = c.trim();
    if (!/^:?-+:?$/.test(s)) return null;
    align.push(s[0] === ':' && s[s.length - 1] === ':' ? 'center' : s[0] === ':' ? 'left' : s[s.length - 1] === ':' ? 'right' : null);
  }
  return align.length ? align : null;
}

// Does lines[j] start a table (header + delimiter follow)? The delimiter
// must have the same number of cells as the header, else it is a paragraph.
function tableAt(lines, j) {
  if (j + 1 >= lines.length) return null;
  const head = lines[j];
  if (head.indexOf('|') === -1) return null;
  const align = tableDelimAt(lines[j + 1]);
  if (!align) return null;
  if (align.length !== splitCells(head).length) return null;
  return align;
}

// Does line i start a list item? Returns {ordered, start, markerLen, indent}
// or null. `interrupt` tells whether it may interrupt a paragraph.
function listMarkerAt(line, interrupt) {
  const m = /^ {0,3}([*+-]|\d{1,9}[.)])([ \t]+|$)/.exec(line);
  if (!m) return null;
  const marker = m[1];
  const ordered = /\d/.test(marker[0]);
  const start = ordered ? parseInt(marker, 10) : 0;
  const after = line.slice(m[0].length);
  // An empty item cannot interrupt a paragraph; an ordered list can only
  // interrupt a paragraph when it starts at 1.
  if (interrupt) {
    if (after.trim() === '') return null;
    if (ordered && start !== 1) return null;
  }
  const indent = lineIndent(line);
  const markerLen = m[0].length - (m[2] ? m[2].length : 0);
  // markerLen already includes the leading indent (m[0] starts at column 0),
  // so it is the column just past the marker.
  return { ordered, start, markerLen, indent, afterSpaces: m[2] || '' };
}

// Match a link reference definition starting at lines[i] (may span lines).
// Returns {label, dest, title, next} or null.
function tryDefLines(lines, i) {
  // A definition can span several lines (the title may wrap), so hand
  // tryDef a generous window; it stops at the first line end after the def.
  const chunk = lines.slice(i, i + 6).join('\n') + '\n';
  const d = tryDef(chunk);
  if (!d) return null;
  const consumed = (d.raw.match(/\n/g) || []).length;
  return { label: d.label, dest: d.dest, title: d.title, next: i + consumed };
}

// Indented code block starting at line i (indent >= 4). Consumes indented
// lines and blank lines that are followed by more indented lines.
// Remove n columns of indent from the start of a line. A tab advances to
// the next multiple of 4; a tab entirely past the boundary is kept as-is
// (not expanded), and a straddling tab becomes spaces for its remainder.
function stripIndentCols(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

function parseIndented(lines, i, b) {
  let text = '', j = i;
  while (j < b) {
    const line = lines[j];
    if (isBlank(line)) {
      // Blank line: include only if a later indented line follows. Its
      // spaces past the 4-column indent are kept (so a 6-space blank line
      // contributes 2 spaces to the code).
      let k = j + 1;
      while (k < b && isBlank(lines[k])) k++;
      if (k < b && lineIndent(lines[k]) >= 4) {
        text += stripIndentCols(line, 4) + '\n';
        j++; continue;
      }
      break;
    }
    const ex = expandLeading(line, 0);
    const ind = ex.length - ex.replace(/^ +/, '').length;
    if (ind < 4) break;
    text += stripIndentCols(line, 4) + '\n';
    j++;
  }
  return { text, next: j };
}

// HTML block starting at line i (condition `type`). Ends per the condition.
function parseHtml(lines, i, b, type, eof) {
  const out = [];
  let j = i, ended = false;
  for (; j < b; j++) {
    const line = lines[j];
    // A blank line ends a type 6/7 block and is NOT part of it.
    if (j > i && type >= 6 && isBlank(line)) break;
    out.push(line);
    // Types 1-5 end on the line containing the closing marker — including
    // the first line (e.g. <style>...</style> on one line).
    if (type <= 5 && htmlEnds(type, line)) { j++; ended = true; break; }
  }
  // The lines are joined by \n. A trailing \n is included when the block
  // ended via its end marker, or when it ran to the end of the whole input
  // (eof) — but never when the next line is blank (a block that ended at a
  // blank line or just before one has no trailing \n), and never when it
  // ended at a container boundary.
  let text = out.join('\n');
  const endedAtBlank = j < b && type >= 6 && isBlank(lines[j]);
  const nextIsBlank = j < b && isBlank(lines[j]);
  if (out.length && (ended || (!endedAtBlank && eof && gEndsWithNL)) && !nextIsBlank) text += '\n';
  return { text, next: j };
}

// Table starting at line i (header) with the delimiter alignments `align`.
function parseTable(lines, i, b, align, defs) {
  const head = splitCells(lines[i]).map(c => c.trim());
  const rows = [];
  let j = i + 2;
  while (j < b) {
    const line = lines[j];
    // A line with only spaces (or empty) ends the table, but a line
    // containing a tab is a row (marked treats it as an empty row, and
    // the table then keeps swallowing following lines as rows).
    if (line.trim() === '' && !line.includes('\t')) break;
    // A line that starts a new block (blockquote, heading, fence, hr,
    // list, html 1-6, indented code) ends the table; a plain line without
    // a pipe is still a row (one cell, padded with empty cells). A
    // whitespace-only line is not a block start (a tab-only line is a row).
    if (line.trim() !== '' && (/^ {0,3}>/.test(line) || startsBlock(line))) break;
    rows.push(splitCells(line).map(c => c.trim()));
    j++;
  }
  return { node: { t: 'table', align, head, rows }, next: j };
}

// Paragraph starting at line i (with setext detection). Lines are kept raw.
// `nested` is true when parsing a list item's content: there, a nested
// list marker interrupts the paragraph whatever its start number.
function parsePara(lines, i, b, nested) {
  const ls = [lines[i]];
  let j = i + 1;
  while (j < b) {
    const line = lines[j];
    if (isBlank(line)) {
      // A trailing line of spaces (not an empty line) at the very end of
      // the block is paragraph text, not a separator (e.g. '>  ' in a
      // blockquote leaves a lone space line inside the paragraph).
      if (line !== '' && j === b - 1) { ls.push(line); j++; }
      break;
    }
    if (setextAt(line)) break;
    if (/^ {0,3}#{1,6}(?:[ \t]+|[ \t]*$)/.test(line)) break;
    if (fenceOpenLine(line)) break;
    if (/^ {0,3}>/.test(line)) break;
    if (hrAt(line)) break;
    const hs = htmlStart(line);
    if (hs >= 1 && hs <= 6) break;
    if (listMarkerAt(line, nested ? false : true)) break;
    if (tableAt(lines, j)) break;
    ls.push(line);
    j++;
  }
  if (j < b) {
    const d = setextAt(lines[j]);
    if (d) return { node: { t: 'h', d, text: ls.join('\n').trim() }, next: j + 1 };
  }
  return { node: { t: 'p', text: ls.join('\n') }, next: j };
}

// Main block parser: lines[a..b) -> array of block nodes. `defs` is shared.
// `nested` is true inside a list item's content (nested lists may
// interrupt a paragraph there whatever their start number).
function parseBlocks(lines, a, b, defs, eof, nested) {
  const nodes = [];
  let i = a, loose = false, sawBlock = false, sawBlank = false;
  while (i < b) {
    const line = lines[i];
    if (isBlank(line)) { sawBlank = true; i++; continue; }
    const d = tryDefLines(lines, i);
    if (d) {
      // A definition is invisible, but a blank line before it still
      // separates the surrounding blocks (e.g. list items).
      if (sawBlock && sawBlank) loose = true;
      sawBlock = true; sawBlank = false;
      const key = normLabel(d.label);
      if (key && !(key in defs)) defs[key] = { href: d.dest, title: d.title };
      i = d.next; continue;
    }
    // A real block starts here: a blank line before it (after an earlier
    // block) means the blocks are separated, i.e. this level is loose.
    if (sawBlock && sawBlank) loose = true;
    sawBlock = true; sawBlank = false;
    const f = fenceAt(lines, i);
    if (f) { nodes.push({ t: 'code', lang: f.lang, text: f.text, fenced: true }); i = f.next; continue; }
    const h = atxAt(line);
    if (h) { nodes.push({ t: 'h', d: h.depth, text: h.text }); i++; continue; }
    if (hrAt(line)) { nodes.push({ t: 'hr' }); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const q = parseQuote(lines, i, b, defs, nested);
      nodes.push({ t: 'quote', items: q.nodes }); i = q.next; continue;
    }
    const lm = listMarkerAt(line, false);
    if (lm) {
      const l = parseList(lines, i, b, defs);
      nodes.push(l.node); i = l.next; continue;
    }
    const hs = htmlStart(line);
    if (hs) {
      const hb = parseHtml(lines, i, b, hs, eof);
      nodes.push({ t: 'html', text: hb.text }); i = hb.next; continue;
    }
    if (lineIndent(line) >= 4) {
      const c = parseIndented(lines, i, b);
      nodes.push({ t: 'code', lang: '', text: c.text, fenced: false }); i = c.next; continue;
    }
    const al = tableAt(lines, i);
    if (al) {
      const tb = parseTable(lines, i, b, al, defs);
      nodes.push(tb.node); i = tb.next; continue;
    }
    const p = parsePara(lines, i, b, nested);
    nodes.push(p.node); i = p.next;
  }
  return { nodes, loose };
}

// Fence opener on a single line (content after '>' stripping). Returns
// {char, len} or null. A backtick fence's info string must not contain a
// backtick.
function fenceOpenLine(s) {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(s);
  if (!m) return null;
  const ch = m[1][0];
  if (ch === '`' && s.slice(m[0].length).includes('`')) return null;
  return { char: ch, len: m[1].length };
}

// True when a single line closes the fence `f` (same char, at least as
// long, nothing but whitespace after it).
function fenceCloseLine(s, f) {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(s);
  return !!m && m[1][0] === f.char && m[1].length >= f.len;
}

// Blockquote starting at line i. `nested` is inherited from the context
// (a quote inside a list item is nested content too).
function parseQuote(lines, i, b, defs, nested) {
  const inner = [];
  let j = i, inPara = false, prevLazy = false, inFence = null;
  while (j < b) {
    const line = lines[j];
    const m = /^ {0,3}>/.exec(line);
    if (m) {
      // Expand the leading tabs after '>' (relative to the column just
      // after it), then consume one optional space.
      let s = expandLeading(line.slice(m[0].length), m[0].length);
      if (s.startsWith(' ')) s = s.slice(1);
      inner.push(s);
      // Track fenced code blocks: while inside one, lines are code
      // content (not paragraph text), so a lazy line cannot continue it.
      if (inFence) {
        if (fenceCloseLine(s, inFence)) inFence = null;
        inPara = false;
      } else {
        const fo = fenceOpenLine(s);
        if (fo) { inFence = fo; inPara = false; }
        else inPara = !isBlank(s) && !startsBlock(s);
      }
      prevLazy = false;
      j++; continue;
    }
    // A blank line without a '>' ends the blockquote (a new '>' after it
    // starts a fresh quote).
    if (isBlank(line)) break;
    // A lazy line inside a fenced code block ends the quote (and the code
    // block); it is not code content and cannot lazily continue it.
    if (inFence) break;
    if (!inPara) break;
    // A lazy line that is a thematic break ends the quote (it is an hr
    // outside it). A lazy setext underline is not a real underline: it is
    // paragraph text, indented by 4 spaces when it follows another lazy
    // line (marked's blockquoteSetextReplace).
    if (hrAt(line)) break;
    if (setextAt(line)) {
      inner.push(prevLazy ? '    ' + line.trim() : line);
      prevLazy = true; j++; continue;
    }
    // Lazy continuation of the quote's open paragraph. A lazy line that
    // is itself a block start (heading, fence, list with <=3 indent, html,
    // table) ends the quote; otherwise it is paragraph text, appended to
    // the paragraph's last line (with a newline), not pushed as a new
    // line: once stripped it may look like a block start (e.g. '- bar'),
    // but it is paragraph text, not a new block.
    if (/^ {0,3}#{1,6}(?:[ \t]+|[ \t]*$)/.test(line)) break;
    if (fenceOpenLine(line)) break;
    if (listMarkerAt(line, true)) break;
    const hs = htmlStart(line);
    if (hs >= 1 && hs <= 6) break;
    if (tableAt(lines, j)) break;
    const ex = expandLeading(line, 0);
    const stripped = /^ {4}/.test(ex) ? ex.slice(4) : line;
    inner[inner.length - 1] += '\n' + stripped;
    prevLazy = true;
    j++;
  }
  // Only truly empty trailing lines are dropped; a trailing line of
  // spaces is part of the paragraph (it survives as paragraph text).
  while (inner.length && inner[inner.length - 1] === '') inner.pop();
  const { nodes } = parseBlocks(inner, 0, inner.length, defs, false, nested);
  return { nodes, next: j };
}

// True when a line starts a non-paragraph block (fence, ATX heading, hr,
// list, HTML block 1-6, indented code, table). Used to decide whether a
// blockquote's content still ends in an open paragraph.
function startsBlock(s) {
  if (fenceOpenLine(s)) return true;
  if (/^ {0,3}#{1,6}(?:[ \t]+|[ \t]*$)/.test(s)) return true;
  if (hrAt(s)) return true;
  if (listMarkerAt(s, true)) return true;
  const hs = htmlStart(s);
  if (hs >= 1 && hs <= 6) return true;
  if (lineIndent(s) >= 4) return true;
  return false;
}

// One list item starting at line s, with the list's marker indent and the
// content indent computed from the first line. Returns {lines, next, task,
// checked, blankAfter} where lines are the item's content lines.
function parseItem(lines, s, b, listIndent, marker) {
  const firstLine = lines[s];
  const markerEnd = marker.markerLen; // listMarkerAt already includes the indent
  const after = expandLeading(firstLine.slice(markerEnd), markerEnd);
  // Columns of spaces after the marker on the first line (tabs expanded).
  let sp = 0;
  while (sp < after.length && after[sp] === ' ') sp++;
  const rest = after.slice(sp);
  let contentIndent, firstContent;
  if (rest === '') { contentIndent = markerEnd + 1; firstContent = ''; }
  else if (sp >= 1 && sp <= 4) { contentIndent = markerEnd + sp; firstContent = rest; }
  else { contentIndent = markerEnd + 1; firstContent = after.slice(1); }
  const itemLines = [firstContent];
  let j = s + 1, blankAfter = false, blankRun = 0;
  let hasContent = firstContent !== '';
  // Whether the item's content so far ends in an open paragraph. A
  // non-blank line that is not indented enough can still continue such a
  // paragraph (a lazy continuation), with its leading whitespace stripped.
  let inPara = hasContent && !startsBlock(firstContent);
  while (j < b) {
    const line = lines[j];
    if (isBlank(line)) {
      // An item with no content yet is closed by a blank line: indented
      // lines after it are not part of the (empty) item.
      if (!hasContent) break;
      itemLines.push(''); blankRun++; inPara = false; j++; continue;
    }
    const ex = expandLeading(line, 0);
    if (ex.length - ex.replace(/^ +/, '').length >= contentIndent) {
      const content = ex.slice(contentIndent);
      itemLines.push(content);
      if (!isBlank(content)) {
        hasContent = true;
        inPara = !startsBlock(content);
      }
      blankRun = 0; j++; continue;
    }
    // Not indented enough.
    // (a) A new item at the list's indent ends this item — including an
    // empty item ('-' alone), which listMarkerAt(..., true) would miss.
    const nm = listMarkerAt(line, false);
    if (nm && nm.indent === listIndent && nm.ordered === marker.ordered &&
        (marker.ordered ? nm.markerLen === marker.markerLen || true : nm.markerLen === marker.markerLen)) break;
    // (b) A lazy paragraph continuation, or the item ends.
    // (The indented-code test is deliberately excluded: a lazy line with
    // >= 4 indent is stripped and becomes paragraph text.)
    if (inPara && !/^ {0,3}#{1,6}(?:[ \t]+|[ \t]*$)/.test(line) &&
        !fenceOpenLine(line) && !hrAt(line) &&
        !listMarkerAt(line, true) &&
        !(htmlStart(line) >= 1 && htmlStart(line) <= 6) && !tableAt(lines, j)) {
      // Strip all leading whitespace and append to the paragraph's line.
      const stripped = line.replace(/^[ \t]+/, '');
      itemLines[itemLines.length - 1] += '\n' + stripped;
      blankRun = 0; j++; continue;
    }
    break;
  }
  // Trailing blank lines are separators, not item content. An empty item
  // (only its blank first content) is not followed by a blank line.
  // Rewind `next` to the first trailing blank so the outer parser sees
  // the blank line (it separates this item from the next block/item).
  let popped = 0;
  while (itemLines.length > 1 && isBlank(itemLines[itemLines.length - 1])) { itemLines.pop(); blankAfter = true; popped++; }
  if (itemLines.length === 1 && isBlank(itemLines[0])) itemLines.pop();
  return { lines: itemLines, next: j - popped, blankAfter, contentIndent };
}

// List starting at line i.
function parseList(lines, i, b, defs) {
  const first = listMarkerAt(lines[i], false);
  const ordered = first.ordered;
  const start = first.start;
  // The list's base indent may dedent: an item with a smaller indent
  // than the first still joins (marked merges them into one list).
  let listIndent = first.indent;
  const bullet = first.ordered ? null : lines[i].slice(first.indent, first.indent + 1);
  const delim = first.ordered ? lines[i].slice(first.indent + String(start).length, first.indent + String(start).length + 1) : null;
  const items = [];
  let j = i, loose = false, prevBlank = false, prevContentIndent = Infinity;
  while (j < b) {
    // A blank line between items does not end the list; it makes it loose
    // (the next item, if any, still belongs to it). But if the next
    // non-blank line is not an item of this list, the list ends here and
    // `next` stays at the first blank, so the outer parser sees the blank
    // line (it separates this list from the following block).
    if (isBlank(lines[j])) {
      let k = j;
      while (k < b && isBlank(lines[k])) k++;
      const m2 = k < b ? listMarkerAt(lines[k], false) : null;
      let same = false;
      if (m2 && m2.indent < prevContentIndent && m2.ordered === ordered && !hrAt(lines[k])) {
        const b2 = m2.ordered ? null : lines[k].slice(m2.indent, m2.indent + 1);
        const d2 = m2.ordered ? lines[k].slice(m2.indent + String(m2.start).length, m2.indent + String(m2.start).length + 1) : null;
        same = b2 === bullet && d2 === delim;
      }
      if (same) { prevBlank = true; j = k; continue; }
      break;
    }
    const m = listMarkerAt(lines[j], false);
    // An item belongs to this list when it is below the previous item's
    // content indent (so it does not start a sublist). Items may vary in
    // indent, including dedenting below the first item's indent.
    if (!m || m.indent >= prevContentIndent || m.ordered !== ordered) break;
    // A line that is a thematic break is not a list item (it ends the list).
    if (hrAt(lines[j])) break;
    const thisBullet = m.ordered ? null : lines[j].slice(m.indent, m.indent + 1);
    const thisDelim = m.ordered ? lines[j].slice(m.indent + String(m.start).length, m.indent + String(m.start).length + 1) : null;
    if (thisBullet !== bullet || thisDelim !== delim) break;
    if (m.indent < listIndent) listIndent = m.indent;
    if (prevBlank) loose = true;
    const it = parseItem(lines, j, b, listIndent, m);
    prevContentIndent = it.contentIndent;
    // Task checkbox at the start of the item's content: [ ]/[x]/[X] followed
    // by spaces/tabs and more text on the same line (marked's listIsTask).
    let task = false, checked = false;
    if (it.lines.length) {
      const tm = /^\[([ xX])\][ \t]+\S/.exec(it.lines[0]);
      if (tm) {
        task = true; checked = tm[1] !== ' ';
        it.lines[0] = it.lines[0].replace(/^\[[ xX]\][ \t]+/, '');
      }
    }
    // An item is loose when its own direct blocks are separated by a blank
    // line (reported by parseBlocks for this item's lines). Item content
    // is nested: a nested list interrupts its paragraph whatever its
    // start number.
    const pb = parseBlocks(it.lines, 0, it.lines.length, defs, false, true);
    if (pb.loose) loose = true;
    const blocks = pb.nodes;
    items.push({ task, checked, blocks });
    prevBlank = it.blankAfter;
    j = it.next;
  }
  return { node: { t: 'list', ordered, start, loose, items }, next: j };
}

// ---------- rendering ----------
function renderTable(n, defs) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let i = 0; i < n.head.length; i++) {
    const a = n.align[i];
    out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inline(n.head[i], defs) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (n.rows.length) {
    out += '<tbody>';
    for (const row of n.rows) {
      out += '<tr>\n';
      for (let i = 0; i < n.head.length; i++) {
        const a = n.align[i];
        const cell = row[i] !== undefined ? row[i] : '';
        out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inline(cell, defs) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  return out + '</table>\n';
}

function renderList(n, defs) {
  let out = n.ordered
    ? '<ol' + (n.start !== 1 ? ' start="' + n.start + '"' : '') + '>\n'
    : '<ul>\n';
  for (const it of n.items) {
    out += '<li>';
    // The checkbox goes inside the first paragraph's content (marked puts
    // it before the paragraph text, with one space after it).
    const box = it.task ? '<input' + (it.checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ' : '';
    const blocks = it.blocks;
    if (box && blocks.length && blocks[0].t === 'p') {
      const first = blocks[0];
      const rest = renderNodes(blocks.slice(1), defs, !n.loose);
      out += n.loose
        ? '<p>' + box + inline(first.text, defs) + '</p>\n' + rest
        : box + inline(first.text, defs) + rest;
    } else {
      out += box + renderNodes(blocks, defs, !n.loose);
    }
    out += '</li>\n';
  }
  return out + (n.ordered ? '</ol>\n' : '</ul>\n');
}

function renderNodes(nodes, defs, tight) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'p':
        out += tight ? inline(n.text, defs) : '<p>' + inline(n.text, defs) + '</p>\n';
        break;
      case 'h':
        out += '<h' + n.d + '>' + inline(n.text, defs) + '</h' + n.d + '>\n';
        break;
      case 'hr': out += '<hr>\n'; break;
      case 'code':
        out += '<pre><code' + (n.lang ? ' class="language-' + escAttr(n.lang) + '"' : '') + '>' + esc(n.text) + '</code></pre>\n';
        break;
      case 'quote':
        out += '<blockquote>\n' + renderNodes(n.items, defs, false) + '</blockquote>\n';
        break;
      case 'html': out += n.text; break;
      case 'list': out += renderList(n, defs); break;
      case 'table': out += renderTable(n, defs); break;
    }
  }
  return out;
}

// Document-level "inside an unclosed <a>" state. Marked's inline lexer
// keeps this flag across paragraphs: an unclosed inline <a> tag suppresses
// extended autolinks (email/www/scheme) for the rest of the document,
// until an inline </a> clears it. (Angle autolinks and [x](y) links are
// NOT suppressed by it.) Reset at the start of each parse().
let gInA = false;
let gEndsWithNL = false;

export function parse(src) {
  src = src.replace(/\r\n?/g, '\n');
  gEndsWithNL = src.endsWith('\n');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const defs = {};
  gInA = false;
  const { nodes } = parseBlocks(lines, 0, lines.length, defs, true);
  return renderNodes(nodes, defs, false);
}

// ---------- inline parsing ----------
// Direct-to-HTML scanner with a CommonMark delimiter stack for emphasis.
// `defs` is the document's link-reference map. `inLink` disables nested links.

const ASCII_PUNCT = /[!\"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~]/;
const isPunct = c => ASCII_PUNCT.test(c) || /\p{P}|\p{S}/u.test(c);
const isWS = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\x0b' || c === '\x0c' || c === '\u00a0';

// Flanking of a delimiter run at s[i..i+len): [canOpen, canClose] per the
// CommonMark rules (different for * and _).
function flanking(s, i, len, ch) {
  const n = s.length;
  const before = i > 0 ? s[i - 1] : '';
  const after = i + len < n ? s[i + len] : '';
  const beforeWS = i === 0 || isWS(before);
  const afterWS = i + len >= n || isWS(after);
  const beforeP = before !== '' && isPunct(before);
  const afterP = after !== '' && isPunct(after);
  const left = !afterWS && (!afterP || beforeWS || beforeP);
  const right = !beforeWS && (!beforeP || afterWS || afterP);
  if (ch === '*') return [left, right];
  return [left && (!right || beforeP), right && (!left || afterP)];
}

// Find the index of the `]` matching the `[` at `open` (balanced brackets,
// backslash escapes and code spans do not count). Returns -1 if none.
function findCloseBracket(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { i++; continue; }
    if (c === '`') {
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      const len = j - i;
      // Skip to a matching backtick run of the same length. A run of a
      // DIFFERENT length encountered first breaks the span: the opening
      // run is literal and does not hide a ']' (this is what lets
      // [docs each ``url`](d) form a link, while [foo`](/uri)` stays a
      // code span because its len-1 closer is unobstructed). If there is
      // no matching run at all, the span is unclosed and also literal.
      let k = j, broken = false, found = -1;
      while (k < s.length) {
        if (s[k] === '`') {
          let m = k;
          while (m < s.length && s[m] === '`') m++;
          if (m - k === len) { found = m; break; }
          broken = true; break;
        } else k++;
      }
      if (found !== -1) { i = found - 1; continue; }
      i = j - 1; continue;
    }
    // Skip an HTML tag or autolink: a ']' inside it is not a bracket.
    if (c === '<') {
      const tag = tryTag(s, i);
      if (tag) { i += tag.length - 1; continue; }
      const al = tryAngleAutolink(s, i);
      if (al) { i = al.next - 1; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Parse a link destination + optional title inside parens starting at i
// (s[i] === '('). Returns {dest, title, next} (next is past ')') or null.
// The destination may be <...> or bare (balanced parens, no spaces); the
// title may be "..." '...' or (...); newlines are allowed between parts.
function parseParenLink(s, i) {
  let j = i + 1;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  let dest = '';
  if (s[j] === '<') {
    // Scan for the closing '>', skipping backslash-escaped chars (so
    // <foo\>> has no unescaped '>' and is not a link destination).
    let end = -1;
    for (let k = j + 1; k < s.length; k++) {
      if (s[k] === '\\' && k + 1 < s.length) { k++; continue; }
      if (s[k] === '>') { end = k; break; }
      if (s[k] === '\n') break;
    }
    if (end === -1) return null;
    dest = s.slice(j + 1, end);
    if (/[\n\x00-\x1f]/.test(dest)) return null;
    j = end + 1;
  } else {
    let depth = 0, k = j;
    while (k < s.length) {
      const c = s[k];
      if (c === ' ' || c === '\t' || c === '\n' || c <= '\x1f') break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === '\\' && k + 1 < s.length) { k += 2; continue; }
      k++;
    }
    dest = s.slice(j, k);
    j = k;
  }
  // dest must be followed by optional whitespace, an optional title, then ')'.
  let title = null;
  let save = j;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  const q = s[j];
  if (q === '"' || q === "'" || q === '(') {
    const close = q === '(' ? ')' : q;
    let k = j + 1, ok = false;
    while (k < s.length) {
      const c = s[k];
      if (c === '\\' && k + 1 < s.length) { k += 2; continue; }
      if (c === close) { ok = true; break; }
      if (c === '\n') break;
      k++;
    }
    if (ok) {
      title = s.slice(j + 1, k);
      j = k + 1;
    } else return null;
  }
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (s[j] !== ')') return null;
  return { dest, title, next: j + 1 };
}

// Resolve backslash escapes and numeric character references in a link
// destination or title (marked unescapes these before emitting them).
function unescLink(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) { out += s[i + 1]; i++; continue; }
    if (c === '&') { const [h, ni] = decodeRef(s, i); out += h; i = ni - 1; continue; }
    out += c;
  }
  return out;
}

// Try to parse a link or image starting at src[i] ('[' or '![').
// Returns {html, next} or null (not a link: the bracket is literal text).
// True when a label contains an unescaped '[' outside a code span.
// Such a label is not a link (marked rejects nested brackets in labels).
function hasUnescapedBracket(label) {
  for (let k = 0; k < label.length; k++) {
    const c = label[k];
    if (c === '\\') { k++; continue; }
    if (c === '`') {
      let m = k;
      while (m < label.length && label[m] === '`') m++;
      const len = m - k;
      let n = m;
      while (n < label.length) {
        if (label[n] === '`') {
          let q = n;
          while (q < label.length && label[q] === '`') q++;
          if (q - n === len) { k = q - 1; break; }
          n = q;
        } else n++;
      }
      if (n >= label.length) return false;
      continue;
    }
    if (c === '[') return true;
  }
  return false;
}

// True when a link label itself contains a complete link. Such a label
// cannot be the text of an outer link (links cannot nest). Images do not
// count: an image inside a link is allowed, so a whole image (inline or
// reference, label plus its destination/reference) is skipped.
function labelHasLink(label, defs) {
  for (let k = 0; k < label.length; k++) {
    if (label[k] === '!' && label[k + 1] === '[') {
      const img = tryLink(label, k, defs, false);
      if (img) { k = img.next - 1; continue; }
      continue;
    }
    if (label[k] === '[') {
      if (tryLink(label, k, defs, false)) return true;
    }
  }
  return false;
}

function tryLink(src, i, defs, inLink) {
  const isImg = src[i] === '!';
  const open = isImg ? i + 1 : i;
  if (src[open] !== '[') return null;
  // Links cannot nest, but an image inside a link is allowed.
  if (inLink && !isImg) return null;
  const close = findCloseBracket(src, open);
  if (close === -1) return null;
  const label = src.slice(open + 1, close);
  if (label.length > 999) return null;
  // If the label itself contains a link, this outer '[' cannot form a
  // link (links cannot nest); the inner link wins instead. Images may
  // contain links in their label (they become plain alt text).
  if (!isImg && labelHasLink(label, defs)) return null;
  let j = close + 1;
  let dest = null, title = null;
  if (src[j] === '(') {
    const p = parseParenLink(src, j);
    if (p) { dest = p.dest; title = p.title; j = p.next; }
    else {
      // Not a valid inline link: fall back to a shortcut reference.
      const r = defs[normLabel(label)];
      if (!r) return null;
      dest = r.href; title = r.title;
    }
  } else if (src[j] === '[') {
    const c2 = findCloseBracket(src, j);
    if (c2 === -1) return null;
    const ref = c2 === j + 1 ? label : src.slice(j + 1, c2);
    const r = defs[normLabel(ref)];
    if (!r) return null;
    dest = r.href; title = r.title; j = c2 + 1;
  } else {
    const r = defs[normLabel(label)];
    if (!r) return null;
    dest = r.href; title = r.title;
  }
  const href = cleanHref(unescLink(dest));
  if (href === null) return null;
  const titleAttr = title === null ? '' : ' title="' + escAttr(unescLink(title)) + '"';
  if (isImg) {
    // Alt text is the label's plain text; a nested image contributes its
    // own alt text (so <img> tags are replaced by their alt, not dropped).
    const altHtml = inline(label, defs, false).replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/g, '$1');
    const alt = altHtml.replace(/<[^>]*>/g, '');
    return { html: '<img src="' + escAttr(href) + '" alt="' + escAttr(alt) + '"' + titleAttr + '>', next: j };
  }
  const text = inline(label, defs, true);
  return { html: '<a href="' + escAttr(href) + '"' + titleAttr + '>' + text + '</a>', next: j };
}

// Extended autolink (GFM): mailto:/xmpp:, http(s)://, ftp://, www., or email.
// Uses marked's exact url rule: the scheme/www branch is
//   ^((?:http[s]?|ftp):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*
// followed by the _backpedal trim applied until stable; the email branch is
//   ^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![A-Za-z0-9-])
// Returns {html, next} or null.
const EMAIL_PROTO_Y = /(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![A-Za-z0-9-]|_(?!_))|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![A-Za-z0-9-]|_(?!_))(?:\/[A-Za-z0-9@.]+)?)/y;
const SCHEME_WWW_Y = /((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*/y;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const EMAIL_URL_Y = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![A-Za-z0-9-]|_(?!_))/y;
// Same email patterns WITHOUT the trailing-'_' blocker. A trailing '_' blocks
// the link ONLY when it is not an emphasis closer (gfm-632/633: a.b-c_d@a.b_
// stays literal). When the '_' closes an open '_' emphasis (e.g. inside
// _warning when@atlas.example.com_) the full email still links, so the
// blocker must be applied conditionally in tryExtAutolink, not in the regex.
const EMAIL_PROTO_NOU_Y = /(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![A-Za-z0-9-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![A-Za-z0-9-])(?:\/[A-Za-z0-9@.]+)?)/y;
const EMAIL_URL_NOU_Y = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![A-Za-z0-9-])/y;

// True when the '_' at src[p] can close an open '_' emphasis: it is
// right-flanking and an open '_' delimiter is on the stack.
function underscoreCloses(src, p, delims) {
  let len = 0;
  while (src[p + len] === '_') len++;
  if (len === 0) return false;
  if (!flanking(src, p, len, '_')[1]) return false;
  return delims.some(d => d.ch === '_' && d.open && d.rem > 0);
}

function tryExtAutolink(src, i, delims) {
  EMAIL_PROTO_NOU_Y.lastIndex = i;
  let m = EMAIL_PROTO_NOU_Y.exec(src);
  if (m) {
    const url = m[0];
    // A trailing '_' blocks the link unless it is an emphasis closer.
    if (src[i + url.length] === '_' && !underscoreCloses(src, i + url.length, delims)) return null;
    const href = cleanHref(url) || url;
    return { html: '<a href="' + escAttr(href) + '">' + esc(url) + '</a>', next: i + url.length };
  }
  SCHEME_WWW_Y.lastIndex = i;
  m = SCHEME_WWW_Y.exec(src);
  if (m) {
    let url = m[0];
    let prev;
    do { prev = url; url = BACKPEDAL_RE.exec(url)?.[0] ?? ''; } while (url !== prev);
    if (!url) return null;
    const href = cleanHref(m[1] === 'www.' ? 'http://' + url : url) || url;
    return { html: '<a href="' + escAttr(href) + '">' + esc(url) + '</a>', next: i + url.length };
  }
  EMAIL_URL_NOU_Y.lastIndex = i;
  m = EMAIL_URL_NOU_Y.exec(src);
  if (m) {
    const addr = m[0];
    if (src[i + addr.length] === '_' && !underscoreCloses(src, i + addr.length, delims)) return null;
    return { html: '<a href="mailto:' + escAttr(addr) + '">' + esc(addr) + '</a>', next: i + addr.length };
  }
  return null;
}

// Inline HTML tag at src[i] (src[i] === '<'). Returns the raw tag or null.
function tryTag(src, i) {
  const rest = src.slice(i);
  // <!--> and <!---> are empty comments (abrupt close).
  let m = /^<!-->/.exec(rest);
  if (m) return m[0];
  m = /^<!--->/.exec(rest);
  if (m) return m[0];
  m = /^<!--[\s\S]*?-->/.exec(rest);
  if (m) return m[0];
  m = /^<\?[\s\S]*?\?>/.exec(rest);
  if (m) return m[0];
  m = /^<![A-Z][^>]*>/.exec(rest);
  if (m) return m[0];
  m = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(rest);
  if (m) return m[0];
  // A closing tag has no attributes: </name> only (plus whitespace).
  m = /^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>/.exec(rest);
  if (m) return m[0];
  m = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/.exec(rest);
  if (m) return m[0];
  return null;
}

// Autolink <scheme:...> or <email> at src[i]. Returns {html, next} or null.
function tryAngleAutolink(src, i) {
  const m = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^<>\s\x00-\x1f]*)>/.exec(src.slice(i));
  if (m) {
    const url = m[1];
    return { html: '<a href="' + escAttr(cleanHref(url) || url) + '">' + esc(url) + '</a>', next: i + m[0].length };
  }
  const e = /^<([A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![A-Za-z0-9-]|_(?!_)))>/.exec(src.slice(i));
  if (e) {
    const addr = e[1];
    return { html: '<a href="mailto:' + escAttr(addr) + '">' + esc(addr) + '</a>', next: i + e[0].length };
  }
  return null;
}

// Apply `use` (1 or 2) delimiters from opener `op` and closer `cl`.
function applyEm(op, cl, use) {
  const ot = use === 1 ? '<em>' : '<strong>';
  const ct = use === 1 ? '</em>' : '</strong>';
  op.rem -= use; cl.rem -= use;
  op.ot = ot + op.ot;
  cl.ct = cl.ct + ct;
}

// Main inline parser: src -> HTML. `inLink` disables nested links.
function inline(src, defs, inLink) {
  const n = src.length;
  const out = [];
  const delims = [];
  // Effective in-link state: the local label nesting. (The document-level
  // unclosed-<a> flag gInA is separate: it suppresses only extended
  // autolinks, never [x](y) links.)
  let link = !!inLink;
  let i = 0;

  const SCHEME_START_Y = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//y;
  const NARROW_LOCAL = /[A-Za-z0-9._+-]/;
  const WWW_PREV = /[\s*_~(\]]/;

  // Consume a run of plain text starting at i (stops at special chars and
  // at extended-autolink starts, mirroring marked's GFM text regex).
  // Returns the new index.
  function textRun(i) {
    let j = i;
    while (j < n) {
      const c = src[j];
      if (c === '\\' || c === '`' || c === '<' || c === '[' || c === '!' ||
          c === '*' || c === '_' || c === '~' || c === '&' || c === '\n') break;
      // Hard break: 2+ spaces then a newline.
      if (c === ' ') {
        let k = j;
        while (k < n && src[k] === ' ') k++;
        if (k - j >= 2 && src[k] === '\n') break;
        j = k; continue;
      }
      // www. — only when preceded by the start or one of [ \t\n*_~(].
      if (c === 'w' && src.startsWith('www.', j) &&
          (j === 0 || WWW_PREV.test(src[j - 1]))) break;
      // Scheme http(s):// or ftp:// (any case) — no boundary restriction.
      if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
        SCHEME_START_Y.lastIndex = j;
        if (SCHEME_START_Y.test(src)) break;
      }
      // Email — only where a new local part can start (the previous char is
      // not a narrow local-part char), and the strict email pattern matches.
      if (NARROW_LOCAL.test(c) && (j === 0 || !NARROW_LOCAL.test(src[j - 1]))) {
        EMAIL_URL_Y.lastIndex = j;
        if (EMAIL_URL_Y.test(src)) break;
      }
      // mailto:/xmpp: — the text stops before it.
      if ((c === 'm' || c === 'x') && (j === 0 || !/[A-Za-z0-9]/.test(src[j - 1]))) {
        EMAIL_PROTO_Y.lastIndex = j;
        if (EMAIL_PROTO_Y.test(src)) break;
      }
      j++;
    }
    if (j > i) out.push(esc(src.slice(i, j)));
    return j;
  }

  while (i < n) {
    const c = src[i];

    if (c === '\\') {
      if (i + 1 < n) {
        const d = src[i + 1];
        if (d === '\n') { out.push('<br>'); i += 2; while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; continue; }
        if (ASCII_PUNCT.test(d)) { out.push(esc(d)); i += 2; continue; }
      }
      out.push('\\'); i++; continue;
    }

    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const len = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (src[k] === '`') {
          let m = k;
          while (m < n && src[m] === '`') m++;
          if (m - k === len) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found === -1) { out.push('`'.repeat(len)); i = j; continue; }
      let content = src.slice(j, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /\S/.test(content)) {
        content = content.slice(1, -1);
      }
      out.push('<code>' + esc(content) + '</code>');
      i = found + len;
      continue;
    }

    if (c === '<') {
      const al = tryAngleAutolink(src, i);
      if (al) { out.push(al.html); i = al.next; continue; }
      const tag = tryTag(src, i);
      if (tag) {
        out.push(tag);
        // An <a> tag sets the document-level flag (suppresses extended
        // autolinks until an inline </a>); it never suppresses [x](y).
        if (/^<a[\s>]/.test(tag)) gInA = true;
        else if (/^<\/a[\s>]/.test(tag)) gInA = false;
        i += tag.length; continue;
      }
      out.push('&lt;'); i++; continue;
    }

    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const r = tryLink(src, i, defs, link);
      if (r) { out.push(r.html); i = r.next; continue; }
      out.push(c); i++; continue;
    }

    if (c === '*' || c === '_') {
      let j = i;
      while (j < n && src[j] === c) j++;
      const len = j - i;
      const [canOpen, canClose] = flanking(src, i, len, c);
      const idx = out.length;
      out.push(c.repeat(len));
      const cl = { ch: c, len, rem: len, open: canOpen, close: canClose, idx, ot: '', ct: '', poisoned: false };
      if (canClose) {
        while (cl.rem > 0) {
          let oi = -1;
          for (let k = delims.length - 1; k >= 0; k--) {
            const op = delims[k];
            if (op.ch !== c || !op.open || op.rem === 0) continue;
            if ((op.open && op.close) || (canOpen && canClose)) {
              if ((op.rem + cl.rem) % 3 === 0 && !(op.rem % 3 === 0 && cl.rem % 3 === 0)) continue;
            }
            // A '**' opener poisoned by an inner emphasis whose closer
            // could both open and close (e.g. the '*' of '*so*' in
            // '**a *so*other* option**') must not match a single '*'
            // closer with use 1; it stays available for a '**' closer.
            if (op.poisoned && op.rem === 2 && Math.min(op.rem, cl.rem, 2) === 1) continue;
            oi = k; break;
          }
          if (oi === -1) break;
          const op = delims[oi];
          const use = Math.min(op.rem, cl.rem, 2);
          applyEm(op, cl, use);
          // When this closer could both open and close, it poisons any
          // enclosing '**' opener for single-delimiter matches.
          if (canOpen && canClose) {
            for (const d of delims) if (d.ch === c && d.rem === 2) d.poisoned = true;
          }
          out[op.idx] = op.ch.repeat(op.rem) + op.ot;
          out[cl.idx] = cl.ct + cl.ch.repeat(cl.rem);
          // Delimiters between the opener and this closer are inside the
          // emphasis just formed, so they cannot match a closer outside
          // it: drop them (and the opener itself if it is spent).
          if (op.rem === 0) { delims.splice(oi, 1); delims.splice(oi); }
          else delims.splice(oi + 1);
        }
      }
      if (canOpen && cl.rem > 0) delims.push(cl);
      i = j;
      continue;
    }

    if (c === '~') {
      // Del content may contain spaces (and line breaks) in the middle;
      // it just must not start or end with one (the opener lookahead and
      // the trailing [^\s~] enforce that). If the content holds an odd
      // number of the opener run, a nested del is unbalanced: extend the
      // closer to the next opener run (the true outer closer) so the
      // nested del forms inside it.
      const m = /^(~~?)(?=[^\s~])([\s\S]*?[^\s~])\1(?=[^~]|$)/.exec(src.slice(i));
      if (m) {
        const open = m[1];
        let content = m[2];
        let next = i + m[0].length;
        const countRuns = (s) => { let n = 0, p = 0; while ((p = s.indexOf(open, p)) !== -1) { n++; p += open.length; } return n; };
        while (countRuns(content) % 2 === 1) {
          const q = src.indexOf(open, next);
          if (q === -1) break;
          if (/\s/.test(src[q - 1])) break;
          if (src[q + open.length] === '~') break;
          content = src.slice(i + open.length, q);
          next = q + open.length;
        }
        out.push('<del>' + inline(content, defs, link) + '</del>');
        i = next;
        continue;
      }
      out.push('~'); i++; continue;
    }

    if (c === '&') {
      const [h, ni] = ampAt(src, i);
      out.push(h); i = ni; continue;
    }

    if (c === '\n') { out.push('\n'); i++; continue; }

    if (c === ' ') {
      let k = i;
      while (k < n && src[k] === ' ') k++;
      if (k - i >= 2 && src[k] === '\n') { out.push('<br>'); i = k + 1; while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; continue; }
      i = textRun(i);
      continue;
    }

    // Plain text run; if it stops immediately, an extended autolink starts
    // here (textRun's break conditions mirror the url token). Extended
    // autolinks are suppressed inside a link (or after an unclosed <a>);
    // angle autolinks are not. The fallback emits one literal char so the
    // loop always makes progress.
    const ni = textRun(i);
    if (ni === i) {
      const ea = (link || gInA) ? null : tryExtAutolink(src, i, delims);
      if (ea) { out.push(ea.html); i = ea.next; }
      else { out.push(esc(src[i])); i++; }
    } else i = ni;
  }
  return out.join('');
}
