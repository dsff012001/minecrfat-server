'use client'

import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import {
  AlertTriangle, Bot, CheckCircle2, Clock3, Copy, FileText, Globe2, KeyRound, MessageCircle,
  Power, Radio, RefreshCw, Save, Settings2, ShieldCheck, Users, Wifi, XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type IntegrationKey = 'discord' | 'discord-bot' | 'web-api' | 'live-stream'
type IntegrationState = {
  kind?: IntegrationKey
  enabled?: boolean
  status?: string
  statusLabel?: string
  config?: Record<string, unknown>
  hasSecret?: boolean
  lastTestAt?: string | null
  lastError?: string | null
  updatedAt?: string | null
} | null

type IntegrationLog = {
  id: number
  integration: string
  level: string
  event: string
  details?: Record<string, unknown>
  createdAt: string
}

type ResponseData = {
  integrations: Record<IntegrationKey, IntegrationState>
  logs: IntegrationLog[]
  encryptionReady: boolean
  capabilities: {
    discordWebhook: boolean
    discordBotWorker: boolean
    webApi: boolean
    websocket: boolean
    liveStreamGateway: boolean
    streamAccounts?: { youtube?: boolean; twitch?: boolean; kick?: boolean }
  }
  canManage: boolean
}

type Props = { serverId: string; serverName: string; canManage: boolean }

const EVENT_OPTIONS = [
  ['player_join','Oyuncu sunucuya girdiğinde'],
  ['player_leave','Oyuncu sunucudan çıktığında'],
  ['server_start','Sunucu açıldığında'],
  ['server_stop','Sunucu kapandığında'],
  ['server_restart','Sunucu yeniden başlatıldığında'],
  ['server_crash','Sunucu çöktüğünde'],
  ['player_death','Oyuncu öldüğünde'],
  ['player_advancement','Oyuncu başarı kazandığında'],
  ['player_ban','Ban atıldığında'],
  ['player_unban','Ban kaldırıldığında'],
  ['whitelist_add','Whitelist’e oyuncu eklendiğinde'],
  ['whitelist_remove','Whitelist’ten oyuncu çıkarıldığında'],
] as const

const BOT_COMMANDS = ['/status','/players','/player oyuncuadı','/start','/stop','/restart','/say mesaj','/kick oyuncu','/ban oyuncu','/unban oyuncu','/whitelist add oyuncu','/whitelist remove oyuncu']

const fetcher = async (url: string) => {
  const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
  const text = await response.text()
  let data: any = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { error: text } }
  if (!response.ok) throw new Error(data.error ?? `İstek başarısız (${response.status})`)
  return data
}

function statusTone(state: IntegrationState, blocked = false) {
  if (blocked) return 'border-amber-500/30 bg-amber-500/10 text-amber-300'
  if (state?.enabled) return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
  if (state?.status === 'tested' || state?.status === 'configured') return 'border-blue-500/30 bg-blue-500/10 text-blue-300'
  return 'border-slate-700 bg-slate-800/60 text-slate-400'
}

