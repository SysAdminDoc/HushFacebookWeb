// Every phrase the script can show through t(), plural() or english(), in English, for the
// translation template. Three sources: the feature list's own words (titles, descriptions,
// option labels and choices, section and quick setup names), Diagnostics' row labels
// (diagnostics.add), card buttons' labels (actions.add), and every call in src, read with a parser. An argument is followed to the
// words it can end up as: a string, either side of ?: ?? or ||, a const or a lookup table in
// the same file or one it imports, a parameter of the function it's in (through that
// function's callers in the same file), or a property (the strings that property gets in the
// same file, or the files it imports when it has none, or in any file for an action's label and
// a busyLabel, which toasts and buttons pass along). Whatever it can't follow comes back in
// unresolved, by file and call, unless PASS_THROUGH says where its words come from.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');
// Properties whose strings travel between files before t() shows them, and the pool each one
// draws from: a label only from an action { label, run }, so a share target's or a language's
// own name doesn't count.
const SHARED_PROPERTIES = new Map([['label', 'label:run'], ['busyLabel', 'busyLabel']]);
// Calls that only hand on words found elsewhere, by file and call as written.
export const PASS_THROUGH = new Map([
  ['src/core/i18n.js t(count === 1 ? one : other, all)', 'plural() itself'],
  ['src/ui/search.js english(text, vars)', 'search reads the feature list and panel words'],
  ['src/ui/search.js t(text, vars)', 'search reads the feature list and panel words'],
  ["src/ui/panel.js t(status ?? '')", "a feature's status line (diagnostics.status), none so far"],
  ["src/ui/panel.js t(diagnostics.statusOf(node.getAttribute('data-status-for')) ?? '')", "a feature's status line (diagnostics.status), none so far"],
]);

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out.sort();
}

// Calls fn(node, ancestors) for every node.
function walk(node, fn, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, fn, ancestors);
    else if (value && typeof value.type === 'string') walk(value, fn, ancestors);
  }
  ancestors.pop();
}

const isFunction = (node) => /Function/.test(node?.type ?? '');
const keyName = (property) => (property.computed ? null : property.key?.name ?? (typeof property.key?.value === 'string' ? property.key.value : null));
const calleeName = (call) => (call.callee.type === 'Identifier' ? call.callee.name : call.callee.type === 'MemberExpression' && !call.callee.computed ? call.callee.property.name : null);
const pushTo = (map, key, value) => (map.has(key) ? map.get(key).push(value) : map.set(key, [value]));

function readSource(path, text) {
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const constants = new Map();
  const functions = new Map();
  const properties = new Map();
  const imports = new Map();
  const calls = [];
  walk(ast, (node, ancestors) => {
    if (node.type === 'ImportDeclaration' && node.source.value.startsWith('.')) {
      const from = resolvePath(dirname(path), node.source.value);
      for (const spec of node.specifiers) if (spec.type === 'ImportSpecifier') imports.set(spec.local.name, { from, name: spec.imported.name });
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      const init = node.init.type === 'CallExpression' && calleeName(node.init) === 'freeze' ? node.init.arguments[0] : node.init;
      if (isFunction(init)) functions.set(node.id.name, init);
      else if (ancestors.at(-1)?.kind === 'const') constants.set(node.id.name, init);
    }
    if (node.type === 'FunctionDeclaration' && node.id) functions.set(node.id.name, node);
    if (node.type === 'Property' && keyName(node)) {
      pushTo(properties, keyName(node), node.value);
      // A button's label: an action { label, run } a toast or a card passes along.
      if (keyName(node) === 'label' && ancestors.at(-1).properties.some((other) => other.type === 'Property' && keyName(other) === 'run')) pushTo(properties, 'label:run', node.value);
    }
    if (node.type === 'CallExpression') calls.push({ node, ancestors: [...ancestors] });
    // new Error('...') carries a message a toast may show through t(error.message).
    if (node.type === 'NewExpression' && node.callee.name === 'Error' && node.arguments[0]) pushTo(properties, 'message', node.arguments[0]);
  });
  return { path, text, constants, functions, properties, imports, calls };
}

