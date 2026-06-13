import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { createQuery } from "@tanstack/solid-query"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { authTokenFromCredentials } from "@/utils/server"
import { useServer } from "@/context/server"

type ScheduleInfo = {
  id: string
  expression: string
  message: string
  nextRunAt?: number
  lastRunAt?: number
  lastRunStatus?: "ran" | "skipped" | null
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
}

function formatTime(value?: number) {
  if (!value) return "未计算"
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

export function SessionScheduleDock(props: {
  sessionID?: string
}) {
  const server = useServer()
  const [store, setStore] = createStore({ collapsed: true })
  const toggle = () => setStore("collapsed", (value) => !value)
  const query = createQuery(() => ({
    queryKey: ["session", "schedule", server.current?.http.url, props.sessionID],
    enabled: !!server.current && !!props.sessionID,
    refetchInterval: 30_000,
    queryFn: async () => {
      const current = server.current
      if (!current || !props.sessionID) return [] as ScheduleInfo[]
      const url = new URL(`/session/${props.sessionID}/schedule`, current.http.url)
      const headers = new Headers()
      if (current.http.password) {
        headers.set(
          "Authorization",
          `Basic ${authTokenFromCredentials({ username: current.http.username, password: current.http.password })}`,
        )
      }
      const response = await fetch(url, { headers })
      if (!response.ok) throw new Error(`Failed to load schedules: ${response.status}`)
      const json = (await response.json()) as Array<{
        id: string
        expression: string
        message: string
        nextRun?: number | string | null
        lastRanAt?: number | string | null
        lastRunStatus?: "ran" | "skipped" | null
      }>
      return json
        .map((item) => ({
          id: item.id,
          expression: item.expression,
          message: item.message,
          nextRunAt: asNumber(item.nextRun ?? undefined),
          lastRunAt: asNumber(item.lastRanAt ?? undefined),
          lastRunStatus: item.lastRunStatus ?? null,
        }))
        .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))
    },
  }))
  const schedules = createMemo(() => query.data ?? [])
  const primary = createMemo(() => schedules()[0])
  const total = createMemo(() => schedules().length)
  const label = createMemo(() => (total() > 1 ? `定时发送（${total()}）` : "定时发送"))
  const preview = createMemo(() => primary()?.message || "到点后自动发送预设消息")
  const next = createMemo(() => formatTime(primary()?.nextRunAt))

  const visible = createMemo(() => !!props.sessionID && schedules().length > 0)

  return (
    <Show when={visible()}>
      <DockTray
        data-component="session-schedule-dock"
        style={{
          "margin-bottom": "-0.875rem",
          "border-bottom-left-radius": 0,
          "border-bottom-right-radius": 0,
        }}
      >
        <div
          class="pl-3 pr-2 py-2 flex items-center gap-2"
          role="button"
          tabIndex={0}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            toggle()
          }}
        >
          <span class="shrink-0 text-13-medium text-text-strong cursor-default">{label()}</span>
          <span class="shrink-0 text-12-regular text-text-weak">下次 {next()}</span>
          <span class="min-w-0 flex-1 truncate text-13-regular text-text-base cursor-default">{preview()}</span>
          <div class="ml-auto shrink-0">
            <IconButton
              data-collapsed={store.collapsed ? "true" : "false"}
              icon="chevron-down"
              size="normal"
              variant="ghost"
              style={{ transform: `rotate(${store.collapsed ? 180 : 0}deg)` }}
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.stopPropagation()
                toggle()
              }}
              aria-label={store.collapsed ? "展开定时发送详情" : "折叠定时发送详情"}
            />
          </div>
        </div>
        <Show when={store.collapsed}>
          <div class="h-5" aria-hidden="true" />
        </Show>
        <Show when={!store.collapsed}>
          <div class="px-3 pb-7 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">
            <For each={schedules()}>
              {(item) => (
                <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px] leading-5 text-text-base">
                  <span class="text-text-weak">下次</span>
                  <span>{formatTime(item.nextRunAt)}</span>
                  <span class="text-text-weak">消息</span>
                  <span class="min-w-0 truncate">{item.message}</span>
                  <span class="text-text-weak">CRON</span>
                  <span class="font-mono">{item.expression}</span>
                  <span class="text-text-weak">上次</span>
                  <span>
                    {formatTime(item.lastRunAt)}
                    <Show when={item.lastRunStatus === "skipped"}>
                      <span class="text-text-weak">（会话繁忙，已跳过）</span>
                    </Show>
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </DockTray>
    </Show>
  )
}
