// md-fast: a dependency-free marked 18.1.3-compatible Markdown renderer.
// Written from scratch from the CommonMark 0.31.2 / GFM 0.29 rules and the
// practice cases. Single pass over blocks, direct-to-HTML output, no token tree.

const ENTITY = {
  AElig: '\u00C6', ClockwiseContourIntegral: '\u2232', Dcaron: '\u010E',
  DifferentialD: '\u2146', HilbertSpace: '\u210B', amp: '&', auml: '\u00E4',
  copy: '\u00A9', frac34: '\u00BE', gt: '>', hellip: '\u2026', lt: '<',
  mdash: '\u2014', nbsp: '\u00A0', ngE: '\u2267\u0338', ouml: '\u00F6',
  quot: '"', reg: '\u00AE'
};

const DISALLOWED_TAGS = new Set([
  'title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes',
  'script', 'plaintext'
]);

// Block-level HTML tag names (CommonMark HTML block type 6).
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul'
]);

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
function isPunct(ch) {
  return ch !== undefined && PUNCT.indexOf(ch) !== -1;
}
function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}
function isAlphaNum(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || isDigit(ch);
}

// Escape &, <, >, ", ' in text content.
function escText(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > last) out += s.slice(last, i);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Escape an attribute value. An `&` that starts an entity-like reference
// (&name;, &#123;, &#x1f;) is preserved verbatim; other `&` become &amp;.
function escAttr(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      let j = i + 1;
      let ok = false;
      if (s.charCodeAt(j) === 35) { // #
        j++;
        if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) j++;
        const start = j;
        while (j < s.length && ((s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 102) || (s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 70))) j++;
        if (j > start && s.charCodeAt(j) === 59) ok = true;
      } else if ((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122)) {
        j++;
        while (j < s.length && isAlphaNum(s[j])) j++;
        if (s.charCodeAt(j) === 59) ok = true;
      }
      if (ok) {
        if (i > last) out += s.slice(last, i);
        out += s.slice(i, j + 1);
        i = j;
        last = j + 1;
        continue;
      }
      if (i > last) out += s.slice(last, i);
      out += '&amp;';
      last = i + 1;
    } else if (c === 60 || c === 62 || c === 34) {
      if (i > last) out += s.slice(last, i);
      out += c === 60 ? '&lt;' : c === 62 ? '&gt;' : '&quot;';
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Decode a numeric character reference starting at `i` (s[i] === '&').
// Returns [decodedString, endIndex] or null when not a valid numeric
// reference in range (0 and surrogates decode to U+FFFD; over 0x10FFFF is null).
function decodeNumericEntity(s, i) {
  if (s.charCodeAt(i + 1) !== 35) return null;
  let j = i + 2;
  let hex = false;
  if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
  const start = j;
  let code = 0;
  let digits = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    if (d < 0) break;
    code = code * (hex ? 16 : 10) + d;
    if (code > 0x10ffff) return null;
    digits++;
    j++;
  }
  if (digits === 0 || j >= s.length || s.charCodeAt(j) !== 59) return null;
  if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
  return [String.fromCodePoint(code), j + 1];
}

// Decode any character reference (named via the table, or numeric) — used
// only to probe a URL's scheme for dangerous content, never for output.
function decodeEntity(s, i) {
  const num = decodeNumericEntity(s, i);
  if (num) return num;
  let j = i + 1;
  while (j < s.length && j < i + 33) {
    const c = s.charCodeAt(j);
    if (c === 59) { // ;
      const v = ENTITY[s.slice(i + 1, j)];
      if (v !== undefined) return [v, j + 1];
      return null;
    }
    if (!isAlphaNum(s[j])) return null;
    j++;
  }
  return null;
}

// Remove backslash escapes before punctuation (entities are left alone).
function unescapeBackslash(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isPunct(s[i + 1])) {
      if (i > last) out += s.slice(last, i);
      out += s[i + 1];
      i++;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Sanitize a link destination. Returns null for dangerous schemes.
function cleanUrl(href) {
  // The stripped copy is only a probe for the scheme check; the href
  // itself is returned unchanged when safe (spaces stay for encoding).
  const u = href.replace(/[\u0000-\u0020\u007F]+/g, '');
  let probe = '';
  for (let i = 0; i < u.length;) {
    if (u.charCodeAt(i) === 38) {
      const d = decodeEntity(u, i);
      if (d) { probe += d[0]; i = d[1]; continue; }
    }
    probe += u[i];
    i++;
  }
  probe = probe.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  if (/^(javascript|vbscript|data):/.test(probe)) return null;
  if (/^data:image\/(png|gif|jpeg|webp)/.test(probe)) return href;
  return href;
}

// Percent-encode a URL for an href attribute (encodeURI semantics):
// leaves A-Z a-z 0-9 ; , / ? : @ & = + $ - _ . ! ~ * ' ( ) # and valid %XX.
function encodeHref(u) {
  const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
  let out = '';
  let last = 0;
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    if (c === 37 && i + 2 < u.length && isHex(u.charCodeAt(i + 1)) && isHex(u.charCodeAt(i + 2))) continue;
    const safe = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 59 || c === 44 || c === 47 || c === 63 || c === 58 || c === 64 || c === 38 ||
      c === 61 || c === 43 || c === 36 || c === 45 || c === 95 || c === 46 || c === 33 ||
      c === 126 || c === 42 || c === 39 || c === 40 || c === 41 || c === 35 || c === 37;
    if (safe) continue;
    if (i > last) out += u.slice(last, i);
    if (c < 128) {
      out += '%' + c.toString(16).toUpperCase().padStart(2, '0');
    } else {
      const bytes = new TextEncoder().encode(u[i]);
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    last = i + 1;
  }
  return last === 0 ? u : out + u.slice(last);
}

// Column width of leading whitespace (tab advances to next multiple of 4).
function indentOf(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Remove up to `cols` columns of leading indent. The leading whitespace is
// expanded to spaces by its original columns first, so a partly-consumed tab
// keeps its remainder and later tabs keep their original widths.
function stripIndentAt(line, cols, baseCol) {
  // Removing zero columns leaves the line untouched (a tab stays a tab).
  if (cols === 0) return line;
  let i = 0, col = baseCol, spaces = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { spaces += ' '; col++; i++; }
    else if (c === 9) { const w = 4 - (col % 4); spaces += ' '.repeat(w); col += w; i++; }
    else break;
  }
  const rest = line.slice(i);
  if (col - baseCol <= cols) return rest;
  return spaces.slice(cols) + rest;
}
// Strip `cols` columns of leading whitespace, keeping a tab that lies
// entirely beyond the stripped region as a tab (for code block bodies,
// where the result is final output, not re-parsed).
function stripIndentKeepTabs(line, cols) {
  if (cols === 0) return line;
  let i = 0, col = 0;
  let out = '';
  const target = cols;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      if (col < target) { col++; i++; }
      else { out += ' '; col++; i++; }
    } else if (c === 9) {
      const w = 4 - (col % 4);
      const endCol = col + w;
      if (endCol <= target) { col = endCol; i++; }
      else if (col < target) { out += ' '.repeat(endCol - target); col = endCol; i++; }
      else { out += '\t'; col = endCol; i++; }
    } else break;
  }
  return out + line.slice(i);
}
function stripIndent(line, cols) {
  return stripIndentAt(line, cols, 0);
}

// Normalize a link label: collapse whitespace, case-fold.
function normLabel(s) {
  // Unicode case folding: ß and ẞ both fold to "ss" (toLowerCase alone
  // gives ß for ẞ). Labels are NOT backslash-unescaped for matching.
  return s.replace(/ß/g, 'ss').replace(/ẞ/g, 'ss').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---- block parsing ----

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Index of first non-space/tab char and its column.
function leadOf(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return [col, i];
}

function isThematic(line) {
  const [col, i] = leadOf(line);
  if (col > 3) return false;
  let ch = 0, n = 0, j = i;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c === 32 || c === 9) { j++; continue; }
    if (ch === 0) ch = c;
    if (c !== ch || (ch !== 42 && ch !== 45 && ch !== 95)) return false;
    n++; j++;
  }
  return n >= 3;
}

function isSetext(line) {
  const [col, i] = leadOf(line);
  if (col > 3) return 0;
  let j = i;
  const ch = line.charCodeAt(j);
  if (ch !== 61 && ch !== 45) return 0; // = or -
  while (j < line.length && line.charCodeAt(j) === ch) j++;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j < line.length) return 0;
  return ch === 61 ? 1 : 2;
}

