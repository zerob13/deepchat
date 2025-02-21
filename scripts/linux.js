const fs = require('fs')
const path = require('path')

module.exports = async (context) => {
  const appPath = path.join(context.appOutDir, 'DeepChat')
  const appExec = path.join(appPath, 'DeepChat')

  // 修改启动命令，添加 --no-sandbox 参数
  const execFile = fs.readFileSync(appExec, 'utf8')
  const modifiedExecFile = execFile.replace(/"[^"]*"/, '"$& --no-sandbox"')
  fs.writeFileSync(appExec, modifiedExecFile, 'utf8')
}
