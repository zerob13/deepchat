import log from 'electron-log'
import { app } from 'electron'
import path from 'path'
import { is } from '@electron-toolkit/utils'

// 配置日志文件路径
if (!is.dev) {
  // 使用logger记录而不是console
  const userData = app?.getPath('userData') || ''
  if (userData) {
    log.transports.file.resolvePathFn = () => path.join(userData, 'logs/main.log')
  }
}

// 配置控制台日志
log.transports.console.level = is.dev ? 'debug' : 'info'

// 配置文件日志
log.transports.file.level = 'info'
log.transports.file.maxSize = 1024 * 1024 * 10 // 10MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'

// 创建不同级别的日志函数
const logger = {
  error: (...params: any[]) => log.error(...params),
  warn: (...params: any[]) => log.warn(...params),
  info: (...params: any[]) => log.info(...params),
  verbose: (...params: any[]) => log.verbose(...params),
  debug: (...params: any[]) => log.debug(...params),
  silly: (...params: any[]) => log.silly(...params),
  log: (...params: any[]) => log.info(...params)
}

// 拦截console方法，重定向到logger
function hookConsole() {
  const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
    trace: console.trace,
    verbose: console.verbose
  }

  // 替换console方法
  console.log = (...args: any[]) => {
    logger.info(...args)
    if (is.dev) {
      originalConsole.log(...args)
    }
  }

  console.error = (...args: any[]) => {
    logger.error(...args)
    if (is.dev) {
      originalConsole.error(...args)
    }
  }

  console.warn = (...args: any[]) => {
    logger.warn(...args)
    if (is.dev) {
      originalConsole.warn(...args)
    }
  }

  console.info = (...args: any[]) => {
    logger.info(...args)
    if (is.dev) {
      originalConsole.info(...args)
    }
  }

  console.debug = (...args: any[]) => {
    logger.debug(...args)
    if (is.dev) {
      originalConsole.debug(...args)
    }
  }

  console.trace = (...args: any[]) => {
    logger.debug(...args)
    if (is.dev) {
      originalConsole.trace(...args)
    }
  }

  console.verbose = (...args: any[]) => {
    logger.verbose(...args)
    if (is.dev && originalConsole.verbose) {
      originalConsole.verbose(...args)
    }
  }

  return originalConsole
}

// 导出原始console方法，以便需要时可以恢复
export const originalConsole = hookConsole()
export default logger
