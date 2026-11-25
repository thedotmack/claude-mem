// swift-tools-version:5.9
// Claude-Mem Messages: a Mac app that keeps Claude-Mem notes on the iMessage
// chats you pick. See docs/imessage-mac-app.md.
import PackageDescription

let package = Package(
    name: "ClaudeMemMessages",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ClaudeMemMessages", targets: ["ClaudeMemMessages"]),
    ],
    targets: [
        // Everything that can be tested without a window: the command's JSON,
        // finding claude-mem, the Full Disk Access check.
        .target(name: "MessagesObserverKit"),
        .executableTarget(name: "ClaudeMemMessages", dependencies: ["MessagesObserverKit"]),
        .testTarget(name: "MessagesObserverKitTests", dependencies: ["MessagesObserverKit"]),
    ]
)
