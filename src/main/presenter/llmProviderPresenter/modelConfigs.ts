export interface ModelConfig {
  maxTokens: number
  contextLength: number
}

export interface ProviderModelConfigs {
  [modelId: string]: ModelConfig
}

export interface ModelConfigs {
  [providerId: string]: ProviderModelConfigs
}

// 静态配置表
export const MODEL_CONFIGS: ModelConfigs = {
  ollama: {
    // 示例配置，后续需要更新为真实数据
    // 'llama2': {
    //   maxTokens: 4096,
    //   contextLength: 4096
    // }
  },
  deepseek: {},
  silicon: {},
  qwenlm: {},
  doubao: {},
  minimax: {},
  fireworks: {}
}

/**
 * 获取指定provider和model的推荐配置
 * @param providerId 提供商ID
 * @param modelId 模型ID
 * @returns ModelConfig | undefined 如果找到配置则返回，否则返回undefined
 */
export function getModelConfig(providerId: string, modelId: string): ModelConfig | undefined {
  const providerConfigs = MODEL_CONFIGS[providerId]
  if (!providerConfigs) {
    return undefined
  }
  return providerConfigs[modelId]
}
