import { LLM_PROVIDER, MODEL_META, LLMResponse, LLMResponseStream } from '@shared/presenter'
import OpenAI from 'openai'
import { ChatCompletionMessage } from 'openai/resources'
import { eventBus } from '@/eventbus'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export abstract class BaseLLMProvider {
  protected provider: LLM_PROVIDER
  protected openai: OpenAI
  protected models: MODEL_META[] = []
  protected customModels: MODEL_META[] = []
  protected isInitialized: boolean = false
  private isNoModelsApi: boolean = false
  // 添加不支持 OpenAI 标准接口的供应商黑名单
  private static readonly NO_MODELS_API_LIST = ['doubao']

  constructor(provider: LLM_PROVIDER) {
    this.provider = provider
    this.openai = new OpenAI({
      apiKey: this.provider.apiKey,
      baseURL: this.provider.baseUrl
    })
    if (BaseLLMProvider.NO_MODELS_API_LIST.includes(this.provider.id.toLowerCase())) {
      this.isNoModelsApi = true
    }
    this.init()
  }

  protected async init() {
    if (this.provider.enable) {
      try {
        await this.fetchModels()
        this.isInitialized = true
        console.info('Provider initialized successfully:', this.provider.name)
      } catch (error) {
        console.warn('Provider initialization failed:', this.provider.name, error)
      }
    }
  }

  public async fetchModels(): Promise<MODEL_META[]> {
    try {
      // 检查供应商是否在黑名单中
      if (this.isNoModelsApi) {
        console.log(`Provider ${this.provider.name} does not support OpenAI models API`)
        return this.models
      }
      const models = await this.fetchOpenAIModels()
      console.log('Fetched models:', models?.length)
      this.models = models
      eventBus.emit('provider-models-updated', {
        providerId: this.provider.id,
        models: this.getModels()
      })
      return models
    } catch (e) {
      console.error('Failed to fetch models:', e)
      if (!this.models) {
        this.models = []
      }
      return []
    }
  }

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

    // 触发模型列表更新事件
    eventBus.emit('provider-models-updated', {
      providerId: this.provider.id,
      models: this.getModels()
    })

    return newModel
  }

  public removeCustomModel(modelId: string): boolean {
    const index = this.customModels.findIndex((m) => m.id === modelId)
    if (index !== -1) {
      this.customModels.splice(index, 1)

      // 触发模型列表更新事件
      eventBus.emit('provider-models-updated', {
        providerId: this.provider.id,
        models: this.getModels()
      })

      return true
    }
    return false
  }

  public updateCustomModel(modelId: string, updates: Partial<MODEL_META>): boolean {
    const model = this.customModels.find((m) => m.id === modelId)
    if (model) {
      Object.assign(model, updates)

      // 触发模型列表更新事件
      eventBus.emit('provider-models-updated', {
        providerId: this.provider.id,
        models: this.getModels()
      })

      return true
    }
    return false
  }

  public getCustomModels(): MODEL_META[] {
    return this.customModels
  }

  protected formatMessages(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  ): ChatMessage[] {
    return messages
  }

  protected async fetchOpenAIModels(options?: { timeout: number }): Promise<MODEL_META[]> {
    const response = await this.openai.models.list(options)
    return response.data.map((model) => ({
      id: model.id,
      name: model.id,
      group: 'default',
      providerId: this.provider.id,
      enabled: true,
      isCustom: false,
      contextLength: 4096,
      maxTokens: 2048
    }))
  }

  public async updateModelStatus(modelId: string, enabled: boolean): Promise<void> {
    const modelIndex = this.models.findIndex((m) => m.id === modelId)
    if (modelIndex !== -1) {
      this.models[modelIndex].enabled = enabled
    }
  }

  protected async openAICompletion(
    messages: ChatMessage[],
    modelId?: string,
    temperature?: number,
    maxTokens?: number
  ): Promise<LLMResponse> {
    if (!this.isInitialized) {
      throw new Error('Provider not initialized')
    }

    if (!modelId) {
      throw new Error('Model ID is required')
    }

    const completion = await this.openai.chat.completions.create({
      messages: messages,
      model: modelId,
      stream: false,
      temperature: temperature,
      max_tokens: maxTokens
    })
    const message = completion.choices[0].message as ChatCompletionMessage & {
      reasoning_content?: string
    }
    const resultResp: LLMResponse = {
      content: ''
    }

    // 处理原生 reasoning_content
    if (message.reasoning_content) {
      resultResp.reasoning_content = message.reasoning_content
      resultResp.content = message.content || ''
      return resultResp
    }

    // 处理 <think> 标签
    if (message.content) {
      const content = message.content.trimStart()
      if (content.includes('<think>')) {
        const thinkStart = content.indexOf('<think>')
        const thinkEnd = content.indexOf('</think>')

        if (thinkEnd > thinkStart) {
          // 提取 reasoning_content
          resultResp.reasoning_content = content.substring(thinkStart + 7, thinkEnd).trim()

          // 合并 <think> 前后的普通内容
          const beforeThink = content.substring(0, thinkStart).trim()
          const afterThink = content.substring(thinkEnd + 8).trim()
          resultResp.content = [beforeThink, afterThink].filter(Boolean).join('\n')
        } else {
          // 如果没有找到配对的结束标签，将所有内容作为普通内容
          resultResp.content = message.content
        }
      } else {
        // 没有 think 标签，所有内容作为普通内容
        resultResp.content = message.content
      }
    }

    return resultResp
  }

  protected async *openAIStreamCompletion(
    messages: ChatMessage[],
    modelId?: string,
    temperature?: number,
    maxTokens?: number
  ): AsyncGenerator<LLMResponseStream> {
    if (!this.isInitialized) {
      throw new Error('Provider not initialized')
    }

    if (!modelId) {
      throw new Error('Model ID is required')
    }

    const stream = await this.openai.chat.completions.create({
      messages: messages,
      model: modelId,
      stream: true,
      temperature: temperature,
      max_tokens: maxTokens
    })

    let hasCheckedFirstChunk = false
    let hasReasoningContent = false
    let buffer = ''
    let isInThinkTag = false
    let initialBuffer = '' // 用于累积开头的内容
    const WINDOW_SIZE = 10 // 滑动窗口大小

    // 辅助函数：清理标签并返回清理后的位置
    const cleanTag = (text: string, tag: string): { cleanedPosition: number; found: boolean } => {
      const tagIndex = text.indexOf(tag)
      if (tagIndex === -1) return { cleanedPosition: 0, found: false }

      // 查找标签结束位置（跳过可能的空白字符）
      let endPosition = tagIndex + tag.length
      while (endPosition < text.length && /\s/.test(text[endPosition])) {
        endPosition++
      }
      return { cleanedPosition: endPosition, found: true }
    }

    for await (const chunk of stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delta = chunk.choices[0]?.delta as any

      // 处理原生 reasoning_content 格式
      if (delta?.reasoning_content) {
        yield {
          reasoning_content: delta.reasoning_content
        }
        continue
      }

      const content = delta?.content || ''
      if (!content) continue

      // 检查是否包含 <think> 标签
      if (!hasCheckedFirstChunk) {
        initialBuffer += content
        // 如果积累的内容包含了完整的 <think> 或者已经可以确定不是以 <think> 开头
        if (
          initialBuffer.includes('<think>') ||
          (initialBuffer.length >= 6 && !'<think>'.startsWith(initialBuffer.trimStart()))
        ) {
          hasCheckedFirstChunk = true
          const trimmedContent = initialBuffer.trimStart()
          hasReasoningContent = trimmedContent.includes('<think>')

          // 如果不包含 <think>，直接输出累积的内容
          if (!hasReasoningContent) {
            yield {
              content: initialBuffer
            }
            initialBuffer = ''
          } else {
            // 如果包含 <think>，将内容转移到主 buffer 继续处理
            buffer = initialBuffer
            initialBuffer = ''
            // 立即处理 buffer 中的 think 标签
            if (buffer.includes('<think>')) {
              isInThinkTag = true
              const thinkStart = buffer.indexOf('<think>')
              if (thinkStart > 0) {
                yield {
                  content: buffer.substring(0, thinkStart)
                }
              }
              const { cleanedPosition } = cleanTag(buffer, '<think>')
              buffer = buffer.substring(cleanedPosition)
            }
          }
          continue
        } else {
          // 继续累积内容
          continue
        }
      }

      // 如果没有 reasoning_content，直接返回普通内容
      if (!hasReasoningContent) {
        yield {
          content: content
        }
        continue
      }

      // 已经在处理 reasoning_content 模式
      if (!isInThinkTag && buffer.includes('<think>')) {
        isInThinkTag = true
        const thinkStart = buffer.indexOf('<think>')
        if (thinkStart > 0) {
          yield {
            content: buffer.substring(0, thinkStart)
          }
        }
        const { cleanedPosition } = cleanTag(buffer, '<think>')
        buffer = buffer.substring(cleanedPosition)
      } else if (isInThinkTag) {
        buffer += content
        const { found: hasEndTag, cleanedPosition } = cleanTag(buffer, '</think>')
        if (hasEndTag) {
          const thinkEnd = buffer.indexOf('</think>')
          if (thinkEnd > 0) {
            yield {
              reasoning_content: buffer.substring(0, thinkEnd)
            }
          }
          buffer = buffer.substring(cleanedPosition)
          isInThinkTag = false
          hasReasoningContent = false

          // 输出剩余的普通内容
          if (buffer) {
            yield {
              content: buffer
            }
            buffer = ''
          }
        } else {
          // 保持滑动窗口大小的 buffer 来检测结束标签
          if (buffer.length > WINDOW_SIZE) {
            const contentToYield = buffer.slice(0, -WINDOW_SIZE)
            yield {
              reasoning_content: contentToYield
            }
            buffer = buffer.slice(-WINDOW_SIZE)
          }
        }
      } else {
        // 不在任何标签中，累积内容
        buffer += content
        yield {
          content: buffer
        }
        buffer = ''
      }
    }

    // 处理剩余的 buffer
    if (initialBuffer) {
      yield {
        content: initialBuffer
      }
    }
    if (buffer) {
      if (isInThinkTag) {
        yield {
          reasoning_content: buffer
        }
      } else {
        yield {
          content: buffer
        }
      }
    }
  }

  public async check(): Promise<{ isOk: boolean; errorMsg: string | null }> {
    try {
      if (!this.isNoModelsApi) {
        const models = await this.fetchOpenAIModels({
          timeout: 3000
        })
        this.models = models
        eventBus.emit('provider-models-updated', {
          providerId: this.provider.id,
          models: this.getModels()
        })
      }
      return {
        isOk: true,
        errorMsg: null
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      return {
        isOk: false,
        errorMsg: error?.message
      }
    }
  }

  public async summaryTitles(messages: ChatMessage[], modelId: string) {
    const systemPrompt = `You need to summarize the user's conversation into a title of no more than 10 words, with the title language matching the user's primary language, without using punctuation or other special symbols`
    const fullMessage: ChatMessage[] = [
      {
        role: 'system',
        content: systemPrompt
      },
      { role: 'user', content: messages.map((m) => `${m.role}: ${m.content}`).join('\n') }
    ]
    const response = await this.openAICompletion(fullMessage, modelId, 0.5)
    return response.content
  }

  // 预留常用的LLM调用函数
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

  // 增加流式接口
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
