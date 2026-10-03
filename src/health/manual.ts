/**
 * Manual-step text templates. The health check never acts: when a fix needs
 * elevated rights, a GUI or a restart, the finding carries these steps and the
 * user runs them. This is the only health file that may mention elevated commands.
 */

/** Thin the APFS local snapshots (works for the current user, no elevated rights). */
export function thinSnapshotsSteps(): string[] {
  return ['tmutil thinlocalsnapshots / 999999999999 4'];
}

/** Remove a login item through System Settings. */
export function loginItemSteps(name: string): string[] {
  return [
    `System Settings → General → Login Items & Extensions → Open at Login → select “${name}” → click −`,
  ];
}

/** Remove a launchd job whose program is gone. System-wide plists need elevated rights. */
export function launchAgentSteps(plistPath: string, home: string): string[] {
  const inHome = plistPath.startsWith(`${home}/`);
  const q = `"${plistPath}"`;
  if (inHome) {
    return [
      `launchctl bootout gui/$(id -u) ${q}`,
      `mv ${q} ~/.Trash/`,
    ];
  }
  return [
    `sudo launchctl bootout system ${q}`,
    `sudo mv ${q} ~/.Trash/`,
  ];
}

/** Update through System Settings (the check never installs anything). */
export function softwareUpdateSteps(): string[] {
  return ['System Settings → General → Software Update → Update Now (needs a restart)'];
}

/**
 * Remove the nodejs.org installer's files from /usr/local so only the version
 * manager's Node stays on PATH. Review the file list first; none of it is run by Process Detective.
 */
export function usrLocalNodeSteps(): string[] {
  return [
    'pkgutil --pkgs | grep -i node          # find the installer receipt (usually org.nodejs.node.pkg)',
    'pkgutil --files org.nodejs.node.pkg    # review what it installed before removing anything',
    'sudo rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack',
    'sudo rm -rf /usr/local/lib/node_modules /usr/local/include/node /usr/local/share/doc/node',
    'sudo rm -f /usr/local/share/man/man1/node.1 /usr/local/share/systemtap/tapset/node.stp',
    'sudo pkgutil --forget org.nodejs.node.pkg',
  ];
}
