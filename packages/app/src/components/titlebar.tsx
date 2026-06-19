import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  startTransition,
  Switch,
  untrack,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"

import { LayoutRoute, useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { WindowsAppMenu } from "./windows-app-menu"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { useServerSync } from "@/context/server-sync"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { nextSessionMetadata, sessionEmoji, sessionEmojiOptions, sortedRootSessions } from "@/pages/layout/helpers"
import { makeEventListener } from "@solid-primitives/event-listener"
import {
  notifySessionTabsRemoved,
  readSessionTabsRemovedDetail,
  SESSION_TABS_REMOVED_EVENT,
} from "@/components/titlebar-session-events"
import { useGlobal } from "@/context/global"
import { decodeDirectory64, decode64 } from "@/utils/base64"
import { ServerConnection, useServer } from "@/context/server"
import { tabHref, tabKey, useTabs, type Tab } from "@/context/tabs"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"
import {
  archiveSessionWithSchedules,
  listSessionSchedules,
  type SessionScheduleSummary,
} from "@/utils/session-schedule"

type TauriDesktopWindow = {
  startDragging?: () => Promise<void>
  toggleMaximize?: () => Promise<void>
}

type TauriThemeWindow = {
  setTheme?: (theme?: "light" | "dark" | null) => Promise<void>
}

type TauriApi = {
  window?: {
    getCurrentWindow?: () => TauriDesktopWindow
  }
  webviewWindow?: {
    getCurrentWebviewWindow?: () => TauriThemeWindow
  }
}

const tauriApi = () => (window as unknown as { __TAURI__?: TauriApi }).__TAURI__
const currentDesktopWindow = () => tauriApi()?.window?.getCurrentWindow?.()
const currentThemeWindow = () => tauriApi()?.webviewWindow?.getCurrentWebviewWindow?.()
const legacyTitlebarHeight = 40
const v2TitlebarHeight = 36
const minTitlebarZoom = 0.25
const windowsControlsBaseWidth = 138 // 3 native Windows caption buttons at 46px each.

export type TitlebarUpdate = {
  version: () => string | undefined
  installing: () => boolean
  install: () => void
}

export function Titlebar(props: { update?: TitlebarUpdate }) {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const theme = useTheme()
  const server = useServer()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const useV2Titlebar = createMemo(() => settings.general.newLayoutDesigns())

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const electronWindows = createMemo(() => windows() && !tauriApi())
  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const web = createMemo(() => platform.platform === "web")
  const zoom = () => platform.webviewZoom?.() ?? 1
  const titlebarZoom = () => (windows() ? Math.max(zoom(), minTitlebarZoom) : zoom())
  const counterZoom = () => (windows() && titlebarZoom() < 1 ? 1 / titlebarZoom() : 1)
  const minHeight = () => {
    const height = useV2Titlebar() ? v2TitlebarHeight : legacyTitlebarHeight
    if (mac()) return `${height / zoom()}px`
    if (windows()) return `${height / Math.min(titlebarZoom(), 1)}px`
    return undefined
  }
  const windowsControlsWidth = () => `${windowsControlsBaseWidth / Math.max(titlebarZoom(), 1)}px`

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`
  const creating = createMemo(() => {
    if (!params.dir) return false
    if (params.id) return false
    const parts = location.pathname.replace(/\/+$/, "").split("/")
    return parts.at(-1) === "session"
  })

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const canBack = createMemo(() => history.index > 0)
  const canForward = createMemo(() => history.index < history.stack.length - 1)
  const hasProjects = createMemo(() => layout.projects.list().length > 0)
  const nav = createMemo(() => (useV2Titlebar() ? settings.general.showNavigation() : true))
  const updateState = createMemo<TitlebarUpdatePillState>(() => {
    const installing = props.update?.installing() ?? false
    const version = props.update?.version()
    return {
      visible: version !== undefined || installing,
      installing,
      label: "Update",
      ariaLabel: language.t("toast.update.action.installRestart"),
      title: version ? `Update ${version}` : undefined,
      onInstall: () => props.update?.install(),
    }
  })
  const v2RightState = createMemo<TitlebarV2RightState>(() => ({
    update: updateState(),
  }))

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  const getWin = () => {
    if (platform.platform !== "desktop") return
    return currentDesktopWindow()
  }

  createEffect(() => {
    if (platform.platform !== "desktop") return

    const scheme = theme.colorScheme()
    const value = scheme === "system" ? null : scheme

    const win = currentThemeWindow()
    if (!win?.setTheme) return

    void win.setTheme(value).catch(() => undefined)
  })

  const interactive = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false

    const selector =
      "button, a, input, textarea, select, option, [role='button'], [role='menuitem'], [contenteditable='true'], [contenteditable='']"

    return !!target.closest(selector)
  }

  const drag = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (e.buttons !== 1) return
    if (interactive(e.target)) return

    const win = getWin()
    if (!win?.startDragging) return

    e.preventDefault()
    void win.startDragging().catch(() => undefined)
  }

  const maximize = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (interactive(e.target)) return
    if (e.target instanceof Element && e.target.closest("[data-tauri-decorum-tb]")) return

    const win = getWin()
    if (!win?.toggleMaximize) return

    e.preventDefault()
    void win.toggleMaximize().catch(() => undefined)
  }

  return (
    <header
      classList={{
        "shrink-0 relative flex flex-row": true,
        "h-9 bg-v2-background-bg-deep overflow-visible": useV2Titlebar(),
        "h-10 bg-background-base overflow-hidden": !useV2Titlebar(),
      }}
      style={{
        "min-height": minHeight(),
        "padding-left": mac() ? `${84 / zoom()}px` : 0,
        width: electronWindows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        "max-width": electronWindows()
          ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))`
          : undefined,
        "align-self": electronWindows() ? "flex-start" : undefined,
      }}
      data-tauri-drag-region
      onMouseDown={drag}
      onDblClick={maximize}
    >
      <Switch>
        <Match when={useV2Titlebar()}>
          {(_) => {
            const serverSync = useServerSync()
            const navigate = useNavigate()
            const layout = useLayout()
            const global = useGlobal()

            const newSessionHref = () => {
              if (params.dir) return `/${params.dir}/session`

              const project = layout.projects.list()[0]
              if (!project) return "/"

              return `/${base64Encode(project.worktree)}/session`
            }

            const tabs = useTabs()
            const tabsStore = tabs.store
            const tabsStoreActions = tabs
            const [archiveVersion, setArchiveVersion] = createSignal(0)
            const [archiveConfirmKey, setArchiveConfirmKey] = createSignal<string>()
            let archiveConfirmTimer: ReturnType<typeof setTimeout> | undefined
            const refreshArchivedSessions = () => setArchiveVersion((value) => value + 1)
            const requireArchiveConfirm = (key: string) => {
              setArchiveConfirmKey(key)
              if (archiveConfirmTimer) clearTimeout(archiveConfirmTimer)
              archiveConfirmTimer = setTimeout(() => setArchiveConfirmKey(undefined), 4_000)
            }
            onCleanup(() => {
              if (archiveConfirmTimer) clearTimeout(archiveConfirmTimer)
            })
            const navigateTab = (tab: Tab) => {
              const href = tabHref(tab)
              if (tab.server === server.key) {
                navigate(href)
                return
              }
              void startTransition(() => {
                server.setActive(tab.server)
                navigate(href)
              })
            }
            const closeTab = (tab: Tab | undefined) => {
              if (!tab) return
              const index = tabsStore.findIndex((item) => tabKey(item) === tabKey(tab))
              if (index === -1) return
              if (tab.type === "draft") {
                tabsStoreActions.removeTab(index)
                return
              }

              const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
              const directory = decode64(tab.dirBase64)
              if (!conn || !directory) {
                tabsStoreActions.removeTab(index)
                return
              }

              const serverCtx = global.createServerCtx(conn)
              const key = tabKey(tab)
              void (async () => {
                const schedules = await listSessionSchedules(conn, tab.sessionId).catch(
                  () => [] as SessionScheduleSummary[],
                )
                if (schedules.length > 0 && archiveConfirmKey() !== key) {
                  requireArchiveConfirm(key)
                  return
                }
                setArchiveConfirmKey(undefined)
                await archiveSessionWithSchedules({
                  current: conn,
                  directory,
                  sessionID: tab.sessionId,
                  schedules,
                  updateSession: (payload) => serverCtx.sdk.client.session.update(payload),
                })
                const [, setDirectoryStore] = serverCtx.sync.child(directory)
                setDirectoryStore(
                  produce((draft) => {
                    const index = draft.session.findIndex((session) => session.id === tab.sessionId)
                    if (index !== -1) draft.session.splice(index, 1)
                  }),
                )
                refreshArchivedSessions()
                tabsStoreActions.removeTab(index)
                notifySessionTabsRemoved({ directory, sessionIDs: [tab.sessionId] })
              })()
            }

            const matchRoute = (route: LayoutRoute) => {
              if (route.type === "home") return
              if (route.type === "draft") {
                return tabsStore.find((item) => item.type === "draft" && item.draftID === route.draftID)
              }
              if (route.type === "session") {
                const main = tabsStore.find(
                  (item) =>
                    item.type === "session" && item.server === route.server && item.sessionId === route.sessionId,
                )
                if (main) return main
                const sync = serverSync.createDirSyncContext(route.dir)
                const session = sync.session.get(route.sessionId)
                if (session?.parentID) {
                  const parentID = session.parentID
                  const parent = tabsStore.find(
                    (item) => item.type === "session" && item.server === route.server && item.sessionId === parentID,
                  )
                  if (parent) return parent
                }
              }
            }

            const currentTab = () => matchRoute(layout.route())
            const currentTabKey = () => {
              const tab = currentTab()
              return tab ? tabKey(tab) : undefined
            }
            const isCurrentTab = (tab: Tab) => currentTabKey() === tabKey(tab)
            let restoreDirectoryRun = 0
            createEffect(() => {
              const route = layout.route()
              if (!tabs.ready()) return
              if (route.type === "session") {
                const currentServer = route.server ?? server.key
                const run = ++restoreDirectoryRun
                void (async () => {
                  const ensureRouteSessionTab = () => {
                    const sync = serverSync.createDirSyncContext(route.dir)
                    const routeSession = sync.session.get(route.sessionId)
                    if (!routeSession) return
                    const targetSessionId = routeSession.parentID ?? routeSession.id
                    const routeTabExists = tabsStore.find(
                      (item) =>
                        item.type === "session" &&
                        item.server === currentServer &&
                        item.dirBase64 === route.dirBase64 &&
                        item.sessionId === targetSessionId,
                    )
                    if (!routeTabExists) {
                      tabsStoreActions.addSessionTab({
                        server: currentServer,
                        dirBase64: route.dirBase64,
                        sessionId: targetSessionId,
                      })
                    }
                  }

                  await serverSync.project.loadSessions(route.dir)
                  if (run !== restoreDirectoryRun) return

                  const [directoryStore] = serverSync.child(route.dir, { bootstrap: false })
                  const sync = serverSync.createDirSyncContext(route.dir)
                  const routeSession = sync.session.get(route.sessionId)
                  const sessionId = routeSession?.parentID ?? routeSession?.id ?? route.sessionId
                  const sessions = sortedRootSessions(
                    { session: directoryStore.session, path: { directory: route.dir } },
                    Date.now(),
                  )

                  if (sessions.length > 0) {
                    tabsStoreActions.replaceDirectorySessions(currentServer, route.dir, sessions)
                    ensureRouteSessionTab()
                    return
                  }

                  if (!routeSession) return
                  // If this session is not in the directory's root sessions,
                  // ensure at least its corresponding root session tab exists.
                  tabsStoreActions.addSessionTab({
                    server: currentServer,
                    dirBase64: route.dirBase64,
                    sessionId,
                  })
                })()
                return
              }

              const tab = currentTab()
              if (tab) return
            })

            makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
              const detail = readSessionTabsRemovedDetail(event)
              if (!detail) return
              tabsStoreActions.removeSessions(detail)
            })

            const currentDirectory = createMemo(() => {
              if (params.dir) return decodeDirectory64(params.dir)
              const current = currentTab()
              if (current?.type === "draft") return current.directory
              if (current?.type === "session") return decode64(current.dirBase64)
            })
            const currentServerKey = createMemo(() => {
              const route = layout.route()
              if (route.type !== "home") return route.server ?? server.key
              return currentTab()?.server
            })
            const tabDirectory = (tab: Tab) =>
              tab.type === "draft" ? tab.directory : (decode64(tab.dirBase64) ?? undefined)
            const visibleTabs = createMemo(() => {
              const directory = currentDirectory()
              const currentServer = currentServerKey()
              if (!directory || !currentServer) return [] as Tab[]
              const group = tabs.directoryGroup()
              const groupActive =
                group?.server === currentServer && pathKey(group.directory) === pathKey(directory)
              if (groupActive) {
                return tabsStore.filter(
                  (tab) => tab.server === currentServer && pathKey(tabDirectory(tab) ?? "") === pathKey(directory),
                )
              }
              const current = currentTab()
              return current &&
                current.server === currentServer &&
                pathKey(tabDirectory(current) ?? "") === pathKey(directory)
                ? [current]
                : []
            })
            const currentDirectoryDraft = createMemo(() => {
              const directory = currentDirectory()
              const currentServer = currentServerKey()
              if (!directory) return
              if (!currentServer) return
              return tabsStore.find(
                (tab) =>
                  tab.type === "draft" && tab.server === currentServer && pathKey(tab.directory) === pathKey(directory),
              )
            })

            const openNewTab = () => navigate(newSessionHref())

            command.register("tabs", () => {
              const current = currentTab()

              return [
                {
                  id: "tab.new",
                  category: "tab",
                  title: language.t("command.session.new"),
                  keybind: "mod+t",
                  hidden: true,
                  onSelect: openNewTab,
                },
                current && {
                  id: "tab.close",
                  category: "tab",
                  title: language.t("command.tab.close"),
                  keybind: "mod+w",
                  hidden: true,
                  onSelect: () => closeTab(current),
                },
                {
                  id: `tab.prev`,
                  category: "tab",
                  title: "",
                  keybind: `mod+option+ArrowLeft`,
                  hidden: true,
                  onSelect: () => {
                    const groupTabs = visibleTabs()
                    const currentKey = currentTabKey()
                    let index = currentKey ? groupTabs.findIndex((tab) => tabKey(tab) === currentKey) : -1
                    if (index === -1) return

                    index -= 1
                    if (index === -1) index = groupTabs.length - 1

                    const next = groupTabs[index]
                    if (next) navigateTab(next)
                  },
                },
                {
                  id: `tab.next`,
                  category: "tab",
                  title: "",
                  keybind: `mod+option+ArrowRight`,
                  hidden: true,
                  onSelect: () => {
                    const groupTabs = visibleTabs()
                    const currentKey = currentTabKey()
                    let index = currentKey ? groupTabs.findIndex((tab) => tabKey(tab) === currentKey) : -1
                    if (index === -1) return

                    index += 1
                    if (index === groupTabs.length) index = 0

                    const next = groupTabs[index]
                    if (next) navigateTab(next)
                  },
                },
                ...Array.from({ length: 9 }, (_, i) => {
                  const index = i
                  const number = index + 1
                  return {
                    id: `tab.${number}`,
                    category: "tab",
                    title: "",
                    keybind: `mod+${number}`,
                    disabled: visibleTabs().length <= index,
                    hidden: true,
                    onSelect: () => {
                      const tab = visibleTabs()[index]
                      if (tab) navigateTab(tab)
                    },
                  }
                }),
              ].filter((v) => v !== undefined)
            })

            const [tabsAreOverflowing, setTabsAreOverflowing] = createSignal(false)
            let tabScrollRef!: HTMLDivElement

            const openCurrentDirectoryDraft = () => {
              const directory = currentDirectory()
              if (!directory) return
              const existing = currentDirectoryDraft()
              if (existing?.type === "draft") {
                navigateTab(existing)
                return
              }
              tabsStoreActions.newDraft({
                server: server.key,
                directory,
              })
            }

            function refreshTabsAreOverflowing() {
              setTabsAreOverflowing(tabScrollRef.scrollWidth > tabScrollRef.clientWidth)
            }

            return (
              <div
                class="h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 pr-3 pt-2"
                classList={{
                  "pl-2": mac(),
                  "pl-4": !mac(),
                }}
              >
                <Show when={windows() || linux()}>
                  <WindowsAppMenu command={command} platform={platform} variant="v2" />
                </Show>
                <div
                  class="flex min-w-0 flex-row items-center gap-1.5 overflow-x-auto no-scrollbar [app-region:no-drag]"
                  ref={tabScrollRef}
                >
                  <div class="flex min-w-0 flex-row items-center gap-1.5">
                    <For each={visibleTabs()}>
                      {(tab, i) => {
                        let ref!: HTMLDivElement

                        onMount(() => {
                          refreshTabsAreOverflowing()
                        })

                        const divider = () =>
                          i() !== 0 && (
                            <div class="w-[1.5px] h-3 shrink-0 rounded-full bg-[var(--v2-background-bg-layer-02)]" />
                          )

                        if (tab.type === "draft") {
                          return (
                            <>
                              {divider()}
                              <DraftTabItem
                                ref={ref}
                                href={tabHref(tab)}
                                title={language.t("command.session.new")}
                                active={isCurrentTab(tab)}
                                onNavigate={() => {
                                  navigateTab(tab)
                                  ref.scrollIntoView({ behavior: "instant" })
                                }}
                              />
                            </>
                          )
                        }

                        return (
                          <>
                            {divider()}
                            <TabNavItem
                              ref={ref}
                              href={tabHref(tab)}
                              server={tab.server}
                              directory={decode64(tab.dirBase64)!}
                              sessionId={tab.sessionId}
                              onNavigate={() => {
                                navigateTab(tab)

                                ref.scrollIntoView({ behavior: "instant" })
                              }}
                              onClose={() => closeTab(tab)}
                              active={isCurrentTab(tab)}
                              archiveConfirm={archiveConfirmKey() === tabKey(tab)}
                              forceTruncate={tabsAreOverflowing()}
                            />
                          </>
                        )
                      }}
                    </For>
                    <Show when={currentDirectory() && !currentDirectoryDraft()}>
                      <>
                        <Show when={visibleTabs().length > 0}>
                          <div class="w-[1.5px] h-3 shrink-0 rounded-full bg-[var(--v2-background-bg-layer-02)]" />
                        </Show>
                        <DraftTabItem
                          href="#"
                          title={language.t("command.session.new")}
                          active={false}
                          onNavigate={openCurrentDirectoryDraft}
                        />
                      </>
                    </Show>
                  </div>
                </div>
                <div class="flex-1" />
                <Show when={currentDirectory()} keyed>
                  {(directory) => (
                    <ArchivedSessionsMenu
                      serverKey={server.key}
                      directory={directory}
                      version={archiveVersion()}
                      onChanged={refreshArchivedSessions}
                    />
                  )}
                </Show>
                <Tooltip placement="bottom" value={language.t("command.fileTree.toggle")} openDelay={600}>
                  <IconButtonV2
                    size="small"
                    variant="ghost-muted"
                    icon={<IconV2 name="sidebar-right" />}
                    aria-label={language.t("command.fileTree.toggle")}
                    onClick={() => layout.fileTree.toggle()}
                  />
                </Tooltip>
                <TitlebarV2Right state={v2RightState()} />
                <Show when={windows() && !electronWindows()}>
                  <div data-tauri-decorum-tb class="flex flex-row" />
                </Show>
              </div>
            )
          }}
        </Match>
        <Match when>
          <div
            class="grid h-full min-h-full w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
            style={{ zoom: counterZoom() }}
          >
            <div
              classList={{
                "flex items-center min-w-0": true,
                "pl-2": !mac(),
              }}
            >
              <Show when={windows() || linux()}>
                <WindowsAppMenu command={command} platform={platform} />
              </Show>
              <Show when={mac()}>
                {/*<div class="h-full shrink-0" style={{ width: `${72 / zoom()}px` }} />*/}
                <div class="xl:hidden w-10 shrink-0 flex items-center justify-center">
                  <IconButton
                    icon="menu"
                    variant="ghost"
                    class="titlebar-icon rounded-md"
                    onClick={layout.mobileSidebar.toggle}
                    aria-label={language.t("sidebar.menu.toggle")}
                    aria-expanded={layout.mobileSidebar.opened()}
                  />
                </div>
              </Show>
              <Show when={!mac()}>
                <div class="xl:hidden w-[48px] shrink-0 flex items-center justify-center">
                  <IconButton
                    icon="menu"
                    variant="ghost"
                    class="titlebar-icon rounded-md"
                    onClick={layout.mobileSidebar.toggle}
                    aria-label={language.t("sidebar.menu.toggle")}
                    aria-expanded={layout.mobileSidebar.opened()}
                  />
                </div>
              </Show>
              <div class="flex items-center gap-1 shrink-0">
                <TooltipKeybind
                  class={web() ? "hidden xl:flex shrink-0 ml-14" : "hidden xl:flex shrink-0 ml-2"}
                  placement="bottom"
                  title={language.t("command.sidebar.toggle")}
                  keybind={command.keybind("sidebar.toggle")}
                >
                  <Button
                    variant="ghost"
                    class="group/sidebar-toggle titlebar-icon w-8 h-6 p-0 box-border"
                    onClick={layout.sidebar.toggle}
                    aria-label={language.t("command.sidebar.toggle")}
                    aria-expanded={layout.sidebar.opened()}
                  >
                    <Icon size="small" name={layout.sidebar.opened() ? "sidebar-active" : "sidebar"} />
                  </Button>
                </TooltipKeybind>
                <div class="hidden xl:flex items-center shrink-0">
                  <Show when={params.dir}>
                    <div
                      class="flex items-center shrink-0 w-8 mr-1"
                      aria-hidden={layout.sidebar.opened() ? "true" : undefined}
                    >
                      <div
                        class="transition-opacity"
                        classList={{
                          "opacity-100 duration-120 ease-out": !layout.sidebar.opened(),
                          "opacity-0 duration-120 ease-in delay-0 pointer-events-none": layout.sidebar.opened(),
                        }}
                      >
                        <TooltipKeybind
                          placement="bottom"
                          title={language.t("command.session.new")}
                          keybind={command.keybind("session.new")}
                          openDelay={2000}
                        >
                          <Button
                            variant="ghost"
                            icon={creating() ? "new-session-active" : "new-session"}
                            class="titlebar-icon w-8 h-6 p-0 box-border"
                            disabled={layout.sidebar.opened()}
                            tabIndex={layout.sidebar.opened() ? -1 : undefined}
                            onClick={() => {
                              if (!params.dir) return
                              navigate(`/${params.dir}/session`)
                            }}
                            aria-label={language.t("command.session.new")}
                            aria-current={creating() ? "page" : undefined}
                          />
                        </TooltipKeybind>
                      </div>
                    </div>
                  </Show>
                  <div
                    class="flex items-center shrink-0"
                    classList={{
                      "-translate-x-[36px]": layout.sidebar.opened() && !!params.dir,
                      "duration-180 ease-out": !layout.sidebar.opened(),
                      "duration-180 ease-in": layout.sidebar.opened(),
                    }}
                  >
                    <Show when={hasProjects() && nav()}>
                      <div class="flex items-center gap-0 transition-transform">
                        <Tooltip placement="bottom" value={language.t("common.goBack")} openDelay={2000}>
                          <Button
                            variant="ghost"
                            icon="chevron-left"
                            class="titlebar-icon w-6 h-6 p-0 box-border"
                            disabled={!canBack()}
                            onClick={back}
                            aria-label={language.t("common.goBack")}
                          />
                        </Tooltip>
                        <Tooltip placement="bottom" value={language.t("common.goForward")} openDelay={2000}>
                          <Button
                            variant="ghost"
                            icon="chevron-right"
                            class="titlebar-icon w-6 h-6 p-0 box-border"
                            disabled={!canForward()}
                            onClick={forward}
                            aria-label={language.t("common.goForward")}
                          />
                        </Tooltip>
                      </div>
                    </Show>
                    <div id="opencode-titlebar-left" class="flex items-center gap-3 min-w-0 px-2" />
                    <ChannelIndicator />
                  </div>
                </div>
              </div>
            </div>

            <div class="min-w-0 flex items-center justify-center pointer-events-none">
              <div
                id="opencode-titlebar-center"
                class="pointer-events-auto min-w-0 flex justify-center w-fit max-w-full"
              />
            </div>

            <div
              classList={{
                "flex items-center min-w-0 justify-end": true,
                "pr-2": !windows(),
              }}
              data-tauri-drag-region
              onMouseDown={drag}
            >
              <div id="opencode-titlebar-right" class="flex items-center gap-1 shrink-0 justify-end" />
              <Show when={windows()}>
                {!tauriApi() && <div class="shrink-0" style={{ width: windowsControlsWidth() }} />}
                <div data-tauri-decorum-tb class="flex flex-row" />
              </Show>
            </div>
          </div>
        </Match>
      </Switch>
    </header>
  )
}

