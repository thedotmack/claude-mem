import AppKit
import MessagesObserverKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if model.needsSetup {
                SetupView()
            } else {
                ChatsView()
            }
        }
        .frame(minWidth: 760, minHeight: 520)
        .task { await model.refreshAll() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            // Coming back from System Settings: check again without a click.
            if model.needsSetup { Task { await model.refreshAll() } }
        }
    }
}

// MARK: - Setup

struct SetupView: View {
    @EnvironmentObject var model: AppModel
    @State private var pathField = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Set up Claude-Mem Messages").font(.largeTitle.bold())
                    Text("Pick the chats you want remembered. New messages in those chats become notes in your Claude-Mem, on this Mac. Nothing is ever sent to a chat.")
                        .foregroundStyle(.secondary)
                }

                StepCard(number: 1, title: "Allow Full Disk Access", done: model.access == .granted) {
                    VStack(alignment: .leading, spacing: 10) {
                        switch model.access {
                        case .granted:
                            Text("Messages is readable.")
                        case .noDatabase:
                            Text("This Mac has no Messages history yet. Sign in to Messages with your Apple Account, then check again.")
                        case .denied:
                            Text("macOS keeps your messages private, so the app needs Full Disk Access to read them. macOS can't ask for it with a pop-up: you turn it on yourself.")
                            VStack(alignment: .leading, spacing: 4) {
                                Text("1. Click Open Full Disk Access below.")
                                Text("2. Turn on Claude-Mem Messages. If it isn't listed, click +, and pick it in Applications (Show the App finds it).")
                                Text("3. macOS may ask you to quit and reopen the app. Do that, and this step turns green.")
                            }
                            .font(.callout)
                            HStack {
                                Button("Open Full Disk Access") { model.openFullDiskAccessSettings() }
                                    .buttonStyle(.borderedProminent)
                                Button("Show the App") { model.revealAppInFinder() }
                                Button("Check Again") { Task { await model.refreshAll() } }
                            }
                        }
                    }
                }

                StepCard(number: 2, title: "Connect to Claude-Mem", done: model.launch != nil && model.workerReachable) {
                    VStack(alignment: .leading, spacing: 10) {
                        if let launch = model.launch {
                            Text("Using \(launch.displayName)").font(.callout.monospaced()).textSelection(.enabled)
                            if model.workerReachable {
                                Text("Claude-Mem is running at \(model.workerURL).")
                            } else {
                                Text("Claude-Mem isn't running. The app starts it when it starts listening, or start it now.")
                                Button("Start Claude-Mem") { Task { await model.startWorker() } }
                            }
                        } else {
                            Text(model.commandProblem ?? "Looking for claude-mem…")
                            Text("If you haven't installed Claude-Mem, run this in Terminal, then click Check Again:")
                                .font(.callout)
                            Text("npx claude-mem install").font(.body.monospaced()).textSelection(.enabled)
                                .padding(8).background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                        }
                        // Always here, so a wrong command can be replaced or cleared.
                        HStack {
                            TextField("Full path to claude-mem (leave empty to find it)", text: $pathField)
                                .textFieldStyle(.roundedBorder)
                            Button("Use") { Task { await model.useCommand(pathField) } }
                            if !model.commandPath.isEmpty {
                                Button("Clear") {
                                    pathField = ""
                                    Task { await model.useCommand("") }
                                }
                            }
                        }
                        if let problem = model.commandProblem, model.launch != nil {
                            Text(problem).foregroundStyle(.red).font(.callout)
                        }
                    }
                }

                StepCard(number: 3, title: "Pick chats", done: false) {
                    Text("Once the first two steps are green, your chats show up here. Tick the ones to observe and say what to watch for in each.")
                }

                HStack {
                    Spacer()
                    Button("Check Again") { Task { await model.refreshAll() } }
                        .keyboardShortcut("r")
                }
            }
            .padding(28)
            .frame(maxWidth: 680, alignment: .leading)
        }
        .onAppear { pathField = model.commandPath }
    }
}

