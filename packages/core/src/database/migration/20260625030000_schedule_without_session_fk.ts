import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260625030000_schedule_without_session_fk",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("PRAGMA foreign_keys = OFF;")
      yield* tx.run("ALTER TABLE `schedule_run` RENAME TO `schedule_run_old`;")
      yield* tx.run("ALTER TABLE `schedule` RENAME TO `schedule_old`;")
      yield* tx.run(`
        CREATE TABLE \`schedule\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL,
          \`kind\` text DEFAULT 'recurring' NOT NULL,
          \`expression\` text NOT NULL,
          \`run_at\` integer,
          \`message\` text NOT NULL,
          \`created_at\` integer NOT NULL
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
      yield* tx.run(`
        INSERT INTO \`schedule\` (\`id\`, \`session_id\`, \`kind\`, \`expression\`, \`run_at\`, \`message\`, \`created_at\`)
        SELECT \`id\`, \`session_id\`, \`kind\`, \`expression\`, \`run_at\`, \`message\`, \`created_at\`
        FROM \`schedule_old\`;
      `)
      yield* tx.run(`
        INSERT INTO \`schedule_run\` (\`id\`, \`schedule_id\`, \`ran_at\`, \`status\`)
        SELECT \`id\`, \`schedule_id\`, \`ran_at\`, \`status\`
        FROM \`schedule_run_old\`;
      `)
      yield* tx.run("DROP TABLE `schedule_run_old`;")
      yield* tx.run("DROP TABLE `schedule_old`;")
      yield* tx.run("PRAGMA foreign_keys = ON;")
    })
  },
} satisfies DatabaseMigration.Migration