type TitlebarUpdatePillState = {
  visible: boolean
  installing: boolean
  label: string
  ariaLabel: string
  title?: string
  onInstall: () => void
}

type TitlebarV2RightState = {
  update: TitlebarUpdatePillState
}

function TitlebarV2Right(props: { state: TitlebarV2RightState }) {
  return (
    <div class="relative z-20 flex shrink-0 items-center justify-end gap-0 overflow-visible">
      <Show when={props.state.update.visible}>
        <TitlebarUpdateIconButton state={props.state.update} />
      </Show>
      <div id="opencode-titlebar-right" class="flex shrink-0 items-center justify-end gap-0" />
    </div>
  )
}

function TitlebarUpdateIconButton(props: { state: TitlebarUpdatePillState }) {
  return (
    <div class="relative isolate mr-3 size-5 shrink-0">
      <button
        type="button"
        class="group absolute right-0 top-0 z-10 flex h-5 w-5 items-center justify-end overflow-hidden rounded-full bg-v2-icon-icon-accent/20 text-v2-icon-icon-accent transition-[width,background-color] duration-150 ease-out hover:z-30 hover:w-[68px] hover:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] focus-visible:z-30 focus-visible:w-[68px] focus-visible:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] focus-visible:outline-none disabled:opacity-60 motion-reduce:transition-none"
        onClick={props.state.onInstall}
        disabled={props.state.installing}
        aria-busy={props.state.installing}
        aria-label={props.state.ariaLabel}
      >
        <span class="shrink-0 ml-[8px] mr-px text-[11px] text-v2-text-text-accent [font-weight:530] opacity-0 translate-x-2 motion-safe:transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-x-0 group-focus-visible:opacity-100 group-focus-visible:translate-x-0 motion-reduce:translate-x-0">
          Update
        </span>
        <span class="flex size-5 shrink-0 items-center justify-center">
          <Show
            when={!props.state.installing}
            fallback={<span data-slot="titlebar-update-loader" aria-hidden="true" />}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128" stroke="currentColor" />
            </svg>
          </Show>
        </span>
      </button>
    </div>
  )
}

