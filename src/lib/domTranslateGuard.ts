/**
 * Guard React against in-browser page translators.
 *
 * Spare ships its own English / 简体中文 / 繁體中文 strings (src/i18n) and loads
 * no translation widget. Visitors can still run their browser's
 * translator over the page in other languages — Chrome / Edge "Translate this
 * page", Safari, or extensions such as Immersive Translate. Those wrap text
 * nodes in <font> elements behind React's back, and the next update that
 * removes or moves such a node throws
 *
 *   "Failed to execute 'removeChild' on 'Node':
 *    The node to be removed is not a child of this node."
 *
 * which would drop the whole desktop into the ErrorBoundary. This patches
 * Node.prototype.removeChild / insertBefore to recover when a node has been
 * re-parented (https://github.com/facebook/react/issues/11538).
 *
 * No effect without a translator: the patched branches only run on a parent
 * mismatch, which React never produces on its own.
 */

let patched = false;

export function installDomTranslateGuard(): void {
  if (patched) return;
  if (typeof Node === 'undefined') return;
  patched = true;

  const originalRemoveChild = Node.prototype.removeChild;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Node.prototype as any).removeChild = function <T extends Node>(child: T): T {
    if (child.parentNode !== this) {
      if (child.parentNode) {
        // A translator re-parented this node: let its actual parent remove it.
        try {
          return originalRemoveChild.call(child.parentNode, child) as T;
        } catch {
          /* still failing: fall through and swallow */
        }
      }
      // Already detached. Return the node so callers that chain on it don't crash.
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Node.prototype as any).insertBefore = function <T extends Node>(newNode: T, referenceNode: Node | null): T {
    if (referenceNode && referenceNode.parentNode !== this) {
      // The reference node was re-parented. Appending keeps the node under the
      // parent React expects, which React tolerates; inserting into a foreign
      // ancestor it does not.
      try {
        return originalInsertBefore.call(this, newNode, null) as T;
      } catch {
        /* fall through */
      }
    }
    return originalInsertBefore.call(this, newNode, referenceNode) as T;
  };
}
