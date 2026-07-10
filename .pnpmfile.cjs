// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Workspace pnpm hook that drops better-auth's UI and test peer dependencies so production deploys stay free of build tooling.

function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    for (const peer of ['react', 'react-dom', 'vitest']) {
      if (pkg.peerDependencies) delete pkg.peerDependencies[peer];
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[peer];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
