import { Readable } from 'stream';

const realStdin = process.stdin;
const realStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

export function installFakeStdin(payload: string): void {
  const fake = Readable.from([payload], { objectMode: false }) as unknown as NodeJS.ReadStream;
  Object.defineProperty(fake, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: realStdinDescriptor?.enumerable ?? true,
    writable: true,
    value: fake,
  });
}

export function restoreStdin(): void {
  if (realStdinDescriptor) {
    Object.defineProperty(process, 'stdin', realStdinDescriptor);
  } else {
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true, writable: true });
  }
}
