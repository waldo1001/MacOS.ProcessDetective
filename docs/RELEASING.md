# Releasing Process Detective (Developer ID + notarization)

Process Detective cannot go on the Mac App Store: it inspects other processes,
runs `lsof`/`ps`, and escalates to root through the admin dialog to run
`fs_usage`. None of that survives the App Sandbox. Direct distribution with a
Developer ID signature and Apple notarization gives the same "double-click and it
opens" experience on any Mac.

## One-time setup

### 1. Developer ID Application certificate

Fastest route (no CSR, no portal): Xcode → Settings → Accounts → select the team
→ **Manage Certificates…** → **+** → **Developer ID Application**. The key and
certificate land in the login keychain. Only the team's Account Holder can create
this certificate type.

Portal route (if Xcode refuses): generate a CSR with Keychain Access
(Certificate Assistant → Request a Certificate from a Certificate Authority, save
to disk), upload it at developer.apple.com → Certificates → **+** → Developer ID
Application → profile type "G2 Sub-CA", download the `.cer`, double-click it.

Verify:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

### 2. Notarization credentials

Create an app-specific password at account.apple.com → Sign-In and Security →
App-Specific Passwords (name it `notarytool`). Then store it once in the keychain
(the command prompts for the password, so it is never on the command line):

```bash
xcrun notarytool store-credentials PD-notary --apple-id <your-apple-id> --team-id <TEAMID>
```

Verify:

```bash
xcrun notarytool history --keychain-profile PD-notary
```

## Each release

```bash
npm version patch        # or minor/major — bumps package.json, used for CFBundleVersion
npm run release          # build → sign (Developer ID, hardened runtime) → notarize → staple → zip
```

Output: `release/ProcessDetective-<version>.zip`. Attach it to a GitHub release.
Recipients unzip and double-click; Gatekeeper sees the stapled ticket and opens it.

Options: `--identity="Developer ID Application: …"` to pick a certificate,
`--profile=<name>` for another notarytool profile, `--no-build` to re-submit the
existing bundle.

## Releasing from GitHub Actions

`.github/workflows/release.yml` runs the same `scripts/notarize.sh` on a macOS
runner whenever a `v*` tag is pushed, then publishes a GitHub release with the
notarized zip and a `SHA256SUMS.txt`. The tag must equal `v` + the
`package.json` version, otherwise the job stops before signing.

```bash
npm version patch
git push --follow-tags
```

A failed run can be retried for an existing tag from the Actions tab
(*Release → Run workflow*, enter the tag); assets are replaced on the existing release.

### One-time: repository secrets

Put them on the `release` environment (Settings → Environments → `release`), so
only the release job can read them. Add a required reviewer there if every
release should wait for a click.

| Secret | Value |
|---|---|
| `DEVELOPER_ID_CERT_P12_BASE64` | the Developer ID Application certificate + private key, exported as `.p12`, base64-encoded |
| `DEVELOPER_ID_CERT_PASSWORD` | the password chosen when exporting the `.p12` |
| `NOTARY_APPLE_ID` | the Apple ID used for notarization |
| `NOTARY_TEAM_ID` | the 10-character team ID |
| `NOTARY_PASSWORD` | an app-specific password for that Apple ID |

Export the certificate: Keychain Access → login → My Certificates → right-click
*Developer ID Application: …* → Export → `.p12` (pick a strong password). Then:

```bash
base64 -i DeveloperID.p12 | gh secret set DEVELOPER_ID_CERT_P12_BASE64 --env release
gh secret set DEVELOPER_ID_CERT_PASSWORD --env release
gh secret set NOTARY_APPLE_ID --env release
gh secret set NOTARY_TEAM_ID --env release
gh secret set NOTARY_PASSWORD --env release
```

`gh secret set` without a value prompts for it, so nothing lands in shell history.
Delete the `.p12` file afterwards. Locally `notarize.sh` still uses the keychain
profile; it switches to the `NOTARY_*` variables only when all three are set.

The runner is Apple Silicon, so the bundled Node runtime (and the release) is
arm64-only, the same as a local release built on an M-series Mac.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:
typecheck, the test suite, the full ad-hoc app build (bundle guard, `swiftc`,
hardened-runtime signing) and a smoke run of the bundled Node. The ad-hoc zip is
kept as a workflow artifact for 7 days. Dependabot proposes npm and Actions
updates weekly.

## What the build does for notarization

- Bundles the Node runtime as `Contents/MacOS/node` and installs production
  dependencies only (dev deps carry unsigned binaries that Apple rejects).
- Fails if any other Mach-O file is found in the bundle.
- Signs inside-out with `--options runtime` and a secure timestamp; the Node
  binary gets `native/node.entitlements` (JIT + unsigned executable memory, the
  minimum V8 needs; never `get-task-allow`).
- The local `npm run deploy` uses the exact same build with an ad-hoc identity,
  so entitlement problems surface locally before a release.

## Troubleshooting

- `notarytool submit` returns `Invalid`: run the printed `xcrun notarytool log
  <id>` command. Typical causes are an unsigned binary (the build guard should
  have caught it) or a missing timestamp (network issue during signing).
- The admin password dialog for `fs_usage` is unchanged by signing: it is a
  normal `osascript … with administrator privileges` call, allowed outside the
  sandbox.
