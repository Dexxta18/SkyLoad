import { pino } from 'pino'
import { config } from '../config.js'

export const log = pino({
  level: process.env.LOG_LEVEL ?? (config.isProduction ? 'info' : 'debug'),
  transport: config.isProduction || process.env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
})
