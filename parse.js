// parse.js — dependency-free marked 18.1.3-compatible Markdown parser.
// Written from scratch from the CommonMark 0.31.2 + GFM spec and the
// practice cases. Single-pass scanner, direct to HTML, no token tree.
export function parse(src) {
  return new Doc(src).render();
}

// ---------- character helpers ----------
const C_SPACE = 32, C_TAB = 9, C_LF = 10, C_CR = 13, C_BANG = 33, C_QUOT = 34,
  C_HASH = 35, C_DOLLAR = 36, C_PCT = 37, C_AMP = 38, C_SQ = 39, C_LP = 40,
  C_RP = 41, C_STAR = 42, C_PLUS = 43, C_COMMA = 44, C_MINUS = 45, C_DOT = 46,
  C_SLASH = 47, C_COLON = 58, C_SEMI = 59, C_LT = 60, C_EQ = 61, C_GT = 62,
  C_Q = 63, C_AT = 64, C_LB = 91, C_BSL = 92, C_RB = 93, C_CARET = 94,
  C_US = 95, C_BT = 96, C_LC = 123, C_PIPE = 124, C_RC = 125, C_TILDE = 126;

function isSpaceCh(c) { return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288; }
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
const RE_PUNCT = /[\p{P}\p{S}]/u;
const RE_WORD = /[\p{L}\p{N}]/u;
function isPunctCh(ch) { return RE_PUNCT.test(ch); }
function isWordCh(ch) { return RE_WORD.test(ch); }
// flanking per CommonMark: prev/next are single chars ('' = start/end of text)
function leftFlanking(prev, next) {
  if (next === '' || isSpaceCh(next.charCodeAt(0))) return false;
  const npc = next.charCodeAt(0);
  if (!isPunctCh(next)) return true;
  return prev === '' || isSpaceCh(prev.charCodeAt(0)) || isPunctCh(prev);
}
function rightFlanking(prev, next) {
  if (prev === '' || isSpaceCh(prev.charCodeAt(0))) return false;
  if (!isPunctCh(prev)) return true;
  return next === '' || isSpaceCh(next.charCodeAt(0)) || isPunctCh(next);
}

