import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, desc, eq, inArray, lt, ne, or } from 'drizzle-orm'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db, ensurePanelSchema } from '@/lib/db'
import { agentCommands, auditLog, backups, consoleLogs, lostItems, managedDatabases, mods, nodes, operationLogs, serverPermissions, serverSchedules, serverSftp, servers, user, worlds } from '@/lib/db/schema'
import { resolvePanelUser } from '@/lib/db/identity'
import { getNodeConfig, nodeDiagnosticMessage, nodeFetch, nodePublicHost } from '@/lib/node-bridge'
import { isCompatibleNeoForgeVersion } from '@/lib/neoforge-version'

const ALL_SECTIONS = ['overview','settings','console','logs','players','software','files','worlds','backups','network','integrations','schedules','databases','access'] as const
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
  return resolvePanelUser(session.user)
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function publicHostForNode(nodeId:string){ return nodePublicHost(nodeId) ?? 'node-configured-address' }
async function nodeJson(nodeId:string,path:string,init:RequestInit={}){const response=await nodeFetch(nodeId,path,init);const text=await response.text();let data:Record<string,unknown>={};try{data=text?JSON.parse(text) as Record<string,unknown>:{} }catch{data={error:text.slice(0,500)}}if(!response.ok)throw new Error(String(data.error??`Node SFTP işlemi başarısız (HTTP ${response.status})`));return data}
function sftpStatus(value:unknown){return value===true?'ready':'failed'}
function connectivityState(node:{status:string;lastHeartbeat:Date|null}, directError?:string){const heartbeatOnline=node.status==='online'&&!!node.lastHeartbeat&&Date.now()-node.lastHeartbeat.getTime()<60_000;return {heartbeatOnline,directOnline:!directError,directError:directError??null,label:heartbeatOnline&&!directError?'Node online':heartbeatOnline?'Agent online fakat doğrudan node bağlantısı başarısız':'Node offline'}}
function withConnection<T extends {nodeId:string;port:number}>(server:T){const publicHost=publicHostForNode(server.nodeId);return {...server,publicHost,connectionAddress:`${publicHost}:${server.port}`}}

function panelBaseUrl(request:NextRequest){
  const configured=process.env.NEXT_PUBLIC_APP_URL??process.env.BETTER_AUTH_URL
  if(configured)return configured.replace(/\/$/,'')
  return request.nextUrl.origin.replace(/\/$/,'')
}


function nextScheduleAt(input:{cadence:string;timeOfDay?:string|null;weekday?:number|null;intervalMinutes?:number|null;timezoneOffsetMinutes?:number|null}, from=new Date()){
  const cadence=input.cadence
  const offset=Math.max(-840,Math.min(840,Number(input.timezoneOffsetMinutes??0)))
  if(cadence==='interval'){
    const minutes=Math.max(5,Math.min(10080,Number(input.intervalMinutes??60)))
    return new Date(from.getTime()+minutes*60_000)
  }
  const match=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(input.timeOfDay??'04:00'))
  const hour=Number(match?.[1]??4), minute=Number(match?.[2]??0)
  const localNow=new Date(from.getTime()-offset*60_000)
  const localTargetMs=Date.UTC(localNow.getUTCFullYear(),localNow.getUTCMonth(),localNow.getUTCDate(),hour,minute,0,0)
  let targetMs=localTargetMs+offset*60_000
  if(cadence==='weekly'){
    const wanted=Math.max(0,Math.min(6,Number(input.weekday??0)))
    let diff=(wanted-localNow.getUTCDay()+7)%7
    if(diff===0&&targetMs<=from.getTime())diff=7
    targetMs+=diff*86_400_000
  }else if(targetMs<=from.getTime()){
    targetMs+=86_400_000
  }
  return new Date(targetMs)
}

