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
/// and the Node version managers' folders are added in front of it.
///
/// It never runs the login shell to read its PATH: shell profiles are plain
/// files anything on the Mac can edit, and the app holds Full Disk Access, so
/// running them from the app would hand that access to whatever is in them.
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

    /// Node's bin folders from nvm, fnm, asdf and mise, newest version first.
    /// Found by listing folders, never by running a shell.
    public static func versionManagerFolders(home: String, fileManager: FileManager = .default) -> [String] {
        func versions(_ root: String, bin: String) -> [String] {
            let names = (try? fileManager.contentsOfDirectory(atPath: root)) ?? []
            return names
                .filter { !$0.hasPrefix(".") }
                .sorted { $0.compare($1, options: .numeric) == .orderedDescending }
                .map { "\(root)/\($0)\(bin)" }
                .filter { fileManager.fileExists(atPath: $0) }
        }
        var folders = versions("\(home)/.nvm/versions/node", bin: "/bin")
        folders += versions("\(home)/Library/Application Support/fnm/node-versions", bin: "/installation/bin")
        folders += versions("\(home)/.local/share/fnm/node-versions", bin: "/installation/bin")
        folders += ["\(home)/.asdf/shims", "\(home)/.local/share/mise/shims", "/opt/homebrew/opt/node/bin", "/usr/local/opt/node/bin"]
            .filter { fileManager.fileExists(atPath: $0) }
        return folders
    }

    /// The child's PATH: version manager folders first, then the common folders, then the system ones. No repeats.
    public static func searchPath(home: String, extraFolders: [String], inherited: String?) -> String {
        var seen = Set<String>()
        var folders: [String] = []
        let parts = extraFolders
            + commonFolders(home: home)
            + (inherited ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        for folder in parts where !folder.isEmpty && !seen.contains(folder) {
            seen.insert(folder)
            folders.append(folder)
        }
        return folders.joined(separator: ":")
    }

    /// The npm package that carries the `imessage mac` commands. `@latest`, so
    /// an older copy left in npx's cache is never used.
    public static let package = "claude-mem@latest"

    /// Picks how to run claude-mem: a path the person set, else npx, else a
    /// claude-mem on the PATH that is not the hook launcher.
    ///
    /// The launcher Claude-Mem installs in ~/.local/bin only forwards hook and
    /// worker commands, so it can't run `imessage mac`; npx runs the full CLI.
    public static func resolve(
        override: String?,
        searchPath: String,
        home: String = FileManager.default.homeDirectoryForCurrentUser.path,
        isExecutable: (String) -> Bool
    ) -> CommandLaunch? {
        if let override, !override.trimmingCharacters(in: .whitespaces).isEmpty {
            let path = (override as NSString).expandingTildeInPath
            return isExecutable(path) ? CommandLaunch(executable: path, prefix: [], path: searchPath) : nil
        }
        let folders = searchPath.split(separator: ":").map(String.init)
        for folder in folders {
            let npx = "\(folder)/npx"
            if isExecutable(npx) { return CommandLaunch(executable: npx, prefix: ["--yes", package], path: searchPath) }
        }
        let launcherFolder = "\(home)/.local/bin"
        for folder in folders where folder != launcherFolder {
            let candidate = "\(folder)/claude-mem"
            if isExecutable(candidate) { return CommandLaunch(executable: candidate, prefix: [], path: searchPath) }
        }
        return nil
    }
}
