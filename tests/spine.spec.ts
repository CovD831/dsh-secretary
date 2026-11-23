import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import {
  REDACTED, createGitShardSink, createSpineAppender, createSpineFlusher,
  ensureSpineSchema, joinTaint, pickShard, redactValue,
  type SpineDraft, type SpineEnvelope,
} from '../src/spine/index.ts'

let dir: string
let store: Store

const draft = <P>(id: string, payload: P, extra: Partial<SpineDraft<P>> = {}): SpineDraft<P> => ({
  id,
  stream: 'ticket:t1',
  type: 'ticket.accepted',
  source: { kind: 'system', ref: 'unit-test' },
  evidence: [],
  taint: 'trusted',
  payload,
  ...extra,
})

const readAllShards = (gitDir: string): SpineEnvelope[] => {
  const m0 = join(gitDir, 'm0')
  if (!existsSync(m0)) return []
  return readdirSync(m0).filter(n => n.endsWith('.jsonl')).sort().flatMap(name => {
    const raw = readFileSync(join(m0, name), 'utf8')
    if (!raw) return []
    expect(raw.endsWith('\n')).toBe(true)
    return raw.slice(0, -1).split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as SpineEnvelope)
  })
}

const assertContiguousSeqs = (events: SpineEnvelope[], expectedCount: number): void => {
  expect(events).toHaveLength(expectedCount)
  expect(events.map(e => e.seq)).toEqual(Array.from({ length: expectedCount }, (_, i) => i + 1))
  expect(new Set(events.map(e => e.id)).size).toBe(expectedCount)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-spine-test-'))
  store = new Store(join(dir, 'orchestrator.sqlite'))
  ensureSpineSchema(store.db)
})

afterEach(() => {
  try { store.close() } catch { /* 已在测试内关闭 */ }
  rmSync(dir, { recursive: true, force: true })
})

it('前置脱敏：密钥绝不落入 SQLite event_spine 或 Git 分片，redacted 路径准确且保留非敏感计数', async () => {
  const gitDir = join(dir, 'memory-git')
  const sink = createGitShardSink({ dir: gitDir })
  const flusher = createSpineFlusher(store.db, sink)
  const appender = createSpineAppender(store, { kick: () => {} })

  const secrets = [
    'sk-proj-abc1234567890SECRETKEY',
    'jwt-secret-bearer-token-999',
    'ghp_1234567890abcdef1234567890abcdef1234',
    'github_pat_11ABCDEFG_0123456789abcdef12345',
    'feishu_super_secret_val',
    'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBK',
    'https://open.feishu.cn/open-apis/bot/v2/hook/hook-secret-xyz',
  ]
  const ref = appender.append(draft('ev-sec-1', {
    apiKey: secrets[0],
    headers: { authorization: 'auth-val-123', cookie: 'ck-val', 'Set-Cookie': 'sc-val' },
    nested: {
      password: 'db-pass-value',
      feishuSecret: secrets[4],
      token: 'tok-abc-123',
      pem: `-----BEGIN PRIVATE KEY-----\n${secrets[5]}\n-----END PRIVATE KEY-----`,
    },
    logs: [
      `Authorization: Bearer ${secrets[1]}`,
      `pat=${secrets[2]} fine=${secrets[3]}`,
      `FEISHU_SECRET=inline_fsec webhook=${secrets[6]}`,
      'url=https://x.test/cb?token=qtok123&ok=1',
      'feishuSecret=camel1 clientSecret="camel2" botToken=t123456 {"feishuSecret":"v1"}',
      'x-api-key: mysecret123 password: 12345 Set-Cookie: sid_abc=1; HttpOnly tokenCount=10',
    ],
    myAPIKey: 'acronym-secret-123',
    usage: { input_tokens: 120, tokenCount: 5, hasToken: true },
    safe: 'keep-me',
  }, {
    source: { kind: 'worker', ref: 'https://bot:pass999@example.com/repo' },
  }))

  const rawRow = store.db.prepare('SELECT value FROM event_spine WHERE seq = ?').get(ref.seq) as { value: string }
  for (const s of [...secrets.slice(0, 6), 'hook-secret-xyz', 'auth-val-123', 'db-pass-value', 'tok-abc-123', 'inline_fsec', 'pass999', 'qtok123', 'acronym-secret-123', 'camel1', 'camel2', 't123456', '"v1"', 'mysecret123', '12345', 'sid_abc=1', 'ck-val', 'sc-val']) {
    expect(rawRow.value).not.toContain(s)
  }
  const dbEnv = JSON.parse(rawRow.value) as SpineEnvelope<Record<string, unknown>>
  expect(dbEnv.redacted).toEqual([
    'source.ref',
    'payload.apiKey',
    'payload.headers.authorization',
    'payload.headers.cookie',
    'payload.headers.Set-Cookie',
    'payload.nested.password',
    'payload.nested.feishuSecret',
    'payload.nested.token',
    'payload.nested.pem',
    'payload.logs[0]',
    'payload.logs[1]',
    'payload.logs[2]',
    'payload.logs[3]',
    'payload.logs[4]',
    'payload.logs[5]',
    'payload.myAPIKey',
  ])
  expect((dbEnv.payload.logs as string[])[3]).toBe('url=https://x.test/cb?token=[REDACTED]&ok=1')
  expect((dbEnv.payload.logs as string[])[5]).toContain('tokenCount=10')
  expect(dbEnv.payload.usage).toEqual({ input_tokens: 120, tokenCount: 5, hasToken: true })
  expect(dbEnv.payload.safe).toBe('keep-me')
  expect(redactValue({ apiKey: 'sk-1234567890abcdef1234' }).value.apiKey).toBe(REDACTED)

  const report = await flusher.flush()
  expect(report.commit).toBeTruthy()
  const shardText = readFileSync(join(gitDir, report.shard!), 'utf8')
  for (const s of [...secrets.slice(0, 6), 'hook-secret-xyz', 'inline_fsec', 'pass999', 'camel1', 'mysecret123', 'sid_abc=1']) {
    expect(shardText).not.toContain(s)
  }
  expect(shardText).toContain(REDACTED)
})

