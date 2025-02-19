import {
  IThreadPresenter,
  CONVERSATION,
  CONVERSATION_SETTINGS,
  MESSAGE_ROLE,
  MESSAGE_STATUS,
  MESSAGE_METADATA
} from '../../../shared/presenter'
import { ISQLitePresenter } from '../../../shared/presenter'
import { MessageManager } from './messageManager'
import { ILlmProviderPresenter } from '../../../shared/presenter'
import { eventBus } from '@/eventbus'
import { AssistantMessage, Message, AssistantMessageBlock } from '@shared/chat'
import { approximateTokenSize } from 'tokenx'
import { getModelConfig } from '../llmProviderPresenter/modelConfigs'
import { SearchResult } from '@shared/presenter'

const DEFAULT_SETTINGS: CONVERSATION_SETTINGS = {
  systemPrompt: '',
  temperature: 0.7,
  contextLength: 1000,
  maxTokens: 2000,
  providerId: 'openai',
  modelId: 'gpt-4'
}

interface GeneratingMessageState {
  message: AssistantMessage
  conversationId: string
  startTime: number
  firstTokenTime: number | null
  promptTokens: number
  reasoningStartTime: number | null
  reasoningEndTime: number | null
  lastReasoningTime: number | null
}
const SEARCH_PROMPT_TEMPLATE = `You are an expert in organizing search results.Write an accurate answer concisely for a given question, citing the search results as needed. Your answer must be correct, high-quality, and written by an expert using an unbiased and journalistic tone. Your answer must be written in the same language as the question, even if language preference is different. Cite search results using [index] at the end of sentences when needed, for example "Ice is less dense than water.[1][2]" NO SPACE between the last word and the citation. Cite the most relevant results that answer the question. Avoid citing irrelevant results. Write only the response. Use markdown for formatting.

- Use markdown to format paragraphs, lists, tables, and quotes whenever possible.
- Use markdown code blocks to write code, including the language for syntax highlighting.
- Use LaTeX to wrap ALL math expression. Always use double dollar signs $$, for example $$x^4 = x - 3$$.
- DO NOT include any URL's, only include citations with numbers, eg [1].
- DO NOT include references (URL's at the end, sources).
- Use footnote citations at the end of applicable sentences(e.g, [1][2]).
- Write more than 100 words (2 paragraphs).
- In the response avoid referencing the citation directly
- Print just the response text.
<search_results>
{{SEARCH_RESULTS}}
</search_results>
<user_query>
{{USER_QUERY}}
</user_query>
  `
// 格式化搜索结果的函数
export function formatSearchResults(results: SearchResult[]): string {
  return results
    .map(
      (result, index) => `source ${index + 1}：${result.title}
URL: ${result.url}
content：${result.content || '无法获取内容'}
---`
    )
    .join('\n\n')
}
// 生成带搜索结果的提示词
export function generateSearchPrompt(query: string, results: SearchResult[]): string {
  return SEARCH_PROMPT_TEMPLATE.replace('{{SEARCH_RESULTS}}', formatSearchResults(results)).replace(
    '{{USER_QUERY}}',
    query
  )
}

export class ThreadPresenter implements IThreadPresenter {
  private activeConversationId: string | null = null
  private sqlitePresenter: ISQLitePresenter
  private messageManager: MessageManager
  private llmProviderPresenter: ILlmProviderPresenter
  private generatingMessages: Map<string, GeneratingMessageState> = new Map()