struct StepCard<Content: View>: View {
    let number: Int
    let title: String
    let done: Bool
    @ViewBuilder var content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                Circle().fill(done ? Color.green : Color.accentColor).frame(width: 28, height: 28)
                if done {
                    Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                } else {
                    Text("\(number)").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.title3.bold())
                content
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Chats

struct ChatsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                Picker("Show", selection: $model.filter) {
                    ForEach(ChatFilter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(8)
                List(selection: $model.selection) {
                    ForEach(model.visibleChats) { chat in
                        ChatRow(chat: chat).tag(chat.guid)
                    }
                }
                .overlay {
                    if model.visibleChats.isEmpty {
                        ContentUnavailableView(model.loadingChats ? "Loading chats…" : "No chats",
                                               systemImage: "bubble.left.and.bubble.right")
                    }
                }
            }
            .searchable(text: $model.search, placement: .sidebar, prompt: "Search chats or people")
            .navigationSplitViewColumnWidth(min: 280, ideal: 320)
        } detail: {
            VStack(spacing: 0) {
                if let guid = model.selection, let chat = model.chats.first(where: { $0.guid == guid }) {
                    ChatDetail(chat: chat)
                } else {
                    OverviewView()
                }
                Divider()
                ActivityView().frame(height: 150)
            }
        }
        .toolbar {
            ToolbarItem(placement: .status) { ListenerBadge() }
            ToolbarItemGroup {
                Button { Task { await model.loadChats() } } label: { Label("Reload Chats", systemImage: "arrow.clockwise") }
                    .keyboardShortcut("r")
                ListenButton()
            }
        }
    }
}

struct ChatRow: View {
    @EnvironmentObject var model: AppModel
    let chat: ChatItem

