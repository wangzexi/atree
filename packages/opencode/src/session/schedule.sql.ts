import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionID } from "./schema"

export const ScheduleTable = sqliteTable(
  "schedule",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull(),
    kind: text().$type<"once" | "recurring">().notNull().default("recurring"),
    expression: text().notNull(),
    run_at: integer(),
    message: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [index("schedule_session_idx").on(table.session_id)],
)

export const ScheduleRunTable = sqliteTable(
  "schedule_run",
  {
    id: text().primaryKey(),
    schedule_id: text()
      .notNull()
      .references(() => ScheduleTable.id, { onDelete: "cascade" }),
    ran_at: integer().notNull(),
    status: text().notNull(),
  },
  (table) => [index("schedule_run_idx").on(table.schedule_id, table.ran_at)],
)