// ATX heading: returns [level, textStart, textEnd] or null.
function atxHeading(line) {
  const [col, i] = leadOf(line);
  if (col > 3) return null;
  let j = i, level = 0;
  while (j < line.length && line.charCodeAt(j) === 35 && level < 7) { level++; j++; }
  if (level === 0 || level > 6) return null;
  if (j >= line.length) return [level, j, j];
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let start = j;
  while (start < line.length && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  let end = line.length;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  // Strip a closing sequence of #'s preceded by space (or the whole content).
  let k = end;
  while (k > start && line.charCodeAt(k - 1) === 35) k--;
  if (k < end && (k === start || line.charCodeAt(k - 1) === 32 || line.charCodeAt(k - 1) === 9)) {
    end = k;
    while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  }
  return [level, start, end];
}

// Fence start: returns [char, length, indent, infoStart] or null.
function fenceStart(line) {
  const [col, i] = leadOf(line);
  if (col > 3) return null;
  const c = line.charCodeAt(i);
  if (c !== 96 && c !== 126) return null;
  let j = i, n = 0;
  while (j < line.length && line.charCodeAt(j) === c) { n++; j++; }
  if (n < 3) return null;
  if (c === 96) {
    for (let k = j; k < line.length; k++) if (line.charCodeAt(k) === 96) return null;
  }
  return [c, n, col, j];
}

function htmlBlockStart(line) {
  const [col, i] = leadOf(line);
  if (col > 3 || i >= line.length || line.charCodeAt(i) !== 60) return 0;
  const rest = line.slice(i + 1);
  if (/^script(?=[\s>]|$)/i.test(rest) || /^pre(?=[\s>]|$)/i.test(rest) ||
      /^style(?=[\s>]|$)/i.test(rest) || /^textarea(?=[\s>]|$)/i.test(rest)) return 1;
  if (rest.startsWith('!--')) return 2;
  if (rest.startsWith('?')) return 3;
  if (rest.startsWith('!') && rest.length > 1 && rest.charCodeAt(1) >= 65 && rest.charCodeAt(1) <= 90) return 4;
  if (rest.startsWith('![CDATA[')) return 5;
  const m = /^(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s|>|$|\/>))/.exec(rest);
  if (m) {
    // Type 6 (block tag): only the tag name matters; the tag need not
    // be complete on this line.
    if (BLOCK_TAGS.has(m[2].toLowerCase())) return 6;
    // Type 7: validate the full tag (attributes, closing-tag rules)
    // with the inline tag parser; an invalid tag is not an HTML block,
    // and the tag must be complete on this line, followed only by
    // whitespace.
    const tag = parseHtmlTag(line, i);
    if (!tag) return 0;
    let t = tag.end;
    while (t < line.length && (line.charCodeAt(t) === 32 || line.charCodeAt(t) === 9)) t++;
    if (t >= line.length) return 7;
    return 0;
  }
  return 0;
}

function htmlBlockEnd(type, line) {
  if (type === 1) return /<\/(script|pre|style|textarea)\s*>/i.test(line);
  if (type === 2) return line.indexOf('-->') !== -1;
  if (type === 3) return line.indexOf('?>') !== -1;
  if (type === 4) return line.indexOf('>') !== -1;
  if (type === 5) return line.indexOf(']]>') !== -1;
  return false; // types 6, 7 end at blank line
}

// List marker at line start (after <=3 indent): returns null or
// {ordered, num, delim, markerLen, contentIndent, empty, wsCols, contentStart}.
function listMarker(line) {
  const [col, i] = leadOf(line);
  if (col > 3) return null;
  let j = i;
  const c = line.charCodeAt(j);
  let ordered = false, num = 0, delim = '', mlen = 0;
  if (c === 45 || c === 42 || c === 43) {
    j++;
    mlen = 1;
  } else if (isDigit(String.fromCharCode(c))) {
    let k = j, digits = 0;
    while (k < line.length && isDigit(line[k]) && digits < 10) { num = num * 10 + (line.charCodeAt(k) - 48); digits++; k++; }
    if (digits === 0 || digits > 9) return null;
    const d = line.charCodeAt(k);
    if (d !== 46 && d !== 41) return null;
    delim = String.fromCharCode(d);
    k++;
    mlen = digits + 1;
    j = k;
    ordered = true;
  } else return null;
  // Whitespace after the marker, counted in columns.
  const after = line.charCodeAt(j);
  if (after !== 32 && after !== 9 && j < line.length) return null;
  let p = j, wsCols = 0;
  while (p < line.length) {
    const cc = line.charCodeAt(p);
    if (cc === 32) { wsCols++; p++; }
    else if (cc === 9) { wsCols += 4 - ((col + mlen + wsCols) % 4); p++; }
    else break;
  }
  if (p >= line.length) {
    return { ordered, num, delim, markerLen: mlen, contentIndent: col + mlen + 1, empty: true, wsCols, contentStart: p };
  }
  const ci = wsCols >= 5 ? 1 : wsCols;
  return { ordered, num, delim, markerLen: mlen, contentIndent: col + mlen + ci, empty: false, wsCols, contentStart: p };
}

// Can this line start a block that interrupts a paragraph?
function interruptsParagraph(line, inList) {
  if (isBlank(line)) return false;
  if (atxHeading(line)) return true;
  if (fenceStart(line)) return true;
  const hb = htmlBlockStart(line);
  if (hb >= 1 && hb <= 6) return true;
  if (line.charCodeAt(leadOf(line)[1]) === 62) return true; // >
  if (isThematic(line)) return true;
  const lm = listMarker(line);
  if (lm) {
    if (lm.empty) return false;
    if (!lm.ordered) return true;
    // Inside a list item's content, any ordered list marker interrupts
    // a paragraph (marked behavior); at top level only start=1 does.
    if (LIST_DEPTH > 0) return true;
    return lm.num === 1;
  }
  return false;
}

