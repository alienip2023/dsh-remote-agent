// Exposes the NodeRegistry instance into the cordis context so ds-bot's
// worker-bridge can retrieve it via ctx.get('remote-agent:registry').
// ctx.provide is the correct API (cordis 4.0.2); ctx.set throws without prior provide.
export function exposeRegistry(ctx, registry) {
  try { ctx.provide?.('remote-agent:registry', registry) } catch {}
}
