// Run with `npm test` (node --test; Node strips the types). The page's side of continuing a conversation: which rows
// offer it, what a row shows, and how the worker's answers and refusals are read.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CONVERSATION_CONTINUATION_STATES, type ConversationContinuation, type ConversationContinuationTarget } from '../../../../shared/conversation-continuation.ts'
import { interpolate } from '../../../i18n/locale.ts'
import { myworkKo } from '../../../i18n/mywork-ko.ts'
import { myworkTr } from '../../../i18n/mywork-tr.ts'
import { myworkZh } from '../../../i18n/mywork-zh.ts'
import { SAMPLE_REQUESTS } from '../data.ts'
import { myworkFr } from '../../../i18n/mywork-fr.ts'
import {
  CONTINUATION_STATE_WORDS, canContinueConversations, continuationEventConcernsConversation, continuationView, conversationAppActions,
  conversationReadFailureView, buttonLabelsKeepingTheirWidth, conversationControlNames, conversationRouteFailureSentence, focusAfterSendOrStop, folderPathForDisplay, isContinuableConversation,
  sentenceAroundFolder, readConversationContinuationAnswer, readConversationContinuationNotice, readConversationExchangeAnswer, readOpenedInAppAnswer,
  resumeCommandCopyFailureWords, unreachableWorkerSentence, unreadableAnswerSentence, type ButtonLabelInPlace, type ContinuationWords,
} from './conversation-continuation.ts'
import { createLocalSource } from './local-source.ts'
import { sampleSource } from './sample-source.ts'

const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const OTHER_SESSION = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f'
const RECORDED_FOLDER = '/work/example/worktree'
const NEAREST_FOLDER = '/work/example'
const STILL_RUNNING = 'This conversation is still answering your last message from here. Wait for its reply, or stop it, before you send another.'
const NO_FOLDER_RECORDED = 'No folder was recorded for this Claude Code conversation, so it can’t be continued from here.'
/** As long as the runner test's: a reply or a failure this size comes back whole. */
const LONG_TEXT = 'x'.repeat(200_000)

// As the worker on macOS answers for a Claude Code conversation: it can open one in the Claude app there.
const runsInRecordedFolder: ConversationContinuationTarget = { canContinue: true, recordedFolder: RECORDED_FOLDER, runsInFolder: RECORDED_FOLDER, recordedFolderIsGone: false, opensInAppNamed: 'Claude' }
const recordedFolderIsGone: ConversationContinuationTarget = { canContinue: true, recordedFolder: RECORDED_FOLDER, runsInFolder: NEAREST_FOLDER, recordedFolderIsGone: true, opensInAppNamed: 'Claude' }
/** As the worker answers for a Codex conversation, or for any conversation on Windows or Linux: no app opens it there. */
const opensInNoAppHere: ConversationContinuationTarget = { ...runsInRecordedFolder, opensInAppNamed: null }
const cannotContinue: ConversationContinuationTarget = { canContinue: false, refusalText: NO_FOLDER_RECORDED, recordedFolder: null }

function exchange(fields: Partial<ConversationContinuation> = {}): ConversationContinuation {
  return { exchangeId: 1, platform: 'claude', conversationSessionId: SESSION, state: 'running', ownerMessage: 'Which word? Reply with only the word.', startedAtEpochMs: 1_000, ranInFolder: RECORDED_FOLDER, ...fields }
}
const replied = (fields: Partial<ConversationContinuation> = {}) => exchange({ state: 'replied', endedAtEpochMs: 2_000, replyText: 'marmalade', deniedToolCallCount: 0, ...fields })
const failed = (fields: Partial<ConversationContinuation> = {}) => exchange({ state: 'failed', endedAtEpochMs: 2_000, failureText: 'You stopped this turn.', ...fields })

