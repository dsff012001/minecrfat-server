'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { upload } from '@vercel/blob/client'
import {
  AlertTriangle, Bug, Check, CheckCircle2, Clock3, FileImage, Headphones, Info, LockKeyhole,
  MessageCircle, Paperclip, Send, ShieldCheck, UserRoundPlus, Video, X, XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const MAX_ATTACHMENTS = 6
const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/jpeg','image/png','image/webp','image/gif','image/avif','image/heic','image/heif',
  'video/mp4','video/webm','video/quicktime','video/x-m4v',
])

type AppRole='manager'|'admin'|'guide'|'member'
type ThreadType='support'|'bug'|'private'
type ThreadStatus='pending'|'open'|'invited'|'closed'|'declined'
type ThreadSummary={
  id:string;type:ThreadType;status:ThreadStatus;subject:string;priority:string;creatorUserId:string;targetUserId:string|null;assignedUserId:string|null;
  creatorName?:string|null;creatorRole?:string|null;targetName?:string|null;targetRole?:string|null;assignedName?:string|null;assignedRole?:string|null;
  acceptedAt?:string|null;closedAt?:string|null;lastMessageAt:string;createdAt:string;updatedAt:string
}
type Actor={id:string;name:string;role:AppRole}
type SupportSummary={actor:Actor;consent:{required:boolean;accepted:boolean;version:string};threads:ThreadSummary[];members:Array<{id:string;name:string;role:string}>;staff:Array<{id:string;name:string;role:string}>;attentionCount:number}
type Attachment={id:string;threadId:string;messageId:string;filename:string;contentType:string;sizeBytes:string|number;createdAt:string}
type ChatMessage={id:string;threadId:string;senderUserId:string;body:string;createdAt:string;senderName?:string|null;senderRole?:string|null;attachments:Attachment[]}
type ThreadDetail={thread:ThreadSummary;messages:ChatMessage[];permissions:{canAccept:boolean;canSend:boolean;canClose:boolean;canRespondInvite:boolean}}
type View='home'|'info'|'new-support'|'new-bug'|'invite-private'|'thread'

async function fetcher<T>(url:string){
  const response=await fetch(url,{cache:'no-store',headers:{accept:'application/json'}})
  const text=await response.text();let data:any={}
  try{data=text?JSON.parse(text):{}}catch{data={error:text.slice(0,200)}}
  if(!response.ok)throw new Error(String(data.error??`İstek başarısız (${response.status})`))
  return data as T
}
function roleLabel(role:unknown){const r=String(role);return r==='manager'?'Yönetici':r==='admin'?'Admin':r==='guide'?'Rehber / Yetkili':'Üye'}
function typeLabel(type:ThreadType){return type==='support'?'Destek':type==='bug'?'Hata bildirimi':'Özel sohbet'}
function statusLabel(status:ThreadStatus){return status==='pending'?'Onay bekliyor':status==='open'?'Açık':status==='invited'?'Davet bekliyor':status==='declined'?'Reddedildi':'Kapalı'}
function statusVariant(status:ThreadStatus):'default'|'secondary'|'destructive'|'outline'{return status==='open'?'default':status==='pending'||status==='invited'?'secondary':status==='declined'?'destructive':'outline'}
function bytes(value:number|string){const n=Number(value||0);if(n<1024)return `${n} B`;if(n<1024**2)return `${(n/1024).toFixed(1)} KB`;return `${(n/1024**2).toFixed(1)} MB`}
function safeFileName(name:string){return name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-160)||'file'}
function counterpart(thread:ThreadSummary,actor:Actor){
  if(thread.type==='private')return thread.creatorUserId===actor.id?(thread.targetName??'Üye'):(thread.creatorName??'Yetkili')
  if(thread.creatorUserId===actor.id)return thread.assignedName??'Destek ekibi'
  return thread.creatorName??'Üye'
}