it('id 幂等去重与 store.atomic 抛错回滚：回滚后 SQLite 与 Git 分片均零残留', async () => {
  const gitDir = join(dir, 'memory-git')
  const sink = createGitShardSink({ dir: gitDir })
  const flusher = createSpineFlusher(store.db, sink)
  const kickSpy = vi.spyOn(flusher, 'kick')
  const appender = createSpineAppender(store, flusher)

  expect(() => store.atomic(() => {
    appender.append(draft('ev-rollback', { ok: false }))
    throw new Error('simulated tx failure')
  })).toThrow('simulated tx failure')
  await Promise.resolve()

  expect(store.db.prepare('SELECT COUNT(*) AS c FROM event_spine').get()).toEqual({ c: 0 })
  expect(kickSpy).not.toHaveBeenCalled()
  expect(readAllShards(gitDir)).toHaveLength(0)
  expect(existsSync(join(gitDir, '.git'))).toBe(false)

  const r1 = appender.append(draft('ev-dup-1', { step: 1 }))
  const r2 = appender.append(draft('ev-dup-1', { step: 2 }))
  expect(r2).toEqual(r1)
  expect(store.db.prepare('SELECT COUNT(*) AS c FROM event_spine').get()).toEqual({ c: 1 })
  await flusher.flush()
  const events = readAllShards(gitDir)
  expect(events).toHaveLength(1)
  expect(events[0]!.payload).toEqual({ step: 1 })
})

