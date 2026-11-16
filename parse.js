// parse.js — a from-scratch CommonMark 0.31.2 + GFM renderer, byte-compatible with
// marked 18.1.3 (default options: gfm on, breaks off). Single file, no dependencies.
// Derived from the marked reference rules (regexes + algorithms) and re-written here
// in my own structure: a block tokenizer, an inline tokenizer and a direct renderer.
// No caching across calls: parse() keeps nothing from an earlier call.

export function parse(src) {
  return new Lexer().run(src);
}

// ---------------------------------------------------------------------------
// Small utilities

// Regex template builder: substitute a named piece into a pattern source, dropping
// the piece's leading ^ anchor (the template already anchors at the start).
function rx(tpl, flags) {
  let s = typeof tpl === 'string' ? tpl : tpl.source;
  const api = {
    sub(name, rep) {
      const r = typeof rep === 'string' ? rep : rep.source;
      s = s.split(name).join(r.replace(/(^|[^\[])\^/g, '$1'));
      return api;
    },
    done() { return new RegExp(s, flags || ''); },
  };
  return api;
}

// Memoised factory for the small indent-dependent regexes. Marked's cache
// builds the regex from the CLAMPED index, not the requested indent, so
// nextBulletRegex(2) is really `^ {0,1}...` — kept exactly as-is.
function cached(fn) {
  const box = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return box[i] || (box[i] = fn(i));
  };
}

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const listItemRegexCache = new Map();