function TabNavItem(props: {
  ref?: HTMLDivElement
  href: string
  server: ServerConnection.Key
  directory: string
  sessionId?: string
  hideClose?: boolean
  onClose: () => void
  onNavigate: () => void
  active?: boolean
  archiveConfirm?: boolean
  forceTruncate?: boolean
}) {
  const closeTab = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }
  const global = useGlobal()
  const serverCtx = createMemo(() => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    if (conn) return global.createServerCtx(conn)
  })
  const dirSyncCtx = createMemo(() => serverCtx()?.sync.createDirSyncContext(props.directory))

  const [session] = createResource(
    () => {
      const ctx = dirSyncCtx()
      if (!ctx || !props.sessionId) return
      return [props.sessionId, ctx] as const
    },
    async ([sessionId, dirSyncCtx]) => {
      await dirSyncCtx.session.sync(sessionId).catch(() => {})
      return dirSyncCtx.session.get(sessionId)
    },
    { initialValue: props.sessionId ? dirSyncCtx()?.session.get(props.sessionId) : undefined },
  )

  return (
    <div
      ref={props.ref}
      data-atree-session-tab
      data-session-id={props.sessionId}
      class="group relative flex h-7 w-9 shrink-0 flex-row items-center justify-start overflow-hidden whitespace-nowrap rounded-[6px] bg-[var(--tab-bg)] px-1.5 transition-[width,background-color] duration-150 ease-out [--tab-bg:var(--v2-background-bg-deep)] hover:w-[52px] hover:[--tab-bg:var(--v2-background-bg-layer-02)] data-[active='true']:[--tab-bg:var(--v2-background-bg-layer-02)] focus-within:w-[52px] motion-reduce:transition-none"
      data-active={props.active}
      onMouseDown={(event) => {
        if (event.button !== 1) return
        closeTab(event)
      }}
      onClick={(event) => {
        event.preventDefault()
        props.onNavigate()
      }}
    >
      <Show when={session.latest}>
        {(session) => {
          return (
            <Tooltip placement="bottom" value={session().title || "会话"} openDelay={0}>
              <div class="flex size-6 shrink-0 items-center justify-center">
                <SessionEmojiPicker
                  session={session()}
                  directory={props.directory}
                  serverCtx={serverCtx()}
                  enabled={props.active}
                />
              </div>
            </Tooltip>
          )
        }}
      </Show>

      <div
        class="pointer-events-none absolute inset-y-0 right-0 flex w-6 flex-row items-center py-1 pl-0.5 pr-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
        data-truncate={props.forceTruncate}
      >
        <div
          class="absolute inset-0 rounded-r-[6px] bg-(image:--inactive-bg) group-hover:bg-(image:--active-bg) group-focus-within:bg-(image:--active-bg)"
          style={{
            "--inactive-bg": "linear-gradient(to right, transparent 0%, var(--tab-bg) 55%)",
            "--active-bg": "linear-gradient(90deg, transparent 0%, var(--tab-bg) 40%)",
          }}
        />
        <Tooltip
          value={props.archiveConfirm ? "再次点击归档并取消自动化消息" : "归档会话"}
          placement="bottom"
          openDelay={0}
        >
          <IconButtonV2
            size="small"
            variant="ghost-muted"
            class="z-10 opacity-0 transition-[opacity,color,background-color] duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
            classList={{
              "text-red-500 hover:bg-red-500/10": props.archiveConfirm,
            }}
            aria-label={props.archiveConfirm ? "再次点击归档并取消自动化消息" : "归档会话"}
            onClick={closeTab}
            icon={<IconV2 name="xmark-small" />}
          />
        </Tooltip>
      </div>
    </div>
  )
}

