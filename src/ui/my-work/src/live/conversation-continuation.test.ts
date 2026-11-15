// Run with `npm test` (node --test; Node strips the types). The page's side of continuing a conversation: which rows
// offer it, what a row shows, and how the worker's answers and refusals are read.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CONVERSATION_CONTINUATION_STATES, type ConversationContinuation, type ConversationContinuationTarget } from '../../../../shared/conversation-continuation.ts'
import { SAMPLE_REQUESTS } from '../data.ts'
import {
  CONTINUATION_STATE_WORDS, continuationEventConcernsConversation, continuationView, conversationRouteFailureSentence,
  isContinuableConversation, readConversationContinuationAnswer, readConversationContinuationNotice, readConversationExchangeAnswer,
  unreachableWorkerSentence, unreadableAnswerSentence,
} from './conversation-continuation.ts'

const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const OTHER_SESSION = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f'
const RECORDED_FOLDER = '/work/example/worktree'
const NEAREST_FOLDER = '/work/example'
const STILL_RUNNING = 'This conversation is still answering your last message from here. Wait for its reply, or stop it, before you send another.'
const NO_FOLDER_RECORDED = 'No folder was recorded for this Claude Code conversation, so it can\'t be continued from here.'
/** As long as the runner test's: a reply or a failure this size comes back whole. */
const LONG_TEXT = 'x'.repeat(200_000)

const runsInRecordedFolder: ConversationContinuationTarget = { canContinue: true, recordedFolder: RECORDED_FOLDER, runsInFolder: RECORDED_FOLDER, recordedFolderIsGone: false }
const recordedFolderIsGone: ConversationContinuationTarget = { canContinue: true, recordedFolder: RECORDED_FOLDER, runsInFolder: NEAREST_FOLDER, recordedFolderIsGone: true }
const cannotContinue: ConversationContinuationTarget = { canContinue: false, refusalText: NO_FOLDER_RECORDED, recordedFolder: null }

function exchange(fields: Partial<ConversationContinuation> = {}): ConversationContinuation {
  return { exchangeId: 1, platform: 'claude', conversationSessionId: SESSION, state: 'running', ownerMessage: 'Which word? Reply with only the word.', startedAtEpochMs: 1_000, ranInFolder: RECORDED_FOLDER, ...fields }
}
const replied = (fields: Partial<ConversationContinuation> = {}) => exchange({ state: 'replied', endedAtEpochMs: 2_000, replyText: 'marmalade', deniedToolCallCount: 0, ...fields })
const failed = (fields: Partial<ConversationContinuation> = {}) => exchange({ state: 'failed', endedAtEpochMs: 2_000, failureText: 'You stopped this turn.', ...fields })

describe('which conversation rows can offer to continue', () => {
  it('a Claude Code or Codex conversation with a UUID session id', () => {
    assert.equal(isContinuableConversation({ platform: 'claude', conversationSessionId: SESSION }), true)
    assert.equal(isContinuableConversation({ platform: 'codex', conversationSessionId: SESSION.toUpperCase() }), true)
  })

  it('not another tool, an id that is not a UUID, or a sample row', () => {
    assert.equal(isContinuableConversation({ platform: 'gemini', conversationSessionId: SESSION }), false)
    assert.equal(isContinuableConversation({ platform: 'claude', conversationSessionId: 'sample-conversation-1' }), false)
    assert.equal(isContinuableConversation({ platform: 'claude', conversationSessionId: `${SESSION} --help` }), false)
    assert.equal(isContinuableConversation({ platform: 'claude', conversationSessionId: '' }), false)
    const sampleRows = SAMPLE_REQUESTS.flatMap((request) => request.conversations)
    assert.ok(sampleRows.length > 0)
    for (const row of sampleRows) assert.equal(isContinuableConversation(row), false, `sample row ${row.conversationSessionId} would offer a live control`)
  })
})

describe('which events make a row read its conversation again', () => {
  const row = { platform: 'claude', conversationSessionId: SESSION }
  it('a notice about this conversation, or a reopened live stream', () => {
    assert.equal(continuationEventConcernsConversation({ exchangeId: 3, platform: 'claude', conversationSessionId: SESSION, state: 'replied' }, row), true)
    assert.equal(continuationEventConcernsConversation('live-updates-reconnected', row), true)
  })
  it('not a notice about another conversation, or the same id on another tool', () => {
    assert.equal(continuationEventConcernsConversation({ exchangeId: 3, platform: 'claude', conversationSessionId: OTHER_SESSION, state: 'replied' }, row), false)
    assert.equal(continuationEventConcernsConversation({ exchangeId: 3, platform: 'codex', conversationSessionId: SESSION, state: 'replied' }, row), false)
  })
})

