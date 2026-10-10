// Visits every object and array in a parsed JSON tree without recursion, so deep Relay
// payloads can't overflow the stack. visit(value) may return SKIP to not descend.

export const SKIP = Symbol('hfw.skip');

export function walk(root, visit) {
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    if (visit(value) === SKIP) continue;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
    } else {
      for (const key in value) stack.push(value[key]);
    }
  }
}
