// Export exactly ONE signing identity (certificate + private key) from the keychain
// as PKCS#12. `security export -t identities` would dump every identity in the
// keychain; this picks the one whose certificate SHA-1 matches.
//
//   P12_PASSWORD=… swift scripts/export-identity.swift <cert-sha1> <out.p12>
//
// macOS asks once to allow the private-key export (keychain prompt).
import CryptoKit
import Foundation
import Security

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write(Data("error: \(msg)\n".utf8))
  exit(1)
}

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: export-identity.swift <cert-sha1> <out.p12>") }
let wanted = args[1].uppercased()
let outPath = args[2]
guard let pass = ProcessInfo.processInfo.environment["P12_PASSWORD"], !pass.isEmpty else {
  fail("P12_PASSWORD is not set")
}

let query: [String: Any] = [
  kSecClass as String: kSecClassIdentity,
  kSecReturnRef as String: true,
  kSecMatchLimit as String: kSecMatchLimitAll,
]
var found: CFTypeRef?
guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
  let identities = found as? [SecIdentity]
else { fail("no identities in the keychain") }

func sha1(_ identity: SecIdentity) -> String? {
  var cert: SecCertificate?
  guard SecIdentityCopyCertificate(identity, &cert) == errSecSuccess, let cert else { return nil }
  let der = SecCertificateCopyData(cert) as Data
  return Insecure.SHA1.hash(data: der).map { String(format: "%02X", $0) }.joined()
}

guard let identity = identities.first(where: { sha1($0) == wanted }) else {
  fail("no identity with certificate SHA-1 \(wanted)")
}

var params = SecItemImportExportKeyParameters()
params.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
params.passphrase = Unmanaged.passRetained(pass as CFString)
var data: CFData?
let status = SecItemExport(identity, .formatPKCS12, [], &params, &data)
guard status == errSecSuccess, let data else {
  fail("export failed (\(status)): \(SecCopyErrorMessageString(status, nil) as String? ?? "unknown")")
}
FileManager.default.createFile(atPath: outPath, contents: data as Data, attributes: [.posixPermissions: 0o600])
