import { logger } from '../../utils/logger.js';

/**
 * Windows Job Object binding for the worker's chroma-mcp child chain
 * (uvx -> uv -> python/chroma-mcp).
 *
 * WHY THIS EXISTS
 * ---------------
 * All existing chroma-mcp cleanup (stop()/reconnect()/onclose tree-kills,
 * issue #2313) is in-process JavaScript: it only runs while the worker is
 * alive and executing that code. When the worker dies ABNORMALLY (crash,
 * taskkill, sleep/wake, port collision) none of it runs. On Windows the
 * orphaned uvx/uv/python chain then survives holding an INHERITED handle to
 * the worker's listen socket (port 37777), which bricks the port for every
 * future worker — netstat shows LISTEN owned by a now-dead PID and no new
 * worker can bind.
 *
 * The fix is a kernel-enforced backstop that needs zero cleanup code: create
 * a Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, keep its ONLY
 * handle inside the worker process, and assign the chroma children into it.
 * When the worker terminates by ANY means the kernel closes that last handle,
 * which trips the kill-on-close limit and terminates every job member — the
 * children AND their descendants — instantly. This is the OS backstop; the
 * in-process tree-kill (#2313) remains the primary, graceful layer.
 *
 * BEST-EFFORT CONTRACT
 * --------------------
 * Every function here is best-effort. On ANY failure (non-win32, non-Bun,
 * bun:ffi unavailable, kernel32 error) the module degrades to a no-op and the
 * caller sees the pre-existing behavior. Nothing here ever throws to callers.
 */

// Guard: this mechanism only exists on Windows, and it depends on bun:ffi to
// reach kernel32. `Bun` is a global under the Bun runtime; under Node it is
// undefined and we stay a no-op.
const IS_SUPPORTED = process.platform === 'win32' && typeof (globalThis as any).Bun !== 'undefined';

// --- Windows constants ---
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectExtendedLimitInformation = 9; // JOBOBJECTINFOCLASS
// x64 sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION). BasicLimitInformation is at
// offset 0; its LimitFlags (DWORD) sits at offset 16.
const JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;

const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_ACCESS = PROCESS_SET_QUOTA | PROCESS_TERMINATE; // 0x0101

const TH32CS_SNAPPROCESS = 0x2;
// x64 sizeof(PROCESSENTRY32W). dwSize MUST be initialized to this before
// Process32FirstW, or the walk fails. th32ProcessID (DWORD) at offset 8,
// th32ParentProcessID (DWORD) at offset 32.
const PROCESSENTRY32W_SIZE = 568;
const PE32_PROCESSID_OFFSET = 8;
const PE32_PARENTID_OFFSET = 32;

const ERROR_ACCESS_DENIED = 5;
const INVALID_HANDLE_VALUE = -1; // CreateToolhelp32Snapshot failure sentinel

interface Kernel32Symbols {
  CreateJobObjectW: (attrs: any, name: any) => number | null;
  SetInformationJobObject: (job: any, cls: number, info: any, len: number) => number;
  OpenProcess: (access: number, inherit: number, pid: number) => number | null;
  AssignProcessToJobObject: (job: any, process: any) => number;
  CloseHandle: (handle: any) => number;
  GetLastError: () => number;
  CreateToolhelp32Snapshot: (flags: number, pid: number) => number | null;
  Process32FirstW: (snapshot: any, entry: any) => number;
  Process32NextW: (snapshot: any, entry: any) => number;
}

// Module-level state. The job handle is INTENTIONALLY held for the entire
// lifetime of the worker process and NEVER closed (except by the test reset
// hook). Closing it is the kill trigger — the kernel closing it at process
// death is exactly what we want.
let initialized = false;
let initFailed = false; // one-time failure latch: never retry, never re-warn
let jobHandle: number | null = null;
let k32: Kernel32Symbols | null = null;
let ptrFn: ((buf: ArrayBufferView | ArrayBuffer) => number | bigint) | null = null;
const assignedPids = new Set<number>();

/**
 * Lazy, one-time init. Loads bun:ffi + kernel32, creates the Job Object and
 * sets its kill-on-close limit. On any failure it latches (logs ONE warn) and
 * every future call is a no-op. Returns true only when the job is live.
 */
