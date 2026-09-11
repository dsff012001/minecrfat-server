import { NextRequest, NextResponse } from 'next/server'
import { neoForgePrefix } from '@/lib/neoforge-version'

export const revalidate = 0

async function fetchMetadata(url: string, loader: string, mcVersion: string) {
  const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/xml,text/xml;q=0.9' } })
  const contentType = response.headers.get('content-type') ?? 'unknown'
  console.info('[catalog:metadata]', { loader, mcVersion, host: new URL(url).hostname, status: response.status, contentType })
  if (!response.ok) throw new Error(`${loader === 'neoforge' ? 'NeoForge' : 'Forge'} katalog isteği başarısız: HTTP ${response.status}`)
  return { body: await response.text(), status: response.status, contentType }
}

type MojangManifest = { versions: Array<{ id: string; type: string }> }
export async function GET(request: NextRequest) {
  const loader = request.nextUrl.searchParams.get('loader') ?? 'vanilla'
  const mcVersion = request.nextUrl.searchParams.get('mcVersion')
  try {
    const manifest = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { next: { revalidate: 3600 } }).then(r => { if (!r.ok) throw new Error('Mojang kataloğu alınamadı'); return r.json() }) as MojangManifest
    const minecraft = manifest.versions.filter(v => v.type === 'release').slice(0, 80).map(v => v.id)
    if (!mcVersion || loader === 'vanilla' || loader === 'paper') return NextResponse.json({ minecraft, loaderVersions: [] })
    if (loader === 'fabric') {
      const rows = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`, { next: { revalidate: 3600 } }).then(r => r.ok ? r.json() : []) as Array<{ loader: { version: string; stable: boolean } }>
      return NextResponse.json({ minecraft, loaderVersions: rows.map(x => x.loader.version).slice(0, 30) })
    }
    const metadataUrl = loader === 'forge' ? 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml' : 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'
    const metadata = await fetchMetadata(metadataUrl, loader, mcVersion)
    const allVersions = [...metadata.body.matchAll(/<version>([^<]+)<\/version>/g)].map(x => x[1]).filter(Boolean)
    const prefix = loader === 'neoforge' ? neoForgePrefix(mcVersion) : null
    const versions = allVersions.filter(v => loader === 'forge' ? v.startsWith(`${mcVersion}-`) : v.startsWith(prefix!) && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(v)).reverse().slice(0, 80)
    console.info('[catalog:versions]', { loader, mcVersion, host: new URL(metadataUrl).hostname, status: metadata.status, contentType: metadata.contentType, total: allVersions.length, filtered: versions.length })
    if (versions.length === 0) return NextResponse.json({ error: loader === 'neoforge' ? 'NeoForge sürüm kataloğu alınamadı' : 'Forge sürüm kataloğu alınamadı', code: loader === 'neoforge' ? 'NEOFORGE_CATALOG_EMPTY' : 'FORGE_CATALOG_EMPTY' }, { status: 502 })
    return NextResponse.json({ minecraft, loaderVersions: versions })
  } catch (error) { console.error('[catalog:error]', { loader, mcVersion, message: error instanceof Error ? error.message : 'Katalog hatası' }); return NextResponse.json({ error: error instanceof Error ? error.message : 'Katalog hatası', code: loader === 'neoforge' ? 'NEOFORGE_CATALOG_ERROR' : 'CATALOG_ERROR' }, { status: 502 }) }
}
