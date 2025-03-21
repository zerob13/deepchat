export default {
  title: '设置',
  common: {
    title: '通用设置',
    resetData: '重置数据',
    language: '语言',
    languageSelect: '选择语言',
    searchEngine: '搜索引擎',
    searchEngineSelect: '选择搜索引擎',
    searchPreview: '搜索预览',
    searchAssistantModel: '搜索助手模型',
    selectModel: '选择模型',
    proxyMode: '代理模式',
    proxyModeSelect: '选择代理模式',
    proxyModeSystem: '系统代理',
    proxyModeNone: '不使用代理',
    proxyModeCustom: '自定义代理',
    customProxyUrl: '自定义代理地址',
    customProxyUrlPlaceholder: '例如: http://127.0.0.1:7890',
    invalidProxyUrl: '无效的代理地址，请输入有效的 http/https URL',
    addCustomSearchEngine: '添加自定义搜索引擎',
    addCustomSearchEngineDesc:
      '添加一个新的搜索引擎，需要提供名称和搜索URL。URL中必须包含{query}作为查询占位符。',
    searchEngineName: '搜索引擎名称',
    searchEngineNamePlaceholder: '请输入搜索引擎名称',
    searchEngineUrl: '搜索URL',
    searchEngineUrlPlaceholder: "如: https://a.com/search?q={'{'}query{'}'}",
    searchEngineUrlError: "URL必须包含{'{'}query{'}'}作为查询占位符",
    deleteCustomSearchEngine: '删除自定义搜索引擎',
    deleteCustomSearchEngineDesc: '确定要删除自定义搜索引擎 "{name}" 吗？此操作无法撤销。',
    testSearchEngine: '测试搜索引擎',
    testSearchEngineDesc: '即将使用 {engine} 搜索引擎进行测试搜索，将搜索关键词 "天气"。',
    testSearchEngineNote:
      '如果搜索页面需要登录或其他操作，您可以在测试窗口中进行。完成测试后请关闭测试窗口。',
    theme: '主题',
    themeSelect: '选择主题',
    closeToQuit: '点击关闭按钮时退出程序',
    contentProtection: '投屏保护',
    contentProtectionDialogTitle: '投屏保护切换确认',
    contentProtectionEnableDesc:
      '开启投屏保护可以防止投屏软件捕获DeepChat主窗口，用来保护您的内容隐私。请注意，此功能不会彻底隐藏所有界面，请合理合规使用。并且，并不是所有投屏软件都遵守用户隐私设定，该功能可能会在一些不遵守隐私设定的投屏软件上失效，切部分环境中可能会残留一个黑色窗体。',
    contentProtectionDisableDesc: '关闭投屏保护将允许投屏软件捕获DeepChat窗口。',
    contentProtectionRestartNotice: '切换此设置将导致程序重启，请确认是否继续？'
  },
  data: {
    title: '数据设置',
    syncEnable: '启用数据同步',
    syncFolder: '同步文件夹',
    openSyncFolder: '打开同步文件夹',
    lastSyncTime: '上次同步时间',
    never: '从未同步',
    startBackup: '立即备份',
    backingUp: '备份中...',
    importData: '导入数据',
    incrementImport: '增量导入',
    overwriteImport: '覆盖导入',
    importConfirmTitle: '确认导入数据',
    importConfirmDescription:
      '导入将会覆盖当前所有数据，包括聊天记录和设置。请确保已备份重要数据。导入完成后需要重启应用程序。',
    importing: '导入中...',
    confirmImport: '确认导入',
    importSuccessTitle: '导入成功',
    importErrorTitle: '导入失败'
  },
  model: {
    title: '模型设置',
    systemPrompt: {
      label: '系统提示词',
      placeholder: '请输入系统提示词...',
      description: '设置AI助手的系统提示词，用于定义其行为和角色'
    },
    temperature: {
      label: '模型温度',
      description: '控制输出的随机性，较高的值会产生更具创造性的响应'
    },
    contextLength: {
      label: '上下文长度',
      description: '设置对话上下文的最大长度'
    },
    responseLength: {
      label: '返回文本长度',
      description: '设置AI响应的最大长度'
    },
    artifacts: {
      title: 'Artifacts效果',
      description: '代码块生成动画效果'
    },
    provider: '服务商',
    modelList: '模型列表',
    selectModel: '选择模型',
    providerSetting: '服务商设置',
    configureModel: '配置模型',
    addModel: '添加模型'
  },
  provider: {
    enable: '开启服务',
    urlPlaceholder: '请输入API URL',
    keyPlaceholder: '请输入API Key',
    verifyKey: '验证密钥',
    howToGet: '如何获取',
    getKeyTip: '请前往',
    getKeyTipEnd: '获取API Key',
    urlFormat: 'API样例：{defaultUrl}',
    modelList: '模型列表',
    enableModels: '启用模型',
    disableAllModels: '禁用全部',
    modelsEnabled: '模型已经启用',
    verifyLink: '验证链接',
    syncModelsFailed: '同步模型失败...',
    addCustomProvider: '添加自定义服务商',
    delete: '删除',
    stopModel: '停止模型',
    pulling: '拉取中...',
    runModel: '运行模型',
    dialog: {
      disableModel: {
        title: '确认禁用模型',
        content: '是否确认禁用模型 "{name}"？',
        confirm: '禁用'
      },
      disableAllModels: {
        title: '确认禁用全部模型',
        content: '是否确认禁用 "{name}" 的全部模型？',
        confirm: '全部禁用'
      },
      configModels: {
        title: '配置模型列表'
      },
      verify: {
        missingFields: '请输入 API Key 和 API URL',
        failed: '验证失败',
        success: '验证成功'
      },
      addCustomProvider: {
        title: '添加自定义服务商',
        description: '请填写服务商的必要信息',
        name: '名称',
        namePlaceholder: '请输入服务商名称',
        apiType: 'API类型',
        apiTypePlaceholder: '请选择API类型',
        apiKey: 'API密钥',
        apiKeyPlaceholder: '请输入API密钥',
        baseUrl: 'API地址',
        baseUrlPlaceholder: '请输入API基础地址',
        enable: '启用服务商'
      },
      deleteProvider: {
        title: '确认删除服务商',
        content: '是否确认删除服务商 "{name}"？此操作不可恢复。',
        confirm: '删除'
      },
      deleteModel: {
        title: '确认删除模型',
        content: '是否确认删除模型 "{name}"？此操作不可恢复。',
        confirm: '删除'
      },
      pullModel: {
        title: '拉取模型',
        pull: '拉取'
      }
    },
    pullModels: '拉取模型',
    refreshModels: '刷新模型',
    modelsRunning: '运行中的模型',
    runningModels: '运行中的模型',
    noRunningModels: '没有运行中的模型',
    deleteModel: '删除模型',
    deleteModelConfirm: '是否确认删除模型 "{name}"？此操作不可恢复。',
    noLocalModels: '没有本地模型',
    localModels: '本地模型'
  },
  about: {
    title: '关于我们',
    version: '版本',
    checkUpdate: '检查更新',
    checking: '检查中...',
    latestVersion: '已是最新版本'
  }
}
