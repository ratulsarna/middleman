import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConversationMessageRow } from './ConversationMessageRow'
import type { ConversationMessageEntry } from './types'

function renderMessage(overrides: Partial<ConversationMessageEntry> = {}): string {
  const message: ConversationMessageEntry = {
    type: 'conversation_message',
    agentId: 'agent-1',
    role: 'assistant',
    text: 'Hello world',
    timestamp: '2026-03-03T11:00:00.000Z',
    source: 'speak_to_user',
    ...overrides,
  }

  return renderToStaticMarkup(
    createElement(ConversationMessageRow, { message }),
  )
}

describe('ConversationMessageRow thinking block', () => {
  it('renders thinking block when assistant message has thinking text', () => {
    const html = renderMessage({ thinking: 'I need to analyze this carefully' })

    expect(html).toContain('Thinking')
    expect(html).toContain('I need to analyze this carefully')
  })

  it('does not render thinking block when thinking is absent', () => {
    const html = renderMessage()

    expect(html).not.toContain('Thinking')
  })

  it('does not render thinking block when thinking is empty', () => {
    const html = renderMessage({ thinking: '' })

    expect(html).not.toContain('Thinking')
  })

  it('does not render thinking block when thinking is whitespace only', () => {
    const html = renderMessage({ thinking: '   \n\t  ' })

    expect(html).not.toContain('Thinking')
  })

  it('does not render thinking block for user messages', () => {
    const html = renderMessage({
      role: 'user',
      thinking: 'some thinking',
    })

    expect(html).not.toContain('Thinking')
  })

  it('does not render thinking block for system messages', () => {
    const html = renderMessage({
      role: 'system',
      thinking: 'some thinking',
    })

    expect(html).not.toContain('Thinking')
  })

  it('renders thinking block above the response text', () => {
    const html = renderMessage({
      text: 'The answer is 42',
      thinking: 'Let me calculate this',
    })

    const thinkingIndex = html.indexOf('Let me calculate this')
    const responseIndex = html.indexOf('The answer is 42')

    expect(thinkingIndex).toBeGreaterThan(-1)
    expect(responseIndex).toBeGreaterThan(-1)
    expect(thinkingIndex).toBeLessThan(responseIndex)
  })

  it('renders assistant message with only thinking and no text', () => {
    const html = renderMessage({
      text: '',
      thinking: 'thinking without response',
    })

    expect(html).toContain('Thinking')
    expect(html).toContain('thinking without response')
  })

  it('returns null when no text, no attachments, and no thinking', () => {
    const html = renderMessage({ text: '', thinking: undefined })

    expect(html).toBe('')
  })
})