function IntegrationCard({ icon:Icon, title, description, state, blocked, onConfigure, onTest, onToggle, onLogs, busy, testDisabled, toggleDisabled }:{
  icon:React.ComponentType<{className?:string}>; title:string; description:string; state:IntegrationState; blocked?:boolean;
  onConfigure:()=>void; onTest:()=>void; onToggle:()=>void; onLogs:()=>void; busy:boolean; testDisabled?:boolean; toggleDisabled?:boolean
}) {
  return <section className="rounded-xl border border-emerald-950/70 bg-[linear-gradient(145deg,rgba(15,33,26,.94),rgba(8,23,18,.94))] p-4 shadow-[inset_0_1px_rgba(255,255,255,.015)]">
    <div className="flex items-start gap-3">
      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-300"><Icon className="size-5"/></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold text-white">{title}</h4><span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${statusTone(state,blocked)}`}>{blocked?state?.statusLabel??'Hazırlık gerekli':state?.statusLabel??'Yapılandırılmadı'}</span></div>
        <p className="mt-1 text-[11px] leading-5 text-slate-500">{description}</p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-500"><span>Son test</span><span className="text-right text-slate-300">{state?.lastTestAt?new Date(state.lastTestAt).toLocaleString('tr-TR'):'—'}</span><span>Durum</span><span className="text-right text-slate-300">{state?.enabled?'Açık':'Kapalı'}</span></div>
      </div>
    </div>
    {state?.lastError&&<div className="mt-3 rounded-lg border border-red-500/25 bg-red-950/20 px-3 py-2 text-[10px] text-red-300">{state.lastError}</div>}
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Button size="sm" variant="outline" onClick={onConfigure}><Settings2 className="mr-1.5 size-3.5"/>Yapılandır</Button>
      <Button size="sm" variant="outline" disabled={busy||testDisabled} onClick={onTest}><Wifi className="mr-1.5 size-3.5"/>Test Et</Button>
      <Button size="sm" variant="outline" disabled={busy||toggleDisabled} onClick={onToggle}><Power className="mr-1.5 size-3.5"/>{state?.enabled?'Kapat':'Aç'}</Button>
      <Button size="sm" variant="outline" onClick={onLogs}><FileText className="mr-1.5 size-3.5"/>Kayıtları Gör</Button>
    </div>
  </section>
}

function Toggle({ label, checked, onChange, disabled=false, sub }:{label:string;checked:boolean;onChange:(value:boolean)=>void;disabled?:boolean;sub?:string}) {
  return <div className="flex items-center gap-3 border-b border-emerald-950/45 py-2.5 last:border-0"><div className="min-w-0 flex-1"><p className="text-xs font-medium text-slate-200">{label}</p>{sub&&<p className="mt-0.5 text-[10px] text-slate-500">{sub}</p>}</div><button type="button" disabled={disabled} role="switch" aria-checked={checked} onClick={()=>onChange(!checked)} className={`relative h-5 w-9 rounded-full transition disabled:opacity-40 ${checked?'bg-emerald-500':'bg-slate-700'}`}><span className={`absolute top-0.5 size-4 rounded-full bg-white transition ${checked?'left-[18px]':'left-0.5'}`}/></button></div>
}

function Field({ label, value, onChange, placeholder, type='text', disabled=false }:{label:string;value:string;onChange:(value:string)=>void;placeholder?:string;type?:string;disabled?:boolean}) {
  return <div className="space-y-1.5"><Label className="text-[11px] text-slate-300">{label}</Label><Input type={type} value={value} disabled={disabled} placeholder={placeholder} onChange={e=>onChange(e.target.value)} className="h-9 border-emerald-950/80 bg-[#091712] text-xs focus-visible:ring-emerald-500/40"/></div>
}

export function ServerIntegrationsCenter({serverId,serverName,canManage}:Props){
  const {data,error,mutate}=useSWR<ResponseData>(`/api/integrations?serverId=${encodeURIComponent(serverId)}`,fetcher,{refreshInterval:10000})
  const [selected,setSelected]=useState<IntegrationKey>('discord')
  const [showLogs,setShowLogs]=useState(false)
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const [hydrated,setHydrated]=useState(false)
  const [apiKeyOnce,setApiKeyOnce]=useState('')

  const [discordWebhook,setDiscordWebhook]=useState('')
  const [discordEvents,setDiscordEvents]=useState<Record<string,boolean>>({})
  const [botToken,setBotToken]=useState('')
  const [guildId,setGuildId]=useState('')
  const [commandChannelId,setCommandChannelId]=useState('')
  const [logChannelId,setLogChannelId]=useState('')
  const [adminRoleId,setAdminRoleId]=useState('')
  const [allowedOrigins,setAllowedOrigins]=useState('')
  const [sourceMode,setSourceMode]=useState('direct')
  const [streamPlatform,setStreamPlatform]=useState('youtube')
  const [streamUrl,setStreamUrl]=useState('')
  const [streamPreview,setStreamPreview]=useState<Record<string,unknown>|null>(null)
  const [pageHost,setPageHost]=useState('')
  const [selectionMode,setSelectionMode]=useState('random')
  const [rotateSeconds,setRotateSeconds]=useState('600')
  const [switchOnLeave,setSwitchOnLeave]=useState(true)
  const [switchOnShareStop,setSwitchOnShareStop]=useState(true)
  const [switchOnDisconnect,setSwitchOnDisconnect]=useState(true)
  const [switchOnAfk,setSwitchOnAfk]=useState(false)
  const [avoidImmediateRepeat,setAvoidImmediateRepeat]=useState(true)
  const [emptyFallbackEnabled,setEmptyFallbackEnabled]=useState(false)
  const [emptyFallbackMode,setEmptyFallbackMode]=useState('link')
  const [emptyFallbackPlatform,setEmptyFallbackPlatform]=useState('youtube')
  const [emptyFallbackUrl,setEmptyFallbackUrl]=useState('')
  const [emptyFallbackServerId,setEmptyFallbackServerId]=useState('')
  const [emptyFallbackCameraKey,setEmptyFallbackCameraKey]=useState('')
  const [emptyFallbackDelaySeconds,setEmptyFallbackDelaySeconds]=useState('60')
  const [emptyFallbackLockSeconds,setEmptyFallbackLockSeconds]=useState('300')
  const [returnToPlayersDelaySeconds,setReturnToPlayersDelaySeconds]=useState('30')

  useEffect(()=>{setHydrated(false);setApiKeyOnce('');setStreamPreview(null);setNotice('')},[serverId])
  useEffect(()=>{if(typeof window!=='undefined')setPageHost(window.location.hostname)},[])
  useEffect(()=>{
    if(!data||hydrated)return
    const discordConfig=data.integrations.discord?.config??{}
    const events=discordConfig.events&&typeof discordConfig.events==='object'?discordConfig.events as Record<string,unknown>:{}
    setDiscordEvents(Object.fromEntries(EVENT_OPTIONS.map(([key])=>[key,events[key]===true])))
    const botConfig=data.integrations['discord-bot']?.config??{}
    setGuildId(String(botConfig.guildId??''));setCommandChannelId(String(botConfig.commandChannelId??''));setLogChannelId(String(botConfig.logChannelId??''));setAdminRoleId(String(botConfig.adminRoleId??''))
    const webConfig=data.integrations['web-api']?.config??{}
    setAllowedOrigins(Array.isArray(webConfig.allowedOrigins)?webConfig.allowedOrigins.map(String).join(', '):'')
    const liveConfig=data.integrations['live-stream']?.config??{}
    setSourceMode(String(liveConfig.sourceMode??'direct'));setStreamPlatform(String(liveConfig.platform??'youtube')||'youtube');setStreamUrl(String(liveConfig.streamUrl??''))
    setSelectionMode(String(liveConfig.selectionMode??'random'));setRotateSeconds(String(liveConfig.rotateSeconds??600));setSwitchOnLeave(liveConfig.switchOnLeave!==false);setSwitchOnShareStop(liveConfig.switchOnShareStop!==false);setSwitchOnDisconnect(liveConfig.switchOnDisconnect!==false);setSwitchOnAfk(liveConfig.switchOnAfk===true);setAvoidImmediateRepeat(liveConfig.avoidImmediateRepeat!==false)
    setEmptyFallbackEnabled(liveConfig.emptyFallbackEnabled===true);setEmptyFallbackMode(String(liveConfig.emptyFallbackMode??'link'));setEmptyFallbackPlatform(String(liveConfig.emptyFallbackPlatform??'youtube')||'youtube');setEmptyFallbackUrl(String(liveConfig.emptyFallbackUrl??''));setEmptyFallbackServerId(String(liveConfig.emptyFallbackServerId??''));setEmptyFallbackCameraKey(String(liveConfig.emptyFallbackCameraKey??''));setEmptyFallbackDelaySeconds(String(liveConfig.emptyFallbackDelaySeconds??60));setEmptyFallbackLockSeconds(String(liveConfig.emptyFallbackLockSeconds??300));setReturnToPlayersDelaySeconds(String(liveConfig.returnToPlayersDelaySeconds??30))
    setHydrated(true)
  },[data,hydrated])

  const manageable=canManage&&data?.canManage!==false
  const integrations=data?.integrations
  const capabilities=data?.capabilities

  async function action(action:string,payload:Record<string,unknown>={}){
    setBusy(true);setNotice('')
    try{
      const response=await fetch('/api/integrations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({serverId,action,...payload})})
      const text=await response.text();let body:any={};try{body=text?JSON.parse(text):{}}catch{body={error:text}}
      if(!response.ok)throw new Error(body.error??`İşlem başarısız (${response.status})`)
      if(body.apiKey)setApiKeyOnce(String(body.apiKey))
      setNotice(body.message??'İşlem başarıyla tamamlandı.')
      await mutate()
      return body
    }catch(e){setNotice(e instanceof Error?e.message:'İşlem başarısız');return null}finally{setBusy(false)}
  }

  async function resolveStreamPreview(){
    const body=await action('resolve-live-stream')
    if(body?.ok)setStreamPreview(body as Record<string,unknown>)
  }
  function connectStreamAccount(platform:'youtube'|'twitch'|'kick'){
    if(typeof window==='undefined')return
    window.location.href=`/api/integrations/oauth/start?serverId=${encodeURIComponent(serverId)}&platform=${platform}`
  }
  const previewSrc=useMemo(()=>{
    if(!streamPreview)return ''
    const provider=String(streamPreview.provider??'')
    if(provider==='youtube'&&streamPreview.videoId)return `https://www.youtube.com/embed/${encodeURIComponent(String(streamPreview.videoId))}?autoplay=1`
    if(provider==='twitch'&&streamPreview.channelSlug&&pageHost)return `https://player.twitch.tv/?channel=${encodeURIComponent(String(streamPreview.channelSlug))}&parent=${encodeURIComponent(pageHost)}&autoplay=false`
    if(provider==='kick'&&streamPreview.channelSlug)return `https://player.kick.com/${encodeURIComponent(String(streamPreview.channelSlug))}?autoplay=false`
    return ''
  },[streamPreview,pageHost])

  const liveConfig=integrations?.['live-stream']?.config??{}
  const liveMode=String(liveConfig.sourceMode??'direct')
  const livePlatform=String(liveConfig.platform??'youtube')
  const liveAccount=liveConfig[`${livePlatform}Account`] as Record<string,unknown>|undefined
  const liveReady=liveMode==='direct'?!!capabilities?.liveStreamGateway:liveMode==='link'?!!liveConfig.streamUrl:liveAccount?.connected===true
  const cards=useMemo(()=>[
    {key:'discord' as const,icon:MessageCircle,title:'Discord',description:'Minecraft olaylarını seçtiğiniz Discord kanalına webhook üzerinden gönderir.',blocked:false,testDisabled:!integrations?.discord?.hasSecret,toggleDisabled:!manageable||(!integrations?.discord?.enabled&&!integrations?.discord?.hasSecret)},
    {key:'discord-bot' as const,icon:Bot,title:'Discord Bot',description:'Bot kimlik bilgilerini doğrular; komut çalıştırmak için kalıcı bot worker gerekir.',blocked:!capabilities?.discordBotWorker,testDisabled:!integrations?.['discord-bot']?.hasSecret,toggleDisabled:!manageable||(!integrations?.['discord-bot']?.enabled&&!capabilities?.discordBotWorker)},
    {key:'web-api' as const,icon:Globe2,title:'Web API',description:'Harici web sitelerine API anahtarıyla gerçek sunucu durumu ve node metrikleri sağlar.',blocked:false,testDisabled:!integrations?.['web-api']?.config?.apiKeyPrefix,toggleDisabled:!manageable||(!integrations?.['web-api']?.enabled&&!integrations?.['web-api']?.config?.apiKeyPrefix)},
    {key:'live-stream' as const,icon:Radio,title:'Canlı Yayın',description:'Görüntüyü kaydetmeden WebRTC ile anlık iletir veya YouTube, Twitch ve Kick yayınını link/hesap üzerinden gösterir.',blocked:!liveReady,testDisabled:!liveReady,toggleDisabled:!manageable||(!integrations?.['live-stream']?.enabled&&!liveReady)},
  ],[integrations,capabilities,manageable,liveReady])

  if(error)return <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-4 text-sm text-red-300">Entegrasyonlar yüklenemedi: {error.message}</div>

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-[22px] font-bold tracking-tight text-white">Entegrasyonlar</h3><p className="mt-0.5 text-[12px] text-slate-400">{serverName} sunucusunu Discord, bot, web sitesi ve canlı oyuncu yayın altyapısıyla bağlayın.</p></div><Button size="sm" variant="outline" onClick={()=>mutate()}><RefreshCw className="mr-2 size-4"/>Yenile</Button></div>

    {!data?.encryptionReady&&<div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-200"><AlertTriangle className="mr-2 inline size-4"/><b>Gizli anahtar gerekli:</b> Discord webhook ve bot token kaydetmek için Vercel ortamına <code>INTEGRATION_ENCRYPTION_KEY</code> eklenmelidir. Tokenlar düz metin saklanmaz.</div>}
    {notice&&<div className="rounded-xl border border-blue-500/25 bg-blue-950/20 px-4 py-3 text-xs text-blue-200">{notice}</div>}

    <div className="grid gap-3 xl:grid-cols-2">{cards.map(card=><IntegrationCard key={card.key} icon={card.icon} title={card.title} description={card.description} state={integrations?.[card.key]??null} blocked={card.blocked} busy={busy} testDisabled={card.testDisabled} toggleDisabled={card.toggleDisabled} onConfigure={()=>{setSelected(card.key);setShowLogs(false)}} onLogs={()=>{setSelected(card.key);setShowLogs(true)}} onTest={()=>action(`test-${card.key}`)} onToggle={()=>action(`toggle-${card.key}`,{enabled:!integrations?.[card.key]?.enabled})}/>)}</div>

    {showLogs?<section className="rounded-xl border border-emerald-950/70 bg-[linear-gradient(145deg,rgba(15,33,26,.94),rgba(8,23,18,.94))] p-4"><div className="mb-3 flex items-center justify-between"><div><h4 className="text-sm font-semibold text-white">Entegrasyon kayıtları</h4><p className="mt-0.5 text-[11px] text-slate-500">Bağlantı testleri, aç/kapat işlemleri ve gönderilen olaylar.</p></div><Button size="sm" variant="outline" onClick={()=>mutate()}><RefreshCw className="mr-1.5 size-3.5"/>Yenile</Button></div><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[11px]"><thead className="border-y border-emerald-950/60 text-left text-slate-500"><tr><th className="p-2.5">Tarih</th><th className="p-2.5">Entegrasyon</th><th className="p-2.5">Olay</th><th className="p-2.5">Durum</th><th className="p-2.5">Ayrıntı</th></tr></thead><tbody>{data?.logs?.length?data.logs.map(row=><tr key={row.id} className="border-b border-emerald-950/45"><td className="p-2.5 text-slate-500">{new Date(row.createdAt).toLocaleString('tr-TR')}</td><td className="p-2.5 font-medium text-slate-200">{row.integration}</td><td className="p-2.5 text-slate-300">{row.event}</td><td className={`p-2.5 ${row.level==='error'?'text-red-300':'text-emerald-300'}`}>{row.level}</td><td className="max-w-[320px] truncate p-2.5 text-slate-500">{row.details&&Object.keys(row.details).length?JSON.stringify(row.details):'—'}</td></tr>):<tr><td colSpan={5} className="p-8 text-center text-slate-500">Henüz entegrasyon kaydı yok.</td></tr>}</tbody></table></div></section>:

    <section className="rounded-xl border border-emerald-950/70 bg-[linear-gradient(145deg,rgba(15,33,26,.94),rgba(8,23,18,.94))] p-4">
      {selected==='discord'&&<>
        <div className="mb-4"><h4 className="flex items-center gap-2 text-sm font-semibold text-white"><MessageCircle className="size-4 text-emerald-300"/>Discord webhook ayarları</h4><p className="mt-1 text-[11px] text-slate-500">Webhook URL sunucuda AES-256-GCM ile şifrelenerek saklanır ve tekrar panelde gösterilmez.</p></div>
        <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]"><div className="space-y-4"><Field label="Discord Webhook URL" value={discordWebhook} onChange={setDiscordWebhook} type="password" disabled={!manageable} placeholder={integrations?.discord?.hasSecret?'Kaydedilmiş webhook var — değiştirmek için yeni URL girin':'https://discord.com/api/webhooks/...'} /><div className="rounded-lg border border-emerald-950/60 bg-black/10 p-3 text-[10px] text-slate-500"><ShieldCheck className="mr-1.5 inline size-3.5 text-emerald-300"/>Webhook URL API yanıtlarında ve audit loglarında gösterilmez.</div></div><div className="rounded-lg border border-emerald-950/60 bg-black/10 px-3">{EVENT_OPTIONS.map(([key,label])=><Toggle key={key} label={label} checked={!!discordEvents[key]} disabled={!manageable} onChange={value=>setDiscordEvents(prev=>({...prev,[key]:value}))}/>)}</div></div>
        <div className="mt-4 flex flex-wrap gap-2"><Button className="bg-emerald-600 text-emerald-950" disabled={!manageable||busy} onClick={()=>action('save-discord',{webhookUrl:discordWebhook,events:discordEvents}).then(r=>{if(r)setDiscordWebhook('')})}><Save className="mr-2 size-4"/>Kaydet</Button><Button variant="outline" disabled={busy||!integrations?.discord?.hasSecret} onClick={()=>action('test-discord')}><Wifi className="mr-2 size-4"/>Test mesajı gönder</Button></div>
      </>}

      {selected==='discord-bot'&&<>
        <div className="mb-4"><h4 className="flex items-center gap-2 text-sm font-semibold text-white"><Bot className="size-4 text-emerald-300"/>Discord Bot ayarları</h4><p className="mt-1 text-[11px] text-slate-500">Token doğrulaması gerçek Discord API üzerinden yapılır. Slash komutlarını sürekli dinlemek için ayrı bot worker servisi gerekir.</p></div>
        {!capabilities?.discordBotWorker&&<div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-950/20 p-3 text-[11px] text-amber-200"><AlertTriangle className="mr-2 inline size-4"/>Bot worker yapılandırılmadığı için bu kart “çalışıyor” gösterilmez. Token ve sunucu erişimi yine test edilebilir.</div>}
        <div className="grid gap-4 md:grid-cols-2"><Field label="Bot Token" value={botToken} onChange={setBotToken} type="password" disabled={!manageable} placeholder={integrations?.['discord-bot']?.hasSecret?'Kaydedilmiş token var — değiştirmek için yeni token girin':'Discord bot token'}/><Field label="Discord Sunucu ID" value={guildId} onChange={setGuildId} disabled={!manageable}/><Field label="Komut Kanalı ID" value={commandChannelId} onChange={setCommandChannelId} disabled={!manageable}/><Field label="Log Kanalı ID" value={logChannelId} onChange={setLogChannelId} disabled={!manageable}/><Field label="Yetkili Rol ID" value={adminRoleId} onChange={setAdminRoleId} disabled={!manageable}/></div>
        <div className="mt-4 rounded-lg border border-emerald-950/60 bg-black/10 p-3"><p className="mb-2 text-[11px] font-semibold text-slate-300">Planlanan Discord komutları</p><div className="flex flex-wrap gap-2">{BOT_COMMANDS.map(cmd=><code key={cmd} className="rounded-md border border-emerald-950/60 bg-[#091712] px-2 py-1 text-[10px] text-emerald-300">{cmd}</code>)}</div><p className="mt-2 text-[10px] text-slate-500">Start/stop/restart/ban gibi komutlar Yetkili Rol ID kontrolünden sonra çalıştırılmalıdır; bot worker kurulmadan bu komutlar aktif değildir.</p></div>
        <div className="mt-4 flex flex-wrap gap-2"><Button className="bg-emerald-600 text-emerald-950" disabled={!manageable||busy} onClick={()=>action('save-discord-bot',{botToken,guildId,commandChannelId,logChannelId,adminRoleId}).then(r=>{if(r)setBotToken('')})}><Save className="mr-2 size-4"/>Kaydet</Button><Button variant="outline" disabled={busy||!integrations?.['discord-bot']?.hasSecret} onClick={()=>action('test-discord-bot')}><Wifi className="mr-2 size-4"/>Bot kimliğini test et</Button></div>
      </>}

      {selected==='web-api'&&<>
        <div className="mb-4"><h4 className="flex items-center gap-2 text-sm font-semibold text-white"><Globe2 className="size-4 text-emerald-300"/>Web sitesi / API entegrasyonu</h4><p className="mt-1 text-[11px] text-slate-500">Harici siteler yalnız oluşturulan API anahtarıyla bu sunucunun izin verilen canlı verilerini okuyabilir.</p></div>
        <div className="grid gap-4 lg:grid-cols-[1fr_.9fr]"><div><Field label="İzin verilen domainler" value={allowedOrigins} onChange={setAllowedOrigins} disabled={!manageable} placeholder="https://example.com, https://panel.example.com"/><p className="mt-2 text-[10px] text-slate-500">Boş bırakılırsa sunucudan sunucuya çağrılar yapılabilir; tarayıcı Origin kısıtlaması yalnız liste doluysa uygulanır.</p><div className="mt-4 flex flex-wrap gap-2"><Button className="bg-emerald-600 text-emerald-950" disabled={!manageable||busy} onClick={()=>action('save-web-api',{allowedOrigins:allowedOrigins.split(',').map(x=>x.trim()).filter(Boolean)})}><Save className="mr-2 size-4"/>Domainleri kaydet</Button><Button variant="outline" disabled={!manageable||busy} onClick={()=>action('rotate-web-api-key')}><KeyRound className="mr-2 size-4"/>{integrations?.['web-api']?.config?.apiKeyPrefix?'Anahtarı yenile':'API anahtarı oluştur'}</Button>{integrations?.['web-api']?.config?.apiKeyPrefix&&<Button variant="destructive" disabled={!manageable||busy} onClick={()=>action('revoke-web-api-key')}>Anahtarı iptal et</Button>}</div></div><div className="rounded-lg border border-emerald-950/60 bg-black/10 p-3 text-[11px]"><p className="font-semibold text-slate-300">REST endpoint</p><code className="mt-2 block break-all rounded bg-[#07130f] p-2 text-[10px] text-emerald-300">/api/integrations/public?serverId={serverId}</code><p className="mt-3 text-slate-500">Header:</p><code className="mt-1 block rounded bg-[#07130f] p-2 text-[10px] text-slate-300">Authorization: Bearer &lt;API_KEY&gt;</code><div className="mt-3 grid grid-cols-2 gap-2"><span className="text-slate-500">Sunucu durumu</span><span className="text-right text-emerald-300">Destekleniyor</span><span className="text-slate-500">CPU / RAM / Disk</span><span className="text-right text-emerald-300">Destekleniyor</span><span className="text-slate-500">WebSocket</span><span className="text-right text-amber-300">Henüz yok</span><span className="text-slate-500">TPS / gerçek ping</span><span className="text-right text-amber-300">Telemetri gerekli</span></div></div></div>
        {apiKeyOnce&&<div className="mt-4 rounded-xl border border-amber-500/35 bg-amber-950/20 p-3"><div className="flex items-start gap-3"><KeyRound className="mt-0.5 size-4 text-amber-300"/><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-amber-200">Yeni API anahtarı — yalnız bir kez gösterilir</p><code className="mt-2 block break-all rounded bg-black/20 p-2 text-[10px] text-amber-100">{apiKeyOnce}</code></div><Button size="sm" variant="outline" onClick={()=>navigator.clipboard.writeText(apiKeyOnce)}><Copy className="mr-1.5 size-3.5"/>Kopyala</Button></div></div>}
      </>}

      {selected==='live-stream'&&<>
        <div className="mb-4"><h4 className="flex items-center gap-2 text-sm font-semibold text-white"><Radio className="size-4 text-emerald-300"/>Canlı yayın kaynağı</h4><p className="mt-1 text-[11px] text-slate-500">BLOCKCTRL görüntü karesi, ekran görüntüsü veya video dosyası kaydetmez. Oyuncu görüntüsü doğrudan WebRTC veri akışı olarak iletilir; alternatif olarak YouTube, Twitch veya Kick yayını gösterilir.</p></div>
        <div className="mb-4 rounded-lg border border-emerald-500/25 bg-emerald-950/20 p-3 text-[11px] text-emerald-200"><ShieldCheck className="mr-2 inline size-4"/><b>Kayıt kapalı:</b> recording=false, storageMode=none. Akış yalnız anlık iletim içindir; panel sunucusunda yayın görüntüsü tutulmaz.</div>
        <div className="grid gap-4 lg:grid-cols-2"><div className="space-y-4"><div className="space-y-1.5"><Label className="text-[11px] text-slate-300">Yayın kaynağı</Label><select value={sourceMode} disabled={!manageable} onChange={e=>{setSourceMode(e.target.value);setStreamPreview(null)}} className="h-9 w-full rounded-md border border-emerald-950/80 bg-[#091712] px-3 text-xs text-slate-200"><option value="direct">Oyuncudan doğrudan WebRTC</option><option value="link">YouTube / Twitch / Kick linki</option><option value="account">Platform hesabı bağla</option></select></div>
        {sourceMode==='link'&&<><div className="space-y-1.5"><Label className="text-[11px] text-slate-300">Platform</Label><select value={streamPlatform} disabled={!manageable} onChange={e=>setStreamPlatform(e.target.value)} className="h-9 w-full rounded-md border border-emerald-950/80 bg-[#091712] px-3 text-xs text-slate-200"><option value="youtube">YouTube</option><option value="twitch">Twitch</option><option value="kick">Kick</option></select></div><Field label="Canlı yayın / kanal linki" value={streamUrl} onChange={setStreamUrl} disabled={!manageable} placeholder={streamPlatform==='youtube'?'https://youtube.com/watch?v=...':streamPlatform==='twitch'?'https://twitch.tv/kanal':'https://kick.com/kanal'}/><p className="text-[10px] text-slate-500">Link sunucuda yalnız oynatılacak kaynağı belirtir; BLOCKCTRL videoyu indirmez veya kopyalamaz.</p></>}
        {sourceMode==='account'&&<div className="space-y-3">{(['youtube','twitch','kick'] as const).map(platform=>{const account=liveConfig[`${platform}Account`] as Record<string,unknown>|undefined;const connected=account?.connected===true;const ready=capabilities?.streamAccounts?.[platform]===true;return <div key={platform} className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-950/60 bg-black/10 p-3"><div className="min-w-0 flex-1"><p className="text-xs font-semibold capitalize text-slate-200">{platform}</p><p className="mt-0.5 truncate text-[10px] text-slate-500">{connected?`Bağlı: ${String(account?.title??account?.login??account?.username??'hesap')}`:ready?'OAuth hazır · hesap bağlanabilir':'OAuth uygulama bilgileri eksik'}</p></div>{connected?<><Button size="sm" variant="outline" onClick={()=>{setStreamPlatform(platform);setSourceMode('account')}}>Kullan</Button><Button size="sm" variant="destructive" disabled={!manageable||busy} onClick={()=>action('disconnect-stream-account',{platform})}>Bağlantıyı kes</Button></>:<Button size="sm" variant="outline" disabled={!manageable||busy||!ready||!data?.encryptionReady} onClick={()=>connectStreamAccount(platform)}>Hesabı bağla</Button>}</div>})}</div>}
        {sourceMode==='direct'&&<div className="rounded-lg border border-emerald-950/60 bg-black/10 p-3 text-[10px] leading-5 text-slate-500"><Radio className="mr-1.5 inline size-3.5 text-emerald-300"/>Client mod Minecraft penceresini gerçek zamanlı video akışına kodlar ve WebRTC/SFU üzerinden iletir. Kareler disk dosyasına, ekran görüntüsü klasörüne veya arşive yazılmaz.</div>}
        </div><div className="space-y-4">{sourceMode==='direct'&&<><div className="space-y-1.5"><Label className="text-[11px] text-slate-300">Oyuncu seçim türü</Label><select value={selectionMode} disabled={!manageable} onChange={e=>setSelectionMode(e.target.value)} className="h-9 w-full rounded-md border border-emerald-950/80 bg-[#091712] px-3 text-xs text-slate-200"><option value="random">Rastgele</option><option value="round-robin">Sırayla</option><option value="longest-online">En uzun süredir çevrimiçi</option><option value="newest">En yeni giren</option><option value="manual">Manuel</option></select></div><Field label="Yayıncı değiştirme süresi (saniye, 0 = sınırsız)" value={rotateSeconds} onChange={setRotateSeconds} disabled={!manageable}/><div className="rounded-lg border border-emerald-950/60 bg-black/10 px-3"><Toggle label="Oyuncu çıkarsa değiştir" checked={switchOnLeave} disabled={!manageable} onChange={setSwitchOnLeave}/><Toggle label="Oyuncu yayını kapatırsa değiştir" checked={switchOnShareStop} disabled={!manageable} onChange={setSwitchOnShareStop}/><Toggle label="Yayın bağlantısı koparsa değiştir" checked={switchOnDisconnect} disabled={!manageable} onChange={setSwitchOnDisconnect}/><Toggle label="Oyuncu AFK olursa değiştir" checked={switchOnAfk} disabled={!manageable} onChange={setSwitchOnAfk}/><Toggle label="Aynı oyuncuyu arka arkaya seçmemeye çalış" checked={avoidImmediateRepeat} disabled={!manageable} onChange={setAvoidImmediateRepeat}/></div>
        <div className="rounded-xl border border-amber-500/25 bg-amber-950/10 p-3"><Toggle label="Sunucuda oyuncu kalmazsa fallback yayına geç" sub="0 oyuncu olduğunda belirlenen süre beklenir; sonra yedek canlı kaynağa geçilir." checked={emptyFallbackEnabled} disabled={!manageable} onChange={setEmptyFallbackEnabled}/>{emptyFallbackEnabled&&<div className="mt-3 space-y-3 border-t border-amber-500/15 pt-3"><div className="grid gap-3 sm:grid-cols-3"><Field label="0 oyuncu sonrası bekleme (sn)" value={emptyFallbackDelaySeconds} onChange={setEmptyFallbackDelaySeconds} disabled={!manageable}/><Field label="Fallback minimum kilit süresi (sn)" value={emptyFallbackLockSeconds} onChange={setEmptyFallbackLockSeconds} disabled={!manageable}/><Field label="Oyuncuya dönüş beklemesi (sn)" value={returnToPlayersDelaySeconds} onChange={setReturnToPlayersDelaySeconds} disabled={!manageable}/></div><div className="space-y-1.5"><Label className="text-[11px] text-slate-300">Oyuncu yokken gösterilecek görüntü</Label><select value={emptyFallbackMode} disabled={!manageable} onChange={e=>setEmptyFallbackMode(e.target.value)} className="h-9 w-full rounded-md border border-emerald-950/80 bg-[#091712] px-3 text-xs text-slate-200"><option value="link">YouTube / Twitch / Kick canlı linki</option><option value="account">Bağlı YouTube / Twitch / Kick hesabı</option><option value="remote-player">Başka BLOCKCTRL sunucusundaki oyuncunun gözünden</option><option value="spectator-camera">Dış / spectator kamera</option></select></div>{(emptyFallbackMode==='link'||emptyFallbackMode==='account')&&<div className="space-y-1.5"><Label className="text-[11px] text-slate-300">Fallback platformu</Label><select value={emptyFallbackPlatform} disabled={!manageable} onChange={e=>setEmptyFallbackPlatform(e.target.value)} className="h-9 w-full rounded-md border border-emerald-950/80 bg-[#091712] px-3 text-xs text-slate-200"><option value="youtube">YouTube</option><option value="twitch">Twitch</option><option value="kick">Kick</option></select></div>}{emptyFallbackMode==='link'&&<Field label="Fallback canlı yayın / kanal linki" value={emptyFallbackUrl} onChange={setEmptyFallbackUrl} disabled={!manageable} placeholder={emptyFallbackPlatform==='youtube'?'https://youtube.com/watch?v=...':emptyFallbackPlatform==='twitch'?'https://twitch.tv/kanal':'https://kick.com/kanal'}/>} {emptyFallbackMode==='account'&&<p className="text-[10px] leading-5 text-slate-500">Seçtiğiniz platform hesabının yukarıdaki Hesap bağla bölümünden bağlı olması gerekir. Aktif canlı yayın yoksa sistem bunu aktifmiş gibi göstermez.</p>}{emptyFallbackMode==='remote-player'&&<><Field label="Fallback hedef sunucu ID" value={emptyFallbackServerId} onChange={setEmptyFallbackServerId} disabled={!manageable} placeholder="UUID biçiminde BLOCKCTRL sunucu ID"/><p className="text-[10px] leading-5 text-slate-500">Hedef sunucuda yayın izni veren uygun oyuncu varsa gateway onun POV akışını seçer. Hedef sunucuya erişim yetkisi kontrol edilir.</p></>}{emptyFallbackMode==='spectator-camera'&&<><Field label="Dış kamera kaynak anahtarı" value={emptyFallbackCameraKey} onChange={setEmptyFallbackCameraKey} disabled={!manageable} placeholder="ör. spawn-overview"/><p className="text-[10px] leading-5 text-slate-500">Bu kaynak WebRTC gateway’de tanımlı dış/spectator kamera olmalıdır. BLOCKCTRL görüntüyü yine kaydetmez.</p></>}</div>}</div></>}
        {sourceMode!=='direct'&&<div className="rounded-lg border border-emerald-950/60 bg-black/10 p-3 text-[11px] text-slate-400"><p className="font-semibold text-slate-200">Harici player</p><p className="mt-1 text-[10px] leading-5 text-slate-500">YouTube canlı video ID’si, Twitch kanal adı veya Kick kanal slug’ı kullanılarak resmi platform player’ı gösterilir. Yayın verisi platformdan izleyicinin tarayıcısına gider; BLOCKCTRL medya proxy’si veya kayıt sunucusu olmaz.</p></div>}
        </div></div>
        <div className="mt-4 flex flex-wrap gap-2"><Button className="bg-emerald-600 text-emerald-950" disabled={!manageable||busy} onClick={()=>action('save-live-stream',{config:{sourceMode,platform:streamPlatform,streamUrl,selectionMode,rotateSeconds:Number(rotateSeconds),switchOnLeave,switchOnShareStop,switchOnDisconnect,switchOnAfk,avoidImmediateRepeat,emptyFallbackEnabled,emptyFallbackMode,emptyFallbackPlatform,emptyFallbackUrl,emptyFallbackServerId,emptyFallbackCameraKey,emptyFallbackDelaySeconds:Number(emptyFallbackDelaySeconds),emptyFallbackLockSeconds:Number(emptyFallbackLockSeconds),returnToPlayersDelaySeconds:Number(returnToPlayersDelaySeconds)}})}><Save className="mr-2 size-4"/>Canlı yayın ayarlarını kaydet</Button><Button variant="outline" disabled={busy} onClick={resolveStreamPreview}><Wifi className="mr-2 size-4"/>{sourceMode==='direct'?'WebRTC geçidini test et':'Canlı yayını göster'}</Button></div>
        {streamPreview&&<div className="mt-4 rounded-xl border border-emerald-950/60 bg-black/15 p-3"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-semibold text-slate-200">Canlı yayın önizleme</p><p className="mt-0.5 text-[10px] text-slate-500">{String(streamPreview.message??'')}</p></div>{streamPreview.streamUrl&&<a className="text-[10px] text-emerald-300 underline" href={String(streamPreview.streamUrl)} target="_blank" rel="noreferrer">Platformda aç</a>}</div>{previewSrc?<div className="aspect-video overflow-hidden rounded-lg border border-emerald-950/70 bg-black"><iframe title="Canlı yayın" src={previewSrc} className="h-full w-full" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen/></div>:<div className="rounded-lg bg-[#07130f] p-6 text-center text-xs text-slate-500">{streamPreview.waitingForFallback?`Oyuncu yok · fallback ${String(streamPreview.fallbackInSeconds??'')} sn sonra devreye girecek.`:streamPreview.fallbackMode==='remote-player'?'Başka sunucudaki oyuncu POV akışı gateway player’a bağlandığında burada gösterilecek.':streamPreview.fallbackMode==='spectator-camera'?'Dış / spectator kamera akışı gateway player’a bağlandığında burada gösterilecek.':streamPreview.live===false?'Şu anda aktif yayın yok.':sourceMode==='direct'?'Doğrudan WebRTC oynatıcısı gateway istemci endpoint’i bağlandığında burada gösterilecek.':'Player kaynağı çözümlenemedi.'}</div>}</div>}
      </>}
    </section>}

    <div className="grid gap-3 md:grid-cols-3"><div className="rounded-xl border border-emerald-950/60 bg-black/10 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-slate-200"><ShieldCheck className="size-4 text-emerald-300"/>Güvenli secret saklama</div><p className="mt-1.5 text-[10px] leading-5 text-slate-500">Webhook, bot ve OAuth tokenları panel yanıtına geri verilmez; platform hesap tokenları şifreli saklanır.</p></div><div className="rounded-xl border border-emerald-950/60 bg-black/10 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-slate-200"><Radio className="size-4 text-emerald-300"/>Kayıtsız canlı veri</div><p className="mt-1.5 text-[10px] leading-5 text-slate-500">Minecraft görüntüsü ekran görüntüsü/video olarak tutulmaz; doğrudan WebRTC ile aktarılır veya resmi YouTube/Twitch/Kick player’ı kullanılır.</p></div><div className="rounded-xl border border-emerald-950/60 bg-black/10 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-slate-200"><Clock3 className="size-4 text-emerald-300"/>Entegrasyon logları</div><p className="mt-1.5 text-[10px] leading-5 text-slate-500">Test, yapılandırma, hesap bağlantısı ve Discord olay gönderimleri sunucuya özel kayıt altında tutulur.</p></div></div>
  </div>
}