describe('which sources can continue a conversation', () => {
  const fetchNothing = (() => Promise.reject(new Error('No call is made here.'))) as typeof fetch

  it('the page this computer\'s worker serves', () => {
    assert.equal(canContinueConversations(createLocalSource({ hostname: 'localhost', fetchImpl: fetchNothing })), true)
  })

  it('not sample data, a cloud-served page, or a source without one of the four calls', () => {
    assert.equal(canContinueConversations(sampleSource), false)
    assert.equal(canContinueConversations(createLocalSource({ hostname: 'work.cmem.ai', fetchImpl: fetchNothing })), false)
    const local = createLocalSource({ hostname: 'localhost', fetchImpl: fetchNothing })
    for (const call of ['loadConversationContinuation', 'continueConversation', 'stopConversationContinuation', 'subscribeToConversationContinuations'] as const) {
      assert.equal(canContinueConversations({ ...local, [call]: undefined }), false, `without ${call}`)
    }
  })
})

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
    assert.deepEqual(view.exchanges, [{
      exchangeId: 1, startedAtEpochMs: 1_000, stopWasSent: false, ownerMessage: 'Which word? Reply with only the word.', state: 'running', stateWords: 'Working…',
      replyText: null, failureText: null, notices: [],
    }])
  })

  it('a Stop sent for a running turn waits for that turn to end, and the first turn after a worker restart, with the same id, never inherits it', () => {
    const stopSentFor = { exchangeId: 1, startedAtEpochMs: 1_000 }
    assert.equal(continuationView(runsInRecordedFolder, [exchange()], '', stopSentFor).exchanges[0].stopWasSent, true)
    assert.equal(continuationView(runsInRecordedFolder, [exchange()], '', null).exchanges[0].stopWasSent, false, 'no Stop sent')
    assert.equal(continuationView(runsInRecordedFolder, [exchange()], '').exchanges[0].stopWasSent, false, 'no Stop sent')
    // The worker restarted: it counts exchanges from 1 again, and its first one started after it did.
    const firstAfterRestart = exchange({ startedAtEpochMs: 9_000 })
    assert.equal(continuationView(runsInRecordedFolder, [firstAfterRestart], '', stopSentFor).exchanges[0].stopWasSent, false)
    // Another exchange of the same worker's life, after the stopped one ended.
    const views = continuationView(runsInRecordedFolder, [failed(), exchange({ exchangeId: 2, startedAtEpochMs: 3_000 })], '', stopSentFor).exchanges
    assert.deepEqual(views.map((view) => view.stopWasSent), [true, false])
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
    assert.deepEqual(view.exchanges[0], {
      exchangeId: 1, startedAtEpochMs: 1_000, stopWasSent: false, ownerMessage: 'Which word? Reply with only the word.', state: 'failed', stateWords: 'Did not finish',
      replyText: null, failureText: 'You stopped this turn.', notices: [],
    })
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
    const view = continuationView({ canContinue: true, recordedFolder: `${longFolder}/gone`, runsInFolder: longFolder, recordedFolderIsGone: true, opensInAppNamed: 'Claude' },
      [replied({ ownerMessage: LONG_TEXT, replyText: LONG_TEXT }), failed({ exchangeId: 2, failureText: LONG_TEXT })], '')
    assert.equal(view.exchanges[0].ownerMessage.length, LONG_TEXT.length)
    assert.equal(view.exchanges[0].replyText?.length, LONG_TEXT.length)
    assert.equal(view.exchanges[1].failureText?.length, LONG_TEXT.length)
    assert.equal(String(view.folderGoneNotice?.values.folder).length, longFolder.length)
  })
})