describe('what a conversation row shows', () => {
  // The words for each state are checked below, on a running, a replied and a failed exchange.
  it('words every state in the one list of states', () => {
    for (const state of CONVERSATION_CONTINUATION_STATES) assert.ok(CONTINUATION_STATE_WORDS[state].trim(), state)
  })

  it('a conversation that can be continued, with nothing sent yet: the box, and Send once the message has words', () => {
    const empty = continuationView(runsInRecordedFolder, [], '')
    assert.deepEqual(empty, { refusalText: null, folderGoneNotice: null, composerIsShown: true, sendIsEnabled: false, stopIsShown: false, exchanges: [] })
    assert.equal(continuationView(runsInRecordedFolder, [], ' \n\t ').sendIsEnabled, false, 'the worker trims the message and refuses one with no words')
    assert.equal(continuationView(runsInRecordedFolder, [], 'Which word?').sendIsEnabled, true)
  })

  it('a recorded folder that is gone: before anything is sent, says where the turn will run instead', () => {
    const view = continuationView(recordedFolderIsGone, [], 'Which word?')
    assert.deepEqual(view.folderGoneNotice, { english: 'Its folder is gone, so this turn will run in {folder}.', values: { folder: NEAREST_FOLDER } })
    assert.equal(view.composerIsShown, true)
    assert.equal(view.sendIsEnabled, true)
  })

  it('a conversation that cannot be continued: the worker\'s sentence and no box', () => {
    const view = continuationView(cannotContinue, [], 'Which word?')
    assert.equal(view.refusalText, NO_FOLDER_RECORDED)
    assert.equal(view.composerIsShown, false)
    assert.equal(view.sendIsEnabled, false)
    assert.equal(view.folderGoneNotice, null)
    assert.equal(view.stopIsShown, false)
  })

  it('a running turn: Working…, Stop, and no second Send', () => {
    const view = continuationView(runsInRecordedFolder, [exchange()], 'And the word before that?')
    assert.equal(view.sendIsEnabled, false)
    assert.equal(view.stopIsShown, true)
    assert.deepEqual(view.exchanges, [{ exchangeId: 1, ownerMessage: 'Which word? Reply with only the word.', state: 'running', stateWords: 'Working…', replyText: null, failureText: null, notices: [] }])
  })

  it('a running turn can still be stopped when its conversation can no longer be continued', () => {
    const view = continuationView(cannotContinue, [exchange()], '')
    assert.equal(view.composerIsShown, false)
    assert.equal(view.stopIsShown, true)
  })

  it('a reply with tool calls the turn was not allowed to make: the reply, and how many, in words for one and for several', () => {
    const several = continuationView(runsInRecordedFolder, [replied({ deniedToolCallCount: 3 })], '').exchanges[0]
    assert.equal(several.stateWords, 'Replied')
    assert.equal(several.replyText, 'marmalade')
    assert.deepEqual(several.notices, [{ english: '{count} tool calls were not allowed in this turn. Open the conversation to approve them.', values: { count: 3 } }])
    const one = continuationView(runsInRecordedFolder, [replied({ deniedToolCallCount: 1 })], '').exchanges[0]
    assert.deepEqual(one.notices, [{ english: '{count} tool call was not allowed in this turn. Open the conversation to approve it.', values: { count: 1 } }])
    assert.deepEqual(continuationView(runsInRecordedFolder, [replied()], '').exchanges[0].notices, [], 'no denied calls, no notice')
  })

  it('a reply with no words says so instead of showing an empty block', () => {
    const noWords = { english: 'It finished without a written reply.', values: {} }
    const views = ['', '\n  \n', undefined].map((replyText) => continuationView(runsInRecordedFolder, [replied({ replyText })], '').exchanges[0])
    for (const view of views) {
      assert.equal(view.replyText, null)
      assert.deepEqual(view.notices, [noWords])
    }
    const withDeniedCalls = continuationView(runsInRecordedFolder, [replied({ replyText: '', deniedToolCallCount: 2 })], '').exchanges[0]
    assert.deepEqual(withDeniedCalls.notices.map((notice) => notice.english), [noWords.english, '{count} tool calls were not allowed in this turn. Open the conversation to approve them.'])
  })

  it('a turn that did not finish: its failure, whole, and Send works again', () => {
    const view = continuationView(runsInRecordedFolder, [failed()], 'Count again')
    assert.equal(view.sendIsEnabled, true)
    assert.equal(view.stopIsShown, false)
    assert.deepEqual(view.exchanges[0], { exchangeId: 1, ownerMessage: 'Which word? Reply with only the word.', state: 'failed', stateWords: 'Did not finish', replyText: null, failureText: 'You stopped this turn.', notices: [] })
  })

  it('a back-and-forth keeps the worker\'s order, and each exchange keeps its own message and reply', () => {
    const view = continuationView(runsInRecordedFolder, [
      replied({ exchangeId: 1 }),
      replied({ exchangeId: 2, ownerMessage: 'And the word before that? Reply with only: none', replyText: 'none' }),
      exchange({ exchangeId: 3, ownerMessage: 'Count slowly to 200, one number per line.' }),
    ], '')
    assert.deepEqual(view.exchanges.map(({ exchangeId, ownerMessage, replyText, state }) => ({ exchangeId, ownerMessage, replyText, state })), [
      { exchangeId: 1, ownerMessage: 'Which word? Reply with only the word.', replyText: 'marmalade', state: 'replied' },
      { exchangeId: 2, ownerMessage: 'And the word before that? Reply with only: none', replyText: 'none', state: 'replied' },
      { exchangeId: 3, ownerMessage: 'Count slowly to 200, one number per line.', replyText: null, state: 'running' },
    ])
  })

  it('passes a long message, reply, failure and folder on whole', () => {
    const longFolder = `/work/${LONG_TEXT}`
    const view = continuationView({ canContinue: true, recordedFolder: `${longFolder}/gone`, runsInFolder: longFolder, recordedFolderIsGone: true },
      [replied({ ownerMessage: LONG_TEXT, replyText: LONG_TEXT }), failed({ exchangeId: 2, failureText: LONG_TEXT })], '')
    assert.equal(view.exchanges[0].ownerMessage.length, LONG_TEXT.length)
    assert.equal(view.exchanges[0].replyText?.length, LONG_TEXT.length)
    assert.equal(view.exchanges[1].failureText?.length, LONG_TEXT.length)
    assert.equal(String(view.folderGoneNotice?.values.folder).length, longFolder.length)
  })
})