  constructor(sqlitePresenter: ISQLitePresenter, llmProviderPresenter: ILlmProviderPresenter) {
    this.sqlitePresenter = sqlitePresenter
    this.messageManager = new MessageManager(sqlitePresenter)
    this.llmProviderPresenter = llmProviderPresenter

    // 初始化时处理所有未完成的消息
    this.initializeUnfinishedMessages()

    eventBus.on('stream-response', async (msg) => {
      const { eventId, content, reasoning_content } = msg
      const state = this.generatingMessages.get(eventId)
      if (state) {
        // 记录第一个token的时间
        if (state.firstTokenTime === null && (content || reasoning_content)) {
          state.firstTokenTime = Date.now()
          await this.messageManager.updateMessageMetadata(eventId, {
            firstTokenTime: Date.now() - state.startTime
          })
        }

        // 处理reasoning_content的时间戳
        if (reasoning_content) {
          if (state.reasoningStartTime === null) {
            state.reasoningStartTime = Date.now()
            await this.messageManager.updateMessageMetadata(eventId, {
              reasoningStartTime: Date.now() - state.startTime
            })
          }
          state.lastReasoningTime = Date.now()
        }

        const lastBlock = state.message.content[state.message.content.length - 1]
        if (content) {
          if (lastBlock && lastBlock.type === 'content') {
            lastBlock.content += content
          } else {
            if (lastBlock) {
              lastBlock.status = 'success'
            }
            state.message.content.push({
              type: 'content',
              content: content,
              status: 'loading',
              timestamp: Date.now()
            })
          }
        }
        if (reasoning_content) {
          if (lastBlock && lastBlock.type === 'reasoning_content') {
            lastBlock.content += reasoning_content
          } else {
            if (lastBlock) {
              lastBlock.status = 'success'
            }
            state.message.content.push({
              type: 'reasoning_content',
              content: reasoning_content,
              status: 'loading',
              timestamp: Date.now()
            })
          }
        }
      }
    })
    eventBus.on('stream-end', async (msg) => {
      const { eventId } = msg
      const state = this.generatingMessages.get(eventId)
      if (state) {
        state.message.content.forEach((block) => {
          block.status = 'success'
        })

        // 计算completion tokens
        let completionTokens = 0
        for (const block of state.message.content) {
          completionTokens += approximateTokenSize(block.content)
        }

        const totalTokens = state.promptTokens + completionTokens
        const generationTime = Date.now() - state.startTime
        const tokensPerSecond = completionTokens / (generationTime / 1000)

        // 如果有reasoning_content，记录结束时间
        const metadata: Partial<MESSAGE_METADATA> = {
          totalTokens,
          generationTime,
          firstTokenTime: state.firstTokenTime ? state.firstTokenTime - state.startTime : 0,
          tokensPerSecond
        }

        if (state.reasoningStartTime !== null && state.lastReasoningTime !== null) {
          metadata.reasoningStartTime = state.reasoningStartTime - state.startTime
          metadata.reasoningEndTime = state.lastReasoningTime - state.startTime
        }

        // 更新消息的usage信息
        await this.messageManager.updateMessageMetadata(eventId, metadata)

        await this.messageManager.updateMessageStatus(eventId, 'sent')
        await this.messageManager.editMessage(eventId, JSON.stringify(state.message.content))
        this.generatingMessages.delete(eventId)
      }
    })
    eventBus.on('stream-error', async (msg) => {
      const { eventId, error } = msg
      const state = this.generatingMessages.get(eventId)
      if (state) {
        await this.handleMessageError(eventId, String(error))
        this.generatingMessages.delete(eventId)
      }
    })
  }

  /**
   * 处理消息错误状态的公共函数
   * @param messageId 消息ID
   * @param errorMessage 错误信息
   */
  private async handleMessageError(
    messageId: string,
    errorMessage: string = 'common.error.requestFailed'
  ): Promise<void> {
    const message = await this.messageManager.getMessage(messageId)
    if (!message) {
      return
    }

    let content: AssistantMessageBlock[] = []
    try {
      content = JSON.parse(message.content)
    } catch (e) {
      content = []
    }

    // 将所有loading状态的block改为error
    content.forEach((block: AssistantMessageBlock) => {
      if (block.status === 'loading') {
        block.status = 'error'
      }
    })

    // 添加错误信息block
    content.push({
      type: 'error',
      content: errorMessage,
      status: 'error',
      timestamp: Date.now()
    })

    // 更新消息状态和内容
    await this.messageManager.updateMessageStatus(messageId, 'error')
    await this.messageManager.editMessage(messageId, JSON.stringify(content))
  }