const operations = ['start','stop','restart','kill','reconnect-node','refresh-node','console','send-command','list-players','backup','restore-backup','delete-backup','CREATE_BACKUP','LIST_BACKUPS','DOWNLOAD_BACKUP','DELETE_BACKUP','RESTORE_BACKUP','CREATE_WORLD_BACKUP','UPLOAD_WORLD','CHANGE_WORLD','RESET_WORLD','DELETE_WORLD','list-files','read-file','write-file','delete-file','move-file','create-folder','create-archive','delete-server','create-world','reset-world','reset-config','install-addon','set-properties','clear-addons','reinstall','change-software','change-port','factory-reset'] as const
const serverNameSchema=z.string().trim().min(2).max(80).refine(value=>!value.includes('..')&&!/[\\/\0\x00-\x1F\x7F]/.test(value),'Geçersiz sunucu adı')
const createSchema = z.object({ action:z.literal('create-server'), nodeId:z.string().uuid(), name:serverNameSchema, loader:z.enum(['vanilla','paper','fabric','forge','neoforge']), mcVersion:z.string().regex(/^\d+\.\d+(\.\d+)?$/), loaderVersion:z.string().max(80).optional(), memoryMb:z.number().int().min(1024).max(65536), port:z.number().int().min(1024).max(65535), worldName:z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/), seed:z.string().max(100).optional(), itemTrackingEnabled:z.boolean().default(false), eula:z.literal(true) })

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

