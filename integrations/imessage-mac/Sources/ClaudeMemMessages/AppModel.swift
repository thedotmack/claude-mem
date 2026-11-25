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
    @Published var commandPath = UserDefaults.standard.string(forKey: "commandPath") ?? "" {
        didSet { UserDefaults.standard.set(commandPath, forKey: "commandPath") }
    }
    @Published var listenOnLaunch = UserDefaults.standard.object(forKey: "listenOnLaunch") as? Bool ?? true {
        didSet { UserDefaults.standard.set(listenOnLaunch, forKey: "listenOnLaunch") }
    }

    private var running: RunningCommand?
    private var userStopped = false
    private var focusSaves: [String: Task<Void, Never>] = [:]

    var needsSetup: Bool { access != .granted || launch == nil }

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

    /// Checks access, finds claude-mem, asks it about Messages and the worker, then loads chats.
    func refreshAll() async {
        access = FullDiskAccess.check()
        if launch == nil || !commandPath.isEmpty { await locateCommand() }
        guard let runner else { return }
        if let result = try? await runner.run(["imessage", "mac", "check", "--json"]) {
            for event in result.events {
                if case let .check(messages, worker, _) = event {
                    if messages.ok { access = .granted } else if messages.reason == "no-permission" { access = .denied }
                    workerReachable = worker.reachable
                    workerURL = worker.url
                }
            }
            if result.events.isEmpty {
                commandProblem = result.errorText.isEmpty
                    ? "claude-mem did not answer. Update it with: npx claude-mem@latest install"
                    : result.errorText
            } else {
                commandProblem = nil
            }
        }
        if access == .granted { await loadChats() }
        if access == .granted, listenOnLaunch, observedCount > 0, running == nil, !userStopped { startListening() }
    }

    func locateCommand() async {
        let override = commandPath
        let found: CommandLaunch? = await Task.detached {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            let shell = CommandLocator.loginShellPath()
            let path = CommandLocator.searchPath(home: home, shellPath: shell, inherited: ProcessInfo.processInfo.environment["PATH"])
            return CommandLocator.resolve(override: override.isEmpty ? nil : override, searchPath: path) {
                FileManager.default.isExecutableFile(atPath: $0)
            }
        }.value
        launch = found
        commandProblem = found == nil
            ? (override.isEmpty
                ? "Claude-Mem isn't installed, or Node isn't on your PATH. In Terminal run: npx claude-mem install"
                : "Nothing runnable at \(override).")
            : nil
    }

    private var runner: CommandRunner? { launch.map(CommandRunner.init(launch:)) }

    func openFullDiskAccessSettings() {
        NSWorkspace.shared.open(FullDiskAccess.settingsURL)
    }

    func revealAppInFinder() {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }

    func startWorker() async {
        guard let runner else { return }
        append("info", "Starting Claude-Mem…")
        let result = try? await runner.run(["start"])
        if let result, result.status != 0, !result.errorText.isEmpty { append("warn", result.errorText) }
        await refreshAll()
    }

    // MARK: Chats

    func loadChats() async {
        guard let runner else { return }
        loadingChats = true
        defer { loadingChats = false }
        do {
            let result = try await runner.run(["imessage", "mac", "chats", "--json"])
            for event in result.events {
                if case let .chats(focus, list) = event {
                    chats = list
                    defaultFocus = focus
                }
            }
            if result.status != 0, !result.errorText.isEmpty { append("warn", result.errorText) }
        } catch {
            append("warn", "Could not list chats: \(error.localizedDescription)")
        }
    }

    func setObserved(_ guid: String, _ on: Bool) {
        guard let index = chats.firstIndex(where: { $0.guid == guid }) else { return }
        chats[index].observed = on
        let name = chats[index].name
        Task {
            await pick(guid, ["--\(on ? "on" : "off")"])
            append("info", on ? "Now observing \"\(name)\"." : "Stopped observing \"\(name)\".")
            // The listener reads the new choice on its own; start it for the first picked chat.
            if on, running == nil, access == .granted { startListening() }
        }
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
            guard !Task.isCancelled, let runner else { return }
            _ = try? await runner.run(["imessage", "mac", "pick", "--default-focus", text, "--json"])
        }
    }

    private func pick(_ guid: String, _ flags: [String]) async {
        guard let runner else { return }
        do {
            let result = try await runner.run(["imessage", "mac", "pick", guid] + flags + ["--json"])
            if result.status != 0 { append("warn", result.errorText.isEmpty ? "Could not save the choice." : result.errorText) }
        } catch {
            append("warn", "Could not save the choice: \(error.localizedDescription)")
        }
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
        } catch {
            append("warn", "Could not read Contacts: \(error.localizedDescription)")
        }
    }

    // MARK: Listener

    func startListening() {
        guard running == nil, let runner else { return }
        userStopped = false
        listener = .starting
        do {
            running = try runner.stream(
                ["imessage", "mac", "observe", "--json"],
                onEvent: { [weak self] event in Task { @MainActor in self?.handle(event) } },
                onStderr: { [weak self] text in Task { @MainActor in self?.append("warn", text) } },
                onExit: { [weak self] status in Task { @MainActor in self?.listenerExited(status) } }
            )
        } catch {
            listener = .failed(error.localizedDescription)
        }
    }

    func stopListening() {
        userStopped = true
        running?.stop()
    }

    private func handle(_ event: CommandEvent) {
        switch event {
        case let .started(observing):
            listener = .listening(observing: observing)
            append("info", "Listening for new messages in \(observing) chat\(observing == 1 ? "" : "s").")
        case let .status(observing, sent, skipped):
            listener = .listening(observing: observing)
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
