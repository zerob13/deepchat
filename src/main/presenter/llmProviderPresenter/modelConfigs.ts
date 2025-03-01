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
  // 添加对Gemini 2.0和1.5模型的匹配
  if (modelId.includes('gemini-2.0-flash')) {
    return {
      maxTokens: 8192,
      contextLength: 1048576,
      temperature: 0.7
    }
  }

  if (modelId.includes('gemini-1.5-flash')) {
    return {
      maxTokens: 8192,
      contextLength: 1048576,
      temperature: 0.7
    }
  }

  if (modelId.includes('gemini-1.5-pro')) {
    return {
      maxTokens: 8192,
      contextLength: 2097152,
      temperature: 0.7
    }
  }

  // 使用默认匹配逻辑
  const providerConfigs = defaultModelsSettings.find((config) =>
    config.match.every((matchString) => modelId.toLowerCase().includes(matchString.toLowerCase()))
  )

  if (!providerConfigs) {
    return undefined
  }
  return providerConfigs
}
