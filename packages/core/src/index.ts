export { VERSION } from './version-constants'

export { downloadFile, assertSafeRemoteUrl, fetchJsonWithRetry } from './download'
export type { DownloadOptions } from './download'

export { hashFile, fileSha1, verifyFile } from './verify'
export type { HashAlgorithm } from './verify'

export { ChecksumMismatchError, HttpError, InvalidPlayerNameError } from './errors'
export { YggdrasilError } from './errors'

export {
  offlineUuid,
  validatePlayerName,
  loadAccounts,
  saveAccounts,
  PLAYER_NAME_PATTERN
} from './account'
export type { Account, OfflineAccount, YggdrasilAccount } from './account'

export {
  authenticate,
  fetchProfileWithSkin,
  fetchServerMeta,
  generateClientToken,
  invalidate,
  refresh,
  resolveApiRoot,
  validate
} from './yggdrasil'
export type {
  AuthServerMeta,
  AuthenticateResponse,
  ProfileWithSkin,
  RefreshResponse,
  SkinInfo,
  YgProfile,
  YgUser
} from './yggdrasil'

export { ensureAuthlibInjector } from './authlibInjector'
export type {
  AuthlibInjectorArtifact,
  AuthlibInjectorInfo,
  AuthlibInjectorInstallOptions
} from './authlibInjector'

export {
  BMCLAPI_MANIFEST_URL,
  DEFAULT_MANIFEST_URL,
  fetchVersionJson,
  fetchVersionManifest,
  fetchVersionManifestWithFallback,
  findVersionEntry,
  mergeVersionJson
} from './manifest'
export { fetchFabricLoaderVersions, fetchFabricProfileJson, installFabric } from './fabric'
export type { FabricLoaderVersion, FabricInstallOptions } from './fabric'
export { evaluateRules } from './rules'
export type { RuleContext } from './rules'

export { BMCLAPI_MAVEN_BASE, installVersion, extractNatives, mavenPath, nativesJarRelPath } from './install'
export type { InstallOptions, InstallProgress, InstallResult } from './install'

export { resolveInstalledVersion } from './installed'
export type { InstalledVersionResolution } from './installed'

export {
  DEFAULT_INSTANCE_ID,
  createInstance,
  deleteInstance,
  ensureDefaultInstance,
  getInstance,
  isInstanceId,
  listInstances,
  updateInstance
} from './instances'
export type { InstanceMeta } from './instances'

export {
  MODRINTH_USER_AGENT,
  installModFile,
  listModVersions,
  searchMods
} from './modrinth'
export type { ModrinthSearchHit, ModrinthVersion, ModrinthVersionFile } from './modrinth'

export { installLocalMod, listMods, removeMod } from './mods'
export type { ModFileInfo } from './mods'

export { readOptionsTxt, writeOptionsTxt } from './optionsTxt'

export { assembleLaunch } from './launch'
export type { AssembleOptions, JavaAgentOptions, LaunchSpec } from './launch'

export { assertJavaCompatible, detectJava, parseJavaVersionText, probeJava } from './java'
export type { JavaInfo } from './java'

export { ADOPTIUM_ASSETS_URL, installRuntime, listInstalledRuntimes, pickRuntime } from './runtime'
export type { RuntimeInfo, RuntimeInstallOptions, RuntimeProgress } from './runtime'
export { extractZip } from './zip'
export type { ExtractZipOptions } from './zip'
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
