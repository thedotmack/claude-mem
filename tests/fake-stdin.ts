import { PassThrough, Readable } from 'stream';

const realStdin = process.stdin;
const realStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
let activeFake: NodeJS.ReadStream | null = null;

export function installFakeStdin(payload: string): void {
  const fake = Readable.from([payload], { objectMode: false }) as unknown as NodeJS.ReadStream;
  activeFake = fake;
  Object.defineProperty(fake, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: realStdinDescriptor?.enumerable ?? true,
    writable: true,
    value: fake,
  });
}

export function installOpenFakeStdin(payload: string): void {
  const fake = new PassThrough() as unknown as NodeJS.ReadStream & { write(chunk: string): boolean };
  Object.defineProperty(fake, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: realStdinDescriptor?.enumerable ?? true,
    writable: true,
    value: fake,
  });
  activeFake = fake;
  fake.write(payload);
}

export function restoreStdin(): void {
  activeFake?.destroy?.();
  activeFake = null;
  if (realStdinDescriptor) {
    Object.defineProperty(process, 'stdin', realStdinDescriptor);
  } else {
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true, writable: true });
  }
}
