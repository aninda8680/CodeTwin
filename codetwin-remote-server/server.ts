#!/usr/bin/env bun
// @ts-nocheck

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

type Level = "stdout" | "stderr" | "meta" | "cli_event"
type JobStatus = "running" | "done" | "error"
type JobMode = "shell" | "cli"
type PairRole = "client" | "worker"

type PairTokenClaims = {
  v: 1
  role: PairRole
  pairingId: string
  deviceId: string
  workerId?: string
  iat: number
  exp: number
}

type AuthContext =
  | { kind: "open" }
  | { kind: "admin" }
  | { kind: "pair"; claims: PairTokenClaims }

type JobLog = {
  ts: number
  level: Level
  text?: string
  event?: Record<string, unknown>
}

type Job = {
  id: string
  mode: JobMode
  interactive?: boolean
  command: string
  args: string[]
  cwd: string
  status: JobStatus
  code: number | null
  start: number
  end: number | null
  logs: JobLog[]
  pid?: number
  pairingId?: string
}

type BridgeEvent =
  | { type: "ready"; ts: number; jobId: string | null }
  | {
      type: "start"
      jobId: string
      ts: number
      mode: JobMode
      interactive?: boolean
      command: string
      args: string[]
      cwd: string
      pid: number
    }
  | { type: "stdout" | "stderr"; jobId: string; ts: number; text: string }
  | { type: "cli_event"; jobId: string; ts: number; event: Record<string, unknown> }
  | { type: "input"; jobId: string; ts: number; bytes: number }
  | { type: "terminate"; jobId: string; ts: number; signal: string }
  | { type: "exit"; jobId: string; ts: number; code: number }
  | { type: "error"; jobId: string; ts: number; message: string }
  | { type: "subscribed"; ts: number; jobId: string | null }
  | { type: "accepted"; ts: number; job: Partial<Job> }

type PairingResult = {
  pairingId: string
  workerId: string
  workerToken: string
  clientToken: string
  cliDeviceId: string
  mobileDeviceId: string
  mobileDeviceName?: string
  pairedAt: number
  tokenExpiresAt: number
  apiBaseUrl: string
  wsUrl: string
}

type PairingSession = {
  id: string
  code: string
  pollToken: string
  cliDeviceId: string
  cliDeviceName?: string
  createdAt: number
  expiresAt: number
  deleteAt: number
  status: "pending" | "paired" | "expired"
  result?: PairingResult
}

type SseClient = {
  jobId?: string
  pairingId?: string
  send: (event: BridgeEvent) => void
}

type WsData = {
  role: "client" | "worker"
  workerId?: string
  jobId?: string
  pairingId?: string
}

const host = process.env["HOST"] || process.env["REMOTE_EXEC_HOST"] || "0.0.0.0"
const port = parseNumber(process.env["PORT"] || process.env["REMOTE_EXEC_PORT"], 8787)
const adminToken = (process.env["REMOTE_EXEC_TOKEN"] ?? "").trim()
const signingSecret =
  (process.env["REMOTE_EXEC_SIGNING_SECRET"] ?? process.env["REMOTE_EXEC_PAIRING_SECRET"] ?? "").trim()
const maxLogs = parseNumber(process.env["REMOTE_EXEC_MAX_LOGS"], 4000)
const wsClientPingMs = parseNumber(process.env["REMOTE_EXEC_WS_CLIENT_PING_MS"], 15000)

const publicApiBaseUrl = (process.env["REMOTE_EXEC_PUBLIC_BASE_URL"] ?? "").trim()
const publicWsUrl = (process.env["REMOTE_EXEC_PUBLIC_WS_URL"] ?? "").trim()
const pairCodeLength = parseNumber(process.env["REMOTE_EXEC_PAIR_CODE_LENGTH"], 12)
const pairCodeTtlMs = parseNumber(process.env["REMOTE_EXEC_PAIR_CODE_TTL_SEC"], 300) * 1000
const pairSessionTtlMs = parseNumber(process.env["REMOTE_EXEC_PAIR_SESSION_TTL_SEC"], 900) * 1000
const pairTokenTtlMs = parseNumber(process.env["REMOTE_EXEC_PAIR_TOKEN_TTL_DAYS"], 180) * 24 * 60 * 60 * 1000
const corsOrigins = parseList(
  process.env["REMOTE_EXEC_ALLOWED_ORIGINS"] ?? process.env["REMOTE_EXEC_CORS_ORIGINS"] ?? "",
)

const authEnabled = Boolean(adminToken || signingSecret)
const pairingEnabled = Boolean(signingSecret)

const jobs = new Map<string, Job>()
const jobWorker = new Map<string, string>()
const workerJobs = new Map<string, Set<string>>()
const workerPairing = new Map<string, string | undefined>()
const sseClients = new Set<SseClient>()
const clientWs = new Set<ServerWebSocket<WsData>>()
const workers = new Map<string, ServerWebSocket<WsData>>()

const pairingSessions = new Map<string, PairingSession>()
const pairingCodes = new Map<string, string>()
const clientHeartbeatTimers = new Map<ServerWebSocket<WsData>, ReturnType<typeof setInterval>>()

