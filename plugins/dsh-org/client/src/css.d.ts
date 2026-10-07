/**
 * Ambient typing for CSS Modules consumed by the client bundle. The tsdown
 * preset compiles `*.module.css` through lightningcss and injects the hashed
 * class map as the default export; tsc needs this declaration to typecheck
 * the imports.
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
