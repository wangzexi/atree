import { Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import type { Session } from "@opencode-ai/sdk/v2/client"

type AtreeSchedule = {
  cron?: string
  message?: string
  nextRunAt?: number
  lastRunAt?: number
  enabled: boolean
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
}

export function readAtreeSchedule(session?: Pick<Session, "metadata">): AtreeSchedule | undefined {
  const metadata = asRecord(session?.metadata)
  const atree = asRecord(metadata?.atree)
  if (!atree) return

  const raw = atree.schedule
  const config = asRecord(raw)
  const cron = asString(config?.cron) ?? asString(config?.expression) ?? asString(atree.cron) ?? asString(raw)
  const message = asString(config?.message) ?? asString(config?.prompt) ?? asString(atree.scheduledMessage)
  const nextRunAt = asNumber(config?.nextRunAt) ?? asNumber(config?.next)
  const lastRunAt = asNumber(config?.lastRunAt) ?? asNumber(config?.last)
  const enabled = config?.enabled === false || atree.scheduled === false ? false : Boolean(cron || message || raw)

  if (!enabled && !cron && !message) return
  return { cron, message, nextRunAt, lastRunAt, enabled }
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
  schedule: AtreeSchedule
}) {
  const [store, setStore] = createStore({ collapsed: true })
  const status = createMemo(() => (props.schedule.enabled ? "已启用" : "已暂停"))
  const preview = createMemo(() => props.schedule.message || "到点后发送预设消息")
  const next = createMemo(() => formatTime(props.schedule.nextRunAt))
  const toggle = () => setStore("collapsed", (value) => !value)

  return (
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
        <span class="shrink-0 text-13-medium text-text-strong cursor-default">定时发送</span>
        <span class="shrink-0 rounded-full border border-border-weak-base bg-background-muted px-1.5 py-0.5 font-mono text-[11px] leading-4 text-text-base">
          [atree:scheduled]
        </span>
        <span class="shrink-0 rounded-full border border-border-weak-base px-1.5 py-0.5 text-[11px] leading-4 text-text-weak">
          {status()}
        </span>
        <Show when={props.schedule.cron}>
          {(cron) => <span class="shrink-0 font-mono text-[12px] text-text-base">{cron()}</span>}
        </Show>
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
        <div class="px-3 pb-7 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px] leading-5 text-text-base">
          <span class="text-text-weak">下次</span>
          <span>{next()}</span>
          <span class="text-text-weak">上次</span>
          <span>{formatTime(props.schedule.lastRunAt)}</span>
          <span class="text-text-weak">消息</span>
          <span class="min-w-0 truncate">{preview()}</span>
        </div>
      </Show>
    </DockTray>
  )
}
