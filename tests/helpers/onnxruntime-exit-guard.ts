/**
 * Stops `bun test` from crashing on macOS after a run that loaded the
 * embedding model ("panic: A C++ exception occurred", Abort trap: 6, exit 134).
 *
 * What happens:
 *   - onnxruntime-node keeps its runtime in two static smart pointers,
 *     OrtInstanceData::ortEnv and OrtInstanceData::ortDefaultRunOptions. Its
 *     N-API instance-data finalizer releases both when the JS environment ends.
 *   - `bun test` (and `process.exit`) end the process without running N-API
 *     finalizers. On Linux, Bun then leaves through quick_exit, which runs no
 *     C++ static destructors, so nothing happens. On macOS it leaves through
 *     exit(), whose static destructors free ONNX Runtime's own globals first and
 *     then the binding's ortEnv, whose release locks a mutex that is already
 *     gone. That is microsoft/onnxruntime#24579; 1.23.2, pinned for Intel Macs,
 *     still has it.
 *
 * The fix: once every test has finished, set both pointers to null. Their
 * destructors then have nothing to free, the run exits with the code Bun
 * chose, and the runtime is reclaimed with the process. Nothing is loaded
 * here: when the binding is not already in the process, this does nothing.
 */
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { realpathSync } from 'fs';

/**
 * released: the runtime was live and both pointers are now null.
 * idle: the binding is loaded but no session ever started the runtime.
 * not-loaded: onnxruntime-node's binding is not in this process.
 * unsupported: no way to reach the pointers here (Windows, Node, another build).
 */
export type OnnxRuntimeExitGuardResult = 'released' | 'idle' | 'not-loaded' | 'unsupported';

const STATIC_POINTERS = [
  '_ZN15OrtInstanceData20ortDefaultRunOptionsE',
  '_ZN15OrtInstanceData6ortEnvE',
];

/** Where onnxruntime-node loads its binding from (see its dist/binding.js). */
export function onnxRuntimeBindingPath(fromDir = process.cwd()): string | null {
  try {
    const entry = createRequire(join(fromDir, 'package.json')).resolve('onnxruntime-node');
    return join(dirname(entry), '..', 'bin', 'napi-v6', process.platform, process.arch, 'onnxruntime_binding.node');
  } catch {
    return null;
  }
}

export function releaseOnnxRuntimeForExit(bindingPath = onnxRuntimeBindingPath()): OnnxRuntimeExitGuardResult {
  if (!bindingPath || (process.platform !== 'darwin' && process.platform !== 'linux')) return 'unsupported';
  if (typeof Bun === 'undefined') return 'unsupported';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dlopen, FFIType, toArrayBuffer } = require('bun:ffi') as typeof import('bun:ffi');
  const isMac = process.platform === 'darwin';
  // RTLD_NOLOAD returns the binding only if it is already loaded, so a run
  // that never touched the model never loads it here.
  const RTLD_LAZY = 0x1;
  const RTLD_NOLOAD = isMac ? 0x10 : 0x4;
  const symbols = {
    dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    dlclose: { args: [FFIType.ptr], returns: FFIType.i32 },
  } as const;
  let libdl;
  try {
    libdl = dlopen(isMac ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', symbols);
  } catch {
    try {
      libdl = dlopen('libdl.so.2', symbols);
    } catch {
      return 'unsupported';
    }
  }
  try {
    let realPath = bindingPath;
    try {
      realPath = realpathSync(bindingPath);
    } catch {
      return 'not-loaded';
    }
    const handle = [bindingPath, realPath]
      .map(path => libdl.symbols.dlopen(Buffer.from(`${path}\0`), RTLD_LAZY | RTLD_NOLOAD))
      .find(Boolean);
    if (!handle) return 'not-loaded';
    try {
      const pointers = STATIC_POINTERS.map(name => libdl.symbols.dlsym(handle, Buffer.from(`${name}\0`)));
      if (pointers.some(pointer => !pointer)) return 'unsupported';
      const cells = pointers.map(pointer => new BigUint64Array(toArrayBuffer(pointer!, 0, 8)));
      if (cells.every(cell => cell[0] === 0n)) return 'idle';
      for (const cell of cells) cell[0] = 0n;
      return 'released';
    } finally {
      // Drops only the reference RTLD_NOLOAD added; the binding stays loaded.
      libdl.symbols.dlclose(handle);
    }
  } finally {
    libdl.close();
  }
}