const mobileFeatureCatalog = {
  transport: {
    websocket: {
      path: "/ws",
      supports: ["subscribe", "execute", "cliExecute", "input", "terminate", "ping", "pong"],
    },
    sse: {
      paths: ["/stream", "/jobs/:id/stream"],
      pingIntervalMs: wsClientPingMs,
    },
  },
  execution: {
    shell: {
      endpoint: "POST /jobs",
      interactive: false,
    },
    cliStructured: {
      endpoint: "POST /cli/exec",
      interactive: false,
      request: {
        args: ["run", "<prompt>"],
        streamFormat: "json",
        thinking: true,
      },
      emits: ["cli_event", "stdout", "stderr", "exit", "error"],
    },
    cliInteractive: {
      endpoint: "POST /cli/exec",
      interactive: true,
      request: {
        args: ["<optional cli args>"],
        interactive: true,
      },
      notes: [
        "Keeps stdin open for raw key control (slash, tab, arrows, escape sequences)",
        "Use /jobs/:id/input with appendNewline=false for single-key and terminal control sequences",
      ],
    },
  },
  tuiCommands: {
    global: [
      { id: "session.list", slash: ["/sessions", "/resume", "/continue"] },
      { id: "session.new", slash: ["/new", "/clear"] },
      { id: "model.list", slash: ["/models"] },
      { id: "model.cycle_recent", keybind: "model_cycle_recent" },
      { id: "model.cycle_recent_reverse", keybind: "model_cycle_recent_reverse" },
      { id: "model.cycle_favorite", keybind: "model_cycle_favorite" },
      { id: "model.cycle_favorite_reverse", keybind: "model_cycle_favorite_reverse" },
      { id: "agent.list", slash: ["/agents"] },
      { id: "agent.cycle", keybind: "agent_cycle" },
      { id: "agent.cycle.reverse", keybind: "agent_cycle_reverse" },
      { id: "variant.cycle", keybind: "variant_cycle" },
      { id: "variant.list", slash: ["/variants"] },
      { id: "mcp.list", slash: ["/mcps"] },
      { id: "provider.connect", slash: ["/connect"] },
      { id: "codetwin.status", slash: ["/status"] },
      { id: "theme.switch", slash: ["/themes"] },
      { id: "help.show", slash: ["/help"] },
      { id: "app.exit", slash: ["/exit", "/quit", "/q"] },
    ],
    prompt: [
      { id: "prompt.submit", keybind: "input_submit" },
      { id: "prompt.clear", keybind: "input_clear" },
      { id: "prompt.editor", slash: ["/editor"] },
      { id: "prompt.skills", slash: ["/skills"] },
      { id: "prompt.stash" },
      { id: "prompt.stash.pop" },
      { id: "prompt.stash.list" },
      { id: "session.interrupt", keybind: "session_interrupt" },
      { id: "prompt.paste", keybind: "input_paste" },
    ],
    session: [
      { id: "session.share", slash: ["/share"] },
      { id: "session.rename", slash: ["/rename"] },
      { id: "session.timeline", slash: ["/timeline"] },
      { id: "session.fork", slash: ["/fork"] },
      { id: "session.compact", slash: ["/compact", "/summarize"] },
      { id: "session.unshare", slash: ["/unshare"] },
      { id: "session.undo", slash: ["/undo"] },
      { id: "session.redo", slash: ["/redo"] },
      { id: "session.toggle.timestamps", slash: ["/timestamps", "/toggle-timestamps"] },
      { id: "session.toggle.thinking", slash: ["/thinking", "/toggle-thinking"] },
      { id: "messages.copy" },
      { id: "session.copy", slash: ["/copy"] },
      { id: "session.export", slash: ["/export"] },
      { id: "session.child.first", keybind: "session_child_first" },
      { id: "session.parent", keybind: "session_parent" },
      { id: "session.child.next", keybind: "session_child_cycle" },
      { id: "session.child.previous", keybind: "session_child_cycle_reverse" },
    ],
  },
  defaultKeybinds: {
    command_list: "ctrl+p",
    leader: "ctrl+x",
    agent_cycle: "tab",
    agent_cycle_reverse: "shift+tab",
    variant_cycle: "ctrl+t",
    model_list: "<leader>m",
    agent_list: "<leader>a",
    session_list: "<leader>l",
    session_new: "<leader>n",
    session_timeline: "<leader>g",
    input_submit: "return",
    input_newline: "shift+return,ctrl+return,alt+return,ctrl+j",
    session_interrupt: "escape",
  },
}

const now = () => Date.now()
const WS_OPEN = 1
const PAIR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function parseNumber(input: string | undefined, fallback: number) {
  if (!input) return fallback
  const value = Number(input)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function parseList(input: string) {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function toBase64Url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url")
}

function fromBase64Url(input: string) {
  return Buffer.from(input, "base64url")
}

function safeEqualString(a: string, b: string) {
  const aa = Buffer.from(a)
  const bb = Buffer.from(b)
  if (aa.length !== bb.length) return false
  return timingSafeEqual(aa, bb)
}

function signPayload(payloadB64: string) {
  return createHmac("sha256", signingSecret).update(payloadB64).digest("base64url")
}

function issuePairToken(claims: Omit<PairTokenClaims, "v">) {
  if (!pairingEnabled) throw new Error("Pairing is not enabled")
  const payload = toBase64Url(JSON.stringify({ v: 1, ...claims }))
  const sig = signPayload(payload)
  return `${payload}.${sig}`
}

function verifyPairToken(token: string) {
  if (!pairingEnabled) return undefined
  const [payload, signature] = token.split(".")
  if (!payload || !signature) return undefined

  const expected = signPayload(payload)
  if (!safeEqualString(signature, expected)) return undefined

  let parsed: any
  try {
    parsed = JSON.parse(fromBase64Url(payload).toString("utf8"))
  } catch {
    return undefined
  }

  if (parsed?.v !== 1) return undefined
  if (parsed?.role !== "client" && parsed?.role !== "worker") return undefined
  if (typeof parsed?.pairingId !== "string" || !parsed.pairingId) return undefined
  if (typeof parsed?.deviceId !== "string" || !parsed.deviceId) return undefined
  if (typeof parsed?.iat !== "number" || !Number.isFinite(parsed.iat)) return undefined
  if (typeof parsed?.exp !== "number" || !Number.isFinite(parsed.exp)) return undefined
  if (parsed.exp <= now()) return undefined
  if (parsed.role === "worker" && typeof parsed?.workerId !== "string") return undefined

  return parsed as PairTokenClaims
}

function sanitizeDeviceId(input: unknown, fallbackPrefix: string) {
  if (typeof input !== "string") return `${fallbackPrefix}-${crypto.randomUUID()}`
  const cleaned = input.trim().replace(/[^a-zA-Z0-9._-]/g, "")
  if (!cleaned) return `${fallbackPrefix}-${crypto.randomUUID()}`
  return cleaned.slice(0, 100)
}

function sanitizeDeviceName(input: unknown) {
  if (typeof input !== "string") return undefined
  const cleaned = input.trim().slice(0, 120)
  return cleaned || undefined
}

function generatePairCode(length: number) {
  const bytes = randomBytes(length)
  let code = ""
  for (let i = 0; i < length; i++) {
    code += PAIR_CODE_ALPHABET[bytes[i] % PAIR_CODE_ALPHABET.length]
  }
  return code
}

function getPublicUrls(req: Request) {
  const requestUrl = new URL(req.url)
  const derivedApi = `${requestUrl.protocol}//${requestUrl.host}`
  const apiBaseUrl = publicApiBaseUrl || derivedApi

  let wsUrl = publicWsUrl
  if (!wsUrl) {
    const ws = new URL(apiBaseUrl)
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:"
    ws.pathname = "/ws"
    ws.search = ""
    ws.hash = ""
    wsUrl = ws.toString()
  }

  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    wsUrl,
  }
}

