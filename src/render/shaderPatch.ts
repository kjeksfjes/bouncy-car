/** `source` with `find` replaced, which must occur exactly once (a shader patch that misses throws, naming `what`). */
export function replaceOnce(source: string, find: string, replace: string, what: string): string {
  const at = source.indexOf(find);
  if (at < 0 || source.indexOf(find, at + 1) >= 0) throw new Error(`${what} shader patch: "${find}" not found exactly once`);
  return source.slice(0, at) + replace + source.slice(at + find.length);
}
