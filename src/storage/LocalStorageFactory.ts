import type { Database } from 'bun:sqlite'
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js'
import { USER_SETTINGS_PATH } from '../shared/paths.js'
import { AgentEventsRepository, AuthRepository, MemoryItemsRepository, ProjectsRepository, ServerSessionsRepository } from './sqlite/index.js'
import {
  HelixAgentEventsRepository,
  HelixAuthRepository,
  HelixMemoryItemsRepository,
  HelixProjectsRepository,
  HelixServerSessionsRepository
} from './helix/index.js'
import type { HelixTransport } from './helix/transport.js'

export type LocalStorageBackend = 'sqlite' | 'helix'

export interface LocalStorageFactoryOptions {
  getDatabase: () => Database;
  backend?: string;
  getHelixTransport?: () => Promise<HelixTransport>;
}

export class LocalStorageFactory {
  constructor(private readonly options: LocalStorageFactoryOptions) {}

  getBackend(): LocalStorageBackend {
    const configured = this.options.backend
      ?? SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_DB_BACKEND
    return configured === 'helix' ? 'helix' : 'sqlite'
  }

  private async helixTransport(): Promise<HelixTransport> {
    if (!this.options.getHelixTransport) {
      throw new Error('Helix backend selected without a Helix transport provider')
    }
    return await this.options.getHelixTransport()
  }

  async projects(): Promise<ProjectsRepository | HelixProjectsRepository> {
    if (this.getBackend() === 'helix') {
      return new HelixProjectsRepository(await this.helixTransport())
    }
    return new ProjectsRepository(this.options.getDatabase())
  }

  async sessions(): Promise<ServerSessionsRepository | HelixServerSessionsRepository> {
    if (this.getBackend() === 'helix') {
      return new HelixServerSessionsRepository(await this.helixTransport())
    }
    return new ServerSessionsRepository(this.options.getDatabase())
  }

  async agentEvents(): Promise<AgentEventsRepository | HelixAgentEventsRepository> {
    if (this.getBackend() === 'helix') {
      return new HelixAgentEventsRepository(await this.helixTransport())
    }
    return new AgentEventsRepository(this.options.getDatabase())
  }

  async memoryItems(): Promise<MemoryItemsRepository | HelixMemoryItemsRepository> {
    if (this.getBackend() === 'helix') {
      return new HelixMemoryItemsRepository(await this.helixTransport())
    }
    return new MemoryItemsRepository(this.options.getDatabase())
  }

  async auth(): Promise<AuthRepository | HelixAuthRepository> {
    if (this.getBackend() === 'helix') {
      return new HelixAuthRepository(await this.helixTransport())
    }
    return new AuthRepository(this.options.getDatabase())
  }
}

