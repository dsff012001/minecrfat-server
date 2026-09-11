import JSZip from 'jszip'
import { put } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentCommands, servers } from '@/lib/db/schema'

const categories = ['mods', 'plugins', 'config', 'worlds', 'other'] as const
type Category = (typeof categories)[number]
const textExtensions = new Set(['.yml', '.yaml', '.json', '.properties', '.toml', '.ini', '.cfg', '.conf', '.txt'])
const safe = (value: string) => value.replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..').join('/')
function classify(name: string): Category | null {
  const normalized = safe(name).toLowerCase()
  if (!normalized || normalized.endsWith('/')) return null
  const ext = normalized.includes('.') ? normalized.slice(normalized.lastIndexOf('.')) : ''
  if (normalized.startsWith('mods/') || ext === '.jar' && !normalized.startsWith('plugins/')) return 'mods'
  if (normalized.startsWith('plugins/')) return 'plugins'
  if (normalized.startsWith('config/') || textExtensions.has(ext) || ext === '.conf') return 'config'
  if (normalized.startsWith('worlds/') || normalized.startsWith('world/')) return 'worlds'
  return 'other'
}
async function currentUser() { const session = await auth.api.getSession({ headers: await headers() }); return session?.user?.id ?? null }
async function ownedServer(userId: string, serverId: string) { return (await db.select().from(servers).where(and(eq(servers.id, serverId), eq(servers.userId, userId))).limit(1))[0] }
async function postFiles(request: NextRequest) {
  const userId = await currentUser(); if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const form = await request.formData(); const serverId = String(form.get('serverId') ?? ''); const server = await ownedServer(userId, serverId)
  if (!server) return NextResponse.json({ error: 'Sunucu bulunamadı' }, { status: 404 })
  if (server.status === 'running') return NextResponse.json({ error: 'Yükleme için sunucuyu durdurun' }, { status: 409 })
  const file = form.get('file'); if (!(file instanceof File) || file.size > 1024 * 1024 * 1024) return NextResponse.json({ error: 'Geçersiz veya çok büyük dosya' }, { status: 400 })
  const isZip = file.name.toLowerCase().endsWith('.zip')
  const zipEntries: Array<{ name: string; category: Category }> = []
  if (isZip) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer())
    for (const entry of Object.values(zip.files)) { const category = classify(entry.name); if (category) zipEntries.push({ name: safe(entry.name), category }) }
    if (!zipEntries.length) return NextResponse.json({ error: 'ZIP içinde desteklenen mod, plugin, config veya dünya dosyası bulunamadı' }, { status: 400 })
    if (form.get('confirm') !== 'true') return NextResponse.json({ preview: true, entries: zipEntries, rejected: Object.keys(zip.files).filter(name => !classify(name)) })
  }
  const pathname = `${userId}/servers/${serverId}/uploads/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
  const blob = await put(pathname, file, { access: 'private', addRandomSuffix: false })
  const commandType = isZip ? 'upload-archive' : 'upload-file'
  await db.insert(agentCommands).values({ userId, nodeId: server.nodeId, serverId, type: commandType, payload: { pathname: blob.pathname, filename: file.name, entries: zipEntries, backupBeforeReplace: true }, status: 'queued' })
  return NextResponse.json({ queued: true, filename: file.name, entries: zipEntries, pathname: blob.pathname }, { status: 202 })
}
export async function POST(request: NextRequest) { try { return await postFiles(request) } catch (error) { console.error('[files-upload]', error); return NextResponse.json({ error: error instanceof Error ? error.message : 'Yükleme sırasında beklenmeyen hata oluştu' }, { status: 500 }) } }
export async function PATCH(request: NextRequest) { const userId = await currentUser(); if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); const body = await request.json() as { serverId?: string; path?: string; content?: string }; const server = body.serverId ? await ownedServer(userId, body.serverId) : null; if (!server || !body.path || typeof body.content !== 'string') return NextResponse.json({ error: 'Geçersiz dosya düzenleme isteği' }, { status: 400 }); if (server.status === 'running') return NextResponse.json({ error: 'Düzenlemek için sunucuyu durdurun' }, { status: 409 }); if (body.content.length > 2_000_000 || body.path.includes('..') || body.path.startsWith('/')) return NextResponse.json({ error: 'Geçersiz dosya yolu veya boyut' }, { status: 400 }); await db.insert(agentCommands).values({ userId, nodeId: server.nodeId, serverId: server.id, type: 'write-file', payload: { path: safe(body.path), content: body.content, backupBeforeReplace: true }, status: 'queued' }); return NextResponse.json({ queued: true }, { status: 202 }) }
export async function DELETE(request: NextRequest) { const userId = await currentUser(); if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); const body = await request.json() as { serverId?: string; path?: string }; const server = body.serverId ? await ownedServer(userId, body.serverId) : null; if (!server || !body.path || body.path.includes('..') || body.path.startsWith('/')) return NextResponse.json({ error: 'Geçersiz dosya silme isteği' }, { status: 400 }); if (server.status === 'running') return NextResponse.json({ error: 'Silmek için sunucuyu durdurun' }, { status: 409 }); await db.insert(agentCommands).values({ userId, nodeId: server.nodeId, serverId: server.id, type: 'delete-file', payload: { path: safe(body.path) }, status: 'queued' }); return NextResponse.json({ queued: true }, { status: 202 }) }
export async function GET(request: NextRequest) {
  const userId = await currentUser(); if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const serverId = request.nextUrl.searchParams.get('serverId'); if (!serverId) return NextResponse.json({ error: 'serverId gerekli' }, { status: 400 })
  const server = await ownedServer(userId, serverId); if (!server) return NextResponse.json({ error: 'Sunucu bulunamadı' }, { status: 404 })
  const commandRows = await db.select({ id: agentCommands.id, type: agentCommands.type, status: agentCommands.status, payload: agentCommands.payload, result: agentCommands.result, createdAt: agentCommands.createdAt, completedAt: agentCommands.completedAt }).from(agentCommands).where(and(eq(agentCommands.serverId, serverId), eq(agentCommands.userId, userId)))
  return NextResponse.json({ files: commandRows.filter(row => ['upload-file', 'upload-archive', 'write-file', 'delete-file', 'move-file'].includes(row.type)) })
}