  /**
   * 初始化未完成的消息
   */
  private async initializeUnfinishedMessages(): Promise<void> {
    try {
      // 获取所有对话
      const { list: conversations } = await this.getConversationList(1, 1000)

      for (const conversation of conversations) {
        // 获取每个对话的消息
        const { list: messages } = await this.getMessages(conversation.id, 1, 1000)

        // 找出所有pending状态的assistant消息
        const pendingMessages = messages.filter(
          (msg) => msg.role === 'assistant' && msg.status === 'pending'
        )

        // 处理每个未完成的消息
        for (const message of pendingMessages) {
          await this.handleMessageError(message.id, 'common.error.sessionInterrupted')
        }
      }
    } catch (error) {
      console.error('初始化未完成消息失败:', error)
    }
  }

  async renameConversation(conversationId: string, title: string): Promise<CONVERSATION> {
    return await this.sqlitePresenter.renameConversation(conversationId, title)
  }

  async createConversation(
    title: string,
    settings: Partial<CONVERSATION_SETTINGS> = {}
  ): Promise<string> {
    const latestConversation = await this.getLatestConversation()

    if (latestConversation) {
      const { list: messages } = await this.getMessages(latestConversation.id, 1, 1)
      if (messages.length === 0) {
        await this.setActiveConversation(latestConversation.id)
        return latestConversation.id
      }
    }
    let defaultSettings = DEFAULT_SETTINGS
    if (latestConversation?.settings) {
      defaultSettings = { ...latestConversation.settings }
    }
    Object.keys(settings).forEach((key) => {
      if (settings[key] === undefined || settings[key] === null || settings[key] === '') {
        delete settings[key]
      }
    })
    const mergedSettings = { ...defaultSettings, ...settings }
    const conversationId = await this.sqlitePresenter.createConversation(title, mergedSettings)
    await this.setActiveConversation(conversationId)
    return conversationId
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.sqlitePresenter.deleteConversation(conversationId)
    if (this.activeConversationId === conversationId) {
      this.activeConversationId = null
    }
  }

  async getConversation(conversationId: string): Promise<CONVERSATION> {
    return await this.sqlitePresenter.getConversation(conversationId)
  }

  async updateConversationTitle(conversationId: string, title: string): Promise<void> {
    await this.sqlitePresenter.updateConversation(conversationId, { title })
  }

  async updateConversationSettings(
    conversationId: string,
    settings: Partial<CONVERSATION_SETTINGS>
  ): Promise<void> {
    const conversation = await this.getConversation(conversationId)
    const mergedSettings = { ...conversation.settings, ...settings }

    // 检查是否有 modelId 的变化
    if (settings.modelId && settings.modelId !== conversation.settings.modelId) {
      console.log('check model default config')
      // 获取模型配置
      const modelConfig = getModelConfig(mergedSettings.providerId, mergedSettings.modelId)
      if (modelConfig) {
        // 如果当前设置小于推荐值，则使用推荐值
        if (mergedSettings.maxTokens < modelConfig.maxTokens) {
          mergedSettings.maxTokens = modelConfig.maxTokens
        }
        if (mergedSettings.contextLength < modelConfig.contextLength) {
          mergedSettings.contextLength = modelConfig.contextLength
        }
      }
    }

    await this.sqlitePresenter.updateConversation(conversationId, { settings: mergedSettings })
  }

  async getConversationList(
    page: number,
    pageSize: number
  ): Promise<{ total: number; list: CONVERSATION[] }> {
    return await this.sqlitePresenter.getConversationList(page, pageSize)
  }

