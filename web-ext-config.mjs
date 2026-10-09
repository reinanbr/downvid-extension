// web-ext (lint, build, run): only the extension's own files.
export default {
  ignoreFiles: [
    '.github',
    'dist',
    'docs',
    'node_modules',
    'scripts',
    'test',
    'package.json',
    'package-lock.json',
    'README.md',
    'web-ext-config.mjs',
  ],
};
