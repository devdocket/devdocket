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

## Usage

```typescript
import { BaseProvider, DiscoveredItem, Event } from '@devdocket/shared';
```

See the [DevDocket documentation](https://github.com/devdocket/devdocket) for details on building provider and action extensions.

## License

[MIT](LICENSE)
