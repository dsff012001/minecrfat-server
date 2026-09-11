import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db, ensurePanelSchema } from '@/lib/db'
import { agentCommands, auditLog, nodes, serverPermissions, servers, worlds } from '@/lib/db/schema'
import { resolvePanelUser } from '@/lib/db/identity'
import { nodeDiagnosticMessage, nodeFetch } from '@/lib/node-bridge'
import { WORLD_TEMPLATE_MAP, WORLD_TEMPLATES, WORLD_TEMPLATE_CATEGORIES } from '@/lib/world-templates'

async function actor(){const session=await auth.api.getSession({headers:await headers()});if(!session?.user)return null;return resolvePanelUser(session.user)}
async function access(serverId:string,a:NonNullable<Awaited<ReturnType<typeof actor>>>){
  const server=(await db.select().from(servers).where(eq(servers.id,serverId)).limit(1))[0]
  if(!server||server.status==='deleted')return null
  const privileged=a.role==='manager'||a.role==='admin'
  if(privileged||server.userId===a.id)return {server,canView:true,canManage:true,permission:null}
  const permission=(await db.select().from(serverPermissions).where(and(eq(serverPermissions.serverId,serverId),eq(serverPermissions.userId,a.id))).limit(1))[0]
  if(!permission)return null
  const sections=Array.isArray(permission.sections)?permission.sections.map(String):[]
  return {server,canView:sections.includes('worlds'),canManage:!!permission.canReset,permission}
}
async function directJson(nodeId:string,path:string){const response=await nodeFetch(nodeId,path,{cache:'no-store',signal:AbortSignal.timeout(8000)});const text=await response.text();let data:any={};try{data=text?JSON.parse(text):{}}catch{data={error:text.slice(0,500)}}if(!response.ok)throw new Error(String(data.error??`Node HTTP ${response.status}`));return data}
function safeWorldName(value:unknown){const name=String(value??'').trim();return /^[A-Za-z0-9_-]{1,40}$/.test(name)?name:null}
function nodeFresh(node:{status:string;lastHeartbeat:Date|null}|undefined){return !!node&&node.status==='online'&&!!node.lastHeartbeat&&Date.now()-node.lastHeartbeat.getTime()<90_000}

export async function GET(request:NextRequest){
  await ensurePanelSchema();const a=await actor();if(!a)return NextResponse.json({error:'Unauthorized'},{status:401});if(!a.approved)return NextResponse.json({error:'Approval required'},{status:403})
  const serverId=request.nextUrl.searchParams.get('serverId')??'';const x=await access(serverId,a);if(!x||!x.canView)return NextResponse.json({error:'Dünyalar bölümüne erişiminiz yok'},{status:403})
  const node=(await db.select({status:nodes.status,lastHeartbeat:nodes.lastHeartbeat}).from(nodes).where(eq(nodes.id,x.server.nodeId)).limit(1))[0]
  let packageIds:string[]=[];let runtimeWorlds:any[]|undefined;let runtimeSynced=false;let runtimeError:string|null=null
  if(nodeFresh(node)){
    try{const [packages,status]=await Promise.all([directJson(x.server.nodeId,`/internal/worlds/templates?serverId=${encodeURIComponent(serverId)}`),directJson(x.server.nodeId,`/internal/worlds/status?serverId=${encodeURIComponent(serverId)}`)]);packageIds=Array.isArray(packages.packages)?packages.packages.map(String):[];runtimeWorlds=Array.isArray(status.worlds)?status.worlds:[];runtimeSynced=true}catch(error){runtimeError=nodeDiagnosticMessage(error)}
  }else runtimeError='Node çevrimdışı veya heartbeat güncel değil.'
  const packageSet=new Set(packageIds)
  const templates=WORLD_TEMPLATES.map(template=>({
    ...template,
    available:template.mode==='native'||packageSet.has(template.packageKey??template.id),
    availability:template.mode==='native'?'built-in':packageSet.has(template.packageKey??template.id)?'installed-package':nodeFresh(node)?'package-required':'unknown',
  }))
  return NextResponse.json({templates,categories:WORLD_TEMPLATE_CATEGORIES,runtimeWorlds,nodeOnline:nodeFresh(node),runtimeSynced,runtimeError,canManage:x.canManage},{headers:{'Cache-Control':'private, no-store'}})
}

