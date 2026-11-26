import AppKit
import Foundation
import MessagesObserverKit
import ServiceManagement
import SwiftUI

/// What the window shows at the top: can we read Messages, is Claude-Mem up, are we listening.
enum ListenerState: Equatable {
    case stopped
    case starting
    case listening(observing: Int)
    case failed(String)
}

enum ChatFilter: String, CaseIterable, Identifiable {
    case all = "All chats"
    case groups = "Group chats"
    case observing = "Observing"
    var id: String { rawValue }
}

struct LogLine: Identifiable, Equatable {
    let id = UUID()
    let at: Date
    let level: String
    let text: String
}

@MainActor
final class AppModel: ObservableObject {
    // Setup
    @Published var access: FullDiskAccess.State = .denied
    @Published var launch: CommandLaunch?
    @Published var workerReachable = false
    @Published var workerURL = ""
    @Published var commandProblem: String?

    // Chats
    @Published var chats: [ChatItem] = []
    @Published var defaultFocus = ""
    @Published var filter: ChatFilter = .all
    @Published var search = ""
    @Published var selection: String?
    @Published var loadingChats = false

    // Listener
    @Published var listener: ListenerState = .stopped
    @Published var sent = 0
    @Published var skipped = 0
    @Published var log: [LogLine] = []

    // Kept in UserDefaults. Plain @Published so the window updates when they change.
    private let defaults: UserDefaults
    @Published private(set) var source: MessageSource
    @Published var photonConfigured = false
    @Published var photonNumbers: [String] = []
    @Published var connectingPhoton = false
    private var pendingSource: MessageSource?
    private var photonWasListening: Bool {
        get { defaults.bool(forKey: "photonWasListening") }
        set { defaults.set(newValue, forKey: "photonWasListening") }
    }
    @Published var listenOnLaunch: Bool {
        didSet { defaults.set(listenOnLaunch, forKey: "listenOnLaunch") }
    }

