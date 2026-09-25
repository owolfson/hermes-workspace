/**
 * VITE_HERMESWORLD_ENABLED=0 turns HermesWorld off. Vite inlines VITE_* variables when the
 * app is BUILT, so this is decided at build time (see the Dockerfile build arg), not at runtime.
 */
export function isHermesWorldEnabled(rawFlag: string | undefined): boolean {
  return rawFlag !== '0'
}

/** Drop the HermesWorld entry ('playground') from a navigation list when it is disabled. */
export function withoutHermesWorld<T extends { id: string }>(items: ReadonlyArray<T>, enabled: boolean): Array<T> {
  return enabled ? [...items] : items.filter((item) => item.id !== 'playground')
}