  async setActiveConversation(conversationId: string): Promise<void> {
    const conversation = await this.getConversation(conversationId)
    if (conversation) {
      this.activeConversationId = conversationId
      eventBus.emit('conversation-activated', { conversationId })
    } else {
      throw new Error(`Conversation ${conversationId} not found`)
    }
  }

  async getActiveConversation(): Promise<CONVERSATION | null> {
    if (!this.activeConversationId) {
      return null
    }
    return this.getConversation(this.activeConversationId)
  }

  async getMessages(
    conversationId: string,
    page: number,
    pageSize: number
  ): Promise<{ total: number; list: Message[] }> {
    return await this.messageManager.getMessageThread(conversationId, page, pageSize)
  }

  async getContextMessages(conversationId: string): Promise<Message[]> {
    const conversation = await this.getConversation(conversationId)
    // 计算需要获取的消息数量（假设每条消息平均300字）
    let messageCount = Math.ceil(conversation.settings.contextLength / 300)
    if (messageCount < 2) {
      messageCount = 2
    }
    return await this.messageManager.getContextMessages(conversationId, messageCount)
  }

  async clearContext(conversationId: string): Promise<void> {
    await this.sqlitePresenter.runTransaction(async () => {
      const conversation = await this.getConversation(conversationId)
      if (conversation) {
        await this.sqlitePresenter.deleteAllMessages()
      }
    })
  }
  /**
   *
   * @param conversationId
   * @param content
   * @param role
   * @returns 如果是user的消息，返回ai生成的message，否则返回空
   */
  async sendMessage(
    conversationId: string,
    content: string,
    role: MESSAGE_ROLE
  ): Promise<AssistantMessage | null> {
    const conversation = await this.getConversation(conversationId)
    const { providerId, modelId } = conversation.settings
    const message = await this.messageManager.sendMessage(
      conversationId,
      content,
      role,
      '',
      false,
      {
        totalTokens: 0,
        generationTime: 0,
        firstTokenTime: 0,
        tokensPerSecond: 0,
        model: modelId,
        provider: providerId
      }
    )
    if (role === 'user') {
      const assistantMessage = await this.generateAIResponse(conversationId, message.id)
      this.generatingMessages.set(assistantMessage.id, {
        message: assistantMessage,
        conversationId,
        startTime: Date.now(),
        firstTokenTime: null,
        promptTokens: 0,
        reasoningStartTime: null,
        reasoningEndTime: null,
        lastReasoningTime: null
      })

      // 检查是否是新会话的第一条消息
      const { list: messages } = await this.getMessages(conversationId, 1, 2)
      if (messages.length === 1) {
        // 更新会话的 is_new 标志位
        await this.sqlitePresenter.updateConversation(conversationId, { is_new: 0 })
      }

      return assistantMessage
    }

    return null
  }

  private async generateAIResponse(conversationId: string, userMessageId: string) {
    try {
      const triggerMessage = await this.messageManager.getMessage(userMessageId)
      if (!triggerMessage) {
        throw new Error('找不到触发消息')
      }

      await this.messageManager.updateMessageStatus(userMessageId, 'sent')

      const conversation = await this.getConversation(conversationId)
      const { providerId, modelId } = conversation.settings
      const assistantMessage = (await this.messageManager.sendMessage(
        conversationId,
        JSON.stringify([]),
        'assistant',
        userMessageId,
        false,
        {
          totalTokens: 0,
          generationTime: 0,
          firstTokenTime: 0,
          tokensPerSecond: 0,
          model: modelId,
          provider: providerId
        }
      )) as AssistantMessage

      this.generatingMessages.set(assistantMessage.id, {
        message: assistantMessage,
        conversationId,
        startTime: Date.now(),
        firstTokenTime: null,
        promptTokens: 0,
        reasoningStartTime: null,
        reasoningEndTime: null,
        lastReasoningTime: null
      })

      return assistantMessage
    } catch (error) {
      await this.messageManager.updateMessageStatus(userMessageId, 'error')
      console.error('生成 AI 响应失败:', error)
      throw error
    }
  }

