import Foundation

/// Full Disk Access is what lets an app read ~/Library/Messages. macOS has no
/// call that asks for it: the person turns it on in System Settings. The app
/// checks by trying to open the Messages database for reading.
public enum FullDiskAccess {
    public static var messagesDatabase: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Messages/chat.db")
    }

    /// The Privacy & Security > Full Disk Access pane.
    public static let settingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!

    public enum State: Equatable, Sendable {
        case granted
        case denied
        /// No Messages database: Messages was never used on this Mac.
        case noDatabase
    }

    /// Tries to read the first bytes of chat.db. Reading changes nothing.
    public static func check(database: URL = messagesDatabase) -> State {
        let path = database.path
        let folder = database.deletingLastPathComponent().path
        if !FileManager.default.fileExists(atPath: path) {
            // Without access the folder itself cannot be listed.
            return (try? FileManager.default.contentsOfDirectory(atPath: folder)) == nil ? .denied : .noDatabase
        }
        guard let handle = FileHandle(forReadingAtPath: path) else { return .denied }
        defer { try? handle.close() }
        let header = (try? handle.read(upToCount: 16)) ?? Data()
        return header.starts(with: Array("SQLite format 3".utf8)) ? .granted : .denied
    }
}
