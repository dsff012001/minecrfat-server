import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db, ensurePanelSchema } from '@/lib/db'
import { backups, nodes, serverPermissions, servers, worlds } from '@/lib/db/schema'
import { resolvePanelUser } from '@/lib/db/identity'
import { nodeFetch } from '@/lib/node-bridge'

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensurePanelSchema()
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const actor = await resolvePanelUser(session.user)
  if (!actor?.approved) return NextResponse.json({ error: 'Approval required' }, { status: 403 })
  const { id } = await params
  const row = (await db.select({ backup: backups, world: worlds, server: servers, node: nodes }).from(backups).innerJoin(worlds, eq(backups.worldId, worlds.id)).innerJoin(servers, eq(worlds.serverId, servers.id)).innerJoin(nodes, eq(servers.nodeId, nodes.id)).where(eq(backups.id, id)).limit(1))[0]
  if (!row) return NextResponse.json({ error: 'Yedek bulunamadı' }, { status: 404 })
  if (actor.role !== 'manager') {
    const permission = (await db.select({ canBackup: serverPermissions.canBackup }).from(serverPermissions).where(and(eq(serverPermissions.serverId, row.server.id), eq(serverPermissions.userId, actor.id))).limit(1))[0]
    if (!permission?.canBackup) return NextResponse.json({ error: 'Yedek indirme yetkiniz yok' }, { status: 403 })
  }
  let upstream: Response
  try {
    upstream = await nodeFetch(row.node.id, `/internal/backups/${id}/download`, { headers: { 'x-backup-path': row.backup.blobPathname }, signal: AbortSignal.timeout(30000) })
  } catch {
    return NextResponse.json({ error: 'Yedek node üzerinden indirilemedi. Node bağlantısını ve NODE_DOWNLOAD_URL yapılandırmasını kontrol edin.' }, { status: 502 })
  }
  if (upstream.status === 404) return NextResponse.json({ error: 'Arşiv dosyası bulunamadı' }, { status: 404 })
  if (!upstream.ok || !upstream.body) return NextResponse.json({ error: 'Node indirme köprüsüne erişilemedi' }, { status: 502 })
  return new NextResponse(upstream.body, { status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${row.backup.blobPathname.split('/').pop() || 'backup.tar.gz'}"`, ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length')! } : {}) } })
}