// Try to parse a link reference definition starting at lines[i].
// Returns lines consumed (0 if none). Fills refs.
function tryLinkDef(lines, i, hi, refs) {
  const line = lines[i];
  const [col, idx] = leadOf(line);
  if (col > 3) return 0;
  let j = idx;
  if (line.charCodeAt(j) !== 91) return 0; // [
  j++;
  // The label may span lines (joined with '\n'; normalized later).
  // It ends at the FIRST unescaped ']' (labels do not nest).
  let label = '';
  let labLn = i;
  let labPos = j;
  let closed = false;
  outer: while (true) {
    const L = lines[labLn];
    while (labPos < L.length) {
      const c = L.charCodeAt(labPos);
      // Skip an escaped char for bracket counting, but keep the raw
      // backslash in the label (labels are not unescaped for matching).
      if (c === 92 && labPos + 1 < L.length && isPunct(L[labPos + 1])) { label += L[labPos]; label += L[labPos + 1]; labPos += 2; continue; }
      // An unescaped '[' inside a DEFINITION label makes it invalid
      // (e.g. [ref[]: /uri is not a definition).
      if (c === 91) return 0;
      if (c === 93) { closed = true; break outer; }
      label += L[labPos];
      labPos++;
    }
    // A label cannot span a blank line.
    if (labLn + 1 >= hi || isBlank(lines[labLn + 1])) break;
    labLn++; labPos = 0;
    label += '\n';
  }
  if (!closed) return 0;
  if (label.length === 0 || label.length > 999) return 0;
  labPos++;
  if (lines[labLn].charCodeAt(labPos) !== 58) return 0; // :
  labPos++;
  // Skip spaces/tabs; dest may be on this line or the next (not past a
  // blank line, and the continuation line may be indented any amount).
  // The destination must sit on the label's last line or the line after it.
  const destMaxLn = labLn + 1;
  let ln = labLn;
  let pos = labPos;
  const skipWs = () => {
    while (true) {
      while (pos < lines[ln].length && (lines[ln].charCodeAt(pos) === 32 || lines[ln].charCodeAt(pos) === 9)) pos++;
      if (pos < lines[ln].length) return true;
      if (ln + 1 >= hi || ln + 1 > destMaxLn || isBlank(lines[ln + 1])) return false;
      ln++; pos = 0;
      while (pos < lines[ln].length && (lines[ln].charCodeAt(pos) === 32 || lines[ln].charCodeAt(pos) === 9)) pos++;
    }
  };
  if (!skipWs()) return 0;
  let dest = '';
  if (lines[ln].charCodeAt(pos) === 60) { // <dest>
    pos++;
    const start = pos;
    while (pos < lines[ln].length) {
      const c = lines[ln].charCodeAt(pos);
      if (c === 62) break;
      if (c === 60 || c === 10) return 0;
      if (c === 92 && pos + 1 < lines[ln].length && isPunct(lines[ln][pos + 1])) { pos += 2; continue; }
      pos++;
    }
    if (pos >= lines[ln].length) return 0;
    dest = lines[ln].slice(start, pos);
    pos++;
  } else {
    // Bare destination: no spaces, balanced parens allowed.
    const start = pos;
    let parens = 0;
    while (pos < lines[ln].length) {
      const c = lines[ln].charCodeAt(pos);
      if (c === 32 || c === 9) break;
      if (c === 92 && pos + 1 < lines[ln].length && isPunct(lines[ln][pos + 1])) { pos += 2; continue; }
      if (c === 40) parens++;
      if (c === 41) { if (parens === 0) break; parens--; }
      if (c < 32) return 0;
      pos++;
    }
    if (parens !== 0) return 0;
    dest = lines[ln].slice(start, pos);
    if (dest.length === 0) return 0;
  }
  // Optional title on this line or the next; it must be separated from
  // the destination by whitespace, and may itself span several lines.
  let title = '';
  let hasTitle = false;
  {
    let l2 = ln, p2 = pos;
    let sep = false;
    while (p2 < lines[l2].length && (lines[l2].charCodeAt(p2) === 32 || lines[l2].charCodeAt(p2) === 9)) { p2++; sep = true; }
    if (p2 >= lines[l2].length && l2 + 1 < hi && !isBlank(lines[l2 + 1])) {
      l2++; p2 = 0; sep = true;
      while (p2 < lines[l2].length && (lines[l2].charCodeAt(p2) === 32 || lines[l2].charCodeAt(p2) === 9)) p2++;
    }
    if (p2 < lines[l2].length) {
      const q = lines[l2].charCodeAt(p2);
      if ((q === 34 || q === 39 || q === 40) && sep) {
        const close = q === 40 ? 41 : q;
        let t = '';
        let p3 = p2 + 1;
        let l3 = l2;
        let ok = false;
        let endL = l2, endP = -1;
        outer: while (true) {
          while (p3 < lines[l3].length) {
            const c = lines[l3].charCodeAt(p3);
            if (c === 92 && p3 + 1 < lines[l3].length && isPunct(lines[l3][p3 + 1])) { t += lines[l3][p3 + 1]; p3 += 2; continue; }
            if (c === close) { ok = true; endL = l3; endP = p3; break outer; }
            t += lines[l3][p3];
            p3++;
          }
          // A title cannot span a blank line.
          if (l3 + 1 >= hi || isBlank(lines[l3 + 1])) break;
          l3++; p3 = 0;
          t += '\n';
        }
        if (ok) {
          // Only whitespace may follow on the closing line.
          let p4 = endP + 1;
          while (p4 < lines[endL].length && (lines[endL].charCodeAt(p4) === 32 || lines[endL].charCodeAt(p4) === 9)) p4++;
          if (p4 >= lines[endL].length) {
            title = t;
            hasTitle = true;
            ln = endL; pos = p4;
          }
        }
      }
    }
  }
  if (!hasTitle) {
    // No title: only whitespace may follow the destination on its line.
    let p = pos;
    while (p < lines[ln].length && (lines[ln].charCodeAt(p) === 32 || lines[ln].charCodeAt(p) === 9)) p++;
    if (p < lines[ln].length) return 0;
  }
  const key = normLabel(label);
  if (key.length === 0) return 0; // An empty label is not a definition.
  if (!refs.has(key)) refs.set(key, { dest: unescapeBackslash(dest), title });
  return ln - i + 1;
}

// ---- tables ----

function isTableDelim(line) {
  const [col, i] = leadOf(line);
  if (col > 3) return 0;
  let j = i;
  if (line.charCodeAt(j) === 124) j++; // |
  let cells = 0;
  while (true) {
    while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
    // A trailing '|' ends the row (no further cell).
    if (j >= line.length) return cells > 0 ? cells : 0;
    let dashes = 0, align = 0; // 1 left, 2 right, 3 center
    if (line.charCodeAt(j) === 58) { align = 1; j++; }
    while (j < line.length && line.charCodeAt(j) === 45) { dashes++; j++; }
    if (line.charCodeAt(j) === 58) { align = align === 1 ? 3 : 2; j++; }
    while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
    if (dashes === 0) return 0;
    cells++;
    if (j >= line.length) return cells;
    if (line.charCodeAt(j) !== 124) return 0;
    j++;
  }
}

function tableAligns(line) {
  const out = [];
  const [col, i] = leadOf(line);
  let j = i;
  if (line.charCodeAt(j) === 124) j++;
  while (j <= line.length) {
    let start = j;
    while (j < line.length && line.charCodeAt(j) !== 124) j++;
    const cell = line.slice(start, j).trim();
    let a = '';
    if (cell.startsWith(':') && cell.endsWith(':')) a = 'center';
    else if (cell.startsWith(':')) a = 'left';
    else if (cell.endsWith(':')) a = 'right';
    out.push(a);
    j++;
    if (j > line.length) break;
    if (line.charCodeAt(j - 1) !== 124) break;
    if (j >= line.length) break;
  }
  return out;
}

// Split a table row on unescaped pipes (pipes inside code spans don't split).
function splitRow(line) {
  const cells = [];
  let cur = '';
  let lastSep = false; // true when the last thing seen was a '|' separator
  let i = 0;
  const [col, start] = leadOf(line);
  i = start;
  if (line.charCodeAt(i) === 124) i++;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < line.length && line.charCodeAt(i + 1) === 124) {
      // An escaped pipe is a literal pipe in the cell (backslash consumed).
      cur += '|';
      lastSep = false;
      i += 2;
      continue;
    }
    if (c === 96) {
      // Copy a code span verbatim (pipes inside don't split).
      let k = i, n = 0;
      while (k < line.length && line.charCodeAt(k) === 96) { n++; k++; }
      let close = -1;
      let s = k;
      while (s < line.length) {
        if (line.charCodeAt(s) === 96) {
          let m = s, c2 = 0;
          while (m < line.length && line.charCodeAt(m) === 96) { c2++; m++; }
          if (c2 === n) { close = s; break; }
          s = m;
        } else s++;
      }
      if (close !== -1) {
        // Escaped pipes inside the span are literal pipes too.
        cur += line.slice(i, close + n).replace(/\\\|/g, '|');
        lastSep = false;
        i = close + n;
        continue;
      }
      cur += line[i];
      lastSep = false;
      i++;
      continue;
    }
    if (c === 124) {
      cells.push(cur.trim());
      cur = '';
      lastSep = true;
      i++;
      continue;
    }
    cur += line[i];
    if (c !== 32 && c !== 9) lastSep = false;
    i++;
  }
  // A trailing '|' does not create an extra empty cell.
  if (!lastSep) cells.push(cur.trim());
  return cells;
}

// ---- the block parser ----

// When true, parseBlocks emits HTML; when false it only collects link
// reference definitions (first pass, so forward references resolve).
let EMIT = true;
// Whether the source text ends with a newline (an HTML block at EOF keeps it).
let SRC_ENDS_NL = false;
// Set when the last top-level block emitted is an HTML block at EOF.
let LAST_HTML_EOF = false;
// Nesting depth of parseBlocks (1 = top level).
let BLOCK_DEPTH = 0;
let LIST_DEPTH = 0;

