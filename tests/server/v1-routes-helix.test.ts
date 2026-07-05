import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Server, type ServerOptions } from '../../src/services/server/Server.js'
import { ServerV1Routes } from '../../src/server/routes/v1/ServerV1Routes.js'
import { InMemoryHelixTransport } from '../../src/storage/helix/index.js'
import { logger } from '../../src/utils/logger.js'

let loggerSpies: ReturnType<typeof spyOn>[] = []

describe('server REST API v1 routes (helix backend)', () => {
  let db: Database
  let server: Server
  let port: number
  let transport: InMemoryHelixTransport

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ]
    db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    transport = new InMemoryHelixTransport()
    const options: ServerOptions = {
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({
        provider: 'claude',
        authMethod: 'cli',
        lastInteraction: null,
      }),
    }
    server = new Server(options)
    server.registerRoutes(new ServerV1Routes({
      getDatabase: () => db,
      backend: 'helix',
      getHelixTransport: async () => transport,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
    }))
    server.finalizeRoutes()
    await server.listen(0, '127.0.0.1')
    const address = server.getHttpServer()?.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected server to bind to an ephemeral TCP port')
    }
    port = address.port
  })

  afterEach(async () => {
    try {
      await server.close()
    } catch (error: any) {
      if (error?.code !== 'ERR_SERVER_NOT_RUNNING') {
        throw error
      }
    }
    db.close()
    loggerSpies.forEach(spy => spy.mockRestore())
    mock.restore()
  })

  it('creates and searches records through the helix backend', async () => {
    const projectResponse = await post('/v1/projects', {
      name: 'Claude Mem',
      rootPath: '/tmp/claude-mem',
    })
    expect(projectResponse.status).toBe(201)
    const { project } = await projectResponse.json()

    const sessionResponse = await post('/v1/sessions/start', {
      projectId: project.id,
      memorySessionId: 'memory-1',
    })
    expect(sessionResponse.status).toBe(201)
    const { session } = await sessionResponse.json()

    const eventResponse = await post('/v1/events', {
      projectId: project.id,
      serverSessionId: session.id,
      sourceType: 'api',
      eventType: 'observation.created',
      payload: { type: 'learned' },
      occurredAtEpoch: Date.now(),
    })
    expect(eventResponse.status).toBe(201)

    const memoryResponse = await post('/v1/memories', {
      projectId: project.id,
      serverSessionId: session.id,
      kind: 'manual',
      type: 'note',
      title: 'Queue backend',
      narrative: 'BullMQ keeps deployable server queues in Valkey.',
      facts: ['BullMQ mode requires Redis or Valkey'],
    })
    expect(memoryResponse.status).toBe(201)
    const { memory } = await memoryResponse.json()

    const searchResponse = await post('/v1/search', {
      projectId: project.id,
      query: 'Valkey',
    })
    expect(searchResponse.status).toBe(200)
    const search = await searchResponse.json()
    expect(search.memories.map((item: any) => item.id)).toContain(memory.id)

    const infoResponse = await fetch(`http://127.0.0.1:${port}/v1/info`)
    expect(infoResponse.status).toBe(200)
    expect((await infoResponse.json()).storageBackend).toBe('helix')
  })

  async function post(path: string, body: unknown): Promise<Response> {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
})
