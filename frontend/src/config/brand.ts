import pkg from '../../package.json';

export const BRAND = Object.freeze({
  appName: 'LocWarp',
  edition: 'koxuan 特製版本',
  shortEdition: 'KX',
  repository: 'meteorcyclops/locwarp',
  repositoryUrl: 'https://github.com/meteorcyclops/locwarp',
  releasesUrl: 'https://github.com/meteorcyclops/locwarp/releases',
  version: (pkg as { version: string }).version,
});

