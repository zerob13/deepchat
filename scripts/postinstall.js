import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs-extra'
import os from 'os'
import { promisify } from 'util'
import { exec } from 'child_process'
import axios from 'axios'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream'
import tar from 'tar'

const pipelineAsync = promisify(pipeline)
const execAsync = promisify(exec)

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 默认 Node.js 版本
const DEFAULT_NODE_VERSION = 'v22.9.0'

// 获取目标目录
const runtimeDir = path.resolve(__dirname, '../resources/mcp/runtime')
const nodeDir = path.join(runtimeDir, 'node')

/**
 * 检查是否已经下载过指定平台和架构的Node.js
 * @param {string} platform 平台
 * @param {string} arch 架构
 * @param {string} version Node.js版本
 * @returns {Promise<boolean>} 是否已下载
 */
async function isNodeAlreadyInstalled(platform, arch, version) {
  try {
    // 检查标记文件
    const markerFile = path.join(nodeDir, `${platform}_${arch}`)

    if (await fs.pathExists(markerFile)) {
      const installedVersion = await fs.readFile(markerFile, 'utf8')

      // 检查版本是否匹配
      if (installedVersion.trim() === version) {
        // 再检查node可执行文件是否存在
        const nodeBin =
          platform === 'win32' ? path.join(nodeDir, 'node.exe') : path.join(nodeDir, 'bin', 'node')

        if (await fs.pathExists(nodeBin)) {
          try {
            // 尝试运行node -v 检查版本
            const nodePath = nodeBin.replace(/(\s+)/g, '\\$1') // 处理路径中的空格
            const { stdout } = await execAsync(`"${nodePath}" -v`)

            if (stdout.trim() === version) {
              console.log(`已检测到 Node.js ${version} (${platform}-${arch})，跳过下载`)
              return true
            }
          } catch (err) {
            // 执行失败，可能是权限问题或文件损坏
            console.log(`Node.js 执行测试失败，将重新下载: ${err.message}`)
          }
        }
      }
    }

    return false
  } catch (error) {
    console.error('检查Node.js安装状态失败:', error)
    return false
  }
}

/**
 * 创建标记文件
 * @param {string} platform 平台
 * @param {string} arch 架构
 * @param {string} version Node.js版本
 */
async function createMarkerFile(platform, arch, version) {
  const markerFile = path.join(nodeDir, `${platform}_${arch}`)
  await fs.writeFile(markerFile, version)
  console.log(`创建标记文件: ${markerFile}`)
}

/**
 * 获取平台标识符，用于下载对应版本
 */
function getPlatformIdentifier(platform, arch) {
  // 将 arch 转为字符串以避免类型错误
  const archStr = String(arch)

  // 针对不同平台返回对应的标识符
  if (platform === 'darwin') {
    return archStr === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  } else if (platform === 'linux') {
    // 支持更多Linux架构
    if (archStr === 'arm64') {
      return 'linux-arm64'
    } else if (archStr === 'arm' || archStr === 'armv7l') {
      return 'linux-armv7l'
    } else if (archStr === 'ppc64' || archStr === 'ppc64le') {
      return 'linux-ppc64le'
    } else if (archStr === 's390' || archStr === 's390x') {
      return 'linux-s390x'
    } else {
      // 默认x64架构
      return 'linux-x64'
    }
  } else if (platform === 'win32') {
    // 支持Windows的不同架构
    if (archStr === 'arm64') {
      return 'win-arm64'
    } else if (archStr === 'ia32' || archStr === 'x86') {
      return 'win-x86'
    } else {
      return 'win-x64'
    }
  }

  throw new Error(`不支持的平台: ${platform}-${archStr}`)
}

/**
 * 下载文件
 */
async function downloadFile(url, destination) {
  console.log(`正在下载: ${url}`)
  await fs.ensureDir(path.dirname(destination))

  try {
    // 创建写入流
    const writer = createWriteStream(destination)

    // 发送GET请求
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    })

    // 使用pipeline将响应流写入文件
    await pipelineAsync(response.data, writer)

    console.log(`文件已下载到: ${destination}`)
  } catch (error) {
    console.error('下载失败:', error)
    throw error
  }
}