describe('what a row shows when a read of its conversation failed', () => {
  const unreachable = 'Could not read this conversation: the worker could not be reached (fetch failed).'
  /** What the button lays out for a view (buttonLabelsKeepingTheirWidth, as the row draws it). */
  const buttonLabelsOf = (view: NonNullable<ReturnType<typeof conversationReadFailureView>>) =>
    buttonLabelsKeepingTheirWidth(view.tryAgainLabel, view.tryingAgainLabel, view.isTryingAgain)

  it('the reason, whole, and "Try again", for the first read and any later one alike', () => {
    assert.deepEqual(conversationReadFailureView(unreachable, false), {
      failureText: unreachable, tryAgainLabel: 'Try again', tryingAgainLabel: 'Trying again…', isTryingAgain: false,
    })
    assert.equal(conversationReadFailureView(LONG_TEXT, false)?.failureText.length, LONG_TEXT.length)
  })

  it('keeps the reason and its button on screen while "Try again" reads again, and the button says it is trying again', () => {
    // As the row stands once "Try again" is pressed and before any read has answered: also when nothing was ever read, and
    // the reason and the button are all the row shows. A read that never answers leaves them there, button and all.
    const whileTryingAgain = conversationReadFailureView(unreachable, true)
    assert.ok(whileTryingAgain)
    assert.equal(whileTryingAgain.failureText, unreachable)
    assert.equal(whileTryingAgain.isTryingAgain, true)
    assert.deepEqual(buttonLabelsOf(whileTryingAgain), [{ text: 'Try again', isShown: false }, { text: 'Trying again…', isShown: true }])
  })

  it('shows the reason a new failed read gives in place of the old one, with "Try again" again', () => {
    const anotherReason = 'The worker answered 500, but this page cannot read its answer.'
    const afterTheNewReadFailed = conversationReadFailureView(anotherReason, false)
    assert.ok(afterTheNewReadFailed)
    assert.equal(afterTheNewReadFailed.failureText, anotherReason)
    assert.deepEqual(buttonLabelsOf(afterTheNewReadFailed), [{ text: 'Try again', isShown: true }, { text: 'Trying again…', isShown: false }])
  })

  it('nothing once a read has answered', () => {
    assert.equal(conversationReadFailureView(null, false), null)
    assert.equal(conversationReadFailureView(null, true), null)
  })

  it('"Try again" in the words the drawer already has, and "Trying again…", in every language My Work speaks', () => {
    const { tryAgainLabel, tryingAgainLabel } = conversationReadFailureView('The worker answered 500.', true)!
    for (const [language, catalog] of Object.entries({ zh: myworkZh, ko: myworkKo, tr: myworkTr, fr: myworkFr })) {
      for (const label of [tryAgainLabel, tryingAgainLabel]) assert.ok(catalog[label]?.trim(), `${language} has "${label}"`)
    }
  })
})

describe('what a row\'s message box, Send and Stop are called for a screen reader', () => {
  const inEnglish = (words: ContinuationWords) => interpolate(words.english, words.values)
  const namesFor = (fields: Partial<Parameters<typeof conversationControlNames>[0]> = {}) => conversationControlNames({
    toolName: 'Claude Code', conversationTitle: 'Fix the login flow', conversationSessionId: SESSION, anotherConversationHasTheSameTitle: false, ...fields,
  })

  it('names the conversation each Send and Stop acts on, so a request with several does not read "Send, Send, Send"', () => {
    const first = namesFor()
    const second = namesFor({ conversationTitle: 'Write the release notes', conversationSessionId: OTHER_SESSION })
    assert.equal(inEnglish(first.sendButton), 'Send to the Claude Code conversation “Fix the login flow”')
    assert.equal(inEnglish(first.stopButton), 'Stop the turn in the Claude Code conversation “Fix the login flow”')
    assert.notEqual(inEnglish(first.sendButton), inEnglish(second.sendButton))
    assert.notEqual(inEnglish(first.stopButton), inEnglish(second.stopButton))
    // The box keeps the label it had: the tool only.
    assert.equal(inEnglish(first.messageBox), 'Continue this Claude Code conversation')
  })

  it('adds the end of each session id when another row shows the same title', () => {
    // Codex session ids are time-ordered: conversations started within a minute share the title made from their start.
    const title = 'Conversation abcd0123'
    const first = namesFor({ toolName: 'Codex', conversationTitle: title, conversationSessionId: 'abcd0123-4e5f-7a6b-8c7d-9e0f1a2b3c4d', anotherConversationHasTheSameTitle: true })
    const second = namesFor({ toolName: 'Codex', conversationTitle: title, conversationSessionId: 'abcd0123-77aa-7bcd-8e2f-1a0b9c8d7e6f', anotherConversationHasTheSameTitle: true })
    assert.equal(inEnglish(first.messageBox), 'Continue this Codex conversation (…1a2b3c4d)')
    assert.equal(inEnglish(first.sendButton), 'Send to the Codex conversation “Conversation abcd0123” (…1a2b3c4d)')
    assert.equal(inEnglish(second.stopButton), 'Stop the turn in the Codex conversation “Conversation abcd0123” (…9c8d7e6f)')
    for (const control of ['messageBox', 'sendButton', 'stopButton'] as const) {
      assert.notEqual(inEnglish(first[control]), inEnglish(second[control]), control)
    }
  })

  it('has Chinese, Korean and Turkish words for every name, and each button\'s name holds the word it shows', () => {
    for (const names of [namesFor(), namesFor({ anotherConversationHasTheSameTitle: true })]) {
      // Someone who speaks to their computer says the word they see, so a name holds it (WCAG 2.5.3, label in name).
      assert.ok(names.sendButton.english.startsWith('Send '))
      assert.ok(names.stopButton.english.startsWith('Stop '))
      for (const [locale, catalog] of Object.entries({ 'zh-CN': myworkZh, ko: myworkKo, tr: myworkTr })) {
        for (const words of Object.values(names)) assert.ok(catalog[words.english]?.trim(), `${locale} has no words for ${words.english}`)
        const lower = (text: string) => text.toLocaleLowerCase(locale)
        assert.ok(lower(catalog[names.sendButton.english]).includes(lower(catalog['Send'])), `${locale}: ${catalog[names.sendButton.english]}`)
        assert.ok(lower(catalog[names.stopButton.english]).includes(lower(catalog['Stop'])), `${locale}: ${catalog[names.stopButton.english]}`)
      }
    }
  })
})

