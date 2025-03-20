import {
  LLM_PROVIDER,
  MODEL_META,
  LLMResponse,
  LLMResponseStream,
  MCPToolDefinition,
  MCPToolCall
} from '@shared/presenter'
import { ConfigPresenter } from '../configPresenter'

// 定义ChatMessage接口用于统一消息格式
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content:
    | string
    | {
        type: 'text' | 'image_url'
        text?: string
        image_url?: {
          url: string
          detail?: 'auto' | 'low' | 'high'
        }
      }[]
}

export abstract class BaseLLMProvider {
  // 最大工具调用次数限制
  protected static readonly MAX_TOOL_CALLS = 10

  protected provider: LLM_PROVIDER
  protected models: MODEL_META[] = []
  protected customModels: MODEL_META[] = []
  protected isInitialized: boolean = false
  protected configPresenter: ConfigPresenter

  constructor(provider: LLM_PROVIDER, configPresenter: ConfigPresenter) {
    this.provider = provider
    this.configPresenter = configPresenter
  }

  // 获取最大工具调用次数
  public static getMaxToolCalls(): number {
    return BaseLLMProvider.MAX_TOOL_CALLS
  }

  protected async init() {
    if (this.provider.enable) {
      try {
        await this.fetchModels()
        // 检查是否需要自动启用所有模型
        await this.autoEnableModelsIfNeeded()
        this.isInitialized = true
        console.info('Provider initialized successfully:', this.provider.name)
      } catch (error) {
        console.warn('Provider initialization failed:', this.provider.name, error)
      }
    }
  }

  // 检查并自动启用模型
  protected async autoEnableModelsIfNeeded() {
    if (!this.models || this.models.length === 0) return

    const providerId = this.provider.id

    // 检查是否有自定义模型
    const customModels = this.configPresenter.getCustomModels(providerId)
    if (customModels && customModels.length > 0) return

    // 检查是否有任何模型的状态被手动修改过
    const hasManuallyModifiedModels = this.models.some((model) =>
      this.configPresenter.getModelStatus(providerId, model.id)
    )
    if (hasManuallyModifiedModels) return

    // 检查是否有任何已启用的模型
    const hasEnabledModels = this.models.some((model) =>
      this.configPresenter.getModelStatus(providerId, model.id)
    )

    // 如果没有任何已启用的模型，则自动启用所有模型
    // 这部分后续应该改为启用推荐模型
    if (!hasEnabledModels) {
      console.info(`Auto enabling all models for provider: ${this.provider.name}`)
      this.models.forEach((model) => {
        this.configPresenter.enableModel(providerId, model.id)
      })
    }
  }

  public async fetchModels(): Promise<MODEL_META[]> {
    try {
      const models = await this.fetchProviderModels()
      console.log('Fetched models:', models?.length)
      this.models = models
      return models
    } catch (e) {
      console.error('Failed to fetch models:', e)
      if (!this.models) {
        this.models = []
      }
      return []
    }
  }

  // 这个方法由具体子类实现，用于获取特定提供商的模型
  protected abstract fetchProviderModels(): Promise<MODEL_META[]>

  public getModels(): MODEL_META[] {
    return [...this.models, ...this.customModels]
  }

  public addCustomModel(model: Omit<MODEL_META, 'providerId' | 'isCustom' | 'group'>): MODEL_META {
    const newModel: MODEL_META = {
      ...model,
      providerId: this.provider.id,
      isCustom: true,
      group: 'default'
    }

    // 检查是否已存在相同ID的自定义模型
    const existingIndex = this.customModels.findIndex((m) => m.id === newModel.id)
    if (existingIndex !== -1) {
      this.customModels[existingIndex] = newModel
    } else {
      this.customModels.push(newModel)
    }

    return newModel
  }

  public removeCustomModel(modelId: string): boolean {
    const index = this.customModels.findIndex((model) => model.id === modelId)
    if (index !== -1) {
      this.customModels.splice(index, 1)
      return true
    }
    return false
  }

  public updateCustomModel(modelId: string, updates: Partial<MODEL_META>): boolean {
    const model = this.customModels.find((m) => m.id === modelId)
    if (model) {
      // 应用更新
      Object.assign(model, updates)
      return true
    }
    return false
  }

  public getCustomModels(): MODEL_META[] {
    return this.customModels
  }

  protected getFunctionCallWrapPrompt(tools: MCPToolDefinition[]): string {
    return `
    你将根据用户的问题，选择合适的工具，并调用工具来解决问题，工具会以一个JSON数组的格式提供给你，内容在tool_list标签中:
    <tool_list>
  ${JSON.stringify(tools)}
    </tool_list>
    当用户的意图需要使用工具时，你必须严格按照以下格式回复，保证函数调用的信息在function_call的标签中,每个标签有且只能有一个调用:
<function_call>
{
  "function_call": {
    "name": "<函数名称>",
    "arguments": { /* 参数对象，要求为有效 JSON 格式 */ }
  }
}
</function_call>
    例如，如果你需要调用函数 "getWeather" 并传入 "location" 和 "date"，请返回如下格式：
    <function_call>
   {
      "function_call": {
        "name": "getWeather",
        "arguments": { "location": "Beijing", "date": "2025-03-20" }
      }
    }
    </function_call>
    `
  }

  protected parseFunctionCalls(response: string): MCPToolCall[] {
    try {
      // 使用正则表达式匹配所有的function_call标签对
      const functionCallMatches = response.match(/<function_call>(.*?)<\/function_call>/gs)

      // 如果没有匹配到任何函数调用，返回空数组
      if (!functionCallMatches) {
        return []
      }

      // 解析每个匹配到的函数调用并组成数组
      const toolCalls = functionCallMatches
        .map((match) => {
          const content = match.replace(/<function_call>|<\/function_call>/g, '').trim()
          try {
            const parsedCall = JSON.parse(content)
            return parsedCall.function_call
          } catch (parseError) {
            console.error('Error parsing function call JSON:', parseError)
            return null
          }
        })
        .filter((call) => call !== null)

      return toolCalls
    } catch (error) {
      console.error('Error parsing function calls:', error)
      return []
    }
  }

  // 验证提供商API是否可用
  public abstract check(): Promise<{ isOk: boolean; errorMsg: string | null }>

  // 生成对话标题
  public abstract summaryTitles(messages: ChatMessage[], modelId: string): Promise<string>

  // 基础LLM调用函数
  abstract completions(
    messages: ChatMessage[],
    modelId: string,
    temperature?: number,
    maxTokens?: number
  ): Promise<LLMResponse>

  abstract summaries(
    text: string,
    modelId: string,
    temperature?: number,
    maxTokens?: number
  ): Promise<LLMResponse>

  abstract generateText(
    prompt: string,
    modelId: string,
    temperature?: number,
    maxTokens?: number
  ): Promise<LLMResponse>

  abstract suggestions(
    context: string,
    modelId: string,
    temperature?: number,
    maxTokens?: number
  ): Promise<string[]>

  // 流式接口
  abstract streamCompletions(
    messages: ChatMessage[],
    modelId: string,
    temperature?: number,
    maxTokens?: number
  ): AsyncGenerator<LLMResponseStream>

  abstract streamSummaries(
    text: string,
    modelId: string,
    temperature?: number,
    maxTokens?: number
  ): AsyncGenerator<LLMResponseStream>

  abstract streamGenerateText(
    prompt: string,
    modelId: string,
    temperature?: number,
    maxTokens?: number
  ): AsyncGenerator<LLMResponseStream>
}