async function getPanel(request:NextRequest) {
  await ensurePanelSchema()
  const a=await actor()
  if(!a) return NextResponse.json({error:'Unauthorized'},{status:401})
  if(!a.approved) return NextResponse.json({error:'Approval required'},{status:403})
  await db.update(nodes).set({status:'offline',updatedAt:new Date()}).where(and(eq(nodes.status,'online'),lt(nodes.lastHeartbeat,new Date(Date.now()-60_000))))

  const requestedServerId=request.nextUrl.searchParams.get('serverId')
  if(requestedServerId){
    const result=await access(a,requestedServerId)
    if(!result)return NextResponse.json({error:'Sunucu bulunamadı veya erişiminiz yok'},{status:404})
    const compactServer=withConnection({id:result.server.id,nodeId:result.server.nodeId,name:result.server.name,loader:result.server.loader,mcVersion:result.server.mcVersion,loaderVersion:result.server.loaderVersion,status:result.server.status,port:result.server.port,memoryMb:result.server.memoryMb,playerCount:result.server.playerCount,installProgress:result.server.installProgress,installError:result.server.installError?.slice(0,500),worldName:result.server.worldName})
    let directBridge:{online:boolean;error?:string;status?:number}={online:false}
  try{const config=getNodeConfig(result.server.nodeId);const bridge=await fetch(`${config.baseUrl}/health`,{headers:{authorization:`Bearer ${config.token}`,'x-node-id':result.server.nodeId},cache:'no-store',signal:AbortSignal.timeout(8000)});directBridge={online:bridge.ok,status:bridge.status};if(!bridge.ok)directBridge.error=`HTTP ${bridge.status}`}catch(error){directBridge={online:false,error:nodeDiagnosticMessage(error)}}
  const maySeeWorlds=result.admin||result.sections.includes('worlds')
    const maySeeLogs=result.admin||result.sections.some(section=>['logs','console','players'].includes(section))
    const mayManageAccess=result.admin&&result.sections.includes('access')
    const maySeeSchedules=result.admin||result.sections.includes('schedules')
    const maySeeDatabases=result.admin||result.sections.includes('databases')
    const [nodeRows,worldRows,logRows,operationRows,serverPermissionRows,memberRows,scheduleRows,databaseRows,sftpRows]=await Promise.all([
      db.select({id:nodes.id,name:nodes.name,status:nodes.status,lastHeartbeat:nodes.lastHeartbeat,cpuPercent:nodes.cpuPercent,memoryUsedMb:nodes.memoryUsedMb,memoryTotalMb:nodes.memoryTotalMb,diskUsedGb:nodes.diskUsedGb,diskTotalGb:nodes.diskTotalGb}).from(nodes).where(eq(nodes.id,result.server.nodeId)).limit(1),
      maySeeWorlds?db.select().from(worlds).where(eq(worlds.serverId,requestedServerId)).orderBy(desc(worlds.createdAt)):Promise.resolve([]),
      maySeeLogs?db.select({id:consoleLogs.id,serverId:consoleLogs.serverId,line:consoleLogs.line,createdAt:consoleLogs.createdAt}).from(consoleLogs).where(eq(consoleLogs.serverId,requestedServerId)).orderBy(desc(consoleLogs.createdAt)).limit(200):Promise.resolve([]),
      db.select().from(operationLogs).where(eq(operationLogs.serverId,requestedServerId)).orderBy(desc(operationLogs.createdAt)).limit(50),
      mayManageAccess?db.select().from(serverPermissions).where(eq(serverPermissions.serverId,requestedServerId)):Promise.resolve([]),
      mayManageAccess?db.select({id:user.id,name:user.name,email:user.email,role:user.role,approved:user.approved}).from(user).where(eq(user.approved,true)).orderBy(desc(user.createdAt)):Promise.resolve([]),
      maySeeSchedules?db.select().from(serverSchedules).where(eq(serverSchedules.serverId,requestedServerId)).orderBy(desc(serverSchedules.createdAt)):Promise.resolve([]),
      maySeeDatabases?db.select().from(managedDatabases).where(eq(managedDatabases.serverId,requestedServerId)).orderBy(desc(managedDatabases.createdAt)):Promise.resolve([]),
      result.admin?db.select({id:serverSftp.id,serverId:serverSftp.serverId,nodeId:serverSftp.nodeId,username:serverSftp.username,port:serverSftp.port,rootPath:serverSftp.rootPath,status:serverSftp.status,lastError:serverSftp.lastError,lastTestAt:serverSftp.lastTestAt,passwordRotatedAt:serverSftp.passwordRotatedAt,disabledAt:serverSftp.disabledAt,createdAt:serverSftp.createdAt,updatedAt:serverSftp.updatedAt}).from(serverSftp).where(eq(serverSftp.serverId,requestedServerId)).limit(1):Promise.resolve([])
    ])
    return NextResponse.json({
      nodes:nodeRows,servers:[{...compactServer,directBridge,connectivity:connectivityState(nodeRows[0]??{status:'offline',lastHeartbeat:null},directBridge.online?undefined:directBridge.error)}],worlds:worldRows,mods:[],backups:[],logs:logRows.slice().reverse(),
      users:memberRows.filter(member=>member.id!==a.id),audits:[],lostItems:[],operations:operationRows,
      permissions:serverPermissionRows,currentPermission:result.permission,allowedSections:result.sections,
      schedules:scheduleRows,databases:databaseRows,sftp:sftpRows[0]??null,
actor:{id:a.id,name:a.name,email:a.email,role:normalizeRole(a.role)},nodeConnectivity:directBridge
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
  const recoveryServers=serverRows.filter(server=>['queued','failed'].includes(server.status)).map(server=>({id:server.id,name:server.name,status:server.status,installError:server.installError,hasInstallCommand:true}))
  return NextResponse.json({nodes:nodeRows,servers:serverRows.map(withConnection),worlds:worldRows,mods:modRows,backups:backupRows,logs,users,audits,lostItems:lost,operations:ops,recoveryServers,permissions:permissionRows,actor:{id:a.id,name:a.name,email:a.email,role:normalizeRole(a.role)}})
}

export async function GET(request:NextRequest){const requestId=request.headers.get('x-request-id')??crypto.randomUUID();try{return await getPanel(request)}catch(error){const e=error as {code?:string;table?:string;column?:string;message?:string};console.error('[panel-api:GET]',{requestId,code:e.code??'UNKNOWN',table:e.table??null,column:e.column??null,message:e.message??'database error'});return NextResponse.json({error:'Canlı panel verileri alınamadı',code:'PANEL_DATA_ERROR',requestId},{status:500})}}

async function postPanel(request:NextRequest) {
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
    const name=serverNameSchema.parse(body.name)
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
    if(i.loader==='neoforge'&&(!i.loaderVersion||!isCompatibleNeoForgeVersion(i.mcVersion,i.loaderVersion)))return NextResponse.json({error:'NeoForge sürümü Minecraft sürümüyle uyumsuz',code:'INCOMPATIBLE_LOADER_VERSION'},{status:400})
    const server=await db.transaction(async tx=>{const [created]=await tx.insert(servers).values({userId:a.id,nodeId:i.nodeId,name:i.name,loader:i.loader,mcVersion:i.mcVersion,loaderVersion:i.loaderVersion,memoryMb:i.memoryMb,port:i.port,status:'queued',worldName:i.worldName,itemTrackingEnabled:i.itemTrackingEnabled}).returning();if(!created)throw new Error('SERVER_INSERT_FAILED');await tx.insert(worlds).values({userId:a.id,serverId:created.id,name:i.worldName,seed:i.seed,isActive:true});await tx.insert(agentCommands).values({userId:a.id,nodeId:i.nodeId,serverId:created.id,type:'install',payload:i});await tx.insert(operationLogs).values({userId:a.id,serverId:created.id,operation:'install',status:'queued'});return created})
    return NextResponse.json({server},{status:201})
  }
  if(body.action==='update-server'){
    if(!manager)return NextResponse.json({error:'Yalnız Yönetici sunucu bilgisini düzenleyebilir'},{status:403})
    const serverId=z.string().uuid().parse(body.serverId)
    const name=serverNameSchema.parse(body.name)
    const server=(await db.select().from(servers).where(eq(servers.id,serverId)).limit(1))[0]
    if(!server)return NextResponse.json({error:'Sunucu bulunamadı'},{status:404})
    await db.update(servers).set({name,updatedAt:new Date()}).where(eq(servers.id,serverId))
    return NextResponse.json({ok:true})
  }

  if(body.action==='create-schedule'){
    if(!manager)return NextResponse.json({error:'Zamanlama oluşturmak için Yönetici yetkisi gerekir'},{status:403})
    const serverId=z.string().uuid().parse(body.serverId)
    const result=await access(a,serverId)
    if(!result)return NextResponse.json({error:'Sunucu bulunamadı'},{status:404})
    const name=z.string().trim().min(2).max(80).parse(body.name)
    const taskType=z.enum(['restart','backup','log-cleanup','security-scan','file-integrity','port-scan']).parse(body.taskType)
    const cadence=z.enum(['daily','weekly','interval']).parse(body.cadence)
    const timeOfDay=cadence==='interval'?null:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).parse(body.timeOfDay??'04:00')
    const weekday=cadence==='weekly'?z.number().int().min(0).max(6).parse(Number(body.weekday)):null
    const intervalMinutes=cadence==='interval'?z.number().int().min(5).max(10080).parse(Number(body.intervalMinutes)):null
    const timezoneOffsetMinutes=z.number().int().min(-840).max(840).parse(Number(body.timezoneOffsetMinutes??0))
    const retentionDays=taskType==='log-cleanup'?z.number().int().min(1).max(365).parse(Number(body.retentionDays??30)):30
    const nextRunAt=nextScheduleAt({cadence,timeOfDay,weekday,intervalMinutes,timezoneOffsetMinutes})
    const [schedule]=await db.insert(serverSchedules).values({userId:a.id,serverId,name,taskType,cadence,timeOfDay,weekday,intervalMinutes,timezoneOffsetMinutes,payload:{retentionDays},nextRunAt}).returning()
    await db.insert(auditLog).values({userId:a.id,action:'schedule.created',resourceType:'server',resourceId:serverId,details:{scheduleId:schedule.id,taskType,cadence}})
    return NextResponse.json({schedule},{status:201})
  }
  if(body.action==='toggle-schedule'){
    if(!manager)return NextResponse.json({error:'Forbidden'},{status:403})
    const scheduleId=z.string().uuid().parse(body.scheduleId)
    const schedule=(await db.select().from(serverSchedules).where(eq(serverSchedules.id,scheduleId)).limit(1))[0]
    if(!schedule)return NextResponse.json({error:'Zamanlama bulunamadı'},{status:404})
    const enabled=z.boolean().parse(body.enabled)
    await db.update(serverSchedules).set({enabled,nextRunAt:enabled?nextScheduleAt(schedule):schedule.nextRunAt,updatedAt:new Date()}).where(eq(serverSchedules.id,scheduleId))
    return NextResponse.json({ok:true})
  }
  if(body.action==='delete-schedule'){
    if(!manager)return NextResponse.json({error:'Forbidden'},{status:403})
    const scheduleId=z.string().uuid().parse(body.scheduleId)
    await db.delete(serverSchedules).where(eq(serverSchedules.id,scheduleId))
    return NextResponse.json({ok:true})
  }
  if(body.action==='create-database'){
    if(!manager)return NextResponse.json({error:'Veritabanı oluşturmak için Yönetici yetkisi gerekir'},{status:403})
    const serverId=z.string().uuid().parse(body.serverId)
    const result=await access(a,serverId)
    if(!result)return NextResponse.json({error:'Sunucu bulunamadı'},{status:404})
    const databaseName=z.string().trim().min(2).max(48).regex(/^[A-Za-z0-9_]+$/).parse(body.databaseName)
    const databaseUser=z.string().trim().min(2).max(28).regex(/^[A-Za-z0-9_]+$/).parse(body.databaseUser)
    const duplicate=await db.select({id:managedDatabases.id,databaseName:managedDatabases.databaseName,databaseUser:managedDatabases.databaseUser}).from(managedDatabases).where(eq(managedDatabases.serverId,serverId))
    if(duplicate.some(row=>row.databaseName===databaseName))return NextResponse.json({error:'Bu sunucuda aynı isimde yönetilen veritabanı zaten var'},{status:409})
    if(duplicate.some(row=>row.databaseUser===databaseUser))return NextResponse.json({error:'Bu sunucuda aynı veritabanı kullanıcısı zaten var'},{status:409})
    const [record]=await db.insert(managedDatabases).values({userId:a.id,serverId,nodeId:result.server.nodeId,engine:'mariadb',databaseName,databaseUser,status:'queued'}).returning()
    await db.insert(agentCommands).values({userId:a.id,nodeId:result.server.nodeId,serverId,type:'database-create',payload:{databaseId:record.id,databaseName,databaseUser}})
    await db.insert(operationLogs).values({userId:a.id,serverId,operation:'database-create',status:'queued'})
    return NextResponse.json({database:record},{status:202})
  }
  if(body.action==='rotate-database-password'){
    if(!manager)return NextResponse.json({error:'Forbidden'},{status:403})
    const databaseId=z.string().uuid().parse(body.databaseId)
    const record=(await db.select().from(managedDatabases).where(eq(managedDatabases.id,databaseId)).limit(1))[0]
    if(!record)return NextResponse.json({error:'Veritabanı kaydı bulunamadı'},{status:404})
    await db.update(managedDatabases).set({status:'rotating',lastError:null,updatedAt:new Date()}).where(eq(managedDatabases.id,databaseId))
    await db.insert(agentCommands).values({userId:a.id,nodeId:record.nodeId,serverId:record.serverId,type:'database-rotate-password',payload:{databaseId:record.id,databaseName:record.databaseName,databaseUser:record.databaseUser}})
    await db.insert(operationLogs).values({userId:a.id,serverId:record.serverId,operation:'database-rotate-password',status:'queued'})
    return NextResponse.json({ok:true},{status:202})
  }
  if(body.action==='delete-database'){
    if(!manager)return NextResponse.json({error:'Forbidden'},{status:403})
    const databaseId=z.string().uuid().parse(body.databaseId)
    const record=(await db.select().from(managedDatabases).where(eq(managedDatabases.id,databaseId)).limit(1))[0]
    if(!record)return NextResponse.json({error:'Veritabanı kaydı bulunamadı'},{status:404})
    await db.update(managedDatabases).set({status:'deleting',lastError:null,updatedAt:new Date()}).where(eq(managedDatabases.id,databaseId))
    await db.insert(agentCommands).values({userId:a.id,nodeId:record.nodeId,serverId:record.serverId,type:'database-delete',payload:{databaseId:record.id,databaseName:record.databaseName,databaseUser:record.databaseUser}})
    await db.insert(operationLogs).values({userId:a.id,serverId:record.serverId,operation:'database-delete',status:'queued'})
    return NextResponse.json({ok:true},{status:202})
  }

  if(['provision-sftp','rotate-sftp-password','test-sftp','disable-sftp','enable-sftp','list-sftp-sessions','terminate-sftp-session'].includes(String(body.action))){
    if(!manager)return NextResponse.json({error:'SFTP yönetimi için Yönetici yetkisi gerekir'},{status:403})
    const serverId=z.string().uuid().parse(body.serverId); const result=await access(a,serverId)
    if(!result)return NextResponse.json({error:'Sunucu bulunamadı'},{status:404})
    const action=String(body.action); const nodeId=result.server.nodeId; const now=new Date(); const existing=(await db.select().from(serverSftp).where(eq(serverSftp.serverId,serverId)).limit(1))[0]
    const call=async(path:string,method:'GET'|'POST'='POST',payload?:Record<string,unknown>)=>nodeJson(nodeId,path,{method,headers:method==='POST'?{'content-type':'application/json'}:undefined,body:method==='POST'?JSON.stringify(payload??{serverId}):undefined})
    try{
      if(action==='provision-sftp'){
        const data=await call('/internal/sftp/provision','POST',{serverId}); const username=String(data.username??`mc_${serverId.replaceAll('-','').slice(0,12)}`); const password=String(data.password??''); const port=Number(data.port??22)
        if(password.length<20)throw new Error('Node tek kullanımlık SFTP parolası döndürmedi')
        const values={nodeId,username,passwordHash:hash(password),port:Number.isInteger(port)?port:22,rootPath:'/files',status:'ready',lastError:null,lastTestAt:now,passwordRotatedAt:now,disabledAt:null,updatedAt:now}
        if(existing)await db.update(serverSftp).set(values).where(eq(serverSftp.serverId,serverId));else await db.insert(serverSftp).values({serverId,...values})
        await db.insert(auditLog).values({userId:a.id,action:'server.sftp.provision',resourceType:'server',resourceId:serverId,details:{username,port:values.port}})
        return NextResponse.json({ok:true,sftp:{username,port:values.port,rootPath:'/files',status:'ready'},credentials:{host:publicHostForNode(nodeId),port:values.port,username,password,rootPath:'/files'},oneTimePassword:true},{status:201,headers:{'Cache-Control':'private, no-store'}})
      }
      if(!existing)return NextResponse.json({error:'Önce bu sunucu için SFTP hesabı oluşturun'},{status:404})
      if(action==='rotate-sftp-password'){
        const data=await call('/internal/sftp/rotate-password','POST',{serverId});const password=String(data.password??'');if(password.length<20)throw new Error('Node tek kullanımlık SFTP parolası döndürmedi');const port=Number(data.port??existing.port??22);await db.update(serverSftp).set({passwordHash:hash(password),port:Number.isInteger(port)?port:22,rootPath:'/files',status:'ready',lastError:null,passwordRotatedAt:now,disabledAt:null,updatedAt:now}).where(eq(serverSftp.serverId,serverId));await db.insert(auditLog).values({userId:a.id,action:'server.sftp.password.rotate',resourceType:'server',resourceId:serverId,details:{username:existing.username}});return NextResponse.json({ok:true,credentials:{host:publicHostForNode(nodeId),port:Number.isInteger(port)?port:22,username:existing.username,password,rootPath:'/files'},oneTimePassword:true},{headers:{'Cache-Control':'private, no-store'}})
      }
      if(action==='test-sftp'){
        const data=await call(`/internal/sftp/status?serverId=${encodeURIComponent(serverId)}`,'GET');const ready=data.ready===true;const port=Number(data.port??existing.port??22);const error=ready?null:'SFTP sunucu tarafı doğrulaması başarısız';await db.update(serverSftp).set({status:sftpStatus(ready),port:Number.isInteger(port)?port:22,rootPath:'/files',lastError:error,lastTestAt:now,updatedAt:now}).where(eq(serverSftp.serverId,serverId));await db.insert(auditLog).values({userId:a.id,action:'server.sftp.test',resourceType:'server',resourceId:serverId,details:{ready,checks:{mounted:data.mounted,sshdValid:data.sshdValid,serviceActive:data.serviceActive,secureChroot:data.secureChroot}}});return NextResponse.json({ok:ready,status:data},{status:ready?200:409,headers:{'Cache-Control':'private, no-store'}})
      }
      if(action==='disable-sftp'){
        await call('/internal/sftp/disable','POST',{serverId});await db.update(serverSftp).set({status:'disabled',lastError:null,disabledAt:now,updatedAt:now}).where(eq(serverSftp.serverId,serverId));await db.insert(auditLog).values({userId:a.id,action:'server.sftp.disable',resourceType:'server',resourceId:serverId,details:{username:existing.username}});return NextResponse.json({ok:true,status:'disabled'})
      }
      if(action==='enable-sftp'){
        const data=await call('/internal/sftp/enable','POST',{serverId});const ready=data.ready===true;await db.update(serverSftp).set({status:sftpStatus(ready),rootPath:'/files',lastError:ready?null:'SFTP etkinleştirildi ancak doğrulama başarısız',lastTestAt:now,disabledAt:null,updatedAt:now}).where(eq(serverSftp.serverId,serverId));await db.insert(auditLog).values({userId:a.id,action:'server.sftp.enable',resourceType:'server',resourceId:serverId,details:{ready}});return NextResponse.json({ok:ready,status:data},{status:ready?200:409})
      }
      if(action==='list-sftp-sessions'){
        const data=await call(`/internal/sftp/sessions?serverId=${encodeURIComponent(serverId)}`,'GET');return NextResponse.json({ok:true,sessions:Array.isArray(data.sessions)?data.sessions:[]},{headers:{'Cache-Control':'private, no-store'}})
      }
      const pid=z.coerce.number().int().positive().parse(body.pid);const data=await call('/internal/sftp/sessions/terminate','POST',{serverId,pid});await db.insert(auditLog).values({userId:a.id,action:'server.sftp.session.terminate',resourceType:'server',resourceId:serverId,details:{pid}});return NextResponse.json({ok:true,result:data})
    }catch(error){const message=nodeDiagnosticMessage(error).slice(0,500);if(existing)await db.update(serverSftp).set({lastError:message,status:action==='test-sftp'?'failed':existing.status,updatedAt:new Date()}).where(eq(serverSftp.serverId,serverId));await db.insert(auditLog).values({userId:a.id,action:`server.sftp.${action}.failed`,resourceType:'server',resourceId:serverId,details:{error:message}});return NextResponse.json({error:message},{status:502,headers:{'Cache-Control':'private, no-store'}})}
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

export async function POST(request:NextRequest){try{return await postPanel(request)}catch(error){if(error instanceof z.ZodError){const issue=error.issues[0];return NextResponse.json({error:issue?.message??'Geçersiz istek',field:issue?.path.join('.')??'',code:'VALIDATION_ERROR'},{status:400})}console.error('[panel-api]',error);return NextResponse.json({error:'İstek işlenemedi'},{status:500})}}