const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  setextUnderline: /\n {0,3}[=-]/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharRef: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharRefOrAmp: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => { const box = listItemRegexCache; let re = box.get(bull); if (!re) { re = new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`); box.set(bull, re); } return re; },
  nextBulletRegex: cached((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: cached((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`)),
  fencesBeginRegex: cached((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cached((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cached((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cached((n) => new RegExp(`^ {0,${n}}>`)),
};

// ---------------------------------------------------------------------------
// Block rules (GFM set)

const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLOCK_BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

const BLOCK_HTML = rx(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))',
  'i',
)
  .sub('comment', BLOCK_HTML_COMMENT)
  .sub('tag', BLOCK_TAGS)
  .sub('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .done();

const LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BLOCK_DEF = rx(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
)
  .sub('label', LABEL)
  .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)/)
  .done();

const BLOCK_LIST = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).sub('bull', BLOCK_BULLET).done();

const BLOCK_TEXT_SRC =
  '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
const BLOCK_HTML_START =
  ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

function paragraphRegex(listPat, tableRep) {
  const b = rx(BLOCK_TEXT_SRC)
    .sub('hr', BLOCK_HR)
    .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .sub('|lheading', '');
  // GFM keeps the table alternative (replaced by the table rule); the plain
  // paragraph drops the whole `|table` alternative from the lookahead.
  if (tableRep) b.sub('table', tableRep);
  else b.sub('|table', '');
  return b
    .sub('blockquote', ' {0,3}>')
    .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .sub('list', listPat)
    .sub('html', BLOCK_HTML_START)
    .sub('tag', BLOCK_TAGS)
    .done();
}

const BLOCK_TABLE = rx(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
)
  .sub('hr', BLOCK_HR)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('blockquote', ' {0,3}>')
  .sub('code', '(?: {4}| {0,3}\t)[^\\n]')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .sub('html', BLOCK_HTML_START)
  .sub('tag', BLOCK_TAGS)
  .done();

const SETEXT_SRC =
  '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
const BLOCK_SETEXT = rx(SETEXT_SRC)
  .sub('bull', BLOCK_BULLET)
  .sub('blockCode', /(?: {4}| {0,3}\t)/)
  .sub('fences', / {0,3}(?:`{3,}|~{3,})/)
  .sub('blockquote', / {0,3}>/)
  .sub('heading', / {0,3}#{1,6}(?:\s|$)/)
  .sub('hr', / {0,3}(?:(?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})(?:\n+|$)/)
  .sub('html', / {0,3}<[^\n>]+>\n/)
  .sub('table', / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .done();

const BLOCK_PARAGRAPH = paragraphRegex(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, BLOCK_TABLE);
const BLOCK_QUOTE = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).sub(
  'paragraph',
  paragraphRegex(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, ''),
).done();

const BLOCK = {
  newline: BLOCK_NEWLINE,
  code: BLOCK_CODE,
  fences: BLOCK_FENCES,
  hr: BLOCK_HR,
  heading: BLOCK_HEADING,
  blockquote: BLOCK_QUOTE,
  list: BLOCK_LIST,
  html: BLOCK_HTML,
  def: BLOCK_DEF,
  table: BLOCK_TABLE,
  lheading: BLOCK_SETEXT,
  paragraph: BLOCK_PARAGRAPH,
  text: /^[^\n]+/,
};

// ---------------------------------------------------------------------------
// Inline rules (GFM set)

const IN_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const IN_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const IN_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NT = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NT = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_T = /(?:[^\s\p{P}\p{S}]|~)/u;
const PUNCT_TEST = rx(/^((?![*_])punctSpace)/, 'u').sub('punctSpace', PUNCT_SPACE).done();
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

const LDELIM_SRC = '^(?:\\*+(?:((?!\\*)punct)|([^\\s*]))?)|^_+(?:((?!_)punct)|([^\\s_]))?';
const IN_EM_LDELIM = rx(LDELIM_SRC, 'u').sub('punct', PUNCT_NT).done();
const RDELIM_AST_SRC =
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const IN_EM_RDELIM_AST = rx(RDELIM_AST_SRC, 'gu')
  .sub('notPunctSpace', NOT_PUNCT_SPACE_T)
  .sub('punctSpace', PUNCT_SPACE_NT)
  .sub('punct', PUNCT_NT)
  .done();
const RDELIM_UND_SRC =
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
const IN_EM_RDELIM_UND = rx(RDELIM_UND_SRC, 'gu')
  .sub('notPunctSpace', NOT_PUNCT_SPACE)
  .sub('punctSpace', PUNCT_SPACE)
  .sub('punct', PUNCT)
  .done();
const IN_DEL_LDELIM = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').sub('punct', PUNCT).done();
const DEL_RDELIM_SRC =
  "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
const IN_DEL_RDELIM = rx(DEL_RDELIM_SRC, 'gu')
  .sub('notPunctSpace', NOT_PUNCT_SPACE)
  .sub('punctSpace', PUNCT_SPACE)
  .sub('punct', PUNCT)
  .done();

const IN_AUTOLINK = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .sub('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .sub(
    'email',
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
  )
  .done();

const IN_TAG = rx(
  '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
)
  .sub('comment', rx(BLOCK_HTML_COMMENT).sub('(?:-->|$)', '-->').done())
  .sub('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .done();

const BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INNER = rx(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
)
  .sub('brackets', BRACKETS)
  .done();
const IN_LINK = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .sub('label', LABEL_INNER)
  .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .done();
const IN_REFLINK = rx(/^!?\[(label)\]\[(ref)\]/).sub('label', LABEL_INNER).sub('ref', LABEL).done();
const IN_NOLINK = rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', LABEL).done();
const LT_SRC =
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const BE_SRC = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const IN_REFLINK_SEARCH = rx('reflink|nolink(?!\\()', 'g')
  .sub(
    'reflink',
    rx(/^!?\[(label)\]\[(ref)\]/)
      .sub('label', rx(LT_SRC).sub('brackets', BRACKETS).done())
      .sub('ref', BE_SRC)
      .done(),
  )
  .sub('nolink', rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', BE_SRC).done())
  .done();

const EMAIL_IT = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const PROTO_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const AT_PROTO = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).sub('email', EMAIL_IT).done();
const IN_URL = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .sub('emailProtocol', AT_PROTO)
  .sub('protocol', PROTO_RE)
  .sub('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .done();
const IN_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const IN_BLOCKSKIP = rx(/link|precode-code|html/, 'g')
  .sub('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .sub('precode-', '(?<!`)()')
  .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .sub('html', /<(?! )[^<>]*?>/)
  .done();
const IN_ANY_PUNCT = rx(/\\(punct)/, 'gu').sub('punct', PUNCT).done();
const IN_ANY_PUNCT_OUTSIDE_CODE = rx(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
  'gu',
)
  .sub('punct', PUNCT)
  .done();
const IN_TEXT = rx(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
)
  .sub('protocol', PROTO_RE)
  .sub('emailProtocol', /(?:mailto|xmpp):/)
  .sub('wwwStart', /(?<![^\s*_~(])www\./)
  .done();

const INLINE = {
  escape: IN_ESCAPE,
  code: IN_CODE,
  br: IN_BR,
  text: IN_TEXT,
  punctuation: PUNCT_TEST,
  emStrongLDelim: IN_EM_LDELIM,
  emStrongRDelimAst: IN_EM_RDELIM_AST,
  emStrongRDelimUnd: IN_EM_RDELIM_UND,
  delLDelim: IN_DEL_LDELIM,
  delRDelim: IN_DEL_RDELIM,
  autolink: IN_AUTOLINK,
  tag: IN_TAG,
  link: IN_LINK,
  reflink: IN_REFLINK,
  nolink: IN_NOLINK,
  reflinkSearch: IN_REFLINK_SEARCH,
  url: IN_URL,
  _backpedal: IN_BACKPEDAL,
  blockSkip: IN_BLOCKSKIP,
  anyPunctuation: IN_ANY_PUNCT,
  anyPunctuationOutsideCode: IN_ANY_PUNCT_OUTSIDE_CODE,
};

// ---------------------------------------------------------------------------
// Text helpers

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s, encode) {
  if (encode) {
    if (O.escapeTest.test(s)) return s.replace(O.escapeReplace, (c) => ESC_MAP[c]);
  } else if (O.escapeTestNoEncode.test(s)) {
    return s.replace(O.escapeReplaceNoEncode, (c) => ESC_MAP[c]);
  }
  return s;
}

function decodeEnt(s) {
  if (!O.numericCharRef.test(s)) return s;
  return s.replace(O.numericCharRefOrAmp, (all, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 1114111 || (n >= 55296 && n <= 57343)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes; trim cells; pad/truncate to `count`.
function splitCells(row, count) {
  const marked = row.replace(O.findPipe, (ch, off, str) => {
    let odd = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') odd = !odd;
    return odd ? '|' : ' |';
  });
  const cells = marked.split(O.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  return cells;
}

// Trim trailing characters: with invert=false strip trailing `ch`; true: strip
// trailing chars that are NOT `ch`. (marked's L helper.)
function trimTrail(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Drop trailing blank lines, keeping at most one trailing blank line's worth.
function trimBlankLines(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && O.blankLine.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Normalise a link reference label: trim, collapse whitespace, case-fold.
function normLabel(s) {
  return s.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the closing char of a balanced pair, or -2 when unbalanced, -1 none.
function parenIdx(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// First line of `s` (up to but not including the newline), without allocating
// a split array. Identical to `s.split('\n', 1)[0]`.
function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// Expand tabs to spaces, tracking the column from `col`.
function tabExpand(s, col = 0) {
  let n = col;
  let out = '';
  for (const c of s) {
    if (c === '\t') {
      const w = 4 - (n % 4);
      out += ' '.repeat(w);
      n += w;
    } else {
      out += c;
      n++;
    }
  }
  return out;
}

// Remove the fence's leading indent from a fenced code block's lines.
function fenceIndent(raw, code) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return code;
  const ind = m[1];
  return code
    .split('\n')
    .map((line) => {
      const o = line.match(O.beginningSpace);
      if (o === null) return line;
      const [sp] = o;
      return line.slice(Math.min(sp.length, ind.length));
    })
    .join('\n');
}

// Does `label` (at offset n in the full remaining string) contain a link-like
// `<...>` that the inline tag/autolink rules would eat? (marked's Be helper.)
function hasLinkInText(full, label, n, rules) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const m = rules.code.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = full.slice(n + i);
    const m = rules.tag.exec(rest) || rules.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Block tokenizer — turns the remaining source into one block token at a time.
// The lexer drives it in marked's order: space, indented code, fences, heading,
// hr, blockquote, list, html, link definition, table, setext heading, paragraph,
// text. Methods return undefined when their rule does not match at the start.

class Tokenizer {
  constructor(lexer) {
    this.lexer = lexer;
  }

  space(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  code(src) {
    const m = BLOCK.code.exec(src);
    if (!m) return;
    const raw = trimBlankLines(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(O.codeRemoveIndent, '') };
  }

  fences(src) {
    const m = BLOCK.fences.exec(src);
    if (!m) return;
    return {
      type: 'code',
      raw: m[0],
      lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2],
      text: fenceIndent(m[0], m[3] || ''),
    };
  }

  heading(src) {
    const m = BLOCK.heading.exec(src);
    if (!m) return;
    let text = m[2].trim();
    if (O.endingHash.test(text)) {
      const stripped = trimTrail(text, '#');
      if (!stripped || O.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return {
      type: 'heading',
      raw: trimTrail(m[0], '\n'),
      depth: m[1].length,
      text,
      tokens: this.lexer.inline(text),
    };
  }

  hr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: trimTrail(m[0], '\n') };
  }

  blockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return;
    let raw = '';
    let text = '';
    const tokens = [];
    let lines = trimTrail(m[0], '\n').split('\n');
    while (lines.length > 0) {
      let inQuote = false;
      const chunk = [];
      let p = 0;
      for (; p < lines.length; p++) {
        if (O.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); inQuote = true; }
        else if (!inQuote) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const joined = chunk.join('\n');
      const cleaned = joined
        .replace(O.blockquoteMarkerWhitespace, (g, b, m2) => b + tabExpand(m2, b.length))
        .replace(O.blockquoteSetextReplace, '\n    $1')
        .replace(O.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${joined}` : joined;
      text = text ? `${text}\n${cleaned}` : cleaned;
      const savedTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(cleaned, tokens, true);
      this.lexer.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (
        last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' ||
        last?.type === 'html' || last?.type === 'table'
      ) break;
      if (last?.type === 'blockquote') {
        const prev = last;
        const rest = lines.join('\n');
        const combined = prev.raw + '\n' + rest.replace(O.blockquoteSetextReplace2, '');
        const inner = this.blockquote(combined);
        tokens[tokens.length - 1] = inner;
        const leftover = combined.substring(inner.raw.length).replace(/^\n/, '');
        const leftCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftCount ? lines.slice(0, -leftCount) : lines;
        if (consumed.length > 0) {
          raw = `${raw}\n${consumed.join('\n')}`;
          text = text.substring(0, text.length - prev.text.length) + inner.text;
          lines = lines.slice(consumed.length);
          if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
        }
        break;
      } else if (last?.type === 'list') {
        const prev = last;
        const combined = prev.raw + '\n' + lines.join('\n');
        const inner = this.list(combined);
        tokens[tokens.length - 1] = inner;
        const extra = inner.raw.length > prev.raw.length
          ? combined.slice(prev.raw.length + 1, inner.raw.length).split('\n').length
          : 0;
        if (extra > 0) {
          const y = lines.slice(0, extra).join('\n');
          raw = `${raw}\n${y}`;
          text = `${text}\n${y}`;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src) {
    const m = BLOCK.list.exec(src);
    if (!m) return;
    const orig = src;
    let rest = src;
    const used = () => orig.length - rest.length;
    const bullet = m[1].trim();
    const ordered = bullet.length > 1;
    const listTok = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +bullet.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    const bullPat = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = O.listItemRegex(bullPat);
    let sawBlank = false;
    while (rest) {
      let done = false;
      let itemText = '';
      const t = itemRe.exec(rest);
      if (!t || BLOCK.hr.test(rest)) break;
      const startAt = used();
      rest = rest.substring(t[0].length);
      const firstLine = firstLineOf(t[2]);
      const markerLen = t[1].length;
      let content = firstLine.replace(O.leadingSpaceTab, (v) => tabExpand(v, markerLen));
      let nextLine = firstLineOf(rest);
      let empty = !content.trim();
      let indent;
      if (empty) {
        indent = markerLen + 1;
      } else {
        indent = content.search(O.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemText = content.slice(indent);
        indent += markerLen;
      }
      if (empty && O.blankLine.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        done = true;
      }
      if (!done) {
        const nextBullet = O.nextBulletRegex(indent);
        const hrRe = O.hrRegex(indent);
        const fencesRe = O.fencesBeginRegex(indent);
        const headingRe = O.headingBeginRegex(indent);
        const htmlRe = O.htmlBeginRegex(indent);
        const quoteRe = O.blockquoteBeginRegex(indent);
        while (rest) {
          const line = firstLineOf(rest);
          let expanded;
          nextLine = line;
          expanded =
            line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9
              ? line.replace(O.leadingSpaceTab, (v) => tabExpand(v))
              : line;
          if (
            fencesRe.test(line) || headingRe.test(line) || htmlRe.test(line) ||
            quoteRe.test(line) || nextBullet.test(line) || hrRe.test(line)
          ) break;
          if (expanded.search(O.nonSpaceChar) >= indent || !line.trim()) {
            itemText += '\n' + expanded.slice(indent);
          } else {
            if (
              empty || content.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4 ||
              fencesRe.test(content) || headingRe.test(content) || htmlRe.test(content) || hrRe.test(content)
            ) break;
            const lazy = /^ {0,3}(?:=+|-+) *$/.test(line) &&
              BLOCK.lheading.test(`${content}\n${line}`)
              ? `    ${expanded.replace(/^ {0,3}/, '')}`
              : line;
            itemText += '\n' + lazy;
          }
          empty = !line.trim();
          rest = rest.substring(line.length + 1);
          content = expanded.slice(indent);
        }
      }
      const itemRaw = orig.slice(startAt, used());
      if (!listTok.loose) {
        if (sawBlank) listTok.loose = true;
        else if (O.doubleBlankLine.test(itemRaw)) sawBlank = true;
      }
      listTok.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: O.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const lastItem = listTok.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return;
    }
    listTok.raw = orig.slice(0, used()).trimEnd();
    for (const item of listTok.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!listTok.loose) {
        const spaces = item.tokens.filter((g) => g.type === 'space');
        listTok.loose = spaces.length > 0 && spaces.some((g) => O.anyLine.test(g.raw));
      }
    }
    for (const item of listTok.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(O.listReplaceTask, '');
        first.raw = first.raw.replace(O.listReplaceTask, '');
        first.text = first.text.replace(O.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (O.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(O.listReplaceTask, '');
            break;
          }
        }
        const cb = O.listTaskCheckbox.exec(item.raw);
        if (cb) {
          const box = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = box.checked;
          if (listTok.loose) {
            if (
              item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] && item.tokens[0].tokens
            ) {
              item.tokens[0].raw = box.raw + item.tokens[0].raw;
              item.tokens[0].text = box.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(box);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (listTok.loose) {
      for (const item of listTok.items) {
        item.loose = true;
        for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
    return listTok;
  }

  html(src) {
    const m = BLOCK.html.exec(src);
    if (!m) return;
    const raw = trimBlankLines(m[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      text: raw,
    };
  }

  def(src) {
    const m = BLOCK.def.exec(src);
    if (!m) return;
    if (!O.startAngleBracket.test(m[2]) && parenIdx(m[2], '()') !== -1) return;
    const tag = normLabel(m[1]);
    const href = m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = m[3]
      ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1')
      : m[3];
    return { type: 'def', tag, raw: trimTrail(m[0], '\n'), href, title };
  }

  table(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !O.tableDelimiter.test(m[2])) return;
    const headerCells = splitCells(m[1]);
    const aligns = m[2].replace(O.tableAlignChars, '').split('|');
    const rows = m[3]?.trim() ? m[3].replace(O.tableRowBlankLine, '').split('\n') : [];
    const tok = { type: 'table', raw: trimTrail(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length === aligns.length) {
      for (const a of aligns) {
        if (O.tableAlignRight.test(a)) tok.align.push('right');
        else if (O.tableAlignCenter.test(a)) tok.align.push('center');
        else if (O.tableAlignLeft.test(a)) tok.align.push('left');
        else tok.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        tok.header.push({
          text: headerCells[i],
          tokens: this.lexer.inline(headerCells[i]),
          header: true,
          align: tok.align[i],
        });
      }
      for (const r of rows) {
        tok.rows.push(
          splitCells(r, tok.header.length).map((cell, j) => ({
            text: cell,
            tokens: this.lexer.inline(cell),
            header: false,
            align: tok.align[j],
          })),
        );
      }
      return tok;
    }
  }

  lheading(src) {
    const m = BLOCK.lheading.exec(src);
    if (!m) return;
    const text = m[1].trim();
    return {
      type: 'heading',
      raw: trimTrail(m[0], '\n'),
      depth: m[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: this.lexer.inline(text),
    };
  }

  paragraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (!m) return;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
  }

  text(src) {
    const m = BLOCK.text.exec(src);
    if (!m) return;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }
}

// ---------------------------------------------------------------------------
// Inline tokenizer — one inline token at a time, in marked's order: escape,
// html tag, link, reference link, emphasis, code span, hard break, strikethrough,
// autolink, extended url, text. `masked` is the emphasis-mask of the full
// source (same length as the source); the raw spans always come from `src`.

function makeLink(m, ref, raw, lx) {
  const href = ref.href;
  const title = ref.title || null;
  const text = m[1].replace(O.outputLinkReplace, '$1');
  const isImage = m[0].charAt(0) === '!';
  const savedInLink = lx.state.inLink;
  const savedEmitted = lx.state.linkEmitted;
  const savedRaw = lx.state.inRawBlock;
  lx.state.inLink = true;
  lx.state.linkEmitted = false;
  const inner = lx.inlineTokens(text);
  const emitted = lx.state.linkEmitted;
  lx.state.linkEmitted = savedEmitted;
  lx.state.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      lx.state.inRawBlock = savedRaw;
      return;
    }
    lx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens: inner };
}

// Last `*`/`_`/`~` run starts in a string, for the emphasis closer search.
function scanMask(s) {
  const lastEm = { '*': -1, '_': -1 };
  let lastDel = -1;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    const prev = i === 0 ? '\n' : s[i - 1];
    let j = i + 1;
    while (j < n && s[j] === c) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (c === '~') lastDel = i;
      else lastEm[c] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: s, lastEm, lastDel };
}

Object.assign(Tokenizer.prototype, {
  escape(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  },

  tag(src) {
    const m = INLINE.tag.exec(src);
    if (!m) return;
    const st = this.lexer.state;
    if (!st.inLink && O.startATag.test(m[0])) st.inLink = true;
    else if (st.inLink && O.endATag.test(m[0])) st.inLink = false;
    if (!st.inRawBlock && O.startPreScriptTag.test(m[0])) st.inRawBlock = true;
    else if (st.inRawBlock && O.endPreScriptTag.test(m[0])) st.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: st.inLink, inRawBlock: st.inRawBlock, block: false, text: m[0] };
  },

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return;
    const m = INLINE.link.exec(src);
    if (!m) return;
    const n = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasLinkInText(src, m[1], n, INLINE)) return;
    const s = m[2].trim();
    if (O.startAngleBracket.test(s)) {
      if (!O.endAngleBracket.test(s)) return;
      const l = trimTrail(s.slice(0, -1), '\\');
      if ((s.length - l.length) % 2 === 0) return;
    } else {
      const l = parenIdx(m[2], '()');
      if (l === -2) return;
      if (l > -1) {
        const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
        m[2] = m[2].substring(0, l);
        m[0] = m[0].substring(0, h).trim();
        m[3] = '';
      }
    }
    const r = trimTrail(m[0].slice(0, -1), '\\');
    if ((m[0].length - r.length) % 2 === 0) return;
    let href = m[2];
    const title = m[3] ? m[3].slice(1, -1) : '';
    href = href.trim();
    if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
    return makeLink(
      m,
      {
        href: href && href.replace(INLINE.anyPunctuation, '$1'),
        title: title && title.replace(INLINE.anyPunctuation, '$1'),
      },
      m[0],
      this.lexer,
    );
  },

  reflink(src, links) {
    const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (!m) return;
    const n = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasLinkInText(src, m[1], n, INLINE)) return;
    const ref = links[normLabel(m[2] || m[1])];
    if (!ref) {
      const c = m[0].charAt(0);
      return { type: 'text', raw: c, text: c };
    }
    return makeLink(m, ref, m[0], this.lexer);
  },

  emStrong(src, masked, prev) {
    const m = INLINE.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
    const ch = m[0][0];
    const sameAsPrev = prev === ch;
    const i = masked.length - src.length;
    let l = i;
    while (l > 0 && masked[l - 1] === ch) l--;
    const beforeRun = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
    const beforeIsDelimOrPunct =
      beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
    if (l < i) prev = beforeRun;
    const canOpen = l < i ? beforeIsDelimOrPunct : !!INLINE.punctuation.exec(prev);
    if (m[4] && prev.match(O.unicodeAlphaNumeric)) return;
    const after = m[1] || m[3] || '';
    if (!after || !prev || canOpen) {
      const k = [...m[0]].length - 1;
      let openers = k;
      let extra = 0;
      const y = i - l + k;
      const closerOK = !!beforeRun.trim() && (!!after || (ch === '*' && !beforeIsDelimOrPunct));
      if (ch !== '*' && ch !== '_') return;
      const rdelim = ch === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = this.lexer.lastCloser(masked, ch);
      const afterOpen = masked.length - src.length + k;
      if (lastCloser < afterOpen) return;
      const rest = masked.slice(-src.length + k);
      const limit = lastCloser - afterOpen;
      rdelim.lastIndex = 0;
      let s2;
      while ((s2 = rdelim.exec(rest)) !== null && !(s2.index > limit)) {
        let g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
        if (!g) continue;
        const b = [...g].length;
        if (s2[3] || s2[4]) {
          openers += b;
          continue;
        } else if (s2[5] || s2[6] || closerOK) {
          if (sameAsPrev && (s2[5] || s2[6])) break;
          if (y % 3 && !((y + b) % 3)) {
            extra += b;
            continue;
          }
        }
        if ((openers -= b) > 0) continue;
        const take = Math.min(b, b + openers + extra);
        const firstLen = [...s2[0]][0].length;
        const raw = src.slice(0, k + s2.index + firstLen + take);
        if (Math.min(k, take) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  },

  codespan(src) {
    const m = INLINE.code.exec(src);
    if (!m) return;
    let text = m[2].replace(O.newLineCharGlobal, ' ');
    const hasNonSpace = O.nonSpaceChar.test(text);
    const wrapped = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
    if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  },

  br(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
  },

  del(src, masked, prev) {
    const m = INLINE.delLDelim.exec(src);
    if (!m) return;
    if (!(m[1] || '') || !prev || INLINE.punctuation.exec(prev)) {
      const o = [...m[0]].length - 1;
      let p = o;
      const rdelim = INLINE.delRDelim;
      const lastCloser = this.lexer.lastDelCloser(masked);
      const afterOpen = masked.length - src.length + o;
      if (lastCloser < afterOpen) return;
      const rest = masked.slice(-src.length + o);
      const limit = lastCloser - afterOpen;
      rdelim.lastIndex = 0;
      let s2;
      while ((s2 = rdelim.exec(rest)) !== null && !(s2.index > limit)) {
        const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
        if (!g) continue;
        let l = [...g].length;
        if (l !== o) continue;
        if (s2[3] || s2[4]) {
          p += l;
          continue;
        }
        if ((p -= l) > 0) continue;
        l = Math.min(l, l + p);
        const firstLen = [...s2[0]][0].length;
        const raw = src.slice(0, o + s2.index + firstLen + l);
        const inner = raw.slice(o, -o);
        return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  },

  autolink(src) {
    const m = INLINE.autolink.exec(src);
    if (!m) return;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[1];
      href = 'mailto:' + text;
    } else {
      text = m[1];
      href = text;
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  },

  url(src) {
    const m = INLINE.url.exec(src);
    if (!m) return;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let r;
      do {
        r = m[0];
        m[0] = INLINE._backpedal.exec(m[0])?.[0] ?? '';
      } while (r !== m[0]);
      text = m[0];
      href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  },

  inlineText(src) {
    const m = INLINE.text.exec(src);
    if (!m) return;
    const inRaw = this.lexer.state.inRawBlock;
    return { type: 'text', raw: m[0], text: inRaw ? m[0] : decodeEnt(m[0]), escaped: inRaw };
  },
});

// ---------------------------------------------------------------------------
// Lexer — block loop, inline loop, and the emphasis mask.

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.inlineQueue = [];
    this.maskStack = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.tok = new Tokenizer(this);
  }

  run(src) {
    src = src.replace(O.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (const item of this.inlineQueue) {
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return renderBlocks(this.tokens, this);
  }

  inline(src) {
    this.inlineQueue.push({ src, tokens: [] });
    return this.inlineQueue.at(-1).tokens;
  }

  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const r = s.lastIndexOf('[');
      if (
        !(s.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && this.linkInText(s.slice(1, r - 1)))
      ) return true;
    }
    return false;
  }

  lastCloser(masked, ch) {
    const top = this.maskStack.at(-1);
    if (top && top.maskedSrc === masked) return top.lastEm[ch];
    return scanMask(masked).lastEm[ch];
  }

  lastDelCloser(masked) {
    const top = this.maskStack.at(-1);
    if (top && top.maskedSrc === masked) return top.lastDel;
    return scanMask(masked).lastDel;
  }

  // The emphasis mask: link-like spans, code spans and html tags are replaced
  // by same-length `[aaa…]` placeholders so emphasis closers are not found
  // inside them; backslash-punctuation is neutralised to `+`.
  buildMask(src) {
    let t = src;
    if (this.tokens.links && src.includes('[')) {
      const re = INLINE.reflinkSearch;
      const sub = (r) => {
        const o = r.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normLabel(r.slice(o + 1, -1)))) return r;
        if (o > 1 && r.charAt(0) !== '!') {
          const inner = r.slice(1, o - 1);
          if (this.linkInText(inner)) {
            return '[' + inner.replace(re, sub) + '][' + 'a'.repeat(r.length - o - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(r.length - 2) + ']';
      };
      t = t.replace(re, sub);
    }
    t = t.replace(
      INLINE.anyPunctuationOutsideCode,
      (m, s, r) => (r ? '+'.repeat(m.length) : s ? s + m.slice(s.length, -s.length).replace(/`/g, '+') + s : m),
    );
    t = t.replace(INLINE.blockSkip, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
    return t;
  }

  blockTokens(src, tokens = [], inQuote = false) {
    const tok = this.tok;
    let prevLen = Infinity;
    while (src) {
      if (src.length < prevLen) prevLen = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let t;
      if ((t = tok.space(src))) {
        src = src.substring(t.raw.length);
        const last = tokens.at(-1);
        if (t.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(t);
        continue;
      }
      if ((t = tok.code(src))) {
        src = src.substring(t.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + t.raw;
          last.text += '\n' + t.text;
          this.inlineQueue.at(-1).src = last.text;
        } else tokens.push(t);
        continue;
      }
      if ((t = tok.fences(src))) {
        src = src.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.heading(src))) {
        src = src.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.hr(src))) {
        src = src.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.blockquote(src))) {
        src = src.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.list(src))) {
        src = src.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.html(src))) {
        src = src.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.def(src))) {
        src = src.substring(t.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + t.raw;
          last.text += '\n' + t.raw;
          this.inlineQueue.at(-1).src = last.text;
        } else {
          if (!this.tokens.links[t.tag]) this.tokens.links[t.tag] = { href: t.href, title: t.title };
          tokens.push(t);
        }
        continue;
      }
      if ((t = tok.table(src))) {
        src = src.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      // Cheap necessary condition for a setext underline (`\n {0,3}=` or `-`):
      // the full lheading regex cannot match without it, and it is expensive
      // to run on every block (backtracking text group).
      if (
        src.includes('\n') &&
        O.setextUnderline.test(src) &&
        (t = tok.lheading(src))
      ) {
        src = src.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if (this.state.top && (t = tok.paragraph(src))) {
        const last = tokens.at(-1);
        if (inQuote && last?.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + t.raw;
          last.text += '\n' + t.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = last.text;
        } else tokens.push(t);
        inQuote = false;
        src = src.substring(t.raw.length);
        continue;
      }
      if ((t = tok.text(src))) {
        src = src.substring(t.raw.length);
        const last = tokens.at(-1);
        if (last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + t.raw;
          last.text += '\n' + t.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = last.text;
        } else tokens.push(t);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
      const masked = needsMask ? this.buildMask(src) : src;
      this.maskStack.push(scanMask(masked));
      try {
        return this.inlineLoop(src, masked, tokens);
      } finally {
        this.maskStack.pop();
      }
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  inlineLoop(src, masked, tokens) {
    const tok = this.tok;
    let lastWasText = false;
    let prevChar = '';
    let minLen = Infinity;
    let rest = src;
    while (rest) {
      if (rest.length < minLen) minLen = rest.length;
      else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      if (!lastWasText) prevChar = '';
      lastWasText = false;
      let t;
      if ((t = tok.escape(rest))) {
        rest = rest.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.tag(rest))) {
        rest = rest.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.link(rest))) {
        rest = rest.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.reflink(rest, this.tokens.links))) {
        rest = rest.substring(t.raw.length);
        const last = tokens.at(-1);
        if (t.type === 'text' && last?.type === 'text') {
          last.raw += t.raw;
          last.text += t.text;
        } else tokens.push(t);
        continue;
      }
      if ((t = tok.emStrong(rest, masked, prevChar))) {
        rest = rest.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.codespan(rest))) {
        rest = rest.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.br(rest))) {
        rest = rest.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.del(rest, masked, prevChar))) {
        rest = rest.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.autolink(rest))) {
        rest = rest.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if (!this.state.inLink && (t = tok.url(rest))) {
        rest = rest.substring(t.raw.length);
        tokens.push(t);
        continue;
      }
      if ((t = tok.inlineText(rest))) {
        rest = rest.substring(t.raw.length);
        if (t.raw.slice(-1) !== '_') prevChar = t.raw.slice(-1);
        lastWasText = true;
        const last = tokens.at(-1);
        if (last?.type === 'text') {
          last.raw += t.raw;
          last.text += t.text;
        } else tokens.push(t);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    }
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// Renderer — direct HTML output, mirroring marked's Renderer + TextRenderer.
// `plain` selects the text renderer (used for image alt text).

function renderBlocks(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${t.depth}>${renderInline(t.tokens)}</h${t.depth}>\n`;
        break;
      case 'code': {
        const lang = (t.lang || '').match(O.notSpaceStart)?.[0];
        const body = t.text ? t.text.replace(O.endingNewline, '') + '\n' : '';
        const inner = t.escaped ? body : esc(body, true);
        out += lang
          ? `<pre><code class="language-${esc(lang)}">${inner}</code></pre>\n`
          : `<pre><code>${inner}</code></pre>\n`;
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of t.header) head += renderCell(cell);
        let rows = '';
        for (const row of t.rows) {
          let cells = '';
          for (const cell of row) cells += renderCell(cell);
          rows += `<tr>\n${cells}</tr>\n`;
        }
        if (rows) rows = `<tbody>${rows}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${rows}</table>\n`;
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(t.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const start = t.ordered && t.start !== 1 ? ` start="${t.start}"` : '';
        let items = '';
        for (const item of t.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'html':
        out += t.text;
        break;
      case 'checkbox':
        out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'paragraph':
        out += `<p>${renderInline(t.tokens)}</p>\n`;
        break;
      case 'text':
        out += renderInline(t.tokens);
        break;
      default:
        throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return `${open}${renderInline(cell.tokens)}</${tag}>\n`;
}

function renderInline(tokens, plain = false) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'escape':
        out += plain ? t.text : esc(t.text);
        break;
      case 'html':
        out += t.text;
        break;
      case 'link': {
        if (plain) {
          out += t.tokens ? renderInline(t.tokens, true) : t.text;
          break;
        }
        const label = t.autolink ? esc(t.text, true) : renderInline(t.tokens);
        const href = cleanUrl(t.href);
        if (href === null) {
          out += label;
          break;
        }
        let a = '<a href="' + esc(href, t.autolink) + '"';
        if (t.title) a += ' title="' + esc(t.title) + '"';
        out += a + '>' + label + '</a>';
        break;
      }
      case 'image': {
        let alt = t.text;
        if (t.tokens) alt = renderInline(t.tokens, true);
        if (plain) {
          out += alt;
          break;
        }
        const src = cleanUrl(t.href);
        if (src === null) {
          out += esc(alt);
          break;
        }
        let img = `<img src="${esc(src)}" alt="${esc(alt)}"`;
        if (t.title) img += ` title="${esc(t.title)}"`;
        out += img + '>';
        break;
      }
      case 'checkbox':
        out += plain
          ? t.raw
          : '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += plain
          ? t.tokens ? renderInline(t.tokens, true) : t.text
          : `<strong>${renderInline(t.tokens)}</strong>`;
        break;
      case 'em':
        out += plain
          ? t.tokens ? renderInline(t.tokens, true) : t.text
          : `<em>${renderInline(t.tokens)}</em>`;
        break;
      case 'codespan':
        out += plain ? t.text : `<code>${esc(t.text, true)}</code>`;
        break;
      case 'br':
        out += plain ? '' : '<br>';
        break;
      case 'del':
        out += plain
          ? t.tokens ? renderInline(t.tokens, true) : t.text
          : `<del>${renderInline(t.tokens)}</del>`;
        break;
      case 'text':
        if (plain) out += t.text;
        else if ('tokens' in t && t.tokens) out += renderInline(t.tokens);
        else if ('escaped' in t && t.escaped) out += t.text;
        else out += esc(t.text);
        break;
      default:
        throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}