export function SupportCenter(){
  const[open,setOpen]=useState(false)
  const[view,setView]=useState<View>('home')
  const[selectedId,setSelectedId]=useState<string|null>(null)
  const[busy,setBusy]=useState(false)
  const[error,setError]=useState<string|null>(null)
  const{data,mutate}=useSWR<SupportSummary>('/api/support',fetcher,{refreshInterval:open?3000:12000,revalidateOnFocus:true})
  const{data:detail,mutate:mutateDetail}=useSWR<ThreadDetail>(open&&selectedId?`/api/support?threadId=${encodeURIComponent(selectedId)}`:null,fetcher,{refreshInterval:2000,revalidateOnFocus:true})
  const isStaff=!!data&&['manager','admin','guide'].includes(data.actor.role)

  useEffect(()=>{if(open&&data&&data.consent.required&&!data.consent.accepted)setView('info')},[open,data])
  useEffect(()=>{if(!open){setSelectedId(null);setView('home');setError(null)}},[open])

  async function post(body:Record<string,unknown>){
    setBusy(true);setError(null)
    try{
      const response=await fetch('/api/support',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body)})
      const text=await response.text();let payload:any={};try{payload=text?JSON.parse(text):{}}catch{}
      if(!response.ok)throw new Error(String(payload.error??`İşlem başarısız (${response.status})`))
      await mutate();if(selectedId)await mutateDetail();return payload
    }catch(e){setError(e instanceof Error?e.message:'İşlem başarısız');return null}finally{setBusy(false)}
  }
  function selectThread(id:string){setSelectedId(id);setView('thread');setError(null)}

  return <>
    <Button type="button" variant="ghost" size="icon" className="relative rounded-full" aria-label="Destek ve sohbet" title="Destek ve sohbet" onClick={()=>setOpen(true)}>
      <MessageCircle className="size-[19px]"/>
      {!!data?.attentionCount&&<span className="absolute -right-0.5 -top-0.5 grid min-h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[9px] font-bold leading-4 text-white">{Math.min(99,data.attentionCount)}</span>}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="h-[88svh] w-[calc(100vw-1rem)] max-w-[1180px] overflow-hidden p-0 sm:max-w-[1180px]">
        <div className="flex h-full min-h-0 flex-col bg-background">
          <DialogHeader className="border-b px-5 py-4 text-left">
            <DialogTitle className="flex items-center gap-2"><MessageCircle className="size-5 text-primary"/>BLOCKCTRL Destek ve Sohbet</DialogTitle>
            <DialogDescription>Destek talepleri, hata bildirimleri ve yetkiliyle özel görüşmeler.</DialogDescription>
          </DialogHeader>
          {error&&<div className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertTriangle className="size-4 shrink-0"/>{error}</div>}
          {!data?<div className="grid flex-1 place-items-center text-sm text-muted-foreground">Destek sistemi yükleniyor...</div>:
          data.consent.required&&!data.consent.accepted?<ConsentView busy={busy} error={error} accept={async()=>{const ok=await post({action:'accept-consent'});if(ok)setView('home')}}/>:
          <div className="grid min-h-0 flex-1 md:grid-cols-[330px_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col border-r bg-muted/10">
              <div className="grid grid-cols-2 gap-2 border-b p-3">
                {!isStaff&&<Button size="sm" onClick={()=>{setSelectedId(null);setView('new-support')}}><Headphones className="mr-1 size-4"/>Destek</Button>}
                {!isStaff&&<Button size="sm" variant="outline" onClick={()=>{setSelectedId(null);setView('new-bug')}}><Bug className="mr-1 size-4"/>Hata bildir</Button>}
                <Button size="sm" variant="outline" className={isStaff?'col-span-1':''} onClick={()=>{setSelectedId(null);setView('info')}}><Info className="mr-1 size-4"/>Bilgilendirme</Button>
                {isStaff&&<Button size="sm" variant="outline" onClick={()=>{setSelectedId(null);setView('invite-private')}}><UserRoundPlus className="mr-1 size-4"/>Özel davet</Button>}
              </div>
              {isStaff&&<div className="border-b px-3 py-2 text-xs text-muted-foreground">Bekleyen destek: <b className="text-foreground">{data.threads.filter(t=>t.type!=='private'&&t.status==='pending').length}</b></div>}
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                {data.threads.length?data.threads.map(thread=><button type="button" key={thread.id} onClick={()=>selectThread(thread.id)} className={`w-full rounded-lg border p-3 text-left transition ${selectedId===thread.id?'border-primary/60 bg-primary/5':'bg-card hover:bg-muted/40'}`}>
                  <div className="flex items-start justify-between gap-2"><span className="min-w-0 truncate text-sm font-semibold">{thread.subject}</span><Badge variant={statusVariant(thread.status)} className="shrink-0 text-[10px]">{statusLabel(thread.status)}</Badge></div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span>{typeLabel(thread.type)} · {counterpart(thread,data.actor)}</span><span className="shrink-0">{new Date(thread.lastMessageAt).toLocaleDateString('tr-TR')}</span></div>
                </button>):<div className="p-6 text-center text-sm text-muted-foreground">Henüz sohbet veya destek talebi yok.</div>}
              </div>
            </aside>
            <main className="min-h-0 overflow-hidden">
              {view==='info'?<InformationPanel accepted={data.consent.accepted}/>:
               view==='new-support'?<CreateRequest kind="support" busy={busy} post={post} select={selectThread}/>:
               view==='new-bug'?<CreateRequest kind="bug" busy={busy} post={post} select={selectThread}/>:
               view==='invite-private'?<PrivateInvite members={data.members} busy={busy} post={post} select={selectThread}/>:
               selectedId?<Conversation detail={detail} actor={data.actor} busy={busy} post={post} refresh={async()=>{await Promise.all([mutate(),mutateDetail()])}}/>:<HomePanel actor={data.actor} isStaff={isStaff} pending={data.threads.filter(t=>t.type!=='private'&&t.status==='pending').length}/>} 
            </main>
          </div>}
        </div>
      </DialogContent>
    </Dialog>
  </>
}