describe('reading the worker\'s answers', () => {
  it('reads the guarded read\'s answer for a conversation that can, and one that cannot, be continued', () => {
    const answer = { target: recordedFolderIsGone, exchanges: [replied(), failed({ exchangeId: 2 })] }
    assert.deepEqual(readConversationContinuationAnswer(structuredClone(answer)), answer)
    assert.deepEqual(readConversationContinuationAnswer({ target: cannotContinue, exchanges: [] }), { target: cannotContinue, exchanges: [] })
  })

  it('refuses an answer it cannot read, rather than showing part of it', () => {
    for (const body of [
      null, 'Not JSON', [], {},
      { target: runsInRecordedFolder },
      { target: runsInRecordedFolder, exchanges: {} },
      { target: { canContinue: true, recordedFolder: RECORDED_FOLDER }, exchanges: [] },
      { target: { canContinue: false, recordedFolder: null }, exchanges: [] },
      { target: runsInRecordedFolder, exchanges: [{ ...replied(), state: 'paused' }] },
      { target: runsInRecordedFolder, exchanges: [{ ...replied(), platform: 'gemini' }] },
      { target: runsInRecordedFolder, exchanges: [{ ...replied(), replyText: 42 }] },
    ]) assert.equal(readConversationContinuationAnswer(body), null, JSON.stringify(body))
  })

  it('reads the exchange a continue or a stop answers with', () => {
    assert.deepEqual(readConversationExchangeAnswer({ exchange: exchange() }), exchange())
    assert.equal(readConversationExchangeAnswer({}), null)
    assert.equal(readConversationExchangeAnswer({ exchange: { ...exchange(), exchangeId: '1' } }), null)
    assert.equal(readConversationExchangeAnswer(null), null)
  })

  it('reads a notice as its four fields only, and refuses one that is not a notice', () => {
    const notice = { exchangeId: 4, platform: 'codex', conversationSessionId: SESSION, state: 'running' }
    assert.deepEqual(readConversationContinuationNotice({ ...notice, ownerMessage: 'never on the stream' }), notice)
    assert.equal(readConversationContinuationNotice({ ...notice, state: 'paused' }), null)
    assert.equal(readConversationContinuationNotice({ ...notice, platform: 'gemini' }), null)
    assert.equal(readConversationContinuationNotice({ ...notice, exchangeId: '4' }), null)
    assert.equal(readConversationContinuationNotice({}), null)
  })
})

