export function safeInternalPath(from: unknown): string {
  if (typeof from !== 'string' || from.length === 0) return '/';
  if (!from.startsWith('/') || from.startsWith('//')) return '/';
  return from;
}
