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

    console.log(`准备下载 Node.js ${nodeVersion} 用于 ${platform}-${arch}`)

    // 构建下载URL
    const platformId = getPlatformIdentifier(platform, arch)
    const fileExtension = platform === 'win32' ? 'zip' : 'tar.gz'
    const fileName = `node-${nodeVersion}-${platformId}.${fileExtension}`
    const downloadUrl = `https://nodejs.org/dist/${nodeVersion}/${fileName}`

    // 创建临时目录
    const tempDir = path.join(os.tmpdir(), 'deepchat-node-runtime-temp')
    const downloadPath = path.join(tempDir, fileName)

    // 确保目录存在
    await fs.ensureDir(tempDir)
    await fs.ensureDir(nodeDir)

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