function ArchivedSessionsMenu(props: {
  serverKey: ServerConnection.Key
  directory: string
  version: number
  onChanged: () => void
}) {
  const global = useGlobal()
  const navigate = useNavigate()
  const tabs = useTabs()
  const server = useServer()
  const serverSync = useServerSync()
  const serverCtx = createMemo(() => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.serverKey)
    if (conn) return global.createServerCtx(conn)
  })
  const [sessions, { refetch, mutate }] = createResource(
    () => [serverCtx(), props.directory, props.version] as const,
    async ([serverCtx, directory]) => {
      if (!serverCtx) return [] as Session[]
      const result = await serverCtx.sdk.client.session.list({ directory, roots: true, archived: true })
      return (result.data ?? [])
        .filter((session) => !session.parentID && !!session.time?.archived)
        .sort((a, b) => (b.time.archived ?? 0) - (a.time.archived ?? 0))
    },
    { initialValue: [] as Session[] },
  )
  const visibleSessions = createMemo(() => {
    const openSessionIds = new Set<string>()
    for (const tab of tabs.store) {
      if (tab.type !== "session") continue
      if (tab.server !== props.serverKey) continue
      if (decode64(tab.dirBase64) !== props.directory) continue
      openSessionIds.add(tab.sessionId)
    }
    return (sessions() ?? []).filter((session) => !openSessionIds.has(session.id))
  })
  const count = createMemo(() => visibleSessions().length)
  const relativeSessionTime = (session: Session) => {
    const time = session.time.updated ?? session.time.created
    const diffSeconds = Math.round((time - Date.now()) / 1000)
    const absolute = Math.abs(diffSeconds)
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
    if (absolute < 60) return formatter.format(diffSeconds, "second")
    const diffMinutes = Math.round(diffSeconds / 60)
    if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, "minute")
    const diffHours = Math.round(diffMinutes / 60)
    if (Math.abs(diffHours) < 24) return formatter.format(diffHours, "hour")
    const diffDays = Math.round(diffHours / 24)
    if (Math.abs(diffDays) < 30) return formatter.format(diffDays, "day")
    const diffMonths = Math.round(diffDays / 30)
    if (Math.abs(diffMonths) < 12) return formatter.format(diffMonths, "month")
    return formatter.format(Math.round(diffMonths / 12), "year")
  }

  const openSession = async (session: Session) => {
    const ctx = serverCtx()
    if (!ctx) return
    await ctx.sdk.client.session.update({
      directory: props.directory,
      sessionID: session.id,
      time: { archived: null } as unknown as { archived?: number },
    })
    const restored = {
      ...session,
      time: { ...session.time },
    } as Session
    delete (restored.time as { archived?: number }).archived
    const [directoryStore, setDirectoryStore] = serverSync.child(props.directory)
    const alreadyVisible = directoryStore.session.some((item) => item.id === restored.id)
    setDirectoryStore("session", (list: Session[]) => {
      const next = list.slice()
      const existing = next.findIndex((item) => item.id === restored.id)
      if (existing >= 0) {
        next[existing] = restored
        return next
      }
      const insertAt = next.findIndex((item) => item.id > restored.id)
      if (insertAt === -1) return [...next, restored]
      next.splice(insertAt, 0, restored)
      return next
    })
    if (!alreadyVisible && !restored.parentID) {
      setDirectoryStore("sessionTotal", (value) => value + 1)
    }
    mutate((items) => items.filter((item) => item.id !== session.id))
    props.onChanged()
    void refetch()
    tabs.addSessionTab({
      server: props.serverKey,
      dirBase64: base64Encode(props.directory),
      sessionId: session.id,
    })
    const href = `/${base64Encode(props.directory)}/session/${session.id}`
    if (props.serverKey === server.key) {
      navigate(href)
      return
    }
    void startTransition(() => {
      server.setActive(props.serverKey)
      navigate(href)
    })
  }

  return (
    <DropdownMenu gutter={4} placement="bottom-end">
      <DropdownMenu.Trigger
        class="relative flex size-7 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--v2-border-border-focus)]"
        aria-label="归档会话"
        title="归档会话"
      >
        <ArchiveIcon />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="w-[260px] p-1">
          <Show
            when={visibleSessions().length > 0}
            fallback={<div class="px-2 py-2 text-[12px] leading-5 text-v2-text-text-muted">没有归档会话</div>}
          >
            <div class="px-2 py-1 text-[11px] leading-4 text-v2-text-text-muted">归档会话</div>
            <For each={visibleSessions()}>
              {(session) => (
                <DropdownMenu.Item
                  class="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-v2-overlay-simple-overlay-hover data-[highlighted]:bg-v2-overlay-simple-overlay-hover data-[highlighted]:outline-none"
                  onSelect={() => void openSession(session)}
                >
                  <span class="shrink-0 text-[14px] leading-none">{sessionEmoji(session)}</span>
                  <DropdownMenu.ItemLabel class="min-w-0 flex-1">
                    <span class="block min-w-0 truncate text-[13px] leading-5 text-v2-text-text-base">
                      {session.title || "未命名会话"}
                    </span>
                  </DropdownMenu.ItemLabel>
                  <span class="shrink-0 text-right text-[11px] leading-5 text-v2-text-text-faint">
                    {relativeSessionTime(session)}
                  </span>
                </DropdownMenu.Item>
              )}
            </For>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

function SessionEmojiPicker(props: {
  session: Session
  directory: string
  serverCtx?: ReturnType<ReturnType<typeof useGlobal>["createServerCtx"]>
  enabled?: boolean
}) {
  const [optimisticEmoji, setOptimisticEmoji] = createSignal<string>()
  const currentEmoji = () => optimisticEmoji() ?? sessionEmoji(props.session)

  createEffect(() => {
    setOptimisticEmoji(undefined)
    sessionEmoji(props.session)
  })

  const updateEmoji = async (emoji: string) => {
    const client = props.serverCtx?.sdk.client
    if (!client) return
    const previous = currentEmoji()
    setOptimisticEmoji(emoji)
    try {
      const updated = await client.session.update({
        directory: props.directory,
        sessionID: props.session.id,
        metadata: nextSessionMetadata(props.session, emoji),
      })
      if (updated.data) setOptimisticEmoji(sessionEmoji(updated.data))
    } catch (error) {
      setOptimisticEmoji(previous)
      throw error
    }
  }

  return (
    <Show
      when={props.enabled}
      fallback={
        <span class="flex size-5 shrink-0 items-center justify-center text-[14px] leading-none">{currentEmoji()}</span>
      }
    >
      <DropdownMenu gutter={4} placement="bottom-start">
        <DropdownMenu.Trigger
          class="flex size-5 shrink-0 items-center justify-center rounded text-[14px] leading-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--v2-border-border-focus)]"
          aria-label="设置会话图标"
          onClick={(event) => event.stopPropagation()}
        >
          {currentEmoji()}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="grid w-[184px] grid-cols-6 gap-1 p-1">
            <For each={sessionEmojiOptions}>
              {(emoji) => (
                <DropdownMenu.Item
                  class="flex size-7 items-center justify-center rounded-md text-[17px] hover:bg-v2-overlay-simple-overlay-hover data-[highlighted]:bg-v2-overlay-simple-overlay-hover data-[highlighted]:outline-none"
                  onSelect={() => void updateEmoji(emoji)}
                >
                  <DropdownMenu.ItemLabel>{emoji}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              )}
            </For>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}

function DraftTabItem(props: {
  ref?: HTMLDivElement
  href: string
  title: string
  active?: boolean
  onNavigate: () => void
}) {
  return (
    <div
      ref={props.ref}
      data-active={props.active}
      class="group relative flex h-7 w-9 shrink-0 flex-row items-center justify-start overflow-hidden whitespace-nowrap rounded-[6px] bg-[var(--tab-bg)] px-1.5 transition-[background-color] duration-150 ease-out [--tab-bg:var(--v2-background-bg-deep)] hover:[--tab-bg:var(--v2-background-bg-layer-02)] data-[active='true']:[--tab-bg:var(--v2-background-bg-layer-02)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--v2-border-border-focus)] motion-reduce:transition-none"
    >
      <a
        href={props.href}
        onClick={(event) => {
          event.preventDefault()
          props.onNavigate()
        }}
        title={props.title}
        aria-label={props.title}
        class="flex size-6 shrink-0 items-center justify-center text-v2-text-text-faint group-data-[active='true']:text-[var(--v2-text-text-base)]"
      >
        <span class="flex size-4 shrink-0 items-center justify-center">
          <SquarePenIcon />
        </span>
      </a>
    </div>
  )
}

export function SquarePenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" />
    </svg>
  )
}

function ArchiveIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  )
}

function ChannelIndicator() {
  return (
    <>
      {["beta", "dev"].includes(import.meta.env.VITE_OPENCODE_CHANNEL) && (
        <div class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono">
          {import.meta.env.VITE_OPENCODE_CHANNEL.toUpperCase()}
        </div>
      )}
    </>
  )
}
