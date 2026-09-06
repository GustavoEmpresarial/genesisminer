/**
 * Estado de ciclo de vida do processo (startup → ready → shutting_down).
 * Usado por readiness, job runner e graceful shutdown.
 */

export type AppLifecyclePhase = 'starting' | 'ready' | 'shutting_down';

let phase: AppLifecyclePhase = 'starting';
let activeHttpRequests = 0;
let activeJobs = 0;
let shutdownPromise: Promise<void> | null = null;
/** Controllers dos jobs em execução — abort cooperativo no shutdown. */
const activeJobControllers = new Set<AbortController>();

export function getLifecyclePhase(): AppLifecyclePhase {
  return phase;
}

export function markAppStarting(): void {
  if (phase === 'shutting_down') return;
  phase = 'starting';
}

export function markAppReady(): void {
  if (phase === 'shutting_down') return;
  phase = 'ready';
}

export function markAppShuttingDown(): void {
  phase = 'shutting_down';
}

export function isAppReady(): boolean {
  return phase === 'ready';
}

export function isShuttingDown(): boolean {
  return phase === 'shutting_down';
}

export function beginHttpRequest(): void {
  activeHttpRequests += 1;
}

export function endHttpRequest(): void {
  activeHttpRequests = Math.max(0, activeHttpRequests - 1);
}

export function getActiveHttpRequestCount(): number {
  return activeHttpRequests;
}

export function beginJob(): void {
  activeJobs += 1;
}

export function endJob(): void {
  activeJobs = Math.max(0, activeJobs - 1);
}

export function getActiveJobCount(): number {
  return activeJobs;
}

export function registerJobAbortController(controller: AbortController): void {
  activeJobControllers.add(controller);
}

export function unregisterJobAbortController(controller: AbortController): void {
  activeJobControllers.delete(controller);
}

/** Solicita abort cooperativo a todos os jobs activos (shutdown / drain). */
export function abortAllActiveJobs(reason: string = 'shutdown'): number {
  let n = 0;
  for (const c of activeJobControllers) {
    if (!c.signal.aborted) {
      try {
        c.abort(reason);
        n += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return n;
}

export function getOrCreateShutdownPromise(factory: () => Promise<void>): Promise<void> {
  if (!shutdownPromise) {
    shutdownPromise = factory().catch((e) => {
      // Keep promise settled so retries don't re-run factory twice incorrectly —
      // callers awaiting the same promise get the rejection.
      throw e;
    });
  }
  return shutdownPromise;
}

export function hasShutdownStarted(): boolean {
  return shutdownPromise != null;
}

/** Testes. */
export function resetLifecycleForTests(): void {
  phase = 'starting';
  activeHttpRequests = 0;
  activeJobs = 0;
  shutdownPromise = null;
  activeJobControllers.clear();
}
