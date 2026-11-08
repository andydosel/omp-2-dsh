/** CSS Modules: the bundler replaces this import with the hashed class map. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string | undefined>>
  export default classes
}
