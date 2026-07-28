import { describe, expect, it } from 'vitest'

import { sanitizeAggregateJson } from '../../../scripts/fetch-provider-db.mjs'

describe('fetch-provider-db', () => {
  it('preserves media types and classifies pinned OpenAI speech model IDs', () => {
    const sanitized = sanitizeAggregateJson({
      providers: {
        openai: {
          id: 'openai',
          models: [
            { id: 'tts-1', type: undefined },
            { id: 'tts-1-hd-1106' },
            { id: 'gpt-4o-mini-tts' },
            { id: 'openai/tts-1-hd' },
            { id: 'openai/tts-1', type: 'chat' },
            { id: 'future-speech', type: 'tts' },
            { id: 'future-video', type: 'video_generation' }
          ]
        }
      }
    })

    expect(sanitized?.providers.openai.models).toEqual([
      expect.objectContaining({ id: 'tts-1', type: 'tts' }),
      expect.objectContaining({ id: 'tts-1-hd-1106', type: 'tts' }),
      expect.objectContaining({ id: 'gpt-4o-mini-tts', type: 'tts' }),
      expect.objectContaining({ id: 'openai/tts-1-hd', type: 'tts' }),
      expect.objectContaining({ id: 'openai/tts-1', type: 'chat' }),
      expect.objectContaining({ id: 'future-speech', type: 'tts' }),
      expect.objectContaining({ id: 'future-video', type: 'videoGeneration' })
    ])
  })
})
