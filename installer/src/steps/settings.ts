import * as p from '@clack/prompts';
import pc from 'picocolors';

export interface SettingsConfig {
  workerPort: string;
  dataDir: string;
  contextObservations: string;
  logLevel: string;
  pythonVersion: string;
  chromaEnabled: boolean;
  chromaMode?: 'local' | 'remote';
  chromaHost?: string;
  chromaPort?: string;
  chromaSsl?: boolean;
}

export async function runSettingsConfiguration(): Promise<SettingsConfig> {
  const useDefaults = await p.confirm({
    message: 'Use default settings? (recommended for most users)',
    initialValue: true,
  });

  if (p.isCancel(useDefaults)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  if (useDefaults) {
    return {
      workerPort: '37777',
      dataDir: '~/.claude-mem',
      contextObservations: '50',
      logLevel: 'INFO',
      pythonVersion: '3.13',
      chromaEnabled: true,
      chromaMode: 'local',
    };
  }

  // Custom settings
  const workerPort = await p.text({
    message: 'Worker service port:',
    defaultValue: '37777',
    placeholder: '37777',
    validate: (value = '') => {
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return 'Port must be between 1024 and 65535';
      }
    },
  });
  if (p.isCancel(workerPort)) { p.cancel('Installation cancelled.'); process.exit(0); }

  const dataDir = await p.text({
    message: 'Data directory:',
    defaultValue: '~/.claude-mem',
    placeholder: '~/.claude-mem',
  });
  if (p.isCancel(dataDir)) { p.cancel('Installation cancelled.'); process.exit(0); }

  const contextObservations = await p.text({
    message: 'Number of context observations per session:',
    defaultValue: '50',
    placeholder: '50',
    validate: (value = '') => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 1 || num > 200) {
        return 'Must be between 1 and 200';
      }
    },
  });
  if (p.isCancel(contextObservations)) { p.cancel('Installation cancelled.'); process.exit(0); }

  const logLevel = await p.select({
    message: 'Log level:',
    options: [
      { value: 'DEBUG', label: 'DEBUG', hint: 'verbose' },
      { value: 'INFO', label: 'INFO', hint: 'default' },
      { value: 'WARN', label: 'WARN' },
      { value: 'ERROR', label: 'ERROR', hint: 'errors only' },
    ],
    initialValue: 'INFO',
  });
  if (p.isCancel(logLevel)) { p.cancel('Installation cancelled.'); process.exit(0); }

  const pythonVersion = await p.text({
    message: 'Python version (for Chroma):',
    defaultValue: '3.13',
    placeholder: '3.13',
  });
  if (p.isCancel(pythonVersion)) { p.cancel('Installation cancelled.'); process.exit(0); }

  const chromaEnabled = await p.confirm({
    message: 'Enable Chroma vector search?',
    initialValue: true,
  });
  if (p.isCancel(chromaEnabled)) { p.cancel('Installation cancelled.'); process.exit(0); }

  let chromaMode: 'local' | 'remote' | undefined;
  let chromaHost: string | undefined;
  let chromaPort: string | undefined;
  let chromaSsl: boolean | undefined;

  if (chromaEnabled) {
    const mode = await p.select({
      message: 'Chroma mode:',
      options: [
        { value: 'local' as const, label: 'Local', hint: 'starts local Chroma server' },
        { value: 'remote' as const, label: 'Remote', hint: 'connect to existing server' },
      ],
    });
    if (p.isCancel(mode)) { p.cancel('Installation cancelled.'); process.exit(0); }
    chromaMode = mode;

    if (mode === 'remote') {
      const host = await p.text({
        message: 'Chroma host:',
        defaultValue: '127.0.0.1',
        placeholder: '127.0.0.1',
      });
      if (p.isCancel(host)) { p.cancel('Installation cancelled.'); process.exit(0); }
      chromaHost = host;

      const port = await p.text({
        message: 'Chroma port:',
        defaultValue: '8000',
        placeholder: '8000',
        validate: (value = '') => {
          const portNum = parseInt(value, 10);
          if (isNaN(portNum) || portNum < 1 || portNum > 65535) return 'Port must be between 1 and 65535';
        },
      });
      if (p.isCancel(port)) { p.cancel('Installation cancelled.'); process.exit(0); }
      chromaPort = port;

      const ssl = await p.confirm({
        message: 'Use SSL for Chroma connection?',
        initialValue: false,
      });
      if (p.isCancel(ssl)) { p.cancel('Installation cancelled.'); process.exit(0); }
      chromaSsl = ssl;
    }
  }

  const config: SettingsConfig = {
    workerPort,
    dataDir,
    contextObservations,
    logLevel,
    pythonVersion,
    chromaEnabled,
    chromaMode,
    chromaHost,
    chromaPort,
    chromaSsl,
  };

  // Show summary
  const summaryLines = [
    `Worker port: ${pc.cyan(workerPort)}`,
    `Data directory: ${pc.cyan(dataDir)}`,
    `Context observations: ${pc.cyan(contextObservations)}`,
    `Log level: ${pc.cyan(logLevel)}`,
    `Python version: ${pc.cyan(pythonVersion)}`,
    `Chroma: ${chromaEnabled ? pc.green('enabled') : pc.dim('disabled')}`,
  ];
  if (chromaEnabled && chromaMode) {
    summaryLines.push(`Chroma mode: ${pc.cyan(chromaMode)}`);
  }

  p.note(summaryLines.join('\n'), 'Settings Summary');

  return config;
}