export async function POST(request:NextRequest){
  await ensurePanelSchema();const a=await actor();if(!a)return NextResponse.json({error:'Unauthorized'},{status:401});if(!a.approved)return NextResponse.json({error:'Approval required'},{status:403})
  const body=await request.json().catch(()=>({}));const serverId=String(body.serverId??'');const x=await access(serverId,a);if(!x||!x.canManage)return NextResponse.json({error:'Dünya yönetme yetkiniz yok'},{status:403})
  const action=String(body.action??'');const worldName=safeWorldName(body.worldName)
  if(['create','set-active','live-settings','reset','delete'].includes(action)&&!worldName)return NextResponse.json({error:'Geçersiz dünya adı'},{status:400})
  const node=(await db.select({status:nodes.status,lastHeartbeat:nodes.lastHeartbeat}).from(nodes).where(eq(nodes.id,x.server.nodeId)).limit(1))[0]
  if(!nodeFresh(node))return NextResponse.json({error:'Node çevrimdışı veya agent heartbeat güncel değil. Dünya işlemi uygulanmadan kuyruğa alınmaz.'},{status:409})
  let type='';let payload:Record<string,unknown>={};let message='İşlem agent kuyruğuna alındı.'
  if(action==='create'){
    if(!['ready','stopped','failed','crashed'].includes(x.server.status))return NextResponse.json({error:'Yeni dünya oluşturmak için sunucuyu tamamen durdurun.'},{status:409})
    const templateId=String(body.templateId??'');const template=WORLD_TEMPLATE_MAP.get(templateId);if(!template)return NextResponse.json({error:'Bilinmeyen dünya şablonu'},{status:400})
    if(template.mode==='package'){
      try{const availability=await directJson(x.server.nodeId,`/internal/worlds/templates?serverId=${encodeURIComponent(serverId)}`);const installed=new Set(Array.isArray(availability.packages)?availability.packages.map(String):[]);if(!installed.has(template.packageKey??template.id))return NextResponse.json({error:`${template.name} için onaylı dünya paketi node üzerinde kurulu değil. Paket kurulmadan dünya çalışıyor gibi gösterilmez.`},{status:409})}catch(error){return NextResponse.json({error:`Dünya şablon paketi doğrulanamadı: ${nodeDiagnosticMessage(error)}`},{status:503})}
    }
    type='create-world-profile';payload={worldName,seed:String(body.seed??'').slice(0,100),templateId:template.id,templateName:template.name,mode:template.mode,profile:template.profile??null,packageKey:template.packageKey??null,activateAfterCreate:body.activateAfterCreate!==false};message=template.mode==='native'?'Dünya profili hazırlandı; agent oluşturacak ve ilk başlatmada Minecraft dünya dosyalarını üretecek.':'Onaylı dünya şablonu agent kuyruğuna alındı.'
  }else if(action==='set-active'){
    if(x.server.status==='running')return NextResponse.json({error:'Aktif dünyayı değiştirmek için sunucuyu durdurun.'},{status:409});type='CHANGE_WORLD';payload={worldName};message='Aktif dünya değişikliği kuyruğa alındı.'
  }else if(action==='live-settings'){
    if(x.server.status!=='running'||x.server.worldName!==worldName)return NextResponse.json({error:'Canlı dünya ayarları yalnız çalışan aktif dünyaya uygulanabilir.'},{status:409})
    const gamerules=body.gamerules&&typeof body.gamerules==='object'&&!Array.isArray(body.gamerules)?body.gamerules:{}
    type='world-live-settings';payload={worldName,difficulty:body.difficulty,borderSize:body.borderSize,spawn:body.spawn,time:body.time,weather:body.weather,gamerules};message='Canlı dünya ayarları güvenli komut kuyruğuna alındı.'
  }else if(action==='reset'){
    if(x.server.status==='running')return NextResponse.json({error:'Dünya sıfırlamak için sunucuyu durdurun.'},{status:409});if(String(body.confirmName??'')!==worldName)return NextResponse.json({error:'Dünya adı onayı eşleşmiyor.'},{status:400});type='RESET_WORLD';payload={worldName,confirm:true,backupFirst:true};message='Önce güvenlik yedeği alınarak dünya sıfırlama kuyruğa alındı.'
  }else if(action==='delete'){
    if(x.server.status==='running')return NextResponse.json({error:'Dünya silmek için sunucuyu durdurun.'},{status:409});if(x.server.worldName===worldName)return NextResponse.json({error:'Aktif dünya silinemez. Önce başka bir dünyayı aktif yapın.'},{status:409});if(String(body.confirmName??'')!==worldName)return NextResponse.json({error:'Dünya adı onayı eşleşmiyor.'},{status:400});type='DELETE_WORLD';payload={worldName};message='Dünya silme işlemi kuyruğa alındı.'
  }else return NextResponse.json({error:'Desteklenmeyen dünya işlemi'},{status:400})
  const [command]=await db.insert(agentCommands).values({userId:x.server.userId,nodeId:x.server.nodeId,serverId,type,payload,status:'queued'}).returning({id:agentCommands.id})
  await db.insert(auditLog).values({userId:a.id,action:`world.${action}`,resourceType:'world',resourceId:`${serverId}:${worldName}`,details:{commandId:command.id,type,templateId:payload.templateId??null}})
  return NextResponse.json({ok:true,commandId:command.id,message},{status:202})
}
