import { bigint, boolean, jsonb, pgTable, real, text, timestamp, unique, uuid, integer } from 'drizzle-orm/pg-core'

export const user = pgTable('user', { id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(), emailVerified: boolean('emailVerified').notNull().default(false), image: text('image'), role: text('role').notNull().default('member'), approved: boolean('approved').notNull().default(false), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow() })
export const session = pgTable('session', { id: text('id').primaryKey(), expiresAt: timestamp('expiresAt').notNull(), token: text('token').notNull().unique(), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow(), ipAddress: text('ipAddress'), userAgent: text('userAgent'), userId: text('userId').notNull().references(() => user.id, { onDelete: 'cascade' }) })
export const account = pgTable('account', { id: text('id').primaryKey(), accountId: text('accountId').notNull(), providerId: text('providerId').notNull(), issuer: text('issuer'), userId: text('userId').notNull().references(() => user.id, { onDelete: 'cascade' }), accessToken: text('accessToken'), refreshToken: text('refreshToken'), idToken: text('idToken'), accessTokenExpiresAt: timestamp('accessTokenExpiresAt'), refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'), scope: text('scope'), password: text('password'), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow() })
export const verification = pgTable('verification', { id: text('id').primaryKey(), identifier: text('identifier').notNull(), value: text('value').notNull(), expiresAt: timestamp('expiresAt').notNull(), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow() })
export const nodes = pgTable('nodes', { id: uuid('id').primaryKey().defaultRandom(), userId: text('userId').notNull(), name: text('name').notNull(), agentTokenHash: text('agentTokenHash').notNull().unique(), status: text('status').notNull().default('offline'), lastHeartbeat: timestamp('lastHeartbeat'), cpuPercent: real('cpuPercent').notNull().default(0), memoryUsedMb: integer('memoryUsedMb').notNull().default(0), memoryTotalMb: integer('memoryTotalMb').notNull().default(0), diskUsedGb: real('diskUsedGb').notNull().default(0), diskTotalGb: real('diskTotalGb').notNull().default(0), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow() })
export const servers = pgTable('servers', { id: uuid('id').primaryKey().defaultRandom(), userId: text('userId').notNull(), nodeId: uuid('nodeId').notNull(), name: text('name').notNull(), loader: text('loader').notNull(), mcVersion: text('mcVersion').notNull(), loaderVersion: text('loaderVersion'), memoryMb: integer('memoryMb').notNull().default(4096), port: integer('port').notNull().default(25565), status: text('status').notNull().default('stopped'), installProgress: integer('installProgress').notNull().default(0), installError: text('installError'), playerCount: integer('playerCount').notNull().default(0), pid: integer('pid'), worldName: text('worldName').notNull().default('world'), itemTrackingEnabled: boolean('itemTrackingEnabled').notNull().default(false), javaArgs: text('javaArgs').notNull().default(''), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow() })
export const worlds = pgTable('worlds', { id: uuid('id').primaryKey().defaultRandom(), userId: text('userId').notNull(), serverId: uuid('serverId').notNull(), name: text('name').notNull(), seed: text('seed'), isActive: boolean('isActive').notNull().default(false), sizeMb: real('sizeMb').notNull().default(0), lastBackupAt: timestamp('lastBackupAt'), createdAt: timestamp('createdAt').notNull().defaultNow() })
export const mods = pgTable('mods', { id: uuid('id').primaryKey().defaultRandom(), userId: text('userId').notNull(), serverId: uuid('serverId').notNull(), filename: text('filename').notNull(), blobPathname: text('blobPathname').notNull(), sha256: text('sha256').notNull(), enabled: boolean('enabled').notNull().default(true), uploadedBy: text('uploadedBy').notNull(), createdAt: timestamp('createdAt').notNull().defaultNow() })
export const backups = pgTable('backups', { id: uuid('id').primaryKey().defaultRandom(), userId: text('userId').notNull(), worldId: uuid('worldId').notNull(), blobPathname: text('blobPathname').notNull(), sizeMb: real('sizeMb').notNull().default(0), sizeBytes: bigint('sizeBytes', { mode: 'number' }).notNull().default(0), createdBy: text('createdBy').notNull(), createdAt: timestamp('createdAt').notNull().defaultNow() })
export const serverPermissions = pgTable('server_permissions', { id: uuid('id').primaryKey().defaultRandom(), userId: text('userId').notNull(), ownerUserId: text('ownerUserId').notNull(), serverId: uuid('serverId').notNull(), canStart: boolean('canStart').notNull().default(false), canStop: boolean('canStop').notNull().default(false), canRestart: boolean('canRestart').notNull().default(false), canConsole: boolean('canConsole').notNull().default(false), canFiles: boolean('canFiles').notNull().default(false), canBackup: boolean('canBackup').notNull().default(false), canReset: boolean('canReset').notNull().default(false), canViewLostItems: boolean('canViewLostItems').notNull().default(false), canManageLostItems: boolean('canManageLostItems').notNull().default(false), sections: jsonb('sections').$type<string[]>().notNull().default([]), createdAt: timestamp('createdAt').notNull().defaultNow() }, (t) => [unique().on(t.userId, t.serverId)])

export const serverSftp = pgTable('server_sftp', { id: uuid('id').primaryKey().defaultRandom(), serverId: uuid('serverId').notNull().unique(), nodeId: uuid('nodeId').notNull(), username: text('username').notNull(), passwordHash: text('passwordHash').notNull(), port: integer('port').notNull().default(22), rootPath: text('rootPath').notNull(), status: text('status').notNull().default('queued'), lastError: text('lastError'), lastTestAt: timestamp('lastTestAt'), passwordRotatedAt: timestamp('passwordRotatedAt'), disabledAt: timestamp('disabledAt'), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow() })

export const uploadSessions = pgTable('upload_sessions', { id: uuid('id').primaryKey().defaultRandom(), uploadId: uuid('uploadId').notNull().unique(), commandId: uuid('commandId').notNull(), userId: text('userId').notNull(), serverId: uuid('serverId').notNull(), nodeId: uuid('nodeId').notNull(), filename: text('filename').notNull(), totalSize: bigint('totalSize', { mode: 'number' }).notNull(), chunkSize: integer('chunkSize').notNull(), totalParts: integer('totalParts').notNull(), receivedParts: jsonb('receivedParts').$type<number[]>().notNull().default([]), receivedBytes: bigint('receivedBytes', { mode: 'number' }).notNull().default(0), status: text('status').notNull().default('starting'), createdAt: timestamp('createdAt').notNull().defaultNow(), lastActivityAt: timestamp('lastActivityAt').notNull().defaultNow(), completedAt: timestamp('completedAt'), error: text('error') })

export const serverSchedules = pgTable('server_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('userId').notNull(),
  serverId: uuid('serverId').notNull(),
  name: text('name').notNull(),
  taskType: text('taskType').notNull(),
  cadence: text('cadence').notNull().default('daily'),
  timeOfDay: text('timeOfDay'),
  weekday: integer('weekday'),
  intervalMinutes: integer('intervalMinutes'),
  timezoneOffsetMinutes: integer('timezoneOffsetMinutes').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  payload: jsonb('payload').notNull().default({}),
  lastRunAt: timestamp('lastRunAt'),
  nextRunAt: timestamp('nextRunAt').notNull(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const managedDatabases = pgTable('managed_databases', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('userId').notNull(),
  serverId: uuid('serverId').notNull(),
  nodeId: uuid('nodeId').notNull(),
  engine: text('engine').notNull().default('mariadb'),
  databaseName: text('databaseName').notNull(),
  databaseUser: text('databaseUser').notNull(),
  host: text('host').notNull().default('127.0.0.1'),
  port: integer('port').notNull().default(3306),
  credentialsPath: text('credentialsPath'),
  status: text('status').notNull().default('queued'),
  lastError: text('lastError'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
}, (t) => [
  unique().on(t.serverId, t.databaseName),
  unique().on(t.serverId, t.databaseUser),
])


export const serverSettings = pgTable('server_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('serverId').notNull().unique(),
  userId: text('userId').notNull(),
  settings: jsonb('settings').$type<Record<string, string | number | boolean>>().notNull().default({}),
  capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
  updatedBy: text('updatedBy').notNull(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const auditLog = pgTable('audit_log', { id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(), userId: text('userId').notNull(), action: text('action').notNull(), resourceType: text('resourceType').notNull(), resourceId: text('resourceId'), details: jsonb('details').notNull().default({}), createdAt: timestamp('createdAt').notNull().defaultNow() })
export const agentCommands = pgTable('agent_commands', { id: uuid('id').primaryKey().defaultRandom(), userId: text('userId').notNull(), nodeId: uuid('nodeId').notNull(), serverId: uuid('serverId'), type: text('type').notNull(), payload: jsonb('payload').notNull().default({}), status: text('status').notNull().default('queued'), result: jsonb('result'), createdAt: timestamp('createdAt').notNull().defaultNow(), completedAt: timestamp('completedAt') })
export const consoleLogs = pgTable('console_logs', { id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(), userId: text('userId').notNull(), serverId: uuid('serverId').notNull(), stream: text('stream').notNull().default('stdout'), line: text('line').notNull(), createdAt: timestamp('createdAt').notNull().defaultNow() })


export const supportConsents = pgTable('support_consents', {
  userId: text('userId').primaryKey(),
  version: text('version').notNull(),
  acceptedAt: timestamp('acceptedAt').notNull().defaultNow(),
})

export const supportThreads = pgTable('support_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  subject: text('subject').notNull(),
  priority: text('priority').notNull().default('normal'),
  creatorUserId: text('creatorUserId').notNull(),
  targetUserId: text('targetUserId'),
  assignedUserId: text('assignedUserId'),
  createdByRole: text('createdByRole').notNull().default('member'),
  acceptedAt: timestamp('acceptedAt'),
  closedAt: timestamp('closedAt'),
  closedBy: text('closedBy'),
  lastMessageAt: timestamp('lastMessageAt').notNull().defaultNow(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const supportMessages = pgTable('support_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('threadId').notNull(),
  senderUserId: text('senderUserId').notNull(),
  body: text('body').notNull().default(''),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
})

export const supportAttachments = pgTable('support_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  threadId: uuid('threadId').notNull(),
  messageId: uuid('messageId').notNull(),
  uploaderUserId: text('uploaderUserId').notNull(),
  pathname: text('pathname').notNull(),
  url: text('url').notNull().default(''),
  filename: text('filename').notNull(),
  contentType: text('contentType').notNull(),
  sizeBytes: bigint('sizeBytes', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
})

export { lostItems, operationLogs } from './lost-items-schema'