function ConsentView({busy,accept}:{busy:boolean;error:string|null;accept:()=>Promise<void>}){
  const[checked,setChecked]=useState(false)
  return <div className="min-h-0 flex-1 overflow-y-auto p-5 md:p-8"><div className="mx-auto max-w-3xl space-y-5">
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-5"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-6 shrink-0 text-primary"/><div><h3 className="font-semibold">Destek ve sohbet bilgilendirmesi</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">Üyeler destek sistemini ilk kez kullanmadan önce bu bilgilendirmeyi okumalı ve kabul etmelidir.</p></div></div></div>
    <InformationPanel accepted={false}/>
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} className="mt-1 size-4 accent-emerald-500"/><span className="text-sm leading-6">Bilgilendirmeyi okudum. Destek mesajlarımın ve yüklediğim görsel/video dosyalarının talebimi çözmek amacıyla destek yetkilileri tarafından görüntülenebileceğini kabul ediyorum.</span></label>
    <Button className="w-full" disabled={!checked||busy} onClick={accept}><Check className="mr-1 size-4"/>{busy?'Kaydediliyor...':'Okudum ve kabul ediyorum'}</Button>
  </div></div>
}

function InformationPanel({accepted}:{accepted:boolean}){return <div className="h-full overflow-y-auto p-5 md:p-7"><div className="mx-auto max-w-3xl space-y-4">
  <div><h3 className="text-lg font-semibold">Bilgilendirme</h3><p className="mt-1 text-sm text-muted-foreground">Destek sisteminin nasıl çalıştığını ve dosya gönderim kurallarını burada görebilirsiniz.</p></div>
  <InfoCard icon={Headphones} title="Destek talebi"><p>Bir sorun yaşadığınızda konu ve açıklama ile talep oluşturursunuz. Talep önce <b>Onay bekliyor</b> durumuna geçer. Rehber, Admin veya Yönetici talebi kabul ettiğinde sohbet açılır.</p></InfoCard>
  <InfoCard icon={Bug} title="Hata bildirimi"><p>Panel veya sunucuyla ilgili hata bildirimi oluşturabilir; ekran görüntüsü, fotoğraf ve video ekleyebilirsiniz. Hata bildirimi de destek ekibi tarafından incelenir.</p></InfoCard>
  <InfoCard icon={FileImage} title="Görsel ve video ekleri"><p>JPEG, PNG, WEBP, GIF, AVIF, HEIC/HEIF ile MP4, WEBM, MOV ve M4V dosyaları kabul edilir. Bir mesajda en fazla {MAX_ATTACHMENTS} dosya ve dosya başına en fazla 100 MB gönderilebilir. Dosyalar özel Blob depolamada tutulur ve yalnız yetkili sohbet katılımcıları üzerinden görüntülenir.</p></InfoCard>
  <InfoCard icon={LockKeyhole} title="Özel sohbet"><p>Yönetici, Admin veya Rehber bir üyeyi birebir özel görüşmeye davet edebilir. Üye daveti kabul etmeden sohbet açılmaz. Özel sohbet yalnız iki katılımcıya görünür.</p></InfoCard>
  <InfoCard icon={XCircle} title="Sohbeti kapatma"><p>Destek talebini talebi açan üye veya ilgili destek yetkilisi kapatabilir. Özel sohbeti iki taraftan biri kapatabilir. Kapatılan sohbet geçmişi kayıt olarak saklanır.</p></InfoCard>
  {accepted&&<div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-300"><CheckCircle2 className="size-4"/>Bu bilgilendirmeyi kabul ettiniz.</div>}
</div></div>}

function InfoCard({icon:Icon,title,children}:{icon:typeof Headphones;title:string;children:ReactNode}){return <div className="rounded-xl border bg-card p-4"><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4"/></span><div><h4 className="font-medium">{title}</h4><div className="mt-1 text-sm leading-6 text-muted-foreground">{children}</div></div></div></div>}

function HomePanel({actor,isStaff,pending}:{actor:Actor;isStaff:boolean;pending:number}){return <div className="grid h-full place-items-center p-8"><div className="max-w-xl text-center"><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary"><MessageCircle className="size-7"/></span><h3 className="mt-4 text-xl font-semibold">Merhaba, {actor.name}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Soldan bir konuşma seçin veya yeni bir destek/hata talebi oluşturun.{isStaff?` Şu anda ${pending} bekleyen talep var.`:''}</p></div></div>}

function CreateRequest({kind,busy,post,select}:{kind:'support'|'bug';busy:boolean;post:(body:Record<string,unknown>)=>Promise<any>;select:(id:string)=>void}){
  const[subject,setSubject]=useState('');const[message,setMessage]=useState('');const[priority,setPriority]=useState('normal');const[files,setFiles]=useState<File[]>([]);const[progress,setProgress]=useState(0);const[localError,setLocalError]=useState<string|null>(null)
  async function submit(){
    setLocalError(null)
    if(subject.trim().length<3||message.trim().length<3){setLocalError('Konu ve açıklama en az 3 karakter olmalı.');return}
    if(files.length>MAX_ATTACHMENTS){setLocalError(`En fazla ${MAX_ATTACHMENTS} dosya seçebilirsiniz.`);return}
    for(const file of files){if(file.size>MAX_ATTACHMENT_BYTES||!ALLOWED_ATTACHMENT_TYPES.has(file.type)){setLocalError(`${file.name} desteklenmiyor veya 100 MB sınırını aşıyor.`);return}}
    const result=await post({action:'create-thread',type:kind,subject:subject.trim(),message:message.trim(),priority});if(!result?.threadId)return
    const threadId=String(result.threadId)
    try{
      if(files.length){const attachments=await uploadAttachments(threadId,files,setProgress);await post({action:'send-message',threadId,message:'',attachments,evidenceOnly:true})}
      setSubject('');setMessage('');setFiles([]);setProgress(0);select(threadId)
    }catch(e){setLocalError(e instanceof Error?e.message:'Dosyalar yüklenemedi');select(threadId)}
  }
  return <div className="h-full overflow-y-auto p-5 md:p-7"><div className="mx-auto max-w-2xl space-y-5"><div><h3 className="text-lg font-semibold">{kind==='bug'?'Hata bildir':'Destek talebi oluştur'}</h3><p className="mt-1 text-sm text-muted-foreground">{kind==='bug'?'Hatayı olabildiğince açık anlatın; isterseniz ekran görüntüsü veya video ekleyin.':'Sorununuzu açıklayın. Bir destek yetkilisi kabul ettiğinde canlı sohbet açılır.'}</p></div>
    {localError&&<div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{localError}</div>}
    <label className="block space-y-1.5"><span className="text-sm font-medium">Konu</span><Input value={subject} onChange={e=>setSubject(e.target.value)} maxLength={120} placeholder={kind==='bug'?'Örn. Dosya yükleme ekranında hata alıyorum':'Örn. Sunucum açılmıyor'}/></label>
    <label className="block space-y-1.5"><span className="text-sm font-medium">Öncelik</span><select value={priority} onChange={e=>setPriority(e.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="low">Düşük</option><option value="normal">Normal</option><option value="high">Yüksek</option><option value="urgent">Acil</option></select></label>
    <label className="block space-y-1.5"><span className="text-sm font-medium">Açıklama</span><textarea value={message} onChange={e=>setMessage(e.target.value)} maxLength={5000} rows={7} className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring" placeholder="Sorunu, ne yaptığınızı ve ne olduğunu yazın..."/></label>
    <AttachmentPicker files={files} setFiles={setFiles} progress={progress}/>
    <Button className="w-full" disabled={busy} onClick={submit}>{kind==='bug'?<Bug className="mr-1 size-4"/>:<Headphones className="mr-1 size-4"/>}{busy?'Gönderiliyor...':kind==='bug'?'Hata bildirimini gönder':'Destek talebini gönder'}</Button>
  </div></div>
}

function PrivateInvite({members,busy,post,select}:{members:Array<{id:string;name:string;role:string}>;busy:boolean;post:(body:Record<string,unknown>)=>Promise<any>;select:(id:string)=>void}){
  const[targetUserId,setTargetUserId]=useState('');const[subject,setSubject]=useState('Özel görüşme');const[message,setMessage]=useState('')
  useEffect(()=>{if(!targetUserId&&members[0])setTargetUserId(members[0].id)},[members,targetUserId])
  return <div className="h-full overflow-y-auto p-5 md:p-7"><div className="mx-auto max-w-2xl space-y-5"><div><h3 className="text-lg font-semibold">Üyeyi özel sohbete çağır</h3><p className="mt-1 text-sm text-muted-foreground">Davet yalnız seçtiğiniz üyeye görünür. Üye kabul ettikten sonra birebir sohbet açılır.</p></div>
    {!members.length?<div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Özel sohbete davet edilebilecek onaylı üye bulunmuyor.</div>:<>
      <label className="block space-y-1.5"><span className="text-sm font-medium">Üye</span><select value={targetUserId} onChange={e=>setTargetUserId(e.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm">{members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <label className="block space-y-1.5"><span className="text-sm font-medium">Konu</span><Input value={subject} onChange={e=>setSubject(e.target.value)} maxLength={120}/></label>
      <label className="block space-y-1.5"><span className="text-sm font-medium">Davet mesajı</span><textarea value={message} onChange={e=>setMessage(e.target.value)} maxLength={5000} rows={6} className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Neden görüşmek istediğinizi yazın..."/></label>
      <Button className="w-full" disabled={busy||!targetUserId} onClick={async()=>{const result=await post({action:'invite-private',targetUserId,subject,message});if(result?.threadId)select(String(result.threadId))}}><UserRoundPlus className="mr-1 size-4"/>{busy?'Davet gönderiliyor...':'Özel sohbet daveti gönder'}</Button>
    </>}
  </div></div>
}

function Conversation({detail,actor,busy,post,refresh}:{detail?:ThreadDetail;actor:Actor;busy:boolean;post:(body:Record<string,unknown>)=>Promise<any>;refresh:()=>Promise<void>}){
  const[text,setText]=useState('');const[files,setFiles]=useState<File[]>([]);const[progress,setProgress]=useState(0);const[localError,setLocalError]=useState<string|null>(null)
  const thread=detail?.thread
  useEffect(()=>{setText('');setFiles([]);setProgress(0);setLocalError(null)},[thread?.id])
  if(!detail||!thread)return <div className="grid h-full place-items-center text-sm text-muted-foreground">Sohbet yükleniyor...</div>
  async function send(){
    setLocalError(null)
    if(!text.trim()&&!files.length)return
    if(files.length>MAX_ATTACHMENTS){setLocalError(`En fazla ${MAX_ATTACHMENTS} dosya seçebilirsiniz.`);return}
    for(const file of files){if(file.size>MAX_ATTACHMENT_BYTES||!ALLOWED_ATTACHMENT_TYPES.has(file.type)){setLocalError(`${file.name} desteklenmiyor veya 100 MB sınırını aşıyor.`);return}}
    try{
      const attachments=files.length?await uploadAttachments(thread.id,files,setProgress):[]
      const result=await post({action:'send-message',threadId:thread.id,message:text.trim(),attachments})
      if(result){setText('');setFiles([]);setProgress(0);await refresh()}
    }catch(e){setLocalError(e instanceof Error?e.message:'Mesaj gönderilemedi')}
  }
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-semibold">{thread.subject}</h3><Badge variant={statusVariant(thread.status)}>{statusLabel(thread.status)}</Badge><Badge variant="outline">{typeLabel(thread.type)}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{counterpart(thread,actor)} · {thread.type==='support'||thread.type==='bug'?(thread.assignedName?`Atanan: ${thread.assignedName}`:'Henüz yetkili atanmadı'):'Birebir özel görüşme'}</p></div><div className="flex flex-wrap gap-2">
      {detail.permissions.canAccept&&<Button size="sm" onClick={async()=>{await post({action:'accept-thread',threadId:thread.id});await refresh()}} disabled={busy}><Check className="mr-1 size-4"/>Talebi kabul et</Button>}
      {detail.permissions.canRespondInvite&&<><Button size="sm" onClick={async()=>{await post({action:'respond-invite',threadId:thread.id,accept:true});await refresh()}} disabled={busy}><Check className="mr-1 size-4"/>Kabul et</Button><Button size="sm" variant="outline" onClick={async()=>{await post({action:'respond-invite',threadId:thread.id,accept:false});await refresh()}} disabled={busy}><X className="mr-1 size-4"/>Reddet</Button></>}
      {detail.permissions.canClose&&<Button size="sm" variant="outline" onClick={async()=>{if(!window.confirm('Bu sohbet kapatılsın mı?'))return;await post({action:'close-thread',threadId:thread.id});await refresh()}} disabled={busy}><XCircle className="mr-1 size-4"/>Kapat</Button>}
    </div></div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-muted/5 p-4">{detail.messages.length?detail.messages.map(message=><MessageBubble key={message.id} message={message} mine={message.senderUserId===actor.id}/>):<div className="grid h-full place-items-center text-sm text-muted-foreground">Henüz mesaj yok.</div>}</div>
    {localError&&<div className="border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">{localError}</div>}
    {thread.status==='pending'&&!detail.permissions.canAccept?<div className="border-t bg-amber-500/5 px-4 py-3 text-sm text-amber-300"><Clock3 className="mr-1 inline size-4"/>Talebiniz destek ekibinin kabulünü bekliyor. Kabul edildikten sonra sohbet açılır.</div>:
     thread.status==='invited'&&!detail.permissions.canRespondInvite?<div className="border-t bg-blue-500/5 px-4 py-3 text-sm text-blue-300"><Clock3 className="mr-1 inline size-4"/>Özel sohbet davetinin kabul edilmesi bekleniyor.</div>:
     thread.status==='closed'||thread.status==='declined'?<div className="border-t px-4 py-3 text-center text-sm text-muted-foreground">Bu sohbet {thread.status==='declined'?'reddedildi':'kapatıldı'}. Mesaj gönderilemez.</div>:
     detail.permissions.canSend?<div className="border-t p-3"><div className="flex gap-2"><textarea value={text} onChange={e=>setText(e.target.value)} maxLength={5000} rows={2} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send()}}} placeholder="Mesajınızı yazın..." className="min-h-12 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"/><Button className="self-end" size="icon" onClick={send} disabled={busy||(!text.trim()&&!files.length)} aria-label="Mesajı gönder"><Send/></Button></div><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs hover:bg-muted"><Paperclip className="size-3.5"/>Görsel / video ekle<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,image/heif,video/mp4,video/webm,video/quicktime,video/x-m4v" multiple className="hidden" onChange={e=>setFiles(Array.from(e.target.files??[]).slice(0,MAX_ATTACHMENTS))}/></label><span className="text-xs text-muted-foreground">{files.length?`${files.length} dosya seçildi`:''}</span></div>{progress>0&&progress<100&&<Progress value={progress} className="mt-2"/>}{files.length>0&&<div className="mt-2 flex flex-wrap gap-1">{files.map(file=><Badge key={`${file.name}-${file.size}`} variant="secondary" className="max-w-52 truncate">{file.name}</Badge>)}</div>}</div>:
     <div className="border-t px-4 py-3 text-center text-sm text-muted-foreground">Bu konuşmaya mesaj gönderme yetkiniz yok.</div>}
  </div>
}

function MessageBubble({message,mine}:{message:ChatMessage;mine:boolean}){return <div className={`flex ${mine?'justify-end':'justify-start'}`}><div className={`max-w-[88%] rounded-2xl border px-3 py-2 ${mine?'border-primary/30 bg-primary/10':'bg-card'}`}><div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground"><b className="text-foreground">{message.senderName??'Kullanıcı'}</b><span>{roleLabel(message.senderRole)}</span><span>·</span><span>{new Date(message.createdAt).toLocaleString('tr-TR')}</span></div>{message.body&&<p className="whitespace-pre-wrap break-words text-sm leading-6">{message.body}</p>}{message.attachments?.length>0&&<div className="mt-2 grid gap-2 sm:grid-cols-2">{message.attachments.map(file=><AttachmentPreview key={file.id} file={file}/>)}</div>}</div></div>}

function AttachmentPreview({file}:{file:Attachment}){const src=`/api/support?attachmentId=${encodeURIComponent(file.id)}`;const video=file.contentType.startsWith('video/');return <div className="overflow-hidden rounded-lg border bg-black/10">{video?<video src={src} controls preload="metadata" className="max-h-72 w-full bg-black"/>:<a href={src} target="_blank" rel="noreferrer"><img src={src} alt={file.filename} loading="lazy" className="max-h-72 w-full object-contain"/></a>}<div className="flex items-center gap-2 px-2 py-1.5 text-[10px] text-muted-foreground">{video?<Video className="size-3"/>:<FileImage className="size-3"/>}<span className="min-w-0 flex-1 truncate">{file.filename}</span><span>{bytes(file.sizeBytes)}</span></div></div>}

function AttachmentPicker({files,setFiles,progress}:{files:File[];setFiles:(files:File[])=>void;progress:number}){return <div className="space-y-2"><div className="rounded-lg border border-dashed p-4"><label className="flex cursor-pointer items-center justify-center gap-2 text-sm"><Paperclip className="size-4 text-primary"/>Görsel veya video seç<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,image/heif,video/mp4,video/webm,video/quicktime,video/x-m4v" multiple className="hidden" onChange={e=>setFiles(Array.from(e.target.files??[]).slice(0,MAX_ATTACHMENTS))}/></label><p className="mt-1 text-center text-xs text-muted-foreground">En fazla {MAX_ATTACHMENTS} dosya · dosya başına 100 MB</p></div>{files.length>0&&<div className="flex flex-wrap gap-1">{files.map(file=><Badge key={`${file.name}-${file.size}`} variant="secondary">{file.name} · {bytes(file.size)}</Badge>)}</div>}{progress>0&&progress<100&&<div className="space-y-1"><Progress value={progress}/><p className="text-right text-xs text-muted-foreground">Yükleniyor %{progress}</p></div>}</div>}

async function uploadAttachments(threadId:string,files:File[],setProgress:(value:number)=>void){
  const uploaded:Array<{pathname:string;url:string;filename:string;contentType:string;sizeBytes:number}>=[]
  for(let index=0;index<files.length;index++){
    const file=files[index]
    const base=Math.round(index/files.length*100)
    const weight=1/files.length
    const pathname=`support/${threadId}/${crypto.randomUUID()}-${safeFileName(file.name)}`
    const blob=await upload(pathname,file,{access:'private',handleUploadUrl:'/api/support-upload',clientPayload:JSON.stringify({threadId}),multipart:true,onUploadProgress:event=>setProgress(Math.min(99,Math.round(base+event.percentage*weight)))})
    uploaded.push({pathname:blob.pathname,url:blob.url,filename:file.name,contentType:file.type,sizeBytes:file.size})
  }
  setProgress(100)
  return uploaded
}