describe('what a row offers beside Send', () => {
  const inEnglish = (words: ContinuationWords) => interpolate(words.english, words.values)
  const claudeRow = { platform: 'claude' as const, conversationSessionId: SESSION, toolName: 'Claude Code', conversationTitle: 'Fix the login flow', anotherConversationHasTheSameTitle: false }
  const codexRow = { ...claudeRow, platform: 'codex' as const, toolName: 'Codex', conversationTitle: 'Write the release notes' }

  it('a Claude Code conversation: Open in Claude, the command that resumes it, and the folder its turn runs in', () => {
    const actions = conversationAppActions(claudeRow, runsInRecordedFolder, true)
    assert.deepEqual(actions, {
      openInApp: {
        label: { english: 'Open in {app}', values: { app: 'Claude' } },
        buttonName: { english: 'Open in {app}: the {tool} conversation “{title}”', values: { app: 'Claude', tool: 'Claude Code', title: 'Fix the login flow' } },
      },
      copyResumeCommand: {
        command: `claude --resume ${SESSION}`,
        buttonName: { english: 'Copy resume command for the {tool} conversation “{title}”', values: { tool: 'Claude Code', title: 'Fix the login flow' } },
        copiedButtonName: { english: 'Copied the resume command for the {tool} conversation “{title}”', values: { tool: 'Claude Code', title: 'Fix the login flow' } },
      },
      runsInFolderNotice: { english: 'Runs in {folder}', values: { folder: RECORDED_FOLDER } },
    })
    assert.equal(inEnglish(actions!.openInApp!.label), 'Open in Claude')
    assert.equal(inEnglish(actions!.runsInFolderNotice!), `Runs in ${RECORDED_FOLDER}`)
  })

  it('a Codex conversation: the command that resumes it, and no Open, since Codex documents no way to open one in its app', () => {
    const actions = conversationAppActions(codexRow, opensInNoAppHere, true)
    assert.equal(actions?.openInApp, null)
    assert.equal(actions?.copyResumeCommand.command, `codex resume ${SESSION}`)
    assert.equal(inEnglish(actions!.copyResumeCommand.buttonName), 'Copy resume command for the Codex conversation “Write the release notes”')
    assert.deepEqual(actions?.runsInFolderNotice, { english: 'Runs in {folder}', values: { folder: RECORDED_FOLDER } }, 'where to cd before the command')
  })

  it('no Open for a Claude Code conversation when the worker says no app opens it on this computer (Windows, Linux); the command still copies', () => {
    const actions = conversationAppActions(claudeRow, opensInNoAppHere, true)
    assert.equal(actions?.openInApp, null)
    assert.equal(actions?.copyResumeCommand.command, `claude --resume ${SESSION}`)
    assert.deepEqual(actions?.runsInFolderNotice, { english: 'Runs in {folder}', values: { folder: RECORDED_FOLDER } })
  })

  it('names the Open button after the app the worker says opens it', () => {
    const actions = conversationAppActions(claudeRow, { ...runsInRecordedFolder, opensInAppNamed: 'Claude Desktop' }, true)
    assert.equal(inEnglish(actions!.openInApp!.label), 'Open in Claude Desktop')
  })

  it('no Open when the page cannot ask the worker to open it; the command can still be copied', () => {
    const actions = conversationAppActions(claudeRow, runsInRecordedFolder, false)
    assert.equal(actions?.openInApp, null)
    assert.equal(actions?.copyResumeCommand.command, `claude --resume ${SESSION}`)
  })

  it('a recorded folder that is gone: no folder line, since the notice above the box says where the turn runs', () => {
    const actions = conversationAppActions(claudeRow, recordedFolderIsGone, true)
    assert.equal(actions?.runsInFolderNotice, null)
    assert.notEqual(actions?.openInApp, null)
    assert.notEqual(continuationView(recordedFolderIsGone, [], '').folderGoneNotice, null)
  })

  it('nothing where the row shows no Send: a conversation that can\'t be continued from here', () => {
    assert.equal(conversationAppActions(claudeRow, cannotContinue, true), null)
    assert.equal(conversationAppActions(codexRow, cannotContinue, true), null)
  })

  it('copies fixed words and the session id only: never the folder, whatever it holds', () => {
    const oddFolder = `/work/my "folder"; rm -rf ~ $(whoami)/${LONG_TEXT}`
    const actions = conversationAppActions(claudeRow, { canContinue: true, recordedFolder: oddFolder, runsInFolder: oddFolder, recordedFolderIsGone: false, opensInAppNamed: 'Claude' }, true)
    assert.deepEqual(actions?.copyResumeCommand.command.split(' '), ['claude', '--resume', SESSION])
    assert.equal(String(actions?.runsInFolderNotice?.values.folder).length, oddFolder.length, 'the folder is shown whole, beside the command')
  })

  it('names each button for the conversation it acts on, with the end of its session id when another row shows the same title', () => {
    const title = 'Conversation abcd0123'
    const first = conversationAppActions({ ...claudeRow, conversationTitle: title, conversationSessionId: 'abcd0123-4e5f-7a6b-8c7d-9e0f1a2b3c4d', anotherConversationHasTheSameTitle: true }, runsInRecordedFolder, true)!
    const second = conversationAppActions({ ...claudeRow, conversationTitle: title, conversationSessionId: 'abcd0123-77aa-7bcd-8e2f-1a0b9c8d7e6f', anotherConversationHasTheSameTitle: true }, runsInRecordedFolder, true)!
    assert.equal(inEnglish(first.openInApp!.buttonName), 'Open in Claude: the Claude Code conversation “Conversation abcd0123” (…1a2b3c4d)')
    assert.equal(inEnglish(first.copyResumeCommand.buttonName), 'Copy resume command for the Claude Code conversation “Conversation abcd0123” (…1a2b3c4d)')
    assert.equal(inEnglish(second.copyResumeCommand.copiedButtonName), 'Copied the resume command for the Claude Code conversation “Conversation abcd0123” (…9c8d7e6f)')
    for (const names of [(actions: typeof first) => actions.openInApp!.buttonName, (actions: typeof first) => actions.copyResumeCommand.buttonName, (actions: typeof first) => actions.copyResumeCommand.copiedButtonName]) {
      assert.notEqual(inEnglish(names(first)), inEnglish(names(second)))
    }
  })

  it('has Chinese, Korean and Turkish words for each, and each button\'s name holds the words it shows', () => {
    for (const actions of [conversationAppActions(claudeRow, runsInRecordedFolder, true)!, conversationAppActions({ ...claudeRow, anotherConversationHasTheSameTitle: true }, runsInRecordedFolder, true)!]) {
      const { openInApp, copyResumeCommand, runsInFolderNotice } = actions
      // Someone who speaks to their computer says the words they see, so a name holds them (WCAG 2.5.3, label in name).
      const buttons: Array<[label: string, name: ContinuationWords]> = [
        [openInApp!.label.english, openInApp!.buttonName], ['Copy resume command', copyResumeCommand.buttonName], ['Copied', copyResumeCommand.copiedButtonName],
      ]
      for (const [label, name] of buttons) assert.ok(name.english.startsWith(`${label}`), name.english)
      const words = [openInApp!.label.english, ...buttons.map(([label, name]) => [label, name.english]).flat(), runsInFolderNotice!.english,
        'Opening…', 'Could not copy the command: {reason}', 'Copy it from here:']
      for (const [locale, catalog] of Object.entries({ 'zh-CN': myworkZh, ko: myworkKo, tr: myworkTr })) {
        for (const english of words) assert.ok(catalog[english]?.trim(), `${locale} has no words for ${english}`)
        const lower = (text: string) => text.toLocaleLowerCase(locale)
        for (const [label, name] of buttons) assert.ok(lower(catalog[name.english]).includes(lower(catalog[label])), `${locale}: ${catalog[name.english]}`)
      }
    }
  })
})