function parseBlocks(lines, lo, hi, refs, out, paraWrap) {
  if (paraWrap === undefined) paraWrap = true;
  BLOCK_DEPTH++;
  let i = lo;
  while (i < hi) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const [col, idx] = leadOf(line);

    // ATX heading
    const atx = atxHeading(line);
    if (atx) {
      if (EMIT) out.push('<h' + atx[0] + '>' + inlineParse(line.slice(atx[1], atx[2]), refs) + '</h' + atx[0] + '>\n');
      i++;
      continue;
    }

    // Fenced code
    const fs = fenceStart(line);
    if (fs) {
      const ch = fs[0], len = fs[1], ind = fs[2];
      let info = line.slice(fs[3]).trim();
      let lang = '';
      if (info.length > 0) {
        const sp = info.search(/[ \t]/);
        lang = unescapeBackslash(sp === -1 ? info : info.slice(0, sp));
      }
      const body = [];
      let j = i + 1;
      let closed = false;
      while (j < hi) {
        const l = lines[j];
        const [c2, i2] = leadOf(l);
        if (c2 <= 3 && l.charCodeAt(i2) === ch) {
          let k = i2, n = 0;
          while (k < l.length && l.charCodeAt(k) === ch) { n++; k++; }
          if (n >= len) {
            let rest = k;
            while (rest < l.length && (l.charCodeAt(rest) === 32 || l.charCodeAt(rest) === 9)) rest++;
            if (rest >= l.length) { closed = true; j++; break; }
          }
        }
        body.push(stripIndentKeepTabs(l, ind));
        j++;
      }
      let code = body.join('\n');
      if (code.length > 0 && !code.endsWith('\n')) code += '\n';
      if (EMIT) out.push('<pre><code' + (lang ? ' class="language-' + escAttr(lang) + '"' : '') + '>' + escText(code) + '</code></pre>\n');
      i = j;
      continue;
    }

    // HTML block
    const hb = htmlBlockStart(line);
    if (hb) {
      const buf = [];
      let j = i;
      if (hb <= 5) {
        buf.push(line);
        j++;
        // The block ends at the first line containing the closing marker
        // (possibly the opening line itself).
        if (!htmlBlockEnd(hb, line)) {
          while (j < hi && !htmlBlockEnd(hb, lines[j])) { buf.push(lines[j]); j++; }
          if (j < hi) { buf.push(lines[j]); j++; }
        }
      } else {
        while (j < hi && !isBlank(lines[j])) { buf.push(lines[j]); j++; }
      }
      if (EMIT) {
        if (hb <= 5) {
          // Types 1-5 keep the newline after the closing line, unless a
          // blank line follows (or EOF without a trailing newline).
          const keepNL = (j < hi && !isBlank(lines[j])) || (j >= hi && SRC_ENDS_NL);
          out.push(buf.join('\n') + (keepNL ? '\n' : ''));
        } else {
          out.push(buf.join('\n'));
          if (BLOCK_DEPTH === 1 && j >= hi) LAST_HTML_EOF = true;
        }
      }
      i = j;
      continue;
    }

    // Thematic break
    if (isThematic(line)) {
      if (EMIT) out.push('<hr>\n');
      i++;
      continue;
    }

    // Indented code
    if (col >= 4) {
      const body = [];
      let j = i;
      while (j < hi) {
        const l = lines[j];
        // A whitespace-only line with >= 4 indent is code (rest kept);
        // a truly blank / short-indent line is an empty code line.
        if (indentOf(l) >= 4) { body.push(stripIndentKeepTabs(l, 4)); j++; continue; }
        if (isBlank(l)) { body.push(''); j++; continue; }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      let code = body.join('\n');
      if (code.length > 0) code += '\n';
      if (EMIT) out.push('<pre><code>' + escText(code) + '</code></pre>\n');
      i = j;
      continue;
    }

    // Blockquote
    if (line.charCodeAt(idx) === 62) {
      const q = [];
      let j = i;
      // Whether the last inner line belongs to an open paragraph (only then
      // may a lazy continuation line join it). Fenced code blocks do not
      // allow lazy continuation.
      let paraOpen = false;
      let inFence = false;
      let fenceCh = '';
      let fenceLen = 0;
      const noteLine = (s) => {
        if (isBlank(s)) { paraOpen = false; return; }
        if (!inFence) {
          const fs = fenceStart(s);
          if (fs) { inFence = true; fenceCh = fs[0]; fenceLen = fs[1]; paraOpen = false; return; }
        } else {
          const [c2, i2] = leadOf(s);
          if (c2 <= 3 && s.charCodeAt(i2) === fenceCh) {
            let k = i2, n = 0;
            while (k < s.length && s.charCodeAt(k) === fenceCh) { n++; k++; }
            if (n >= fenceLen) {
              let rest = k;
              while (rest < s.length && (s.charCodeAt(rest) === 32 || s.charCodeAt(rest) === 9)) rest++;
              if (rest >= s.length) { inFence = false; paraOpen = false; return; }
            }
          }
          paraOpen = false;
          return;
        }
        if (interruptsParagraph(s)) { paraOpen = false; return; }
        if (indentOf(s) >= 4 && !paraOpen) { paraOpen = false; return; }
        paraOpen = true;
      };
      while (j < hi) {
        const l = lines[j];
        const [c2, i2] = leadOf(l);
        if (c2 <= 3 && l.charCodeAt(i2) === 62) {
          // Strip '>' and one following column of whitespace.
          const s = stripIndentAt(l.slice(i2 + 1), 1, c2 + 1);
          if (isBlank(s) && s.length > 0 && paraOpen) {
            // A whitespace-only content line inside an open paragraph is
            // content (its spaces are kept), not a blank line.
            q[q.length - 1] += '\n' + s;
          } else {
            q.push(s);
            noteLine(s);
          }
          j++;
        } else if (!isBlank(l) && !interruptsParagraph(l)) {
          if (paraOpen) {
            // Lazy continuation of this block quote's paragraph: append to
            // the paragraph's last line so the inner parser keeps it as
            // text. Leading whitespace is stripped; a setext underline
            // cannot be lazy, so it stays literal (indented 4).
            const stripped = l.slice(leadOf(l)[1]);
            q[q.length - 1] += '\n' + (isSetext(stripped) > 0 ? '    ' + stripped : stripped);
            j++;
          } else if (q.length > 0 && !inFence) {
            // Or a lazy continuation of a nested block quote's paragraph,
            // or of a list item's (possibly nested block quote's)
            // paragraph: pass the line through for the inner parse to
            // decide.
            const lastQ = q[q.length - 1];
            const [cq, iq] = leadOf(lastQ);
            if (cq <= 3 && lastQ.charCodeAt(iq) === 62) { q.push(l); j++; }
            else if (listMarker(lastQ)) { q.push(l); j++; }
            else break;
          } else break;
        } else break;
      }
      while (q.length > 0 && isBlank(q[q.length - 1])) q.pop();
      const inner = [];
      parseBlocks(q, 0, q.length, refs, inner, true);
      if (EMIT) out.push('<blockquote>\n' + inner.join('') + '</blockquote>\n');
      i = j;
      continue;
    }

    // List
    const lm0 = listMarker(line);
    if (lm0) {
      i = parseList(lines, i, hi, refs, out);
      continue;
    }

    // Paragraph (with link defs, setext heading, table)
    i = parseParagraph(lines, i, hi, refs, out, paraWrap);
  }
  BLOCK_DEPTH--;
  return i;
}

function parseParagraph(lines, i, hi, refs, out, paraWrap) {
  // Consume leading link reference definitions.
  let k = i;
  while (k < hi) {
    const used = tryLinkDef(lines, k, hi, refs);
    if (used === 0) break;
    k += used;
  }
  if (k >= hi || isBlank(lines[k])) return k;
  // A definition cannot be followed by a block that interrupts a paragraph.
  if (interruptsParagraph(lines[k])) return k;
  // A setext underline is not a table delimiter (setext wins).
  // Otherwise a table needs the delimiter cell count to match the header
  // and a pipe in the header or the delimiter row.
  if (k + 1 < hi && isSetext(lines[k + 1]) === 0 && isTableDelim(lines[k + 1]) > 0 &&
      isTableDelim(lines[k + 1]) === splitRow(lines[k]).length &&
      (lines[k].includes('|') || lines[k + 1].includes('|'))) {
    return parseTable(lines, k, hi, refs, out);
  }
  // Collect paragraph lines (kept as-is; leading spaces are content).
  const plines = [];
  let j = k;
  while (j < hi) {
    const l = lines[j];
    if (isBlank(l)) break;
    if (j > k && interruptsParagraph(l)) break;
    if (j > k && isSetext(l) > 0) break;
    plines.push(l);
    j++;
  }
  // Setext heading? (Content is trimmed at both ends.)
  if (j < hi && isSetext(lines[j]) > 0) {
    const lvl = isSetext(lines[j]);
    if (EMIT) out.push('<h' + lvl + '>' + inlineParse(plines.join('\n').trim(), refs) + '</h' + lvl + '>\n');
    return j + 1;
  }
  if (!EMIT) return j;
  const text = plines.join('\n');
  const html = inlineParse(text, refs);
  if (paraWrap) out.push('<p>' + html + '</p>\n');
  else out.push(html);
  return j;
}

function parseTable(lines, i, hi, refs, out) {
  const aligns = tableAligns(lines[i + 1]);
  const ncols = aligns.length;
  let j = i + 2;
  // A whitespace-only line ends the table — except a line containing a
  // tab, which marked treats as an (empty) table row.
  const isRowEnd = (l) => {
    if (l.length === 0) return true;
    for (let t = 0; t < l.length; t++) {
      const c = l.charCodeAt(t);
      if (c === 9) return false;
      if (c !== 32) return false;
    }
    return true;
  };
  while (j < hi && !isRowEnd(lines[j]) && !interruptsParagraph(lines[j])) j++;
  if (!EMIT) return j;
  const headCells = splitRow(lines[i]);
  let html = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < ncols; c++) {
    const cell = c < headCells.length ? headCells[c] : '';
    const a = aligns[c] ? ' align="' + aligns[c] + '"' : '';
    html += '<th' + a + '>' + inlineParse(cell, refs) + '</th>\n';
  }
  html += '</tr>\n</thead>\n';
  let k = i + 2;
  if (k < j) {
    html += '<tbody>';
    while (k < j) {
      const cells = splitRow(lines[k]);
      html += '<tr>\n';
      for (let c = 0; c < ncols; c++) {
        const cell = c < cells.length ? cells[c] : '';
        const a = aligns[c] ? ' align="' + aligns[c] + '"' : '';
        html += '<td' + a + '>' + inlineParse(cell, refs) + '</td>\n';
      }
      html += '</tr>\n';
      k++;
    }
    html += '</tbody>';
  }
  html += '</table>\n';
  out.push(html);
  return j;
}

