// Production loads plugin TypeScript sources through tsx (see NODE_OPTIONS in the unit files and
// package.json scripts). Config-driven e2e tests must use the same loader, otherwise the Cordis
// loader's dynamic import() reaches Node's strip-only TypeScript support and rejects syntax that
// needs transformation, such as constructor parameter properties.
import { register } from 'tsx/esm/api'
register()
