export const ROLE_SERVICE = 'remote-agent:role'

/**
 * Surface the resolved role to other plugins. Least privilege: anything that
 * is not explicitly hub/both is surfaced as "worker" — an unconfigured or
 * unreadable role must never hand another plugin hub powers.
 */
export function exposeRole(ctx, role) {
  const value = role === 'hub' || role === 'both' ? role : 'worker'
  if (typeof ctx?.provide !== 'function') return () => {}
  return ctx.provide(ROLE_SERVICE, value)
}
