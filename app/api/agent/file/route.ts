import { get } from '@vercel/blob'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { timingSafeEqual, createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { agentCommands, nodes, servers } from '@/lib/db/schema'
export async function GET(request: NextRequest) {
  const nodeId=request.headers.get('x-node-id'); const token=request.headers.get('authorization')?.replace(/^Bearer\s+/i,''); const pathname=request.nextUrl.searchParams.get('pathname'); const serverId=request.nextUrl.searchParams.get('serverId')
  if(!nodeId||!token||!pathname||!serverId)return NextResponse.json({error:'Bad request'},{status:400})
  const node=(await db.select().from(nodes).where(eq(nodes.id,nodeId)).limit(1))[0]; const server=(await db.select().from(servers).where(and(eq(servers.id,serverId),eq(servers.nodeId,nodeId))).limit(1))[0]
  if(!node||!server)return NextResponse.json({error:'Unauthorized'},{status:401}); const a=Buffer.from(createHash('sha256').update(token).digest('hex')); const b=Buffer.from(node.agentTokenHash); if(a.length!==b.length||!timingSafeEqual(a,b))return NextResponse.json({error:'Unauthorized'},{status:401})
  const commands=await db.select({payload:agentCommands.payload}).from(agentCommands).where(and(eq(agentCommands.serverId,serverId),eq(agentCommands.nodeId,nodeId)))
  const owned=commands.some(command=>{const payload=(command.payload??{}) as Record<string,unknown>;return payload.pathname===pathname})
  if(!owned)return NextResponse.json({error:'File is not authorized for this server command'},{status:403})
  const result=await get(pathname,{access:'private'}); if(!result)return new NextResponse('Not found',{status:404}); return new NextResponse(result.stream,{headers:{'Content-Type':result.blob.contentType??'application/octet-stream'}})
}