function readCredential(req: Request, url?: URL) {
  const parsed = url ?? new URL(req.url)
  const queryToken = parsed.searchParams.get("token")
  if (queryToken) return queryToken

  const auth = req.headers.get("authorization")
  if (auth?.startsWith("Bearer ")) return auth.slice(7)

  const alt = req.headers.get("x-remote-token")
  if (alt) return alt

  return undefined
}

function resolveAuth(req: Request, url?: URL): AuthContext | null {
  if (!authEnabled) return { kind: "open" }

  const credential = readCredential(req, url)
  if (!credential) return null

  if (adminToken && safeEqualString(credential, adminToken)) {
    return { kind: "admin" }
  }

  const claims = verifyPairToken(credential)
  if (claims) {
    return { kind: "pair", claims }
  }

  return null
}

function getClientPairing(auth: AuthContext): string | undefined | null {
  if (auth.kind === "pair") {
    if (auth.claims.role !== "client") return null
    return auth.claims.pairingId
  }
  return undefined
}

function getWorkerIdentity(auth: AuthContext): { pairingId?: string; workerId?: string } | null {
  if (auth.kind === "pair") {
    if (auth.claims.role !== "worker") return null
    return {
      pairingId: auth.claims.pairingId,
      workerId: auth.claims.workerId,
    }
  }
  return {}
}

function allowedOrigin(req: Request) {
  const origin = req.headers.get("origin")
  if (!corsOrigins.length) return "*"
  if (!origin) return corsOrigins[0]
  if (corsOrigins.includes("*")) return origin
  return corsOrigins.includes(origin) ? origin : corsOrigins[0]
}

function addCors(headers: Headers, req?: Request) {
  headers.set("Access-Control-Allow-Origin", req ? allowedOrigin(req) : corsOrigins.length ? corsOrigins[0] : "*")
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Remote-Token, CodeTwin-Role")
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  if (corsOrigins.length && !corsOrigins.includes("*")) {
    headers.set("Vary", "Origin")
  }
}

function asJson(data: unknown, status = 200, req?: Request) {
  const headers = new Headers({ "content-type": "application/json" })
  addCors(headers, req)
  return new Response(JSON.stringify(data), { status, headers })
}

function unauthorized(req: Request, message = "Unauthorized") {
  return asJson({ error: message }, 401, req)
}

function forbidden(req: Request, message = "Forbidden") {
  return asJson({ error: message }, 403, req)
}

function jobInfo(job: Job) {
  return {
    id: job.id,
    mode: job.mode,
    interactive: !!job.interactive,
    command: job.command,
    args: job.args,
    cwd: job.cwd,
    status: job.status,
    code: job.code,
    start: job.start,
    end: job.end,
    pid: job.pid,
    pairingId: job.pairingId ?? null,
  }
}

function appendLog(jobId: string, level: Level, text: string) {
  if (!text) return
  const job = jobs.get(jobId)
  if (!job) return
  job.logs.push({ ts: now(), level, text })
  if (job.logs.length > maxLogs) {
    job.logs.splice(0, job.logs.length - maxLogs)
  }
}

function appendCliEvent(jobId: string, event: Record<string, unknown>, ts?: number) {
  const job = jobs.get(jobId)
  if (!job) return
  job.logs.push({
    ts: typeof ts === "number" ? ts : now(),
    level: "cli_event",
    event,
  })
  if (job.logs.length > maxLogs) {
    job.logs.splice(0, job.logs.length - maxLogs)
  }
}

function jobIdFromEvent(event: BridgeEvent) {
  if (!("jobId" in event)) return undefined
  return typeof event.jobId === "string" ? event.jobId : undefined
}

function matchesClientFilters(event: BridgeEvent, jobFilter?: string, pairingId?: string) {
  const eventJobId = jobIdFromEvent(event)
  if (jobFilter && eventJobId && eventJobId !== jobFilter) return false
  if (!pairingId || !eventJobId) return true
  const job = jobs.get(eventJobId)
  return Boolean(job && job.pairingId === pairingId)
}

function fanoutToClients(event: BridgeEvent, pairingId?: string) {
  for (const client of sseClients) {
    if (pairingId && client.pairingId !== pairingId) continue
    if (!matchesClientFilters(event, client.jobId, client.pairingId)) continue
    client.send(event)
  }

  const data = JSON.stringify(event)
  for (const client of clientWs) {
    if (pairingId && client.data.pairingId !== pairingId) continue
    if (!matchesClientFilters(event, client.data.jobId, client.data.pairingId)) continue
    client.send(data)
  }
}

function stopClientHeartbeat(socket: ServerWebSocket<WsData>) {
  const timer = clientHeartbeatTimers.get(socket)
  if (!timer) return
  clearInterval(timer)
  clientHeartbeatTimers.delete(socket)
}

function startClientHeartbeat(socket: ServerWebSocket<WsData>) {
  stopClientHeartbeat(socket)
  const timer = setInterval(() => {
    if (socket.readyState !== WS_OPEN) {
      stopClientHeartbeat(socket)
      return
    }
    socket.send(JSON.stringify({ type: "ping", ts: now() }))
  }, wsClientPingMs)
  clientHeartbeatTimers.set(socket, timer)
}

