// Ambient module declaration for bare (non-CSS-Modules) stylesheet imports,
// e.g. `import './globals.css'` in app/layout.tsx.
//
// Next.js's own build pipeline (webpack/Turbopack loaders) handles this import
// at bundle time regardless of what TypeScript thinks, and Next's TypeScript
// *language-service plugin* (the `{"name": "next"}` entry in tsconfig.json's
// `compilerOptions.plugins`) supplies this same declaration to editors and to
// `next build`'s own internal type-check pass. That plugin, however, only
// runs inside a full language-service host — a bare `tsc --noEmit` invocation
// (this project's separate, fast `apps/web` "typecheck" script, kept
// deliberately independent from the slower `next build`) never loads
// tsconfig "plugins" at all, so without this file `tsc --noEmit` fails on
// this import even though `next build` compiles it fine. Declaring it
// ourselves makes both commands agree.
declare module '*.css';