  async getMessage(messageId: string): Promise<Message> {
    return await this.messageManager.getMessage(messageId)
  }

  /**
   * 获取指定消息之前的历史消息
   * @param messageId 消息ID
   * @param limit 限制返回的消息数量
   * @returns 历史消息列表，按时间正序排列
   */
  private async getMessageHistory(messageId: string, limit: number = 100): Promise<Message[]> {
    const message = await this.messageManager.getMessage(messageId)
    if (!message) {
      throw new Error('找不到指定的消息')
    }

    const { list: messages } = await this.messageManager.getMessageThread(
      message.conversationId,
      1,
      limit * 2
    )

    // 找到目标消息在列表中的位置
    const targetIndex = messages.findIndex((msg) => msg.id === messageId)
    if (targetIndex === -1) {
      return [message]
    }

    // 返回目标消息之前的消息（包括目标消息）
    return messages.slice(Math.max(0, targetIndex - limit + 1), targetIndex + 1)
  }

  async startStreamCompletion(conversationId: string, queryMsgId?: string) {
    console.log('开始流式完成，conversationId:', conversationId, 'queryMsgId:', queryMsgId)

    const state = Array.from(this.generatingMessages.values()).find(
      (state) => state.conversationId === conversationId
    )
    if (!state) {
      console.warn('未找到状态，conversationId:', conversationId)
      return
    }

    const conversation = await this.getConversation(conversationId)

    const { systemPrompt, providerId, modelId, temperature, contextLength, maxTokens } =
      conversation.settings

    let contextMessages: Message[] = []
    if (queryMsgId) {
      console.log('有queryMsgId，从该消息开始获取历史消息')
      const queryMessage = await this.getMessage(queryMsgId)
      if (!queryMessage || !queryMessage.parentId) {
        console.error('找不到指定的消息，queryMsgId:', queryMsgId)
        throw new Error('找不到指定的消息')
      }
      const triggerMessage = await this.getMessage(queryMessage.parentId)
      if (!triggerMessage) {
        console.error('找不到触发消息，parentId:', queryMessage.parentId)
        throw new Error('找不到指定的消息')
      }
      // 获取触发消息之前的历史消息
      contextMessages = await this.getMessageHistory(triggerMessage.id, contextLength)
    } else {
      console.log('没有queryMsgId，获取常规的上下文消息')
      contextMessages = await this.getContextMessages(conversationId)
    }

    const formattedMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = []

    // 添加系统提示语
    if (systemPrompt) {
      formattedMessages.push({
        role: 'system',
        content: systemPrompt
      })
    }

    // 计算每条消息的内容长度并从后往前选择消息
    type FormattedMessage = {
      role: 'user' | 'assistant'
      content: string
      files: File[]
      links: string[]
      search: boolean
      think: boolean
    }

    const messagesWithLength = contextMessages
      .map((msg) => {
        if (msg.role === 'user') {
          const userContent = msg.content
          return {
            message: msg,
            length: userContent.text.length,
            formattedMessage: {
              role: 'user' as const,
              content: userContent.text,
              files: userContent.files,
              links: userContent.links,
              search: userContent.search,
              think: userContent.think
            } satisfies FormattedMessage
          }
        } else {
          const content = msg.content
            .filter((block) => block.type === 'content')
            .map((block) => block.content)
            .join('\n')
          return {
            message: msg,
            length: content.length,
            formattedMessage: {
              role: 'assistant' as const,
              content: content,
              files: [],
              links: [],
              search: false,
              think: false
            } satisfies FormattedMessage
          }
        }
      })
      .filter((item) => item.formattedMessage.content.length > 0)

    let totalLength = 0
    const selectedMessages: FormattedMessage[] = []

    // 从后往前遍历消息
    for (let i = messagesWithLength.length - 1; i >= 0; i--) {
      const currentMsg = messagesWithLength[i]

      // 如果是最后一条消息且是assistant，且不是重生成模式，则跳过
      if (
        !queryMsgId &&
        i === messagesWithLength.length - 1 &&
        currentMsg.message.role === 'assistant'
      ) {
        continue
      }

      // 如果加入当前消息后总长度超过限制
      if (totalLength + currentMsg.length > contextLength) {
        // 如果还没有选择任何消息，则只选择这一条
        if (selectedMessages.length === 0) {
          selectedMessages.push(currentMsg.formattedMessage)
        }
        break
      }

      totalLength += currentMsg.length
      selectedMessages.unshift(currentMsg.formattedMessage)
    }

    // 获取最后一条用户消息的内容
    const lastUserMessage = messagesWithLength.reverse().find((msg) => msg.message.role === 'user')
    if (lastUserMessage) {
      const userContent = lastUserMessage.message.content
      // 如果需要搜索，发送搜索事件并等待搜索结果
      if (userContent.search) {
        // 发送搜索事件
        eventBus.emit('search-requested', {
          messageId: state.message.id,
          query: userContent.text,
          files: userContent.files,
          links: userContent.links
        })

        // 等待搜索结果
        const searchResults = await new Promise<SearchResult[]>((resolve) => {
          const handleSearchResults = (results: { messageId: string; results: SearchResult[] }) => {
            if (results.messageId === state.message.id) {
              eventBus.off('search-results', handleSearchResults)
              resolve(results.results)
            }
          }
          eventBus.on('search-results', handleSearchResults)
        })

        // 生成搜索提示词
        const searchPrompt = generateSearchPrompt(userContent.text, searchResults)

        // 将搜索提示词添加到系统消息中
        formattedMessages.unshift({
          role: 'system',
          content: searchPrompt
        })
      }
    }

    formattedMessages.push(...selectedMessages)

    // 计算prompt tokens
    let promptTokens = 0
    for (const msg of formattedMessages) {
      promptTokens += approximateTokenSize(msg.content)
    }
    console.log('formattedMessage:', formattedMessages, 'promptTokens:', promptTokens)

    // 更新生成状态
    this.generatingMessages.set(state.message.id, {
      ...state,
      startTime: Date.now(),
      firstTokenTime: null,
      promptTokens
    })

    // 更新消息的usage信息
    await this.messageManager.updateMessageMetadata(state.message.id, {
      totalTokens: promptTokens,
      generationTime: 0,
      firstTokenTime: 0,
      tokensPerSecond: 0
    })

    await this.llmProviderPresenter.startStreamCompletion(
      providerId,
      formattedMessages,
      modelId,
      state.message.id,
      temperature,
      maxTokens
    )
  }