function sendToWorker(workerId: string, payload: unknown) {
  const socket = workers.get(workerId)
  if (!socket || socket.readyState !== WS_OPEN) {
    workers.delete(workerId)
    workerJobs.delete(workerId)
    workerPairing.delete(workerId)
    return false
  }
  socket.send(JSON.stringify(payload))
  return true
}

function pickWorkerId(pairingId?: string) {
  let selected: string | undefined
  let minLoad = Number.MAX_SAFE_INTEGER

  for (const [workerId, socket] of workers) {
    if (socket.readyState !== WS_OPEN) {
      workers.delete(workerId)
      workerJobs.delete(workerId)
      workerPairing.delete(workerId)
      continue
    }

    const workerPair = workerPairing.get(workerId)
    if (pairingId && workerPair !== pairingId) continue

    const load = workerJobs.get(workerId)?.size ?? 0
    if (load < minLoad) {
      minLoad = load
      selected = workerId
    }
  }

  return selected
}

function assignJobToWorker(jobId: string, workerId: string) {
  jobWorker.set(jobId, workerId)
  let set = workerJobs.get(workerId)
  if (!set) {
    set = new Set()
    workerJobs.set(workerId, set)
  }
  set.add(jobId)
}

function releaseJob(jobId: string) {
  const workerId = jobWorker.get(jobId)
  if (!workerId) return
  const set = workerJobs.get(workerId)
  set?.delete(jobId)
  if (set && set.size === 0) {
    workerJobs.delete(workerId)
  }
  jobWorker.delete(jobId)
}

function normalizeEnv(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") result[key] = value
  }
  return Object.keys(result).length ? result : undefined
}

function stringArray(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string")
}

function normalizeCliStreamFormat(input: unknown): "text" | "json" | undefined {
  if (typeof input !== "string") return undefined
  const value = input.toLowerCase()
  if (value === "text" || value === "json") return value
  return undefined
}

function createPendingJob(input: {
  mode: JobMode
  interactive?: boolean
  command?: string
  args?: string[]
  cwd?: string
  pairingId?: string
}) {
  const jobId = crypto.randomUUID()
  const job: Job = {
    id: jobId,
    mode: input.mode,
    interactive: input.interactive,
    command: input.command ?? "",
    args: input.args ?? [],
    cwd: input.cwd ?? "",
    status: "running",
    code: null,
    start: now(),
    end: null,
    logs: [],
    pairingId: input.pairingId,
  }
  jobs.set(jobId, job)
  return job
}

function dispatchJob(input: {
  mode: JobMode
  command?: string
  args?: string[]
  cwd?: string
  env?: unknown
  interactive?: unknown
  streamFormat?: unknown
  thinking?: unknown
  pairingId?: string
}) {
  const workerId = pickWorkerId(input.pairingId)
  if (!workerId) {
    throw new Error(input.pairingId ? "No paired worker connected" : "No workers connected")
  }

  const mode = input.mode
  const args = input.args ?? []
  const command = input.command ?? ""
  const cwd = input.cwd
  const env = normalizeEnv(input.env)
  const cliInteractive = mode === "cli" ? input.interactive === true : undefined
  const cliStreamFormat =
    mode === "cli"
      ? (normalizeCliStreamFormat(input.streamFormat) ?? (cliInteractive ? "text" : args[0] === "run" ? "json" : "text"))
      : undefined
  const cliThinking =
    mode === "cli"
      ? typeof input.thinking === "boolean"
        ? input.thinking
        : cliInteractive
          ? false
          : cliStreamFormat === "json"
      : undefined

  if (mode === "shell" && !command.trim()) {
    throw new Error("command is required")
  }
  if (mode === "cli" && args.length === 0 && !cliInteractive) {
    throw new Error("args must be a non-empty string array")
  }

  const job = createPendingJob({
    mode,
    interactive: cliInteractive,
    command: mode === "shell" ? command : ["codetwin", ...args].join(" "),
    args,
    cwd,
    pairingId: input.pairingId,
  })

  assignJobToWorker(job.id, workerId)

  const sent = sendToWorker(workerId, {
    type: mode === "shell" ? "execute" : "cliExecute",
    jobId: job.id,
    command,
    args,
    cwd,
    env,
    interactive: cliInteractive,
    streamFormat: cliStreamFormat,
    thinking: cliThinking,
  })

  if (!sent) {
    releaseJob(job.id)
    jobs.delete(job.id)
    throw new Error("Selected worker is unavailable")
  }

  return { job, workerId }
}

function forwardToJobWorker(jobId: string, payload: unknown) {
  const workerId = jobWorker.get(jobId)
  if (!workerId) return false
  return sendToWorker(workerId, payload)
}

function markJobWorkerDisconnected(jobId: string, workerId: string) {
  const job = jobs.get(jobId)
  if (!job || job.status !== "running") {
    releaseJob(jobId)
    return
  }

  const endedAt = now()
  job.status = "error"
  job.code = -1
  job.end = endedAt
  appendLog(jobId, "meta", `Assigned worker disconnected: ${workerId}`)
  releaseJob(jobId)

  fanoutToClients({
    type: "error",
    jobId,
    ts: endedAt,
    message: `Assigned worker disconnected: ${workerId}`,
  })

  fanoutToClients({
    type: "exit",
    jobId,
    ts: endedAt,
    code: -1,
  })
}

function disconnectWorker(workerId: string) {
  const set = workerJobs.get(workerId)
  if (set && set.size) {
    for (const jobId of [...set]) {
      markJobWorkerDisconnected(jobId, workerId)
    }
  }
  workerJobs.delete(workerId)
  workers.delete(workerId)
  workerPairing.delete(workerId)
}

