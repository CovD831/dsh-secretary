/** 构造受会话沙箱约束的命令执行器（支持重定根到只读探针临时目录并阻断 sandbox.denied）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ExecuteVerifyRerunOptions } from '../judgement/gates/verify-rerun.ts'

export function buildSessionSandboxRunner(
  context: Context,
  session: unknown,
  primaryWorkdir?: string,
): NonNullable<ExecuteVerifyRerunOptions['runCommand']> {
  return async (command, cwd, opts) => {
    const shell = context.get('shell' as never) as {
      resolve(req: Record<string, unknown>): unknown
      execute(spec: unknown): Promise<{
        result(): Promise<{
          exitCode: number | null; timedOut: boolean; aborted: boolean
          stdout: { text: string }; stderr: { text: string }
          sandbox?: { mode: string; denied: boolean; runnerFailed?: boolean }
        }>
      }>
    } | undefined
    const sandboxPolicySvc = context.get('sandboxPolicy' as never) as {
      resolve(req?: { session?: unknown }): { mode: string; workspaceRoot: string; additionalWritableRoots?: readonly string[]; sessionId?: string }
    } | undefined
    if (!shell || !sandboxPolicySvc || !session) return { exitCode: null, noSandbox: true }
    try {
      const base = sandboxPolicySvc.resolve({ session })
      const isProbeDir = primaryWorkdir !== undefined && cwd !== '' && cwd !== primaryWorkdir
      const sandboxPolicy = isProbeDir
        ? { ...base, mode: 'workspace-write', workspaceRoot: cwd }
        : (base.mode === 'danger-full-access' ? { ...base, mode: 'workspace-write' } : base)
      const spec = shell.resolve({
        command, workdir: cwd, timeoutMs: opts.timeoutMs, onExpiry: 'kill', stdoutMaxBytes: 4 * 1024 * 1024,
        ...(opts.signal ? { signal: opts.signal } : {}), sandboxPolicy,
      })
      const res = await (await shell.execute(spec)).result()
      if (!res.sandbox || res.sandbox.runnerFailed) return { exitCode: null, noSandbox: true }
      if (res.sandbox.denied) {
        return { exitCode: res.exitCode, sandboxDenied: true, stdout: res.stdout.text, stderr: res.stderr.text }
      }
      return { exitCode: res.exitCode, timedOut: res.timedOut, aborted: res.aborted, stdout: res.stdout.text, stderr: res.stderr.text }
    } catch {
      if (opts.signal?.aborted) return { exitCode: null, aborted: true }
      return { exitCode: null, noSandbox: true }
    }
  }
}