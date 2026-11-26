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

    func testPhotonEventsAndSourceCommands() {
        let line = #"{"type":"photon","configured":true,"lineNumbers":["Fixture"],"worker":{"reachable":true,"url":"http://127.0.0.1:37777"}}"#
        guard case let .photon(configured, numbers, worker)? = CommandEvent.parse(Data(line.utf8)) else {
            return XCTFail("Expected Photon setup status")
        }
        XCTAssertTrue(configured)
        XCTAssertEqual(numbers, ["Fixture"])
        XCTAssertTrue(worker.reachable)
        XCTAssertEqual(MessageSource.mac.command("check"), ["imessage", "mac", "check", "--json"])
        XCTAssertEqual(MessageSource.photon.command("observe"), ["imessage", "photon", "observe", "--json"])
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

final class CommandRunnerTests: XCTestCase {
    func testRunsAndStreamsJsonLines() async throws {
        let launch = CommandLaunch(executable: "/bin/sh", prefix: ["-c"])
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
