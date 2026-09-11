'use client'

import { useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Clipboard, Eye, EyeOff, KeyRound, Laptop, Network, Power, RefreshCw, ShieldCheck, Users, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

type SftpInfo = {
  username:string
  port:number
  rootPath:string
  status:string
  lastError?:string|null
  lastTestAt?:string|Date|null
  passwordRotatedAt?:string|Date|null
  disabledAt?:string|Date|null
  createdAt?:string|Date|null
  updatedAt?:string|Date|null
}

type Credentials={host:string;port:number;username:string;password:string;rootPath:string}
type Session={pid:number;elapsedSeconds?:number;process?:string}
type Checks={ready?:boolean;mounted?:boolean;sshdValid?:boolean;serviceActive?:boolean;secureChroot?:boolean;userExists?:boolean;rootExists?:boolean;enabled?:boolean}

type Props={serverId:string;host?:string;nodeOnline:boolean;sftp?:SftpInfo|null;onRefresh?:()=>void|Promise<unknown>}

async function readJson(response:Response){const text=await response.text();try{return text?JSON.parse(text):{}}catch{return {error:text||'Geçersiz sunucu yanıtı'}}}
function dateText(value?:string|Date|null){if(!value)return '—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('tr-TR')}
function duration(seconds=0){if(seconds<60)return `${seconds} sn`;const min=Math.floor(seconds/60);if(min<60)return `${min} dk`;return `${Math.floor(min/60)} sa ${min%60} dk`}

export function ServerSftpManager({serverId,host,nodeOnline,sftp,onRefresh}:Props){
  const [busy,setBusy]=useState('')
  const [notice,setNotice]=useState('')
  const [credentials,setCredentials]=useState<Credentials|null>(null)
  const [showPassword,setShowPassword]=useState(true)
  const [sessions,setSessions]=useState<Session[]>([])
  const [checks,setChecks]=useState<Checks|null>(null)

  async function post(action:string,extra:Record<string,unknown>={}){
    setBusy(action);setNotice('')
    try{
      const response=await fetch('/api/panel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,serverId,...extra}),cache:'no-store'})
      const data=await readJson(response)
      if(action==='test-sftp'&&data.status)setChecks(data.status)
      if(!response.ok)throw new Error(data.error??'SFTP işlemi başarısız')
      if((action==='provision-sftp'||action==='rotate-sftp-password')&&data.credentials){setCredentials(data.credentials);setShowPassword(true)}
      if(action==='list-sftp-sessions')setSessions(Array.isArray(data.sessions)?data.sessions:[])
      if(action==='terminate-sftp-session')await loadSessions(false)
      if(action==='provision-sftp')setNotice('SFTP hesabı oluşturuldu ve sunucu tarafında doğrulandı.')
      else if(action==='rotate-sftp-password')setNotice('SFTP parolası yenilendi. Yeni parola yalnız bu ekranda bir kez gösterilir.')
      else if(action==='test-sftp')setNotice('SFTP sunucu tarafı doğrulaması başarılı.')
      else if(action==='disable-sftp')setNotice('SFTP erişimi devre dışı bırakıldı ve açık oturumlar kapatıldı.')
      else if(action==='enable-sftp')setNotice('SFTP erişimi yeniden etkinleştirildi ve doğrulandı.')
      else if(action==='terminate-sftp-session')setNotice('SFTP oturumu sonlandırıldı.')
      await onRefresh?.()
      return data
    }catch(error){setNotice(error instanceof Error?error.message:'SFTP işlemi başarısız');return null}finally{setBusy('')}
  }

  async function loadSessions(setBusyState=true){
    if(setBusyState)setBusy('list-sftp-sessions')
    try{const response=await fetch('/api/panel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'list-sftp-sessions',serverId}),cache:'no-store'});const data=await readJson(response);if(!response.ok)throw new Error(data.error??'Oturumlar alınamadı');setSessions(Array.isArray(data.sessions)?data.sessions:[]);return data}catch(error){setNotice(error instanceof Error?error.message:'Oturumlar alınamadı');return null}finally{if(setBusyState)setBusy('')}
  }

  const actualHost=credentials?.host||host||'—'
  const actualPort=credentials?.port||sftp?.port||22
  const actualUser=credentials?.username||sftp?.username||'—'
  const verifiedReady=sftp?.status==='ready'&&!!sftp?.lastTestAt
  const legacyReady=sftp?.status==='ready'&&!sftp?.lastTestAt
  const disabled=sftp?.status==='disabled'
  const copy=(value:string)=>navigator.clipboard.writeText(value).then(()=>setNotice('Panoya kopyalandı.')).catch(()=>setNotice('Panoya kopyalanamadı.'))

  return <section className="rounded-xl border border-emerald-950/70 bg-[linear-gradient(145deg,rgba(15,33,26,.92),rgba(8,23,18,.92))] p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3"><div className="grid size-9 place-items-center rounded-lg bg-emerald-500/10 text-emerald-300"><KeyRound className="size-4.5"/></div><div><h3 className="text-sm font-semibold text-white">SFTP erişimi</h3><p className="mt-1 text-[11px] text-slate-500">Her Minecraft sunucusu için ayrı, chroot ile sınırlandırılmış dosya erişimi.</p></div></div>
      <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${verifiedReady?'bg-emerald-500/10 text-emerald-300':disabled?'bg-slate-700/50 text-slate-300':sftp?'bg-amber-500/10 text-amber-300':'bg-slate-800 text-slate-400'}`}>{verifiedReady?'● Hazır':legacyReady?'● Doğrulama gerekli':disabled?'● Devre dışı':sftp?`● ${sftp.status}`:'Kurulmadı'}</span>
    </div>

    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Info label="Host" value={actualHost}/><Info label="Port" value={String(actualPort)}/><Info label="Kullanıcı" value={actualUser}/><Info label="SFTP kökü" value={sftp?.rootPath||'/files'}/><Info label="Son doğrulama" value={dateText(sftp?.lastTestAt)}/>
    </div>

    {sftp?.lastError&&<div className="mt-4 flex gap-2 rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-xs text-red-200"><XCircle className="mt-0.5 size-4 shrink-0"/><div><b>Son SFTP hatası:</b> {sftp.lastError}</div></div>}

    <div className="mt-4 flex flex-wrap gap-2">
      {!sftp?<Button disabled={!nodeOnline||!!busy} className="bg-emerald-600 text-emerald-950 hover:bg-emerald-500" onClick={()=>void post('provision-sftp')}><KeyRound className="mr-2 size-4"/>{busy==='provision-sftp'?'Oluşturuluyor…':'SFTP oluştur'}</Button>:<>
        <Button disabled={!nodeOnline||!!busy} variant="outline" onClick={()=>void post('test-sftp')}><ShieldCheck className="mr-2 size-4"/>{busy==='test-sftp'?'Kontrol ediliyor…':'Doğrula'}</Button>
        <Button disabled={!nodeOnline||!!busy||disabled} variant="outline" onClick={()=>void post('rotate-sftp-password')}><RefreshCw className="mr-2 size-4"/>Parolayı yenile</Button>
        {disabled?<Button disabled={!nodeOnline||!!busy} className="bg-emerald-600 text-emerald-950 hover:bg-emerald-500" onClick={()=>void post('enable-sftp')}><Power className="mr-2 size-4"/>Etkinleştir</Button>:<Button disabled={!nodeOnline||!!busy} variant="destructive" onClick={()=>confirm('SFTP devre dışı bırakılsın ve aktif SFTP oturumları kapatılsın mı?')&&void post('disable-sftp')}><Power className="mr-2 size-4"/>Devre dışı bırak</Button>}
        <Button disabled={!nodeOnline||!!busy||disabled} variant="outline" onClick={()=>void loadSessions()}><Users className="mr-2 size-4"/>Aktif oturumlar</Button>
      </>}
    </div>

    {credentials&&<div className="mt-4 rounded-xl border border-amber-500/35 bg-amber-950/20 p-4">
      <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-300"/><div className="min-w-0 flex-1"><h4 className="text-sm font-semibold text-amber-200">Tek kullanımlık bağlantı bilgileri</h4><p className="mt-1 text-[11px] leading-5 text-amber-200/70">Parola veritabanında düz metin tutulmaz. Bu kutuyu kapattığınızda veya sayfayı yenilediğinizde parola tekrar gösterilemez.</p></div><Button size="sm" variant="outline" onClick={()=>{setCredentials(null);setShowPassword(true)}}>Gizle</Button></div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5"><Credential label="Host" value={credentials.host} onCopy={copy}/><Credential label="Port" value={String(credentials.port)} onCopy={copy}/><Credential label="Kullanıcı" value={credentials.username} onCopy={copy}/><Credential label="Parola" value={showPassword?credentials.password:'••••••••••••••••'} copyValue={credentials.password} onCopy={copy} action={<button type="button" onClick={()=>setShowPassword(v=>!v)} className="text-slate-400 hover:text-white">{showPassword?<EyeOff className="size-3.5"/>:<Eye className="size-3.5"/>}</button>}/><Credential label="Uzak dizin" value={credentials.rootPath} onCopy={copy}/></div>
    </div>}

    {checks&&<div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6"><Check label="Hesap" ok={checks.userExists}/><Check label="Sunucu dizini" ok={checks.rootExists}/><Check label="Bind mount" ok={checks.mounted}/><Check label="Chroot izinleri" ok={checks.secureChroot}/><Check label="sshd ayarı" ok={checks.sshdValid}/><Check label="SSH servisi" ok={checks.serviceActive}/></div>}

    {!!sessions.length&&<div className="mt-4 overflow-x-auto rounded-lg border border-emerald-950/60"><table className="w-full min-w-[560px] text-xs"><thead className="bg-black/15 text-left text-slate-400"><tr><th className="p-3">PID</th><th className="p-3">Süre</th><th className="p-3">İşlem</th><th className="p-3 text-right">İşlem</th></tr></thead><tbody>{sessions.map(session=><tr key={session.pid} className="border-t border-emerald-950/50"><td className="p-3 font-mono">{session.pid}</td><td className="p-3 text-slate-400">{duration(session.elapsedSeconds)}</td><td className="p-3">{session.process||'sshd'}</td><td className="p-3 text-right"><Button size="sm" variant="destructive" disabled={!!busy} onClick={()=>confirm(`PID ${session.pid} SFTP oturumu sonlandırılsın mı?`)&&void post('terminate-sftp-session',{pid:session.pid})}>Sonlandır</Button></td></tr>)}</tbody></table></div>}

    <div className="mt-4 grid gap-3 lg:grid-cols-2">
      <div className="rounded-lg border border-blue-500/25 bg-blue-950/15 p-3 text-[11px] leading-5 text-blue-200/80"><div className="flex items-center gap-2 font-semibold text-blue-200"><Laptop className="size-4"/>WinSCP / FileZilla</div><p className="mt-1">Protokol: <b>SFTP</b> · Host: <b>{actualHost}</b> · Port: <b>{actualPort}</b> · Kullanıcı: <b>{actualUser}</b> · Başlangıç dizini: <b>/files</b>.</p></div>
      <div className="rounded-lg border border-amber-500/25 bg-amber-950/15 p-3 text-[11px] leading-5 text-amber-200/80"><div className="flex items-center gap-2 font-semibold text-amber-200"><Network className="size-4"/>Dış erişim</div><p className="mt-1">Bu doğrulama node üzerindeki kullanıcı, chroot, mount ve sshd durumunu kontrol eder. Oracle Cloud Security List/NSG ve işletim sistemi firewall'ında gerçek SSH/SFTP portunun dışarıdan erişilebilir olması ayrıca gerekir.</p></div>
    </div>

    {(sftp?.passwordRotatedAt||sftp?.disabledAt)&&<p className="mt-3 text-[10px] text-slate-500">Son parola yenileme: {dateText(sftp?.passwordRotatedAt)} · Devre dışı bırakılma: {dateText(sftp?.disabledAt)}</p>}
    {notice&&<div role="status" className={`mt-4 rounded-lg border px-3 py-2 text-xs ${/başarısız|hata|bulunamadı|gerekli|döndürmedi/i.test(notice)?'border-red-500/30 bg-red-950/20 text-red-200':'border-emerald-500/25 bg-emerald-950/25 text-emerald-200'}`}>{notice}</div>}
  </section>
}

function Info({label,value}:{label:string;value:string}){return <div className="min-w-0 rounded-lg border border-emerald-950/55 bg-black/10 p-3"><p className="text-[10px] text-slate-500">{label}</p><p className="mt-1 truncate text-xs font-medium text-slate-200">{value}</p></div>}
function Credential({label,value,copyValue,onCopy,action}:{label:string;value:string;copyValue?:string;onCopy:(value:string)=>void;action?:ReactNode}){return <div className="min-w-0 rounded-lg border border-amber-900/40 bg-black/15 p-3"><p className="text-[10px] text-amber-200/60">{label}</p><div className="mt-1 flex items-center gap-2"><code className="min-w-0 flex-1 truncate text-xs text-amber-100">{value}</code>{action}<button type="button" className="text-amber-200/60 hover:text-amber-100" onClick={()=>onCopy(copyValue??value)}><Clipboard className="size-3.5"/></button></div></div>}
function Check({label,ok}:{label:string;ok?:boolean}){return <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[10px] ${ok?'border-emerald-500/20 bg-emerald-950/20 text-emerald-300':'border-red-500/20 bg-red-950/15 text-red-300'}`}>{ok?<CheckCircle2 className="size-3.5"/>:<XCircle className="size-3.5"/>}{label}</div>}
