import Foundation

public struct CommandResult: Sendable {
    public var status: Int32
    public var stdout: Data
    public var stderr: Data

    public var events: [CommandEvent] { CommandEvent.parseAll(stdout) }
    public var errorText: String {
        String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Runs claude-mem as a child of this app. Children count as the app for
/// Full Disk Access, so the app's permission covers their read of Messages.
public final class CommandRunner: @unchecked Sendable {
    public let launch: CommandLaunch

    public init(launch: CommandLaunch) {
        self.launch = launch
    }

    private func makeProcess(_ arguments: [String]) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launch.executable)
        process.arguments = launch.prefix + arguments
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = launch.path
        environment["NO_COLOR"] = "1"
        process.environment = environment
        return process
    }

    /// Runs a command to the end and returns what it printed.
    public func run(_ arguments: [String], input: Data? = nil) async throws -> CommandResult {
        let process = makeProcess(arguments)
        let out = Pipe()
        let err = Pipe()
        let stdin = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = stdin
        try process.run()
        if let input { stdin.fileHandleForWriting.write(input) }
        try? stdin.fileHandleForWriting.close()
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                // Read both pipes before waiting, so a chatty child cannot fill a pipe and stall.
                let stdoutData = DataBox()
                let stderrData = DataBox()
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global().async { stdoutData.set(out.fileHandleForReading.readDataToEndOfFile()); group.leave() }
                group.enter()
                DispatchQueue.global().async { stderrData.set(err.fileHandleForReading.readDataToEndOfFile()); group.leave() }
                group.wait()
                process.waitUntilExit()
                continuation.resume(returning: CommandResult(status: process.terminationStatus, stdout: stdoutData.get(), stderr: stderrData.get()))
            }
        }
    }

    /// Starts a long-running command and hands each JSON line to `onEvent` on the main queue.
    public func stream(
        _ arguments: [String],
        onEvent: @escaping @Sendable (CommandEvent) -> Void,
        onStderr: @escaping @Sendable (String) -> Void,
        onExit: @escaping @Sendable (Int32) -> Void
    ) throws -> RunningCommand {
        let process = makeProcess(arguments)
        let out = Pipe()
        let err = Pipe()
        let stdin = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = stdin
        let lines = LockedLineBuffer()
        out.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            for line in lines.append(data) {
                if let event = CommandEvent.parse(line) { DispatchQueue.main.async { onEvent(event) } }
            }
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { DispatchQueue.main.async { onStderr(text) } }
        }
        process.terminationHandler = { finished in
            let status = finished.terminationStatus
            DispatchQueue.main.async { onExit(status) }
        }
        try process.run()
        return RunningCommand(process: process, stdin: stdin)
    }
}

/// A command the app started and can stop.
public final class RunningCommand: @unchecked Sendable {
    private let process: Process
    private let stdin: Pipe

    init(process: Process, stdin: Pipe) {
        self.process = process
        self.stdin = stdin
    }

    public var isRunning: Bool { process.isRunning }

    /// Closing stdin tells the command to finish its open conversations and exit; SIGTERM backs it up.
    public func stop() {
        try? stdin.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
    }
}

final class LockedLineBuffer: @unchecked Sendable {
    private var buffer = LineBuffer()
    private let lock = NSLock()

    func append(_ data: Data) -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return buffer.append(data)
    }
}

final class DataBox: @unchecked Sendable {
    private var value = Data()
    private let lock = NSLock()

    func set(_ data: Data) { lock.lock(); value = data; lock.unlock() }
    func get() -> Data { lock.lock(); defer { lock.unlock() }; return value }
}