function escText(s) {
  // escape & < > " ' for text content (marked: " -> &quot;, ' -> &#39;)
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > start) out += s.slice(start, i);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}
function escAttr(s) {
  // escape & < > " for attributes, but pass valid entity references through
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const m = RE_ENTITY.exec(s.slice(i, i + 40));
      if (m) {
        if (i > start) out += s.slice(start, i);
        out += m[0];
        i += m[0].length - 1;
        start = i + 1;
        continue;
      }
      if (i > start) out += s.slice(start, i);
      out += '&amp;';
      start = i + 1;
    } else if (c === 60 || c === 62 || c === 34) {
      if (i > start) out += s.slice(start, i);
      out += c === 60 ? '&lt;' : c === 62 ? '&gt;' : '&quot;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// ---------- entities ----------
const ENT = {
  nbsp: ' ', amp: '&', copy: '©', AElig: 'Æ', Dcaron: 'Ď', frac34: '¾',
  HilbertSpace: 'ℋ', DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲',
  auml: 'ä', gt: '>', hellip: '…', lt: '<', mdash: '—', ouml: 'ö',
  quot: '"', reg: '®',
  // other common HTML5 entities (valid per spec; harmless if unused)
  eacute: 'é', Eacute: 'É', agrave: 'à', egrave: 'è', icirc: 'î', uuml: 'ü',
  szlig: 'ß', sect: '§', deg: '°', plusmn: '±', times: '×', divide: '÷',
  laquo: '«', raquo: '»', trade: '™', euro: '€', pound: '£', yen: '¥',
  cent: '¢', curren: '¤', brvbar: '¦', uml: '¨', ordf: 'ª', ordm: 'º',
  iexcl: '¡', iquest: '¿', micro: 'µ', para: '¶', middot: '·', cedil: '¸',
  sup1: '¹', sup2: '²', sup3: '³', frac12: '½', frac14: '¼', acute: '´',
  macr: '¯', circ: 'ˆ', tilde: '˜', diaeresis: '¨', aelig: 'æ', Aacute: 'Á',
  Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', Ccedil: 'Ç', Egrave: 'È',
  Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ',
  Ograve: 'Ò', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù',
  Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', THORN: 'Þ', thorn: 'þ', yuml: 'ÿ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', pi: 'π',
  sigma: 'σ', omega: 'ω', infin: '∞', ne: '≠', le: '≤', ge: '≥',
  hellip2: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', dagger: '†', Dagger: '‡', permil: '‰',
  lsaquo: '‹', rsaquo: '›', oline: '‾', frasl: '⁄', ndash: '–',
  bull: '•', prime: '′', Prime: '″', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', shy: '­',
};
const RE_ENTITY = /^&(#x[0-9a-fA-F]+|#X[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/;
// Decode one entity at s[i]=='&'. Returns {text, len} or null if not a valid entity.
// Named: any validly-formed name passes through verbatim (marked). Numeric:
// decoded to the character (0 -> U+FFFD); out-of-range/surrogate -> not an
// entity (left literal).
function decodeEntity(s, i) {
  const m = RE_ENTITY.exec(s.slice(i, i + 40));
  if (!m) return null;
  const body = m[0].slice(1, -1);
  if (body[0] === '#') {
    let cp;
    if (body[1] === 'x' || body[1] === 'X') cp = parseInt(body.slice(2), 16);
    else {
      if (!/^[0-9]+$/.test(body.slice(1))) return null;
      cp = parseInt(body.slice(1), 10);
    }
    if (cp === 0) cp = 0xFFFD;
    else if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return null;
    return { text: String.fromCodePoint(cp), len: m[0].length };
  }
  return { text: m[0], len: m[0].length };
}

function cleanUrl(url) {
  // percent-encode anything outside the URL-allowed set (CommonMark cleanUrl);
  // [ ] and backtick are also encoded (marked); % itself is left alone.
  let out = '', start = 0;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 45 || c === 46 || c === 95 || c === 126 || c === 58 || c === 47 || c === 63 ||
      c === 35 || c === 64 || c === 33 || c === 36 || c === 38 || c === 39 || c === 40 ||
      c === 41 || c === 42 || c === 43 || c === 44 || c === 59 || c === 61 || c === 37;
    if (!ok) {
      if (i > start) out += url.slice(start, i);
      if (c < 128) out += '%' + c.toString(16).toUpperCase().padStart(2, '0');
      else out += encodeURIComponent(url[i]);
      start = i + 1;
    }
  }
  return start === 0 ? url : out + url.slice(start);
}
function normLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// ---------- inline parser ----------
// Returns {html, hasLink}. refs: Map normalized label -> {dest, title}.
function parseInline(s, refs, noAuto) {
  const out = [];           // pieces of html
  const delims = [];        // {ch, piece, len, canOpen, canClose, active}
  let cur = '';             // pending plain text
  const flush = () => { if (cur) { out.push(escText(cur)); cur = ''; } };
  const n = s.length;
  let i = 0;
  let hasLink = false;

  const pushDelim = (ch, run) => {
    const prev = i === 0 ? '' : s[i - 1];
    const next = i + run >= n ? '' : s[i + run];
    const lf = leftFlanking(prev, next), rf = rightFlanking(prev, next);
    let canOpen, canClose;
    if (ch === '_') {
      canOpen = lf && (!rf || isPunctCh(prev));
      canClose = rf && (!lf || isPunctCh(next));
    } else {
      canOpen = lf; canClose = rf;
    }
    // a run that can neither open nor close is plain text: keep it in cur
    // so constructs spanning it (e.g. an email local part) stay intact
    if (!canOpen && !canClose) { cur += s.slice(i, i + run); return; }
    flush();
    out.push(s.slice(i, i + run));
    delims.push({ ch, piece: out.length - 1, len: run, canOpen, canClose, active: true });
  };

  while (i < n) {
    const c = s.charCodeAt(i);
    // backslash
    if (c === C_BSL) {
      if (i + 1 < n && s[i + 1] === '\n') {
        flush(); out.push('<br>'); i += 2;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { cur += s[i + 1]; i += 2; continue; }
      cur += '\\'; i++; continue;
    }
    // entity
    if (c === C_AMP) {
      const e = decodeEntity(s, i);
      if (e) {
        // named entities pass through verbatim; numeric decoded char may need escaping
        if (e.text[0] === '&' && e.text.length > 1 && e.text[1] !== '#') { flush(); out.push(e.text); }
        else if (e.text === '"') { flush(); out.push('&quot;'); }
        else if (e.text === '<') { flush(); out.push('&lt;'); }
        else if (e.text === '>') { flush(); out.push('&gt;'); }
        else if (e.text === '&') { flush(); out.push('&amp;'); }
        else cur += e.text;
        i += e.len; continue;
      }
      cur += '&'; i++; continue;
    }
    // code span
    if (c === C_BT) {
      let k = i; while (k < n && s.charCodeAt(k) === C_BT) k++;
      const run = k - i;
      let p = k, found = -1;
      while (p < n) {
        if (s.charCodeAt(p) === C_BT) {
          let q = p; while (q < n && s.charCodeAt(q) === C_BT) q++;
          if (q - p === run) { found = p; break; }
          p = q;
        } else p++;
      }
      if (found === -1) { cur += s.slice(i, k); i = k; continue; }
      let content = s.slice(k, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush(); out.push('<code>' + escText(content) + '</code>');
      i = found + run; continue;
    }
    // html tag / autolink / comment
    if (c === C_LT) {
      const h = tryHtml(s, i);
      if (h) { flush(); out.push(h.html); i = h.end; continue; }
      const a = tryAngleAutolink(s, i);
      if (a) { flush(); out.push(a.html); i = a.end; continue; }
      cur += '<'; i++; continue;
    }
    // link / image
    if (c === C_LB || (c === C_BANG && i + 1 < n && s.charCodeAt(i + 1) === C_LB)) {
      const isImg = c === C_BANG;
      const start = isImg ? i + 1 : i;
      const l = tryLink(s, start, refs, isImg);
      if (l) { flush(); out.push(l.html); if (!isImg) hasLink = true; i = l.end; continue; }
      cur += isImg ? '!' : ''; cur += '['; i = start + 1; continue;
    }
    // emphasis delimiters
    if (c === C_STAR || c === C_US) {
      let k = i; while (k < n && s.charCodeAt(k) === c) k++;
      pushDelim(c === C_STAR ? '*' : '_', k - i);
      i = k; continue;
    }
    if (c === C_TILDE) {
      let k = i; while (k < n && s.charCodeAt(k) === C_TILDE) k++;
      const run = k - i;
      // strikethrough uses runs of 1 or 2 tildes; 3+ is literal text
      if (run === 1 || run === 2) { pushDelim('~', run); i = k; continue; }
      cur += s.slice(i, k); i = k; continue;
    }
    // newline: hard / soft break; leading whitespace of the next line is
    // stripped only after a hard break
    if (c === C_LF) {
      let sp = 0;
      while (cur.length > sp && cur[cur.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        cur = cur.slice(0, cur.length - sp); flush(); out.push('<br>');
        i++;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      } else { flush(); out.push('\n'); i++; }
      continue;
    }
    // extended autolinks: www. / scheme:// / email (suppressed in link labels)
    if (!noAuto && (c === 119 || c === 87) && s.startsWith('www.', i) && (i === 0 || !isWordCh(s[i - 1]) && s[i - 1] !== '/')) {
      const w = tryWwwAutolink(s, i);
      if (w) { flush(); out.push(w.html); i = w.end; continue; }
    }
    if (!noAuto && c === C_AT) {
      const e = tryEmailAutolink(s, i, cur, delims);
      if (e) {
        // trim the local part out of cur
        cur = cur.slice(0, cur.length - e.localLen);
        flush(); out.push(e.html); i = e.end; continue;
      }
    }
    if (!noAuto && isWordCh(s[i]) && (i === 0 || !isWordCh(s[i - 1]) && s[i - 1] !== '/')) {
      const sc = trySchemeAutolink(s, i);
      if (sc) { flush(); out.push(sc.html); i = sc.end; continue; }
    }
    cur += s[i]; i++;
  }
  flush();
  processDelims(out, delims);
  return { html: out.join(''), hasLink };
}

function processDelims(out, delims) {
  // CommonMark delimiter-stack algorithm.
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.active || !closer.canClose) continue;
    let oi = ci - 1;
    while (oi >= 0) {
      const opener = delims[oi];
      if (!opener.active || opener.ch !== closer.ch || !opener.canOpen) { oi--; continue; }
      // odd-match rule: if either delimiter can both open and close,
      // the sum of lengths must not be a multiple of 3 unless both are
      if ((opener.canClose || closer.canOpen)) {
        const sum = opener.len + closer.len;
        if (sum % 3 === 0 && !(opener.len % 3 === 0 && closer.len % 3 === 0)) { oi--; continue; }
      }
      let use;
      if (closer.ch === '~') {
        use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
      } else {
        use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
      }
      const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      const openTag = '<' + tag + '>', closeTag = '</' + tag + '>';
      // opener piece: leftover delimiters + new open tag + tags already added
      out[opener.piece] = out[opener.piece].slice(0, opener.len - use) + openTag + out[opener.piece].slice(opener.len);
      // closer piece: tags already added + new close tag + leftover delimiters
      const cp = out[closer.piece];
      out[closer.piece] = cp.slice(0, cp.length - closer.len) + closeTag + cp.slice(cp.length - (closer.len - use));
      opener.len -= use; closer.len -= use;
      if (opener.len === 0) opener.active = false;
      if (closer.len === 0) { closer.active = false; }
      // Delimiters strictly between this opener and closer are now trapped
      // inside the emphasis just created: they can no longer match a closer
      // outside it (any closer between them was already processed, being
      // earlier in the stack). Deactivate them.
      for (let k = oi + 1; k < ci; k++) delims[k].active = false;
      if (!closer.active) break;
      // closer still has delimiters: retry the same opener if it still
      // has delimiters, else move to the previous opener
      if (opener.len === 0) oi--;
    }
  }
}

// HTML tag at s[i]=='<'. Returns {html, end} or null.
function tryHtml(s, i) {
  const n = s.length;
  // comment
  if (s.startsWith('<!--', i)) {
    // <!--> and <!---> are complete (abruptly closed) empty comments
    if (s.startsWith('<!-->', i)) return { html: '<!-->', end: i + 5 };
    if (s.startsWith('<!--->', i)) return { html: '<!--->', end: i + 6 };
    const e = s.indexOf('-->', i + 4);
    if (e !== -1) return { html: s.slice(i, e + 3), end: e + 3 };
    return null;
  }
  // processing instruction
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    if (e !== -1) return { html: s.slice(i, e + 2), end: e + 2 };
    return null;
  }
  // declaration <!A...>
  if (s.startsWith('<!', i) && i + 2 < n && /[A-Za-z]/.test(s[i + 2])) {
    const e = s.indexOf('>', i + 2);
    if (e !== -1) return { html: s.slice(i, e + 1), end: e + 1 };
    return null;
  }
  // CDATA
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    if (e !== -1) return { html: s.slice(i, e + 3), end: e + 3 };
    return null;
  }
  // close tag: no attributes allowed, only optional whitespace
  const cm = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(s.slice(i));
  if (cm) return { html: cm[0], end: i + cm[0].length };
  // open tag (quoted attribute values may span newlines)
  const m = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^ \t\n\r"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/.exec(s.slice(i));
  if (m) return { html: m[0], end: i + m[0].length };
  return null;
}

