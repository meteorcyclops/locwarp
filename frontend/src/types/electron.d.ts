export interface LocatePcResult {
  ok: boolean
  lat?: number
  lng?: number
  accuracy?: number
  via?: 'windows' | 'ipwho.is' | 'ipapi.co' | 'freeipapi.com'
  code?: 'DENIED' | 'TIMEOUT' | 'UNKNOWN' | 'ERROR' | 'SPAWN_FAILED' | 'NODATA' | 'ALL_FAILED'
  message?: string
}

export type RenderMode = 'hardware' | 'software'

export interface RenderModeInfo {
  mode: RenderMode
  saved: RenderMode | null
  isWin10: boolean
}

export interface RestartBackendResult {
  ok: boolean
}

export interface DesktopApiConfig {
  baseUrl: string
  token: string
}

export interface NetworkContext {
  signature: string
  interfaceName: string | null
  ipv4: string | null
  cidr: number | null
  subnet: string | null
  changedAt: number
}

export interface GpsWatchRegion {
  displayId: number
  displayBounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  x: number
  y: number
  width: number
  height: number
}

export interface GpsWatchEvent {
  event: 'ready' | 'permission' | 'started' | 'frame' | 'warning' | 'status' | 'error' | 'stopping' | 'stopped'
  state?: string
  code?: string | number | null
  message?: string
  reason?: string
  frame?: number
  text?: string
  texts?: Array<{ text: string; confidence?: number; boundingBox?: number[] }>
  candidates?: Array<{
    latitude: number
    longitude: number
    text: string
    confidence?: number
    boundingBox?: number[]
  }>
  captureDroppedCount?: number
}

declare global {
  interface Window {
    electronAPI?: {
      platform: NodeJS.Platform
      locatePc(): Promise<LocatePcResult>
      getRenderMode(): Promise<RenderModeInfo>
      setRenderMode(mode: RenderMode): Promise<{ ok: boolean }>
      relaunchApp(): Promise<void>
      restartBackend(): Promise<RestartBackendResult>
      getDesktopApiConfig(): DesktopApiConfig
      getNetworkContext?(): Promise<NetworkContext>
      onNetworkContextChanged?(callback: (context: NetworkContext) => void): () => void
      gpsWatch?: {
        selectRegion(): Promise<{ ok: boolean; code?: string; region?: GpsWatchRegion }>
        start(region: GpsWatchRegion): Promise<{ ok: boolean; code?: string; state?: string; helper?: string }>
        stop(): Promise<{ ok: boolean; state?: string }>
        status(): Promise<{ state: string; region: GpsWatchRegion | null; supported: boolean }>
        updateStatus(status: {
          mode: 'latest' | 'complete'
          queued: number
          succeeded: number
          skipped: number
          framesSkipped?: number
        }): Promise<{ ok: boolean }>
        showMain(): Promise<{ ok: boolean }>
        onEvent(callback: (event: GpsWatchEvent) => void): () => void
      }
      clipboard?: {
        readText(): Promise<string> | string
        writeText(text: string): Promise<void> | void
      }
    }
  }
}

export {}
