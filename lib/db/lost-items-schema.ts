import { bigint, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const lostItems = pgTable('lost_items', {
  id: uuid('id').primaryKey().defaultRandom(), userId: text('userId').notNull(), serverId: uuid('serverId').notNull(), eventId: text('eventId').notNull().unique(), playerUuid: text('playerUuid'), playerName: text('playerName'), itemId: text('itemId').notNull(), itemName: text('itemName').notNull(), amount: integer('amount').notNull(), reason: text('reason').notNull(), world: text('world').notNull(), x: integer('x').notNull(), y: integer('y').notNull(), z: integer('z').notNull(), metadata: jsonb('metadata').notNull().default({}), occurredAt: timestamp('occurredAt').notNull(), createdAt: timestamp('createdAt').notNull().defaultNow(),
})

export const operationLogs = pgTable('operation_logs', { id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(), userId: text('userId').notNull(), serverId: uuid('serverId').notNull(), operation: text('operation').notNull(), status: text('status').notNull(), message: text('message'), createdAt: timestamp('createdAt').notNull().defaultNow() })
