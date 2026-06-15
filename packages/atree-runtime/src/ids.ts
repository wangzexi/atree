import { randomBytes } from "node:crypto"

export function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`
}

export function eventID() {
  return id("evt")
}

