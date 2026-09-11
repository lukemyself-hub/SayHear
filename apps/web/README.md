# Web runtime boundary

The `build` and `prestart` scripts run `src/validate-startup.ts` through `tsx`.
The Web package declares `tsx` in `dependencies` because startup validation runs
in both the build environment and the production start environment. The root
workspace `devDependencies` entry is not sufficient for a production install.

The validator remains fail closed: changing its runtime only makes the existing
`assertSafeRuntimeConfiguration` and G1 release-evidence checks executable by
Node; it does not change their rules.