  async editMessage(messageId: string, content: string): Promise<Message> {
    return await this.messageManager.editMessage(messageId, content)
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.messageManager.deleteMessage(messageId)
  }

  async retryMessage(messageId: string): Promise<Message> {
    const message = await this.messageManager.getMessage(messageId)
    if (message.role !== 'assistant') {
      throw new Error('只能重试助手消息')
    }

    const userMessage = await this.messageManager.getMessage(message.parentId || '')
    if (!userMessage) {
      throw new Error('找不到对应的用户消息')
    }
    const conversation = await this.getConversation(message.conversationId)
    const { providerId, modelId } = conversation.settings
    const assistantMessage = await this.messageManager.retryMessage(messageId, {
      totalTokens: 0,
      generationTime: 0,
      firstTokenTime: 0,
      tokensPerSecond: 0,
      model: modelId,
      provider: providerId
    })
    try {
      this.generatingMessages.set(assistantMessage.id, {
        message: assistantMessage,
        conversationId: message.conversationId,
        startTime: Date.now(),
        firstTokenTime: null,
        promptTokens: 0,
        reasoningStartTime: null,
        reasoningEndTime: null,
        lastReasoningTime: null
      })

      return assistantMessage
    } catch (error) {
      await this.messageManager.updateMessageStatus(assistantMessage.id, 'error')
      console.error('生成 AI 响应失败:', error)
      throw error
    }
  }