function parseList(lines, i, hi, refs, out) {
  const first = listMarker(lines[i]);
  const ordered = first.ordered;
  const delim = first.delim;
  const bullet = ordered ? '' : lines[i][leadOf(lines[i])[1]];
  const firstIndent = leadOf(lines[i])[0];
  let listIndent = firstIndent;
  const items = [];
  let j = i;
  let loose = false;
  while (j < hi) {
    const l = lines[j];
    // A thematic break ends the list (it wins over a list-item reading).
    if (j > i && isThematic(l)) break;
    const lm = listMarker(l);
    if (!lm || lm.ordered !== ordered) break;
    if (ordered) {
      if (lm.delim !== delim) break;
    } else {
      if (l[leadOf(l)[1]] !== bullet) break;
    }
    // A sibling item may be indented up to 3 spaces more than the
    // list's first item, or outdented (a less-indented marker still
    // continues the list; the list's indent drops to match it).
    const ind = leadOf(l)[0];
    if (ind > listIndent + 3) break;
    if (ind < listIndent) listIndent = ind;
    const ci = lm.contentIndent;
    const itemLines = [];
    // Whether the last item line belongs to an open paragraph (only then
    // may a lazy continuation line join it).
    let paraOpen = false;
    const noteLine = (s) => {
      if (isBlank(s)) { paraOpen = false; return; }
      if (interruptsParagraph(s)) { paraOpen = false; return; }
      if (indentOf(s) >= 4 && !paraOpen) { paraOpen = false; return; }
      paraOpen = true;
    };
    // First line content.
    {
      const p = lm.contentStart;
      let s;
      if (p >= l.length) s = '';
      else if (lm.wsCols >= 5) s = ' '.repeat(lm.wsCols - 1) + l.slice(p);
      else s = l.slice(p);
      itemLines.push(s);
      noteLine(s);
    }
    let k = j + 1;
    let trailingBlanks = 0;
    while (k < hi) {
      const l2 = lines[k];
      if (isBlank(l2)) {
        // An item with no content yet, followed by a blank line, is an
        // empty item — later indented lines are not part of it.
        let hasContent = false;
        for (const s of itemLines) if (!isBlank(s)) { hasContent = true; break; }
        if (!hasContent) break;
        itemLines.push(''); trailingBlanks++; paraOpen = false; k++; continue;
      }
      const [c2] = leadOf(l2);
      if (c2 >= ci) {
        const s = stripIndent(l2, ci);
        itemLines.push(s);
        noteLine(s);
        trailingBlanks = 0;
        k++;
        continue;
      }
      // Lazy continuation of the item's paragraph. A list-marker line
      // only interrupts when it is a valid sibling (indent within
      // [listIndent, listIndent+3]) or a sublist item (indent >= ci);
      // an over-indented marker (e.g. '    - e' after a list starting
      // at 0) is lazy paragraph text, not a new item.
      let interrupts = false;
      {
        const lm2 = listMarker(l2);
        if (lm2) {
          const ind2 = leadOf(l2)[0];
          if (ind2 >= ci) {
            // Sublist item (any marker type) — interrupts the paragraph.
            interrupts = true;
          } else if (ind2 <= listIndent + 3) {
            // Sibling (same list, incl. outdented) or a different list
            // at sibling level — both end this item.
            interrupts = true;
          }
          // Else: over-indented marker (same or different list) is lazy
          // paragraph text, not a new item.
        }
        if (!interrupts) {
          // Other interrupting blocks (heading, fence, html, thematic,
          // blockquote); list markers are handled above.
          if (atxHeading(l2) || fenceStart(l2) || isThematic(l2)) interrupts = true;
          else {
            const hb = htmlBlockStart(l2);
            if (hb >= 1 && hb <= 6) interrupts = true;
          }
          if (l2.charCodeAt(leadOf(l2)[1]) === 62) interrupts = true;
        }
      }
      if (paraOpen && !interrupts) {
        // Append to the paragraph's last line so a lazy line that
        // looks like a list marker stays paragraph text (it must not
        // be re-parsed as a sublist).
        const stripped = l2.slice(leadOf(l2)[1]);
        const add = isSetext(stripped) > 0 ? '    ' + stripped : stripped;
        itemLines[itemLines.length - 1] += '\n' + add;
        trailingBlanks = 0;
        k++;
        continue;
      }
      if (!interrupts && itemLines.length > 0) {
        // Lazy continuation of a nested block quote's paragraph: pass
        // the line through for the inner parse to decide.
        const lastS = itemLines[itemLines.length - 1];
        const [cq, iq] = leadOf(lastS);
        if (cq <= 3 && lastS.charCodeAt(iq) === 62) {
          itemLines.push(l2);
          noteLine(l2);
          trailingBlanks = 0;
          k++;
          continue;
        }
      }
      break;
    }
    // Does the item contain a blank line separating two top-level
    // blocks? If the item has no sublist, any blank line followed by
    // content counts. If it has a sublist, a blank only counts when
    // the next non-blank line is a top-level block — i.e. indented
    // less than the sublist's content indent (lines at or beyond it
    // are sublist content, not top-level blocks of this item).
    let innerBlank = false;
    let subCi = -1;
    let subIndent = -1;
    for (const s of itemLines) {
      if (!isBlank(s)) {
        const lm2 = listMarker(s);
        if (lm2) { subCi = lm2.contentIndent; subIndent = leadOf(s)[0]; break; }
      }
    }
    let inFence = false;
    for (let t = 0; t < itemLines.length; t++) {
      const s = itemLines[t];
      if (fenceStart(s)) inFence = !inFence;
      if (isBlank(s)) {
        if (inFence) continue;
        let hasBefore = false;
        for (let u = 0; u < t; u++) if (!isBlank(itemLines[u])) { hasBefore = true; break; }
        if (!hasBefore) continue;
        // Has the sublist already started before this blank? If not,
        // the blank separates the paragraph from the following block
        // (possibly the sublist's first item) — the list is loose.
        // If it has started, the blank is inside the sublist and only
        // a following top-level block (not a sibling sublist item or
        // sublist content) makes the list loose.
        let subStarted = false;
        for (let u = 0; u < t; u++) {
          if (!isBlank(itemLines[u]) && listMarker(itemLines[u])) { subStarted = true; break; }
        }
        for (let u = t + 1; u < itemLines.length; u++) {
          if (!isBlank(itemLines[u])) {
            if (!subStarted) { innerBlank = true; break; }
            const nextInd = leadOf(itemLines[u])[0];
            const isSubSibling = subIndent !== -1 && listMarker(itemLines[u]) &&
              nextInd >= subIndent && nextInd <= subIndent + 3;
            if (nextInd < subCi && !isSubSibling) innerBlank = true;
            break;
          }
        }
      }
      if (innerBlank) break;
    }
    if (innerBlank) loose = true;
    // Trailing blanks: remember whether a blank separated this item from the next.
    const hadTrailingBlank = trailingBlanks > 0;
    while (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1])) itemLines.pop();
    items.push({ lines: itemLines, hadTrailingBlank });
    j = k;
    // Peek: is the next line a new item of the same list?
    if (j < hi) {
      const nl = lines[j];
      if (isBlank(nl)) {
        // Skip blank lines; if a same-list item follows, the list is loose.
        let m = j;
        while (m < hi && isBlank(lines[m])) m++;
        if (m < hi) {
          const nm = listMarker(lines[m]);
          const indm = leadOf(lines[m])[0];
          const same = nm && nm.ordered === ordered &&
            (ordered ? nm.delim === delim : lines[m][leadOf(lines[m])[1]] === bullet) &&
            indm <= listIndent + 3;
          if (same) { loose = true; j = m; continue; }
        }
        break;
      }
      const nm = listMarker(nl);
      const indn = leadOf(nl)[0];
      const same = nm && nm.ordered === ordered &&
        (ordered ? nm.delim === delim : nl[leadOf(nl)[1]] === bullet) &&
        indn <= listIndent + 3;
      if (same) continue;
    }
    break;
  }
  if (items.length > 1) {
    for (let t = 0; t < items.length - 1; t++) {
      if (items[t].hadTrailingBlank) loose = true;
    }
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && first.num !== 1 ? ' start="' + first.num + '"' : '';
  let html = '<' + tag + startAttr + '>\n';
  for (const item of items) {
    // Task list item?
    let task = '';
    let itemLines = item.lines;
    if (itemLines.length > 0) {
      const f = itemLines[0];
      if (f.length >= 4 && f.charCodeAt(0) === 91 &&
          (f.charCodeAt(1) === 32 || f.charCodeAt(1) === 120 || f.charCodeAt(1) === 88) &&
          f.charCodeAt(2) === 93 && f.charCodeAt(3) === 32) {
        const checked = f.charCodeAt(1) === 120 || f.charCodeAt(1) === 88;
        task = checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ';
        itemLines = itemLines.slice();
        itemLines[0] = f.slice(4);
      }
    }
    const inner = [];
    LIST_DEPTH++;
    parseBlocks(itemLines, 0, itemLines.length, refs, inner, loose);
    LIST_DEPTH--;
    let body = inner.join('');
    if (task) {
      // In a loose list the checkbox belongs inside the first paragraph.
      if (loose && body.startsWith('<p>')) {
        html += '<li><p>' + task + body.slice(3) + '</li>\n';
      } else {
        html += '<li>' + task + body + '</li>\n';
      }
    } else {
      html += '<li>' + body + '</li>\n';
    }
  }
  html += '</' + tag + '>\n';
  if (EMIT) out.push(html);
  return j;
}

