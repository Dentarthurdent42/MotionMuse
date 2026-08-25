// Representation guards for values arriving from an I/O boundary — JSON out
// of localStorage, share links, imported presets — where nothing upstream has
// established what the value is yet. Callers branch on these named guards;
// the raw checks live here so a reader can see every representation test the
// app relies on in one place. This is the one file allowed to use `typeof`
// (see the anti-slop/no-runtime-typeof override in .oxlintrc.json), the
// plain-JS stand-in for the type-predicate escape hatch that rule offers
// TypeScript projects.

export const isString = v => typeof v === 'string';

// A JSON object as opposed to a JSON array — what every stored map/settings
// blob is expected to be.
export const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
