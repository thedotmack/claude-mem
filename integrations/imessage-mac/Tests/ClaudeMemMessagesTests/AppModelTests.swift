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
    private func waitForSave(_ model: AppModel) async {
        for _ in 0..<100 where !model.savingPicks.isEmpty {
            try? await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(model.savingPicks.isEmpty)
    }
}