describe('a folder as its row lays it out', () => {
  it('the folder\'s own name stands apart from its parents, and the two parts joined are the path', () => {
    assert.deepEqual(folderPathForDisplay(RECORDED_FOLDER), { parentWithSeparator: '/work/example/', folderName: 'worktree' })
    for (const folder of [RECORDED_FOLDER, '/work/example/', '/', '', 'worktree', 'C:\\work\\example', 'C:\\work\\example\\', '/a//b', LONG_TEXT]) {
      const { parentWithSeparator, folderName } = folderPathForDisplay(folder)
      assert.equal(parentWithSeparator + folderName, folder, `nothing is taken out of ${folder.slice(0, 40)}`)
    }
  })

  it('a path that ends in a separator keeps it on its name, a Windows path splits at its backslash, and a bare name is all name', () => {
    assert.deepEqual(folderPathForDisplay('/work/example/'), { parentWithSeparator: '/work/', folderName: 'example/' })
    assert.deepEqual(folderPathForDisplay('C:\\work\\example'), { parentWithSeparator: 'C:\\work\\', folderName: 'example' })
    assert.deepEqual(folderPathForDisplay('/'), { parentWithSeparator: '', folderName: '/' })
    assert.deepEqual(folderPathForDisplay('worktree'), { parentWithSeparator: '', folderName: 'worktree' })
  })

  it('a sentence that names a folder is split where the folder goes, in every language', () => {
    const runsIn: ContinuationWords = { english: 'Runs in {folder}', values: { folder: RECORDED_FOLDER } }
    assert.deepEqual(sentenceAroundFolder(runsIn.english, runsIn), { wordsBefore: 'Runs in ', folder: RECORDED_FOLDER, wordsAfter: '' })
    const folderGone: ContinuationWords = { english: 'Its folder is gone, so this turn will run in {folder}.', values: { folder: NEAREST_FOLDER } }
    assert.deepEqual(sentenceAroundFolder(folderGone.english, folderGone), { wordsBefore: 'Its folder is gone, so this turn will run in ', folder: NEAREST_FOLDER, wordsAfter: '.' })
    for (const words of [runsIn, folderGone]) {
      for (const catalog of [myworkZh, myworkKo, myworkTr, myworkFr]) {
        const translated = (catalog as Record<string, string>)[words.english]
        const sentence = sentenceAroundFolder(translated, words)
        assert.ok(sentence, `${translated} has a place for the folder`)
        // The three parts joined are the sentence the row showed before: the folder whole, and every word kept.
        assert.equal(sentence.wordsBefore + sentence.folder + sentence.wordsAfter, interpolate(translated, words.values))
      }
    }
  })

  it('a folder with braces or a dollar in its name is shown as it is', () => {
    const words: ContinuationWords = { english: 'Runs in {folder}', values: { folder: '/work/{folder}/$&' } }
    assert.deepEqual(sentenceAroundFolder(words.english, words), { wordsBefore: 'Runs in ', folder: '/work/{folder}/$&', wordsAfter: '' })
  })

  it('a sentence with no place for a folder, or words that carry none, is shown as it is', () => {
    assert.equal(sentenceAroundFolder('Runs here', { english: 'Runs here', values: { folder: RECORDED_FOLDER } }), null)
    assert.equal(sentenceAroundFolder('Runs in {folder}', { english: 'Runs in {folder}', values: {} }), null)
  })
})

