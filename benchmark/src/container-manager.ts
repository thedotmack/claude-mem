import Docker from 'dockerode';
import { resolve } from 'node:path';
import type { AgentConfig, Arm, ContainerInfo } from './types.js';

export class DockerConnectionError extends Error {
  constructor(public readonly reason: string) {
    super(`Failed to connect to Docker daemon: ${reason}`);
    this.name = 'DockerConnectionError';
  }
}

export class ContainerCreateError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly reason: string,
  ) {
    super(`Failed to create container for agent ${agentId}: ${reason}`);
    this.name = 'ContainerCreateError';
  }
}

export class ContainerStartError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly containerId: string,
    public readonly reason: string,
  ) {
    super(
      `Failed to start container ${containerId} for agent ${agentId}: ${reason}`,
    );
    this.name = 'ContainerStartError';
  }
}

export class ImageBuildError extends Error {
  constructor(
    public readonly imageName: string,
    public readonly reason: string,
  ) {
    super(`Failed to build Docker image ${imageName}: ${reason}`);
    this.name = 'ImageBuildError';
  }
}

export class ContainerManager {
  private docker: Docker;

  constructor() {
    this.docker = new Docker();
  }

  /**
   * Launches a container for the given agent configuration.
   * The container runs autonomously -- this method does NOT wait for it to finish.
   */
  async launchAgent(
    agentConfig: AgentConfig,
    dockerImage: string,
    resultsDir: string,
  ): Promise<ContainerInfo> {
    const imageTag = `${dockerImage}:${agentConfig.arm}`;
    const memoryType =
      agentConfig.arm === 'claude-mem' ? 'claude-mem' : 'vanilla';

    const promptFilePath = resolve(agentConfig.prompt.filePath);
    const absoluteResultsDir = resolve(resultsDir);

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer({
        Image: imageTag,
        Env: [
          `ANTHROPIC_API_KEY=${agentConfig.apiKey}`,
          `ANTHROPIC_MODEL=${agentConfig.modelVersion}`,
          `AGENT_ID=${agentConfig.agentId}`,
          `MEMORY_TYPE=${memoryType}`,
        ],
        HostConfig: {
          Binds: [
            `${promptFilePath}:/workspace/prompt.md:ro`,
            `${absoluteResultsDir}:/workspace/results:rw`,
          ],
          NetworkMode: 'bridge',
        },
        Labels: {
          'benchmark.agent-id': agentConfig.agentId,
          'benchmark.arm': agentConfig.arm,
          'benchmark.prompt-id': agentConfig.prompt.frontmatter.id,
        },
      });
    } catch (error) {
      throw new ContainerCreateError(
        agentConfig.agentId,
        error instanceof Error ? error.message : String(error),
      );
    }

    const startTime = new Date();
    try {
      await container.start();
    } catch (error) {
      throw new ContainerStartError(
        agentConfig.agentId,
        container.id,
        error instanceof Error ? error.message : String(error),
      );
    }

    return {
      containerId: container.id,
      agentId: agentConfig.agentId,
      arm: agentConfig.arm,
      promptId: agentConfig.prompt.frontmatter.id,
      startTime,
      status: 'running',
    };
  }

  /**
   * Returns the current status string of a container (e.g., "running", "exited").
   */
  async getContainerStatus(containerId: string): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const inspectData = await container.inspect();
    return inspectData.State.Status;
  }

  /**
   * Stops a running container.
   */
  async stopContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.stop();
  }

  /**
   * Removes a container.
   */
  async removeContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.remove({ force: true });
  }

  /**
   * Builds a Docker image for the given arm (claude-mem or vanilla).
   * Uses the MEMORY_TYPE build arg to conditionally install claude-mem.
   */
  async buildImage(
    dockerfilePath: string,
    imageName: string,
    arm: Arm,
  ): Promise<void> {
    const contextDir = resolve(dockerfilePath, '..');
    const memoryType = arm === 'claude-mem' ? 'claude-mem' : 'vanilla';

    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.docker.buildImage(
        {
          context: contextDir,
          src: ['.'],
        },
        {
          t: `${imageName}:${arm}`,
          buildargs: { MEMORY_TYPE: memoryType },
          dockerfile: 'Dockerfile',
        },
      );
    } catch (error) {
      throw new ImageBuildError(
        `${imageName}:${arm}`,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Follow the build output stream to completion
    await new Promise<void>((resolvePromise, reject) => {
      this.docker.modem.followProgress(
        stream,
        (error: Error | null) => {
          if (error) {
            reject(
              new ImageBuildError(
                `${imageName}:${arm}`,
                error.message,
              ),
            );
          } else {
            resolvePromise();
          }
        },
      );
    });
  }

  /**
   * Checks if a Docker image exists locally.
   */
  async imageExists(imageTag: string): Promise<boolean> {
    try {
      await this.docker.getImage(imageTag).inspect();
      return true;
    } catch {
      return false;
    }
  }
}