  async getMessageVariants(messageId: string): Promise<Message[]> {
    return await this.messageManager.getMessageVariants(messageId)
  }

  async updateMessageStatus(messageId: string, status: MESSAGE_STATUS): Promise<void> {
    await this.messageManager.updateMessageStatus(messageId, status)
  }

  async updateMessageMetadata(
    messageId: string,
    metadata: Partial<MESSAGE_METADATA>
  ): Promise<void> {
    await this.messageManager.updateMessageMetadata(messageId, metadata)
  }

  async markMessageAsContextEdge(messageId: string, isEdge: boolean): Promise<void> {
    await this.messageManager.markMessageAsContextEdge(messageId, isEdge)
  }

  async getActiveConversationId(): Promise<string | null> {
    return this.activeConversationId
  }

  private async getLatestConversation(): Promise<CONVERSATION | null> {
    const result = await this.getConversationList(1, 1)
    return result.list[0] || null
  }

  getGeneratingMessageState(messageId: string): GeneratingMessageState | null {
    return this.generatingMessages.get(messageId) || null
  }

  getConversationGeneratingMessages(conversationId: string): AssistantMessage[] {
    return Array.from(this.generatingMessages.values())
      .filter((state) => state.conversationId === conversationId)
      .map((state) => state.message)
  }

  async stopMessageGeneration(messageId: string): Promise<void> {
    const state = this.generatingMessages.get(messageId)
    if (state) {
      // 添加用户取消的消息块
      state.message.content.forEach((block) => {
        if (block.status === 'loading') {
          block.status = 'success'
        }
      })
      state.message.content.push({
        type: 'error',
        content: 'common.error.userCanceledGeneration',
        status: 'cancel',
        timestamp: Date.now()
      })

      // 更新消息状态和内容
      await this.messageManager.updateMessageStatus(messageId, 'error')
      await this.messageManager.editMessage(messageId, JSON.stringify(state.message.content))

      // 停止流式生成
      await this.llmProviderPresenter.stopStream(messageId)

      // 清理生成状态
      this.generatingMessages.delete(messageId)
    }
  }

  async stopConversationGeneration(conversationId: string): Promise<void> {
    const messageIds = Array.from(this.generatingMessages.entries())
      .filter(([, state]) => state.conversationId === conversationId)
      .map(([messageId]) => messageId)

    await Promise.all(messageIds.map((messageId) => this.stopMessageGeneration(messageId)))
  }

  async summaryTitles(providerId?: string, modelId?: string): Promise<string> {
    const conversation = await this.getActiveConversation()
    if (!conversation) {
      throw new Error('找不到当前对话')
    }
    if (!modelId) {
      modelId = conversation.settings.modelId
    }
    let summaryProviderId = providerId
    if (!summaryProviderId) {
      summaryProviderId = conversation.settings.providerId
    }
    const messages = await this.getContextMessages(conversation.id)
    const messagesWithLength = messages
      .map((msg) => {
        if (msg.role === 'user') {
          return {
            message: msg,
            length: msg.content.text.length,
            formattedMessage: {
              role: 'user' as const,
              content: msg.content.text
            }
          }
        } else {
          const content = msg.content
            .filter((block) => block.type === 'content')
            .map((block) => block.content)
            .join('\n')
          return {
            message: msg,
            length: content.length,
            formattedMessage: {
              role: 'assistant' as const,
              content: content
            }
          }
        }
      })
      .filter((item) => item.formattedMessage.content.length > 0)
    return await this.llmProviderPresenter.summaryTitles(
      messagesWithLength.map((item) => item.formattedMessage),
      summaryProviderId,
      modelId
    )
  }
  async clearActiveThread(): Promise<void> {
    this.activeConversationId = null
    eventBus.emit('active-conversation-cleared')
  }
}
