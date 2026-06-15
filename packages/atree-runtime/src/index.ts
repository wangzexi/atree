import { handle } from "./server"

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const hostname = arg("--hostname", "127.0.0.1")
const port = Number(arg("--port", "4196"))

Bun.serve({
  hostname,
  port,
  fetch: handle,
})

console.log(`atree runtime listening on http://${hostname}:${port}`)

