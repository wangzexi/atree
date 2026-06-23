import { expect, test } from "bun:test"
import { scopedSessionOptions } from "@/cli/cmd/session"

test("scopes session CLI commands to the current instance directory", () => {
  expect(scopedSessionOptions({ directory: "/tmp/atree-node" } as any)).toEqual({ directory: "/tmp/atree-node" })
})

test("leaves session CLI commands unscoped without an instance directory", () => {
  expect(scopedSessionOptions(undefined)).toEqual({})
  expect(scopedSessionOptions({ directory: "" } as any)).toEqual({})
})