it('崩溃恢复①：分片末尾残留 UTF-8 半行残骸（无换行）后 recover() 精确截断并续写无重复无缺失', async () => {
  const gitDir = join(dir, 'memory-git')
  const sink = createGitShardSink({ dir: gitDir })
  const flusher = createSpineFlusher(store.db, sink)
  const appender = createSpineAppender(store, { kick: () => {} })

  appender.append(draft('e1', { n: 1 }))
  appender.append(draft('e2', { n: 2 }))
  const first = await flusher.flush()
  expect(first.to).toBe(2)

  appender.append(draft('e3', { n: 3 }))
  appender.append(draft('e4', { n: 4 }))
  // 模拟 append 写入半行含中文 UTF-8 数据后进程崩溃（无结尾 \n）
  const tornBytes = '{"v":1,"seq":3,"id":"e3","payload":"中断残骸'
  appendFileSync(join(gitDir, first.shard!), tornBytes, 'utf8')
  expect((await sink.latest())?.torn).toBe(true)

  const recovered = await flusher.recover()
  expect(recovered.truncated).toBe(Buffer.byteLength(tornBytes, 'utf8'))
  expect(recovered.from).toBe(3)
  expect(recovered.to).toBe(4)
  expect(recovered.commit).toBeTruthy()
  expect(store.db.prepare('SELECT COUNT(*) AS c FROM event_spine').get()).toEqual({ c: 0 })
  assertContiguousSeqs(readAllShards(gitDir), 4)
})

it('崩溃恢复②：append+fsync 成功但 git commit 失败抛错，event_spine 保留且 recover() 重试不写重行', async () => {
  const gitDir = join(dir, 'memory-git')
  const sink = createGitShardSink({ dir: gitDir })
  const flusher = createSpineFlusher(store.db, sink)
  const appender = createSpineAppender(store, { kick: () => {} })

  appender.append(draft('c1', { n: 1 }))
  appender.append(draft('c2', { n: 2 }))
  const commitSpy = vi.spyOn(sink, 'commit').mockRejectedValueOnce(new Error('git index lock failed'))

  await expect(flusher.flush()).rejects.toThrow('git index lock failed')
  expect(commitSpy).toHaveBeenCalledTimes(1)
  // append 已落盘但 commit 失败，缓冲行严禁提前删除
  expect(store.db.prepare('SELECT COUNT(*) AS c FROM event_spine').get()).toEqual({ c: 2 })
  expect(readAllShards(gitDir)).toHaveLength(2)

  const retry = await flusher.recover()
  expect(retry.from).toBe(1)
  expect(retry.to).toBe(2)
  expect(retry.commit).toMatch(/^[0-9a-f]{40}$/)
  expect(store.db.prepare('SELECT COUNT(*) AS c FROM event_spine').get()).toEqual({ c: 0 })
  assertContiguousSeqs(readAllShards(gitDir), 2)
})

it('崩溃恢复③：删掉整个 SQLite 文件重建后，基于 git tailSeq 抬升 sqlite_sequence 续写严格递增', async () => {
  const dbPath = join(dir, 'orchestrator.sqlite')
  const gitDir = join(dir, 'memory-git')
  const sink1 = createGitShardSink({ dir: gitDir })
  const flusher1 = createSpineFlusher(store.db, sink1)
  const appender1 = createSpineAppender(store, { kick: () => {} })

  appender1.append(draft('d1', { n: 1 }))
  appender1.append(draft('d2', { n: 2 }))
  appender1.append(draft('d3', { n: 3 }))
  await flusher1.flush()
  store.close()

  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })

  const sink2 = createGitShardSink({ dir: gitDir })
  const head = await sink2.latest()
  expect(head?.tail).toEqual({ seq: 3, id: 'd3' })

  store = new Store(dbPath)
  ensureSpineSchema(store.db, head?.tail?.seq)
  const flusher2 = createSpineFlusher(store.db, sink2)
  const appender2 = createSpineAppender(store, { kick: () => {} })

  const r4 = appender2.append(draft('d4', { n: 4 }))
  const r5 = appender2.append(draft('d5', { n: 5 }))
  expect(r4).toEqual({ seq: 4, id: 'd4' })
  expect(r5).toEqual({ seq: 5, id: 'd5' })
  await flusher2.recover()

  assertContiguousSeqs(readAllShards(gitDir), 5)
})

