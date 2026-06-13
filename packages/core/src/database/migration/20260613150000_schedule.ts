import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260613150000_schedule",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`schedule\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL,
          \`expression\` text NOT NULL,
          \`message\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_schedule_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`schedule_session_idx\` ON \`schedule\` (\`session_id\`);`)
      yield* tx.run(`
        CREATE TABLE \`schedule_run\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`schedule_id\` text NOT NULL,
          \`ran_at\` integer NOT NULL,
          \`status\` text NOT NULL,
          CONSTRAINT \`fk_schedule_run_schedule_id_schedule_id_fk\` FOREIGN KEY (\`schedule_id\`) REFERENCES \`schedule\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`schedule_run_idx\` ON \`schedule_run\` (\`schedule_id\`,\`ran_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
