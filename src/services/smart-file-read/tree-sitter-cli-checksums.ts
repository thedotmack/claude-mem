// SHA-256 of the tree-sitter executable that tree-sitter-cli's install.js
// writes, per package version and `${process.platform}-${process.arch}`.
// ensureTreeSitterCliBinary checks a downloaded executable against this before
// it runs it once or moves it into place, so a replaced release asset is never
// executed. Each digest is of the gunzipped release asset install.js picks for
// that platform (tree-sitter-<os>-<arch>.gz), and every .gz matched the digest
// GitHub publishes for the release. tests/services/smart-file-read/
// tree-sitter-cli-checksums.test.ts fails when plugin/bun.lock moves to a
// version this table lacks; add that version's digests here.
export const TREE_SITTER_EXECUTABLE_SHA256: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "0.26.9": {
    "darwin-arm64": "01f07ce8820a478eec92f6b5d058c98e21dd258f1d8eac43c4eb765330c9ab9e",
    "darwin-x64": "35d94440563f355eedb73c80295adea01dab2a732d4f8c7852c0b2703db09fcd",
    "linux-arm": "d07200c73af76d6afe6fc42fcaad8091430208bbf1d33e60252a7147d8a7e43c",
    "linux-arm64": "0dbc9e41f374a4310d560bcd6ff886dc9d23f40ba7b014ebb6df498f788a1505",
    "linux-ppc64": "923f4600d4bed9779bec698dbf29e7fae2b64343c8795cd505b67235df2249fb",
    "linux-x64": "ca9a7bf542473e956aab7d69e2154a60e4b4ac9f8eaf56f248692fc6d340efa4",
    "win32-arm64": "ffcff3313976e3edb3c275be286ba01c887774d510e1cd48bc8f8e4fdb16b20c",
    "win32-ia32": "15a4049b455aa6504c37e0dced0284eada9028cf306acc61b0a3afab484840e7",
    "win32-x64": "cdeb1148a57c1b539d626ac032b34560d8910d10a1fc0159b362b00349d0813a",
  },
};

/** The pinned digest for a tree-sitter-cli version on this machine, if any. */
export function pinnedTreeSitterExecutableSha256(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  return TREE_SITTER_EXECUTABLE_SHA256[version]?.[`${platform}-${arch}`];
}

/**
 * A build of the same tree-sitter-cli release that runs on older glibc. The
 * release assets above are built on Ubuntu 24.04 and link against GLIBC_2.39
 * (pidfd_spawnp, pidfd_getpid), so they cannot run on Ubuntu 22.04, Debian 12
 * or RHEL 9 (#4758), and upstream builds only on GitHub-hosted runners
 * (tree-sitter/tree-sitter#5221, #4174). conda-forge builds the same version
 * against glibc 2.17 and links only system libraries (libc, libm, libdl,
 * libpthread, librt, libgcc_s).
 */
export interface GlibcCompatibleTreeSitterBuild {
  /** The conda-forge package (.conda: a stored zip holding pkg-*.tar.zst). */
  url: string;
  /** SHA-256 of the .conda file, as conda-forge publishes it. */
  archiveSha256: string;
  /** SHA-256 of bin/tree-sitter inside the package. */
  executableSha256: string;
}

// Each archive digest matches the sha256 the anaconda.org API lists for that
// file; each executable digest is of bin/tree-sitter extracted from it.
export const GLIBC_COMPATIBLE_TREE_SITTER_BUILDS: Readonly<Record<string, Readonly<Record<string, GlibcCompatibleTreeSitterBuild>>>> = {
  "0.26.9": {
    "linux-arm64": {
      url: "https://conda.anaconda.org/conda-forge/linux-aarch64/tree-sitter-cli-0.26.9-h4f14f73_0.conda",
      archiveSha256: "9a7751d55e419d411fcbc3155f79773321b1858e02f39bf8ec989cc306f77326",
      executableSha256: "eb4f706458f38b9aeef229747f4f5c3cb389beab422506a5547af76a34845ed7",
    },
    "linux-x64": {
      url: "https://conda.anaconda.org/conda-forge/linux-64/tree-sitter-cli-0.26.9-hc7555a6_0.conda",
      archiveSha256: "c940aa36efa86533720ad636579103ab88aa366ef0b332ac9e53cfde8c0f0e2d",
      executableSha256: "0afa5aa43bdfd4b2ccc6f0f94f00c1ef855a22d77d32dd1cf3e30aee27988bd8",
    },
  },
};

/** The glibc-compatible build of a tree-sitter-cli version for this machine, if any. */
export function glibcCompatibleTreeSitterBuild(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): GlibcCompatibleTreeSitterBuild | undefined {
  return GLIBC_COMPATIBLE_TREE_SITTER_BUILDS[version]?.[`${platform}-${arch}`];
}
