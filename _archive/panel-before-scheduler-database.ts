import { createHash, randomBytes } from 'node:crypto'
import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db, ensurePanelSchema } from '@/lib/db'
import { agentCommands, auditLog, backups, consoleLogs, lostItems, mods, nodes, operationLogs, serverPermissions, servers, user, worlds } from '@/lib/db/schema'

const ALL_SECTIONS = ['overview','settings','console','logs','players','software','files','worlds','backups','network','schedules','databases','access'] as const
const SAFE_ADMIN_SECTIONS = ['overview','logs','players','worlds','network'] as const
const GUIDE_SECTIONS = ['overview','logs'] as const

type AppRole = 'manager' | 'admin' | 'guide'

function normalizeRole(role: string): AppRole {
  if (role === 'manager' || role === 'admin' || role === 'guide') return role
  return 'guide'
}
function isManager(role: string) { return normalizeRole(role) === 'manager' }
function defaultSections(role: string) {
  const normalized = normalizeRole(role)
  if (normalized === 'manager') return [...ALL_SECTIONS]
  if (normalized === 'admin') return [...SAFE_ADMIN_SECTIONS]
  return [...GUIDE_SECTIONS]
}
function sectionList(value: unknown, role: string) {
  if (Array.isArray(value)) {
    const safe = [...new Set(value.map(String).filter(v => (ALL_SECTIONS as readonly string[]).includes(v)))]
    if (safe.length) return safe
  }
  return defaultSections(role)
}