it('分片时钟回拨保护、单飞合并、GitRepoLock 互斥提交与 joinTaint 单调性', async () => {
  expect(joinTaint('trusted', 'derived')).toBe('derived')
  expect(joinTaint('derived', 'untrusted')).toBe('untrusted')
  expect(pickShard('m0/2026-12-05.jsonl', new Date('2026-11-24T01:00:00Z'))).toBe('m0/2026-12-05.jsonl')

  const gitDir = join(dir, 'memory-git')
  const sink = createGitShardSink({ dir: gitDir })
  let clock = new Date('2026-12-05T10:00:00Z')
  const flusher = createSpineFlusher(store.db, sink, { now: () => clock })
  const appender = createSpineAppender(store, flusher)

  appender.append(draft('t1', { n: 1 }))
  const r1 = await flusher.flush()
  expect(r1.shard).toBe('m0/2026-12-05.jsonl')

  // 时钟回拨到更早日期时，大 seq 必须继续落在最新已有分片
  clock = new Date('2026-11-24T10:00:00Z')
  appender.append(draft('t2', { n: 2 }))
  appender.append(draft('t3', { n: 3 }))
  const [fA, fB] = await Promise.all([flusher.flush(), flusher.flush()])
  expect(fA.shard).toBe('m0/2026-12-05.jsonl')
  expect(fB.to).toBe(0)

  // GitRepoLock 与 M1-M6 同仓并发提交不撞 .git/index.lock
  await sink.init()
  const results = await Promise.all([
    sink.lock.run(async () => {
      appendFileSync(join(gitDir, 'm1-note.md'), 'entity page\n')
      execFileSync('git', ['add', '--', 'm1-note.md'], { cwd: gitDir })
      execFileSync('git', ['commit', '-m', 'm1: page', '--', 'm1-note.md'], { cwd: gitDir })
      return 'm1'
    }),
    (async () => {
      appender.append(draft('t4', { n: 4 }))
      await flusher.flush()
      return 'm0'
    })(),
  ])
  expect(results).toEqual(['m1', 'm0'])
  assertContiguousSeqs(readAllShards(gitDir), 4)
})

it('回归：删库未抬升序列拒绝误删新事件、fsync 后删库 recover() 补提交与尾行空白解析', async () => {
  const dbPath = join(dir, 'orchestrator.sqlite')
  const gitDir = join(dir, 'memory-git')
  const sink1 = createGitShardSink({ dir: gitDir })
  const flusher1 = createSpineFlusher(store.db, sink1)
  const appender1 = createSpineAppender(store, { kick: () => {} })

  appender1.append(draft('r1', { n: 1 }))
  appender1.append(draft('r2', { n: 2 }))
  const first = await flusher1.flush()

  // 末尾夹带纯空白行时，latest() 仍应找回最后一条有效事件
  appendFileSync(join(gitDir, first.shard!), '   \n', 'utf8')
  expect((await sink1.latest())?.tail).toEqual({ seq: 2, id: 'r2' })

  // 模拟 append+fsync 成功但 commit 失败，且随后发生删库重建
  appender1.append(draft('r3', { n: 3 }))
  vi.spyOn(sink1, 'commit').mockRejectedValueOnce(new Error('commit aborted'))
  await expect(flusher1.flush()).rejects.toThrow('commit aborted')
  store.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })

  // 未抬升序列写入 seq=1 应被撞号校验拦截，绝不能误删新事件
  store = new Store(dbPath)
  ensureSpineSchema(store.db)
  const badAppender = createSpineAppender(store, { kick: () => {} })
  badAppender.append(draft('r4-collide', { n: 4 }))
  const sink2 = createGitShardSink({ dir: gitDir })
  const flusher2 = createSpineFlusher(store.db, sink2)
  await expect(flusher2.flush()).rejects.toThrow(/不一致|冲突/)
  expect(store.db.prepare('SELECT id FROM event_spine').all()).toEqual([{ id: 'r4-collide' }])

  // 清理误写缓冲并按正常空库打开后，recover() 仍能幂等提交前次 fsync 遗留的分片
  store.db.exec('DELETE FROM event_spine')
  const recovered = await flusher2.recover()
  expect(recovered.commit).toMatch(/^[0-9a-f]{40}$/)
  expect(execFileSync('git', ['status', '--porcelain', '--', 'm0'], { cwd: gitDir, encoding: 'utf8' }).trim()).toBe('')
  assertContiguousSeqs(readAllShards(gitDir), 3)
})
