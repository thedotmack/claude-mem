import Foundation

/// How the app starts the claude-mem command.
public struct CommandLaunch: Equatable, Sendable {
    /// The program to run.
    public var executable: String
    /// Arguments that come before the command's own (for npx: --yes claude-mem).
    public var prefix: [String]
    /// PATH for the child, so `#!/usr/bin/env node` and bun are found.
    public var path: String

    public init(executable: String, prefix: [String], path: String) {
        self.executable = executable
        self.prefix = prefix
        self.path = path
    }

    public var displayName: String {
        ([executable] + prefix).joined(separator: " ")
    }
}

/// Finds claude-mem the way a terminal would. An app started from Finder gets
/// a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the usual install places
/// and the login shell's PATH are added in front of it.
public enum CommandLocator {
    /// Folders where npm, Homebrew, Bun, Volta, nvm and friends put commands.
    public static func commonFolders(home: String) -> [String] {
        [
            "\(home)/.bun/bin",
            "\(home)/.local/bin",
            "\(home)/.npm-global/bin",
            "\(home)/.volta/bin",
            "\(home)/Library/pnpm",
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ]
    }

    /// The child's PATH: login shell PATH first, then the common folders, then the system ones. No repeats.
    public static func searchPath(home: String, shellPath: String?, inherited: String?) -> String {
        var seen = Set<String>()
        var folders: [String] = []
        let parts = (shellPath ?? "").split(separator: ":").map(String.init)
            + commonFolders(home: home)
            + (inherited ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        for folder in parts where !folder.isEmpty && !seen.contains(folder) {
            seen.insert(folder)
            folders.append(folder)
        }
        return folders.joined(separator: ":")
    }

    /// Picks how to run claude-mem: a path the person set, else claude-mem on the PATH, else npx.
    public static func resolve(
        override: String?,
        searchPath: String,
        isExecutable: (String) -> Bool
    ) -> CommandLaunch? {
        if let override, !override.trimmingCharacters(in: .whitespaces).isEmpty {
            let path = (override as NSString).expandingTildeInPath
            return isExecutable(path) ? CommandLaunch(executable: path, prefix: [], path: searchPath) : nil
        }
        let folders = searchPath.split(separator: ":").map(String.init)
        for folder in folders {
            let candidate = "\(folder)/claude-mem"
            if isExecutable(candidate) { return CommandLaunch(executable: candidate, prefix: [], path: searchPath) }
        }
        for folder in folders {
            let npx = "\(folder)/npx"
            if isExecutable(npx) { return CommandLaunch(executable: npx, prefix: ["--yes", "claude-mem"], path: searchPath) }
        }
        return nil
    }

    /// The login shell's PATH, read once with a short time limit. Nil if the shell does not answer.
    public static func loginShellPath(shell: String = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh",
                                      timeout: TimeInterval = 5) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        // A marker keeps the PATH apart from anything a profile prints.
        process.arguments = ["-l", "-c", "printf '__CMEM_PATH__%s__CMEM_END__' \"$PATH\""]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if process.isRunning {
            process.terminate()
            return nil
        }
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return extractMarkedPath(text)
    }

    public static func extractMarkedPath(_ text: String) -> String? {
        guard let start = text.range(of: "__CMEM_PATH__"),
              let end = text.range(of: "__CMEM_END__", range: start.upperBound..<text.endIndex) else { return nil }
        let path = String(text[start.upperBound..<end.lowerBound])
        return path.isEmpty ? nil : path
    }
}