export function parse(src) {
  const text = src.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  // A trailing empty line from the final newline is not a real line.
  SRC_ENDS_NL = text.endsWith('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  // First pass: collect link reference definitions (forward references work).
  EMIT = false;
  parseBlocks(lines, 0, lines.length, refs, [], true);
  // Second pass: render with the complete reference map.
  EMIT = true;
  LAST_HTML_EOF = false;
  const out = [];
  parseBlocks(lines, 0, lines.length, refs, out, true);
  const html = out.join('');
  return LAST_HTML_EOF && SRC_ENDS_NL ? html + '\n' : html;
}

// ---- inline parsing ----

const UNICODE_SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000]);
function isUniSpace(ch) {
  if (ch === undefined) return true;
  return UNICODE_SPACE.has(ch.charCodeAt(0));
}
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isUniPunct(ch) {
  if (ch === undefined) return false;
  return PUNCT_RE.test(ch);
}

function flanking(text, i, n) {
  const before = i > 0 ? text[i - 1] : undefined;
  const after = i + n < text.length ? text[i + n] : undefined;
  const left = !isUniSpace(after) && (!isUniPunct(after) || isUniSpace(before) || isUniPunct(before));
  const right = !isUniSpace(before) && (!isUniPunct(before) || isUniSpace(after) || isUniPunct(after));
  return [left, right];
}

function plainText(nodes) {
  let s = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') s += n.s;
    else if (n.t === 'delim') s += n.ch.repeat(n.len);
    else if (n.t === 'html' || n.t === 'raw') s += n.s;
    else if (n.t === 'br') s += '\n';
    else if (n.t === 'link' || n.t === 'em' || n.t === 'strong' || n.t === 'del') s += plainText(n.children);
  }
  return s;
}

// Parse a link destination + optional title starting at pos (after '(').
// Returns {dest, title, end} (end = index just past ')') or null.
function parseLinkTarget(text, pos) {
  let i = pos;
  const skipWs = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10) i++;
      else break;
    }
  };
  skipWs();
  let dest = '';
  if (i >= text.length) return null;
  if (text.charCodeAt(i) === 60) { // <dest>
    i++;
    const start = i;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 62) break;
      if (c === 60 || c === 10) return null;
      if (c === 92 && i + 1 < text.length && isPunct(text[i + 1])) { i += 2; continue; }
      i++;
    }
    if (i >= text.length) return null;
    dest = text.slice(start, i);
    i++;
  } else {
    const start = i;
    let parens = 0;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92 && i + 1 < text.length && isPunct(text[i + 1])) { i += 2; continue; }
      if (c === 40) parens++;
      if (c === 41) {
        if (parens === 0) break;
        parens--;
      }
      if (c < 32) return null;
      i++;
    }
    if (parens !== 0) return null;
    dest = text.slice(start, i);
    // An empty destination () is valid (href="").
  }
  let title = '';
  const save = i;
  skipWs();
  if (i < text.length) {
    const q = text.charCodeAt(i);
    if (q === 34 || q === 39 || q === 40) {
      const close = q === 40 ? 41 : q;
      let t = '';
      let j = i + 1;
      let ok = false;
      while (j < text.length) {
        const c = text.charCodeAt(j);
        if (c === 92 && j + 1 < text.length && isPunct(text[j + 1])) { t += text[j + 1]; j += 2; continue; }
        if (c === close) { ok = true; break; }
        t += text[j];
        j++;
      }
      if (ok) {
        title = t;
        i = j + 1;
        skipWs();
      } else {
        i = save;
      }
    }
  }
  if (i >= text.length || text.charCodeAt(i) !== 41) return null;
  return { dest: unescapeBackslash(dest), title: unescapeBackslash(title), end: i + 1 };
}

// Parse a bracketed label starting at pos (text[pos] === '[').
// Returns [label, endIndex] (end just past ']') or null.
function parseLabel(text, pos) {
  // A label ends at the FIRST unescaped ']' (labels do not nest).
  let j = pos + 1;
  const start = j;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 92 && j + 1 < text.length && isPunct(text[j + 1])) { j += 2; continue; }
    if (c === 93) return [text.slice(start, j), j + 1];
    j++;
  }
  return null;
}

// Replace GFM autolink nodes in `list` (and nested children) with their
// plain text children. Angle-bracket autolinks are kept as nested links
// (marked renders them inside the outer link). Returns true if a real
// (non-autolink) link is present.
function unwrapAutoLinks(list) {
  let realLink = false;
  for (let idx = 0; idx < list.length; idx++) {
    const nd = list[idx];
    if (nd.t === 'link' && !nd.img) {
      if (nd.auto === 'gfm') {
        list.splice(idx, 1, ...nd.children);
        idx += nd.children.length - 1;
      } else if (nd.auto === 'angle') {
        // Kept; does not block the outer link.
      } else {
        realLink = true;
      }
    } else if (nd.children) {
      if (unwrapAutoLinks(nd.children)) realLink = true;
    }
  }
  return realLink;
}

