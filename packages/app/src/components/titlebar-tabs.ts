import type { Tab } from "@/context/tabs"
import { pathKey } from "@/utils/path-key"

export type TitlebarDirectoryGroup = {
  server: string
  directory: string
}

export function visibleDirectoryTabs(input: {
  tabs: readonly Tab[]
  current?: Tab
  currentDirectory?: string
  currentServer?: string
  directoryGroup?: TitlebarDirectoryGroup
  tabDirectory: (tab: Tab) => string | undefined
}) {
  const directory = input.currentDirectory
  const currentServer = input.currentServer
  if (!directory || !currentServer) return [] as Tab[]

  const groupActive =
    input.directoryGroup?.server === currentServer && pathKey(input.directoryGroup.directory) === pathKey(directory)

  if (groupActive) {
    return input.tabs.filter(
      (tab) => tab.server === currentServer && pathKey(input.tabDirectory(tab) ?? "") === pathKey(directory),
    )
  }

  const current = input.current
  return current &&
    current.server === currentServer &&
    pathKey(input.tabDirectory(current) ?? "") === pathKey(directory)
    ? [current]
    : []
}
