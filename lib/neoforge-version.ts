export function neoForgePrefix(mcVersion: string) {
  const parts = mcVersion.split('.')
  if (parts[0] === '1' && parts.length >= 3) return `${parts[1]}.${parts[2]}.`
  throw new Error('Unsupported Minecraft version')
}

export function isCompatibleNeoForgeVersion(mcVersion: string, loaderVersion: string) {
  try { return loaderVersion.startsWith(neoForgePrefix(mcVersion)) } catch { return false }
}

export const neoForgeMappingExamples = [
  ['1.21.1', '21.1.77', true],
  ['1.21.4', '21.4.0', true],
  ['1.21.1', '21.4.0', false],
  ['1.20.1', '21.1.77', false],
] as const

if (process.env.NODE_ENV === 'test') {
  for (const [minecraft, loader, expected] of neoForgeMappingExamples) {
    if (isCompatibleNeoForgeVersion(minecraft, loader) !== expected) throw new Error(`NeoForge mapping regression: ${minecraft} -> ${loader}`)
  }
}