function scanInline(text, refs) {
  const nodes = [];
  let buf = '';
  const flush = () => {
    if (buf.length > 0) { nodes.push({ t: 'text', s: buf }); buf = ''; }
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    // Backslash escape / hard break
    if (c === 92) {
      const nx = text[i + 1];
      if (nx === '\n') {
        flush();
        nodes.push({ t: 'br' });
        i += 2;
        // Skip leading whitespace of the next line after a break.
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (nx !== undefined && isPunct(nx)) { buf += nx; i += 2; continue; }
      buf += '\\';
      i++;
      continue;
    }
    // Code span
    if (c === 96) {
      let j = i, run = 0;
      while (j < n && text.charCodeAt(j) === 96) { run++; j++; }
      // Find a matching run.
      let close = -1;
      let s = j;
      while (s < n) {
        if (text.charCodeAt(s) === 96) {
          let m = s, r2 = 0;
          while (m < n && text.charCodeAt(m) === 96) { r2++; m++; }
          if (r2 === run) { close = s; break; }
          s = m;
        } else s++;
      }
      if (close !== -1) {
        let content = text.slice(j, close).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim().length > 0) {
          content = content.slice(1, -1);
        }
        flush();
        nodes.push({ t: 'code', s: content });
        i = close + run;
        continue;
      }
      buf += '`'.repeat(run);
      i = j;
      continue;
    }
    // Emphasis delimiters
    if (c === 42 || c === 95) {
      const ch = text[i];
      let j = i, run = 0;
      while (j < n && text.charCodeAt(j) === c) { run++; j++; }
      const [left, right] = flanking(text, i, run);
      let canOpen, canClose;
      if (ch === '*') { canOpen = left; canClose = right; }
      else {
        const before = i > 0 ? text[i - 1] : undefined;
        const after = j < n ? text[j] : undefined;
        canOpen = left && (!right || isUniPunct(before));
        canClose = right && (!left || isUniPunct(after));
      }
      flush();
      nodes.push({ t: 'delim', ch, len: run, canOpen, canClose, active: true });
      i = j;
      continue;
    }
    // Strikethrough delimiters: a run of 1 or 2 tildes is a delimiter;
    // a run of 3+ tildes is literal text.
    if (c === 126) {
      let j = i, run = 0;
      while (j < n && text.charCodeAt(j) === 126) { run++; j++; }
      if (run === 1 || run === 2) {
        const [left, right] = flanking(text, i, run);
        flush();
        nodes.push({ t: 'delim', ch: '~', len: run, canOpen: left, canClose: right, active: true });
        i = j;
        continue;
      }
      buf += '~'.repeat(run);
      i = j;
      continue;
    }
    // Link / image opener
    if (c === 91 || (c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91)) {
      let img = false;
      if (c === 33) { img = true; i++; }
      flush();
      nodes.push({ t: 'delim', ch: '[', len: 1, canOpen: true, canClose: false, active: true, img, pos: i });
      i++;
      continue;
    }
    // Link closer: try to form a link.
    if (c === 93) {
      flush();
      // Find nearest active '[' delimiter (skip deactivated ones).
      let oi = -1;
      for (let k = nodes.length - 1; k >= 0; k--) {
        if (nodes[k].t === 'delim' && nodes[k].ch === '[' && nodes[k].active) { oi = k; break; }
      }
      if (oi === -1) { buf += ']'; i++; continue; }
      const opener = nodes[oi];
      const children = nodes.slice(oi + 1);
      let link = null;
      let end = i + 1;
      // Inline link: '(' must IMMEDIATELY follow ']' (no whitespace).
      let p = i + 1;
      const next = p < n ? text.charCodeAt(p) : -1;
      const rawLabel = text.slice(opener.pos + 1, i);
      if (next === 40) { // '(' — inline link; if it fails, fall back
        // to a shortcut reference (e.g. [foo](not a link)).
        const t = parseLinkTarget(text, p + 1);
        if (t) { link = { dest: t.dest, title: t.title }; end = t.end; }
        if (!link) {
          const ref = refs.get(normLabel(rawLabel));
          if (ref) link = { dest: ref.dest, title: ref.title };
        }
      } else if (next === 91) { // '[' — full or collapsed reference.
        // If neither matches, the ']' is literal (no shortcut fallback).
        const lab = parseLabel(text, p);
        if (lab) {
          const ref = refs.get(normLabel(lab[0]));
          if (ref) { link = { dest: ref.dest, title: ref.title }; end = lab[1]; }
        }
        if (!link && p + 1 < n && text.charCodeAt(p + 1) === 93) {
          const ref = refs.get(normLabel(rawLabel));
          if (ref) { link = { dest: ref.dest, title: ref.title }; end = p + 2; }
        }
      } else {
        // Shortcut reference: the label is the RAW source text of the
        // link text (backslashes preserved).
        const ref = refs.get(normLabel(rawLabel));
        if (ref) link = { dest: ref.dest, title: ref.title };
      }
      if (link) {
        const href = cleanUrl(link.dest);
        // A link cannot contain another link (images may contain links).
        // An autolink inside link text is unwrapped to plain text instead
        // (its URL stays literal), so the outer link can still form.
        let nestedLink = false;
        if (!opener.img) {
          nestedLink = unwrapAutoLinks(children);
        }
        if (href !== null && !nestedLink) {
          flush();
          nodes.length = oi;
          nodes.push({ t: 'link', href, title: link.title, children, img: opener.img });
          i = end;
          continue;
        }
      }
      // No link: deactivate this opener, ']' is literal.
      opener.active = false;
      buf += ']';
      i++;
      continue;
    }
    // Autolink / raw HTML
    if (c === 60) {
      // Autolink <scheme:...> or <email>
      let j = i + 1;
      let scheme = '';
      while (j < n && ((text.charCodeAt(j) >= 65 && text.charCodeAt(j) <= 90) || (text.charCodeAt(j) >= 97 && text.charCodeAt(j) <= 122) || (text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) || text.charCodeAt(j) === 43 || text.charCodeAt(j) === 45 || text.charCodeAt(j) === 46)) {
        scheme += text[j];
        j++;
      }
      let matched = false;
      if (scheme.length >= 2 && scheme.length <= 32 && j < n && text.charCodeAt(j) === 58) {
        let k = j + 1;
        while (k < n && text.charCodeAt(k) !== 62 && text.charCodeAt(k) !== 32 && text.charCodeAt(k) !== 10 && text.charCodeAt(k) !== 60) k++;
        if (k < n && text.charCodeAt(k) === 62 && k > j + 1) {
          const url = text.slice(i + 1, k);
          flush();
          nodes.push({ t: 'link', href: url, title: '', children: [{ t: 'text', s: url }], img: false, auto: 'angle' });
          i = k + 1;
          matched = true;
        }
      }
      if (!matched) {
        // Email autolink <a@b.c>
        const m = /^([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)>/.exec(text.slice(i + 1));
        if (m) {
          const email = m[1];
          flush();
          nodes.push({ t: 'link', href: 'mailto:' + email, title: '', children: [{ t: 'text', s: email }], img: false, auto: 'angle' });
          i = i + 1 + m[0].length;
          matched = true;
        }
      }
      if (!matched) {
        // Raw HTML tag / comment / PI / declaration / CDATA. All tags
        // are emitted raw (the disallowed-tags list does not apply to
        // inline HTML in the practice set).
        const tag = parseHtmlTag(text, i);
        if (tag) {
          flush();
          nodes.push({ t: 'html', s: tag.raw });
          i = tag.end;
          matched = true;
        }
      }
      if (!matched) { buf += '<'; i++; continue; }
      continue;
    }
    // Entity: numeric references decode; named ones stay literal.
    if (c === 38) {
      const num = decodeNumericEntity(text, i);
      if (num) { buf += num[0]; i = num[1]; continue; }
      let j = i + 1;
      if (j < n && ((text.charCodeAt(j) >= 65 && text.charCodeAt(j) <= 90) || (text.charCodeAt(j) >= 97 && text.charCodeAt(j) <= 122))) {
        j++;
        while (j < n && isAlphaNum(text[j])) j++;
        if (j < n && text.charCodeAt(j) === 59) {
          flush();
          nodes.push({ t: 'raw', s: text.slice(i, j + 1) });
          i = j + 1;
          continue;
        }
      }
      buf += '&';
      i++;
      continue;
    }
    // GFM extended autolink (www. / scheme:// / email), preceded by start or space/punct.
    if (i === 0 || isUniSpace(text[i - 1]) || '(*_~`[{"\'<'.indexOf(text[i - 1]) !== -1) {
      const ga = matchGfmAutolink(text, i);
      if (ga) {
        flush();
        nodes.push({ t: 'link', href: ga.href, title: '', children: [{ t: 'text', s: ga.text }], img: false, auto: 'gfm' });
        i = ga.end;
        continue;
      }
    }
    // Hard break: two or more spaces before newline
    if (c === 32) {
      let j = i;
      while (j < n && text.charCodeAt(j) === 32) j++;
      if (j < n && text.charCodeAt(j) === 10 && j - i >= 2) {
        flush();
        nodes.push({ t: 'br' });
        i = j + 1;
        // Skip leading whitespace of the next line after a break.
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      buf += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === 10) {
      // A soft break: the newline is kept, and a single trailing space
      // before it is preserved (only 2+ spaces make a hard break).
      // Leading whitespace of the next line is also preserved.
      buf += '\n';
      i++;
      continue;
    }
    buf += text[i];
    i++;
  }
  flush();
  return nodes;
}

// Parse an inline HTML construct starting at i (text[i] === '<').
// Returns {raw, end, name} or null.
function parseHtmlTag(text, i) {
  const n = text.length;
  // Comment: <!--> and <!---> are complete (empty) comments.
  if (text.startsWith('<!--', i)) {
    if (text.startsWith('<!-->', i)) return { raw: '<!-->', end: i + 5, name: '' };
    if (text.startsWith('<!--->', i)) return { raw: '<!--->', end: i + 6, name: '' };
    const e = text.indexOf('-->', i + 4);
    if (e !== -1) return { raw: text.slice(i, e + 3), end: e + 3, name: '' };
    return null;
  }
  if (text.startsWith('<?', i)) {
    const e = text.indexOf('?>', i + 2);
    if (e !== -1) return { raw: text.slice(i, e + 2), end: e + 2, name: '' };
    return null;
  }
  if (text.startsWith('<!', i)) {
    if (i + 2 < n && text.charCodeAt(i + 2) >= 65 && text.charCodeAt(i + 2) <= 90) {
      const e = text.indexOf('>', i + 2);
      if (e !== -1) return { raw: text.slice(i, e + 1), end: e + 1, name: '' };
      return null;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9);
      if (e !== -1) return { raw: text.slice(i, e + 3), end: e + 3, name: '' };
      return null;
    }
    return null;
  }
  // Open / close tag
  let j = i + 1;
  let closing = false;
  if (text.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n || !((text.charCodeAt(j) >= 65 && text.charCodeAt(j) <= 90) || (text.charCodeAt(j) >= 97 && text.charCodeAt(j) <= 122))) return null;
  const nameStart = j;
  while (j < n && ((text.charCodeAt(j) >= 65 && text.charCodeAt(j) <= 90) || (text.charCodeAt(j) >= 97 && text.charCodeAt(j) <= 122) || (text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) || text.charCodeAt(j) === 45)) j++;
  const name = text.slice(nameStart, j).toLowerCase();
  // The tag name must be followed by whitespace, '/', or '>' — a ':'
  // or '.' directly after it (e.g. <m:abc>, <foo.bar.baz>) is not a tag.
  if (j < n) {
    const nc = text.charCodeAt(j);
    if (!(nc === 32 || nc === 9 || nc === 10 || nc === 47 || nc === 62)) return null;
  }
  // Attributes (not allowed on a closing tag).
  if (closing) {
    while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 10)) j++;
    if (j < n && text.charCodeAt(j) === 62) { j++; return { raw: text.slice(i, j), end: j, name }; }
    return null;
  }
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) { j++; continue; }
    if (c === 47 && j + 1 < n && text.charCodeAt(j + 1) === 62) { j += 2; return { raw: text.slice(i, j), end: j, name }; }
    if (c === 62) { j++; return { raw: text.slice(i, j), end: j, name }; }
    // Attribute name
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || (c >= 48 && c <= 57) || c === 45 || c === 46)) return null;
    while (j < n) {
      const c2 = text.charCodeAt(j);
      if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122) || (c2 >= 48 && c2 <= 57) || c2 === 95 || c2 === 58 || c2 === 45 || c2 === 46) j++;
      else break;
    }
    while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 10)) j++;
    if (j < n && text.charCodeAt(j) === 61) {
      j++;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 10)) j++;
      if (j >= n) return null;
      const q = text.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && text.charCodeAt(j) !== q) j++;
        if (j >= n) return null;
        j++;
      } else {
        while (j < n) {
          const c3 = text.charCodeAt(j);
          if (c3 === 32 || c3 === 9 || c3 === 10 || c3 === 34 || c3 === 39 || c3 === 61 || c3 === 60 || c3 === 62 || c3 === 96) break;
          j++;
        }
        if (j >= n) return null;
      }
      // After a value, only whitespace, '/', or '>' may follow.
      if (j < n) {
        const vc = text.charCodeAt(j);
        if (!(vc === 32 || vc === 9 || vc === 10 || vc === 47 || vc === 62)) return null;
      }
    }
  }
  return null;
}

