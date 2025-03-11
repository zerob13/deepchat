import { app, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { ISyncPresenter, IConfigPresenter, ISQLitePresenter } from '@shared/presenter'
import { eventBus } from '@/eventbus'
import { SYNC_EVENTS } from '@/events'

export class SyncPresenter implements ISyncPresenter {
  private configPresenter: IConfigPresenter
  private sqlitePresenter: ISQLitePresenter
  private isBackingUp: boolean = false
  private backupTimer: NodeJS.Timeout | null = null
  private readonly BACKUP_DELAY = 60 * 1000 // 60秒无变更后触发备份
  private readonly CONFIG_STORE_PATH = path.join(app.getPath('userData'), 'config.json')
  private readonly DB_PATH = path.join(app.getPath('userData'), 'app_db', 'chat.db')

  constructor(configPresenter: IConfigPresenter, sqlitePresenter: ISQLitePresenter) {
    this.configPresenter = configPresenter
    this.sqlitePresenter = sqlitePresenter
    this.init()
  }

  public init(): void {
    // 检查启动时是否需要导入数据
    this.checkStartupImport()

    // 监听数据变更事件，触发备份计划
    this.listenForChanges()
  }

  public destroy(): void {
    // 清理定时器
    if (this.backupTimer) {
      clearTimeout(this.backupTimer)
      this.backupTimer = null
    }
  }

  /**
   * 检查同步文件夹状态
   */
  public async checkSyncFolder(): Promise<{ exists: boolean; path: string }> {
    const syncFolderPath = this.configPresenter.getSyncFolderPath()
    const exists = fs.existsSync(syncFolderPath)

    return { exists, path: syncFolderPath }
  }

  /**
   * 打开同步文件夹
   */
  public async openSyncFolder(): Promise<void> {
    const { exists, path: syncFolderPath } = await this.checkSyncFolder()

    // 如果文件夹不存在，先创建它
    if (!exists) {
      fs.mkdirSync(syncFolderPath, { recursive: true })
    }

    // 打开文件夹
    shell.openPath(syncFolderPath)
  }

  /**
   * 获取备份状态
   */
  public async getBackupStatus(): Promise<{ isBackingUp: boolean; lastBackupTime: number }> {
    const lastBackupTime = this.configPresenter.getLastSyncTime()
    return { isBackingUp: this.isBackingUp, lastBackupTime }
  }

  /**
   * 手动触发备份
   */
  public async startBackup(): Promise<void> {
    if (this.isBackingUp) {
      return
    }

    // 检查同步功能是否启用
    if (!this.configPresenter.getSyncEnabled()) {
      throw new Error('同步功能未启用')
    }

    try {
      await this.performBackup()
    } catch (error: any) {
      console.error('备份失败:', error)
      eventBus.emit(SYNC_EVENTS.BACKUP_ERROR, error.message || '备份过程发生未知错误')
      throw error
    }
  }

  /**
   * 取消备份操作
   */
  public async cancelBackup(): Promise<void> {
    if (this.backupTimer) {
      clearTimeout(this.backupTimer)
      this.backupTimer = null
    }
    this.isBackingUp = false
  }

  /**
   * 从同步文件夹导入数据
   */
  public async importFromSync(): Promise<{ success: boolean; message: string }> {
    // 检查同步文件夹是否存在
    const { exists, path: syncFolderPath } = await this.checkSyncFolder()
    if (!exists) {
      return { success: false, message: '同步文件夹不存在' }
    }

    // 检查是否有备份文件
    const dbBackupPath = path.join(syncFolderPath, 'chat.db')
    const configBackupPath = path.join(syncFolderPath, 'config.json')

    if (!fs.existsSync(dbBackupPath) || !fs.existsSync(configBackupPath)) {
      return { success: false, message: '同步文件夹中没有有效的备份文件' }
    }

    // 发出导入开始事件
    eventBus.emit(SYNC_EVENTS.IMPORT_STARTED)

    try {
      // 关闭数据库连接
      this.sqlitePresenter.close()

      // 备份当前文件
      const tempDbPath = path.join(app.getPath('temp'), `chat_${Date.now()}.db`)
      const tempConfigPath = path.join(app.getPath('temp'), `config_${Date.now()}.json`)

      // 创建临时备份
      if (fs.existsSync(this.DB_PATH)) {
        fs.copyFileSync(this.DB_PATH, tempDbPath)
      }

      if (fs.existsSync(this.CONFIG_STORE_PATH)) {
        fs.copyFileSync(this.CONFIG_STORE_PATH, tempConfigPath)
      }

      try {
        // 复制文件到应用目录
        fs.copyFileSync(dbBackupPath, this.DB_PATH)
        fs.copyFileSync(configBackupPath, this.CONFIG_STORE_PATH)

        eventBus.emit(SYNC_EVENTS.IMPORT_COMPLETED)
        return { success: true, message: '数据导入成功，请重启应用以应用更改' }
      } catch (error: any) {
        console.error('导入文件失败，恢复备份:', error)

        // 恢复备份
        if (fs.existsSync(tempDbPath)) {
          fs.copyFileSync(tempDbPath, this.DB_PATH)
        }

        if (fs.existsSync(tempConfigPath)) {
          fs.copyFileSync(tempConfigPath, this.CONFIG_STORE_PATH)
        }

        eventBus.emit(SYNC_EVENTS.IMPORT_ERROR, error.message || '导入过程发生未知错误')
        return { success: false, message: '导入失败，已恢复原始数据' }
      } finally {
        // 清理临时文件
        if (fs.existsSync(tempDbPath)) {
          fs.unlinkSync(tempDbPath)
        }

        if (fs.existsSync(tempConfigPath)) {
          fs.unlinkSync(tempConfigPath)
        }
      }
    } catch (error: any) {
      console.error('导入过程出错:', error)
      eventBus.emit(SYNC_EVENTS.IMPORT_ERROR, error.message || '导入过程发生未知错误')
      return { success: false, message: '导入过程出错: ' + (error.message || '未知错误') }
    }
  }

  /**
   * 执行实际的备份操作
   */
  private async performBackup(): Promise<void> {
    // 标记备份开始
    this.isBackingUp = true
    eventBus.emit(SYNC_EVENTS.BACKUP_STARTED)

    try {
      const syncFolderPath = this.configPresenter.getSyncFolderPath()

      // 确保同步文件夹存在
      if (!fs.existsSync(syncFolderPath)) {
        fs.mkdirSync(syncFolderPath, { recursive: true })
      }

      // 生成临时备份文件路径（防止导入过程中的文件冲突）
      const tempDbBackupPath = path.join(syncFolderPath, `chat_${Date.now()}.db.tmp`)
      const tempConfigBackupPath = path.join(syncFolderPath, `config_${Date.now()}.json.tmp`)
      const finalDbBackupPath = path.join(syncFolderPath, 'chat.db')
      const finalConfigBackupPath = path.join(syncFolderPath, 'config.json')

      // 备份数据库
      fs.copyFileSync(this.DB_PATH, tempDbBackupPath)

      // 备份配置文件（过滤掉syncFolderPath设置）
      if (fs.existsSync(this.CONFIG_STORE_PATH)) {
        const configContent = fs.readFileSync(this.CONFIG_STORE_PATH, 'utf-8')
        const config = JSON.parse(configContent)

        // 创建配置副本，不包含同步文件夹路径
        const filteredConfig = { ...config }
        if (filteredConfig.syncFolderPath) delete filteredConfig.syncFolderPath

        fs.writeFileSync(tempConfigBackupPath, JSON.stringify(filteredConfig, null, 2), 'utf-8')
      }

      // 重命名临时文件为最终文件
      if (fs.existsSync(finalDbBackupPath)) {
        fs.unlinkSync(finalDbBackupPath)
      }

      if (fs.existsSync(finalConfigBackupPath)) {
        fs.unlinkSync(finalConfigBackupPath)
      }

      fs.renameSync(tempDbBackupPath, finalDbBackupPath)
      fs.renameSync(tempConfigBackupPath, finalConfigBackupPath)

      // 更新最后备份时间
      const now = Date.now()
      this.configPresenter.setLastSyncTime(now)

      // 发送备份完成事件
      eventBus.emit(SYNC_EVENTS.BACKUP_COMPLETED, now)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      console.error('备份过程出错:', error)
      eventBus.emit(SYNC_EVENTS.BACKUP_ERROR, error.message || '备份过程发生未知错误')
      throw error
    } finally {
      // 标记备份结束
      this.isBackingUp = false
    }
  }

  /**
   * 监听数据变更事件，触发备份计划
   */
  private listenForChanges(): void {
    // 监听多种数据变更事件，使用防抖逻辑触发备份
    const scheduleBackup = () => {
      // 如果同步功能未启用，不执行备份
      if (!this.configPresenter.getSyncEnabled()) {
        return
      }

      // 清除现有定时器
      if (this.backupTimer) {
        clearTimeout(this.backupTimer)
      }

      // 设置新的定时器，延迟执行备份
      this.backupTimer = setTimeout(async () => {
        if (!this.isBackingUp) {
          try {
            await this.performBackup()
          } catch (error) {
            console.error('自动备份失败:', error)
          }
        }
      }, this.BACKUP_DELAY)
    }

    // 监听消息相关变更
    eventBus.on('message-added', scheduleBackup)
    eventBus.on('message-updated', scheduleBackup)
    eventBus.on('message-deleted', scheduleBackup)

    // 监听会话相关变更
    eventBus.on('conversation-added', scheduleBackup)
    eventBus.on('conversation-updated', scheduleBackup)
    eventBus.on('conversation-deleted', scheduleBackup)
  }

  /**
   * 检查程序启动时是否需要导入数据
   */
  private async checkStartupImport(): Promise<void> {
    // 在这里可以实现自动导入逻辑
    // 例如检查同步文件夹中是否有比当前更新的备份
    // 这里我们不实现自动导入，因为需求指出导入应该是手动操作
  }
}
