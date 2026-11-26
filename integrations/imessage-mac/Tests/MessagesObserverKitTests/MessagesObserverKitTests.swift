import Foundation
import XCTest
@testable import MessagesObserverKit

final class CommandEventTests: XCTestCase {
    func testReadsTheChatList() throws {
        let line = #"{"at":"2026-11-25T23:30:50.506Z","type":"chats","defaultFocus":"plans","chats":[{"guid":"iMessage;+;chat1","name":"Tahoe trip","named":true,"isGroup":true,"service":"iMessage","members":["Ana","ben@example.com"],"messageCount":1,"lastMessageAt":"2026-11-25T22:30:50.257Z","observed":true,"focus":"cabin money","project":null}]}"#
        guard case let .chats(focus, chats)? = CommandEvent.parse(Data(line.utf8)) else { return XCTFail("not a chats line") }
        XCTAssertEqual(focus, "plans")
        XCTAssertEqual(chats.count, 1)
        XCTAssertEqual(chats[0].name, "Tahoe trip")
        XCTAssertTrue(chats[0].observed)
        XCTAssertNil(chats[0].project)
        XCTAssertNotNil(chats[0].lastMessageDate)
    }

    func testReadsCheckStatusAndErrors() {
        let check = #"{"type":"check","messages":{"ok":false,"path":"/Users/a/Library/Messages/chat.db","reason":"no-permission","detail":"EPERM"},"worker":{"reachable":true,"url":"http://127.0.0.1:37700"},"dataDir":"/Users/a/.claude-mem"}"#
        guard case let .check(messages, worker, dataDir)? = CommandEvent.parse(Data(check.utf8)) else { return XCTFail("not a check line") }
        XCTAssertFalse(messages.ok)
        XCTAssertEqual(messages.reason, "no-permission")
        XCTAssertTrue(worker.reachable)
        XCTAssertEqual(dataDir, "/Users/a/.claude-mem")
        XCTAssertEqual(CommandEvent.parse(Data(#"{"type":"status","observing":2,"sent":5,"skipped":1}"#.utf8)), .status(observing: 2, sent: 5, skipped: 1))
        XCTAssertEqual(CommandEvent.parse(Data(#"{"type":"error","reason":"no-permission","message":"x"}"#.utf8)), .error(reason: "no-permission", message: "x"))
        XCTAssertEqual(CommandEvent.parse(Data(#"{"type":"stopped"}"#.utf8)), .stopped)
        XCTAssertNil(CommandEvent.parse(Data("npm warn exec The following package was not found".utf8)))
    }

    func testSkipsLinesThatAreNotEvents() {
        let output = "npm notice\n{\"type\":\"started\",\"observing\":1}\n\n{\"type\":\"stopped\"}\n"
        XCTAssertEqual(CommandEvent.parseAll(Data(output.utf8)), [.started(observing: 1), .stopped])
    }

    func testLineBufferJoinsSplitWrites() {
        var buffer = LineBuffer()
        XCTAssertEqual(buffer.append(Data("{\"type\":".utf8)), [])
        XCTAssertEqual(buffer.append(Data("\"stopped\"}\n{\"a\"".utf8)), [Data("{\"type\":\"stopped\"}".utf8)])
        XCTAssertEqual(buffer.finish(), Data("{\"a\"".utf8))
        XCTAssertNil(buffer.finish())
    }
}

final class CommandLocatorTests: XCTestCase {
    func testSearchPathPutsVersionManagersFirstWithoutRepeats() {
        let path = CommandLocator.searchPath(home: "/Users/a", extraFolders: ["/Users/a/.nvm/bin", "/usr/bin"], inherited: "/usr/bin:/bin")
        let parts = path.split(separator: ":").map(String.init)
        XCTAssertEqual(parts.first, "/Users/a/.nvm/bin")
        XCTAssertEqual(parts.filter { $0 == "/usr/bin" }.count, 1)
        XCTAssertTrue(parts.contains("/opt/homebrew/bin"))
        XCTAssertTrue(parts.contains("/Users/a/.bun/bin"))
    }

    func testKnowsWhichNodeVersionsClaudeMemRunsOn() {
        XCTAssertTrue(CommandLocator.isSupportedNode("v20.19.0"))
        XCTAssertTrue(CommandLocator.isSupportedNode("22.12.0"))
        XCTAssertTrue(CommandLocator.isSupportedNode("v23.0.0"))
        XCTAssertFalse(CommandLocator.isSupportedNode("v20.18.9"))
        XCTAssertFalse(CommandLocator.isSupportedNode("v21.7.0"))
        XCTAssertFalse(CommandLocator.isSupportedNode("v22.11.0"))
        XCTAssertFalse(CommandLocator.isSupportedNode("v18.20.0"))
        XCTAssertFalse(CommandLocator.isSupportedNode("default"))
    }

    func testPassesOverAFolderWhoseNodeIsTooOld() {
        let path = "/opt/homebrew/bin:/Users/a/.asdf/shims:/c"
        let versions = ["/opt/homebrew/bin": "v18.20.0\n", "/Users/a/.asdf/shims": "v22.13.0"]
        let picked = CommandLocator.resolve(override: nil, searchPath: path, home: "/Users/a",
                                            isExecutable: { $0.hasSuffix("/npx") }, nodeVersion: { versions[$0] })
        XCTAssertEqual(picked?.executable, "/Users/a/.asdf/shims/npx")
        // A node that can't be asked doesn't rule its folder out.
        let unknown = CommandLocator.resolve(override: nil, searchPath: path, home: "/Users/a",
                                             isExecutable: { $0.hasSuffix("/npx") }, nodeVersion: { _ in nil })
        XCTAssertEqual(unknown?.executable, "/opt/homebrew/bin/npx")
    }

    func testNeverRunsWhatIsInTheLauncherFolderOrUntrusted() {
        let path = "/Users/a/.local/bin:/a:/b"
        // An npx dropped into ~/.local/bin is never used.
        XCTAssertEqual(CommandLocator.resolve(override: nil, searchPath: path, home: "/Users/a",
                                              isExecutable: { $0.hasSuffix("/npx") })?.executable, "/a/npx")
        // A command other users can change is passed over.
        XCTAssertEqual(CommandLocator.resolve(override: nil, searchPath: path, home: "/Users/a",
                                              isExecutable: { $0.hasSuffix("/npx") },
                                              isTrusted: { $0 != "/a/npx" })?.executable, "/b/npx")
        XCTAssertFalse(CommandLocator.commonFolders(home: "/Users/a").contains("/Users/a/.local/bin"))
    }

    func testSpotsCommandsOtherUsersCanChange() throws {
        let fm = FileManager.default
        let folder = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        try fm.createDirectory(atPath: folder, withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: folder) }
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder)
        let file = "\(folder)/npx"
        try "#!/bin/sh\n".write(toFile: file, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file)
        XCTAssertTrue(CommandLocator.notWritableByOthers(file))
        try fm.setAttributes([.posixPermissions: 0o777], ofItemAtPath: file)
        XCTAssertFalse(CommandLocator.notWritableByOthers(file))
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file)
        try fm.setAttributes([.posixPermissions: 0o777], ofItemAtPath: folder)
        XCTAssertFalse(CommandLocator.notWritableByOthers(file))
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder)
        XCTAssertFalse(CommandLocator.notWritableByOthers("\(folder)/missing"))
    }

    func testAsksNodeItsVersionWithoutAShell() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: folder) }
        XCTAssertNil(CommandLocator.nodeVersion(in: folder, path: "/usr/bin:/bin"))
        let node = "\(folder)/node"
        try "#!/bin/sh\necho v22.13.0\n".write(toFile: node, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node)
        XCTAssertEqual(CommandLocator.nodeVersion(in: folder, path: "/usr/bin:/bin"), "v22.13.0")
    }

    func testPrefersNpxAndNeverTheHookLauncher() {
        let path = "/Users/a/.local/bin:/a:/b"
        let npx = CommandLocator.resolve(override: nil, searchPath: path, home: "/Users/a") { $0 == "/b/npx" || $0 == "/a/claude-mem" }
        XCTAssertEqual(npx?.executable, "/b/npx")
        XCTAssertEqual(npx?.prefix, ["--yes", "claude-mem@latest"])
        // Without npx, a claude-mem elsewhere on the PATH is used, but not the launcher in ~/.local/bin.
        XCTAssertEqual(CommandLocator.resolve(override: nil, searchPath: path, home: "/Users/a") {
            $0 == "/Users/a/.local/bin/claude-mem" || $0 == "/a/claude-mem"
        }?.executable, "/a/claude-mem")
        XCTAssertNil(CommandLocator.resolve(override: nil, searchPath: path, home: "/Users/a") { $0 == "/Users/a/.local/bin/claude-mem" })
        XCTAssertNil(CommandLocator.resolve(override: nil, searchPath: path, home: "/Users/a") { _ in false })
        XCTAssertEqual(CommandLocator.resolve(override: "/x/claude-mem", searchPath: path) { $0 == "/x/claude-mem" }?.executable, "/x/claude-mem")
        XCTAssertNil(CommandLocator.resolve(override: "/x/missing", searchPath: path) { _ in false })
    }

    func testFindsNodeVersionManagerFoldersNewestFirstWithoutAShell() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        defer { try? FileManager.default.removeItem(atPath: home) }
        for version in ["v18.20.0", "v20.10.0", "v20.19.2", "v22.11.0", "v22.12.0", "v24.1.0", "v9.0.0"] {
            try FileManager.default.createDirectory(atPath: "\(home)/.nvm/versions/node/\(version)/bin", withIntermediateDirectories: true)
        }
        try FileManager.default.createDirectory(atPath: "\(home)/.asdf/shims", withIntermediateDirectories: true)
        let folders = CommandLocator.versionManagerFolders(home: home)
        // Versions claude-mem can't run on (18, 20.10, 22.11, 9) are left out.
        XCTAssertEqual(Array(folders.prefix(3)), [
            "\(home)/.nvm/versions/node/v24.1.0/bin",
            "\(home)/.nvm/versions/node/v22.12.0/bin",
            "\(home)/.nvm/versions/node/v20.19.2/bin",
        ])
        XCTAssertEqual(folders.count, 3)
        // asdf shims can't be checked without running them, so they come after Homebrew.
        XCTAssertFalse(folders.contains("\(home)/.asdf/shims"))
        XCTAssertEqual(CommandLocator.shimFolders(home: home), ["\(home)/.asdf/shims"])
        let parts = CommandLocator.searchPath(home: home, extraFolders: folders,
                                              lateFolders: CommandLocator.shimFolders(home: home), inherited: "/usr/bin")
            .split(separator: ":").map(String.init)
        XCTAssertLessThan(parts.firstIndex(of: "/opt/homebrew/bin")!, parts.firstIndex(of: "\(home)/.asdf/shims")!)
        XCTAssertLessThan(parts.firstIndex(of: "\(home)/.asdf/shims")!, parts.firstIndex(of: "/usr/bin")!)
    }
}

final class CommandRunnerTests: XCTestCase {
    func testRunsAndStreamsJsonLines() async throws {
        let launch = CommandLaunch(executable: "/bin/sh", prefix: ["-c"], path: "/usr/bin:/bin")
        let runner = CommandRunner(launch: launch)
        let result = try await runner.run(["cat; echo '{\"type\":\"stopped\"}'"], input: Data("{\"type\":\"started\",\"observing\":3}\n".utf8))
        XCTAssertEqual(result.status, 0)
        XCTAssertEqual(result.events, [.started(observing: 3), .stopped])

        let got = expectation(description: "events and exit")
        let events = EventBox()
        let running = try runner.stream(
            ["printf '{\"type\":\"started\",\"observing\":1}\\n'; cat >/dev/null; printf '{\"type\":\"stopped\"}\\n'"],
            onEvent: { events.add($0) },
            onStderr: { _ in },
            onExit: { _ in got.fulfill() }
        )
        try await Task.sleep(nanoseconds: 300_000_000)
        running.stop()
        await fulfillment(of: [got], timeout: 5)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(events.all.first, .started(observing: 1))
    }
}

final class FullDiskAccessTests: XCTestCase {
    func testReadsAnSQLiteHeaderAndSpotsAMissingDatabase() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let db = folder.appendingPathComponent("chat.db")
        XCTAssertEqual(FullDiskAccess.check(database: db), .noDatabase)
        try Data("SQLite format 3\u{0}rest".utf8).write(to: db)
        XCTAssertEqual(FullDiskAccess.check(database: db), .granted)
        try Data("nope".utf8).write(to: db)
        XCTAssertEqual(FullDiskAccess.check(database: db), .denied)
    }
}

final class ContactNamesTests: XCTestCase {
    func testDisplayName() {
        XCTAssertEqual(ContactNames.displayName(given: "Ana", family: "Ruiz", nickname: "", organization: ""), "Ana Ruiz")
        XCTAssertEqual(ContactNames.displayName(given: "", family: "", nickname: "Benji", organization: "Acme"), "Benji")
        XCTAssertEqual(ContactNames.displayName(given: "", family: "", nickname: "", organization: "Acme"), "Acme")
        XCTAssertNil(ContactNames.displayName(given: "", family: "", nickname: " ", organization: ""))
    }
}

final class EventBox: @unchecked Sendable {
    private var events: [CommandEvent] = []
    private let lock = NSLock()
    func add(_ event: CommandEvent) { lock.lock(); events.append(event); lock.unlock() }
    var all: [CommandEvent] { lock.lock(); defer { lock.unlock() }; return events }
}
