import AppKit
import SwiftUI

/// Claude-Mem Messages: pick iMessage chats on this Mac and keep Claude-Mem
/// notes on them. The app reads Messages through the claude-mem command it
/// runs as a child; it never sends, reacts or changes anything in a chat.
@main
struct ClaudeMemMessagesApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        Window("Claude-Mem Messages", id: "main") {
            ContentView()
                .environmentObject(model)
                .onAppear { delegate.model = model }
        }
        .defaultSize(width: 980, height: 640)

        MenuBarExtra("Claude-Mem Messages", systemImage: "bubble.left.and.text.bubble.right") {
            MenuBarContent().environmentObject(model)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?

    /// Closing the window keeps the listener running in the menu bar.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { model?.shutdown() }
    }
}
