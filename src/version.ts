import { readFileSync } from 'node:fs';

type PackageMetadata = {
  version?: unknown;
};

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as PackageMetadata;

  if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
    throw new Error('package.json is missing a valid version');
  }

  return packageJson.version;
}

export const SERVER_VERSION = readPackageVersion();
