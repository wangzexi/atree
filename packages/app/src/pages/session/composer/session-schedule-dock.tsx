import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionKey } from "@/pages/session/session-layout"
import { decode64 } from "@/utils/base64"
import {
  extractSessionScheduleEventSessionID,
  type SessionScheduleSummary,
  sortSessionSchedulesByNextRun,
  deleteSessionSchedules,
  listSessionSchedules,
} from "@/utils/session-schedule"

function formatTime(value?: number) {
  if (!value) return "未计算"
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

function formatRelativeTime(value: number | null | undefined, now: number) {
  if (!value) return "未计算"
  const seconds = Math.max(0, Math.ceil((value - now) / 1000))
  if (seconds <= 0) return "即将发送"
  if (seconds > 12 * 60 * 60) return formatTime(value)
  if (seconds < 60) return `${seconds} 秒后`
  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes < 60) return restSeconds ? `${minutes} 分 ${restSeconds} 秒后` : `${minutes} 分钟后`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes ? `${hours} 小时 ${restMinutes} 分后` : `${hours} 小时后`
}

export function SessionScheduleDock(props: {
  sessionID?: string
}) {
  const server = useServer()
  const serverSDK = useServerSDK()
  const route = useSessionKey()
  const queryClient = useQueryClient()
  const [store, setStore] = createStore({ collapsed: true })
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(clock))
  const toggle = () => setStore("collapsed", (value) => !value)
  const directory = createMemo(() => decode64(route.params.dir))
  const queryKey = createMemo(() => ["session", "schedule", server.current?.http.url, directory(), props.sessionID])
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKey() })
  const stopScheduleEvents = serverSDK.event.listen((event) => {
    if (extractSessionScheduleEventSessionID(event.details) !== props.sessionID) return
    void refresh()
  })
  onCleanup(stopScheduleEvents)
  const query = createQuery(() => ({
    queryKey: queryKey(),
    enabled: !!server.current && !!directory() && !!props.sessionID,
    refetchInterval: 30_000,
    queryFn: async () => {
      const current = server.current
      const currentDirectory = directory()
      if (!current || !currentDirectory || !props.sessionID) return [] as SessionScheduleSummary[]
      const schedules = await listSessionSchedules(current, currentDirectory, props.sessionID)
      return sortSessionSchedulesByNextRun(schedules)
    },
  }))
  const removeSchedule = useMutation(() => ({
    mutationFn: async (scheduleID: string) => {
      const current = server.current
      const currentDirectory = directory()
      if (!current || !currentDirectory || !props.sessionID) return
      await deleteSessionSchedules(current, currentDirectory, props.sessionID, [{ id: scheduleID }])
    },
    onSuccess: refresh,
  }))
  const schedules = createMemo(() => query.data ?? [])
  const primary = createMemo(() => schedules()[0])
  const preview = createMemo(() => primary()?.message || "到点后自动发送预设消息")
  const next = createMemo(() => formatRelativeTime(primary()?.nextRunAt, now()))

  const visible = createMemo(() => !!props.sessionID && schedules().length > 0)

  return (
    <Show when={visible()}>
      <DockTray
        data-component="session-schedule-dock"
        style={{
          "margin-left": "0.75rem",
          "margin-right": "0.75rem",
          "margin-bottom": "-1px",
          "border-bottom": "0",
          "border-bottom-left-radius": 0,
          "border-bottom-right-radius": 0,
          "background-color": "var(--surface-raised-stronger-non-alpha)",
          "box-shadow": "none",
          opacity: "0.78",
          "z-index": 0,
        }}
      >
        <div
          class="h-9 px-3"
          role="button"
          tabIndex={0}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            toggle()
          }}
        >
          <div class="h-full min-w-0 flex items-center gap-2">
            <div class="min-w-0 flex flex-1 items-center gap-1.5">
              <span class="shrink-0 inline-flex items-center text-icon-weak">
                <Icon name="bot" size="small" class="text-icon-weak" />
              </span>
              <span class="min-w-0 flex-1 truncate text-13-regular leading-5 text-text-weak [font-weight:400] cursor-default">
                自动化消息 · {next()} · {preview()}
              </span>
            </div>
            <Tooltip value="删除定时器" placement="top" openDelay={0}>
              <IconButton
                icon="trash-2"
                size="small"
                variant="ghost"
                disabled={removeSchedule.isPending}
                aria-label="删除定时器"
                class="size-4 shrink-0 opacity-60 hover:opacity-100 [&_[data-slot=icon-svg]]:size-3"
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  const schedule = primary()
                  if (!schedule) return
                  removeSchedule.mutate(schedule.id)
                }}
              />
            </Tooltip>
          </div>
        </div>
        <Show when={!store.collapsed}>
          <div class="px-3 pb-3 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">
            <For each={schedules()}>
              {(item) => (
                <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px] leading-5 text-text-weak [font-weight:400]">
                  <span>{item.kind === "once" ? "一次" : "周期"}</span>
                  <span class={item.kind === "once" ? undefined : "font-mono"}>
                    {item.kind === "once" ? "仅运行一次" : item.expression}
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
