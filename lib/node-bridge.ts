import 'server-only'

const REQUEST_TIMEOUT_MS = 8_000

function isPrivateOrMetadataHost(hostname: string) {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === 'metadata.google.internal' || host === '169.254.169.254' || host === '::1' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
}

type NodeConfig = { baseUrl: string; token: string }

function parseMap(name: string): Record<string, string> {
  const raw = process.env[name]
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string' && item.trim())) as Record<string, string>
  } catch {
    throw new Error(`${name} geçerli JSON olmalı`)
  }
}

export function getNodeConfig(nodeId: string): NodeConfig {
  const urls = parseMap('NODE_AGENT_URLS')
  const tokens = parseMap('NODE_TOKENS')
  const legacyUrl = process.env.NODE_UPLOAD_URL ?? process.env.NODE_DOWNLOAD_URL
  const configuredUrl = process.env.NODE_AGENT_BASE_URL ?? legacyUrl
  const baseUrl = (urls[nodeId] ?? configuredUrl ?? '').trim().replace(/\/$/, '')
  const token = (tokens[nodeId] ?? process.env.NODE_TOKEN ?? '').trim()
  if (!baseUrl) throw new Error(`Node ${nodeId} için NODE_AGENT_URLS veya NODE_AGENT_BASE_URL tanımlı değil`)
  if (!token) throw new Error(`Node ${nodeId} için NODE_TOKENS veya NODE_TOKEN tanımlı değil`)
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch { throw new Error(`Node ${nodeId} adresi geçersiz`) }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Node adresi HTTP veya HTTPS olmalı')
  if (isPrivateOrMetadataHost(parsed.hostname)) throw new Error('Node adresi private veya metadata ağına ait olamaz')
  return { baseUrl, token }
}

export async function nodeFetch(nodeId: string, path: string, init: RequestInit = {}) {
  const config = getNodeConfig(nodeId)
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${config.token}`)
  headers.set('x-node-id', nodeId)
  headers.set('accept', 'application/json')
  const endpoint = `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  const hostname = new URL(config.baseUrl).hostname
  try {
    const response = await fetch(endpoint, { ...init, headers, cache: 'no-store', signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) console.warn(`[node-bridge] ${hostname} ${response.status} ${path}`)
    return response
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : error instanceof DOMException && error.name === 'TimeoutError' ? 'ETIMEDOUT' : error instanceof Error ? error.name : 'UNKNOWN'
    console.error(`[node-bridge] ${hostname} ${code} ${path}`)
    throw error
  }
}

export function nodePublicHost(nodeId: string): string | null {
  const hosts = parseMap('NODE_PUBLIC_HOSTS')
  const value = hosts[nodeId] ?? process.env.NODE_PUBLIC_HOST ?? ''
  if (!value.trim()) return null
  try { return new URL(value.includes('://') ? value : `http://${value}`).hostname } catch { return null }
}

export function nodeDiagnosticMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Node bağlantısı kurulamadı'
}
