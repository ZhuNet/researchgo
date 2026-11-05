// Shared across component mounts: cleanup from an old slot must precede layout
// from a new slot for the same native webview. Different webviews stay independent.
const pending = new Map<string, Promise<void>>();

export function queueBrowserLayout(label: string, operation: () => Promise<void>): Promise<void> {
  const result = (pending.get(label) ?? Promise.resolve()).then(operation);
  const tail = result.catch(() => {});
  pending.set(label, tail);
  void tail.then(() => {
    if (pending.get(label) === tail) pending.delete(label);
  });
  return result;
}