function replayHistory(job: Job, send: (event: BridgeEvent) => void) {
  for (const line of job.logs) {
    if (line.level === "cli_event" && line.event) {
      send({
        type: "cli_event",
        jobId: job.id,
        ts: line.ts,
        event: line.event,
      })
      continue
    }

    if (!line.text) continue
    const type = line.level === "stderr" ? "stderr" : "stdout"
    send({
      type,
      jobId: job.id,
      ts: line.ts,
      text: line.text,
    })
  }

  if (job.status !== "running" && job.code !== null) {
    send({
      type: "exit",
      jobId: job.id,
      ts: job.end ?? now(),
      code: job.code,
    })
  }
}

function handleWorkerEvent(socket: ServerWebSocket<WsData>, body: any) {
  const workerId = socket.data.workerId
  if (!workerId) return

  if (body?.type === "ping") {
    socket.send(JSON.stringify({ type: "pong", ts: now() }))
    return
  }

  const { type, jobId } = body
  if (!jobId) return

  const assigned = jobWorker.get(jobId)
  if (assigned && assigned !== workerId) {
    socket.send(
      JSON.stringify({
        type: "error",
        ts: now(),
        message: `Job ${jobId} is assigned to worker ${assigned}`,
      }),
    )
    return
  }

  const workerPairingId = socket.data.pairingId
  let job = jobs.get(jobId)
  if (!job && type === "start") {
    job = {
      id: jobId,
      mode: body.mode,
      interactive: body.interactive === true,
      command: body.command || "",
      args: body.args || [],
      cwd: body.cwd || "",
      status: "running",
      code: null,
      start: body.ts || now(),
      end: null,
      logs: [],
      pid: body.pid,
      pairingId: workerPairingId,
    }
    jobs.set(jobId, job)
    assignJobToWorker(jobId, workerId)
  }

  if (job && workerPairingId && job.pairingId && workerPairingId !== job.pairingId) {
    socket.send(
      JSON.stringify({
        type: "error",
        ts: now(),
        message: `Job ${jobId} does not belong to worker pairing`,
      }),
    )
    return
  }

  if (job) {
    if (type === "start") {
      job.mode = body.mode === "cli" ? "cli" : "shell"
      job.interactive = body.interactive === true
      job.command = typeof body.command === "string" ? body.command : job.command
      job.args = stringArray(body.args)
      job.cwd = typeof body.cwd === "string" ? body.cwd : job.cwd
      job.status = "running"
      job.code = null
      job.start = typeof body.ts === "number" ? body.ts : job.start
      job.pid = typeof body.pid === "number" ? body.pid : job.pid
    } else if (type === "stdout" || type === "stderr") {
      const text = typeof body.text === "string" ? body.text : ""
      appendLog(jobId, type, text)
    } else if (type === "cli_event") {
      if (body.event && typeof body.event === "object") {
        appendCliEvent(jobId, body.event as Record<string, unknown>, typeof body.ts === "number" ? body.ts : undefined)
      }
    } else if (type === "exit") {
      console.log(`[Server] Job ${jobId} exited on worker ${workerId} with code ${body.code}`)
      job.code = body.code
      job.end = body.ts || now()
      job.status = body.code === 0 ? "done" : "error"
      releaseJob(jobId)
    } else if (type === "error") {
      job.code = -1
      job.end = body.ts || now()
      job.status = "error"
      appendLog(jobId, "meta", body.message)
      releaseJob(jobId)
    }
  }

  fanoutToClients(body as BridgeEvent, job?.pairingId)
}

