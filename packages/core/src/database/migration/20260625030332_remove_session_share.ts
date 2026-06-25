import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260625030332_remove_session_share",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE IF EXISTS \`session_share\`;`)
      const hasShareUrl = (yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session\`)`)).some(
        (column) => column.name === "share_url",
      )
      if (hasShareUrl) {
        yield* tx.run(`ALTER TABLE \`session\` DROP COLUMN \`share_url\`;`)
      }
    })
  },
} satisfies DatabaseMigration.Migration