describe('a call that failed, as one plain sentence', () => {
  const answered = (status: number, statusText = '') => ({ status, statusText })

  it('the worker\'s own sentence: a refusal, a worker without the runner, a guard', () => {
    assert.equal(conversationRouteFailureSentence(answered(409, 'Conflict'), { error: STILL_RUNNING }, 'send your message'), STILL_RUNNING)
    assert.equal(conversationRouteFailureSentence(answered(503), { error: 'Continuing a conversation is unavailable on this worker.' }, 'read this conversation'),
      'Continuing a conversation is unavailable on this worker.')
    assert.equal(conversationRouteFailureSentence(answered(403), { error: 'Work view is available only on this computer.' }, 'stop this turn'), 'Work view is available only on this computer.')
    assert.equal(conversationRouteFailureSentence(answered(401), { error: 'Unauthorized', message: 'Missing or invalid local API token' }, 'send your message'),
      'Missing or invalid local API token', 'the worker-wide guards put their sentence in `message`')
    assert.equal(conversationRouteFailureSentence(answered(409), { error: LONG_TEXT }, 'send your message').length, LONG_TEXT.length, 'never shortened')
  })

  it('a message over the worker\'s JSON body limit, answered with Express\'s HTML page: too large, and no HTML', () => {
    assert.equal(conversationRouteFailureSentence(answered(413, 'Payload Too Large'), null, 'send your message'), 'Could not send your message: it is too large for the worker to take.')
  })

  it('a failed request check: the fields and what was wrong with them, not the code word', () => {
    const issues = [{ path: ['ownerMessage'], message: 'Too small: expected string to have >=1 characters', code: 'too_small' }]
    assert.equal(conversationRouteFailureSentence(answered(400), { error: 'ValidationError', issues }, 'send your message'),
      'Could not send your message: the worker could not read the request (ownerMessage: Too small: expected string to have >=1 characters).')
    assert.equal(conversationRouteFailureSentence(answered(400), { error: 'ValidationError', issues: [
      { path: ['conversationSessionId'], message: 'Invalid string: must match pattern', code: 'invalid_format' },
      { path: [], message: 'Unrecognized key: "token"', code: 'unrecognized_keys' },
    ] }, 'stop this turn'), 'Could not stop this turn: the worker could not read the request (conversationSessionId: Invalid string: must match pattern; Unrecognized key: "token").')
    assert.equal(conversationRouteFailureSentence(answered(400, 'Bad Request'), { error: 'ValidationError', issues: 'unreadable' }, 'send your message'),
      'Could not send your message: the worker answered 400 Bad Request.')
  })

  it('any other answer without a sentence: the status, never the body', () => {
    assert.equal(conversationRouteFailureSentence(answered(502, 'Bad Gateway'), null, 'read this conversation'), 'Could not read this conversation: the worker answered 502 Bad Gateway.')
    assert.equal(conversationRouteFailureSentence(answered(500), { error: '' }, 'read this conversation'), 'Could not read this conversation: the worker answered 500.')
    assert.equal(conversationRouteFailureSentence(answered(404), ['not', 'an', 'object'], 'stop this turn'), 'Could not stop this turn: the worker answered 404.')
  })

  it('no answer at all, and an answer this page cannot read', () => {
    assert.equal(unreachableWorkerSentence('stop this turn', new TypeError('fetch failed')), 'Could not stop this turn: the worker could not be reached (fetch failed).')
    assert.equal(unreadableAnswerSentence(202), 'The worker answered 202, but this page cannot read its answer.')
  })
})