// <scheme:...> or <email> autolink. Returns {html, end} or null.
function tryAngleAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n && s[j] !== '>' && s[j] !== ' ' && s[j] !== '\n' && s[j] !== '<') j++;
  if (j >= n || s[j] !== '>') return null;
  const inner = s.slice(i + 1, j);
  if (!inner) return null;
  if (RE_SCHEME.test(inner)) {
    const href = escAttr(cleanUrl(inner));
    return { html: '<a href="' + href + '">' + escText(inner) + '</a>', end: j + 1 };
  }
  if (RE_EMAIL.test(inner)) {
    const href = escAttr('mailto:' + cleanUrl(inner));
    return { html: '<a href="' + href + '">' + escText(inner) + '</a>', end: j + 1 };
  }
  return null;
}

// www. extended autolink at s[i]. Returns {html, end} or null.
function tryWwwAutolink(s, i) {
  const n = s.length;
  let j = i + 4;
  // domain: labels of [A-Za-z0-9_-]+ separated by '.', ending with TLD letters
  const m = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/.exec(s.slice(j));
  if (!m) return null;
  let dom = m[0];
  const lastDot = dom.lastIndexOf('.');
  if (lastDot === -1) return null;
  const tld = dom.slice(lastDot + 1);
  if (!/^[A-Za-z]{2,}$/.test(tld)) return null;
  j += dom.length;
  // path: any non-space non-< chars, but stop before an &...; entity-like run
  let k = j;
  while (k < n && s[k] !== ' ' && s[k] !== '\n' && s[k] !== '<' && s[k] !== '\t') {
    if (s[k] === '&') {
      let q = k + 1;
      while (q < n && /[A-Za-z0-9#]/.test(s[q])) q++;
      if (q > k + 1 && q < n && s[q] === ';') break;
    }
    k++;
  }
  let url = s.slice(i, k);
  url = stripAutolinkTail(url);
  const href = escAttr(cleanUrl('http://' + url));
  return { html: '<a href="' + href + '">' + escText(url) + '</a>', end: i + url.length };
}

// scheme:// extended autolink at s[i]. Returns {html, end} or null.
function trySchemeAutolink(s, i) {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.exec(s.slice(i));
  if (!m) return null;
  const n = s.length;
  let k = i + m[0].length;
  while (k < n && s[k] !== ' ' && s[k] !== '\n' && s[k] !== '<' && s[k] !== '\t') {
    if (s[k] === '&') {
      let q = k + 1;
      while (q < n && /[A-Za-z0-9#]/.test(s[q])) q++;
      if (q > k + 1 && q < n && s[q] === ';') break;
    }
    k++;
  }
  let url = s.slice(i, k);
  // email-like path (contains @): a trailing - or _ right after the address
  // domain invalidates the autolink -- check on the raw URL, before the
  // tail strip removes the very character being tested
  const atRaw = url.indexOf('@', m[0].length);
  if (atRaw !== -1) {
    const dmRaw = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/.exec(url.slice(atRaw + 1));
    if (dmRaw) {
      const afterRaw = url[atRaw + 1 + dmRaw[0].length];
      if (afterRaw === '-' || afterRaw === '_') return null;
    }
  }
  url = stripAutolinkTail(url);
  // must contain a dot after the scheme (a valid host / email domain)
  if (url.slice(m[0].length).indexOf('.') === -1) return null;
  // email-like path (contains @): allow at most one /resource segment
  // after the address domain
  const atIdx = url.indexOf('@', m[0].length);
  if (atIdx !== -1) {
    // domain after @: labels of [A-Za-z0-9-]+ separated by '.'
    const dm = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/.exec(url.slice(atIdx + 1));
    if (!dm) return null;
    const domEnd = atIdx + 1 + dm[0].length;
    const afterDom = url[domEnd];
    if (afterDom === '/') {
      // one /segment allowed; a second '/' ends the autolink there
      const segEnd = url.indexOf('/', domEnd + 1);
      if (segEnd !== -1) url = url.slice(0, segEnd);
      else if (domEnd === url.length - 1) url = url.slice(0, domEnd); // trailing slash
    }
  }
  const href = escAttr(cleanUrl(url));
  return { html: '<a href="' + href + '">' + escText(url) + '</a>', end: i + url.length };
}

// Strip trailing punctuation from an autolink per GFM: ? ! . , : ; * _ ~
// and unbalanced closing parens; also trailing & handling is left as-is.
function stripAutolinkTail(url) {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (ch === '?' || ch === '!' || ch === '.' || ch === ',' || ch === ':' || ch === ';' || ch === '*' || ch === '_' || ch === '~') { end--; continue; }
    if (ch === ')') {
      // keep only if parens are balanced
      let depth = 0;
      for (let p = 0; p < end; p++) { if (url[p] === '(') depth++; else if (url[p] === ')') depth--; }
      if (depth < 0) { end--; continue; }
    }
    break;
  }
  // also strip a trailing entity-like '&' left dangling? marked keeps it.
  return url.slice(0, end);
}

// Email autolink in running text at s[i]=='@'. cur is the pending text buffer.
// Returns {html, end, localLen} or null.
function tryEmailAutolink(s, i, cur, delims) {
  // local part: scan backward in the RAW string from just before '@', so a
  // backslash escape inside it (e.g. foo\+@bar) invalidates the autolink
  let ls = i;
  while (ls > 0 && /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(s[ls - 1])) ls--;
  if (ls > 0 && s[ls - 1] === '\\') return null; // escaped char in local part
  const local = s.slice(ls, i);
  if (!local) return null;
  if (ls > 0 && (isWordCh(s[ls - 1]) || s[ls - 1] === '.')) return null;
  // the processed buffer must end with this local part (no escapes inside)
  if (!cur.endsWith(local)) return null;
  // domain after @
  const m = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/.exec(s.slice(i + 1));
  if (!m) return null;
  let dom = m[0];
  const lastDot = dom.lastIndexOf('.');
  if (!/^[A-Za-z]+$/.test(dom.slice(lastDot + 1))) return null;
  // strip trailing punctuation
  while (dom.length && /[?!,.:;*_~.]/.test(dom[dom.length - 1])) dom = dom.slice(0, -1);
  if (!dom || dom.indexOf('.') === -1) return null;
  // a trailing - or _ in the source (just past the matched domain) means
  // the address continues and is not a standalone autolink (a trailing .
  // is stripped and the link still forms) -- except a _ that closes an
  // open _ emphasis span is markup, not part of the address
  const afterDom = s[i + 1 + m[0].length];
  if (afterDom === '-') return null;
  if (afterDom === '_') {
    let hasUnderscoreOpener = false;
    if (delims) {
      for (let d = 0; d < delims.length; d++) {
        const dl = delims[d];
        if (dl.active && dl.ch === '_' && dl.canOpen) { hasUnderscoreOpener = true; break; }
      }
    }
    if (!hasUnderscoreOpener) return null;
  }
  const addr = local + '@' + dom;
  const href = escAttr('mailto:' + cleanUrl(addr));
  return { html: '<a href="' + href + '">' + escText(addr) + '</a>', end: i + 1 + dom.length, localLen: local.length };
}

// Link / image starting at s[i]=='['. Returns {html, end} or null.
function tryLink(s, i, refs, isImg) {
  const n = s.length;
  const labelEnd = findLabelEnd(s, i);
  if (labelEnd === -1 || labelEnd === -2) return null;
  const labelRaw = s.slice(i + 1, labelEnd);
  const labelNorm = normLabel(labelRaw);
  // An empty label is only valid with an inline destination: [](dest).
  const after = labelEnd + 1;
  if (!labelNorm && !(after < n && s[after] === '(')) return null;
  const labelParsed = parseInline(labelRaw, refs, true);
  if (!isImg && labelParsed.hasLink) return null; // link cannot contain a link
  let dest = null, title = null, end = -1;
  if (after < n && s[after] === '(') {
    const t = parseLinkTarget(s, after + 1, true);
    if (!t) {
      // inline destination invalid: fall back to a shortcut reference link
      const r = labelNorm ? refs.get(labelNorm) : null;
      if (!r) return null;
      dest = r.dest; title = r.title; end = after;
    } else {
      dest = t.dest; title = t.title; end = t.end;
    }
  } else if (after < n && s[after] === '[') {
    const le2 = findLabelEnd(s, after);
    if (le2 === -1 || le2 === -2) return null;
    const lab2 = s.slice(after + 1, le2);
    const key = lab2 === '' ? labelNorm : normLabel(lab2);
    if (!key) return null;
    const r = refs.get(key);
    if (!r) return null;
    dest = r.dest; title = r.title; end = le2 + 1;
  } else {
    const r = refs.get(labelNorm);
    if (!r) return null;
    dest = r.dest; title = r.title; end = after;
  }
  if (isImg) {
    const alt = escAttr(plainText(labelRaw, refs));
    const src = escAttr(cleanUrl(dest));
    let h = '<img src="' + src + '" alt="' + alt + '"';
    if (title !== null && title !== undefined) h += ' title="' + escAttr(title) + '"';
    h += '>';
    return { html: h, end };
  }
  const href = escAttr(cleanUrl(dest));
  let h = '<a href="' + href + '"';
  if (title !== null && title !== undefined) h += ' title="' + escAttr(title) + '"';
  h += '>' + labelParsed.html + '</a>';
  return { html: h, end };
}

// Plain text of an inline span (for image alt text): formatting removed.
function plainText(s, refs) {
  let out = '', i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === C_BSL && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; continue; }
    if (c === C_AMP) {
      const e = decodeEntity(s, i);
      if (e) { out += e.text[0] === '&' && e.text[1] !== '#' ? e.text : e.text; i += e.len; continue; }
      out += '&'; i++; continue;
    }
    if (c === C_BT) {
      let k = i; while (k < n && s.charCodeAt(k) === C_BT) k++;
      const run = k - i;
      let p = k, found = -1;
      while (p < n) {
        if (s.charCodeAt(p) === C_BT) {
          let q = p; while (q < n && s.charCodeAt(q) === C_BT) q++;
          if (q - p === run) { found = p; break; }
          p = q;
        } else p++;
      }
      if (found === -1) { out += s.slice(i, k); i = k; continue; }
      let content = s.slice(k, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) content = content.slice(1, -1);
      out += content; i = found + run; continue;
    }
    if (c === C_LT) {
      const h = tryHtml(s, i);
      if (h) { i = h.end; continue; }
      const a = tryAngleAutolink(s, i);
      if (a) { out += s.slice(i + 1, a.end - 1); i = a.end; continue; }
      out += '<'; i++; continue;
    }
    if (c === C_LB || (c === C_BANG && i + 1 < n && s.charCodeAt(i + 1) === C_LB)) {
      const isImg = c === C_BANG;
      const start = isImg ? i + 1 : i;
      const le = findLabelEnd(s, start);
      if (le !== -1 && le !== -2) {
        const lab = s.slice(start + 1, le);
        // if it is a real link/image, use its label text; else literal
        const l = tryLink(s, start, refs, isImg);
        if (l) { out += plainText(lab, refs); i = l.end; continue; }
      }
      out += isImg ? '!' : ''; out += '['; i = start + 1; continue;
    }
    if (c === C_STAR || c === C_US || c === C_TILDE) { i++; continue; }
    if (c === C_LF) { out += '\n'; i++; continue; }
    out += s[i]; i++;
  }
  return out;
}


// Find the end of a link label starting at s[i]=='['. Returns index of matching ']'
// or -1. Skips code spans; returns -2 if an unmatched backtick run is inside.
// Does a raw link label contain an unescaped '[' outside a code span?
function labelHasBracket(s) {
  let j = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === C_BSL && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === C_BT) {
      let k = j; while (k < s.length && s.charCodeAt(k) === C_BT) k++;
      const run = k - j;
      let p = k, found = -1;
      while (p < s.length) {
        if (s.charCodeAt(p) === C_BT) {
          let q = p; while (q < s.length && s.charCodeAt(q) === C_BT) q++;
          if (q - p === run) { found = p; break; }
          p = q;
        } else p++;
      }
      if (found === -1) return false;
      j = found + run;
      continue;
    }
    if (c === C_LB) return true;
    j++;
  }
  return false;
}

