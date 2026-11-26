import Foundation
import Security

/// The observer is packaged for both processor families inside the signed app.
public struct CommandLaunch: Equatable, Sendable {
    public let executable: String
    public let prefix: [String]
    let requiresBundleVerification: Bool

    init(executable: String, prefix: [String] = [], requiresBundleVerification: Bool = false) {
        self.executable = executable
        self.prefix = prefix
        self.requiresBundleVerification = requiresBundleVerification
    }

    public static func packaged() -> CommandLaunch? {
        let bundle = Bundle.main.bundleURL.resolvingSymlinksInPath()
        #if arch(arm64)
        let name = "imessage-observer-arm64"
        #else
        let name = "imessage-observer-x64"
        #endif
        let file = bundle.appendingPathComponent("Contents/Helpers").appendingPathComponent(name)
        guard file.resolvingSymlinksInPath().path == file.path,
              FileManager.default.isExecutableFile(atPath: file.path),
              verifiedBundle(bundle) else { return nil }
        return CommandLaunch(executable: file.path, requiresBundleVerification: true)
    }

    /// Verify the sealed resources and nested signatures against the running
    /// app's own requirement. The release has an ad-hoc code signature.
    private static func verifiedBundle(_ bundle: URL) -> Bool {
        var running: SecCode?
        var origin: SecStaticCode?
        var requirement: SecRequirement?
        var disk: SecStaticCode?
        guard SecCodeCopySelf([], &running) == errSecSuccess, let running,
              SecCodeCopyStaticCode(running, [], &origin) == errSecSuccess, let origin,
              SecCodeCopyDesignatedRequirement(origin, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCreateWithPath(bundle as CFURL, [], &disk) == errSecSuccess, let disk else { return false }
        let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode)
        return SecStaticCodeCheckValidity(disk, flags, requirement) == errSecSuccess
    }
}