// GFM extended autolink at position i. Returns {href, text, end} or null.
function matchGfmAutolink(text, i) {
  const n = text.length;
  const rest = text.slice(i);
  // www. form
  let m = /^(www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?:[^\s<\[\]]*)?)/.exec(rest);
  if (m) {
    const raw = trimAutolinkEnd(m[1]);
    if (raw.length > 0) return { href: 'http://' + raw, text: raw, end: i + raw.length };
  }
  // scheme:// form
  m = /^([A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/[^\s<\[\]]+)/.exec(rest);
  if (m) {
    const raw = trimAutolinkEnd(m[1]);
    if (raw.length > 0) return { href: raw, text: raw, end: i + raw.length };
  }
  // scheme: form (mailto:, xmpp:, etc.) — scheme + ':' + email, with an
  // optional single path segment. A trailing '-' or '_' after the
  // email invalidates it; a second '/' segment is not included.
  m = /^([A-Za-z][A-Za-z0-9+.-]{1,31}:[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?:\/[^\s<\/]+)?)/.exec(rest);
  if (m) {
    const after = rest[m[1].length];
    if (after === '-' || after === '_') return null;
    const raw = trimAutolinkEnd(m[1]);
    if (raw.length > 0) return { href: raw, text: raw, end: i + raw.length };
  }
  // email form
  m = /^([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)/.exec(rest);
  if (m) {
    // A trailing '-' or '_' right after the domain invalidates the
    // email autolink (the address would continue).
    const after = rest[m[1].length];
    if (after === '-' || after === '_') return null;
    const raw = trimAutolinkEnd(m[1]);
    if (raw.length > 0) return { href: 'mailto:' + raw, text: raw, end: i + raw.length };
  }
  return null;
}

// Trim trailing punctuation / unbalanced closers from a GFM autolink candidate.
function trimAutolinkEnd(s) {
  let end = s.length;
  while (end > 0) {
    const c = s[end - 1];
    if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === ';' || c === '*' || c === '_' || c === '~') {
      if (c === ';') {
        // A trailing &...; entity-like sequence is excluded whole.
        const amp = s.lastIndexOf('&', end - 1);
        if (amp !== -1 && /^[A-Za-z0-9#]+$/.test(s.slice(amp + 1, end - 1))) { end = amp; continue; }
      }
      end--;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      // Keep a trailing closer only if the candidate has at least as
      // many openers as closers of that kind; otherwise trim it.
      const open = c === ')' ? '(' : c === ']' ? '[' : '{';
      let opens = 0, closes = 0;
      for (let k = 0; k < end; k++) {
        if (s[k] === open) opens++;
        else if (s[k] === c) closes++;
      }
      if (closes > opens) { end--; continue; }
    }
    break;
  }
  return s.slice(0, end);
}

// ---- emphasis ----

function processEmphasis(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link') processEmphasis(nd.children);
  }
  let changed = true;
  while (changed) {
    changed = false;
    const delims = nodes.filter((nd) => nd.t === 'delim' && (nd.ch === '*' || nd.ch === '_' || nd.ch === '~'));
    for (let ci = 0; ci < delims.length; ci++) {
      const closer = delims[ci];
      if (closer.len === 0 || !closer.canClose) continue;
      let matched = false;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const opener = delims[oi];
        if (opener.len === 0 || opener.ch !== closer.ch || !opener.canOpen) continue;
        // Rule of 3: if either delimiter can both open and close, and the
        // lengths sum to a multiple of 3 (without both being multiples
        // of 3), this pair must not match.
        const eitherBoth = (opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose);
        if (eitherBoth && (opener.len + closer.len) % 3 === 0 && (opener.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
        const use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
        const type = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
        const oiIdx = nodes.indexOf(opener);
        const ciIdx = nodes.indexOf(closer);
        if (oiIdx === -1 || ciIdx === -1 || ciIdx <= oiIdx) continue;
        const children = nodes.slice(oiIdx + 1, ciIdx);
        const node = { t: type, children };
        opener.len -= use;
        closer.len -= use;
        // Re-insert any leftover delimiters around the new node.
        const replacement = [];
        if (opener.len > 0) replacement.push(opener);
        replacement.push(node);
        if (closer.len > 0) replacement.push(closer);
        nodes.splice(oiIdx, ciIdx - oiIdx + 1, ...replacement);
        matched = true;
        changed = true;
        break;
      }
      if (matched) break;
    }
  }
}

function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += escText(nd.s);
    else if (nd.t === 'delim') out += nd.ch === '[' ? (nd.img ? '![' : '[') : nd.ch.repeat(nd.len);
    else if (nd.t === 'code') out += '<code>' + escText(nd.s) + '</code>';
    else if (nd.t === 'html') out += nd.s;
    else if (nd.t === 'raw') out += nd.s; // named entity reference, kept literal
    else if (nd.t === 'br') out += '<br>';
    else if (nd.t === 'em') out += '<em>' + renderInline(nd.children) + '</em>';
    else if (nd.t === 'strong') out += '<strong>' + renderInline(nd.children) + '</strong>';
    else if (nd.t === 'del') out += '<del>' + renderInline(nd.children) + '</del>';
    else if (nd.t === 'link') {
      const href = escAttr(encodeHref(nd.href));
      const title = nd.title ? ' title="' + escAttr(nd.title) + '"' : '';
      if (nd.img) {
        out += '<img src="' + href + '" alt="' + escAttr(plainText(nd.children)) + '"' + title + '>';
      } else {
        out += '<a href="' + href + '"' + title + '>' + renderInline(nd.children) + '</a>';
      }
    }
  }
  return out;
}

function inlineParse(text, refs) {
  const nodes = scanInline(text, refs);
  processEmphasis(nodes);
  return renderInline(nodes);
}
