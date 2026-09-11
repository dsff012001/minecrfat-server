'use client'

import { useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { Archive, Box, CheckCircle2, FileCog, FileText, FolderOpen, Gamepad2, Globe2, Loader2, Package, Pencil, RefreshCw, Save, Search, Trash2, UploadCloud, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type ContentCategory = 'mods' | 'plugins' | 'plugin-config' | 'resource-packs' | 'config' | 'worlds'
type ContentItem = { name:string; path:string; category:ContentCategory; directory:boolean; size:number; updatedAt:string; editable:boolean; source:'disk' }
type InventoryResponse = { items:ContentItem[]; scannedAt?:string; serverRunning?:boolean; error?:string }
type UploadTarget = 'auto'|'mods'|'plugins'|'configs'|'resource-packs'|'worlds'

const MAX_UPLOAD = 2 * 1024 * 1024 * 1024
const CHUNK_RETRY = 3

async function readJson(response:Response){const text=await response.text();try{return text?JSON.parse(text):{}}catch{throw new Error(response.ok?'Sunucudan geçersiz yanıt alındı':`Sunucu hatası (${response.status}): ${text.slice(0,180)}`)}}
const fetcher=(url:string)=>fetch(url,{cache:'no-store'}).then(async response=>{const data=await readJson(response) as InventoryResponse;if(!response.ok)throw new Error(data.error??'Sunucu içeriği alınamadı');return data})

async function directUploadFile(serverId:string,file:File,category:UploadTarget,onProgress:(percent:number)=>void){
  if(file.size>MAX_UPLOAD)throw new Error(`${file.name}: 2 GB sınırını aşıyor`)
  const start=await fetch('/api/direct-upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'start',serverId,filename:file.name,size:file.size,category})})
  const startData=await readJson(start) as {error?:string;uploadId?:string;commandId?:string;chunkSize?:number}
  if(!start.ok||!startData.uploadId||!startData.commandId||!startData.chunkSize)throw new Error(startData.error??'Yükleme başlatılamadı')
  const totalParts=Math.ceil(file.size/startData.chunkSize)
  for(let part=0;part<totalParts;part++){
    const chunk=file.slice(part*startData.chunkSize,Math.min(file.size,(part+1)*startData.chunkSize))
    let last=''
    for(let attempt=0;attempt<CHUNK_RETRY;attempt++){
      try{
        const response=await fetch(`/api/direct-upload?commandId=${encodeURIComponent(startData.commandId)}&uploadId=${encodeURIComponent(startData.uploadId)}&part=${part}`,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:chunk})
        const data=await readJson(response) as {error?:string};if(!response.ok)throw new Error(data.error??`Parça ${part+1} yüklenemedi`);last='';break
      }catch(error){last=error instanceof Error?error.message:'Parça yüklenemedi';if(attempt<CHUNK_RETRY-1)await new Promise(r=>setTimeout(r,700*(attempt+1)))}
    }
    if(last)throw new Error(last)
    onProgress(Math.round(((part+1)/totalParts)*100))
  }
  const complete=await fetch('/api/direct-upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'complete',commandId:startData.commandId,uploadId:startData.uploadId})})
  const completeData=await readJson(complete) as {error?:string;result?:unknown}
  if(!complete.ok)throw new Error(completeData.error??'Yükleme tamamlanamadı')
  return completeData.result
}

const tabs:Array<{key:'all'|'mods'|'plugins'|'resource-packs'|'config'|'worlds';label:string;icon:any}>=[
  {key:'all',label:'Tümü',icon:FolderOpen},{key:'mods',label:'Modlar',icon:Box},{key:'plugins',label:'Pluginler',icon:Package},{key:'resource-packs',label:'Resource Pack',icon:Archive},{key:'config',label:'Config',icon:FileCog},{key:'worlds',label:'Dünyalar',icon:Globe2},
]
const targetLabels:Record<UploadTarget,string>={auto:'Otomatik / Karma ZIP',mods:'Mod',plugins:'Plugin',configs:'Config','resource-packs':'Resource Pack',worlds:'Dünya'}
const categoryLabels:Record<ContentCategory,string>={mods:'Mod',plugins:'Plugin','plugin-config':'Plugin ayarı','resource-packs':'Resource Pack',config:'Config',worlds:'Dünya'}
const categoryClass:Record<ContentCategory,string>={mods:'bg-blue-500/10 text-blue-300',plugins:'bg-violet-500/10 text-violet-300','plugin-config':'bg-fuchsia-500/10 text-fuchsia-300','resource-packs':'bg-amber-500/10 text-amber-300',config:'bg-cyan-500/10 text-cyan-300',worlds:'bg-emerald-500/10 text-emerald-300'}
function formatSize(bytes:number,directory:boolean){if(directory)return 'Klasör';if(bytes<1024)return `${bytes} B`;if(bytes<1048576)return `${(bytes/1024).toFixed(1)} KB`;if(bytes<1073741824)return `${(bytes/1048576).toFixed(1)} MB`;return `${(bytes/1073741824).toFixed(2)} GB`}

export function ServerContentManager({serverId,running,canEdit}:{serverId:string;running:boolean;canEdit:boolean}){
  const inputRef=useRef<HTMLInputElement>(null)
  const {data,error,mutate,isLoading}=useSWR<InventoryResponse>(`/api/server-content?serverId=${serverId}`,fetcher,{refreshInterval:8000})
  const [tab,setTab]=useState<(typeof tabs)[number]['key']>('all')
  const [query,setQuery]=useState('')
  const [target,setTarget]=useState<UploadTarget>('auto')
  const [pending,setPending]=useState<File[]>([])
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const [progress,setProgress]=useState(0)
  const [editing,setEditing]=useState<ContentItem|null>(null)
  const [editorValue,setEditorValue]=useState('')
  const [editorLoading,setEditorLoading]=useState(false)

  const items=data?.items??[]
  const filtered=useMemo(()=>items.filter(item=>{
    const categoryOk=tab==='all'||item.category===tab||(tab==='plugins'&&item.category==='plugin-config')
    const q=query.trim().toLocaleLowerCase('tr-TR')
    return categoryOk&&(!q||(item.name+' '+item.path+' '+categoryLabels[item.category]).toLocaleLowerCase('tr-TR').includes(q))
  }),[items,tab,query])
  const counts=useMemo(()=>({mods:items.filter(x=>x.category==='mods').length,plugins:items.filter(x=>x.category==='plugins').length,pluginConfigs:items.filter(x=>x.category==='plugin-config').length,packs:items.filter(x=>x.category==='resource-packs').length,worlds:items.filter(x=>x.category==='worlds').length}),[items])

  async function uploadPending(){
    if(!pending.length||running||!canEdit)return
    if(target==='plugins'&&pending.some(file=>!file.name.toLowerCase().endsWith('.jar')))return setNotice('Plugin hedefinde yalnız .jar dosyası yüklenebilir.')
    if(target==='mods'&&pending.some(file=>!file.name.toLowerCase().endsWith('.jar')))return setNotice('Mod hedefinde yalnız .jar dosyası yüklenebilir.')
    if(target==='resource-packs'&&pending.some(file=>!file.name.toLowerCase().endsWith('.zip')))return setNotice('Resource Pack hedefinde .zip dosyası seçin.')
    if(target==='worlds'&&pending.some(file=>!file.name.toLowerCase().endsWith('.zip')))return setNotice('Dünya hedefinde .zip dosyası seçin.')
    setBusy(true);setNotice('');setProgress(0)
    try{
      for(let i=0;i<pending.length;i++){
        const file=pending[i]
        setNotice(`${file.name} yükleniyor...`)
        await directUploadFile(serverId,file,target,p=>setProgress(Math.round(((i+p/100)/pending.length)*100)))
      }
      const total=pending.length;setPending([]);setProgress(100);setNotice(`${total} dosya işlendi. Sunucu diski yeniden tarandı.`);if(inputRef.current)inputRef.current.value='';await mutate()
    }catch(error){setNotice(error instanceof Error?error.message:'Yükleme başarısız')}
    finally{setBusy(false)}
  }

  async function openEditor(item:ContentItem){
    if(!item.editable)return
    setEditorLoading(true);setNotice('')
    try{const response=await fetch(`/api/server-content?serverId=${serverId}&path=${encodeURIComponent(item.path)}`,{cache:'no-store'});const body=await readJson(response) as {content?:string;error?:string};if(!response.ok)throw new Error(body.error??'Dosya okunamadı');setEditing(item);setEditorValue(body.content??'')}
    catch(error){setNotice(error instanceof Error?error.message:'Dosya okunamadı')}
    finally{setEditorLoading(false)}
  }
  async function saveEditor(){
    if(!editing||running||!canEdit)return
    setEditorLoading(true);setNotice('')
    try{const response=await fetch('/api/server-content',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({serverId,path:editing.path,content:editorValue})});const body=await readJson(response) as {error?:string};if(!response.ok)throw new Error(body.error??'Dosya kaydedilemedi');setNotice(`${editing.path} kaydedildi. Önceki sürüm .bak olarak korundu.`);setEditing(null);await mutate()}
    catch(error){setNotice(error instanceof Error?error.message:'Dosya kaydedilemedi')}
    finally{setEditorLoading(false)}
  }
  async function remove(item:ContentItem){
    if(running||!canEdit)return
    const kind=item.category==='worlds'?'dünya klasörü':categoryLabels[item.category]
    if(!window.confirm(`${item.path} (${kind}) kalıcı olarak silinsin mi? Sunucunun kapalı olması gerekir.`))return
    setBusy(true);setNotice('')
    try{const response=await fetch('/api/server-content',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({serverId,path:item.path,confirm:true})});const body=await readJson(response) as {error?:string};if(!response.ok)throw new Error(body.error??'Silinemedi');if(editing?.path===item.path)setEditing(null);setNotice(`${item.path} silindi.`);await mutate()}
    catch(error){setNotice(error instanceof Error?error.message:'Silinemedi')}
    finally{setBusy(false)}
  }

  return <div className="space-y-3">
    <section className="rounded-xl border border-emerald-950/70 bg-[linear-gradient(145deg,rgba(15,33,26,.92),rgba(8,23,18,.92))] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-white">Mod / Plugin / Dünya içerik yöneticisi</h3><p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">Oracle sunucu diski doğrudan taranır. Panel kurulmadan önce eklenmiş mod ve pluginler de burada görünür. Karma ZIP; <b className="text-slate-300">mods/</b>, <b className="text-slate-300">plugins/</b>, <b className="text-slate-300">config/</b>, <b className="text-slate-300">resourcepacks/</b> ve dünya klasörlerini ayırır.</p></div><Button size="sm" variant="outline" onClick={()=>mutate()} disabled={isLoading||busy}><RefreshCw className={`mr-2 size-4 ${isLoading?'animate-spin':''}`}/>Sunucuyu tara</Button></div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5"><MiniStat icon={Box} label="Mod" value={counts.mods}/><MiniStat icon={Package} label="Plugin" value={counts.plugins}/><MiniStat icon={FileText} label="Plugin config" value={counts.pluginConfigs}/><MiniStat icon={Archive} label="Resource pack" value={counts.packs}/><MiniStat icon={Globe2} label="Dünya" value={counts.worlds}/></div>
      {data?.scannedAt&&<p className="mt-3 text-[10px] text-slate-600">Son gerçek disk taraması: {new Date(data.scannedAt).toLocaleString('tr-TR')}</p>}
    </section>

    <section className="rounded-xl border border-emerald-950/70 bg-[#0b1914] p-4">
      <input ref={inputRef} type="file" multiple className="hidden" accept=".jar,.zip,.yml,.yaml,.json,.properties,.toml,.ini,.cfg,.conf,.txt,.xml" onChange={e=>setPending(Array.from(e.target.files??[]))}/>
      <div className="grid gap-3 lg:grid-cols-[220px_1fr_auto] lg:items-end"><label className="block"><span className="mb-1.5 block text-[11px] font-semibold text-slate-300">Yükleme hedefi</span><select value={target} onChange={e=>setTarget(e.target.value as UploadTarget)} disabled={busy||running||!canEdit} className="h-9 w-full rounded-md border border-emerald-950/80 bg-[#07130f] px-3 text-xs">{Object.entries(targetLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><div><span className="mb-1.5 block text-[11px] font-semibold text-slate-300">Dosyalar</span><button type="button" onClick={()=>inputRef.current?.click()} disabled={busy||running||!canEdit} className="flex h-9 w-full items-center rounded-md border border-dashed border-emerald-800/70 bg-black/10 px-3 text-left text-xs text-slate-300 disabled:opacity-50"><UploadCloud className="mr-2 size-4 text-emerald-300"/>{pending.length?`${pending.length} dosya seçildi`:'JAR, ZIP veya config seç'}</button></div><Button onClick={uploadPending} disabled={!pending.length||busy||running||!canEdit} className="bg-emerald-600 text-emerald-950 hover:bg-emerald-500">{busy?<Loader2 className="mr-2 size-4 animate-spin"/>:<UploadCloud className="mr-2 size-4"/>}Yükle ve ayıkla</Button></div>
      {pending.length>0&&<div className="mt-3 flex flex-wrap gap-2">{pending.slice(0,8).map(file=><span key={`${file.name}-${file.size}`} className="rounded-md border border-emerald-950/70 bg-[#07130f] px-2 py-1 text-[10px] text-slate-400">{file.name} · {formatSize(file.size,false)}</span>)}{pending.length>8&&<span className="px-2 py-1 text-[10px] text-slate-500">+{pending.length-8} dosya</span>}</div>}
      {busy&&<div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{width:`${progress}%`}}/></div>}
      <p className="mt-3 text-[10px] leading-5 text-slate-500"><b className="text-slate-300">Karma ZIP:</b> Mod, plugin, plugin config, dünya, resource pack ve config dosyalarını tek ZIP içinde beraber yükleyebilirsiniz. Tek bir plugin JAR yüklerken hedefi “Plugin”, tek resource pack ZIP yüklerken “Resource Pack” seçin.</p>
    </section>

    {error&&<div className="rounded-xl border border-red-500/30 bg-red-950/20 p-3 text-xs text-red-200">Gerçek sunucu içeriği okunamadı: {error.message}</div>}
    {notice&&<div className="rounded-xl border border-emerald-500/25 bg-emerald-950/20 p-3 text-xs text-emerald-200">{notice}</div>}
    {running&&<div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-200">Sunucu çalışırken listeyi görüntüleyebilirsiniz; mod/plugin silme, yükleme ve config düzenleme için sunucuyu durdurun.</div>}

    <section className="overflow-hidden rounded-xl border border-emerald-950/70 bg-[linear-gradient(145deg,rgba(15,33,26,.92),rgba(8,23,18,.92))]">
      <div className="flex flex-wrap items-center gap-2 border-b border-emerald-950/65 p-3"><div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">{tabs.map(item=>{const Icon=item.icon;return <button key={item.key} onClick={()=>setTab(item.key)} className={`inline-flex h-8 shrink-0 items-center rounded-md border px-2.5 text-[11px] font-semibold ${tab===item.key?'border-emerald-500/50 bg-emerald-500/10 text-emerald-300':'border-emerald-950/70 text-slate-400 hover:text-white'}`}><Icon className="mr-1.5 size-3.5"/>{item.label}</button>})}</div><div className="relative w-full sm:w-64"><Search className="absolute left-2.5 top-2.5 size-3.5 text-slate-500"/><Input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Sunucu diskinde ara..." className="h-8 border-emerald-950/80 bg-[#091712] pl-8 text-xs"/></div></div>
      {isLoading?<div className="p-8 text-center text-xs text-slate-500"><Loader2 className="mx-auto mb-2 size-5 animate-spin"/>Sunucu diski taranıyor...</div>:filtered.length===0?<div className="p-8 text-center text-xs text-slate-500">Bu bölümde sunucu diskinde içerik bulunamadı.</div>:<div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-xs"><thead className="bg-white/[.025] text-slate-400"><tr><th className="px-4 py-3 font-medium">Ad</th><th className="px-4 py-3 font-medium">Tür</th><th className="px-4 py-3 font-medium">Gerçek konum</th><th className="px-4 py-3 font-medium">Boyut</th><th className="px-4 py-3 font-medium">Değiştirilme</th><th className="px-4 py-3 font-medium">İşlem</th></tr></thead><tbody>{filtered.map(item=><tr key={`${item.category}:${item.path}`} className="border-t border-emerald-950/55"><td className="px-4 py-3"><div className="flex items-center gap-3"><div className="grid size-8 place-items-center rounded-md bg-slate-800/70 text-slate-300">{item.category==='mods'?<Gamepad2 className="size-4"/>:item.category==='worlds'?<Globe2 className="size-4"/>:item.category==='resource-packs'?<Archive className="size-4"/>:<FileCog className="size-4"/>}</div><div className="min-w-0"><div className="max-w-[300px] truncate font-semibold text-white">{item.name}</div><div className="mt-0.5 text-[10px] text-emerald-400/80">Sunucu diskinde bulundu</div></div></div></td><td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-[10px] ${categoryClass[item.category]}`}>{categoryLabels[item.category]}</span></td><td className="px-4 py-3 font-mono text-[10px] text-slate-500">/{item.path}</td><td className="px-4 py-3 text-slate-400">{formatSize(item.size,item.directory)}</td><td className="px-4 py-3 text-slate-400">{new Date(item.updatedAt).toLocaleString('tr-TR')}</td><td className="px-4 py-3"><div className="flex gap-1.5">{item.editable&&<Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={editorLoading} onClick={()=>openEditor(item)}><Pencil className="mr-1 size-3"/>Görüntüle / düzenle</Button>}<Button size="sm" variant="outline" className="h-7 px-2 text-[10px] text-red-300" disabled={running||busy||!canEdit||item.path==='server.properties'} onClick={()=>remove(item)}><Trash2 className="mr-1 size-3"/>Sil</Button></div></td></tr>)}</tbody></table></div>}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-emerald-950/55 px-4 py-3 text-[10px] text-slate-500"><span>{filtered.length} öğe gösteriliyor · toplam {items.length}</span><span className="inline-flex items-center gap-1.5"><CheckCircle2 className="size-3.5 text-emerald-400"/>Yükleme geçmişi değil, gerçek Oracle sunucu dizini</span></div>
    </section>

    {editing&&<section className="rounded-xl border border-cyan-500/25 bg-[#081713] p-4"><div className="mb-3 flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-white">Plugin / config düzenleyici</h3><p className="mt-1 font-mono text-[10px] text-cyan-300">/{editing.path}</p></div><Button size="icon" variant="ghost" onClick={()=>setEditing(null)}><X className="size-4"/></Button></div><textarea value={editorValue} onChange={e=>setEditorValue(e.target.value)} spellCheck={false} className="min-h-[360px] w-full rounded-lg border border-emerald-950/80 bg-[#050e0b] p-3 font-mono text-xs leading-5 text-slate-200 outline-none focus:border-emerald-700"/><div className="mt-3 flex flex-wrap items-center justify-between gap-2"><p className="text-[10px] text-slate-500">Kaydetmeden önce eski dosya otomatik olarak <b>.bak</b> kopyasına taşınır. JAR dosyaları binary olduğu için metin olarak düzenlenmez.</p><Button onClick={saveEditor} disabled={running||editorLoading||!canEdit} className="bg-emerald-600 text-emerald-950 hover:bg-emerald-500">{editorLoading?<Loader2 className="mr-2 size-4 animate-spin"/>:<Save className="mr-2 size-4"/>}Kaydet</Button></div></section>}
  </div>
}

function MiniStat({icon:Icon,label,value}:{icon:any;label:string;value:number}){return <div className="rounded-lg border border-emerald-950/70 bg-[#07130f] p-3"><div className="flex items-center justify-between"><span className="text-[10px] text-slate-500">{label}</span><Icon className="size-3.5 text-emerald-400"/></div><div className="mt-1 text-xl font-semibold text-white">{value}</div></div>}
