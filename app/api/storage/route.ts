import { get, put } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentCommands, mods, servers } from '@/lib/db/schema'

async function userId() { const session = await auth.api.getSession({ headers: await headers() }); return session?.user?.id }
export async function POST(request: NextRequest) {
  const id = await userId(); if (!id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const data = await request.formData(); const file = data.get('file'); const category = String(data.get('category') ?? 'files'); const serverId = String(data.get('serverId') ?? ''); const addonName = String(data.get('name') ?? (file instanceof File ? file.name : 'uploaded-file')).slice(0,120); const addonVersion = String(data.get('version') ?? 'custom').slice(0,40)
  if (!(file instanceof File) || file.size > 1024 * 1024 * 1024) return NextResponse.json({ error: 'Geçersiz veya çok büyük dosya' }, { status: 400 })
  if (!['mods','plugins','configs','resource-packs','worlds'].includes(category)) return NextResponse.json({ error: 'Geçersiz kategori' }, { status: 400 }); if (serverId) { const server=(await db.select().from(servers).where(and(eq(servers.id,serverId),eq(servers.userId,id))).limit(1))[0]; if(!server)return NextResponse.json({error:'Sunucu bulunamadı'},{status:404}); if(server.status==='running')return NextResponse.json({error:'Dosya yüklemek için sunucuyu durdurun'},{status:409}) }
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const blob = await put(`${id}/${category}/${crypto.randomUUID()}-${safeName}`, file, { access: 'private', addRandomSuffix: false })
  if(serverId){const server=(await db.select().from(servers).where(and(eq(servers.id,serverId),eq(servers.userId,id))).limit(1))[0]!;const kind=category==='plugins'?'plugins':category==='mods'?'mods':category;await db.insert(agentCommands).values({userId:id,nodeId:server.nodeId,serverId,type:category==='mods'||category==='plugins'?'install-addon':category==='worlds'?'UPLOAD_WORLD':'write-file',payload:{pathname:blob.pathname,filename:safeName,kind,path:category==='configs'?'server.properties':category==='resource-packs'?`resourcepacks/${safeName}`:category==='worlds'?`uploads/${safeName}`:safeName},status:'queued'});if(category==='mods'||category==='plugins')await db.insert(mods).values({serverId,userId:id,filename:safeName,blobPathname:blob.pathname,sha256:'pending',uploadedBy:id,enabled:true})} return NextResponse.json({ pathname: blob.pathname, queued: Boolean(serverId) })
}
export async function GET(request: NextRequest) {
  const id = await userId(); if (!id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const pathname = request.nextUrl.searchParams.get('pathname')
  if (!pathname?.startsWith(`${id}/`)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const result = await get(pathname, { access: 'private', ifNoneMatch: request.headers.get('if-none-match') ?? undefined })
  if (!result) return new NextResponse('Not found', { status: 404 })
  if (result.statusCode === 304) return new NextResponse(null, { status: 304, headers: { ETag: result.blob.etag, 'Cache-Control': 'private, no-cache' } })
  return new NextResponse(result.stream, { headers: { 'Content-Type': result.blob.contentType, ETag: result.blob.etag, 'Cache-Control': 'private, no-cache', 'Content-Disposition': `attachment; filename="${pathname.split('/').pop()}"` } })
}
