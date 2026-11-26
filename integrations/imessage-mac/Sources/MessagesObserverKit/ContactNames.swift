import Contacts
import Foundation

/// Reads names for phone numbers and emails from the Mac's Contacts, so the
/// notes say "Ana" instead of "Phone ending 0001". Only name, phone and email
/// fields are read, and only after the person clicks "Use names from Contacts".
public enum ContactNames {
    public static func requestAccess() async -> Bool {
        let store = CNContactStore()
        do {
            return try await store.requestAccess(for: .contacts)
        } catch {
            return false
        }
    }

    /// Address → name for every contact with a phone number or email.
    public static func addressBook() throws -> [String: String] {
        let store = CNContactStore()
        let keys: [CNKeyDescriptor] = [
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactNicknameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
        ]
        var names: [String: String] = [:]
        try store.enumerateContacts(with: CNContactFetchRequest(keysToFetch: keys)) { contact, _ in
            guard let name = displayName(given: contact.givenName, family: contact.familyName,
                                         nickname: contact.nickname, organization: contact.organizationName) else { return }
            for phone in contact.phoneNumbers { names[phone.value.stringValue] = name }
            for email in contact.emailAddresses { names[(email.value as String).lowercased()] = name }
        }
        return names
    }

    /// "Ana Ruiz", else the nickname, else the company.
    public static func displayName(given: String, family: String, nickname: String, organization: String) -> String? {
        let full = [given, family].filter { !$0.isEmpty }.joined(separator: " ")
        for candidate in [full, nickname, organization] where !candidate.trimmingCharacters(in: .whitespaces).isEmpty {
            return candidate.trimmingCharacters(in: .whitespaces)
        }
        return nil
    }
}
