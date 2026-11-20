export { VERSION } from './version-constants'

export { downloadFile } from './download'
export type { DownloadOptions } from './download'

export { hashFile, fileSha1, verifyFile } from './verify'
export type { HashAlgorithm } from './verify'

export { ChecksumMismatchError, HttpError, InvalidPlayerNameError } from './errors'

export {
  offlineUuid,
  validatePlayerName,
  loadAccounts,
  saveAccounts,
  PLAYER_NAME_PATTERN
} from './account'
export type { Account } from './account'

export {
  DEFAULT_MANIFEST_URL,
  fetchVersionJson,
  fetchVersionManifest,
  findVersionEntry,
  mergeVersionJson
} from './manifest'
export { evaluateRules } from './rules'
export type { RuleContext } from './rules'

export { installVersion, extractNatives, mavenPath } from './install'
export type { InstallOptions, InstallProgress, InstallResult } from './install'

export { assembleLaunch } from './launch'
export type { AssembleOptions, LaunchSpec } from './launch'

export { assertJavaCompatible, detectJava, parseJavaVersionText } from './java'
export type { JavaInfo } from './java'
export { launchGame } from './gameProcess'
export type { LaunchHandle, LaunchHandlers } from './gameProcess'
export { JavaNotFoundError, JavaVersionMismatchError } from './errors'
export type {
  DownloadInfo,
  Library,
  LibraryDownloads,
  Rule,
  RuleBasedValue,
  RuleOs,
  VersionArguments,
  VersionJson,
  VersionLogging,
  VersionManifest,
  VersionManifestEntry
} from './version'