function findLabelEnd(s, i) {
  let level = 1, j = i + 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === C_BSL && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === C_BT) {
      let k = j; while (k < s.length && s.charCodeAt(k) === C_BT) k++;
      const run = k - j;
      // find a matching run of the same length
      let p = k, found = -1;
      while (p < s.length) {
        if (s.charCodeAt(p) === C_BT) {
          let q = p; while (q < s.length && s.charCodeAt(q) === C_BT) q++;
          if (q - p === run) { found = p; break; }
          p = q;
        } else p++;
      }
      if (found === -1) { j = k; continue; } // unmatched run is literal text; keep scanning for ']'
      j = found + run;
      continue;
    }
    if (c === C_LT) {
      // an HTML tag / autolink swallows its ']' (e.g. [foo <bar attr="](baz)"> is no link)
      const h = tryHtml(s, j);
      if (h) { j = h.end; continue; }
      const a = tryAngleAutolink(s, j);
      if (a) { j = a.end; continue; }
    }
    if (c === C_LB) level++;
    else if (c === C_RB) { level--; if (level === 0) return j; }
    j++;
  }
  return -1;
}

// Parse a link destination + optional title starting at s[i] (after '(' or after
// the label for reference defs). Returns {dest, title, end} (end = index just
// past the closing paren / end of the def line) or null.
function parseLinkTarget(s, i, inParen) {
  let j = i;
  const n = s.length;
  const skipWs = () => { while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++; };
  skipWs();
  if (j >= n) return null;
  let dest = '';
  if (s[j] === '<') {
    let k = j + 1;
    while (k < n && s[k] !== '>' && s[k] !== '\n') {
      if (s[k] === '<') return null;
      if (s[k] === '\\' && k + 1 < n && isAsciiPunct(s.charCodeAt(k + 1))) k += 2;
      else k++;
    }
    if (k >= n || s[k] !== '>') return null;
    dest = unescapeBackslash(s.slice(j + 1, k));
    j = k + 1;
  } else {
    // bare destination: no spaces/control, balanced parens
    let k = j, depth = 0;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c <= 32 || c === 127) break;
      if (c === C_BSL && k + 1 < n && isAsciiPunct(s.charCodeAt(k + 1))) { k += 2; continue; }
      if (c === C_LP) depth++;
      else if (c === C_RP) { if (depth === 0) break; depth--; }
      k++;
    }
    if (k === j) {
      // empty destination: allowed only for an inline link [x]()
      if (!(inParen && k < n && s[k] === ')')) return null;
      dest = '';
    } else {
      dest = unescapeBackslash(s.slice(j, k));
    }
    j = k;
  }
  // optional title (must be preceded by whitespace)
  let title = null;
  const saveJ = j;
  const destEnd = j;
  skipWs();
  if (j > saveJ && j < n && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const q = s[j], close = q === '(' ? ')' : q;
    let k = j + 1;
    while (k < n && s[k] !== close) {
      if (s[k] === '\\' && k + 1 < n && isAsciiPunct(s.charCodeAt(k + 1))) k += 2;
      else k++;
    }
    if (k < n) {
      title = unescapeBackslash(s.slice(j + 1, k));
      j = k + 1;
    } else {
      j = saveJ; // no title; rewind to right after dest
    }
  } else {
    j = saveJ; // no title; rewind to right after dest
  }
  if (inParen) {
    skipWs();
    if (j >= n || s[j] !== ')') return null;
    return { dest, title, end: j + 1, destEnd };
  }
  return { dest, title, end: j, destEnd };
}

