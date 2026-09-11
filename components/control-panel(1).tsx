'use client'

import { useState } from 'react'
import { Box, Menu, Server, ShieldCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InfrastructureManager } from '@/components/infrastructure-manager'
import { cn } from '@/lib/utils'

export function ControlPanel() {
  const [mobileOpen, setMobileOpen] = useState(false)
  return <div className="min-h-svh bg-background font-sans text-foreground">
    <aside className={cn('fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-sidebar-border bg-sidebar transition-transform lg:translate-x-0',mobileOpen?'translate-x-0':'-translate-x-full')}>
      <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-5"><div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground"><Box className="size-5"/></span><span><strong className="block text-sm tracking-wide">BLOCKCTRL</strong><span className="block text-xs text-muted-foreground">CANLI SUNUCU PANELİ</span></span></div><Button variant="ghost" size="icon" className="lg:hidden" onClick={()=>setMobileOpen(false)} aria-label="Menüyü kapat"><X/></Button></div>
      <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Ana navigasyon"><div className="flex items-center gap-3 rounded-md bg-sidebar-primary px-3 py-2.5 text-sm font-medium text-sidebar-primary-foreground"><Server className="size-4"/>Sunucu operasyonları</div></nav>
      <div className="border-t border-sidebar-border p-4"><div className="flex items-center gap-3 text-sm text-muted-foreground"><ShieldCheck className="size-4 text-primary"/><span>Oturum ve izin korumalı</span></div></div>
    </aside>
    <div className="lg:pl-64"><header className="sticky top-0 z-20 flex h-16 items-center border-b bg-background/95 px-4 backdrop-blur md:px-6"><Button variant="ghost" size="icon" className="lg:hidden" onClick={()=>setMobileOpen(true)} aria-label="Menüyü aç"><Menu/></Button><div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground"><span className="size-2 rounded-full bg-primary"/>Panel çevrimiçi</div></header><main className="p-4 md:p-6 lg:p-8"><InfrastructureManager/></main></div>
  </div>
}
