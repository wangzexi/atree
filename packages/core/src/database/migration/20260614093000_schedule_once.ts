import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260614093000_schedule_once",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`schedule\` ADD \`kind\` text DEFAULT 'recurring' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`schedule\` ADD \`run_at\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