// Remove backslash escapes (\X -> X for ASCII punctuation X).
function unescapeBackslash(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; }
    else { out += s[i]; i++; }
  }
  return out;
}

// Expand tabs in the leading whitespace of s to spaces, given s starts at
// absolute column startCol.
function expandLeadingTabsCol(s, startCol) {
  let i = 0, col = startCol;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === '\t') col += 4 - (col % 4);
    else col++;
    i++;
  }
  if (i === 0) return s;
  return ' '.repeat(col - startCol) + s.slice(i);
}

// Expand tabs to spaces in the leading whitespace of a line only (tabs in
// content are preserved). Column-based, starting at column 0.
function expandLeadingTabs(line) {
  return expandLeadingTabsCol(line, 0);
}

// Expand tabs to spaces (next multiple of 4) per line, as CommonMark
// preprocessing does, so all column arithmetic is space-based.
function expandTabs(line) {
  if (line.indexOf('\t') === -1) return line;
  let out = '', col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else { out += c; col++; }
  }
  return out;
}

// ---------- block parsing ----------
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
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Remove n columns from the start of a line; a tab straddling the boundary
// leaves the remainder as spaces.
function stripCols(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else { return ' '.repeat(col + w - n) + line.slice(i + 1); }
    } else break;
  }
  return line.slice(i);
}
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_HR = /^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/;
const RE_BULLET = /^ {0,3}([*+-])(?:[ \t]+(.*))?$/s;
const RE_ORDERED = /^ {0,3}(\d{1,9})([.)])(?:[ \t]+(.*))?$/s;
const RE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
const RE_EMAIL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const RE_HTML1 = /^ {0,3}<(pre|script|style|textarea)(?:[ \t>]|$)/i;
const RE_HTML6 = /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t>\/]|$)/i;
const RE_HTML7 = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t\n\r"'=<>`]+|'[^'\n\r]*'|"[^"\n\r]*"))?)*[ \t]*\/?|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*)>[ \t]*$/;
const RE_DELIM_ROW = /^ {0,3}\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

