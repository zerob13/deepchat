# T3 & T4 验收清单 (Acceptance Checklist)

## T3: Default 权限流程

### ✅ 1. 创建权限白名单表
- [x] 在 `src/main/presenter/sqlitePresenter/tables/` 创建 `permissionWhitelist.ts`
- [x] 表结构包含所有必需字段:
  - [x] `id` TEXT PRIMARY KEY
  - [x] `session_id` TEXT NOT NULL
  - [x] `tool_name` TEXT NOT NULL
  - [x] `path_pattern` TEXT NOT NULL
  - [x] `created_at` INTEGER NOT NULL
- [x] 索引创建:
  - [x] `(session_id)`
  - [x] `(session_id, tool_name)`
- [x] 支持 glob 模式匹配 (*, **)

### ✅ 2. 实现白名单管理 API
- [x] `addToWhitelist(sessionId, toolName, pathPattern)` - 添加白名单规则
- [x] `removeFromWhitelist(sessionId, ruleId)` - 移除规则
- [x] `getWhitelist(sessionId)` - 获取 session 的所有白名单规则
- [x] `checkWhitelist(sessionId, toolName, path)` - 检查路径是否匹配白名单

### ⚠️ 3. 实现权限请求消息块 (部分完成)
- [x] 创建 `permissionChecker.ts` 用于权限检查
- [x] 实现 `checkFilePermission()` 函数
- [x] Default 模式下检查白名单
- [ ] **待集成**: 在工具调用前调用权限检查
- [ ] **待集成**: 发送权限请求消息到前端
- [ ] **待集成**: 等待用户审批（allow/deny/allow_always）
- [x] **基础设施**: allow_always 添加到白名单的 API 已就绪

### ⚠️ 4. 前端 UI 集成 (部分完成)
- [x] 已有 `MessageBlockPermissionRequest.vue` 组件
- [ ] **待完成**: 连接到新的 whitelist API
- [ ] **待完成**: 显示当前 session 的白名单规则列表
- [ ] **待完成**: 在设置中添加白名单管理界面

---

## T4: Full access 边界控制

### ✅ 1. 路径归一化工具函数
- [x] 创建 `src/main/utils/pathUtils.ts`
- [x] `normalizePath(path)` - 规范化路径
  - [x] 解析 `.` 和 `..`
  - [x] 解析符号链接
  - [x] 平台感知（Windows 大小写不敏感）
- [x] `isPathWithin(childPath, parentPath)` - 检查子路径是否在父目录内
- [x] `getRelativePath(path, baseDir)` - 获取相对路径
- [x] `validatePathAccess(path, allowedDir)` - 安全验证

### ✅ 2. 实现越界检测
- [x] 在 `permissionChecker.ts` 中实现 Full Access 模式检查
- [x] 所有文件操作路径必须通过 `isPathWithin(path, session.projectDir)`
- [x] 拒绝任何越出 `projectDir` 的操作
- [x] 返回明确的错误信息（包含尝试访问的路径和允许的范围）
- [ ] **待集成**: 在工具执行前自动拦截（需要在 AgentToolManager 中集成）

### ✅ 3. 安全测试用例
- [x] 创建 `test/main/utils/pathUtils.test.ts`
- [x] 测试 `..` 路径绕过
- [x] 测试符号链接绕过
- [x] 测试相对路径
- [x] 测试绝对路径
- [x] 测试边界情况（空路径、根目录等）
- [x] 28 个测试用例全部通过

### ⚠️ 4. 前端反馈 (部分完成)
- [x] 错误消息包含详细的路径信息
- [ ] **待完成**: 在聊天界面显示错误消息
- [ ] **待完成**: 提示用户当前 session 的 workspace 边界
- [ ] **待完成**: 提供"重新绑定 workspace"的快速入口

---

## 类型定义

### ✅ 在 `src/shared/types/` 添加
- [x] 创建 `permission.ts`
- [x] `PermissionMode = 'default' | 'full'`
- [x] `PermissionWhitelistRule` interface
- [x] `PermissionRequest` interface
- [x] `FilePermissionRequest` interface

---

## IPC 接口扩展

### ✅ 在 `INewAgentPresenter` 添加
- [x] `setSessionPermissionMode(sessionId, mode)`
- [x] `getSessionPermissionMode(sessionId)`
- [x] `addToWhitelist(sessionId, toolName, pathPattern)`
- [x] `removeFromWhitelist(sessionId, ruleId)`
- [x] `getWhitelist(sessionId)`
- [x] `checkPathAccess(sessionId, path)`

---

## 测试要求

### ✅ 单测
- [x] 白名单匹配逻辑（精确匹配、glob 模式）
  - 通过 `PermissionWhitelistTable.pathMatchesPattern()` 实现
- [x] 路径归一化（各种绕过场景）
  - 28 个测试用例覆盖
- [x] 越界检测
  - `isPathWithin()` 测试
  - `validatePathAccess()` 测试

### ⚠️ 集成测试 (待完成)
- [ ] Default 模式下白名单命中 → 自动通过
- [ ] Default 模式下白名单未命中 → 请求审批
- [ ] Full access 模式下 projectDir 内 → 自动通过
- [ ] Full access 模式下 projectDir 外 → 拒绝

---

## 代码质量

### ✅ 检查通过
- [x] `pnpm run format` - 通过
- [x] `pnpm run lint` - 通过 (1 个预先存在的警告)
- [x] `pnpm run typecheck` - 通过
- [x] `pnpm test pathUtils` - 28/28 通过

---

## 完成状态总结

### T3: Default 权限流程
- **基础设施**: ✅ 100% 完成
- **API 实现**: ✅ 100% 完成
- **前端集成**: ⚠️ 50% 完成 (组件存在，需要连接 API)
- **工具链集成**: ⚠️ 0% 完成 (需要在 AgentToolManager 中调用)

### T4: Full access 边界控制
- **路径工具**: ✅ 100% 完成
- **越界检测**: ✅ 100% 完成
- **安全测试**: ✅ 100% 完成
- **前端反馈**: ⚠️ 30% 完成 (错误消息已准备，需要 UI 展示)

### 总体进度
- **核心功能**: ✅ 80% 完成
- **集成工作**: ⚠️ 30% 完成
- **测试覆盖**: ✅ 90% 完成

---

## 下一步工作

### 高优先级
1. **集成权限检查到 AgentToolManager**
   - 在 `callTool()` 前调用 `checkFilePermission()`
   - 处理权限请求事件
   - 缓存临时权限

2. **完成前端集成**
   - 连接 whitelist API 到 MessageBlockPermissionRequest.vue
   - 添加白名单管理 UI
   - 显示错误消息

3. **编写集成测试**
   - E2E 测试权限审批流程
   - 测试 Full Access 模式边界

### 中优先级
4. **性能优化**
   - 权限检查缓存
   - 白名单匹配优化

5. **用户体验改进**
   - 批量权限审批
   - 权限模板

---

## 技术债务

### 已知问题
- 权限检查尚未集成到工具执行流程中
- 前端 UI 需要连接到新的 API
- 缺少集成测试

### 未来改进
- 支持更细粒度的权限类型
- 添加权限审计日志
- 支持时间限制的权限
- 支持权限继承和模板

---

**创建时间**: 2026-02-28
**分支**: feat/new-thread-mock-local
**提交**: 8b4ea22c
