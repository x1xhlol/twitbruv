import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './auth.ts'

// Per-user persisted searches. The query is stored verbatim — including any
// advanced operators like "from:" / "has:media" — so we don't need to
// re-parse on the read path beyond what /api/search already does.
export const savedSearches = pgTable(
  'saved_searches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('saved_searches_user_idx').on(t.userId, t.createdAt),
    check('saved_search_query_len', sql`char_length(${t.query}) BETWEEN 1 AND 200`),
  ],
)