class Doc {
  constructor(src) {
    this.refs = new Map();
    this.rawLines = src.replace(/\r\n?/g, '\n').split('\n');
    this.lines = this.rawLines.map(expandLeadingTabs);
  }
  render() {
    const root = this.parseBlocks();
    return renderChildren(root.children, this.refs, false);
  }
  parseBlocks() {
    const root = { t: 'doc', children: [] };
    const open = [root]; // containers, then optionally a leaf at the end
    const lines = this.lines;
    let blankOpen = null;
    let prevLazy = false;

    const isLeaf = (b) => b && (b.t === 'para' || b.t === 'fence' || b.t === 'code' || b.t === 'html' || b.t === 'table');
    const leaf = () => { const b = open[open.length - 1]; return isLeaf(b) ? b : null; };
    const container = () => open[open.length - 1];

    const finalize = (b) => {
      if (b.t === 'para') {
        const raw = b.lines.join('\n');
        const rest = this.extractRefDefs(raw);
        b.text = rest;
        b.lines = null;
      } else if (b.t === 'code') {
        while (b.lines.length && isBlank(b.lines[b.lines.length - 1])) b.lines.pop();
        b.text = b.lines.join('\n');
        if (b.text) b.text += '\n';
        b.lines = null;
      } else if (b.t === 'list') {
        let loose = false;
        for (let k = 0; k < b.children.length; k++) {
          const it = b.children[k];
          for (let m = 1; m < it.children.length; m++) {
            if (it.children[m].blankBefore) { loose = true; break; }
          }
          if (loose) break;
          if (k < b.children.length - 1 && it.trailingBlank) { loose = true; break; }
        }
        b.tight = !loose;
      }
    };
    const closeFrom = (depth) => {
      while (open.length > depth) finalize(open.pop());
    };
    const addBlock = (b, parent) => {
      b.blankBefore = blankOpen !== null && blankOpen.includes(parent);
      parent.children.push(b);
      return b;
    };

    for (let ln = 0; ln < lines.length; ln++) {
      const line = lines[ln];
      const wasLazy = prevLazy;
      prevLazy = false;
      const blank = isBlank(line);
      // Phase 1: container matching
      let depth = 1;
      let rest = line;
      let matchedAll = true;
      const lfTop = open[open.length - 1];
      while (depth < open.length) {
        const b = open[depth];
        if (b.t === 'blockquote') {
          const m = /^ {0,3}>/.exec(rest);
          if (!m) { matchedAll = false; break; }
          rest = rest.slice(m[0].length);
          rest = expandLeadingTabsCol(rest, m[0].length);
          if (rest[0] === ' ') rest = rest.slice(1);
          depth++;
        } else if (b.t === 'item') {
          if (blank) { depth++; continue; }
          // an empty item does not continue after a blank line
          if (b.children.length === 0 && b.trailingBlank) { matchedAll = false; break; }
          const ind = indentOf(rest);
          if (ind >= b.contentIndent) { rest = stripCols(rest, b.contentIndent); depth++; }
          else if (lfTop && lfTop.t === 'fence') {
            // a fenced code block absorbs the line as content even when
            // it does not match the enclosing list item's indent (the
            // fence only closes on a matching fence line); keep every
            // container open and let the fence feeder handle the line
            depth = open.length; break;
          }
          else { matchedAll = false; break; }
        } else if (b.t === 'list') { depth++; }
        else break;
      }
      const lf = leaf();
      // a line that is blank after container markers were removed counts
      // as a blank line when nothing remains, or when only whitespace
      // remains and no paragraph is open to absorb it (">  " leaves a
      // space, which is paragraph content, not a blank line)
      const blankLine = blank || rest === '' || (isBlank(rest) && !(lf && lf.t === 'para'));
      if (blankLine) {
        // a blank line inside a code block / fence is part of it, but only
        // when the line matched the block's containers (a blank line that
        // did not match an enclosing blockquote ends that block instead)
        if (lf && (lf.t === 'code' || lf.t === 'fence') && depth >= open.length - 1) {
          lf.lines.push(lf.t === 'fence' ? stripCols(rest, lf.indent) : stripCols(rest, 4));
          continue;
        }
        // a blank line inside a raw html block (types 1-5) is preserved
        if (lf && lf.t === 'html' && lf.kind >= 1 && lf.kind <= 5 && depth >= open.length - 1) {
          lf.lines.push('');
          continue;
        }
        // a blank line ends an html block of type 6/7 (but not the
        // trailing empty artifact of the final newline)
        if (lf && lf.t === 'html' && ln < lines.length - 1) { lf.noTrailNL = true; open.pop(); }
        if (lf && lf.t === 'para') { finalize(open.pop()); }
        if (lf && lf.t === 'table') { closeFrom(depth); }
        // a blank line that did not match the containers closes a code /
        // fence leaf as well
        if (lf && (lf.t === 'code' || lf.t === 'fence')) { finalize(open.pop()); }
        // a blank line ends any blockquote it did not match
        while (open.length > 1 && open.length - 1 >= depth) {
          const top = open[open.length - 1];
          if (top.t === 'blockquote') open.pop();
          else break;
        }
        // a blank line marks the innermost matched item as trailing-blank
        // (a blank line nested inside a blockquote or sub-list does not
        // loosen the outer list)
        if (depth - 1 >= 1 && open[depth - 1] && open[depth - 1].t === 'item') open[depth - 1].trailingBlank = true;
        blankOpen = open.slice();
        continue;
      }
      if (!matchedAll) {
        // a line that starts a new block which can interrupt a paragraph is
        // NOT a lazy continuation line
        if (lf && lf.t === 'para' && !startsBlockInterrupting(rest, lf, open)) {
          // a lazy line indented 4+ spaces loses the 4-space code indent
          if (indentOf(rest) >= 4) rest = stripCols(rest, 4);
          // marked quirk: a lazy setext-underline line in a blockquote that
          // follows another lazy line is indented 4 spaces (so the recursive
          // lex does not read it as a setext heading)
          if (wasLazy && /^ {0,3}=+[ \t]*$/.test(rest)) {
            let inQ = false;
            for (let d = 1; d < open.length; d++) if (open[d].t === 'blockquote') { inQ = true; break; }
            if (inQ) rest = '    ' + rest;
          }
          lf.lines.push(rest);
          prevLazy = true;
          continue;
        }
        closeFrom(depth);
      }
      // feed open leaf blocks
      const cur = leaf();
      if (cur && cur.t === 'fence') {
        const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(rest);
        if (m && m[1][0] === cur.fenceCh && m[1].length >= cur.fenceLen) {
          finalize(open.pop());
        } else {
          // top-level fence: strip the indent from the RAW line so tabs in
          // the code content survive (stripCols is tab-aware)
          const parent = open.length >= 2 ? open[open.length - 2] : null;
          const src = (parent && parent.t === 'doc') ? this.rawLines[ln] : rest;
          cur.lines.push(stripCols(src, cur.indent));
        }
        continue;
      }
      if (cur && cur.t === 'html') {
        cur.lines.push(rest);
        if (cur.endRe && cur.endRe.test(rest)) {
          // no trailing newline when the next line is a real blank line
          // (ignore the trailing empty artifact of the final newline)
          if (ln + 1 < lines.length - 1 && isBlank(lines[ln + 1])) cur.noTrailNL = true;
          finalize(open.pop());
        }
        continue;
      }
      if (cur && cur.t === 'code') {
        if (indentOf(rest) >= 4) {
          const parent = open.length >= 2 ? open[open.length - 2] : null;
          const src = (parent && parent.t === 'doc') ? this.rawLines[ln] : rest;
          cur.lines.push(stripCols(src, 4)); continue;
        }
        finalize(open.pop());
      }
      if (cur && cur.t === 'table') {
        if (!startsBlock(rest, leaf())) {
          cur.rows.push(splitCells(rest));
          continue;
        }
        finalize(open.pop());
      }
      // Phase 2: new block starts (loop for containers)
      let r = rest;
      for (;;) {
        // parent for a new block: innermost open container (a trailing leaf
        // is not a container, so skip it)
        const parent = isLeaf(open[open.length - 1]) ? open[open.length - 2] : open[open.length - 1];
        // a list only continues with a list item of the same type; a
        // thematic break takes precedence over a list marker
        if (parent.t === 'list') {
          const li0 = listItemStart(r, leaf());
          if (RE_HR.test(r) || !(li0 && li0.bullet === parent.bullet && li0.delim === parent.delim && li0.marker === parent.marker)) {
            closeFrom(open.length - 1);
            continue;
          }
        }
        const par = leaf();
        // fenced code
        const fm = RE_FENCE.exec(r);
        if (fm && !(fm[1][0] === '`' && r.slice(fm[0].length).includes('`'))) {
          if (par && par.t === 'para') finalize(open.pop());
          const fb = { t: 'fence', fenceCh: fm[1][0], fenceLen: fm[1].length, info: unescapeBackslash(r.slice(fm[0].length).trim()), indent: indentOf(r), lines: [] };
          addBlock(fb, parent); open.push(fb);
          break;
        }
        // html block
        const hm = htmlBlockStart(r, par);
        if (hm) {
          if (par && par.t === 'para') finalize(open.pop());
          const hb = { t: 'html', kind: hm.kind, endRe: hm.endRe, lines: [r], noTrailNL: parent.t !== 'doc' };
          addBlock(hb, parent); open.push(hb);
          if (hm.endRe && hm.endRe.test(r)) {
            if (ln + 1 < lines.length - 1 && isBlank(lines[ln + 1])) hb.noTrailNL = true;
            finalize(open.pop());
          }
          break;
        }
        // ATX heading
        const am = RE_ATX.exec(r);
        if (am) {
          if (par && par.t === 'para') finalize(open.pop());
          let text = am[2] === undefined ? '' : am[2];
          text = text.replace(/[ \t]+$/, '').replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+$/, '');
          if (/^#+$/.test(text)) text = '';
          addBlock({ t: 'heading', level: am[1].length, text }, parent);
          break;
        }
        // setext heading (only when a paragraph is open)
        if (par && par.t === 'para') {
          const sm = RE_SETEXT.exec(r);
          if (sm) {
            const p = open.pop();
            const raw = p.lines.join('\n');
            const rest = this.extractRefDefs(raw);
            const ls = rest.split('\n');
            if (ls.length) ls[0] = ls[0].replace(/^[ \t]+/, '');
            const text = ls.join('\n').replace(/[ \t]+$/, '');
            if (text) {
              addBlock({ t: 'heading', level: sm[1][0] === '=' ? 1 : 2, text }, parent);
              break;
            }
            // the paragraph was only link reference definitions: the
            // setext line is not a heading underline; reprocess it
            continue;
          }
        }
        // thematic break
        if (RE_HR.test(r)) {
          if (par && par.t === 'para') finalize(open.pop());
          addBlock({ t: 'hr' }, parent);
          break;
        }
        // list item (only if it can interrupt an open paragraph)
        const li = listItemStart(r, par);
        if (li && (!par || par.t !== 'para' || listCanInterrupt(li, open))) {
          if (par && par.t === 'para') finalize(open.pop());
          let list = null;
          const pc = container();
          if (pc.t === 'list' && pc.bullet === li.bullet && pc.delim === li.delim) list = pc;
          else {
            list = { t: 'list', bullet: li.bullet, delim: li.delim, start: li.start, marker: li.marker, children: [] };
            addBlock(list, pc);
            open.push(list);
          }
          const item = { t: 'item', contentIndent: li.contentIndent, children: [], trailingBlank: false };
          // a blank line directly before this item separates it from the
          // previous item of the same list, so that item ends blank and
          // the list is loose (blankOpen is cleared after each non-blank
          // line, so this only fires for an immediately preceding blank)
          if (list.children.length && blankOpen !== null && blankOpen.includes(list)) {
            // a blank line nested inside a blockquote does not separate
            // items of this list (it belongs to the quote, not the list)
            const innermost = blankOpen[blankOpen.length - 1];
            if (!innermost || innermost.t !== 'blockquote') {
              list.children[list.children.length - 1].trailingBlank = true;
            }
          }
          list.children.push(item);
          open.push(item);
          r = li.rest;
          if (r === '') break;
          continue;
        }
        // blockquote
        const qm = /^ {0,3}>/.exec(r);
        if (qm) {
          if (par && par.t === 'para') finalize(open.pop());
          const qb = { t: 'blockquote', children: [] };
          addBlock(qb, parent); open.push(qb);
          r = r.slice(qm[0].length);
          r = expandLeadingTabsCol(r, qm[0].length);
          if (r[0] === ' ') r = r.slice(1);
          if (r === '') break;
          continue;
        }
        // indented code (not interrupting a paragraph)
        if ((!par || par.t !== 'para') && indentOf(r) >= 4) {
          const src = (parent && parent.t === 'doc') ? this.rawLines[ln] : r;
          const cb = { t: 'code', lines: [stripCols(src, 4)] };
          addBlock(cb, parent); open.push(cb);
          break;
        }
        // paragraph (new or continuation)
        if (par && par.t === 'para') {
          if (par.lines.length === 1 && par.lines[0].indexOf('|') !== -1 && RE_DELIM_ROW.test(r)) {
            const header = splitCells(par.lines[0]);
            const aligns = parseAligns(r, header.length);
            if (aligns) {
              open.pop();
              const tb = { t: 'table', aligns, header, rows: [] };
              const p2 = container();
              p2.children.pop();
              addBlock(tb, p2); open.push(tb);
              break;
            }
          }
          par.lines.push(r);
        } else {
          const pb = { t: 'para', lines: [r] };
          addBlock(pb, parent); open.push(pb);
        }
        break;
      }
      // a blank line only separates the block created on the very next
      // non-blank line; clear it so later blocks do not inherit it
      blankOpen = null;
    }
    closeFrom(1);
    // An HTML block that ends the document carries a trailing newline only
    // if the source itself ends with one.
    const last = root.children[root.children.length - 1];
    if (last && last.t === 'html' && lines.length && lines[lines.length - 1] !== '') last.noTrailNL = true;
    return root;
  }
  extractRefDefs(text) {
    const refs = this.refs;
    let pos = 0;
    const n = text.length;
    while (pos < n) {
      let j = pos, col = 0;
      while (j < n && (text[j] === ' ' || text[j] === '\t') && col < 3) {
        col += text[j] === '\t' ? 4 - (col % 4) : 1;
        j++;
      }
      if (j >= n || text[j] !== '[') break;
      const le = findLabelEnd(text, j);
      if (le === -1 || le === -2) break;
      const rawLabel = text.slice(j + 1, le);
      const label = normLabel(rawLabel);
      if (!label) break;
      // A reference-definition label cannot contain an unescaped '['
      // (outside a code span); e.g. [ref[bar]] is not a definition.
      if (labelHasBracket(rawLabel)) break;
      let k = le + 1;
      if (k >= n || text[k] !== ':') break;
      k++;
      const t = parseLinkTarget(text, k, false);
      if (!t) break;
      let e = t.end;
      while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
      if (e < n && text[e] !== '\n') {
        // trailing junk after the title: the title is invalid, retry
        // with the destination alone
        if (t.title !== null) {
          e = t.destEnd;
          while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
          if (e < n && text[e] !== '\n') break;
          if (!refs.has(label)) refs.set(label, { dest: t.dest, title: null });
          pos = e < n ? e + 1 : e;
          continue;
        }
        break;
      }
      if (!refs.has(label)) refs.set(label, { dest: t.dest, title: t.title });
      pos = e < n ? e + 1 : e;
    }
    return text.slice(pos);
  }
}

