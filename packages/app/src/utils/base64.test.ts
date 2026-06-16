import { describe, expect, test } from "bun:test"
import { decodeDirectory64, decode64 } from "./base64"

describe("decode64", () => {
  test("keeps any base64 encoded payload", () => {
    expect(decode64("c2Vzc2lvbg")).toBe("session")
  })
})

describe("decodeDirectory64", () => {
  test("accepts absolute unix paths", () => {
    expect(decodeDirectory64("L1VzZXJzL3pleGkvZGVza3RvcA")).toBe("/Users/zexi/desktop")
  })

  test("accepts absolute windows paths", () => {
    expect(decodeDirectory64("QzovVGVzdA")).toBe("C:/Test")
  })

  test("rejects non-absolute decoded payloads", () => {
    expect(decodeDirectory64("c2Vzc2lvbg")).toBeUndefined()
  })
})