    var body: some View {
        HStack(spacing: 10) {
            Toggle("", isOn: Binding(get: { chat.observed }, set: { model.setObserved(chat.guid, $0) }))
                .toggleStyle(.checkbox)
                .labelsHidden()
                .help(chat.observed ? "Stop observing this chat" : "Observe this chat")
            Image(systemName: chat.isGroup ? "person.3.fill" : "person.fill")
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(chat.name).lineLimit(1)
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            if let date = chat.lastMessageDate {
                Text(date, format: .relative(presentation: .named)).font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String {
        if !chat.focus.isEmpty && chat.observed { return "Watching for: \(chat.focus)" }
        if chat.isGroup { return chat.members.joined(separator: ", ") }
        return "\(chat.messageCount) messages"
    }
}

struct ChatDetail: View {
    @EnvironmentObject var model: AppModel
    let chat: ChatItem
    @State private var focus = ""

    private let examples = [
        "Plans, dates and who's bringing what",
        "Money: who paid, who owes, amounts",
        "Decisions and action items for the project",
        "Recommendations: places, books, links people share",
    ]

    var body: some View {
        Form {
            Section {
                LabeledContent("Chat", value: chat.name)
                LabeledContent("Kind", value: chat.isGroup ? "Group chat" : "Conversation")
                if !chat.members.isEmpty {
                    LabeledContent("People", value: chat.members.joined(separator: ", "))
                }
                LabeledContent("Messages", value: "\(chat.messageCount)")
                Toggle("Observe this chat", isOn: Binding(get: { chat.observed }, set: { model.setObserved(chat.guid, $0) }))
            }
            Section {
                TextField("Anything worth remembering", text: $focus, axis: .vertical)
                    .lineLimit(3...6)
                    .onChange(of: focus) { _, value in model.setFocus(chat.guid, value) }
                Menu("Examples") {
                    ForEach(examples, id: \.self) { example in
                        Button(example) { focus = example }
                    }
                }
                .fixedSize()
            } header: {
                Text("Observe for")
            } footer: {
                Text("Claude-Mem gives this the most attention when it writes notes on this chat. It applies from the next conversation in the chat.")
            }
            Section("Where the notes go") {
                if let project = chat.project {
                    LabeledContent("Claude-Mem project", value: project).textSelection(.enabled)
                } else {
                    Text("A Claude-Mem project named after this chat is made with the first notes.")
                        .foregroundStyle(.secondary)
                }
                Text("Only new messages are read, from when the app starts listening. Older history isn't imported.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { focus = chat.focus }
        .onChange(of: chat.guid) { _, _ in focus = chat.focus }
    }
}

struct OverviewView: View {
    @EnvironmentObject var model: AppModel
    @State private var defaultFocus = ""

    var body: some View {
        Form {
            Section("Observing") {
                LabeledContent("Chats picked", value: "\(model.observedCount)")
                LabeledContent("Conversations sent", value: "\(model.sent)")
                if model.skipped > 0 { LabeledContent("Skipped", value: "\(model.skipped)") }
                if model.observedCount == 0 {
                    Text("Tick a chat on the left to start.").foregroundStyle(.secondary)
                }
            }
            Section {
                TextField("For example: plans, decisions and promises", text: $defaultFocus, axis: .vertical)
                    .lineLimit(2...4)
                    .onChange(of: defaultFocus) { _, value in model.saveDefaultFocus(value) }
            } header: {
                Text("Observe for, in every chat")
            } footer: {
                Text("Used for chats that don't have their own.")
            }
            Section("Names") {
                Text("Notes name people from your Contacts. Without it, a phone number shows as \"Phone ending 1234\".")
                    .foregroundStyle(.secondary)
                Button("Use Names from Contacts") { Task { await model.importContacts() } }
            }
            Section("App") {
                Toggle("Start listening when the app opens", isOn: $model.listenOnLaunch)
                Toggle("Open at login", isOn: Binding(get: { model.opensAtLogin }, set: { model.opensAtLogin = $0 }))
                if let launch = model.launch {
                    LabeledContent("Claude-Mem command", value: launch.displayName).textSelection(.enabled)
                }
                LabeledContent("Claude-Mem", value: model.workerReachable ? "Running at \(model.workerURL)" : "Not running")
            }
        }
        .formStyle(.grouped)
        .onAppear { defaultFocus = model.defaultFocus }
    }
}

struct ActivityView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Activity").font(.caption.bold()).foregroundStyle(.secondary).padding([.horizontal, .top], 10)
            ScrollViewReader { proxy in
                List(model.log) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(line.at, format: .dateTime.hour().minute().second())
                            .font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                        Text(line.text).font(.caption)
                            .foregroundStyle(line.level == "warn" ? Color.orange : Color.primary)
                            .textSelection(.enabled)
                    }
                    .id(line.id)
                }
                .listStyle(.plain)
                .onChange(of: model.log.count) { _, _ in
                    if let last = model.log.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }
}

struct ListenerBadge: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(text).font(.callout)
        }
        .help(help)
    }

    private var color: Color {
        switch model.listener {
        case .listening: return .green
        case .starting: return .yellow
        case .failed: return .red
        case .stopped: return .secondary
        }
    }

    private var text: String {
        switch model.listener {
        case let .listening(count): return "Listening to \(count) chat\(count == 1 ? "" : "s")"
        case .starting: return "Starting…"
        case .failed: return "Stopped with a problem"
        case .stopped: return "Not listening"
        }
    }

    private var help: String {
        if case let .failed(message) = model.listener { return message }
        return text
    }
}

struct ListenButton: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        switch model.listener {
        case .listening, .starting:
            Button { model.stopListening() } label: { Label("Stop", systemImage: "stop.fill") }
        default:
            Button { model.startListening() } label: { Label("Listen", systemImage: "play.fill") }
                .disabled(model.observedCount == 0)
        }
    }
}

struct MenuBarContent: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(statusLine)
        Divider()
        switch model.listener {
        case .listening, .starting:
            Button("Stop Listening") { model.stopListening() }
        default:
            Button("Start Listening") { model.startListening() }.disabled(model.observedCount == 0 || model.needsSetup)
        }
        Button("Open Claude-Mem Messages") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        Divider()
        Button("Quit") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }

    private var statusLine: String {
        switch model.listener {
        case let .listening(count): return "Listening to \(count) chat\(count == 1 ? "" : "s") · \(model.sent) sent"
        case .starting: return "Starting…"
        case let .failed(message): return "Stopped: \(message)"
        case .stopped: return "Not listening"
        }
    }
}