// Can a list marker interrupt an open paragraph? Inside a list item, any
// marker can; at the top level, only a non-empty bullet or an ordered list
// starting with 1.
function listCanInterrupt(li, open) {
  if (open) {
    for (let d = 0; d < open.length; d++) if (open[d].t === 'list') return true;
  }
  if (li.rest === '') return false;
  if (li.bullet) return true;
  return li.start === 1;
}

// Can the line start a block that can interrupt a paragraph (so it is not a
// lazy continuation line)? Setext and indented code cannot; html type 7 cannot.
function startsBlockInterrupting(r, par, open) {
  if (RE_FENCE.test(r)) return true;
  const h = htmlBlockStart(r, par);
  if (h && h.kind !== 7) return true;
  if (RE_ATX.test(r)) return true;
  if (RE_HR.test(r)) return true;
  const li = listItemStart(r, par);
  if (li) return listCanInterrupt(li, open);
  if (/^ {0,3}>/.test(r)) return true;
  return false;
}

// Can the line start a block (used to end a table)?
function startsBlock(r, par) {
  if (RE_FENCE.test(r)) return true;
  if (htmlBlockStart(r, par)) return true;
  if (RE_ATX.test(r)) return true;
  if (RE_HR.test(r)) return true;
  if (listItemStart(r, par)) return true;
  if (/^ {0,3}>/.test(r)) return true;
  return false;
}

function htmlBlockStart(r, par) {
  if (RE_HTML1.test(r)) return { kind: 1, endRe: /<\/(pre|script|style|textarea)>/i };
  if (/^ {0,3}<!--/.test(r)) return { kind: 2, endRe: /-->/ };
  if (/^ {0,3}<\?/.test(r)) return { kind: 3, endRe: /\?>/ };
  if (/^ {0,3}<![A-Za-z]/.test(r)) return { kind: 4, endRe: />/ };
  if (/^ {0,3}<!\[CDATA\[/.test(r)) return { kind: 5, endRe: /\]\]>/ };
  if (RE_HTML6.test(r)) return { kind: 6, endRe: null };
  if (!par && RE_HTML7.test(r)) return { kind: 7, endRe: null };
  return null;
}

