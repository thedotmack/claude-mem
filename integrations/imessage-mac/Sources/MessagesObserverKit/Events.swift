import Foundation

/// The source selected in the app. The command word stays separate from its label.
public enum MessageSource: String, CaseIterable, Sendable {
    case mac, photon

    public var title: String {
        switch self {
        case .mac: return "Messages on this Mac"
        case .photon: return "Photon line"
        }
    }

    public func command(_ action: String) -> [String] { ["imessage", rawValue, action, "--json"] }
}

/// One chat on this Mac, as `claude-mem imessage mac chats --json` lists it.
public struct ChatItem: Codable, Identifiable, Hashable, Sendable {
    public var guid: String
    public var name: String
    public var named: Bool
    public var isGroup: Bool
    public var service: String
    public var members: [String]
    public var messageCount: Int
    public var lastMessageAt: String?
    public var observed: Bool
    public var focus: String
    public var project: String?

    public var id: String { guid }

    public init(guid: String, name: String, named: Bool, isGroup: Bool, service: String, members: [String],
                messageCount: Int, lastMessageAt: String?, observed: Bool, focus: String, project: String?) {
        self.guid = guid
        self.name = name
        self.named = named
        self.isGroup = isGroup
        self.service = service
        self.members = members
        self.messageCount = messageCount
        self.lastMessageAt = lastMessageAt
        self.observed = observed
        self.focus = focus
        self.project = project
    }

    /// When the newest message in the chat was sent.
    public var lastMessageDate: Date? {
        guard let lastMessageAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: lastMessageAt) ?? ISO8601DateFormatter().date(from: lastMessageAt)
    }
}

/// Whether the command could read Messages, and why not.
public struct MessagesAccess: Codable, Hashable, Sendable {
    public var ok: Bool
    public var path: String
    /// "missing", "no-permission" or "unreadable" when `ok` is false.
    public var reason: String?
    public var detail: String?
}

public struct WorkerState: Codable, Hashable, Sendable {
    public var reachable: Bool
    public var url: String
    public var detail: String?
}

/// A line the command prints with --json. Lines it cannot read are skipped.
public enum CommandEvent: Equatable, Sendable {
    case chats(defaultFocus: String, chats: [ChatItem])
    case check(messages: MessagesAccess, worker: WorkerState, dataDir: String?)
    case photon(configured: Bool, lineNumbers: [String], worker: WorkerState)
    case started(observing: Int)
    case status(observing: Int, sent: Int, skipped: Int)
    case log(level: String, message: String)
    case error(reason: String, message: String)
    case stopped
    case other(type: String)

    private struct Envelope: Decodable { var type: String }
    private struct ChatsLine: Decodable { var defaultFocus: String?; var chats: [ChatItem] }
    private struct CheckLine: Decodable { var messages: MessagesAccess; var worker: WorkerState; var dataDir: String? }
    private struct PhotonLine: Decodable { var configured: Bool; var lineNumbers: [String]; var worker: WorkerState }
    private struct CountLine: Decodable { var observing: Int?; var sent: Int?; var skipped: Int? }
    private struct LogLine: Decodable { var level: String?; var message: String? }
    private struct ErrorLine: Decodable { var reason: String?; var message: String? }

    /// Reads one line of the command's output.
    public static func parse(_ line: Data) -> CommandEvent? {
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: line) else { return nil }
        switch envelope.type {
        case "chats":
            guard let value = try? decoder.decode(ChatsLine.self, from: line) else { return nil }
            return .chats(defaultFocus: value.defaultFocus ?? "", chats: value.chats)
        case "check":
            guard let value = try? decoder.decode(CheckLine.self, from: line) else { return nil }
            return .check(messages: value.messages, worker: value.worker, dataDir: value.dataDir)
        case "photon":
            guard let value = try? decoder.decode(PhotonLine.self, from: line) else { return nil }
            return .photon(configured: value.configured, lineNumbers: value.lineNumbers, worker: value.worker)
        case "started":
            let value = try? decoder.decode(CountLine.self, from: line)
            return .started(observing: value?.observing ?? 0)
        case "status":
            let value = try? decoder.decode(CountLine.self, from: line)
            return .status(observing: value?.observing ?? 0, sent: value?.sent ?? 0, skipped: value?.skipped ?? 0)
        case "log":
            let value = try? decoder.decode(LogLine.self, from: line)
            return .log(level: value?.level ?? "info", message: value?.message ?? "")
        case "error":
            let value = try? decoder.decode(ErrorLine.self, from: line)
            return .error(reason: value?.reason ?? "unknown", message: value?.message ?? "")
        case "stopped":
            return .stopped
        default:
            return .other(type: envelope.type)
        }
    }

    /// Every event in a whole output (non-JSON lines, like npm notices, are skipped).
    public static func parseAll(_ output: Data) -> [CommandEvent] {
        output.split(separator: UInt8(ascii: "\n")).compactMap { parse(Data($0)) }
    }
}

/// Splits a stream of bytes into whole lines as they arrive.
public struct LineBuffer: Sendable {
    private var pending = Data()

    public init() {}

    /// Adds bytes; returns the lines they completed.
    public mutating func append(_ data: Data) -> [Data] {
        pending.append(data)
        var lines: [Data] = []
        while let newline = pending.firstIndex(of: UInt8(ascii: "\n")) {
            let line = pending[pending.startIndex..<newline]
            if !line.isEmpty { lines.append(Data(line)) }
            pending.removeSubrange(pending.startIndex...newline)
        }
        return lines
    }

    /// The last line, if the stream ended without a newline.
    public mutating func finish() -> Data? {
        defer { pending = Data() }
        return pending.isEmpty ? nil : pending
    }
}
