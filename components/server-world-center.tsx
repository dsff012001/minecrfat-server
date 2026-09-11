'use client'

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { AlertTriangle, ArrowLeft, Box, CheckCircle2, Clock3, Download, Globe2, MoreHorizontal, Plus, RefreshCw, Search, Settings2, ShieldAlert, Trash2, UploadCloud, WandSparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export type WorldRow = { id?:string; name:string; isActive:boolean; sizeMb:number; seed?:string|null; lastBackupAt?:string|null; prepared?:boolean; templateId?:string|null; templateName?:string|null }
type Template = { id:string; name:string; category:string; mode:'native'|'package'; description:string; available:boolean; availability:'built-in'|'installed-package'|'package-required'|'unknown' }
type WorldsResponse = { templates:Template[]; categories:string[]; runtimeWorlds?:WorldRow[]; nodeOnline:boolean; runtimeSynced:boolean; runtimeError?:string|null }

type Props = {
  serverId:string
  serverName:string
  running:boolean
  busy:boolean
  canBackup:boolean
  canManage:boolean
  worlds:WorldRow[]
  lastBackupAt?:string|null
  onBackup:(worldName:string)=>Promise<void>|void
  onUpload:(file:File)=>Promise<void>|void
  onRefresh:()=>Promise<unknown>|unknown
}

async function json(response:Response){const text=await response.text();let body:any={};try{body=text?JSON.parse(text):{}}catch{body={error:text}}if(!response.ok)throw new Error(body.error??`İstek başarısız (${response.status})`);return body}
const fetcher=(url:string)=>fetch(url,{cache:'no-store'}).then(json)

export function ServerWorldCenter({serverId,serverName,running,busy,canBackup,canManage,worlds,lastBackupAt,onBackup,onUpload,onRefresh}:Props){
  const {data,error,mutate}=useSWR<WorldsResponse>(`/api/worlds?serverId=${encodeURIComponent(serverId)}`,fetcher,{refreshInterval:5000})
  const [view,setView]=useState<'list'|'create'|'settings'>('list')
  const [selectedWorld,setSelectedWorld]=useState<string>('')
  const [menu,setMenu]=useState<string>('')
  const [query,setQuery]=useState('')
  const [category,setCategory]=useState('Tümü')
  const [templateId,setTemplateId]=useState('klasik-survival')
  const [worldName,setWorldName]=useState('world_2')
  const [seed,setSeed]=useState('')
  const [activate,setActivate]=useState(true)
  const [notice,setNotice]=useState('')
  const [localBusy,setLocalBusy]=useState(false)
  const [difficulty,setDifficulty]=useState('')
  const [borderSize,setBorderSize]=useState('')
  const [borderCenterX,setBorderCenterX]=useState('')
  const [borderCenterZ,setBorderCenterZ]=useState('')
  const [borderWarningDistance,setBorderWarningDistance]=useState('')
  const [borderWarningTime,setBorderWarningTime]=useState('')
  const [borderDamageAmount,setBorderDamageAmount]=useState('')
  const [borderDamageBuffer,setBorderDamageBuffer]=useState('')
  const [spawnX,setSpawnX]=useState('')
  const [spawnY,setSpawnY]=useState('')
  const [spawnZ,setSpawnZ]=useState('')
  const [time,setTime]=useState('')
  const [weather,setWeather]=useState('')
  const [gamerules,setGamerules]=useState<Record<string,string>>({})

  const rows=data?.runtimeSynced&&data.runtimeWorlds?.length?data.runtimeWorlds:worlds
  const totalMb=rows.reduce((sum,w)=>sum+(Number(w.sizeMb)||0),0)
  const templates=data?.templates??[]
  const selectedTemplate=templates.find(t=>t.id===templateId)
  const filtered=useMemo(()=>templates.filter(t=>(category==='Tümü'||t.category===category)&&(!query.trim()||`${t.name} ${t.category}`.toLocaleLowerCase('tr-TR').includes(query.toLocaleLowerCase('tr-TR')))),[templates,category,query])
  const current=rows.find(w=>w.name===selectedWorld)

  async function post(action:string,payload:Record<string,unknown>={}){
    setLocalBusy(true);setNotice('')
    try{const result=await json(await fetch('/api/worlds',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({serverId,action,...payload})}));setNotice(result.message??'İşlem kuyruğa alındı.');await mutate();await onRefresh();return result}
    catch(e){setNotice(e instanceof Error?e.message:'İşlem başarısız');return null}finally{setLocalBusy(false)}
  }
  async function createWorld(){
    if(!selectedTemplate)return
    if(!/^[A-Za-z0-9_-]{1,40}$/.test(worldName)){setNotice('Dünya adı yalnız harf, rakam, _ ve - içerebilir.');return}
    await post('create',{templateId:selectedTemplate.id,worldName,seed:seed.slice(0,100),activateAfterCreate:activate})
  }
  async function destructive(action:'reset'|'delete'){
    if(!current)return
    const typed=prompt(`Onaylamak için dünya adını yazın: ${current.name}`)
    if(typed!==current.name)return
    await post(action,{worldName:current.name,confirmName:typed})
  }
  async function applyLive(){
    if(!current)return
    const payload:Record<string,unknown>={worldName:current.name}
    if(difficulty)payload.difficulty=difficulty
    if(borderSize.trim())payload.borderSize=Number(borderSize)
    if(borderCenterX.trim()&&borderCenterZ.trim())payload.borderCenter={x:Number(borderCenterX),z:Number(borderCenterZ)}
    if(borderWarningDistance.trim())payload.borderWarningDistance=Number(borderWarningDistance)
    if(borderWarningTime.trim())payload.borderWarningTime=Number(borderWarningTime)
    if(borderDamageAmount.trim())payload.borderDamageAmount=Number(borderDamageAmount)
    if(borderDamageBuffer.trim())payload.borderDamageBuffer=Number(borderDamageBuffer)
    if(spawnX.trim()&&spawnY.trim()&&spawnZ.trim())payload.spawn={x:Number(spawnX),y:Number(spawnY),z:Number(spawnZ)}
    if(time)payload.time=time
    if(weather)payload.weather=weather
    const rules=Object.fromEntries(Object.entries(gamerules).filter(([,v])=>v==='true'||v==='false').map(([k,v])=>[k,v==='true']))
    if(Object.keys(rules).length)payload.gamerules=rules
    if(Object.keys(payload).length===1){setNotice('Uygulanacak bir canlı dünya ayarı seçin.');return}
    await post('live-settings',payload)
  }

  if(view==='create')return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><button onClick={()=>setView('list')} className="mb-2 flex items-center gap-2 text-xs text-emerald-300 hover:text-emerald-200"><ArrowLeft className="size-4"/>Dünyalara dön</button><h3 className="text-[22px] font-bold text-white">Dünya Oluştur</h3><p className="text-xs text-slate-400">Hazır Minecraft dünyaları ve BlockCtrl şablonlarından yeni dünya hazırlayın.</p></div><div className="rounded-lg border border-emerald-950/70 bg-[#0b1914] px-3 py-2 text-xs text-slate-400">{templates.length} dünya türü</div></div>
    <div className="grid gap-3 xl:grid-cols-[360px_1fr]">
      <section className="space-y-3 rounded-xl border border-emerald-950/70 bg-[#0b1914] p-4"><h4 className="font-semibold">Dünya bilgileri</h4><label className="block text-xs text-slate-400">Dünya adı<Input className="mt-1" value={worldName} onChange={e=>setWorldName(e.target.value)}/></label><label className="block text-xs text-slate-400">Seed (isteğe bağlı)<Input className="mt-1" value={seed} onChange={e=>setSeed(e.target.value)} placeholder="Boş = rastgele"/></label><label className="flex items-center gap-2 rounded-lg border border-emerald-950/70 bg-black/10 p-3 text-xs"><input type="checkbox" checked={activate} onChange={e=>setActivate(e.target.checked)}/> Oluşturulduktan sonra aktif dünya yap</label>{selectedTemplate&&<div className="rounded-lg border border-emerald-950/70 bg-black/15 p-3"><div className="flex items-center justify-between gap-2"><b className="text-sm">{selectedTemplate.name}</b><Badge template={selectedTemplate}/></div><p className="mt-2 text-[11px] leading-5 text-slate-500">{selectedTemplate.description}</p></div>}<Button className="w-full bg-emerald-500 text-emerald-950 hover:bg-emerald-400" disabled={!canManage||running||localBusy||busy||!selectedTemplate?.available} onClick={createWorld}><WandSparkles className="mr-2 size-4"/>{selectedTemplate?.available?'Dünyayı oluştur':'Şablon paketi gerekli'}</Button>{running&&<p className="text-[11px] text-amber-300">Yeni dünya oluşturmak için sunucuyu tamamen durdurun.</p>}</section>
      <section className="rounded-xl border border-emerald-950/70 bg-[#0b1914] p-4"><div className="flex flex-wrap gap-2"><div className="relative min-w-[240px] flex-1"><Search className="absolute left-3 top-2.5 size-4 text-slate-500"/><input className="h-9 w-full rounded-md border border-emerald-950/80 bg-[#07130f] pl-9 pr-3 text-xs outline-none" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Dünya türü ara..."/></div><select className="h-9 rounded-md border border-emerald-950/80 bg-[#07130f] px-3 text-xs" value={category} onChange={e=>setCategory(e.target.value)}><option>Tümü</option>{(data?.categories??[]).map(c=><option key={c}>{c}</option>)}</select></div><div className="mt-4 grid max-h-[620px] gap-2 overflow-y-auto pr-1 md:grid-cols-2 2xl:grid-cols-3">{filtered.map(t=><button key={t.id} onClick={()=>setTemplateId(t.id)} className={`rounded-xl border p-3 text-left transition ${templateId===t.id?'border-emerald-400/70 bg-emerald-500/10':'border-emerald-950/70 bg-black/10 hover:border-emerald-800'}`}><div className="flex items-start justify-between gap-2"><div><div className="text-sm font-semibold text-white">{t.name}</div><div className="mt-1 text-[10px] text-slate-500">{t.category}</div></div><Badge template={t}/></div><p className="mt-2 line-clamp-2 text-[10px] leading-4 text-slate-500">{t.description}</p></button>)}</div>{!filtered.length&&<p className="py-12 text-center text-sm text-slate-500">Eşleşen dünya türü bulunamadı.</p>}</section>
    </div>
    <Notice text={notice}/>
  </div>

  if(view==='settings'&&current)return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><button onClick={()=>setView('list')} className="mb-2 flex items-center gap-2 text-xs text-emerald-300 hover:text-emerald-200"><ArrowLeft className="size-4"/>Dünyalara dön</button><h3 className="text-[22px] font-bold text-white">Dünya Ayarla · {current.name}</h3><p className="text-xs text-slate-400">Bu alt sayfa yalnız Dünyalar bölümünden açılır; sol menüye eklenmez.</p></div><span className={`rounded-full px-3 py-1 text-xs ${current.isActive?'bg-emerald-500/15 text-emerald-300':'bg-slate-700/40 text-slate-300'}`}>{current.isActive?'Aktif dünya':'Pasif dünya'}</span></div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><InfoCard label="Boyut" value={formatSize(current.sizeMb)}/><InfoCard label="Seed" value={current.seed||'Doğrulanmadı'}/><InfoCard label="Şablon" value={current.templateName||'Standart / içe aktarılan'}/><InfoCard label="Durum" value={current.prepared?'İlk başlatmada üretilecek':current.isActive?'Aktif':'Hazır'}/></div>
    <div className="grid gap-3 xl:grid-cols-2">
      <section className="rounded-xl border border-emerald-950/70 bg-[#0b1914] p-4"><div className="flex items-center gap-2"><Settings2 className="size-5 text-emerald-300"/><h4 className="font-semibold">Canlı dünya ayarları</h4></div><p className="mt-1 text-[11px] text-slate-500">Yalnız aktif ve çalışan dünyada güvenli Minecraft komutlarıyla uygulanır. Boş bırakılan seçenek değiştirilmez.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><Select label="Zorluk" value={difficulty} set={setDifficulty} options={[['','Değiştirme'],['peaceful','Peaceful'],['easy','Easy'],['normal','Normal'],['hard','Hard']]}/><Select label="Zaman" value={time} set={setTime} options={[['','Değiştirme'],['day','Gündüz'],['noon','Öğle'],['night','Gece'],['midnight','Gece yarısı']]}/><Select label="Hava" value={weather} set={setWeather} options={[['','Değiştirme'],['clear','Açık'],['rain','Yağmur'],['thunder','Fırtına']]}/><label className="text-xs text-slate-400">World border boyutu<Input className="mt-1" inputMode="numeric" value={borderSize} onChange={e=>setBorderSize(e.target.value)} placeholder="Değiştirme"/></label></div><div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3"><Input placeholder="Border merkez X" value={borderCenterX} onChange={e=>setBorderCenterX(e.target.value)}/><Input placeholder="Border merkez Z" value={borderCenterZ} onChange={e=>setBorderCenterZ(e.target.value)}/><Input placeholder="Border uyarı mesafesi" value={borderWarningDistance} onChange={e=>setBorderWarningDistance(e.target.value)}/><Input placeholder="Border uyarı süresi" value={borderWarningTime} onChange={e=>setBorderWarningTime(e.target.value)}/><Input placeholder="Border hasarı" value={borderDamageAmount} onChange={e=>setBorderDamageAmount(e.target.value)}/><Input placeholder="Border hasar tamponu" value={borderDamageBuffer} onChange={e=>setBorderDamageBuffer(e.target.value)}/></div><div className="mt-3 grid grid-cols-3 gap-2"><Input placeholder="Spawn X" value={spawnX} onChange={e=>setSpawnX(e.target.value)}/><Input placeholder="Spawn Y" value={spawnY} onChange={e=>setSpawnY(e.target.value)}/><Input placeholder="Spawn Z" value={spawnZ} onChange={e=>setSpawnZ(e.target.value)}/></div><div className="mt-4 grid gap-2 sm:grid-cols-2">{['keepInventory','mobGriefing','doDaylightCycle','doWeatherCycle','naturalRegeneration','doMobSpawning','doFireTick','announceAdvancements','doImmediateRespawn','showDeathMessages','disableRaids','doInsomnia','doPatrolSpawning','doTraderSpawning','doWardenSpawning','universalAnger'].map(rule=><label key={rule} className="flex items-center justify-between gap-2 rounded-lg border border-emerald-950/60 bg-black/10 px-3 py-2 text-xs"><span>{rule}</span><select className="rounded border border-emerald-950/70 bg-[#07130f] px-2 py-1" value={gamerules[rule]??''} onChange={e=>setGamerules(v=>({...v,[rule]:e.target.value}))}><option value="">Değiştirme</option><option value="true">Açık</option><option value="false">Kapalı</option></select></label>)}</div><Button className="mt-4 bg-emerald-500 text-emerald-950" disabled={!canManage||!running||!current.isActive||localBusy} onClick={applyLive}>Canlı ayarları uygula</Button>{(!running||!current.isActive)&&<p className="mt-2 text-[11px] text-amber-300">Canlı ayarlar için dünya aktif ve sunucu çalışıyor olmalıdır.</p>}</section>
      <section className="rounded-xl border border-emerald-950/70 bg-[#0b1914] p-4"><div className="flex items-center gap-2"><ShieldAlert className="size-5 text-amber-300"/><h4 className="font-semibold">Dünya yönetimi</h4></div><div className="mt-4 grid gap-2 sm:grid-cols-2">{canBackup&&<Button variant="outline" onClick={()=>onBackup(current.name)}>Yedek al</Button>}{!current.isActive&&canManage&&<Button variant="outline" disabled={running||localBusy} onClick={()=>post('set-active',{worldName:current.name})}>Aktif dünya yap</Button>}<Button variant="outline" disabled={!canManage||running||localBusy} onClick={()=>destructive('reset')}>Dünyayı sıfırla</Button><Button variant="destructive" disabled={!canManage||running||current.isActive||localBusy} onClick={()=>destructive('delete')}><Trash2 className="mr-2 size-4"/>Dünyayı sil</Button></div><div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-xs leading-5 text-amber-200"><AlertTriangle className="mr-2 inline size-4"/>Sıfırlama öncesinde otomatik güvenlik yedeği istenir. Aktif dünya silinemez. Dünya değiştirme/silme işlemleri sunucu kapalıyken yapılır.</div></section>
    </div><Notice text={notice}/>
  </div>

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-[22px] font-bold tracking-tight text-white">Dünyalar</h3><p className="mt-0.5 text-[12px] text-slate-400">Minecraft dünyalarını yönetin, ayarlayın, yedekleyin ve yeni dünya oluşturun.</p></div>{canManage&&<Button className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400" onClick={()=>setView('create')}><Plus className="mr-2 size-4"/>Dünya oluştur</Button>}</div>
    <div className="grid gap-3 xl:grid-cols-3"><InfoCard label="Toplam dünya boyutu" value={formatSize(totalMb)} sub={`${rows.length} dünya`}/><InfoCard label="Son yedek" value={lastBackupAt?new Date(lastBackupAt).toLocaleString('tr-TR'):'Henüz yok'} sub={lastBackupAt?'Yedek mevcut':'Yedek oluşturulmadı'}/><InfoCard label="Node dünya taraması" value={data?.runtimeSynced?'Senkron':'Bekleniyor'} sub={data?.runtimeSynced?'Gerçek disk klasörleri okundu':data?.runtimeError??'Agent verisi bekleniyor'} good={!!data?.runtimeSynced}/></div>
    {error&&<div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-200">Dünya agent verisi alınamadı: {error.message}</div>}
    <section className="rounded-xl border border-emerald-950/70 bg-[#0b1914] p-4"><div><h4 className="font-semibold">Dünya listesi</h4><p className="text-[11px] text-slate-500">Üç nokta menüsünden “Dünya ayarla” alt sayfasını açabilirsiniz.</p></div><div className="mt-4 space-y-3">{rows.length?rows.map((w,index)=><div key={w.id??w.name} className="grid items-center gap-3 rounded-xl border border-emerald-950/65 bg-black/10 p-4 lg:grid-cols-[1.45fr_.5fr_.7fr_.7fr_auto]"><div className="flex items-center gap-3"><div className={`grid size-12 place-items-center rounded-lg ${index===0?'bg-emerald-500/10':'bg-slate-800/60'}`}><Globe2 className="size-6 text-emerald-300"/></div><div><div className="flex flex-wrap items-center gap-2"><b>{w.name}</b>{w.isActive&&<span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">Varsayılan</span>}{w.prepared&&<span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300">Hazırlandı</span>}</div><p className="text-[11px] text-slate-500">{w.templateName||`Dünya klasörü: ${w.name}`}</p></div></div><Mini label="Boyut" value={formatSize(w.sizeMb)}/><Mini label="Seed" value={w.seed||'—'}/><Mini label="Durum" value={w.isActive?'● Aktif':w.prepared?'◐ İlk başlatma bekliyor':'Pasif'} good={w.isActive}/><div className="relative flex gap-2">{canBackup&&<Button size="sm" variant="outline" onClick={()=>onBackup(w.name)}>Yedek al</Button>}<Button size="icon" variant="outline" onClick={()=>setMenu(menu===w.name?'':w.name)}><MoreHorizontal className="size-4"/></Button>{menu===w.name&&<div className="absolute right-0 top-10 z-20 w-44 rounded-lg border border-emerald-900/70 bg-[#07130f] p-1 shadow-2xl"><button className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs hover:bg-emerald-950/60" onClick={()=>{setSelectedWorld(w.name);setView('settings');setMenu('')}}><Settings2 className="size-4"/>Dünya ayarla</button>{!w.isActive&&canManage&&<button disabled={running} className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs hover:bg-emerald-950/60 disabled:opacity-40" onClick={()=>{void post('set-active',{worldName:w.name});setMenu('')}}><CheckCircle2 className="size-4"/>Aktif yap</button>}</div>}</div></div>):<div className="py-10 text-center text-sm text-slate-500">Dünya bulunamadı.</div>}</div></section>
    <div className="grid gap-3 xl:grid-cols-2"><section className="rounded-xl border border-emerald-950/70 bg-[#0b1914] p-4"><h4 className="font-semibold">Dünya içe aktar</h4><p className="mt-1 text-[11px] text-slate-500">ZIP dünya paketini güvenli doğrudan yükleme sistemiyle sunucuya gönderin.</p><label className={`mt-3 flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-emerald-900/70 bg-black/10 p-5 text-center ${running?'pointer-events-none opacity-50':'hover:bg-emerald-950/15'}`}><UploadCloud className="mb-2 size-7 text-emerald-300"/><b className="text-sm">Dünya ZIP dosyası yükle</b><input type="file" accept=".zip" className="hidden" disabled={running||busy} onChange={e=>{const f=e.target.files?.[0];if(f)void onUpload(f);e.currentTarget.value='' }}/><span className="mt-2 text-[11px] text-slate-500">Sunucu kapalı olmalıdır.</span></label></section><section className="rounded-xl border border-emerald-950/70 bg-[#0b1914] p-4"><h4 className="font-semibold">Şablon entegrasyonu</h4><p className="mt-1 text-[11px] leading-5 text-slate-500">Vanilla ile güvenilir biçimde oluşturulabilen klasik tipler yerleşiktir. SkyBlock, OneBlock, kıyamet, RPG, modlu, felaket ve benzeri özel konseptler gerçek harita/datapack/mod içeriği gerektirir; node üzerinde onaylı ZIP şablonu yoksa sistem bunları çalışıyormuş gibi göstermez.</p><Button variant="outline" className="mt-3" onClick={()=>void mutate()}><RefreshCw className="mr-2 size-4"/>Şablon durumunu yenile</Button></section></div>
    <Notice text={notice}/>
  </div>
}

function Badge({template}:{template:Template}){return <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] ${template.available?'bg-emerald-500/15 text-emerald-300':'bg-amber-500/15 text-amber-300'}`}>{template.availability==='built-in'?'Yerleşik':template.availability==='installed-package'?'Paket hazır':template.availability==='unknown'?'Kontrol ediliyor':'Paket gerekli'}</span>}
function InfoCard({label,value,sub,good}:{label:string;value:string;sub?:string;good?:boolean}){return <div className="rounded-xl border border-emerald-950/70 bg-[#0b1914] p-4"><div className="text-[11px] text-slate-500">{label}</div><div className={`mt-1 text-xl font-semibold ${good?'text-emerald-300':'text-white'}`}>{value}</div>{sub&&<div className="mt-1 text-[10px] text-slate-500">{sub}</div>}</div>}
function Mini({label,value,good}:{label:string;value:string;good?:boolean}){return <div><div className="text-[9px] uppercase tracking-wide text-slate-600">{label}</div><div className={`mt-1 text-xs ${good?'text-emerald-300':'text-slate-300'}`}>{value}</div></div>}
function Select({label,value,set,options}:{label:string;value:string;set:(v:string)=>void;options:[string,string][]}){return <label className="text-xs text-slate-400">{label}<select className="mt-1 h-9 w-full rounded-md border border-emerald-950/80 bg-[#07130f] px-3 text-xs text-white" value={value} onChange={e=>set(e.target.value)}>{options.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>}
function Notice({text}:{text:string}){return text?<div className="rounded-xl border border-emerald-500/20 bg-emerald-950/15 px-4 py-3 text-xs text-emerald-100">{text}</div>:null}
function formatSize(mb:number){if(!Number.isFinite(mb)||mb<=0)return '0 MB';return mb>=1024?`${(mb/1024).toFixed(1)} GB`:`${mb.toFixed(0)} MB`}