// Parse a list item start. Returns {bullet, delim, start, contentIndent, rest} or null.
function listItemStart(r, par) {
  // Expand the whitespace run after the marker to spaces (column-based,
  // markerEnd is the absolute column of the run's start), so a tab
  // straddling a boundary is handled correctly.
  const expandWsAfter = (markerEnd) => {
    let j = markerEnd;
    let col = markerEnd, cols = 0;
    let expanded = '';
    while (j < r.length && (r[j] === ' ' || r[j] === '\t')) {
      if (r[j] === '\t') { const w = 4 - (col % 4); expanded += ' '.repeat(w); cols += w; col += w; }
      else { expanded += ' '; cols++; col++; }
      j++;
    }
    return { j, cols, expanded };
  };
  let m = RE_BULLET.exec(r);
  if (m) {
    const markerLen = 1;
    const markerIdx = r.indexOf(m[1]);
    const markerEnd = markerIdx + 1;
    const w = expandWsAfter(markerEnd);
    const empty = w.j >= r.length;
    let contentIndent, rest;
    if (empty) { contentIndent = markerIdx + markerLen + 1; rest = ''; }
    else if (w.cols >= 5) { contentIndent = markerIdx + markerLen + 1; rest = w.expanded.slice(1) + r.slice(w.j); }
    else { contentIndent = markerIdx + markerLen + w.cols; rest = r.slice(w.j); }
    return { bullet: true, delim: null, start: null, marker: m[1], contentIndent, rest };
  }
  m = RE_ORDERED.exec(r);
  if (m) {
    const markerLen = m[1].length + 1;
    const markerIdx = r.indexOf(m[1]);
    const markerEnd = markerIdx + m[1].length + 1;
    const w = expandWsAfter(markerEnd);
    const empty = w.j >= r.length;
    const startNum = parseInt(m[1], 10);
    let contentIndent, rest;
    if (empty) { contentIndent = markerIdx + markerLen + 1; rest = ''; }
    else if (w.cols >= 5) { contentIndent = markerIdx + markerLen + 1; rest = w.expanded.slice(1) + r.slice(w.j); }
    else { contentIndent = markerIdx + markerLen + w.cols; rest = r.slice(w.j); }
    return { bullet: false, delim: m[2], start: startNum, contentIndent, rest };
  }
  return null;
}

// Split a table row line into cells (skipping code spans, handling \|).
function splitCells(line) {
  let cells = [];
  let cur = '', i = 0;
  let s = line.trimStart();
  if (s[0] === '|') s = s.slice(1);
  s = s.trimEnd();
  if (s.length && s[s.length - 1] === '|' && s[s.length - 2] !== '\\') s = s.slice(0, -1);
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === C_BSL && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === C_BT) {
      let k = i; while (k < s.length && s.charCodeAt(k) === C_BT) k++;
      const run = k - i;
      let p = k, found = -1;
      while (p < s.length) {
        if (s.charCodeAt(p) === C_BT) {
          let q = p; while (q < s.length && s.charCodeAt(q) === C_BT) q++;
          if (q - p === run) { found = p; break; }
          p = q;
        } else p++;
      }
      if (found === -1) { cur += s.slice(i, k); i = k; continue; }
      // copy the code span, unescaping \| -> | inside it (an escaped pipe
      // in a table cell is a literal pipe, even inside a code span)
      cur += s.slice(i, found + run).replace(/\\\|/g, '|'); i = found + run; continue;
    }
    if (c === C_PIPE) { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  cells.push(cur.trim());
  return cells;
}
function parseAligns(line, ncols) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  if (cells.length < ncols) return null;
  const aligns = [];
  for (let k = 0; k < ncols; k++) {
    const c = cells[k].trim();
    if (!/^:?-+:?$/.test(c)) return null;
    aligns.push(c[0] === ':' && c[c.length - 1] === ':' ? 'center' : c[c.length - 1] === ':' ? 'right' : c[0] === ':' ? 'left' : null);
  }
  return aligns;
}

// ---------- rendering ----------
function renderChildren(children, refs, tightParent) {
  let out = '';
  for (const b of children) out += renderBlock(b, refs, tightParent);
  return out;
}
function renderBlock(b, refs, tightParent) {
  switch (b.t) {
    case 'blockquote': return '<blockquote>\n' + renderChildren(b.children, refs, false) + '</blockquote>\n';
    case 'list': {
      const tag = b.bullet ? 'ul' : 'ol';
      let h = '<' + tag;
      if (!b.bullet && b.start !== null && b.start !== 1) h += ' start="' + b.start + '"';
      h += '>\n';
      for (const it of b.children) h += renderItem(it, refs, b.tight);
      return h + '</' + tag + '>\n';
    }
    case 'heading': return '<h' + b.level + '>' + parseInline(b.text, refs).html + '</h' + b.level + '>\n';
    case 'fence': {
      let lang = '';
      if (b.info) lang = b.info.split(/[ \t]/)[0];
      let end = b.lines.length;
      // drop a single trailing empty line (the newline before the closing
      // fence); earlier blank lines are content
      if (end > 0 && b.lines[end - 1] === '') end--;
      const content = end ? b.lines.slice(0, end).join('\n') + '\n' : '';
      return '<pre><code' + (lang ? ' class="language-' + escAttr(lang) + '"' : '') + '>' + escText(content) + '</code></pre>\n';
    }
    case 'code': return '<pre><code>' + escText(b.text) + '</code></pre>\n';
    case 'html': {
      let end = b.lines.length;
      while (end > 0 && b.lines[end - 1] === '') end--;
      if (!end) return '';
      const content = b.lines.slice(0, end).join('\n');
      return b.noTrailNL ? content : content + '\n';
    }
    case 'hr': return '<hr>\n';
    case 'para': {
      if (!b.text) return '';
      if (tightParent) return parseInline(b.text, refs).html;
      return '<p>' + parseInline(b.text, refs).html + '</p>\n';
    }
    case 'table': {
      let h = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.header.length; k++) {
        const a = b.aligns[k];
        h += '<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(b.header[k], refs).html + '</th>\n';
      }
      h += '</tr>\n</thead>\n';
      if (b.rows.length) {
        h += '<tbody>';
        for (const row of b.rows) {
          h += '<tr>\n';
          for (let k = 0; k < b.header.length; k++) {
            const a = b.aligns[k];
            const cell = k < row.length ? row[k] : '';
            h += '<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(cell, refs).html + '</td>\n';
          }
          h += '</tr>\n';
        }
        h += '</tbody>';
      }
      return h + '</table>\n';
    }
    default: return '';
  }
}
function renderItem(it, refs, tight) {
  let h = '<li>';
  const kids = it.children;
  for (let k = 0; k < kids.length; k++) {
    const b = kids[k];
    if (k === 0 && b.t === 'para') {
      const m = /^\[([ xX])\] /.exec(b.text);
      if (m) {
        const checked = m[1] !== ' ';
        const rest = b.text.slice(m[0].length);
        const input = '<input' + (checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ';
        if (tight) h += input + parseInline(rest, refs).html;
        else h += '<p>' + input + parseInline(rest, refs).html + '</p>\n';
        continue;
      }
      h += renderBlock(b, refs, tight);
    } else {
      h += renderBlock(b, refs, tight);
    }
  }
  return h + '</li>\n';
}
