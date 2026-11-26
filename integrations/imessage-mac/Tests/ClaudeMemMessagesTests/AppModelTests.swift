import XCTest
@testable import ClaudeMemMessages
@testable import MessagesObserverKit

final class AppModelTests: XCTestCase {
    @MainActor
    func testFailedUnpickKeepsTheConfirmedChoiceAndBlocksListeningUntilSaved() async throws {
        let suite = "ClaudeMemMessagesTests-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(defaults: defaults)
        let chat = ChatItem(guid: "group-fixture", name: "Fixture", named: true, isGroup: true, service: "iMessage",
                            members: [], messageCount: 1, lastMessageAt: nil, observed: true, focus: "", project: nil)
        model.chats = [chat]
        model.access = .granted
        model.workerReachable = true
        model.launch = CommandLaunch(executable: "/usr/bin/false")
        XCTAssertTrue(model.canListen)
        model.setObserved(chat.guid, false)
        await waitForSave(model)
        XCTAssertTrue(model.chats[0].observed)
        XCTAssertFalse(model.canListen)
        XCTAssertTrue(AppModel(defaults: defaults).pendingOptOuts.contains(chat.guid))
        XCTAssertFalse(model.log.contains { $0.text.contains("Stopped observing") })

        model.launch = CommandLaunch(executable: "/usr/bin/printf", prefix: ["%s\\n", #"{"type":"picked"}"#])
        model.retryOptOuts()
        await waitForSave(model)
        XCTAssertFalse(model.chats[0].observed)
        XCTAssertTrue(model.pendingOptOuts.isEmpty)
        XCTAssertTrue(AppModel(defaults: defaults).pendingOptOuts.isEmpty)
    }

    @MainActor
    func testAChangingProjectAndStatusCountersCannotStartAnOldPhotonListener() throws {
        let suite = "ClaudeMemMessagesTests-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("photon", forKey: "messageSource")
        let model = AppModel(defaults: defaults)
        model.launch = CommandLaunch(executable: "/usr/bin/false")
        model.workerReachable = true
        model.photonConfigured = true
        model.connectingPhoton = true
        XCTAssertFalse(model.canListen)
        model.startListening()
        XCTAssertEqual(model.listener, .stopped)
        model.connectingPhoton = false
        XCTAssertTrue(model.canListen)
        model.listener = .starting
        model.handle(.status(observing: 0, sent: 0, skipped: 0))
        XCTAssertEqual(model.listener, .starting)
        model.handle(.started(observing: 0))
        XCTAssertEqual(model.listener, .listening(observing: 0))
        model.handle(.reconnecting)
        model.handle(.status(observing: 0, sent: 1, skipped: 0))
        XCTAssertEqual(model.listener, .starting)
        model.handle(.error(reason: "authorization", message: "Fixture authorization failed"))
        model.handle(.started(observing: 0))
        XCTAssertEqual(model.listener, .failed("Fixture authorization failed"))
        XCTAssertFalse(defaults.bool(forKey: "photonWasListening"))
    }

    @MainActor
    func testPhotonConfirmationAfterStopOrSourceSwitchCannotResumeOnNextLaunch() async throws {
        let choices: [[MessageSource]] = [[], [.mac], [.mac, .photon]]
        for requested in choices {
            let suite = "ClaudeMemMessagesTests-" + UUID().uuidString
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            defaults.set("photon", forKey: "messageSource")
            defaults.set(true, forKey: "photonWasListening")
            let model = AppModel(defaults: defaults)
            model.workerReachable = true
            model.photonConfigured = true
            // Stay alive on SIGTERM and deliver output after the caller closes stdin.
            let program = #"""
            trap '' TERM
            echo '{"type":"log","message":"fixture ready"}'
            cat >/dev/null
            echo '{"type":"started"}'
            echo '{"type":"status","sent":99}'
            """#
            model.launch = CommandLaunch(executable: "/bin/sh", prefix: ["-c", program])
            model.startListening()
            for _ in 0..<100 where !model.log.contains(where: { $0.text == "fixture ready" }) {
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertTrue(model.log.contains { $0.text == "fixture ready" })
            XCTAssertEqual(model.listener, .starting)
            if requested.isEmpty {
                model.stopListening()
            } else {
                for source in requested {
                    model.selectSource(source)
                    XCTAssertEqual(model.selectedSource, source)
                }
            }
            model.handle(.started(observing: 0))
            model.handle(.status(observing: 1, sent: 99, skipped: 0))
            for _ in 0..<100 where model.listener != .stopped {
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertEqual(model.listener, .stopped)
            XCTAssertEqual(model.source, requested.last ?? .photon)
            XCTAssertEqual(model.sent, 0)
            XCTAssertFalse(defaults.bool(forKey: "photonWasListening"))
        }
    }

    @MainActor
    func testOnlyAHealthyPhotonListenerResumesAfterQuitting() async throws {
        for quitWhileHealthy in [false, true] {
            let suite = "ClaudeMemMessagesTests-" + UUID().uuidString
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            let marker = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: marker) }
            defaults.set("photon", forKey: "messageSource")
            let model = AppModel(defaults: defaults)
            model.workerReachable = true
            model.photonConfigured = true
            let program = #"""
            echo '{"type":"started"}'
            while [ ! -f "$1" ]; do sleep 0.02; done
            exit 23
            """#
            model.launch = CommandLaunch(executable: "/bin/sh", prefix: ["-c", program, "fixture", marker.path])
            defer { model.shutdown() }
            model.startListening()
            for _ in 0..<100 where model.listener == .starting { try await Task.sleep(for: .milliseconds(20)) }
            XCTAssertTrue(defaults.bool(forKey: "photonWasListening"))
            if quitWhileHealthy {
                model.shutdown()
            }
            try Data().write(to: marker)
            if !quitWhileHealthy {
                for _ in 0..<100 where model.listener == .listening(observing: 0) { try await Task.sleep(for: .milliseconds(20)) }
                if case .failed = model.listener {} else { XCTFail("Expected a failed Photon listener") }
            }
            XCTAssertEqual(defaults.bool(forKey: "photonWasListening"), quitWhileHealthy)
        }
    }

    @MainActor
    private func waitForSave(_ model: AppModel) async {
        for _ in 0..<100 where !model.savingPicks.isEmpty {
            try? await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(model.savingPicks.isEmpty)
    }
}