function createSse(req: Request, pairingId?: string, jobId?: string) {
  const headers = new Headers({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  addCors(headers, req)

  let ping: ReturnType<typeof setInterval> | undefined
  let client: SseClient | undefined

  const body = new ReadableStream({
    start(controller) {
      const send = (event: BridgeEvent) => {
        controller.enqueue(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      }

      send({ type: "ready", ts: now(), jobId: jobId ?? null })

      if (jobId) {
        const job = jobs.get(jobId)
        if (job) replayHistory(job, send)
      }

      client = { jobId, pairingId, send }
      sseClients.add(client)

      ping = setInterval(() => {
        controller.enqueue(`event: ping\ndata: ${now()}\n\n`)
      }, wsClientPingMs)
    },
    cancel() {
      if (client) sseClients.delete(client)
      if (ping) clearInterval(ping)
    },
  })

  return new Response(body, { headers })
}

async function parseBody(req: Request) {
  try {
    return await req.json()
  } catch {
    throw new Error("Invalid JSON body")
  }
}

function cleanupPairingSessions() {
  const ts = now()
  for (const [id, session] of pairingSessions) {
    if (session.status === "pending" && ts > session.expiresAt) {
      session.status = "expired"
      pairingCodes.delete(session.code)
    }

    if (ts > session.deleteAt) {
      pairingSessions.delete(id)
      pairingCodes.delete(session.code)
    }
  }
}

function createPairingSession(req: Request, body: any) {
  if (!pairingEnabled) {
    throw new Error("Pairing is disabled. Set REMOTE_EXEC_SIGNING_SECRET.")
  }

  cleanupPairingSessions()

  const cliDeviceId = sanitizeDeviceId(body?.cliDeviceId, "cli")
  const cliDeviceName = sanitizeDeviceName(body?.cliDeviceName)
  const id = crypto.randomUUID()
  const code = generatePairCode(pairCodeLength)
  const pollToken = toBase64Url(randomBytes(24))
  const createdAt = now()

  const session: PairingSession = {
    id,
    code,
    pollToken,
    cliDeviceId,
    cliDeviceName,
    createdAt,
    expiresAt: createdAt + pairCodeTtlMs,
    deleteAt: createdAt + pairSessionTtlMs,
    status: "pending",
  }

  pairingSessions.set(id, session)
  pairingCodes.set(code, id)

  return {
    session,
    ...getPublicUrls(req),
  }
}

function completePairing(req: Request, body: any) {
  if (!pairingEnabled) {
    throw new Error("Pairing is disabled. Set REMOTE_EXEC_SIGNING_SECRET.")
  }

  cleanupPairingSessions()

  const code = String(body?.code ?? "").trim().toUpperCase()
  if (!code) throw new Error("code is required")

  const id = pairingCodes.get(code)
  if (!id) throw new Error("Invalid or expired pairing code")

  const session = pairingSessions.get(id)
  if (!session) throw new Error("Invalid or expired pairing code")
  if (session.status !== "pending") throw new Error("Pairing code already used")
  if (now() > session.expiresAt) {
    session.status = "expired"
    pairingCodes.delete(session.code)
    throw new Error("Pairing code expired")
  }

  const mobileDeviceId = sanitizeDeviceId(body?.mobileDeviceId, "mobile")
  const mobileDeviceName = sanitizeDeviceName(body?.mobileDeviceName)
  const pairedAt = now()
  const tokenExpiresAt = pairedAt + pairTokenTtlMs
  const pairingId = crypto.randomUUID()
  const workerId = `worker-${pairingId.slice(0, 12)}`

  const workerToken = issuePairToken({
    role: "worker",
    pairingId,
    deviceId: session.cliDeviceId,
    workerId,
    iat: pairedAt,
    exp: tokenExpiresAt,
  })

  const clientToken = issuePairToken({
    role: "client",
    pairingId,
    deviceId: mobileDeviceId,
    iat: pairedAt,
    exp: tokenExpiresAt,
  })

  const { apiBaseUrl, wsUrl } = getPublicUrls(req)
  session.result = {
    pairingId,
    workerId,
    workerToken,
    clientToken,
    cliDeviceId: session.cliDeviceId,
    mobileDeviceId,
    mobileDeviceName,
    pairedAt,
    tokenExpiresAt,
    apiBaseUrl,
    wsUrl,
  }
  session.status = "paired"
  session.deleteAt = now() + pairSessionTtlMs
  pairingCodes.delete(session.code)

  return session.result
}

function getSessionForPoll(body: any) {
  cleanupPairingSessions()

  const sessionId = typeof body?.pairingSessionId === "string" ? body.pairingSessionId : ""
  const pollToken = typeof body?.pollToken === "string" ? body.pollToken : ""
  if (!sessionId || !pollToken) throw new Error("pairingSessionId and pollToken are required")

  const session = pairingSessions.get(sessionId)
  if (!session) throw new Error("Pairing session not found")
  if (!safeEqualString(session.pollToken, pollToken)) throw new Error("Invalid polling token")

  return session
}

function findJobForPairing(jobId: string, pairingId?: string) {
  const job = jobs.get(jobId)
  if (!job) return undefined
  if (pairingId && job.pairingId !== pairingId) return undefined
  return job
}

const server = Bun.serve<WsData>({
  hostname: host,
  port,
  async fetch(req, app) {
    const url = new URL(req.url)

    if (req.method === "OPTIONS") {
      const headers = new Headers()
      addCors(headers, req)
      return new Response(null, { status: 204, headers })
    }

    if (url.pathname === "/health") {
      return asJson(
        {
          ok: true,
          host,
          port,
          auth: authEnabled ? "enabled" : "open",
          pairing: pairingEnabled,
          workers: workers.size,
          clients: clientWs.size + sseClients.size,
          running: [...jobs.values()].filter((j) => j.status === "running").length,
          total: jobs.size,
        },
        200,
        req,
      )
    }

    if (url.pathname === "/features") {
      return asJson(
        {
          http: [
            "GET /health",
            "GET /features",
            "GET /mobile/features",
            "GET /pair/config",
            "POST /pair/cli/start",
            "POST /pair/cli/poll",
            "POST /pair/mobile/complete",
            "GET /jobs",
            "POST /jobs",
            "POST /cli/exec",
            "GET /jobs/:id",
            "GET /jobs/:id/stream",
            "POST /jobs/:id/input",
            "POST /jobs/:id/terminate",
            "GET /stream",
          ],
          websocket: ["subscribe", "execute", "cliExecute", "input", "terminate", "ping", "pong"],
          workerWebsocket: ["start", "stdout", "stderr", "cli_event", "exit", "error", "input", "terminate"],
          mobile: {
            capabilitiesEndpoint: "/mobile/features",
            interactiveCli: true,
            structuredCliEvents: true,
          },
        },
        200,
        req,
      )
    }

    if (url.pathname === "/mobile/features" && req.method === "GET") {
      return asJson(
        {
          ok: true,
          generatedAt: now(),
          data: mobileFeatureCatalog,
        },
        200,
        req,
      )
    }

    if (url.pathname === "/pair/config" && req.method === "GET") {
      const urls = getPublicUrls(req)
      return asJson(
        {
          pairingEnabled,
          codeLength: pairCodeLength,
          codeTtlSeconds: Math.floor(pairCodeTtlMs / 1000),
          tokenTtlDays: Math.floor(pairTokenTtlMs / (24 * 60 * 60 * 1000)),
          apiBaseUrl: urls.apiBaseUrl,
          wsUrl: urls.wsUrl,
        },
        200,
        req,
      )
    }

    if (url.pathname === "/pair/cli/start" && req.method === "POST") {
      try {
        const body = await parseBody(req)
        const result = createPairingSession(req, body)
        return asJson(
          {
            pairingSessionId: result.session.id,
            pollToken: result.session.pollToken,
            code: result.session.code,
            expiresAt: result.session.expiresAt,
            pollIntervalMs: 2000,
            cliDeviceId: result.session.cliDeviceId,
            apiBaseUrl: result.apiBaseUrl,
            wsUrl: result.wsUrl,
          },
          201,
          req,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return asJson({ error: message }, 400, req)
      }
    }

    if (url.pathname === "/pair/cli/poll" && req.method === "POST") {
      try {
        const body = await parseBody(req)
        const session = getSessionForPoll(body)

        if (session.status === "pending") {
          if (now() > session.expiresAt) {
            session.status = "expired"
            pairingCodes.delete(session.code)
            return asJson({ status: "expired", expiresAt: session.expiresAt }, 200, req)
          }

          return asJson({ status: "pending", expiresAt: session.expiresAt }, 200, req)
        }

        if (session.status === "expired") {
          return asJson({ status: "expired", expiresAt: session.expiresAt }, 200, req)
        }

        if (!session.result) {
          return asJson({ status: "error", message: "Pairing state invalid" }, 500, req)
        }

        return asJson(
          {
            status: "paired",
            pairing: {
              pairingId: session.result.pairingId,
              cliDeviceId: session.result.cliDeviceId,
              workerId: session.result.workerId,
              workerToken: session.result.workerToken,
              apiBaseUrl: session.result.apiBaseUrl,
              wsUrl: session.result.wsUrl,
              tokenExpiresAt: session.result.tokenExpiresAt,
            },
          },
          200,
          req,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return asJson({ error: message }, 400, req)
      }
    }

    if (url.pathname === "/pair/mobile/complete" && req.method === "POST") {
      try {
        const body = await parseBody(req)
        const result = completePairing(req, body)
        return asJson(
          {
            status: "paired",
            pairingId: result.pairingId,
            clientToken: result.clientToken,
            mobileDeviceId: result.mobileDeviceId,
            tokenExpiresAt: result.tokenExpiresAt,
            apiBaseUrl: result.apiBaseUrl,
            wsUrl: result.wsUrl,
          },
          200,
          req,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return asJson({ error: message }, 400, req)
      }
    }

    if (url.pathname === "/ws") {
      const auth = resolveAuth(req, url)
      if (!auth) return unauthorized(req)

      const role =
        req.headers.get("CodeTwin-Role")?.toLowerCase() === "worker" ||
        url.searchParams.get("role")?.toLowerCase() === "worker"
          ? "worker"
          : "client"

      let pairingId: string | undefined
      let workerId: string | undefined = url.searchParams.get("workerId") ?? undefined

      if (role === "worker") {
        const identity = getWorkerIdentity(auth)
        if (!identity) return forbidden(req, "Worker token required")
        pairingId = identity.pairingId
        workerId = identity.workerId ?? workerId
      } else {
        const clientPairing = getClientPairing(auth)
        if (clientPairing === null) return forbidden(req, "Client token required")
        pairingId = clientPairing
      }

      const upgraded = app.upgrade(req, {
        data: {
          role,
          workerId,
          jobId: url.searchParams.get("jobId") ?? undefined,
          pairingId,
        },
      })
      if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 })
      return
    }

    const auth = resolveAuth(req, url)
    if (!auth) return unauthorized(req)

    const clientPairing = getClientPairing(auth)
    if (clientPairing === null) return forbidden(req, "Client token required")

    if (url.pathname === "/stream" && req.method === "GET") {
      return createSse(req, clientPairing)
    }

    if (url.pathname === "/jobs" && req.method === "GET") {
      const filtered = [...jobs.values()].filter((job) => !clientPairing || job.pairingId === clientPairing)
      return asJson({ jobs: filtered.map(jobInfo) }, 200, req)
    }

    if ((url.pathname === "/jobs" || url.pathname === "/cli/exec") && req.method === "POST") {
      try {
        const body = await parseBody(req)
        const mode = url.pathname === "/jobs" ? "shell" : "cli"
        const command = typeof body?.command === "string" ? body.command : ""
        const args = stringArray(body?.args)
        const cwd = typeof body?.cwd === "string" ? body.cwd : undefined
        const env = body?.env
        const interactive = body?.interactive
        const streamFormat = body?.streamFormat
        const thinking = body?.thinking

        const { job, workerId } = dispatchJob({
          mode,
          command,
          args,
          cwd,
          env,
          interactive,
          streamFormat,
          thinking,
          pairingId: clientPairing,
        })

        return asJson(
          {
            job: {
              ...jobInfo(job),
              workerId,
            },
          },
          201,
          req,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return asJson({ error: message }, 400, req)
      }
    }

    const parts = url.pathname.split("/").filter(Boolean)
    const isJobRoute = parts[0] === "jobs" && parts.length >= 2
    if (!isJobRoute) return asJson({ error: "Not Found" }, 404, req)

    const id = parts[1]
    const job = findJobForPairing(id, clientPairing)

    if (parts.length === 2 && req.method === "GET") {
      if (!job) return asJson({ error: "Job not found" }, 404, req)
      return asJson({ job: jobInfo(job), logs: job.logs }, 200, req)
    }

    if (parts.length === 3 && parts[2] === "stream" && req.method === "GET") {
      if (!job) return asJson({ error: "Job not found" }, 404, req)
      return createSse(req, clientPairing, id)
    }

    if (parts.length === 3 && parts[2] === "input" && req.method === "POST") {
      try {
        const body = await parseBody(req)
        if (!job) throw new Error("Job not found")
        if (job.status !== "running") throw new Error("Job is not running")

        const text = typeof body?.text === "string" ? body.text : ""
        const appendNewline = body?.appendNewline !== false

        const payload = {
          type: "input",
          jobId: id,
          text,
          appendNewline,
        }
        const sent = forwardToJobWorker(id, payload)
        if (!sent) throw new Error("Assigned worker unavailable")

        const bytes = Buffer.byteLength(appendNewline ? text + "\n" : text)
        fanoutToClients({
          type: "input",
          jobId: id,
          ts: now(),
          bytes,
        })

        return asJson({ ok: true, bytes }, 200, req)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return asJson({ error: message }, 400, req)
      }
    }

    if (parts.length === 3 && parts[2] === "terminate" && req.method === "POST") {
      try {
        const body = await parseBody(req)
        if (!job) throw new Error("Job not found")

        const signal = typeof body?.signal === "string" ? body.signal : undefined
        const sent = forwardToJobWorker(id, {
          type: "terminate",
          jobId: id,
          signal,
        })
        if (!sent) throw new Error("Assigned worker unavailable")

        fanoutToClients({
          type: "terminate",
          jobId: id,
          ts: now(),
          signal: signal && /^[A-Z0-9]+$/.test(signal) ? signal : "SIGTERM",
        })

        return asJson({ ok: true, requested: true }, 200, req)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return asJson({ error: message }, 400, req)
      }
    }

    return asJson({ error: "Not Found" }, 404, req)
  },
  websocket: {
    open(socket) {
      if (socket.data.role === "worker") {
        const requested = socket.data.workerId?.trim()
        const workerId = requested || crypto.randomUUID()
        const existing = workers.get(workerId)
        if (existing && existing !== socket && existing.readyState === WS_OPEN) {
          existing.close(1012, "worker replaced")
        }

        socket.data.workerId = workerId
        workers.set(workerId, socket)
        workerPairing.set(workerId, socket.data.pairingId)
        if (!workerJobs.has(workerId)) workerJobs.set(workerId, new Set())

        const pairingLabel = socket.data.pairingId ? ` pair=${socket.data.pairingId}` : ""
        console.log(`Worker connected: ${workerId}${pairingLabel}`)
        socket.send(
          JSON.stringify({
            type: "ready",
            ts: now(),
            workerId,
            pairingId: socket.data.pairingId ?? null,
          }),
        )
      } else {
        clientWs.add(socket)
        startClientHeartbeat(socket)
        socket.send(
          JSON.stringify({
            type: "ready",
            ts: now(),
            jobId: socket.data.jobId ?? null,
          }),
        )

        if (socket.data.jobId) {
          const job = findJobForPairing(socket.data.jobId, socket.data.pairingId)
          if (job) {
            replayHistory(job, (event) => socket.send(JSON.stringify(event)))
          }
        }
      }
    },
    close(socket) {
      if (socket.data.role === "worker") {
        const workerId = socket.data.workerId
        if (workerId) {
          console.log(`Worker disconnected: ${workerId}`)
          disconnectWorker(workerId)
        }
      } else {
        stopClientHeartbeat(socket)
        clientWs.delete(socket)
      }
    },
    message(socket, raw) {
      const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")
      let body: any
      try {
        body = JSON.parse(text)
      } catch {
        const fallback = text.trim().toLowerCase()
        if (fallback === "subscribe") {
          body = { type: "subscribe" }
        } else if (fallback === "ping") {
          body = { type: "ping" }
        } else if (fallback === "pong") {
          body = { type: "pong" }
        } else {
          socket.send(JSON.stringify({ type: "error", ts: now(), message: "Invalid JSON payload" }))
          return
        }
      }

      if (socket.data.role === "worker") {
        handleWorkerEvent(socket, body)
        return
      }

      try {
        const pairingId = socket.data.pairingId

        if (body?.type === "subscribe") {
          let requestedJobId = typeof body?.jobId === "string" ? body.jobId : undefined
          if (requestedJobId) {
            const job = findJobForPairing(requestedJobId, pairingId)
            if (!job) {
              requestedJobId = undefined
            }
          }

          socket.data.jobId = requestedJobId
          socket.send(
            JSON.stringify({
              type: "subscribed",
              ts: now(),
              jobId: socket.data.jobId ?? null,
            }),
          )
          if (socket.data.jobId) {
            const job = findJobForPairing(socket.data.jobId, pairingId)
            if (job) replayHistory(job, (event) => socket.send(JSON.stringify(event)))
          }
          return
        }

        if (body?.type === "execute" || body?.type === "cliExecute") {
          const mode: JobMode = body.type === "execute" ? "shell" : "cli"
          const command = typeof body?.command === "string" ? body.command : ""
          const args = stringArray(body?.args)
          const cwd = typeof body?.cwd === "string" ? body.cwd : undefined
          const env = body?.env
          const interactive = body?.interactive
          const streamFormat = body?.streamFormat
          const thinking = body?.thinking

          const { job, workerId } = dispatchJob({
            mode,
            command,
            args,
            cwd,
            env,
            interactive,
            streamFormat,
            thinking,
            pairingId,
          })

          socket.send(
            JSON.stringify({
              type: "accepted",
              ts: now(),
              job: {
                ...jobInfo(job),
                workerId,
              },
            }),
          )
          return
        }

        if (body?.type === "input") {
          const jobId = typeof body?.jobId === "string" ? body.jobId : ""
          const text = typeof body?.text === "string" ? body.text : ""
          const appendNewline = body?.appendNewline !== false

          const job = findJobForPairing(jobId, pairingId)
          if (!job) throw new Error("Job not found")
          if (job.status !== "running") throw new Error("Job is not running")

          const sent = forwardToJobWorker(jobId, {
            type: "input",
            jobId,
            text,
            appendNewline,
          })
          if (!sent) throw new Error("Assigned worker unavailable")

          const bytes = Buffer.byteLength(appendNewline ? text + "\n" : text)
          fanoutToClients({
            type: "input",
            jobId,
            ts: now(),
            bytes,
          })
          return
        }

        if (body?.type === "terminate") {
          const jobId = typeof body?.jobId === "string" ? body.jobId : ""
          const signal = typeof body?.signal === "string" ? body.signal : undefined

          const job = findJobForPairing(jobId, pairingId)
          if (!job) throw new Error("Job not found")

          const sent = forwardToJobWorker(jobId, {
            type: "terminate",
            jobId,
            signal,
          })
          if (!sent) throw new Error("Assigned worker unavailable")

          fanoutToClients({
            type: "terminate",
            jobId,
            ts: now(),
            signal: signal && /^[A-Z0-9]+$/.test(signal) ? signal : "SIGTERM",
          })
          return
        }

        if (body?.type === "ping") {
          socket.send(JSON.stringify({ type: "pong", ts: now() }))
          return
        }

        if (body?.type === "pong") {
          return
        }

        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        socket.send(JSON.stringify({ type: "error", ts: now(), message }))
      }
    },
  },
})

setInterval(cleanupPairingSessions, 30000).unref()

console.log(`CodeTwin remote broker listening on http://${host}:${port}`)
console.log(`- Auth mode: ${authEnabled ? "secured" : "open"}`)
console.log(`- Pairing mode: ${pairingEnabled ? "enabled" : "disabled"}`)
console.log("- WS /ws (clients)")
console.log("- WS /ws with CodeTwin-Role: worker (workers)")
console.log("- POST /jobs and /cli/exec are brokered to connected workers")

await new Promise(() => {})
server.stop(true)