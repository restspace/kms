// wrangler bundles *.sql imports as text (rules in wrangler.toml).
declare module '*.sql' {
  const sql: string;
  export default sql;
}