describe('the buttons beside the message box keep their width while their label changes', () => {
  // A button is as wide as the widest label it lays out, so the same labels laid out in every state keep its width, and the
  // buttons after it in the row stay where they are.
  const laidOut = (labels: ButtonLabelInPlace[]) => labels.map((label) => label.text)
  const shown = (labels: ButtonLabelInPlace[]) => labels.filter((label) => label.isShown).map((label) => label.text)

  for (const [label, workingLabel] of [['Open in Claude', 'Opening…'], ['Send', 'Sending…'], [myworkZh['Send'], myworkZh['Sending…']]] as const) {
    it(`“${label}” lays out “${workingLabel}” in the same place in both states, and shows only the one for now`, () => {
      const idle = buttonLabelsKeepingTheirWidth(label, workingLabel, false)
      const working = buttonLabelsKeepingTheirWidth(label, workingLabel, true)
      assert.deepEqual(laidOut(idle), laidOut(working))
      assert.deepEqual([...laidOut(idle)].sort(), [label, workingLabel].sort())
      assert.deepEqual(shown(idle), [label])
      assert.deepEqual(shown(working), [workingLabel])
    })
  }
})

describe('what the row says when the clipboard does not take the command', () => {
  const inLanguage = (catalog: Record<string, string> | null, words: ContinuationWords) => interpolate(catalog ? catalog[words.english] : words.english, words.values)
  // Reasons browsers give, with and without a full stop of their own.
  const reasons = ['Write permission denied.', 'Document is not focused.', "Cannot read properties of undefined (reading 'writeText')", 'NotAllowedError']

  it('ends the first line with the browser\'s reason, whole, so a reason that has its own full stop never gets a second one', () => {
    for (const [language, catalog] of [['en', null], ['zh-CN', myworkZh], ['ko', myworkKo], ['tr', myworkTr]] as const) {
      for (const reason of reasons) {
        const words = resumeCommandCopyFailureWords(reason)
        const why = inLanguage(catalog, words.why)
        assert.ok(why.endsWith(reason), `${language}: ${why}`)
        assert.doesNotMatch(why, /[.。][)）]?[.。]/, `${language}: ${why}`)
        assert.ok(inLanguage(catalog, words.copyItFromHere).trim(), `${language} has words for ${words.copyItFromHere.english}`)
      }
    }
  })
})