    private var listenerID: UUID?
    private var running: RunningCommand?
    private var userStopped = false
    private var focusSaves: [String: Task<Void, Never>] = [:]
    private var lastSave: Task<Bool, Never>?
    private var sourceGeneration = 0
    private var chatsGeneration = 0
    @Published private(set) var savingPicks = Set<String>()
    @Published private(set) var pendingOptOuts: Set<String> {
        didSet { defaults.set(Array(pendingOptOuts), forKey: "pendingOptOuts") }
    }
    private var restartAfterStop = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        source = MessageSource(rawValue: defaults.string(forKey: "messageSource") ?? "") ?? .mac
        listenOnLaunch = defaults.object(forKey: "listenOnLaunch") as? Bool ?? true
        pendingOptOuts = Set(defaults.stringArray(forKey: "pendingOptOuts") ?? [])
    }

    var needsSetup: Bool { launch == nil || commandProblem != nil || !workerReachable || (source == .mac && access != .granted) }
    var canListen: Bool {
        guard !needsSetup, workerReachable, pendingSource == nil else { return false }
        return source == .photon ? photonConfigured && !connectingPhoton : observedCount > 0 && pendingOptOuts.isEmpty
    }

    var visibleChats: [ChatItem] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        return chats.filter { chat in
            switch filter {
            case .all: break
            case .groups: if !chat.isGroup { return false }
            case .observing: if !chat.observed { return false }
            }
            guard !query.isEmpty else { return true }
            return chat.name.lowercased().contains(query) || chat.members.contains { $0.lowercased().contains(query) }
        }
    }

    var observedCount: Int { chats.filter(\.observed).count }

    // MARK: Setup

    private var refreshGeneration = 0

    func selectSource(_ next: MessageSource) {
        guard next != source else { return }
        if running != nil {
            pendingSource = next
            stopListening()
            return
        }
        refreshGeneration += 1
        source = next
        sourceGeneration += 1
        chatsGeneration += 1
        defaults.set(next.rawValue, forKey: "messageSource")
        listener = .stopped
        selection = nil
        chats = []
        sent = 0
        skipped = 0
        log = []
        commandProblem = nil
        workerReachable = false
        // Selecting a source explicitly gives the person a chance to inspect it before listening.
        userStopped = true
        Task { await refreshAll() }
    }

    func refreshAll() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        if source == .mac { access = FullDiskAccess.check() }
        if launch == nil {
            let packaged = await Task.detached { CommandLaunch.packaged() }.value
            guard generation == refreshGeneration else { return }
            launch = packaged
        }
        guard let runner else {
            commandProblem = "The packaged observer could not be verified. Install Claude-Mem Messages again."
            return
        }
        do {
            let result = try await runner.run(source.command("check"))
            guard generation == refreshGeneration else { return }
            commandProblem = nil
            if let event = result.events.first {
                switch event {
                case let .check(messages, worker, _):
                    if messages.ok { access = .granted }
                    else if messages.reason == "no-permission" { access = .denied }
                    workerReachable = worker.reachable
                    workerURL = worker.url
                case let .photon(configured, numbers, worker):
                    photonConfigured = configured
                    photonNumbers = numbers
                    workerReachable = worker.reachable
                    workerURL = worker.url
                case let .error(_, message): commandProblem = message
                default: commandProblem = "The observer returned an unexpected response."
                }
            } else { commandProblem = "The observer did not answer. Check again." }
            if source == .mac, access == .granted { await loadChats() }
            guard generation == refreshGeneration else { return }
            if listenOnLaunch, canListen, running == nil, !userStopped, source == .mac || photonWasListening {
                startListening()
            }
        } catch {
            guard generation == refreshGeneration else { return }
            commandProblem = error.localizedDescription
        }
    }

    func connectPhoton(projectID: String, secret: String) async {
        guard source == .photon, !connectingPhoton, running == nil, let runner else { return }
        connectingPhoton = true
        defer { connectingPhoton = false }
        do {
            let data = try JSONEncoder().encode(["projectId": projectID, "projectSecret": secret])
            let result = try await runner.run(source.command("connect"), input: data)
            guard source == .photon else { return }
            if case let .error(_, message)? = result.events.first { commandProblem = message; return }
            guard result.status == 0 else { commandProblem = "Photon could not connect to this project."; return }
            await refreshAll()
        } catch { commandProblem = error.localizedDescription }
    }

    private var runner: CommandRunner? { launch.map(CommandRunner.init(launch:)) }

    func openFullDiskAccessSettings() {
        NSWorkspace.shared.open(FullDiskAccess.settingsURL)
    }

    func revealAppInFinder() {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }

    // MARK: Chats

    func loadChats() async {
        guard source == .mac, let runner else { return }
        chatsGeneration += 1
        let generation = chatsGeneration
        loadingChats = true
        defer { loadingChats = false }
        do {
            let result = try await runner.run(["imessage", "mac", "chats", "--json"])
            guard source == .mac, generation == chatsGeneration else { return }
            for event in result.events {
                if case let .chats(focus, list) = event {
                    chats = list
                    defaultFocus = focus
                    pendingOptOuts.subtract(list.filter { !$0.observed && !savingPicks.contains($0.guid) }.map(\.guid))
                }
            }
            if result.status != 0, !result.errorText.isEmpty { append("warn", result.errorText) }
        } catch {
            append("warn", "Could not list chats: \(error.localizedDescription)")
        }
    }

    func setObserved(_ guid: String, _ on: Bool) {
        let name = chats.first(where: { $0.guid == guid })?.name
        guard source == .mac, name != nil || (!on && pendingOptOuts.contains(guid)),
              savingPicks.insert(guid).inserted else { return }
        chatsGeneration += 1
        let chatName = name ?? "this chat"
        if !on { pendingOptOuts.insert(guid) }
        let generation = sourceGeneration
        Task {
            defer { savingPicks.remove(guid) }
            let saved = await pick(guid, ["--\(on ? "on" : "off")"])
            guard saved else {
                if !on, source == .mac {
                    userStopped = true
                    restartAfterStop = false
                    running?.discardAndStop()
                    append("warn", "Listening paused. Retry turning off \"\(chatName)\" to continue.")
                }
                return
            }
            pendingOptOuts.remove(guid)
            guard generation == sourceGeneration else { return }
            if let index = chats.firstIndex(where: { $0.guid == guid }) { chats[index].observed = on }
            append("info", on ? "Now observing \"\(chatName)\"." : "Stopped observing \"\(chatName)\".")
            if on, running == nil { startListening() }
        }
    }

    func retryOptOuts() {
        for guid in pendingOptOuts { setObserved(guid, false) }
    }

    /// Saves a chat's "observe for" text a moment after typing stops.
    func setFocus(_ guid: String, _ text: String) {
        guard let index = chats.firstIndex(where: { $0.guid == guid }), chats[index].focus != text else { return }
        chats[index].focus = text
        focusSaves[guid]?.cancel()
        focusSaves[guid] = Task {
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            await pick(guid, ["--focus", text])
        }
    }

    func saveDefaultFocus(_ text: String) {
        guard text != defaultFocus else { return }
        defaultFocus = text
        focusSaves["__default__"]?.cancel()
        focusSaves["__default__"] = Task {
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            await self.save(["imessage", "mac", "pick", "--default-focus", text, "--json"])
        }
    }

    @discardableResult
    private func pick(_ guid: String, _ flags: [String]) async -> Bool {
        await save(["imessage", "mac", "pick", guid] + flags + ["--json"])
    }

    /// Saves run one after another, so a tick and a focus edit never race.
    @discardableResult
    private func save(_ arguments: [String]) async -> Bool {
        let previous = lastSave
        let next = Task { [weak self] in
            _ = await previous?.value
            guard let self, let runner = self.runner else { return false }
            do {
                let result = try await runner.run(arguments)
                if result.status == 0, result.events.contains(.other(type: "picked")) { return true }
                if self.source == .mac { self.append("warn", result.errorText.isEmpty ? "Could not save the choice." : result.errorText) }
            } catch {
                if self.source == .mac { self.append("warn", "Could not save the choice: \(error.localizedDescription)") }
            }
            return false
        }
        lastSave = next
        return await next.value
    }

    func importContacts() async {
        guard await ContactNames.requestAccess() else {
            append("warn", "Contacts access was not given. Names stay as \"Phone ending …\".")
            return
        }
        do {
            let book = try await Task.detached { try ContactNames.addressBook() }.value
            let data = try JSONSerialization.data(withJSONObject: book)
            guard let runner else { return }
            let result = try await runner.run(["imessage", "mac", "contacts", "--replace", "--json"], input: data)
            append(result.status == 0 ? "info" : "warn",
                   result.status == 0 ? "Using \(book.count) names from Contacts." : result.errorText)
            await loadChats()
            // The listener reads names when it starts, so restart it to use the new ones.
            if result.status == 0, running != nil {
                restartAfterStop = true
                running?.stop()
            }
        } catch {
            append("warn", "Could not read Contacts: \(error.localizedDescription)")
        }
    }

    // MARK: Listener

    func startListening() {
        guard running == nil, canListen, let runner else { return }
        let id = UUID()
        listenerID = id
        userStopped = false
        listener = .starting
        do {
            running = try runner.stream(
                source.command("observe"),
                onEvent: { [weak self] event in Task { @MainActor in self?.handle(event, from: id) } },
                onStderr: { [weak self] text in Task { @MainActor in guard self?.listenerID == id, self?.userStopped == false else { return }; self?.append("warn", text) } },
                onExit: { [weak self] status in Task { @MainActor in guard self?.listenerID == id else { return }; self?.listenerExited(status) } }
            )
        } catch {
            listener = .failed(error.localizedDescription)
        }
    }

    func stopListening() {
        userStopped = true
        restartAfterStop = false
        if source == .photon { photonWasListening = false }
        running?.stop()
    }

    func handle(_ event: CommandEvent, from id: UUID? = nil) {
        // Exit still owns cleanup for a stopping process. Its late output must
        // not change the active source, status, or the person's launch choice.
        guard !userStopped, id == nil || id == listenerID else { return }
        switch event {
        case let .started(observing):
            listener = .listening(observing: observing)
            if source == .photon {
                photonWasListening = true
                append("info", "Listening to groups that include the Photon line.")
            } else { append("info", "Listening for new messages in \(observing) chat\(observing == 1 ? "" : "s").") }
        case .reconnecting:
            listener = .starting
        case let .status(observing, sent, skipped):
            if source == .mac, case .listening = listener { listener = .listening(observing: observing) }
            self.sent = sent
            self.skipped = skipped
        case let .log(level, message):
            append(level, message)
            if message.hasPrefix("Sent ") { sent += 1 }
        case let .error(reason, message):
            if reason == "no-permission" { access = .denied }
            listener = .failed(message)
            append("warn", message)
        case .stopped:
            listener = .stopped
        default:
            break
        }
    }

    private func listenerExited(_ status: Int32) {
        running = nil
        listenerID = nil
        if let next = pendingSource {
            pendingSource = nil
            selectSource(next)
            return
        }
        if restartAfterStop, !userStopped {
            restartAfterStop = false
            listener = .stopped
            startListening()
            return
        }
        if case .failed = listener { return }
        listener = .stopped
        if status != 0 && !userStopped {
            listener = .failed("The listener stopped (exit \(status)). See Activity.")
        }
    }

    func append(_ level: String, _ text: String) {
        log.append(LogLine(at: Date(), level: level, text: text))
        if log.count > 200 { log.removeFirst(log.count - 200) }
    }

    func shutdown() {
        running?.stop()
    }

    // MARK: Open at login

    var opensAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            do {
                if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch {
                append("warn", "Could not change Open at Login: \(error.localizedDescription)")
            }
            objectWillChange.send()
        }
    }
}