async function actor() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  return (await db.select().from(user).where(eq(user.id, session.user.id)).limit(1))[0] ?? null
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function publicHostForNode(nodeId:string){
  const mapRaw=process.env.NODE_PUBLIC_HOSTS
  if(mapRaw){
    try{const map=JSON.parse(mapRaw) as Record<string,string>;const mapped=String(map[nodeId]??'').trim();if(mapped)return mapped.replace(/^https?:\/\//,'').split('/')[0].split(':')[0]}catch{}
  }
  const direct=String(process.env.NODE_PUBLIC_HOST??process.env.PUBLIC_SERVER_HOST??'').trim()
  if(direct)return direct.replace(/^https?:\/\//,'').split('/')[0].split(':')[0]
  const endpoint=process.env.NODE_UPLOAD_URL??process.env.NODE_DOWNLOAD_URL??process.env.NODE_AGENT_BASE_URL
  if(endpoint){try{return new URL(endpoint).hostname}catch{}}
  return ''
}
function withConnection<T extends {nodeId:string;port:number}>(server:T){const publicHost=publicHostForNode(server.nodeId);return {...server,publicHost,connectionAddress:`${publicHost}:${server.port}`}}

function panelBaseUrl(request:NextRequest){
  const configured=process.env.NEXT_PUBLIC_APP_URL??process.env.BETTER_AUTH_URL
  if(configured)return configured.replace(/\/$/,'')
  return request.nextUrl.origin.replace(/\/$/,'')
}

const operations = ['start','stop','restart','kill','console','send-command','list-players','backup','restore-backup','delete-backup','CREATE_BACKUP','LIST_BACKUPS','DOWNLOAD_BACKUP','DELETE_BACKUP','RESTORE_BACKUP','CREATE_WORLD_BACKUP','UPLOAD_WORLD','CHANGE_WORLD','RESET_WORLD','DELETE_WORLD','list-files','read-file','write-file','delete-file','move-file','create-folder','create-archive','delete-server','create-world','reset-world','reset-config','install-addon','set-properties','clear-addons','reinstall','change-software','change-port','factory-reset'] as const
const createSchema = z.object({ action:z.literal('create-server'), nodeId:z.string().uuid(), name:z.string().trim().min(2).max(80).regex(/^[\p{L}\p{N} _-]+$/u), loader:z.enum(['vanilla','paper','fabric','forge','neoforge']), mcVersion:z.string().regex(/^\d+\.\d+(\.\d+)?$/), loaderVersion:z.string().max(80).optional(), memoryMb:z.number().int().min(1024).max(65536), port:z.number().int().min(1024).max(65535), worldName:z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/), seed:z.string().max(100).optional(), itemTrackingEnabled:z.boolean().default(false), eula:z.literal(true) })

async function access(a: NonNullable<Awaited<ReturnType<typeof actor>>>, serverId:string) {
  const server = (await db.select().from(servers).where(and(eq(servers.id,serverId),ne(servers.status,'deleted'))).limit(1))[0]
  if (!server) return null
  if (isManager(a.role)) return { server, admin:true, permission:null, sections:[...ALL_SECTIONS] as string[] }
  const permission = (await db.select().from(serverPermissions).where(and(eq(serverPermissions.serverId,serverId),eq(serverPermissions.userId,a.id))).limit(1))[0]
  if (!permission) return null
  return { server, admin:false, permission, sections:sectionList(permission.sections, a.role) }
}

function allowed(type:string, result:NonNullable<Awaited<ReturnType<typeof access>>>) {
  if(result.admin) return true
  const p=result.permission!
  return type==='start'?p.canStart
    :type==='stop'||type==='kill'?p.canStop
    :type==='restart'?p.canRestart
    :type==='console'||type==='send-command'||type==='list-players'?p.canConsole
    :['backup','restore-backup','delete-backup','CREATE_BACKUP','LIST_BACKUPS','DOWNLOAD_BACKUP','DELETE_BACKUP','RESTORE_BACKUP','CREATE_WORLD_BACKUP'].includes(type)?p.canBackup
    :['list-files','read-file','write-file','delete-file','move-file','create-folder','create-archive'].includes(type)?p.canFiles
    :['delete-server','create-world','reset-world','RESET_WORLD','DELETE_WORLD','CHANGE_WORLD','UPLOAD_WORLD','reset-config','install-addon','set-properties','clear-addons','reinstall','change-software','change-port','factory-reset'].includes(type)?p.canReset
    :false
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request:NextRequest) {
  await ensurePanelSchema()
  const a=await actor()
  if(!a) return NextResponse.json({error:'Unauthorized'},{status:401})
  if(!a.approved) return NextResponse.json({error:'Approval required'},{status:403})

  const requestedServerId=request.nextUrl.searchParams.get('serverId')
  if(requestedServerId){
    const result=await access(a,requestedServerId)
    if(!result)return NextResponse.json({error:'Sunucu bulunamadı veya erişiminiz yok'},{status:404})
    const compactServer=withConnection({id:result.server.id,nodeId:result.server.nodeId,name:result.server.name,loader:result.server.loader,mcVersion:result.server.mcVersion,loaderVersion:result.server.loaderVersion,status:result.server.status,port:result.server.port,memoryMb:result.server.memoryMb,playerCount:result.server.playerCount,installProgress:result.server.installProgress,installError:result.server.installError?.slice(0,500),worldName:result.server.worldName})
    const maySeeWorlds=result.admin||result.sections.includes('worlds')
    const maySeeLogs=result.admin||result.sections.some(section=>['logs','console','players'].includes(section))
    const mayManageAccess=result.admin&&result.sections.includes('access')
    const [nodeRows,worldRows,logRows,operationRows,serverPermissionRows,memberRows]=await Promise.all([
      db.select({id:nodes.id,name:nodes.name,status:nodes.status,lastHeartbeat:nodes.lastHeartbeat,cpuPercent:nodes.cpuPercent,memoryUsedMb:nodes.memoryUsedMb,memoryTotalMb:nodes.memoryTotalMb,diskUsedGb:nodes.diskUsedGb,diskTotalGb:nodes.diskTotalGb}).from(nodes).where(eq(nodes.id,result.server.nodeId)).limit(1),
      maySeeWorlds?db.select().from(worlds).where(eq(worlds.serverId,requestedServerId)).orderBy(desc(worlds.createdAt)):Promise.resolve([]),
      maySeeLogs?db.select({id:consoleLogs.id,serverId:consoleLogs.serverId,line:consoleLogs.line,createdAt:consoleLogs.createdAt}).from(consoleLogs).where(eq(consoleLogs.serverId,requestedServerId)).orderBy(desc(consoleLogs.createdAt)).limit(200):Promise.resolve([]),
      db.select().from(operationLogs).where(eq(operationLogs.serverId,requestedServerId)).orderBy(desc(operationLogs.createdAt)).limit(50),
      mayManageAccess?db.select().from(serverPermissions).where(eq(serverPermissions.serverId,requestedServerId)):Promise.resolve([]),
      mayManageAccess?db.select({id:user.id,name:user.name,email:user.email,role:user.role,approved:user.approved}).from(user).where(eq(user.approved,true)).orderBy(desc(user.createdAt)):Promise.resolve([])
    ])
    return NextResponse.json({
      nodes:nodeRows,servers:[compactServer],worlds:worldRows,mods:[],backups:[],logs:logRows.slice().reverse(),
      users:memberRows.filter(member=>member.id!==a.id),audits:[],lostItems:[],operations:operationRows,
      permissions:serverPermissionRows,currentPermission:result.permission,allowedSections:result.sections,
      actor:{id:a.id,name:a.name,email:a.email,role:normalizeRole(a.role)}
    },{headers:{'Cache-Control':'private, no-store'}})
  }

  const manager=isManager(a.role)
  const permissionRows=manager?await db.select().from(serverPermissions):await db.select().from(serverPermissions).where(eq(serverPermissions.userId,a.id))
  const ids=[...new Set(permissionRows.map(p=>p.serverId))]
  const serverRows=manager
    ?await db.select().from(servers).where(ne(servers.status,'deleted')).orderBy(desc(servers.createdAt))
    :ids.length?await db.select().from(servers).where(and(inArray(servers.id,ids),ne(servers.status,'deleted'))):[]
  const serverIds=serverRows.map(s=>s.id)
  const lostItemServerIds=manager?serverIds:permissionRows.filter(p=>p.canViewLostItems||p.canManageLostItems).map(p=>p.serverId)
  const ownerIds=[...new Set(serverRows.map(s=>s.userId))]

  const [nodeRows,worldRows,modRows,backupRows,logs,users,audits,lost,ops]=await Promise.all([
    manager?db.select().from(nodes).orderBy(desc(nodes.createdAt)):Promise.resolve([]),
    serverIds.length?db.select().from(worlds).where(inArray(worlds.serverId,serverIds)):Promise.resolve([]),
    serverIds.length?db.select().from(mods).where(inArray(mods.serverId,serverIds)):Promise.resolve([]),
    manager&&ownerIds.length?db.select().from(backups).where(inArray(backups.userId,ownerIds)).orderBy(desc(backups.createdAt)):Promise.resolve([]),
    serverIds.length?db.select({id:consoleLogs.id,serverId:consoleLogs.serverId,line:consoleLogs.line,createdAt:consoleLogs.createdAt}).from(consoleLogs).where(inArray(consoleLogs.serverId,serverIds)).orderBy(desc(consoleLogs.createdAt)).limit(50):Promise.resolve([]),
    manager?db.select({id:user.id,name:user.name,email:user.email,role:user.role,approved:user.approved,createdAt:user.createdAt}).from(user).orderBy(desc(user.createdAt)):Promise.resolve([]),
    manager?db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200):Promise.resolve([]),
    lostItemServerIds.length?db.select().from(lostItems).where(inArray(lostItems.serverId,lostItemServerIds)).orderBy(desc(lostItems.occurredAt)).limit(1000):Promise.resolve([]),
    serverIds.length?db.select().from(operationLogs).where(inArray(operationLogs.serverId,serverIds)).orderBy(desc(operationLogs.createdAt)).limit(200):Promise.resolve([])
  ])
  return NextResponse.json({nodes:nodeRows,servers:serverRows.map(withConnection),worlds:worldRows,mods:modRows,backups:backupRows,logs,users,audits,lostItems:lost,operations:ops,permissions:permissionRows,actor:{id:a.id,name:a.name,email:a.email,role:normalizeRole(a.role)}})
}

export async function POST(request:NextRequest) {
  await ensurePanelSchema()
  const a=await actor()
  if(!a)return NextResponse.json({error:'Unauthorized'},{status:401})
  if(!a.approved)return NextResponse.json({error:'Approval required'},{status:403})
  const body=await request.json()
  const manager=isManager(a.role)

  if(body.action==='create-node'){
    if(!manager)return NextResponse.json({error:'Yalnız Yönetici node oluşturabilir'},{status:403})
    const name=z.string().trim().min(2).max(80).parse(body.name)
    const existing=await db.select({id:nodes.id}).from(nodes).where(eq(nodes.name,name)).limit(1)
    if(existing.length)return NextResponse.json({error:'Bu isimde bir node zaten var'},{status:409})
    const token=randomBytes(32).toString('base64url')
    const [node]=await db.insert(nodes).values({userId:a.id,name,agentTokenHash:hash(token)}).returning()
    if(!node)return NextResponse.json({error:'Node oluşturulamadı'},{status:500})
    const panelUrl=panelBaseUrl(request)
    if(process.env.NODE_ENV==='production'&&/localhost|127\.0\.0\.1/.test(panelUrl))throw new Error('Production panel URL is not configured')
    return NextResponse.json({node,token,install:`export PANEL_URL=${panelUrl} NODE_ID=${node.id} NODE_TOKEN=${token} DATA_DIR=/srv/blockctrl && pnpm install --frozen-lockfile && pnpm build && pnpm start`},{status:201})
  }
  if(body.action==='node-install-info'){
    if(!manager)return NextResponse.json({error:'Forbidden'},{status:403})
    const nodeId=z.string().uuid().parse(body.nodeId)
    const node=(await db.select().from(nodes).where(eq(nodes.id,nodeId)).limit(1))[0]
    if(!node)return NextResponse.json({error:'Node bulunamadı'},{status:404})
    const panelUrl=panelBaseUrl(request)
    return NextResponse.json({nodeId,token:null,install:`export PANEL_URL=${panelUrl} NODE_ID=${node.id} NODE_TOKEN=MEVCUT_TOKENI_KULLANIN DATA_DIR=/srv/blockctrl && pnpm install --frozen-lockfile && pnpm build && pnpm start`})
  }
  if(body.action==='regenerate-node-token'){
    if(!manager)return NextResponse.json({error:'Forbidden'},{status:403})
    const nodeId=z.string().uuid().parse(body.nodeId)
    const node=(await db.select().from(nodes).where(eq(nodes.id,nodeId)).limit(1))[0]
    if(!node)return NextResponse.json({error:'Node bulunamadı'},{status:404})
    const token=randomBytes(32).toString('base64url')
    await db.update(nodes).set({agentTokenHash:hash(token),status:'offline',updatedAt:new Date()}).where(eq(nodes.id,nodeId))
    const panelUrl=panelBaseUrl(request)
    if(process.env.NODE_ENV==='production'&&/localhost|127\.0\.0\.1/.test(panelUrl))throw new Error('Production panel URL is not configured')
    return NextResponse.json({nodeId,token,install:`export PANEL_URL=${panelUrl} NODE_ID=${nodeId} NODE_TOKEN=${token} DATA_DIR=/srv/blockctrl && pnpm install --frozen-lockfile && pnpm build && pnpm start`},{status:200})
  }
  if(body.action==='update-node'){
    if(!manager)return NextResponse.json({error:'Forbidden'},{status:403})
    const nodeId=z.string().uuid().parse(body.nodeId)
    const name=z.string().trim().min(2).max(80).regex(/^[\p{L}\p{N} _-]+$/u).parse(body.name)
    const node=(await db.select().from(nodes).where(eq(nodes.id,nodeId)).limit(1))[0]
    if(!node)return NextResponse.json({error:'Node bulunamadı'},{status:404})
    await db.update(nodes).set({name,updatedAt:new Date()}).where(eq(nodes.id,nodeId))
    return NextResponse.json({ok:true})
  }
  if(body.action==='delete-node'){
    if(!manager)return NextResponse.json({error:'Forbidden'},{status:403})
    const nodeId=z.string().uuid().parse(body.nodeId)
    const node=(await db.select().from(nodes).where(eq(nodes.id,nodeId)).limit(1))[0]
    if(!node)return NextResponse.json({error:'Node bulunamadı'},{status:404})
    const attached=await db.select({id:servers.id}).from(servers).where(and(eq(servers.nodeId,nodeId),ne(servers.status,'deleted'))).limit(1)
    if(attached.length)return NextResponse.json({error:'Bu node üzerinde sunucular var; önce sunucuları kaldırın'},{status:409})
    await db.delete(nodes).where(eq(nodes.id,nodeId))
    return NextResponse.json({ok:true})
  }
  if(body.action==='create-server'){
    if(!manager)return NextResponse.json({error:'Yalnız Yönetici sunucu oluşturabilir'},{status:403})
    const i=createSchema.parse(body)
    const node=(await db.select().from(nodes).where(eq(nodes.id,i.nodeId)).limit(1))[0]
    if(!node)return NextResponse.json({error:'Node bulunamadı'},{status:404})
    if(node.status!=='online')return NextResponse.json({error:'Node çevrimdışı. Önce kurulum komutunu VPS üzerinde çalıştırıp agenti bağlayın.'},{status:409})
    const collision=await db.select({id:servers.id}).from(servers).where(and(eq(servers.nodeId,i.nodeId),eq(servers.port,i.port),ne(servers.status,'deleted'))).limit(1)
    if(collision.length)return NextResponse.json({error:'Bu port aynı node üzerinde kullanımda'},{status:409})
    if(i.itemTrackingEnabled&&!['paper','neoforge'].includes(i.loader))return NextResponse.json({error:'Tam kayıp eşya takibi Paper ve NeoForge sunucularında destekleniyor'},{status:400})
    const [server]=await db.insert(servers).values({userId:a.id,nodeId:i.nodeId,name:i.name,loader:i.loader,mcVersion:i.mcVersion,loaderVersion:i.loaderVersion,memoryMb:i.memoryMb,port:i.port,status:'queued',worldName:i.worldName,itemTrackingEnabled:i.itemTrackingEnabled}).returning()
    await db.insert(worlds).values({userId:a.id,serverId:server.id,name:i.worldName,seed:i.seed,isActive:true})
    await db.insert(agentCommands).values({userId:a.id,nodeId:i.nodeId,serverId:server.id,type:'install',payload:i})
    await db.insert(operationLogs).values({userId:a.id,serverId:server.id,operation:'install',status:'queued'})
    return NextResponse.json({server},{status:201})
  }
  if(body.action==='update-server'){
    if(!manager)return NextResponse.json({error:'Yalnız Yönetici sunucu bilgisini düzenleyebilir'},{status:403})
    const serverId=z.string().uuid().parse(body.serverId)
    const name=z.string().trim().min(2).max(80).regex(/^[\p{L}\p{N} _-]+$/u).parse(body.name)
    const server=(await db.select().from(servers).where(eq(servers.id,serverId)).limit(1))[0]
    if(!server)return NextResponse.json({error:'Sunucu bulunamadı'},{status:404})
    await db.update(servers).set({name,updatedAt:new Date()}).where(eq(servers.id,serverId))
    return NextResponse.json({ok:true})
  }
  if(body.action==='command'){
    const serverId=z.string().uuid().parse(body.serverId)
    const type=z.enum(operations).parse(body.type)
    const result=await access(a,serverId)
    if(!result)return NextResponse.json({error:'Sunucu bulunamadı'},{status:404})
    if(!allowed(type,result))return NextResponse.json({error:'Bu işlem için yetkiniz yok'},{status:403})
    if(['LIST_BACKUPS','DOWNLOAD_BACKUP'].includes(type))return NextResponse.json({error:'Backup listesi ve indirme panel endpointinden yapılmalıdır'},{status:400})
    if(type==='set-properties'){
      if(result.server.status==='running')return NextResponse.json({error:'Ayarları kaydetmeden önce sunucuyu durdurun'},{status:409})
      const payload=body.payload&&typeof body.payload==='object'?body.payload:{}
      const [command]=await db.insert(agentCommands).values({userId:result.server.userId,nodeId:result.server.nodeId,serverId,type,payload:{...payload,serverId},status:'queued'}).returning()
      await db.insert(operationLogs).values({userId:result.server.userId,serverId,operation:type,status:'queued'})
      return NextResponse.json({ok:true,command},{status:202})
    }
    if(type==='delete-server'){
      if(body.confirm!==result.server.name)return NextResponse.json({error:'Onay için sunucu adını yazın'},{status:400})
      await db.update(servers).set({status:'deleted',updatedAt:new Date()}).where(eq(servers.id,serverId))
      await db.insert(agentCommands).values({userId:result.server.userId,nodeId:result.server.nodeId,serverId,type:'delete-server',payload:{},status:'queued'})
      await db.insert(operationLogs).values({userId:result.server.userId,serverId,operation:'delete-server',status:'queued'})
      return NextResponse.json({ok:true,status:'deleted'},{status:202})
    }
    if(type==='change-port'){
      const newPort=Number(body.payload?.port)
      if(!Number.isInteger(newPort)||newPort<1024||newPort>65535)return NextResponse.json({error:'Geçersiz port'},{status:400})
      const collision=await db.select({id:servers.id}).from(servers).where(and(eq(servers.nodeId,result.server.nodeId),eq(servers.port,newPort),ne(servers.status,'deleted'))).limit(1)
      if(collision.some(row=>row.id!==serverId))return NextResponse.json({error:'Bu port aynı node üzerinde kullanımda'},{status:409})
    }
    if(type==='start'&&!['stopped','crashed','ready'].includes(result.server.status))return NextResponse.json({error:'Sunucu yalnız kapalıyken başlatılabilir'},{status:409})
    if(['delete-server','create-world','reset-world','RESET_WORLD','DELETE_WORLD','CHANGE_WORLD','UPLOAD_WORLD','reset-config','install-addon','clear-addons','reinstall','change-software','change-port','factory-reset'].includes(type)&&!['stopped','crashed','ready','failed'].includes(result.server.status))return NextResponse.json({error:'Bu işlem için sunucu kapalı olmalıdır'},{status:409})
    const destructive=['delete-server','create-world','reset-world','RESET_WORLD','DELETE_WORLD','CHANGE_WORLD','UPLOAD_WORLD','reset-config','install-addon','clear-addons','reinstall','change-software','factory-reset'].includes(type)
    if(destructive&&body.confirm!==result.server.name)return NextResponse.json({error:'Onay için sunucu adını yazın'},{status:400})
    const [command]=await db.insert(agentCommands).values({userId:result.server.userId,nodeId:result.server.nodeId,serverId,type,payload:{memoryMb:result.server.memoryMb,loader:result.server.loader,mcVersion:result.server.mcVersion,loaderVersion:result.server.loaderVersion,port:result.server.port,worldName:result.server.worldName,...(body.payload??{}),backupFirst:destructive}}).returning()
    await db.insert(operationLogs).values({userId:result.server.userId,serverId,operation:type,status:'queued'})
    await db.insert(auditLog).values({userId:a.id,action:`server.${type}`,resourceType:'server',resourceId:serverId,details:{serverOwner:result.server.userId}})
    return NextResponse.json({command},{status:202})
  }
  if(body.action==='delete-lost-item'){
    const id=z.string().uuid().parse(body.id)
    const item=(await db.select().from(lostItems).where(eq(lostItems.id,id)).limit(1))[0]
    if(!item)return NextResponse.json({error:'Kayıt bulunamadı'},{status:404})
    const result=await access(a,item.serverId)
    if(!result||(!result.admin&&!result.permission?.canManageLostItems))return NextResponse.json({error:'Bu kaydı silme yetkiniz yok'},{status:403})
    await db.delete(lostItems).where(and(eq(lostItems.id,id),eq(lostItems.serverId,item.serverId)))
    await db.insert(auditLog).values({userId:a.id,action:'lost-item.deleted',resourceType:'lost-item',resourceId:id,details:{serverId:item.serverId}})
    return NextResponse.json({ok:true})
  }
  if(body.action==='remove-permission'){
    if(!manager)return NextResponse.json({error:'Yalnız Yönetici sunucu erişimi kaldırabilir'},{status:403})
    const serverId=z.string().uuid().parse(body.serverId)
    const userId=z.string().min(1).parse(body.userId)
    await db.delete(serverPermissions).where(and(eq(serverPermissions.serverId,serverId),eq(serverPermissions.userId,userId)))
    await db.insert(auditLog).values({userId:a.id,action:'permission.removed',resourceType:'server',resourceId:serverId,details:{targetUserId:userId}})
    return NextResponse.json({ok:true})
  }
  if(body.action==='set-permission'){
    if(!manager)return NextResponse.json({error:'Yalnız Yönetici sunucu erişimi verebilir'},{status:403})
    const serverId=z.string().uuid().parse(body.serverId)
    const userId=z.string().min(1).parse(body.userId)
    const server=(await db.select().from(servers).where(and(eq(servers.id,serverId),ne(servers.status,'deleted'))).limit(1))[0]
    if(!server)return NextResponse.json({error:'Sunucu bulunamadı'},{status:404})
    const target=(await db.select().from(user).where(eq(user.id,userId)).limit(1))[0]
    if(!target)return NextResponse.json({error:'Kullanıcı bulunamadı'},{status:404})
    if(isManager(target.role))return NextResponse.json({error:'Yönetici rolü zaten tüm sunuculara tam erişir'},{status:400})
    const sections=sectionList(body.sections,target.role)
    const values={userId,ownerUserId:server.userId,serverId,canStart:!!body.canStart,canStop:!!body.canStop,canRestart:!!body.canRestart,canConsole:!!body.canConsole,canFiles:!!body.canFiles,canBackup:!!body.canBackup,canReset:!!body.canReset,canViewLostItems:!!body.canViewLostItems,canManageLostItems:!!body.canManageLostItems,sections}
    await db.insert(serverPermissions).values(values).onConflictDoUpdate({target:[serverPermissions.userId,serverPermissions.serverId],set:values})
    await db.insert(auditLog).values({userId:a.id,action:'permission.updated',resourceType:'server',resourceId:serverId,details:{targetUserId:userId,sections}})
    return NextResponse.json({ok:true})
  }
  if(body.action==='update-user'){
    if(!manager)return NextResponse.json({error:'Yalnız Yönetici kullanıcıları onaylayabilir ve rol değiştirebilir'},{status:403})
    const userId=z.string().min(1).parse(body.userId)
    if(userId===a.id)return NextResponse.json({error:'Kendi rolünüzü veya onayınızı bu ekrandan değiştiremezsiniz'},{status:400})
    const approved=z.boolean().parse(body.approved)
    const role=z.enum(['manager','admin','guide']).parse(body.role??'guide')
    const target=(await db.select().from(user).where(eq(user.id,userId)).limit(1))[0]
    if(!target)return NextResponse.json({error:'Kullanıcı bulunamadı'},{status:404})
    if(isManager(target.role)&&(!approved||role!=='manager')){
      const otherManagers=await db.select({id:user.id}).from(user).where(eq(user.role,'manager')).limit(2)
      if(otherManagers.length<=1)return NextResponse.json({error:'Sistemde en az bir Yönetici kalmalıdır'},{status:409})
    }
    await db.update(user).set({approved,role,updatedAt:new Date()}).where(eq(user.id,userId))
    await db.insert(auditLog).values({userId:a.id,action:'user.updated',resourceType:'user',resourceId:userId,details:{approved,role}})
    return NextResponse.json({ok:true})
  }
  return NextResponse.json({error:'Unknown action'},{status:400})
}