describe('where focus goes after Send or Stop', () => {
  it('into the message box when the pressed button held focus: a pressed Send or Stop is disabled, and Stop goes away when its turn ends', () => {
    // Send pressed on a conversation with words typed, then Stop pressed on the turn it started.
    assert.equal(focusAfterSendOrStop(true, continuationView(runsInRecordedFolder, [], 'Which word?')), 'message-box')
    assert.equal(focusAfterSendOrStop(true, continuationView(runsInRecordedFolder, [exchange()], '')), 'message-box')
  })

  it('to the conversation\'s box when it has no message box: a turn is stopped after its conversation could no longer be continued', () => {
    const view = continuationView(cannotContinue, [exchange()], '')
    assert.equal(view.stopIsShown, true)
    assert.equal(focusAfterSendOrStop(true, view), 'conversation-box')
  })

  it('nowhere when the pressed button did not hold focus, as in a browser that does not focus a clicked button', () => {
    assert.equal(focusAfterSendOrStop(false, continuationView(runsInRecordedFolder, [exchange()], '')), null)
    assert.equal(focusAfterSendOrStop(false, continuationView(cannotContinue, [exchange()], '')), null)
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
      { target: { canContinue: true, recordedFolder: RECORDED_FOLDER, runsInFolder: RECORDED_FOLDER, recordedFolderIsGone: false }, exchanges: [] },
      { target: { ...runsInRecordedFolder, opensInAppNamed: 42 }, exchanges: [] },
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

  it('reads what the CLI printed as it opened the conversation, from the answer an open in the app gives, and nothing else', () => {
    const printedText = `Opening session ${SESSION} in Claude Desktop`
    assert.deepEqual(readOpenedInAppAnswer({ printedText }), { printedText })
    assert.deepEqual(readOpenedInAppAnswer({ printedText: null }), { printedText: null })
    for (const body of [{}, { printedText: 42 }, null, [], 'opened', 200]) assert.equal(readOpenedInAppAnswer(body), null, JSON.stringify(body))
  })

  it('reads the guarded read\'s target with the app the worker says opens the conversation, or none', () => {
    for (const target of [runsInRecordedFolder, opensInNoAppHere]) {
      assert.deepEqual(readConversationContinuationAnswer({ target, exchanges: [] }), { target, exchanges: [] })
    }
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
