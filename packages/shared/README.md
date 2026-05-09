# @devdocket/shared

Shared types, base classes, and utilities for building [DevDocket](https://github.com/devdocket/devdocket) extensions.

## Installation

This package is published to the GitHub Packages npm registry. Add the following to your `.npmrc`:

```
@devdocket:registry=https://npm.pkg.github.com
```

Then install:

```bash
npm install @devdocket/shared
```

> **Note:** GitHub Packages requires authentication. See [Authenticating to GitHub Packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages) for setup instructions.

## Usage

```typescript
import { BaseProvider, type ProviderItem, type Event } from '@devdocket/shared';
```

`ProviderItem` is the canonical item type emitted by providers. `DiscoveredItem` remains available as a deprecated compatibility alias; migrate consumer imports to `ProviderItem`.

See the [DevDocket documentation](https://github.com/devdocket/devdocket) for details on building provider and action extensions.

## License

[MIT](LICENSE)
