export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

export async function until(read, message, timeout = 2500) {
  const started = performance.now();
  while (!read()) {
    if (performance.now() - started >= timeout) throw new Error(message);
    await delay(15);
  }
}

export const quietLog = (errors) => ({
  error: (message) => errors.push(String(message)),
  warn() {}, info() {}, debug() {},
});