function ensureInitialized(): boolean {
  if (initialized) return jobHandle !== null;
  if (initFailed) return false;
  if (!IS_SUPPORTED) {
    // Not an error: non-Windows or non-Bun runtime. Latch silently.
    initFailed = true;
    return false;
  }

  try {
    // Plain literal require so the build externalizes 'bun:ffi' (it is added to
    // every esbuild external[] alongside 'bun:sqlite'). A dynamic/computed
    // specifier would defeat that and could get bundled for a Node target.
    const ffi = require('bun:ffi');
    const { dlopen, FFIType, ptr } = ffi;

    const lib = dlopen('kernel32.dll', {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
      CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
      Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });

    k32 = lib.symbols as unknown as Kernel32Symbols;
    ptrFn = ptr;

    // CreateJobObjectW(null, null): anonymous, unnamed job.
    const handle = k32.CreateJobObjectW(null, null);
    if (!handle) {
      const err = safeLastError();
      throw new Error(`CreateJobObjectW failed (GetLastError=${err})`);
    }

    // Zeroed 144-byte JOBOBJECT_EXTENDED_LIMIT_INFORMATION with LimitFlags =
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE written little-endian at offset 16.
    const info = new Uint8Array(JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE);
    new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);

    const ok = k32.SetInformationJobObject(
      handle,
      JobObjectExtendedLimitInformation,
      toPtr(info),
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE,
    );
    if (!ok) {
      const err = safeLastError();
      k32.CloseHandle(handle);
      throw new Error(`SetInformationJobObject failed (GetLastError=${err})`);
    }

    jobHandle = handle as unknown as number;
    initialized = true;
    logger.info('WORKER', 'Windows Job Object armed (kill-on-close) for chroma-mcp child chain');
    return true;
  } catch (error: unknown) {
    initFailed = true;
    jobHandle = null;
    k32 = null;
    ptrFn = null;
    // ONE warn, never retry. Best-effort: the in-process tree-kill (#2313) still
    // runs; we merely lose the OS backstop against abnormal worker death.
    logger.warn(
      'WORKER',
      'Windows Job Object unavailable; chroma-mcp orphan backstop disabled (best-effort, non-fatal)',
      undefined,
      error instanceof Error ? error : new Error(String(error)),
    );
    return false;
  }
}

function toPtr(buf: Uint8Array): any {
  return ptrFn ? ptrFn(buf) : null;
}

function safeLastError(): number {
  try {
    return k32 ? k32.GetLastError() : -1;
  } catch {
    return -1;
  }
}

/**
 * True when the worker Job Object is live and assignments can succeed.
 * Triggers lazy init on first call.
 */
export function isWorkerJobObjectAvailable(): boolean {
  return ensureInitialized();
}

/**
 * Assign a single PID into the worker Job Object so the kernel kills it when
 * the worker dies. Deduped via a module-level Set. Best-effort: returns false
 * on any failure without throwing.
 */
export function assignPidToWorkerJob(pid: number, label: string): boolean {
  if (!ensureInitialized() || !k32 || jobHandle === null) return false;

  try {
    if (!pid || pid <= 0) return false;
    if (assignedPids.has(pid)) return true;

    const procHandle = k32.OpenProcess(PROCESS_ACCESS, 0, pid);
    if (!procHandle) {
      // Process already gone, or access denied. Non-fatal.
      logger.debug('WORKER', 'Job Object OpenProcess failed', undefined, {
        pid,
        label,
        lastError: safeLastError(),
      });
      return false;
    }

    try {
      const ok = k32.AssignProcessToJobObject(jobHandle, procHandle);
      if (!ok) {
        const err = safeLastError();
        // ERROR_ACCESS_DENIED (5) here usually means the PID is already in this
        // job, or is in an incompatible job on pre-Win8 (nested jobs unsupported).
        // Either way it is non-fatal for our best-effort backstop.
        logger.debug('WORKER', 'Job Object AssignProcessToJobObject failed', undefined, {
          pid,
          label,
          lastError: err,
          note: err === ERROR_ACCESS_DENIED ? 'likely already-in-job / incompatible-job (non-fatal)' : undefined,
        });
        return false;
      }
      assignedPids.add(pid);
      return true;
    } finally {
      // Always release the process handle — the job holds its own reference to
      // the process, so this handle is only needed for the assign call.
      k32.CloseHandle(procHandle);
    }
  } catch (error: unknown) {
    logger.debug(
      'WORKER',
      'Job Object assignPidToWorkerJob threw unexpectedly (best-effort, non-fatal)',
      undefined,
      { pid, label, error: error instanceof Error ? error.message : String(error) },
    );
    return false;
  }
}

