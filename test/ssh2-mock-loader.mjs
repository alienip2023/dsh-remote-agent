// Custom ESM loader: redirect ssh2 imports to test mock
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, next) {
  if (specifier === 'ssh2') {
    return {
      url: new URL('./mock-ssh2/index.mjs', import.meta.url).href,
      shortCircuit: true,
    }
  }
  return next(specifier, context)
}
