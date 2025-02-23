# DeepChat 贡献指南

我们非常欢迎您的贡献！我们希望让参与 DeepChat 项目变得简单透明。您可以通过以下方式参与：

- 报告 Bug
- 讨论当前代码状态
- 提交修复
- 提出新功能
- 成为项目维护者

## 开发流程

我们使用 GitHub 来托管代码、跟踪问题和功能请求，以及接受 Pull Request。

### 项目组内部贡献者

#### Bug 修复和小型功能改进

- 直接在 `dev` 分支上进行开发
- 提交到 `dev` 分支的代码必须确保：
  - 功能基本正常
  - 无编译错误
  - 至少能够 `npm run dev` 正常启动

#### 大型功能新增或重构

- 创建新的功能分支，命名格式为 `feature/featurename`
- 开发完成后将功能分支合并到 `dev` 分支

### 外部贡献者

1. Fork 本仓库到您的个人账号
2. 从 `dev` 分支创建您的开发分支
3. 在您的 Fork 仓库中进行开发
4. 完成后向原仓库的 `dev` 分支提交 Pull Request
5. 在 PR 描述中说明修复的 Issue（如适用）

## 本地开发环境设置

1. 克隆仓库：

   ```bash
   git clone https://github.com/yourusername/deepchat.git
   cd deepchat
   ```

2. 安装依赖：

   ```bash
   yarn install
   ```

3. 启动开发服务器：
   ```bash
   yarn dev
   ```

## 项目结构

- `/src` - 主要源代码
- `/scripts` - 构建和开发脚本
- `/resources` - 应用资源
- `/build` - 构建配置
- `/out` - 构建输出

## 代码风格

- 使用 ESLint 进行 JavaScript/TypeScript 代码检查
- 使用 Prettier 进行代码格式化
- 使用 EditorConfig 维护一致的编码风格

请确保您的代码符合我们的代码风格指南，可以运行以下命令：

```bash
yarn lint
yarn format
```

## Pull Request 流程

1. 如果涉及接口变更，请更新 README.md
2. 如有需要，请更新 `/docs` 目录中的文档
3. 获得至少一位维护者的批准后，PR 将被合并

## 有问题？

如果您有任何关于贡献的问题，请使用 "question" 标签创建一个 issue。

## 许可证

通过贡献代码，您同意您的贡献将遵循本项目的开源许可证。
