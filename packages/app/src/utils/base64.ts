import { base64Decode } from "@opencode-ai/core/util/encode"

const isAbsoluteDirectory = (value: string) =>
  value === "/" ||
  value.startsWith("/") ||
  /^[A-Za-z]:[\\/]/.test(value) ||
  value.startsWith("\\\\")

export function decode64(value: string | undefined) {
  if (value === undefined) return
  try {
    return base64Decode(decodeURIComponent(value))
  } catch {
    return
  }
}

export function decodeDirectory64(value: string | undefined) {
  const decoded = decode64(value)
  if (!decoded || !isAbsoluteDirectory(decoded)) return
  return decoded
}
