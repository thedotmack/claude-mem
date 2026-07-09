import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { g, readBatch } from '@helix-db/helix-db'
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js'
import { ensureDir, paths } from '../../shared/paths.js'
import { logger } from '../../utils/logger.js'
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js'
import { getSupervisor } from '../../supervisor/index.js'
import { createHelixHttpTransport, type HelixTransport } from '../../storage/helix/transport.js'

const HELIX_SUPERVISOR_ID = 'helix-db'

export class HelixManager {
  private child: ChildProcess | null = null
  private transport: HelixTransport | null = null
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly workspacePath: string

  constructor() {
    const port = SettingsDefaultsManager.get('CLAUDE_MEM_HELIX_PORT')
    this.baseUrl = SettingsDefaultsManager.get('CLAUDE_MEM_HELIX_URL') || `http://127.0.0.1:${port}`
    this.apiKey = SettingsDefaultsManager.get('CLAUDE_MEM_HELIX_API_KEY') || undefined
    this.workspacePath = paths.helix()
  }

  private ensureWorkspace(): void {
    ensureDir(this.workspacePath)
    const configPath = path.join(this.workspacePath, 'helix.toml')
    if (!existsSync(configPath)) {
      execFileSync('helix', ['init'], {
        cwd: this.workspacePath,
        env: sanitizeEnv(process.env),
        stdio: 'ignore'
      })
    }
  }

  async connect(): Promise<void> {
    if (this.transport && await this.healthCheck()) {
      return
    }

    this.transport = createHelixHttpTransport(this.baseUrl, this.apiKey)
    if (await this.healthCheck()) {
      logger.info('HELIX', 'Connected to existing Helix runtime', { baseUrl: this.baseUrl })
      return
    }

    this.ensureWorkspace()
    getSupervisor().assertCanSpawn('helix database')
    const port = SettingsDefaultsManager.get('CLAUDE_MEM_HELIX_PORT')
    this.child = spawn('helix', ['start', 'dev', '--foreground', '--disk', '--port', port], {
      cwd: this.workspacePath,
      env: sanitizeEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child.stdout?.on('data', chunk => {
      logger.debug('HELIX', 'Helix stdout', { message: String(chunk).trim() })
    })
    this.child.stderr?.on('data', chunk => {
      logger.debug('HELIX', 'Helix stderr', { message: String(chunk).trim() })
    })
    this.child.on('exit', code => {
      logger.info('HELIX', 'Helix process exited', { code })
      getSupervisor().unregisterProcess(HELIX_SUPERVISOR_ID)
      this.child = null
    })
    getSupervisor().registerProcess(HELIX_SUPERVISOR_ID, {
      type: 'service',
      pid: this.child.pid ?? -1,
      startedAt: new Date().toISOString()
    }, this.child)

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (await this.healthCheck()) {
        logger.info('HELIX', 'Helix runtime became healthy', { baseUrl: this.baseUrl })
        return
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`Timed out waiting for Helix runtime at ${this.baseUrl}`)
  }

  async disconnect(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM')
      getSupervisor().unregisterProcess(HELIX_SUPERVISOR_ID)
      this.child = null
    }
    this.transport = null
  }

  isConnected(): boolean {
    return this.transport !== null
  }

  async healthCheck(): Promise<boolean> {
    try {
      const transport = this.transport ?? createHelixHttpTransport(this.baseUrl, this.apiKey)
      const batch = readBatch()
        .varAs('count', g().nWithLabel('Project').limit(1).count())
        .returning(['count'])
      const client = (transport as any).client
      if (client) {
        await client.query().dynamic(batch.toDynamicRequest()).send()
        return true
      }
      await transport.findNodes('Project')
      return true
    } catch {
      return false
    }
  }

  async getTransport(): Promise<HelixTransport> {
    await this.connect()
    if (!this.transport) {
      throw new Error('Helix transport unavailable')
    }
    return this.transport
  }
}
