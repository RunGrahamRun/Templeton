// Utilities for pulling a *specific* function or object literal out of the
// large minified inline <script> in twinstone.html and running it for real
// in an isolated vm context, rather than re-implementing (and therefore
// only testing our own guess at) client-side logic like temporal ageing or
// the corroboration-eligibility filter.

import vm from 'node:vm';

export function extractInlineJs(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let all = '';
  while ((m = re.exec(html))) all += m[1] + '\n';
  return all;
}

function findMatchingBrace(text, openIndex, openCh = '{', closeCh = '}') {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === openCh) depth++;
    else if (text[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`no matching '${closeCh}' found starting at index ${openIndex}`);
}

/** Extracts `function <name>(...) { ... }` including the signature and body. */
export function extractFunctionSource(js, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(js);
  if (!m) throw new Error(`function ${name} not found in supplied JS source`);
  const braceStart = js.indexOf('{', m.index);
  const braceEnd = findMatchingBrace(js, braceStart);
  return js.slice(m.index, braceEnd + 1);
}

/** Extracts an object-literal assignment `<name>={ ... }` as `const <name> = { ... };`. */
export function extractObjectConstSource(js, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*\\{`);
  const m = re.exec(js);
  if (!m) throw new Error(`object literal ${name} not found in supplied JS source`);
  const braceStart = js.indexOf('{', m.index);
  const braceEnd = findMatchingBrace(js, braceStart);
  return `const ${name} = ${js.slice(braceStart, braceEnd + 1)};`;
}

/** Extracts an array-literal assignment `<name>=[ ... ]` as `const <name> = [ ... ];`. */
export function extractArrayConstSource(js, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*\\[`);
  const m = re.exec(js);
  if (!m) throw new Error(`array literal ${name} not found in supplied JS source`);
  const bracketStart = js.indexOf('[', m.index);
  const bracketEnd = findMatchingBrace(js, bracketStart, '[', ']');
  return `const ${name} = ${js.slice(bracketStart, bracketEnd + 1)};`;
}

/**
 * Runs the given source fragments (strings of extracted function/const
 * declarations) in a fresh isolated vm context and returns the context's
 * globals, so callers can invoke the extracted functions directly.
 */
export function evalInSandbox(sourceFragments, exposeNames) {
  const src = [
    ...sourceFragments,
    `globalThis.__sandboxExports = { ${exposeNames.join(', ')} };`,
  ].join('\n\n');
  const ctx = { console, Date, Math, JSON, Array, Object, Number, String, Boolean, Map, Set, RegExp };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { timeout: 5000 });
  return ctx.__sandboxExports;
}
