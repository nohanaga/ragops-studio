/**
 * Local TypeScript module shim.
 *
 * Allows importing Bootstrap JS modules (ESM) with correct types in this codebase.
 */

declare module 'bootstrap/js/dist/dropdown' {
  import type { Dropdown } from 'bootstrap'

  const BootstrapDropdown: typeof Dropdown
  export default BootstrapDropdown
}