export async function collectPhrases() {
  const files = new Map();
  for (const path of await sources(SRC)) files.set(path, readSource(path, await readFile(path, 'utf8')));
  const phrases = new Set();
  const plurals = new Map();
  const unresolved = [];
  const imported = (file) => [...new Set([...file.imports.values()].map(({ from }) => from))].map((path) => files.get(path)).filter(Boolean);

  // Strings an expression can end up as, or null when it can't be followed.
  function resolve(file, node, ancestors, seen = new Set()) {
    if (!node) return null;
    if (seen.has(node)) return [];
    seen.add(node);
    switch (node.type) {
      case 'Literal':
        return typeof node.value === 'string' ? [node.value] : [];
      case 'TemplateLiteral':
        return node.expressions.length ? null : [node.quasis[0].value.cooked];
      case 'ConditionalExpression':
      case 'LogicalExpression': {
        const both = node.type === 'LogicalExpression' ? [node.left, node.right] : [node.consequent, node.alternate];
        const found = both.map((part) => resolve(file, part, ancestors, seen));
        return found.includes(null) ? null : found.flat();
      }
      // A label that follows state, () => (showing ? 'Hide' : 'Show'): what its body can return.
      case 'ArrowFunctionExpression':
        return node.body.type === 'BlockStatement' ? null : resolve(file, node.body, [...ancestors, node], seen);
      case 'ObjectExpression': {
        const values = node.properties.map((property) => (property.type === 'Property' ? resolve(file, property.value, ancestors, seen) : null));
        return values.includes(null) ? null : values.flat();
      }
      case 'Identifier':
        return resolveName(file, node.name, ancestors, seen);
      case 'MemberExpression': {
        // A lookup table: TABLE[key] or TABLE.key, every value it holds.
        if (node.object.type === 'Identifier') {
          const table = constantOf(file, node.object.name);
          if (table?.node.type === 'ObjectExpression') return resolve(table.file, table.node, [], seen);
        }
        return node.computed ? null : resolveProperty(file, node.property.name, seen);
      }
      default:
        return null;
    }
  }

  // A const in this file, or one exported by the file it was imported from.
  function constantOf(file, name) {
    if (file.constants.has(name)) return { file, node: file.constants.get(name) };
    const from = file.imports.get(name);
    const other = from && files.get(from.from);
    return other?.constants.has(from.name) ? { file: other, node: other.constants.get(from.name) } : null;
  }

  // Every string a property gets, followed where it can be: an action's label or a busyLabel
  // in any file, any other property in this file, or in the files it imports when this one has
  // none.
  function resolveProperty(file, name, seen) {
    const shared = SHARED_PROPERTIES.get(name);
    const own = file.properties.has(name) ? [file] : imported(file);
    const pool = shared
      ? [...files.values()].flatMap((owner) => (owner.properties.get(shared) ?? []).map((value) => [owner, value]))
      : own.flatMap((owner) => (owner.properties.get(name) ?? []).map((value) => [owner, value]));
    if (!pool.length) return null;
    // A value that can't be followed (a function, a variable) isn't one of the words.
    return pool.flatMap(([owner, value]) => resolve(owner, value, [], seen) ?? []);
  }

  // A name, scope first: a parameter of an enclosing function (the matching argument at every
  // same-file call of it, or the property it was destructured from), then a const.
  function resolveName(file, name, ancestors, seen) {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const fn = ancestors[i];
      if (!isFunction(fn)) continue;
      for (const [index, param] of fn.params.entries()) {
        const plain = param.type === 'AssignmentPattern' ? param.left : param;
        if (plain.type === 'Identifier' && plain.name === name) return resolveArgument(file, fn, index, seen);
        if (plain.type === 'ObjectPattern') {
          for (const property of plain.properties) {
            const value = property.value?.type === 'AssignmentPattern' ? property.value.left : property.value;
            if (value?.type !== 'Identifier' || value.name !== name) continue;
            const found = resolveProperty(file, keyName(property), seen) ?? [];
            const fallback = property.value.type === 'AssignmentPattern' ? resolve(file, property.value.right, ancestors, seen) ?? [] : [];
            return found.length || fallback.length ? [...found, ...fallback] : null;
          }
        }
      }
    }
    const constant = constantOf(file, name);
    return constant ? resolve(constant.file, constant.node, [], seen) : null;
  }

  function resolveArgument(file, fn, index, seen) {
    const fnName = fn.id?.name ?? [...file.functions].find(([, value]) => value === fn)?.[0];
    if (!fnName) return null;
    const values = file.calls.filter(({ node }) => node.callee.type === 'Identifier' && node.callee.name === fnName)
      .map(({ node, ancestors }) => (node.arguments[index] ? resolve(file, node.arguments[index], ancestors, seen) : []));
    return !values.length || values.includes(null) ? null : values.flat();
  }

  const add = (found) => { for (const phrase of found) if (phrase) phrases.add(phrase); };
  for (const file of files.values()) {
    const at = relative(ROOT, file.path).split(sep).join('/');
    for (const { node, ancestors } of file.calls) {
      const name = node.callee.type === 'Identifier' ? node.callee.name : null;
      const missed = () => {
        const call = `${at} ${file.text.slice(node.start, node.end)}`;
        if (!PASS_THROUGH.has(call)) unresolved.push(`${call} (line ${node.loc.start.line})`);
      };
      if (name === 't' || name === 'english') {
        const found = resolve(file, node.arguments[0], ancestors);
        if (found === null) missed();
        else add(found);
      } else if (name === 'plural') {
        const [one, other] = [node.arguments[1], node.arguments[2]].map((arg) => resolve(file, arg, ancestors));
        if (one?.length === 1 && other?.length === 1) plurals.set(other[0], { one: one[0], other: other[0] });
        else missed();
      } else if (node.callee.type === 'MemberExpression' && calleeName(node) === 'add' && ['diagnostics', 'actions'].includes(node.callee.object.name)) {
        // Diagnostics' row labels and card buttons' labels, shown through t(label).
        const found = resolve(file, node.arguments[0], ancestors);
        if (found === null) missed();
        else add(found);
      }
    }
  }

  // The feature list's own words, drawn through t(feature.title) and the like.
  const { features } = await import(pathToFileURL(join(SRC, 'features', 'index.js')));
  const { SECTIONS } = await import(pathToFileURL(join(SRC, 'features', 'sections.js')));
  const { QUICK_SETUPS } = await import(pathToFileURL(join(SRC, 'ui', 'quick-setups.js')));
  for (const feature of features) {
    phrases.add(feature.title).add(feature.description);
    for (const option of feature.options ?? []) {
      if (option.label) phrases.add(option.label);
      for (const choice of option.choices ?? []) if (choice.label) phrases.add(choice.label);
    }
  }
  for (const section of SECTIONS) phrases.add(section.title);
  for (const setup of QUICK_SETUPS) phrases.add(setup.label);

  // A plural phrase is keyed by its English plural form only.
  for (const [key, forms] of plurals) {
    phrases.delete(key);
    phrases.delete(forms.one);
  }
  return { phrases: [...phrases].sort(), plurals, unresolved: unresolved.sort() };
}

// The template a translator starts from: each phrase with its English to write over, and each
// plural phrase with its one and other forms (a language adds the forms Intl.PluralRules has
// for it, Arabic has zero, one, two, few, many and other).
export function templateJson({ phrases, plurals }) {
  const entries = [...phrases.map((phrase) => [phrase, phrase]), ...[...plurals].map(([key, forms]) => [key, forms])];
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}