/**
 * 解压tar.gz文件
 */
async function extractTarGz(filePath, destination) {
  console.log(`正在解压: ${filePath}`)
  await fs.ensureDir(destination)
  await tar.extract({
    file: filePath,
    cwd: destination
  })

  console.log(`文件已解压到: ${destination}`)
}

/**
 * 解压zip文件，使用系统unzip命令
 */
async function extractZip(filePath, destination) {
  console.log(`正在解压: ${filePath}`)
  await fs.ensureDir(destination)

  try {
    // 使用系统自带的unzip命令解压
    if (process.platform === 'win32') {
      // Windows上使用PowerShell的Expand-Archive命令
      await execAsync(
        `powershell -command "Expand-Archive -Path '${filePath}' -DestinationPath '${destination}' -Force"`
      )
    } else {
      // macOS和Linux上使用unzip命令
      await execAsync(`unzip -o "${filePath}" -d "${destination}"`)
    }

    console.log(`ZIP文件已解压到: ${destination}`)
  } catch (error) {
    console.error('解压失败:', error)
    throw error
  }
}

/**
 * 主函数
 */
async function main() {
  try {
    // 获取 npm 配置的平台和架构，如果没有则使用当前系统的
    const platform = process.env.npm_config_platform || process.platform
    const arch = process.env.npm_config_arch || process.arch
    const nodeVersion = process.env.NODE_VERSION || DEFAULT_NODE_VERSION

    console.log(`检查 Node.js ${nodeVersion} 用于 ${platform}-${arch}`)

    // 确保目录存在
    await fs.ensureDir(nodeDir)

    // 检查是否已安装
    if (await isNodeAlreadyInstalled(platform, arch, nodeVersion)) {
      return
    }

    console.log(`准备下载 Node.js ${nodeVersion} 用于 ${platform}-${arch}`)

    // 构建下载URL
    const platformId = getPlatformIdentifier(platform, arch)
    const fileExtension = platform === 'win32' ? 'zip' : 'tar.gz'
    const fileName = `node-${nodeVersion}-${platformId}.${fileExtension}`
    const downloadUrl = `https://nodejs.org/dist/${nodeVersion}/${fileName}`

    // 创建临时目录
    const tempDir = path.join(os.tmpdir(), 'deepchat-node-runtime-temp')
    const downloadPath = path.join(tempDir, fileName)

    // 确保临时目录存在
    await fs.ensureDir(tempDir)

    // 下载文件
    await downloadFile(downloadUrl, downloadPath)

    // 清空目标目录
    await fs.emptyDir(nodeDir)

    // 解压文件
    const extractedDir = path.join(tempDir, 'extracted')
    await fs.ensureDir(extractedDir)

    if (platform === 'win32') {
      await extractZip(downloadPath, extractedDir)
    } else {
      await extractTarGz(downloadPath, extractedDir)
    }

    // 找到解压后的目录
    const nodeDirName = `node-${nodeVersion}-${platformId}`
    const extractedNodeDir = path.join(extractedDir, nodeDirName)

    // 将内容移动到目标目录 (不带版本号)
    const files = await fs.readdir(extractedNodeDir)
    for (const file of files) {
      const srcPath = path.join(extractedNodeDir, file)
      const destPath = path.join(nodeDir, file)
      await fs.move(srcPath, destPath, { overwrite: true })
    }

    // 设置可执行权限（仅Linux和macOS）
    if (platform !== 'win32') {
      const binDir = path.join(nodeDir, 'bin')
      if (await fs.pathExists(binDir)) {
        const binFiles = await fs.readdir(binDir)
        for (const file of binFiles) {
          const filePath = path.join(binDir, file)
          const stats = await fs.stat(filePath)
          if (stats.isFile()) {
            await fs.chmod(filePath, 0o755)
          }
        }
      }
    }

    // 创建标记文件
    await createMarkerFile(platform, arch, nodeVersion)

    // 清理临时文件
    await fs.remove(tempDir)

    console.log(`Node.js ${nodeVersion} 安装成功到 ${nodeDir}`)
  } catch (error) {
    console.error('安装失败:', error)
    process.exit(1)
  }
}

// 执行主函数
main()
