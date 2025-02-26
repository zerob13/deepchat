import { defaultModelsSettings } from '../configPresenter/models'

export interface ModelConfig {
  maxTokens: number
  contextLength: number
  temperature: number
}

export interface ProviderModelConfigs {
  [modelId: string]: ModelConfig
}

/**
 * 获取指定provider和model的推荐配置
 * @param modelId 模型ID
 * @returns ModelConfig | undefined 如果找到配置则返回，否则返回undefined
 */
export function getModelConfig(modelId: string): ModelConfig | undefined {
  const providerConfigs = defaultModelsSettings.find(
    (config) =>
      (config.id.toLowerCase() === modelId.toLowerCase() ||
        config.name.toLowerCase() === modelId.toLowerCase()) &&
      config.match.every((matchString) => modelId.toLowerCase().includes(matchString))
  )

  if (!providerConfigs) {
    return undefined
  }
  return providerConfigs
}
