import type { Context, Logger as CordisLogger } from 'cordis'
import { NodePlatform } from '@mtcute/node'
import { LogManager } from '@mtcute/core/utils.js'

type LoggerFactory = Context['logger']
type LoggerMethod = 'error' | 'warn' | 'info' | 'debug'

/**
 * Route mtcute's protocol logger through Cordis, preserving mtcute's custom
 * formatters (%h/%e/...) while letting Cordis control exporters and levels.
 */
export function createCordisLogManager(factory: LoggerFactory): LogManager {
  const manager = new LogManager('mtproto', new NodePlatform())
  const loggers = new Map<string, CordisLogger>()

  // Let Cordis perform the final level filtering. In particular, mtcute's
  // VERBOSE and DEBUG messages both become Cordis debug messages.
  manager.level = LogManager.VERBOSE
  manager.handler = (_color, level, tag, format, args) => {
    const name = tag === 'mtproto' ? 'mtproto' : `mtproto/${tag}`
    let logger = loggers.get(name)
    if (!logger) {
      logger = factory(name)
      loggers.set(name, logger)
    }
    logger[levelMethod(level)](format, ...args)
  }
  return manager
}

function levelMethod(level: number): LoggerMethod {
  if (level <= LogManager.ERROR) return 'error'
  if (level === LogManager.WARN) return 'warn'
  if (level === LogManager.INFO) return 'info'
  return 'debug'
}
