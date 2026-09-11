import { Analytics } from '@vercel/analytics/next'
import { Geist, Geist_Mono } from 'next/font/google'
import type { Metadata, Viewport } from 'next'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })

export const metadata: Metadata = {
  title: 'BlockCtrl — Minecraft Sunucu Paneli',
  description: 'Vanilla, Fabric, Forge ve NeoForge Minecraft sunucularınızı tek panelden yönetin.',
  generator: 'v0.app',
}

export const viewport: Viewport = { colorScheme: 'dark', themeColor: '#101512', width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="tr" className="dark bg-background"><body className={`${geist.variable} ${geistMono.variable} min-h-svh antialiased`}>{children}{process.env.NODE_ENV === 'production' && <Analytics />}</body></html>
}