/**
 * Assign a root PID AND its entire current descendant tree into the worker Job
 * Object. Required at chroma-mcp connect time because job membership is only
 * inherited by processes spawned AFTER their parent joined the job — uvx's
 * uv/python descendants already exist by connect time, so a single-PID assign
 * of the root would miss them.
 *
 * Walks a one-shot process snapshot, builds a parent->children multimap, then
 * BFS from rootPid assigning root first then descendants.
 *
 * Note on PID reuse: a stale parent PID could theoretically map an unrelated
 * process into the tree. Acceptable for this best-effort sweep taken
 * milliseconds after spawn, when reuse is vanishingly unlikely.
 *
 * Returns { assigned } with the successfully assigned PIDs, or null when the
 * job is unavailable/latched.
 */
export function assignProcessTreeToWorkerJob(rootPid: number, label: string): { assigned: number[] } | null {
  if (!ensureInitialized() || !k32 || ptrFn === null) return null;

  try {
    if (!rootPid || rootPid <= 0) return null;

    const childrenByParent = new Map<number, number[]>();

    const snapshot = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    // CreateToolhelp32Snapshot returns INVALID_HANDLE_VALUE (-1), not null, on
    // failure; guard both.
    if (!snapshot || snapshot === INVALID_HANDLE_VALUE) {
      logger.debug('WORKER', 'Job Object CreateToolhelp32Snapshot failed', undefined, {
        rootPid,
        label,
        lastError: safeLastError(),
      });
      return null;
    }

    try {
      const entry = new Uint8Array(PROCESSENTRY32W_SIZE);
      const view = new DataView(entry.buffer);
      // dwSize MUST be set before Process32FirstW or the walk returns 0.
      view.setUint32(0, PROCESSENTRY32W_SIZE, true);
      const entryPtr = toPtr(entry);

      let more = k32.Process32FirstW(snapshot, entryPtr);
      while (more) {
        const procId = view.getUint32(PE32_PROCESSID_OFFSET, true);
        const parentId = view.getUint32(PE32_PARENTID_OFFSET, true);
        let list = childrenByParent.get(parentId);
        if (!list) {
          list = [];
          childrenByParent.set(parentId, list);
        }
        list.push(procId);
        more = k32.Process32NextW(snapshot, entryPtr);
      }
    } finally {
      k32.CloseHandle(snapshot);
    }

    // BFS from the root, assigning root first then each descendant.
    const assigned: number[] = [];
    const visited = new Set<number>();
    const queue: number[] = [rootPid];
    while (queue.length > 0) {
      const pid = queue.shift() as number;
      if (visited.has(pid)) continue;
      visited.add(pid);

      if (assignPidToWorkerJob(pid, label)) {
        assigned.push(pid);
      }

      const children = childrenByParent.get(pid);
      if (children) {
        for (const child of children) {
          if (!visited.has(child)) queue.push(child);
        }
      }
    }

    return { assigned };
  } catch (error: unknown) {
    logger.debug(
      'WORKER',
      'Job Object assignProcessTreeToWorkerJob threw unexpectedly (best-effort, non-fatal)',
      undefined,
      { rootPid, label, error: error instanceof Error ? error.message : String(error) },
    );
    return null;
  }
}

/**
 * Test-only reset: closes the job handle (which, given kill-on-close, also
 * terminates every assigned member) and clears all module state/latches so a
 * subsequent call re-initializes from scratch. Not for production use.
 */
export function __resetWorkerJobObjectForTesting(): void {
  try {
    if (k32 && jobHandle !== null) {
      k32.CloseHandle(jobHandle);
    }
  } catch {
    // best-effort
  }
  jobHandle = null;
  k32 = null;
  ptrFn = null;
  initialized = false;
  initFailed = false;
  assignedPids.clear();
}
